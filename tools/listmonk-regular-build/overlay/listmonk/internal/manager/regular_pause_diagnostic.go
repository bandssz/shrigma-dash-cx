package manager

import (
 "context"
 "errors"
 "fmt"
)

// This marker describes a refusal at a public phase. It is not authority to
// resume and does not establish a historical cause or a durable DB outcome.
type regularPausePhase string
type regularPauseCode string
const (
 regularPauseQueueGate regularPausePhase = "queue_gate"
 regularPausePipeGate regularPausePhase = "pipe_gate"
 regularPauseLease regularPausePhase = "lease"
 regularPauseHeartbeat regularPausePhase = "heartbeat"
 regularPausePreflight regularPausePhase = "preflight"
 regularPauseClaim regularPausePhase = "claim"
 regularPauseSubscriberGate regularPausePhase = "subscriber_gate"
 regularPauseSubscriberSelect regularPausePhase = "subscriber_select"
 regularPauseTemplate regularPausePhase = "template"
 regularPauseRender regularPausePhase = "render"
 regularPauseFinalize regularPausePhase = "finalize"
 regularPauseCleanup regularPausePhase = "cleanup"
 regularPausePauseWrite regularPausePhase = "pause_write"
 regularPauseGateUnavailable regularPauseCode = "gate_unavailable"
 regularPauseGateNotReady regularPauseCode = "gate_not_ready"
 regularPausePipelineUnavailable regularPauseCode = "pipeline_unavailable"
 regularPauseConfigurationUnavailable regularPauseCode = "configuration_unavailable"
 regularPauseStoreUnavailable regularPauseCode = "store_unavailable"
 regularPauseMessengerUnavailable regularPauseCode = "messenger_unavailable"
 regularPauseDispatchUnavailable regularPauseCode = "dispatch_unavailable"
 regularPauseWorkerUnavailable regularPauseCode = "worker_identity_unavailable"
 regularPauseRuntimeUnavailable regularPauseCode = "runtime_identity_unavailable"
 regularPauseIdentityUnavailable regularPauseCode = "heartbeat_identity_unavailable"
 regularPauseLeaseUnavailable regularPauseCode = "lease_unavailable"
 regularPauseHeartbeatUnavailable regularPauseCode = "heartbeat_unavailable"
 regularPauseSnapshotUnavailable regularPauseCode = "snapshot_unavailable"
 regularPauseProcessUnavailable regularPauseCode = "process_identity_unavailable"
 regularPauseSelectionUnavailable regularPauseCode = "selection_unavailable"
 regularPauseTemplateUnavailable regularPauseCode = "template_unavailable"
 regularPauseTemplatePolicy regularPauseCode = "template_policy_unavailable"
 regularPauseRenderUnavailable regularPauseCode = "render_unavailable"
 regularPauseFinalizeUnavailable regularPauseCode = "finalization_unavailable"
 regularPauseCommitted regularPauseCode = "pause_write_returned_nil"
 regularPauseUnconfirmed regularPauseCode = "pause_write_unconfirmed"
 regularPauseClaimRefused regularPauseCode = "claim_refused"
 regularPauseClaimInFlight regularPauseCode = "claim_in_flight"
 regularPauseClaimUnknown regularPauseCode = "claim_outcome_unknown"
 regularPauseClaimReserved regularPauseCode = "claim_reserved"
)

func regularPauseWriteCode(err error) regularPauseCode {
 if err == nil { return regularPauseCommitted }
 return regularPauseUnconfirmed
}
func regularClaimPauseCode(reason string) regularPauseCode {
 switch reason {
 case "in_flight": return regularPauseClaimInFlight
 case "outcome_unknown": return regularPauseClaimUnknown
 case "reserved": return regularPauseClaimReserved
 default: return regularPauseClaimRefused
 }
}
func regularPauseDiagnosticLine(campaignID int, phase regularPausePhase, code regularPauseCode, err error) string {
 if campaignID < 1 { campaignID = 0 }
 switch phase {
 case regularPauseQueueGate,regularPausePipeGate,regularPauseLease,regularPauseHeartbeat,
 regularPausePreflight,regularPauseClaim,regularPauseSubscriberGate,regularPauseSubscriberSelect,
 regularPauseTemplate,regularPauseRender,regularPauseFinalize,regularPauseCleanup,regularPausePauseWrite:
 default: phase = "unknown"
 }
 switch code {
 case regularPauseGateUnavailable,regularPauseGateNotReady,regularPausePipelineUnavailable,
 regularPauseConfigurationUnavailable,regularPauseStoreUnavailable,regularPauseMessengerUnavailable,
 regularPauseDispatchUnavailable,regularPauseWorkerUnavailable,regularPauseRuntimeUnavailable,
 regularPauseIdentityUnavailable,regularPauseLeaseUnavailable,regularPauseHeartbeatUnavailable,
 regularPauseSnapshotUnavailable,regularPauseProcessUnavailable,regularPauseSelectionUnavailable,
 regularPauseTemplateUnavailable,regularPauseTemplatePolicy,regularPauseRenderUnavailable,
 regularPauseFinalizeUnavailable,regularPauseCommitted,regularPauseUnconfirmed,
 regularPauseClaimRefused,regularPauseClaimInFlight,regularPauseClaimUnknown,regularPauseClaimReserved:
 default: code = "unknown"
 }
 errorClass, state := "none", "none"
 if err != nil {
  errorClass = "unavailable"
  var sqlError interface{ SQLState() string }
  if errors.As(err,&sqlError) {
   errorClass = "postgres"
   switch candidate := sqlError.SQLState(); candidate {
   case "55P03","57014","55000","P0001","40001","40P01","25P02","42501","23505","23503","22023","22P02": state = candidate
   default: state = "other"
   }
  } else if errors.Is(err,context.DeadlineExceeded) { errorClass = "deadline"
  } else if errors.Is(err,context.Canceled) { errorClass = "canceled" }
 }
 return fmt.Sprintf("protected_pause campaign_id=%d phase=%s code=%s error_class=%s sqlstate=%s",campaignID,phase,code,errorClass,state)
}
func (m *Manager) logRegularPause(campaignID int, phase regularPausePhase, code regularPauseCode, err error) {
 if m.log != nil { m.log.Print(regularPauseDiagnosticLine(campaignID,phase,code,err)) }
}
