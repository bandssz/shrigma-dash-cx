package manager

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/knadh/listmonk/internal/i18n"
	"github.com/knadh/listmonk/models"
	"github.com/knadh/smtppool/v2"
	"github.com/paulbellamy/ratecounter"
)

type regularStoreFixture struct {
	gate         RegularDeliveryGate
	subs         []models.Subscriber
	limits       []int
	claim        RegularDeliveryClaimResult
	request      RegularDeliveryClaim
	finish       string
	finalized    int
	status       string
	claimErr     error
	gateErr      error
	finishErr    error
	finalizeErr  error
	subErr       error
	heartbeat    RegularWorkerHeartbeatResult
	heartbeats   []RegularWorkerHeartbeat
	heartbeatErr error
}

const regularFixtureConfigurationSet = "fixture-set"

func (s *regularStoreFixture) NextCampaigns([]int64, []int64) ([]*models.Campaign, error) {
	return nil, nil
}
func (s *regularStoreFixture) NextSubscribers(_ int, limit int) ([]models.Subscriber, error) {
	s.limits = append(s.limits, limit)
	if s.subErr != nil {
		return nil, s.subErr
	}
	if len(s.subs) == 0 {
		return nil, nil
	}
	out := append([]models.Subscriber(nil), s.subs[:1]...)
	s.subs = s.subs[1:]
	return out, nil
}
func (s *regularStoreFixture) GetCampaign(int) (*models.Campaign, error) { return nil, nil }
func (s *regularStoreFixture) GetAttachment(int) (models.Attachment, error) {
	return models.Attachment{}, nil
}
func (s *regularStoreFixture) UpdateCampaignStatus(_ int, status string) error {
	s.status = status
	return nil
}
func (s *regularStoreFixture) UpdateCampaignCounts(int, int, int, int) error { return nil }
func (s *regularStoreFixture) CreateLink(string) (string, error)             { return "", nil }
func (s *regularStoreFixture) BlocklistSubscriber(int64) error               { return nil }
func (s *regularStoreFixture) DeleteSubscriber(int64) error                  { return nil }
func (s *regularStoreFixture) RegularDeliveryGate(int) (RegularDeliveryGate, error) {
	return s.gate, s.gateErr
}
func (s *regularStoreFixture) HeartbeatRegularWorker(request RegularWorkerHeartbeat) (RegularWorkerHeartbeatResult, error) {
	s.heartbeats = append(s.heartbeats, request)
	result := s.heartbeat
	if result.Ready && result.InstanceID == "" {
		result.InstanceID = request.InstanceID
	}
	if result.Ready && result.Deadline.IsZero() {
		result.Deadline = time.Now().Add(time.Minute)
	}
	return result, s.heartbeatErr
}
func (s *regularStoreFixture) ClaimRegularDelivery(request RegularDeliveryClaim) (RegularDeliveryClaimResult, error) {
	s.request = request
	return s.claim, s.claimErr
}
func (s *regularStoreFixture) FinishRegularDelivery(_, _ int, _, _ string, outcome string) error {
	s.finish = outcome
	return s.finishErr
}
func (s *regularStoreFixture) FinalizeRegularDelivery(int) error { s.finalized++; return s.finalizeErr }

type guardedMessengerFixture struct {
	outcome   smtppool.GuardedOutcome
	err       error
	messages  []models.Message
	legacy    int
	configSHA string
}

func (m *guardedMessengerFixture) Name() string { return "email" }
func (m *guardedMessengerFixture) Push(message models.Message) error {
	m.legacy++
	m.messages = append(m.messages, message)
	return nil
}
func (m *guardedMessengerFixture) Flush() error { return nil }
func (m *guardedMessengerFixture) Close() error { return nil }
func (m *guardedMessengerFixture) GuardedConfigSHA256() (string, error) {
	if m.configSHA != "" {
		return m.configSHA, nil
	}
	return strings.Repeat("a", 64), nil
}
func (m *guardedMessengerFixture) PushRegularGuarded(message models.Message, authorize smtppool.GuardedAuthorize) (smtppool.GuardedSendResult, error) {
	m.messages = append(m.messages, message)
	err := authorize(smtppool.GuardedEnvelope{From: "sender@example.invalid", To: message.To[0], PayloadSHA256: strings.Repeat("b", 64)})
	if err != nil {
		return smtppool.GuardedSendResult{Outcome: smtppool.GuardedNotStarted}, err
	}
	return smtppool.GuardedSendResult{Outcome: m.outcome}, m.err
}

func regularHarness(store *regularStoreFixture, messenger *guardedMessengerFixture) (*Manager, *pipe, CampaignMessage) {
	campaign := &models.Campaign{Base: models.Base{ID: 7}, UUID: "campaign", Name: "fixture", FromEmail: "Sender <sender@example.invalid>", Messenger: "email", ContentType: models.CampaignContentTypePlain}
	campaign.Headers = models.Headers{{"X-SES-MESSAGE-TAGS": "source=fixture, crm_test=true, crm_dispatch_id=forged", "x-ses-configuration-set": "forged-a"}, {"X-SES-CONFIGURATION-SET": "forged-b"}}
	subscriber := models.Subscriber{Base: models.Base{ID: 11}, UUID: "subscriber", Email: "recipient@example.invalid", DeliverySnapshot: []byte(`{"id":11,"email":"recipient@example.invalid"}`)}
	language, err := i18n.New([]byte(`{"_.code":"en","_.name":"English","fixture":"Fixture"}`))
	if err != nil {
		panic(err)
	}
	m := New(Config{BatchSize: 99, Concurrency: 1, MessageRate: 100}, store, language, log.New(io.Discard, "", 0))
	m.messengers["email"] = messenger
	identity, _ := m.regularHeartbeatIdentity()
	m.setRegularLease(RegularWorkerHeartbeatResult{Ready: true, InstanceID: identity.InstanceID, Deadline: time.Now().Add(time.Minute)}, identity.RuntimeSHA256)
	p := &pipe{camp: campaign, rate: ratecounter.NewRateCounter(time.Minute), wg: &sync.WaitGroup{}, m: m}
	msg := CampaignMessage{Campaign: campaign, Subscriber: subscriber, from: campaign.FromEmail, to: subscriber.Email, subject: "subject", body: []byte("body"), pipe: p}
	return m, p, msg
}

func TestBoundAcceptedUsesDurableFinishWithoutLegacyCounters(t *testing.T) {
	store := &regularStoreFixture{claim: RegularDeliveryClaimResult{ShouldSend: true, Reason: "claimed", DispatchID: "ignored", ClaimToken: "token"}}
	messenger := &guardedMessengerFixture{outcome: smtppool.GuardedAccepted}
	m, p, msg := regularHarness(store, messenger)
	p.wg.Add(1)
	m.processBoundCampaignMessage(msg, regularFixtureConfigurationSet)
	if store.finish != "accepted" || p.sent.Load() != 0 || p.lastID.Load() != 0 || p.stopped.Load() {
		t.Fatalf("accepted guarded result used legacy progress or stopped: finish=%q sent=%d last=%d stopped=%v", store.finish, p.sent.Load(), p.lastID.Load(), p.stopped.Load())
	}
	if !bytes.Equal(store.request.SubscriberSnapshot, msg.Subscriber.DeliverySnapshot) {
		t.Fatal("raw subscriber snapshot was not carried to claim")
	}
	if len(messenger.messages) != 1 {
		t.Fatal("expected one guarded message")
	}
	tags := messenger.messages[0].Headers.Get(regularSESTagsHeader)
	if !strings.Contains(tags, "source=fixture") || !strings.Contains(tags, "crm_test=false") || strings.Contains(tags, "forged") {
		t.Fatalf("reserved SES tags were not generated safely: %q", tags)
	}
	if messenger.messages[0].Headers.Get(regularDispatchHeader) == "" || store.request.DispatchID == "" {
		t.Fatal("manager did not generate dispatch identity before MIME construction")
	}
	if store.request.InstanceID == "" {
		t.Fatal("guarded claim did not carry the process lease identity")
	}
	if values := messenger.messages[0].Headers.Values(regularSESConfigurationSetHeader); len(values) != 1 || values[0] != regularFixtureConfigurationSet || store.request.ConfigurationSet != regularFixtureConfigurationSet {
		t.Fatalf("configuration set was not replaced from the private gate: headers=%v claim=%q", values, store.request.ConfigurationSet)
	}
}

func TestBoundUnknownFinishesUnknownAndStopsImmediately(t *testing.T) {
	store := &regularStoreFixture{claim: RegularDeliveryClaimResult{ShouldSend: true, Reason: "claimed", ClaimToken: "token"}}
	messenger := &guardedMessengerFixture{outcome: smtppool.GuardedOutcomeUnknown, err: errors.New("synthetic lost ACK")}
	m, p, msg := regularHarness(store, messenger)
	p.wg.Add(1)
	m.processBoundCampaignMessage(msg, regularFixtureConfigurationSet)
	if store.finish != "outcome_unknown" || !p.stopped.Load() || !p.withErrors.Load() {
		t.Fatalf("unknown did not finish and stop: finish=%q stopped=%v errors=%v", store.finish, p.stopped.Load(), p.withErrors.Load())
	}
}

func TestBoundIneligibleSkipsWithoutSMTPOrStop(t *testing.T) {
	store := &regularStoreFixture{claim: RegularDeliveryClaimResult{ShouldSend: false, Reason: "ineligible"}}
	messenger := &guardedMessengerFixture{outcome: smtppool.GuardedAccepted}
	m, p, msg := regularHarness(store, messenger)
	p.wg.Add(1)
	m.processBoundCampaignMessage(msg, regularFixtureConfigurationSet)
	if store.finish != "" || p.stopped.Load() {
		t.Fatalf("safe ineligible result was treated as transport: finish=%q stopped=%v", store.finish, p.stopped.Load())
	}
}

func TestBoundClaimErrorCannotBecomeSafeIneligible(t *testing.T) {
	store := &regularStoreFixture{
		claim:    RegularDeliveryClaimResult{ShouldSend: false, Reason: "ineligible"},
		claimErr: errors.New("synthetic commit uncertainty"),
	}
	messenger := &guardedMessengerFixture{outcome: smtppool.GuardedNotStarted}
	m, p, msg := regularHarness(store, messenger)
	p.wg.Add(1)
	m.processBoundCampaignMessage(msg, regularFixtureConfigurationSet)
	if !p.stopped.Load() || !p.withErrors.Load() {
		t.Fatal("uncertain claim response was treated as a safe ineligible result")
	}
}

func TestBoundMissingPrivateConfigurationSetStopsBeforeTransport(t *testing.T) {
	store := &regularStoreFixture{claim: RegularDeliveryClaimResult{ShouldSend: true, Reason: "claimed", ClaimToken: "token"}}
	messenger := &guardedMessengerFixture{outcome: smtppool.GuardedAccepted}
	m, p, msg := regularHarness(store, messenger)
	p.wg.Add(1)
	m.processBoundCampaignMessage(msg, "")
	if !p.stopped.Load() || !p.withErrors.Load() || len(messenger.messages) != 0 || store.request.DispatchID != "" {
		t.Fatal("missing private configuration set reached the guarded transport or claim")
	}
}

func TestPublicAndQueuedCampaignPushRefuseBoundLegacyPath(t *testing.T) {
	store := &regularStoreFixture{gate: RegularDeliveryGate{Bound: true, Ready: true, ConfigurationSet: regularFixtureConfigurationSet}}
	messenger := &guardedMessengerFixture{}
	m, _, msg := regularHarness(store, messenger)
	if err := m.PushCampaignMessage(msg); err == nil {
		t.Fatal("public campaign push accepted a bound campaign")
	}
	msg.pipe = nil
	n := 0
	m.processQueuedCampaignMessage(msg, &n)
	if messenger.legacy != 0 {
		t.Fatal("queued bound campaign reached legacy messenger")
	}
}

func TestUnboundCampaignPreservesPublicAndWorkerLegacyPaths(t *testing.T) {
	store := &regularStoreFixture{gate: RegularDeliveryGate{Bound: false, Ready: true}}
	messenger := &guardedMessengerFixture{}
	m, _, msg := regularHarness(store, messenger)
	msg.pipe = nil
	if err := m.PushCampaignMessage(msg); err != nil {
		t.Fatalf("unbound public campaign push was rejected: %v", err)
	}
	queued := <-m.campMsgQ
	n := 0
	m.processQueuedCampaignMessage(queued, &n)
	if messenger.legacy != 1 {
		t.Fatalf("unbound campaign did not preserve legacy messenger: calls=%d", messenger.legacy)
	}
	if values := messenger.messages[0].Headers.Values(regularSESConfigurationSetHeader); len(values) != 2 {
		t.Fatalf("legacy configuration headers were changed: %v", values)
	}
}

func TestBoundSelectionIsSerialAndFinalizationIsExplicit(t *testing.T) {
	store := &regularStoreFixture{gate: RegularDeliveryGate{Bound: true, Ready: true, ConfigurationSet: regularFixtureConfigurationSet}, claim: RegularDeliveryClaimResult{ShouldSend: true, Reason: "claimed", ClaimToken: "token"}}
	messenger := &guardedMessengerFixture{outcome: smtppool.GuardedAccepted}
	m, p, _ := regularHarness(store, messenger)
	go m.worker()
	defer close(m.campMsgQ)
	p.camp.Tpl = template.Must(template.New(models.BaseTpl).Parse(`{{define "content"}}body{{end}}{{template "content" .}}`))
	store.subs = []models.Subscriber{{Base: models.Base{ID: 11}, UUID: "subscriber", Email: "recipient@example.invalid", DeliverySnapshot: []byte(`{"id":11,"email":"recipient@example.invalid"}`)}}
	if more, err := p.NextSubscribers(); err != nil || !more {
		t.Fatalf("first batch: more=%v err=%v", more, err)
	}
	if len(messenger.messages) != 1 || store.finish != "accepted" || len(store.limits) != 1 || store.limits[0] != 1 {
		t.Fatalf("bound batch was not serial: messages=%d finish=%q limits=%v", len(messenger.messages), store.finish, store.limits)
	}
	if more, err := p.NextSubscribers(); err != nil || more {
		t.Fatalf("final batch: more=%v err=%v", more, err)
	}
	if store.finalized != 1 || !p.stopped.Load() {
		t.Fatalf("empty batch bypassed explicit finalization: finalized=%d stopped=%v", store.finalized, p.stopped.Load())
	}
	_ = m
}

func TestBoundSelectionErrorStopsPipeAsUncertain(t *testing.T) {
	store := &regularStoreFixture{gate: RegularDeliveryGate{Bound: true, Ready: true, ConfigurationSet: regularFixtureConfigurationSet}, subErr: errors.New("synthetic selector failure")}
	messenger := &guardedMessengerFixture{}
	_, p, _ := regularHarness(store, messenger)
	if more, err := p.NextSubscribers(); err == nil || more {
		t.Fatalf("selection error was not returned: more=%v err=%v", more, err)
	}
	if !p.stopped.Load() || !p.withErrors.Load() || messenger.legacy != 0 {
		t.Fatalf("bound selector failure did not stop safely: stopped=%v errors=%v legacy=%d", p.stopped.Load(), p.withErrors.Load(), messenger.legacy)
	}
}

func TestRuntimeFingerprintContainsNoZeroValueFallback(t *testing.T) {
	store := &regularStoreFixture{}
	messenger := &guardedMessengerFixture{}
	m, _, _ := regularHarness(store, messenger)
	sha, err := m.regularRuntimeSHA("email", messenger)
	if err != nil || len(sha) != 64 {
		t.Fatalf("runtime fingerprint unavailable: %q %v", sha, err)
	}
	if _, err := hex.DecodeString(sha); err != nil {
		t.Fatal(err)
	}
	_, _ = json.Marshal(m.cfg)
}

func TestRuntimeFingerprintPinsEffectiveLanguageAndTimezone(t *testing.T) {
	store := &regularStoreFixture{}
	messenger := &guardedMessengerFixture{}
	m, _, _ := regularHarness(store, messenger)
	first, err := m.regularRuntimeSHA("email", messenger)
	if err != nil {
		t.Fatal(err)
	}
	language, err := i18n.New([]byte(`{"_.code":"pt-BR","_.name":"Português","fixture":"Outro"}`))
	if err != nil {
		t.Fatal(err)
	}
	m.i18n = language
	second, err := m.regularRuntimeSHA("email", messenger)
	if err != nil || first == second {
		t.Fatalf("effective i18n was not pinned: first=%q second=%q err=%v", first, second, err)
	}
	timezone, err := regularTimezoneMaterial()
	if err != nil || !json.Valid(timezone) || !bytes.Contains(timezone, []byte(`"Samples"`)) {
		t.Fatalf("effective timezone material unavailable: %s %v", timezone, err)
	}
}

func TestBoundTemplatePolicyRejectsExternalAndNondeterministicInputs(t *testing.T) {
	store := &regularStoreFixture{}
	messenger := &guardedMessengerFixture{}
	m, _, _ := regularHarness(store, messenger)
	for name, body := range map[string]string{
		"mutable i18n": `{{ L }}`,
		"wall clock":   `{{ Date "2006" }}`,
		"random":       `{{ randInt 1 10 }}`,
	} {
		t.Run(name, func(t *testing.T) {
			campaign := &models.Campaign{Body: body, ContentType: models.CampaignContentTypeHTML}
			if err := campaign.CompileTemplate(m.TemplateFuncs(campaign)); err != nil {
				t.Fatal(err)
			}
			if err := m.validateRegularCampaign(campaign); err == nil {
				t.Fatal("unsafe template function was accepted")
			}
		})
	}
	safe := &models.Campaign{Body: `{{ Safe "<b>fixed</b>" }}`, ContentType: models.CampaignContentTypeHTML}
	if err := safe.CompileTemplate(m.TemplateFuncs(safe)); err != nil {
		t.Fatal(err)
	}
	if err := m.validateRegularCampaign(safe); err != nil {
		t.Fatalf("deterministic template was rejected: %v", err)
	}
	tracked := &models.Campaign{Body: `<a href="https://fishermans.com.br/collections/all@TrackLink">Loja</a>`, ContentType: models.CampaignContentTypeHTML}
	if err := tracked.CompileTemplate(m.TemplateFuncs(tracked)); err != nil {
		t.Fatal(err)
	}
	if err := m.validateRegularCampaign(tracked); err != nil {
		t.Fatalf("panel tracking template was rejected: %v", err)
	}
	safe.MediaIDs = []int64{9}
	if err := m.validateRegularCampaign(safe); err == nil {
		t.Fatal("external attachment bytes were accepted")
	}
}

func TestNewPipeAppliesRenderPolicyOnlyToBoundCampaigns(t *testing.T) {
	store := &regularStoreFixture{gate: RegularDeliveryGate{Bound: true, Ready: true, ConfigurationSet: regularFixtureConfigurationSet}}
	messenger := &guardedMessengerFixture{}
	m, _, msg := regularHarness(store, messenger)
	msg.Campaign.Body = `{{ Date "2006" }}`
	if _, err := m.newPipe(msg.Campaign); err == nil || store.status != models.CampaignStatusPaused {
		t.Fatalf("bound unsafe template was not paused: status=%q err=%v", store.status, err)
	}

	store.gate = RegularDeliveryGate{Bound: false, Ready: true}
	legacy := *msg.Campaign
	legacy.ID = 8
	legacy.Tpl = nil
	if pipe, err := m.newPipe(&legacy); err != nil {
		t.Fatalf("legacy template behavior changed: %v", err)
	} else {
		pipe.Stop(false)
	}
}

func TestHeartbeatRecomputesRuntimeAndCloseIsIdempotent(t *testing.T) {
	store := &regularStoreFixture{heartbeat: RegularWorkerHeartbeatResult{Ready: true, Reason: "ready"}}
	messenger := &guardedMessengerFixture{configSHA: strings.Repeat("a", 64)}
	m, _, _ := regularHarness(store, messenger)
	m.clearRegularLease()
	m.startRegularHeartbeat()
	if len(store.heartbeats) != 1 || !m.regularLeaseAvailable() {
		t.Fatalf("initial heartbeat did not establish local lease: calls=%d", len(store.heartbeats))
	}
	firstRuntime := store.heartbeats[0].RuntimeSHA256
	messenger.configSHA = strings.Repeat("c", 64)
	if m.regularLeaseAvailable() {
		t.Fatal("configuration drift retained the previous local lease")
	}
	m.regularHeartbeatOnce()
	if len(store.heartbeats) != 2 || store.heartbeats[1].RuntimeSHA256 == firstRuntime || !m.regularLeaseAvailable() {
		t.Fatalf("heartbeat did not recompute runtime identity: calls=%d", len(store.heartbeats))
	}
	m.Close()
	m.Close()
}

func TestHeartbeatFalseAndErrorClearOnlyBoundLocalAuthority(t *testing.T) {
	store := &regularStoreFixture{gate: RegularDeliveryGate{Bound: true, Ready: true, ConfigurationSet: regularFixtureConfigurationSet}, heartbeat: RegularWorkerHeartbeatResult{Ready: false, Reason: "lease_suspended"}}
	messenger := &guardedMessengerFixture{}
	m, _, _ := regularHarness(store, messenger)
	m.regularHeartbeatOnce()
	gate, err := m.regularDeliveryGate(7)
	if err != nil || !gate.Bound || gate.Ready {
		t.Fatalf("ready=false did not fail the bound gate closed: gate=%+v err=%v", gate, err)
	}
	store.gate = RegularDeliveryGate{Bound: false, Ready: true}
	gate, err = m.regularDeliveryGate(8)
	if err != nil || gate.Bound || !gate.Ready {
		t.Fatalf("lease state changed the legacy gate: gate=%+v err=%v", gate, err)
	}
	store.heartbeatErr = errors.New("synthetic commit uncertainty")
	m.regularHeartbeatOnce()
	if m.regularLeaseAvailable() {
		t.Fatal("heartbeat error retained local authority")
	}
}
