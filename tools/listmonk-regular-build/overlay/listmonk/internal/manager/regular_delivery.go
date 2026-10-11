package manager

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/textproto"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"text/template/parse"
	"time"

	"github.com/gofrs/uuid/v5"
	"github.com/knadh/listmonk/models"
	"github.com/knadh/smtppool/v2"
)

const (
	regularDispatchHeader            = "X-Crm-Dispatch-Id"
	regularSESTagsHeader             = "X-Ses-Message-Tags"
	regularSESConfigurationSetHeader = "X-SES-Configuration-Set"
)

var regularForbiddenTemplateFunctions = map[string]struct{}{
	// Manager functions with mutable global or wall-clock dependencies.
	"Date": {}, "L": {},
	// Sprig functions backed by wall clock, process randomness, crypto/rand or
	// mutable global RNG state. env/expandenv/getHostByName are already absent
	// from Listmonk's function map and therefore fail at template compilation.
	"ago": {}, "date": {}, "date_in_zone": {}, "date_modify": {}, "now": {},
	"htmlDate": {}, "htmlDateInZone": {}, "dateInZone": {}, "dateModify": {},
	"randAlphaNum": {}, "randAlpha": {}, "randAscii": {}, "randNumeric": {},
	"randBytes": {}, "randInt": {}, "shuffle": {}, "uuidv4": {},
	"bcrypt": {}, "htpasswd": {}, "genPrivateKey": {}, "genCA": {},
	"genCAWithKey": {}, "genSelfSignedCert": {}, "genSelfSignedCertWithKey": {},
	"genSignedCert": {}, "genSignedCertWithKey": {}, "encryptAES": {},
}

type RegularDeliveryGate struct {
	Bound            bool
	Ready            bool
	ConfigurationSet string
}

type RegularDeliveryClaim struct {
	InstanceID         string
	CampaignID         int
	SubscriberID       int
	DispatchID         string
	WorkerSHA256       string
	RuntimeSHA256      string
	EnvelopeFrom       string
	EnvelopeTo         string
	PayloadSHA256      string
	SubscriberSnapshot json.RawMessage
	ConfigurationSet   string
}

type RegularWorkerHeartbeat struct {
	InstanceID    string
	WorkerSHA256  string
	RuntimeSHA256 string
}

type RegularWorkerHeartbeatResult struct {
	Ready      bool
	Reason     string
	InstanceID string
	CheckedAt  time.Time
	ExpiresAt  time.Time
	Deadline   time.Time
}

type RegularDeliveryClaimResult struct {
	ShouldSend bool
	Reason     string
	DispatchID string
	ClaimToken string
	CheckedAt  time.Time
	ValidUntil time.Time
}

type RegularDeliveryStore interface {
	HeartbeatRegularWorker(RegularWorkerHeartbeat) (RegularWorkerHeartbeatResult, error)
	RegularDeliveryGate(campaignID int) (RegularDeliveryGate, error)
	ClaimRegularDelivery(RegularDeliveryClaim) (RegularDeliveryClaimResult, error)
	FinishRegularDelivery(campaignID, subscriberID int, dispatchID, claimToken, outcome string) error
	FinalizeRegularDelivery(campaignID int) error
}

type guardedRegularMessenger interface {
	PushRegularGuarded(models.Message, smtppool.GuardedAuthorize) (smtppool.GuardedSendResult, error)
	GuardedConfigSHA256() (string, error)
}

var (
	workerSHAOnce sync.Once
	workerSHA     string
	workerSHAErr  error
	processIDOnce sync.Once
	processID     string
	processIDErr  error
)

func (m *Manager) regularStore() (RegularDeliveryStore, error) {
	store, ok := m.store.(RegularDeliveryStore)
	if !ok {
		return nil, errors.New("regular delivery store unavailable")
	}
	return store, nil
}

func (m *Manager) regularDeliveryGate(campaignID int) (RegularDeliveryGate, error) {
	store, err := m.regularStore()
	if err != nil {
		return RegularDeliveryGate{}, err
	}
	gate, err := store.RegularDeliveryGate(campaignID)
	if err != nil || !gate.Bound {
		return gate, err
	}
	if !m.regularLeaseAvailable() {
		m.logRegularPause(campaignID, regularPauseLease, regularPauseLeaseUnavailable, nil)
		gate.Ready = false
	}
	return gate, nil
}

func regularProcessID() (string, error) {
	processIDOnce.Do(func() {
		id, err := uuid.NewV4()
		if err != nil {
			processIDErr = errors.New("regular delivery process identity unavailable")
			return
		}
		processID = id.String()
	})
	return processID, processIDErr
}

func (m *Manager) regularHeartbeatIdentity() (RegularWorkerHeartbeat, error) {
	instance, err := regularProcessID()
	if err != nil {
		return RegularWorkerHeartbeat{}, err
	}
	worker, err := executableSHA256()
	if err != nil {
		return RegularWorkerHeartbeat{}, err
	}
	messenger, ok := m.messengers["email"].(guardedRegularMessenger)
	if !ok {
		return RegularWorkerHeartbeat{}, errors.New("regular delivery messenger identity unavailable")
	}
	runtimeSHA, err := m.regularRuntimeSHA("email", messenger)
	if err != nil {
		return RegularWorkerHeartbeat{}, err
	}
	return RegularWorkerHeartbeat{InstanceID: instance, WorkerSHA256: worker, RuntimeSHA256: runtimeSHA}, nil
}

func (m *Manager) setRegularLease(result RegularWorkerHeartbeatResult, runtimeSHA string) {
	m.regularLeaseMu.Lock()
	defer m.regularLeaseMu.Unlock()
	m.regularLeaseReady = result.Ready && time.Now().Before(result.Deadline)
	m.regularLeaseDeadline = result.Deadline
	m.regularLeaseRuntimeSHA = runtimeSHA
}

func (m *Manager) clearRegularLease() {
	m.regularLeaseMu.Lock()
	m.regularLeaseReady = false
	m.regularLeaseDeadline = time.Time{}
	m.regularLeaseRuntimeSHA = ""
	m.regularLeaseMu.Unlock()
}

func (m *Manager) regularLeaseAvailable() bool {
	identity, err := m.regularHeartbeatIdentity()
	if err != nil {
		m.clearRegularLease()
		return false
	}
	m.regularLeaseMu.RLock()
	ready := m.regularLeaseReady && identity.RuntimeSHA256 == m.regularLeaseRuntimeSHA &&
		time.Now().Before(m.regularLeaseDeadline)
	m.regularLeaseMu.RUnlock()
	if !ready {
		m.clearRegularLease()
	}
	return ready
}

func (m *Manager) regularHeartbeatOnce() {
	store, err := m.regularStore()
	if err != nil {
		m.logRegularPause(0, regularPauseHeartbeat, regularPauseStoreUnavailable, err)
		m.clearRegularLease()
		return
	}
	identity, err := m.regularHeartbeatIdentity()
	if err != nil {
		m.logRegularPause(0, regularPauseHeartbeat, regularPauseIdentityUnavailable, err)
		m.clearRegularLease()
		return
	}
	result, err := store.HeartbeatRegularWorker(identity)
	if err != nil || !result.Ready || result.InstanceID != identity.InstanceID ||
		!time.Now().Before(result.Deadline) {
		m.logRegularPause(0, regularPauseHeartbeat, regularPauseHeartbeatUnavailable, err)
		m.clearRegularLease()
		return
	}
	m.setRegularLease(result, identity.RuntimeSHA256)
}

func (m *Manager) startRegularHeartbeat() {
	m.regularHeartbeatStartOnce.Do(func() {
		m.regularHeartbeatMu.Lock()
		m.regularHeartbeatStarted = true
		m.regularHeartbeatMu.Unlock()
		// This synchronous transaction must have a confirmed COMMIT before
		// the campaign scanner is allowed to start.
		m.regularHeartbeatOnce()
		go func() {
			defer close(m.regularHeartbeatDone)
			ticker := time.NewTicker(20 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					m.regularHeartbeatOnce()
				case <-m.regularHeartbeatStop:
					m.clearRegularLease()
					return
				}
			}
		}()
	})
}

func (m *Manager) stopRegularHeartbeat() {
	m.regularHeartbeatMu.Lock()
	started := m.regularHeartbeatStarted
	m.regularHeartbeatMu.Unlock()
	if !started {
		m.clearRegularLease()
		return
	}
	m.regularHeartbeatStopOnce.Do(func() { close(m.regularHeartbeatStop) })
	<-m.regularHeartbeatDone
}

func executableSHA256() (string, error) {
	workerSHAOnce.Do(func() {
		path, err := os.Executable()
		if runtime.GOOS == "linux" {
			if _, statErr := os.Stat("/proc/self/exe"); statErr == nil {
				path = "/proc/self/exe"
			}
		}
		if err != nil {
			workerSHAErr = errors.New("regular delivery executable identity unavailable")
			return
		}
		file, err := os.Open(path)
		if err != nil {
			workerSHAErr = errors.New("regular delivery executable identity unavailable")
			return
		}
		defer file.Close()
		hash := sha256.New()
		if _, err := io.Copy(hash, file); err != nil {
			workerSHAErr = errors.New("regular delivery executable identity unavailable")
			return
		}
		workerSHA = hex.EncodeToString(hash.Sum(nil))
	})
	return workerSHA, workerSHAErr
}

func (m *Manager) regularRuntimeSHA(messengerName string, messenger guardedRegularMessenger) (string, error) {
	messengerSHA, err := messenger.GuardedConfigSHA256()
	if err != nil {
		return "", errors.New("regular delivery messenger identity unavailable")
	}
	render, err := m.regularRenderIdentity()
	if err != nil {
		return "", err
	}
	material := struct {
		Schema          string
		Manager         Config
		MessengerName   string
		MessengerSHA256 string
		Render          regularRenderIdentity
	}{
		Schema: "listmonk-regular-manager-runtime-v2", Manager: m.cfg,
		MessengerName: messengerName, MessengerSHA256: messengerSHA, Render: render,
	}
	body, err := json.Marshal(material)
	if err != nil {
		return "", errors.New("regular delivery runtime identity unavailable")
	}
	return fmt.Sprintf("%x", sha256.Sum256(body)), nil
}

type regularRenderIdentity struct {
	Schema               string
	I18nCode             string
	I18nSHA256           string
	TimezoneSHA256       string
	TemplatePolicySHA256 string
}

func (m *Manager) regularRenderIdentity() (regularRenderIdentity, error) {
	if m.i18n == nil {
		return regularRenderIdentity{}, errors.New("regular delivery render identity unavailable")
	}
	language := m.i18n.JSON()
	if !json.Valid(language) || m.i18n.Code == "" {
		return regularRenderIdentity{}, errors.New("regular delivery render identity unavailable")
	}
	forbidden := make([]string, 0, len(regularForbiddenTemplateFunctions))
	for name := range regularForbiddenTemplateFunctions {
		forbidden = append(forbidden, name)
	}
	sort.Strings(forbidden)
	policy, err := json.Marshal(struct {
		Schema             string
		AttachmentsAllowed bool
		ForbiddenFunctions []string
	}{"listmonk-regular-template-policy-v1", false, forbidden})
	if err != nil {
		return regularRenderIdentity{}, errors.New("regular delivery render identity unavailable")
	}
	timezone, err := regularTimezoneMaterial()
	if err != nil {
		return regularRenderIdentity{}, err
	}
	return regularRenderIdentity{
		Schema: "listmonk-regular-render-v1", I18nCode: m.i18n.Code,
		I18nSHA256:           fmt.Sprintf("%x", sha256.Sum256(language)),
		TimezoneSHA256:       fmt.Sprintf("%x", sha256.Sum256(timezone)),
		TemplatePolicySHA256: fmt.Sprintf("%x", sha256.Sum256(policy)),
	}, nil
}

func regularTimezoneMaterial() ([]byte, error) {
	type sample struct {
		At     string
		Name   string
		Offset int
	}
	samples := make([]sample, 0, 12*31)
	// Bound rendering rejects wall-clock functions. These samples pin the
	// effective local-zone rules used by explicit time values across the
	// operational date range without trusting only a TZ name or environment.
	for year := 2000; year <= 2030; year++ {
		for month := time.January; month <= time.December; month++ {
			at := time.Date(year, month, 15, 12, 0, 0, 0, time.UTC)
			name, offset := at.In(time.Local).Zone()
			samples = append(samples, sample{At: at.Format(time.RFC3339), Name: name, Offset: offset})
		}
	}
	body, err := json.Marshal(struct {
		Schema   string
		Location string
		TZ       string
		Samples  []sample
	}{"listmonk-regular-timezone-v1", time.Local.String(), os.Getenv("TZ"), samples})
	if err != nil {
		return nil, errors.New("regular delivery timezone identity unavailable")
	}
	return body, nil
}

func (m *Manager) validateRegularCampaign(c *models.Campaign) error {
	if len(c.MediaIDs) != 0 || len(c.Attachments) != 0 {
		return errors.New("regular delivery attachments unavailable")
	}
	identifiers := make(map[string]struct{})
	if c.SubjectTpl != nil {
		for _, tpl := range c.SubjectTpl.Templates() {
			if tpl.Tree != nil {
				walkRegularTemplateNode(tpl.Tree.Root, identifiers)
			}
		}
	}
	if c.Tpl != nil {
		for _, tpl := range c.Tpl.Templates() {
			if tpl.Tree != nil {
				walkRegularTemplateNode(tpl.Tree.Root, identifiers)
			}
		}
	}
	if c.AltBodyTpl != nil {
		for _, tpl := range c.AltBodyTpl.Templates() {
			if tpl.Tree != nil {
				walkRegularTemplateNode(tpl.Tree.Root, identifiers)
			}
		}
	}
	for name := range identifiers {
		if _, blocked := regularForbiddenTemplateFunctions[name]; blocked {
			return errors.New("regular delivery template function unavailable")
		}
	}
	return nil
}

func walkRegularTemplateNode(node parse.Node, identifiers map[string]struct{}) {
	if node == nil {
		return
	}
	switch value := node.(type) {
	case *parse.ListNode:
		if value == nil {
			return
		}
		for _, child := range value.Nodes {
			walkRegularTemplateNode(child, identifiers)
		}
	case *parse.ActionNode:
		if value == nil {
			return
		}
		walkRegularTemplateNode(value.Pipe, identifiers)
	case *parse.PipeNode:
		if value == nil {
			return
		}
		for _, command := range value.Cmds {
			walkRegularTemplateNode(command, identifiers)
		}
	case *parse.CommandNode:
		if value == nil {
			return
		}
		for _, argument := range value.Args {
			walkRegularTemplateNode(argument, identifiers)
		}
	case *parse.IdentifierNode:
		if value == nil {
			return
		}
		identifiers[value.Ident] = struct{}{}
	case *parse.ChainNode:
		if value == nil {
			return
		}
		walkRegularTemplateNode(value.Node, identifiers)
	case *parse.IfNode:
		if value == nil {
			return
		}
		walkRegularTemplateNode(value.Pipe, identifiers)
		walkRegularTemplateNode(value.List, identifiers)
		walkRegularTemplateNode(value.ElseList, identifiers)
	case *parse.RangeNode:
		if value == nil {
			return
		}
		walkRegularTemplateNode(value.Pipe, identifiers)
		walkRegularTemplateNode(value.List, identifiers)
		walkRegularTemplateNode(value.ElseList, identifiers)
	case *parse.WithNode:
		if value == nil {
			return
		}
		walkRegularTemplateNode(value.Pipe, identifiers)
		walkRegularTemplateNode(value.List, identifiers)
		walkRegularTemplateNode(value.ElseList, identifiers)
	case *parse.TemplateNode:
		if value == nil {
			return
		}
		walkRegularTemplateNode(value.Pipe, identifiers)
	}
}

// RegularDeliveryIdentity returns only the executable and effective runtime
// fingerprints used by guarded claims. It performs no database write or SMTP
// operation and refuses messengers that do not implement the guarded contract.
func (m *Manager) RegularDeliveryIdentity(messengerName string) (string, string, error) {
	messenger, ok := m.messengers[messengerName].(guardedRegularMessenger)
	if !ok {
		return "", "", errors.New("regular delivery messenger identity unavailable")
	}
	worker, err := executableSHA256()
	if err != nil {
		return "", "", err
	}
	runtime, err := m.regularRuntimeSHA(messengerName, messenger)
	if err != nil {
		return "", "", err
	}
	return worker, runtime, nil
}

func (m *Manager) outgoingCampaignMessage(msg CampaignMessage, dispatchID, configurationSet string, guarded bool) models.Message {
	out := models.Message{
		From: msg.from, To: []string{msg.to}, Subject: msg.subject,
		ContentType: msg.Campaign.ContentType, Body: msg.body, AltBody: msg.altBody,
		Subscriber: msg.Subscriber, Campaign: msg.Campaign, Attachments: msg.Campaign.Attachments,
	}
	h := textproto.MIMEHeader{}
	h.Set(models.EmailHeaderCampaignUUID, msg.Campaign.UUID)
	h.Set(models.EmailHeaderSubscriberUUID, msg.Subscriber.UUID)
	if m.cfg.UnsubHeader {
		h.Set("List-Unsubscribe-Post", "List-Unsubscribe=One-Click")
		h.Set("List-Unsubscribe", `<`+msg.unsubURL+`>`)
	}
	for _, set := range msg.Campaign.Headers {
		for header, value := range set {
			if guarded && strings.EqualFold(header, regularSESConfigurationSetHeader) {
				continue
			}
			if guarded && strings.EqualFold(header, regularDispatchHeader) {
				continue
			}
			if guarded && strings.EqualFold(header, regularSESTagsHeader) {
				value = regularTagsWithoutReserved(value)
				if value == "" {
					continue
				}
			}
			h.Add(header, value)
		}
	}
	if guarded {
		h.Set(regularSESConfigurationSetHeader, configurationSet)
		h.Set(regularDispatchHeader, dispatchID)
		tags := strings.TrimSpace(h.Get(regularSESTagsHeader))
		reserved := "crm_dispatch_id=" + dispatchID + ", crm_test=false"
		if tags != "" {
			reserved = tags + ", " + reserved
		}
		h.Set(regularSESTagsHeader, reserved)
	}
	out.Headers = h
	return out
}

func regularTagsWithoutReserved(value string) string {
	parts := make([]string, 0)
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		key := strings.TrimSpace(strings.SplitN(part, "=", 2)[0])
		if part == "" || strings.EqualFold(key, "crm_dispatch_id") || strings.EqualFold(key, "crm_test") {
			continue
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, ", ")
}

func (m *Manager) processQueuedCampaignMessage(msg CampaignMessage, numMsg *int) {
	if msg.regularDone != nil {
		defer close(msg.regularDone)
	}
	if msg.pipe != nil && msg.pipe.stopped.Load() {
		msg.pipe.wg.Done()
		return
	}
	if *numMsg >= m.cfg.MessageRate {
		time.Sleep(time.Second)
		*numMsg = 0
	}
	*numMsg++
	gate, err := m.regularDeliveryGate(msg.Campaign.ID)
	if err != nil || (gate.Bound && !gate.Ready) || (!gate.Bound && msg.regularDone != nil) {
		m.logRegularPause(msg.Campaign.ID, regularPauseQueueGate, regularPauseGateUnavailable, err)
		if msg.pipe != nil {
			msg.pipe.wg.Done()
			msg.pipe.Stop(true)
		}
		return
	}
	if gate.Bound {
		if msg.regularDone == nil || msg.pipe == nil {
			m.logRegularPause(msg.Campaign.ID, regularPauseQueueGate, regularPausePipelineUnavailable, nil)
			if msg.pipe != nil {
				msg.pipe.wg.Done()
				msg.pipe.Stop(true)
			}
			return
		}
		m.processBoundCampaignMessage(msg, gate.ConfigurationSet)
		return
	}
	out := m.outgoingCampaignMessage(msg, "", "", false)
	err = m.messengers[msg.Campaign.Messenger].Push(out)
	if err != nil {
		m.log.Printf("error sending message in campaign %s: subscriber %d: %v", msg.Campaign.Name, msg.Subscriber.ID, err)
	}
	if msg.pipe == nil {
		return
	}
	defer msg.pipe.wg.Done()
	if err != nil {
		msg.pipe.OnError()
		return
	}
	id := uint64(msg.Subscriber.ID)
	if id > msg.pipe.lastID.Load() {
		msg.pipe.lastID.Store(id)
	}
	msg.pipe.rate.Incr(1)
	msg.pipe.sent.Add(1)
}

func (m *Manager) processBoundCampaignMessage(msg CampaignMessage, configurationSet string) {
	defer msg.pipe.wg.Done()
	if msg.pipe.stopped.Load() {
		return
	}
	if configurationSet == "" {
		m.logRegularPause(msg.Campaign.ID, regularPausePreflight, regularPauseConfigurationUnavailable, nil)
		msg.pipe.Stop(true)
		return
	}
	store, err := m.regularStore()
	if err != nil {
		m.logRegularPause(msg.Campaign.ID, regularPausePreflight, regularPauseStoreUnavailable, err)
		msg.pipe.Stop(true)
		return
	}
	messenger, ok := m.messengers[msg.Campaign.Messenger].(guardedRegularMessenger)
	if !ok {
		m.logRegularPause(msg.Campaign.ID, regularPausePreflight, regularPauseMessengerUnavailable, err)
		msg.pipe.Stop(true)
		return
	}
	dispatch, err := uuid.NewV4()
	if err != nil {
		m.logRegularPause(msg.Campaign.ID, regularPausePreflight, regularPauseDispatchUnavailable, err)
		msg.pipe.Stop(true)
		return
	}
	dispatchID := dispatch.String()
	out := m.outgoingCampaignMessage(msg, dispatchID, configurationSet, true)
	configurationSet = out.Headers.Get(regularSESConfigurationSetHeader)
	if configurationSet == "" {
		m.logRegularPause(msg.Campaign.ID, regularPausePreflight, regularPauseConfigurationUnavailable, nil)
		msg.pipe.Stop(true)
		return
	}
	workerSHA, err := executableSHA256()
	if err != nil {
		m.logRegularPause(msg.Campaign.ID, regularPausePreflight, regularPauseWorkerUnavailable, err)
		msg.pipe.Stop(true)
		return
	}
	runtimeSHA, err := m.regularRuntimeSHA(msg.Campaign.Messenger, messenger)
	if err != nil {
		m.logRegularPause(msg.Campaign.ID, regularPausePreflight, regularPauseRuntimeUnavailable, err)
		msg.pipe.Stop(true)
		return
	}
	snapshot := json.RawMessage(append([]byte(nil), msg.Subscriber.DeliverySnapshot...))
	if !json.Valid(snapshot) || len(snapshot) == 0 {
		m.logRegularPause(msg.Campaign.ID, regularPausePreflight, regularPauseSnapshotUnavailable, nil)
		msg.pipe.Stop(true)
		return
	}
	instanceID, err := regularProcessID()
	if err != nil {
		m.logRegularPause(msg.Campaign.ID, regularPausePreflight, regularPauseProcessUnavailable, err)
		msg.pipe.Stop(true)
		return
	}
	var claim RegularDeliveryClaimResult
	var claimStoreErr error
	claimAttempted := false
	result, sendErr := messenger.PushRegularGuarded(out, func(envelope smtppool.GuardedEnvelope) error {
		claimAttempted = true
		claim, claimStoreErr = store.ClaimRegularDelivery(RegularDeliveryClaim{
			InstanceID: instanceID, CampaignID: msg.Campaign.ID, SubscriberID: msg.Subscriber.ID, DispatchID: dispatchID,
			WorkerSHA256: workerSHA, RuntimeSHA256: runtimeSHA, EnvelopeFrom: envelope.From,
			EnvelopeTo: envelope.To, PayloadSHA256: envelope.PayloadSHA256, SubscriberSnapshot: snapshot,
			ConfigurationSet: configurationSet,
		})
		if claimStoreErr != nil || !claim.ShouldSend {
			return errors.New("regular delivery authorization denied")
		}
		return nil
	})
	if result.Outcome == smtppool.GuardedAccepted && sendErr == nil && claim.ShouldSend {
		if err := store.FinishRegularDelivery(msg.Campaign.ID, msg.Subscriber.ID, dispatchID, claim.ClaimToken, "accepted"); err != nil {
			m.logRegularGuardedDiagnostic(msg.Campaign.ID, dispatchID, result, sendErr, err)
			msg.pipe.Stop(true)
			return
		}
		msg.pipe.rate.Incr(1)
		return
	}
	if result.Outcome == smtppool.GuardedOutcomeUnknown && claim.ShouldSend {
		finishErr := store.FinishRegularDelivery(msg.Campaign.ID, msg.Subscriber.ID, dispatchID, claim.ClaimToken, "outcome_unknown")
		m.logRegularGuardedDiagnostic(msg.Campaign.ID, dispatchID, result, sendErr, finishErr)
		msg.pipe.Stop(true)
		return
	}
	if result.Outcome == smtppool.GuardedNotStarted && claimStoreErr == nil && !claim.ShouldSend &&
		(claim.Reason == "ineligible" || claim.Reason == "already_checkpointed" || claim.Reason == "accepted") {
		return
	}
	m.logRegularGuardedDiagnostic(msg.Campaign.ID, dispatchID, result, sendErr, nil)
	if claimAttempted && (claimStoreErr != nil || !claim.ShouldSend) {
		m.logRegularPause(msg.Campaign.ID, regularPauseClaim, regularClaimPauseCode(claim.Reason), claimStoreErr)
	}
	msg.pipe.Stop(true)
}

// regularGuardedDiagnosticLine contains only public campaign/dispatch identity
// and closed diagnostics. It never changes Outcome, ShouldSend or delivery flow.
func regularGuardedDiagnosticLine(campaignID int, dispatchID string, result smtppool.GuardedSendResult, sendErr, finishErr error) string {
	if campaignID < 1 { campaignID = 0 }
	if id, err := uuid.FromString(dispatchID); err != nil || id.String() != dispatchID || id == uuid.Nil {
		dispatchID = "invalid"
	}
	outcome := string(result.Outcome)
	switch result.Outcome {
	case smtppool.GuardedNotStarted, smtppool.GuardedAccepted, smtppool.GuardedOutcomeUnknown:
	default: outcome = "invalid"
	}
	phase := result.Phase
	switch phase {
	case smtppool.GuardedPhasePreflight, smtppool.GuardedPhaseBuild, smtppool.GuardedPhasePool,
		smtppool.GuardedPhaseAuthorize, smtppool.GuardedPhaseDeadline, smtppool.GuardedPhaseMail,
		smtppool.GuardedPhaseRcpt, smtppool.GuardedPhaseData, smtppool.GuardedPhaseWrite,
		smtppool.GuardedPhaseAck, smtppool.GuardedPhaseComplete:
	default: phase = smtppool.GuardedPhaseUnknown
	}
	// Reclassify the same returned error by type, never by error text. This also
	// covers Emailer refusals before SendGuarded and ignores arbitrary DTO text.
	replyCode, errorClass := smtppool.DiagnoseGuardedError(sendErr)
	_, finishClass := smtppool.DiagnoseGuardedError(finishErr)
	finishState := "none"
	if finishErr != nil {
		finishState = "unavailable"
		var pg interface { SQLState() string }
		if errors.As(finishErr, &pg) {
			switch code := pg.SQLState(); code {
			case "55P03", "57014", "55000", "P0001", "40001", "40P01", "25P02", "42501":
				finishState = code
			default: finishState = "other"
			}
		}
	}
	return fmt.Sprintf("guarded_smtp campaign_id=%d dispatch_id=%s outcome=%s phase=%s reply_code=%d error_class=%s finish_error_class=%s finish_sqlstate=%s",
		campaignID, dispatchID, outcome, phase, replyCode, errorClass, finishClass, finishState)
}

func (m *Manager) logRegularGuardedDiagnostic(campaignID int, dispatchID string, result smtppool.GuardedSendResult, sendErr, finishErr error) {
	m.log.Print(regularGuardedDiagnosticLine(campaignID, dispatchID, result, sendErr, finishErr))
}
