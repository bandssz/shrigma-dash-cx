package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/gofrs/uuid/v5"
	"github.com/knadh/listmonk/internal/manager"
	"github.com/knadh/listmonk/models"
)

var graphCacheRuntimeSHA string

var (
	errGraphGuardRejected  = errors.New("graph cache guard rejected")
	errGraphGuardUncertain = errors.New("graph cache guard uncertain")
	graphHex64             = regexp.MustCompile(`^[a-f0-9]{64}$`)
	graphTarget            = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

type graphCacheDB interface {
	SelectContext(context.Context, any, string, ...any) error
	GetContext(context.Context, any, string, ...any) error
}

type graphHeartbeatResult struct {
	Ready         bool      `json:"ready"`
	Code          string    `json:"code"`
	TemplateCount int       `json:"template_count"`
	ExpiresAt     time.Time `json:"expires_at"`
	Snapshots     []struct {
		TemplateID     int    `json:"template_id"`
		SnapshotSHA256 string `json:"snapshot_sha256"`
	} `json:"snapshots"`
}

type graphCacheRuntime struct {
	db            graphCacheDB
	manager       *manager.Manager
	target        string
	instanceID    uuid.UUID
	leaseToken    uuid.UUID
	executableSHA string
	runtimeSHA    string
	interval      time.Duration

	mu           sync.RWMutex
	ready        bool
	expiresAt    time.Time
	snapshots    map[int]string
	rawSnapshots map[int]manager.GraphTemplateSnapshot
	stop         chan struct{}
	done         chan struct{}
	stopOnce     sync.Once
}

func executableSHA256() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func newGraphCacheRuntime(db graphCacheDB, mgr *manager.Manager, target, executableSHA, runtimeSHA string, interval time.Duration) (*graphCacheRuntime, error) {
	if db == nil || mgr == nil || !graphTarget.MatchString(target) || !graphHex64.MatchString(executableSHA) ||
		!graphHex64.MatchString(runtimeSHA) || interval < 5*time.Second || interval > 30*time.Second {
		return nil, fmt.Errorf("invalid graph cache runtime config")
	}
	instanceID, err := uuid.NewV4()
	if err != nil {
		return nil, err
	}
	leaseToken, err := uuid.NewV4()
	if err != nil {
		return nil, err
	}
	return &graphCacheRuntime{
		db: db, manager: mgr, target: target, instanceID: instanceID, leaseToken: leaseToken,
		executableSHA: executableSHA, runtimeSHA: runtimeSHA, interval: interval,
		snapshots: make(map[int]string), rawSnapshots: make(map[int]manager.GraphTemplateSnapshot), stop: make(chan struct{}), done: make(chan struct{}),
	}, nil
}

func (r *graphCacheRuntime) heartbeat(ctx context.Context) error {
	var ids []int
	if err := r.db.SelectContext(ctx, &ids, `SELECT template_id FROM crm_graph_candidate.cache_identity_expected_v1($1)`, r.target); err != nil {
		return err
	}
	sort.Ints(ids)
	snapshots := make([]manager.GraphTemplateSnapshot, 0, len(ids))
	for _, id := range ids {
		snapshot, err := r.manager.GraphTemplateSnapshot(id)
		if err != nil {
			return err
		}
		snapshots = append(snapshots, snapshot)
	}
	body, err := json.Marshal(snapshots)
	if err != nil {
		return err
	}
	var raw []byte
	if err := r.db.GetContext(ctx, &raw,
		`SELECT crm_graph_candidate.cache_identity_heartbeat_v1($1,$2,$3,$4,$5,$6::jsonb)`,
		r.target, r.instanceID, r.leaseToken, r.executableSHA, r.runtimeSHA, string(body)); err != nil {
		return err
	}
	var result graphHeartbeatResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return err
	}
	if !result.Ready && result.Code == "template_set_changed" {
		// A newly confirmed clone changed the expected set during this read.
		// SQL cleared all send snapshots but retained this physical lease. Keep
		// HTTP available to create/review templates; no guard can send until an
		// exact subsequent heartbeat confirms the actual compiled cache.
		r.mu.Lock()
		r.ready = false
		r.snapshots = make(map[int]string)
		r.rawSnapshots = make(map[int]manager.GraphTemplateSnapshot)
		r.mu.Unlock()
		return nil
	}
	next := make(map[int]string, len(result.Snapshots))
	rawNext := make(map[int]manager.GraphTemplateSnapshot, len(snapshots))
	for _, snapshot := range snapshots {
		rawNext[snapshot.TemplateID] = snapshot
	}
	for _, snapshot := range result.Snapshots {
		if snapshot.TemplateID <= 0 || !graphHex64.MatchString(snapshot.SnapshotSHA256) {
			return fmt.Errorf("invalid graph cache heartbeat response")
		}
		if _, exists := next[snapshot.TemplateID]; exists {
			return fmt.Errorf("duplicate graph cache heartbeat template")
		}
		next[snapshot.TemplateID] = snapshot.SnapshotSHA256
	}
	if !result.Ready || result.TemplateCount != len(ids) || len(next) != len(ids) || result.ExpiresAt.Before(time.Now().Add(2*time.Second)) {
		return errGraphGuardRejected
	}
	r.mu.Lock()
	r.ready = true
	r.expiresAt = result.ExpiresAt
	r.snapshots = next
	r.rawSnapshots = rawNext
	r.mu.Unlock()
	return nil
}

func (r *graphCacheRuntime) run() {
	defer close(r.done)
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err := r.heartbeat(ctx)
			cancel()
			if err != nil {
				r.mu.Lock()
				r.ready = false
				r.mu.Unlock()
			}
		case <-r.stop:
			return
		}
	}
}

func (r *graphCacheRuntime) close() {
	if r == nil {
		return
	}
	r.stopOnce.Do(func() { close(r.stop) })
	<-r.done
}

func (r *graphCacheRuntime) localCheck(guard *models.GraphCacheGuard, templateID, subscriberID int,
	renderedTpl *models.Template, renderedSnapshot manager.GraphTemplateSnapshot, now time.Time) error {
	if r == nil || guard == nil || guard.Contract != "journey_graph_cache_guard_v1" || guard.CacheTarget != r.target ||
		guard.InstanceID != r.instanceID.String() || guard.TemplateID != templateID || templateID <= 0 || guard.SubscriberID != subscriberID || subscriberID <= 0 ||
		!graphHex64.MatchString(guard.NativeSHA256) || !graphHex64.MatchString(guard.SnapshotSHA256) ||
		len(guard.Token) != 64 || !graphHex64.MatchString(guard.Token) {
		return errGraphGuardRejected
	}
	if _, err := uuid.FromString(guard.DispatchID); err != nil {
		return errGraphGuardRejected
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, guard.ExpiresAt)
	if err != nil || !expiresAt.After(now.Add(2*time.Second)) {
		return errGraphGuardRejected
	}
	r.mu.RLock()
	ready, leaseExpiry, snapshotSHA, expectedRaw := r.ready, r.expiresAt, r.snapshots[templateID], r.rawSnapshots[templateID]
	r.mu.RUnlock()
	if !ready || !leaseExpiry.After(now.Add(2*time.Second)) || snapshotSHA != guard.SnapshotSHA256 {
		return errGraphGuardRejected
	}
	heldNow, err := manager.GraphTemplateSnapshotFrom(templateID, renderedTpl)
	if err != nil || !reflect.DeepEqual(heldNow, renderedSnapshot) || !reflect.DeepEqual(renderedSnapshot, expectedRaw) {
		return errGraphGuardRejected
	}
	currentTpl, err := r.manager.GetTpl(templateID)
	if err != nil || currentTpl != renderedTpl {
		return errGraphGuardRejected
	}
	current, err := manager.GraphTemplateSnapshotFrom(templateID, currentTpl)
	if err != nil || !reflect.DeepEqual(current, expectedRaw) {
		return errGraphGuardRejected
	}
	return nil
}

func (r *graphCacheRuntime) consume(ctx context.Context, guard *models.GraphCacheGuard) error {
	body, err := json.Marshal(guard)
	if err != nil {
		return errGraphGuardRejected
	}
	var ok bool
	if err := r.db.GetContext(ctx, &ok, `SELECT crm_graph_candidate.cache_identity_consume_v1($1::jsonb)`, string(body)); err != nil {
		return errGraphGuardUncertain
	}
	if !ok {
		return errGraphGuardRejected
	}
	return nil
}

func guardedGraphPush(ctx context.Context, runtime *graphCacheRuntime, guard *models.GraphCacheGuard, templateID, subscriberID int,
	renderedTpl *models.Template, renderedSnapshot manager.GraphTemplateSnapshot, push func() error) error {
	if runtime == nil || push == nil {
		return errGraphGuardRejected
	}
	if err := runtime.localCheck(guard, templateID, subscriberID, renderedTpl, renderedSnapshot, time.Now()); err != nil {
		return err
	}
	checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := runtime.consume(checkCtx, guard); err != nil {
		return err
	}
	return push()
}

func initGraphCacheRuntime(db graphCacheDB, mgr *manager.Manager) (*graphCacheRuntime, error) {
	if os.Getenv("CRM_GRAPH_CACHE_ENABLED") != "true" {
		return nil, nil
	}
	if !graphHex64.MatchString(graphCacheRuntimeSHA) {
		return nil, fmt.Errorf("graph cache runtime SHA is not compiled")
	}
	executableSHA, err := executableSHA256()
	if err != nil {
		return nil, err
	}
	runtime, err := newGraphCacheRuntime(db, mgr, os.Getenv("CRM_GRAPH_CACHE_TARGET"), executableSHA, graphCacheRuntimeSHA, 20*time.Second)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = runtime.heartbeat(ctx)
	cancel()
	if err != nil {
		return nil, err
	}
	go runtime.run()
	return runtime, nil
}
