package manager

import (
	"bytes"
	"errors"
	"log"
	"net/textproto"
	"strings"
	"testing"

	"github.com/knadh/smtppool/v2"
)

type regularDiagnosticSecretError struct{}
func (regularDiagnosticSecretError) Error() string { panic("ERROR_TEXT_ACCESSED") }

type regularDiagnosticSQLStateError struct { code string }
func (regularDiagnosticSQLStateError) Error() string { panic("ERROR_TEXT_ACCESSED") }
func (e regularDiagnosticSQLStateError) SQLState() string { return e.code }

func TestRegularGuardedSMTPDiagnosticClosedLog(t *testing.T) {
	var out bytes.Buffer
	m := &Manager{log: log.New(&out, "", 0)}
	result := smtppool.GuardedSendResult{Outcome:smtppool.GuardedOutcomeUnknown, Phase:smtppool.GuardedPhaseRcpt, ReplyCode:550, ErrorClass:smtppool.GuardedErrorSMTPPermanent}
	m.logRegularGuardedDiagnostic(174, "63317c6b-a460-4f9f-aa2e-3e4ee1ab9ea6", result,
		&textproto.Error{Code:550, Msg:"PRIVATE_SENTINEL recipient@example.invalid"}, regularDiagnosticSQLStateError{"55P03"})
	want := "guarded_smtp campaign_id=174 dispatch_id=63317c6b-a460-4f9f-aa2e-3e4ee1ab9ea6 outcome=outcome_unknown phase=rcpt reply_code=550 error_class=smtp_permanent finish_error_class=other finish_sqlstate=55P03\n"
	if out.String() != want { t.Fatal("CLOSED_LOG_MISMATCH") }
}

func TestRegularGuardedSMTPDiagnosticUntrustedValues(t *testing.T) {
	result := smtppool.GuardedSendResult{Outcome:smtppool.GuardedOutcome("PRIVATE_SENTINEL"), Phase:smtppool.GuardedPhase("PRIVATE_SENTINEL"), ReplyCode:1234567, ErrorClass:smtppool.GuardedErrorClass("PRIVATE_SENTINEL")}
	line := regularGuardedDiagnosticLine(-1, "PRIVATE_SENTINEL\ninjected", result, regularDiagnosticSecretError{}, regularDiagnosticSQLStateError{"PRIVATE_SENTINEL"})
	want := "guarded_smtp campaign_id=0 dispatch_id=invalid outcome=invalid phase=unknown reply_code=0 error_class=other finish_error_class=other finish_sqlstate=other"
	if line != want { t.Fatal("UNTRUSTED_LOG_VALUE") }
}

func TestRegularGuardedSMTPDiagnosticFinishGenericRemainsUnavailable(t *testing.T) {
	result := smtppool.GuardedSendResult{Outcome:smtppool.GuardedAccepted, Phase:smtppool.GuardedPhaseComplete}
	line := regularGuardedDiagnosticLine(174, "63317c6b-a460-4f9f-aa2e-3e4ee1ab9ea6", result, nil, errors.New("regular delivery finish unavailable PRIVATE_SENTINEL"))
	if !strings.HasSuffix(line, "finish_error_class=other finish_sqlstate=unavailable") || !strings.Contains(line, "outcome=accepted") || strings.Contains(line, "PRIVATE_SENTINEL") { t.Fatal("GENERIC_FINISH_INVENTED_OR_EXPOSED") }
}
