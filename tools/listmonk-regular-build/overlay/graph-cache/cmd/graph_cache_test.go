package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/smtp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/knadh/listmonk/internal/i18n"
	"github.com/knadh/listmonk/internal/manager"
	"github.com/knadh/listmonk/models"
	null "gopkg.in/volatiletech/null.v6"
)

type graphRuntimeStore struct{}

func (graphRuntimeStore) NextCampaigns([]int64, []int64) ([]*models.Campaign, error) { return nil, nil }
func (graphRuntimeStore) NextSubscribers(int, int) ([]models.Subscriber, error)      { return nil, nil }
func (graphRuntimeStore) GetCampaign(int) (*models.Campaign, error)                  { return nil, nil }
func (graphRuntimeStore) GetAttachment(int) (models.Attachment, error) {
	return models.Attachment{}, nil
}
func (graphRuntimeStore) UpdateCampaignStatus(int, string) error        { return nil }
func (graphRuntimeStore) UpdateCampaignCounts(int, int, int, int) error { return nil }
func (graphRuntimeStore) CreateLink(string) (string, error)             { return "", nil }
func (graphRuntimeStore) BlocklistSubscriber(int64) error               { return nil }
func (graphRuntimeStore) DeleteSubscriber(int64) error                  { return nil }

type graphRuntimeDB struct {
	mu          sync.Mutex
	snapshotSHA string
	expiresAt   time.Time
	consumed    bool
	uncertain   bool
	pendingSet  bool
}

func (d *graphRuntimeDB) SelectContext(_ context.Context, dest any, query string, _ ...any) error {
	if !strings.Contains(query, "cache_identity_expected_v1") {
		return errors.New("unexpected select")
	}
	ids, ok := dest.(*[]int)
	if !ok {
		return errors.New("unexpected destination")
	}
	*ids = []int{71}
	return nil
}

func (d *graphRuntimeDB) GetContext(_ context.Context, dest any, query string, args ...any) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if strings.Contains(query, "cache_identity_heartbeat_v1") {
		out, ok := dest.(*[]byte)
		if !ok || len(args) != 6 {
			return errors.New("invalid heartbeat call")
		}
		if d.pendingSet {
			*out = []byte(`{"ready":false,"code":"template_set_changed"}`)
			return nil
		}
		*out = []byte(fmt.Sprintf(`{"ready":true,"template_count":1,"expires_at":%q,"snapshots":[{"template_id":71,"snapshot_sha256":%q}]}`, d.expiresAt.UTC().Format(time.RFC3339Nano), d.snapshotSHA))
		return nil
	}
	if strings.Contains(query, "cache_identity_consume_v1") {
		out, ok := dest.(*bool)
		if !ok || len(args) != 1 {
			return errors.New("invalid consume call")
		}
		if d.uncertain {
			return errors.New("synthetic commit acknowledgement loss")
		}
		if d.consumed {
			*out = false
			return nil
		}
		d.consumed = true
		*out = true
		return nil
	}
	return errors.New("unexpected get")
}

func TestExpectedSetGrowthBlocksPushUntilExactHeartbeat(t *testing.T) {
	runtime, db, guard := readyGraphRuntime(t)
	tpl, snapshot := heldGraphTemplate(t, runtime)
	db.pendingSet = true
	if err := runtime.heartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	pushes := 0
	push := func() error { pushes++; return nil }
	if err := guardedGraphPush(context.Background(), runtime, guard, 71, 7, tpl, snapshot, push); !errors.Is(err, errGraphGuardRejected) {
		t.Fatalf("pending set allowed transport: %v", err)
	}
	if pushes != 0 || db.consumed {
		t.Fatal("pending cache set reached consume or push")
	}
	db.pendingSet = false
	if err := runtime.heartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := guardedGraphPush(context.Background(), runtime, guard, 71, 7, tpl, snapshot, push); err != nil {
		t.Fatal(err)
	}
	if pushes != 1 {
		t.Fatal("exact cache heartbeat did not restore one guarded push")
	}
}

func graphRuntimeManager(t *testing.T, body string) *manager.Manager {
	t.Helper()
	language, err := i18n.New([]byte(`{"_.code":"en","_.name":"English"}`))
	if err != nil {
		t.Fatal(err)
	}
	m := manager.New(manager.Config{Concurrency: 1, MessageRate: 1}, graphRuntimeStore{}, language, log.New(io.Discard, "", 0))
	tpl := models.Template{Base: models.Base{ID: 71}, Type: models.TemplateTypeTx, Subject: "subject", Body: body, BodySource: null.NewString("source", true)}
	if err := tpl.Compile(m.GenericTemplateFuncs()); err != nil {
		t.Fatal(err)
	}
	m.CacheTpl(71, &tpl)
	return m
}

func readyGraphRuntime(t *testing.T) (*graphCacheRuntime, *graphRuntimeDB, *models.GraphCacheGuard) {
	t.Helper()
	db := &graphRuntimeDB{snapshotSHA: strings.Repeat("a", 64), expiresAt: time.Now().Add(time.Minute)}
	runtime, err := newGraphCacheRuntime(db, graphRuntimeManager(t, `{{ define "content" }}one{{ end }}`), "listmonk-primary", strings.Repeat("b", 64), strings.Repeat("c", 64), 20*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.heartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	guard := &models.GraphCacheGuard{
		Contract: "journey_graph_cache_guard_v1", CacheTarget: "listmonk-primary", InstanceID: runtime.instanceID.String(),
		TemplateID: 71, SubscriberID: 7, NativeSHA256: strings.Repeat("d", 64), SnapshotSHA256: db.snapshotSHA,
		DispatchID: "00000000-0000-4000-8000-000000000071", Token: strings.Repeat("e", 64),
		ExpiresAt: time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339Nano),
	}
	return runtime, db, guard
}

func heldGraphTemplate(t *testing.T, runtime *graphCacheRuntime) (*models.Template, manager.GraphTemplateSnapshot) {
	t.Helper()
	tpl, err := runtime.manager.GetTpl(71)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := manager.GraphTemplateSnapshotFrom(71, tpl)
	if err != nil {
		t.Fatal(err)
	}
	return tpl, snapshot
}

func TestGraphGuardRejectsSecondCacheTTLAndReplayBeforePush(t *testing.T) {
	runtime, db, guard := readyGraphRuntime(t)
	tpl, snapshot := heldGraphTemplate(t, runtime)
	pushes := 0
	push := func() error { pushes++; return nil }
	if err := guardedGraphPush(context.Background(), runtime, guard, 71, 7, tpl, snapshot, push); err != nil {
		t.Fatal(err)
	}
	if pushes != 1 {
		t.Fatalf("expected one push, got %d", pushes)
	}
	if err := guardedGraphPush(context.Background(), runtime, guard, 71, 7, tpl, snapshot, push); !errors.Is(err, errGraphGuardRejected) || pushes != 1 {
		t.Fatalf("replay was not blocked before push: err=%v pushes=%d", err, pushes)
	}
	if err := guardedGraphPush(context.Background(), runtime, guard, 71, 8, tpl, snapshot, push); !errors.Is(err, errGraphGuardRejected) || pushes != 1 {
		t.Fatalf("recipient substitution was not blocked before push: err=%v pushes=%d", err, pushes)
	}

	other, _, otherGuard := readyGraphRuntime(t)
	otherGuard.InstanceID = runtime.instanceID.String()
	other.instanceID = runtime.instanceID
	other.expiresAt = runtime.expiresAt
	other.snapshots[71] = guard.SnapshotSHA256
	other.rawSnapshots[71] = runtime.rawSnapshots[71]
	changed := models.Template{Base: models.Base{ID: 71}, Type: models.TemplateTypeTx, Subject: "subject", Body: `{{ define "content" }}two{{ end }}`, BodySource: null.NewString("source", true)}
	if err := changed.Compile(other.manager.GenericTemplateFuncs()); err != nil {
		t.Fatal(err)
	}
	other.manager.CacheTpl(71, &changed)
	changedTpl, changedSnapshot := heldGraphTemplate(t, other)
	if err := guardedGraphPush(context.Background(), other, otherGuard, 71, 7, changedTpl, changedSnapshot, push); !errors.Is(err, errGraphGuardRejected) || pushes != 1 {
		t.Fatalf("divergent process cache was not blocked: err=%v pushes=%d", err, pushes)
	}

	db.consumed = false
	expired := *guard
	expired.ExpiresAt = time.Now().Add(time.Second).UTC().Format(time.RFC3339Nano)
	if err := guardedGraphPush(context.Background(), runtime, &expired, 71, 7, tpl, snapshot, push); !errors.Is(err, errGraphGuardRejected) || pushes != 1 {
		t.Fatalf("near-expired guard was not blocked: err=%v pushes=%d", err, pushes)
	}

	db.uncertain, db.consumed = true, false
	if err := guardedGraphPush(context.Background(), runtime, guard, 71, 7, tpl, snapshot, push); !errors.Is(err, errGraphGuardUncertain) || pushes != 1 {
		t.Fatalf("uncertain consume was not blocked before push: err=%v pushes=%d", err, pushes)
	}
}

func TestGraphGuardRejectsTemplateInstanceReloadedAfterRenderBeforeConsume(t *testing.T) {
	db := &graphRuntimeDB{snapshotSHA: strings.Repeat("a", 64), expiresAt: time.Now().Add(time.Minute)}
	mgr := graphRuntimeManager(t, `old rendered body`)
	oldTpl, err := mgr.GetTpl(71)
	if err != nil {
		t.Fatal(err)
	}
	oldTpl.BodySource = null.NewString("source-old", true)
	runtime, err := newGraphCacheRuntime(db, mgr, "listmonk-primary", strings.Repeat("b", 64), strings.Repeat("c", 64), 20*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.heartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	heldTpl, heldSnapshot := heldGraphTemplate(t, runtime)
	message := models.TxMessage{}
	if err := message.Render(models.Subscriber{Email: "recipient@example.invalid"}, heldTpl, mgr.GenericTemplateFuncs()); err != nil {
		t.Fatal(err)
	}
	if string(message.Body) != "old rendered body" || heldSnapshot.BodySource == nil || *heldSnapshot.BodySource != "source-old" {
		t.Fatalf("the held template was not the exact rendered source: body=%q snapshot=%#v", message.Body, heldSnapshot)
	}

	reloaded := models.Template{Base: models.Base{ID: 71}, Type: models.TemplateTypeTx, Subject: "subject", Body: `new cache body`, BodySource: null.NewString("source-new", true)}
	if err := reloaded.Compile(mgr.GenericTemplateFuncs()); err != nil {
		t.Fatal(err)
	}
	mgr.CacheTpl(71, &reloaded)
	if err := runtime.heartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	guard := &models.GraphCacheGuard{
		Contract: "journey_graph_cache_guard_v1", CacheTarget: "listmonk-primary", InstanceID: runtime.instanceID.String(),
		TemplateID: 71, SubscriberID: 7, NativeSHA256: strings.Repeat("d", 64), SnapshotSHA256: db.snapshotSHA,
		DispatchID: "00000000-0000-4000-8000-000000000071", Token: strings.Repeat("e", 64),
		ExpiresAt: time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339Nano),
	}
	pushes := 0
	push := func() error { pushes++; return nil }
	if err := guardedGraphPush(context.Background(), runtime, guard, 71, 7, heldTpl, heldSnapshot, push); !errors.Is(err, errGraphGuardRejected) {
		t.Fatalf("reloaded cache accepted bytes rendered by the old pointer: %v", err)
	}
	if pushes != 0 || db.consumed {
		t.Fatalf("old rendered pointer reached consume or push: consumed=%v pushes=%d", db.consumed, pushes)
	}

	currentTpl, currentSnapshot := heldGraphTemplate(t, runtime)
	if currentTpl != &reloaded || currentSnapshot.BodySource == nil || *currentSnapshot.BodySource != "source-new" {
		t.Fatalf("current pointer/source mismatch: tpl=%p want=%p snapshot=%#v", currentTpl, &reloaded, currentSnapshot)
	}
	if err := guardedGraphPush(context.Background(), runtime, guard, 71, 7, currentTpl, currentSnapshot, push); err != nil {
		t.Fatal(err)
	}
	if pushes != 1 || !db.consumed {
		t.Fatalf("current attested pointer did not consume and push once: consumed=%v pushes=%d", db.consumed, pushes)
	}
}

func serveOneSMTP(t *testing.T) (string, <-chan string, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		w := bufio.NewWriter(conn)
		write := func(s string) { _, _ = w.WriteString(s + "\r\n"); _ = w.Flush() }
		write("220 loopback ESMTP")
		var data strings.Builder
		inData := false
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			trimmed := strings.TrimRight(line, "\r\n")
			if inData {
				if trimmed == "." {
					received <- data.String()
					write("250 queued")
					inData = false
				} else {
					data.WriteString(line)
				}
				continue
			}
			upper := strings.ToUpper(trimmed)
			switch {
			case strings.HasPrefix(upper, "EHLO"), strings.HasPrefix(upper, "HELO"):
				write("250-loopback")
				write("250 OK")
			case strings.HasPrefix(upper, "MAIL FROM"), strings.HasPrefix(upper, "RCPT TO"):
				write("250 OK")
			case upper == "DATA":
				inData = true
				write("354 End data")
			case upper == "QUIT":
				write("221 bye")
				return
			default:
				write("250 OK")
			}
		}
	}()
	return ln.Addr().String(), received, func() { _ = ln.Close() }
}

func TestGraphGuardedPushReachesOnlyLoopbackSMTPAfterConsume(t *testing.T) {
	runtime, _, guard := readyGraphRuntime(t)
	tpl, snapshot := heldGraphTemplate(t, runtime)
	addr, received, closeServer := serveOneSMTP(t)
	defer closeServer()
	push := func() error {
		return smtp.SendMail(addr, nil, "sender@example.invalid", []string{"recipient@example.invalid"}, []byte("Subject: guarded\r\n\r\nbody\r\n"))
	}
	if err := guardedGraphPush(context.Background(), runtime, guard, 71, 7, tpl, snapshot, push); err != nil {
		t.Fatal(err)
	}
	select {
	case body := <-received:
		if !strings.Contains(body, "Subject: guarded") || !strings.Contains(body, "body") {
			t.Fatalf("unexpected SMTP bytes: %q", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("loopback SMTP did not receive guarded bytes")
	}
}
