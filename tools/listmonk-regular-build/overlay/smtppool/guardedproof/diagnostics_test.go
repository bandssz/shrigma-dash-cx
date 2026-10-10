package guardedproof_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/knadh/smtppool/v2"
)

// Real TCP + net/smtp + the actual guarded Pool. No fake Pool/SMTP client.
// Everything is synthetic and loopback-only; no production configuration.
type diagnosticSMTP struct {
	listener net.Listener
	mode string
	mails atomic.Int32
	rcpts atomic.Int32
	data atomic.Int32
	completed atomic.Int32
	wg sync.WaitGroup
	mu sync.Mutex
	connections []net.Conn
}

func diagnosticServer(t *testing.T, mode string) *diagnosticSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil { t.Fatal("LOOPBACK_LISTEN_REFUSED") }
	s := &diagnosticSMTP{listener: ln, mode: mode}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil { return }
			s.mu.Lock()
			s.connections = append(s.connections, c)
			s.mu.Unlock()
			s.wg.Add(1)
			go func() { defer s.wg.Done(); s.handle(c) }()
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		s.mu.Lock()
		for _, c := range s.connections { _ = c.Close() }
		s.mu.Unlock()
		s.wg.Wait()
	})
	return s
}

func (s *diagnosticSMTP) handle(c net.Conn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.WriteString(c, "220 synthetic.invalid ESMTP\r\n")
	r := bufio.NewScanner(c)
	r.Buffer(make([]byte, 4096), 8 * 1024 * 1024)
	for r.Scan() {
		command := strings.ToUpper(strings.SplitN(r.Text(), " ", 2)[0])
		switch command {
		case "HELO", "EHLO":
			_, _ = io.WriteString(c, "250-synthetic.invalid\r\n250 PIPELINING\r\n")
		case "MAIL":
			s.mails.Add(1)
			if s.mode == "mail" {
				_, _ = io.WriteString(c, "451 PRIVATE_SENTINEL sender@example.invalid\r\n")
			} else { _, _ = io.WriteString(c, "250 ok\r\n") }
		case "RCPT":
			s.rcpts.Add(1)
			if s.mode == "rcpt" {
				_, _ = io.WriteString(c, "550 PRIVATE_SENTINEL recipient@example.invalid\r\n")
			} else { _, _ = io.WriteString(c, "250 ok\r\n") }
		case "DATA":
			s.data.Add(1)
			if s.mode == "data" {
				_, _ = io.WriteString(c, "451 PRIVATE_SENTINEL data unavailable\r\n")
				continue
			}
			_, _ = io.WriteString(c, "354 send body\r\n")
			for r.Scan() { if r.Text() == "." { s.completed.Add(1); break } }
			switch s.mode {
			case "lost_ack": return
			case "close": _, _ = io.WriteString(c, "554 PRIVATE_SENTINEL body rejected\r\n")
			case "mute_ack":
				// The actual pool's socket deadline must end this wait. Closing
				// this fixture later cannot cause a second MAIL.
				time.Sleep(2500 * time.Millisecond)
				return
			default: _, _ = io.WriteString(c, "250 queued\r\n")
			}
		case "RSET":
			if s.mode == "reset_failure" {
				_, _ = io.WriteString(c, "550 PRIVATE_SENTINEL cleanup rejected\r\n")
			} else { _, _ = io.WriteString(c, "250 reset\r\n") }
		case "QUIT": _, _ = io.WriteString(c, "221 bye\r\n"); return
		default: _, _ = io.WriteString(c, "502 unsupported\r\n")
		}
	}
}

func diagnosticPool(t *testing.T, s *diagnosticSMTP) *smtppool.Pool {
	t.Helper()
	p, err := smtppool.New(smtppool.Opt{
		Host: "127.0.0.1", Port: s.listener.Addr().(*net.TCPAddr).Port,
		MaxConns: 1, MaxMessageRetries: 9, PoolWaitTimeout: 2 * time.Second,
		SSL: smtppool.SSLNone,
	})
	if err != nil { t.Fatal("POOL_CREATE_REFUSED") }
	t.Cleanup(p.Close)
	return p
}

func diagnosticMessage() smtppool.Email {
	return smtppool.Email{From: "sender@example.invalid", To: []string{"recipient@example.invalid"},
		Subject: "synthetic", Text: []byte("PRIVATE_SENTINEL synthetic body")}
}

func TestGuardedSMTPDiagnosticLoopback(t *testing.T) {
	cases := []struct {
		mode string
		outcome smtppool.GuardedOutcome
		phase smtppool.GuardedPhase
		code smtppool.GuardedReplyCode
		class smtppool.GuardedErrorClass
		rcpts, data, completed int32
	}{
		{"mail", smtppool.GuardedOutcomeUnknown, smtppool.GuardedPhaseMail, 451, smtppool.GuardedErrorSMTPTransient, 0, 0, 0},
		{"rcpt", smtppool.GuardedOutcomeUnknown, smtppool.GuardedPhaseRcpt, 550, smtppool.GuardedErrorSMTPPermanent, 1, 0, 0},
		{"data", smtppool.GuardedOutcomeUnknown, smtppool.GuardedPhaseData, 451, smtppool.GuardedErrorSMTPTransient, 1, 1, 0},
		{"close", smtppool.GuardedOutcomeUnknown, smtppool.GuardedPhaseAck, 554, smtppool.GuardedErrorSMTPPermanent, 1, 1, 1},
		{"lost_ack", smtppool.GuardedOutcomeUnknown, smtppool.GuardedPhaseAck, 0, smtppool.GuardedErrorEOF, 1, 1, 1},
		{"mute_ack", smtppool.GuardedOutcomeUnknown, smtppool.GuardedPhaseAck, 0, smtppool.GuardedErrorTimeout, 1, 1, 1},
		{"accepted", smtppool.GuardedAccepted, smtppool.GuardedPhaseComplete, 0, smtppool.GuardedErrorNone, 1, 1, 1},
		{"reset_failure", smtppool.GuardedAccepted, smtppool.GuardedPhaseComplete, 0, smtppool.GuardedErrorNone, 1, 1, 1},
	}
	for _, tc := range cases {
		t.Run(tc.mode, func(t *testing.T) {
			s := diagnosticServer(t, tc.mode)
			p := diagnosticPool(t, s)
			calls := 0
			started := time.Now()
			result, err := p.SendGuarded(diagnosticMessage(), func(smtppool.GuardedEnvelope) error { calls++; return nil })
			if result.Outcome != tc.outcome || result.Phase != tc.phase || result.ReplyCode != tc.code || result.ErrorClass != tc.class {
				t.Fatal("DIAGNOSTIC_RESULT_MISMATCH")
			}
			if (err == nil) != (tc.outcome == smtppool.GuardedAccepted) { t.Fatal("ORIGINAL_OUTCOME_ERROR_MISMATCH") }
			if calls != 1 || s.mails.Load() != 1 || s.rcpts.Load() != tc.rcpts || s.data.Load() != tc.data || s.completed.Load() != tc.completed { t.Fatal("RETRANSMISSION_OR_PHASE_COUNT_MISMATCH") }
			if time.Since(started) > 4 * time.Second { t.Fatal("GUARDED_ATTEMPT_NOT_BOUNDED") }
			body, marshalErr := json.Marshal(result)
			if marshalErr != nil || strings.Contains(string(body), "PRIVATE_SENTINEL") || strings.Contains(string(body), "example.invalid") { t.Fatal("PRIVATE_DIAGNOSTIC_OUTPUT") }
		})
	}
}

func TestGuardedSMTPDiagnosticAuthorizationStillNotStarted(t *testing.T) {
	s := diagnosticServer(t, "accepted")
	p := diagnosticPool(t, s)
	denied := errors.New("PRIVATE_SENTINEL original authorization refusal")
	calls := 0
	result, err := p.SendGuarded(diagnosticMessage(), func(smtppool.GuardedEnvelope) error { calls++; return denied })
	if err != denied || result.Outcome != smtppool.GuardedNotStarted || result.Phase != smtppool.GuardedPhaseAuthorize || result.ErrorClass != smtppool.GuardedErrorOther || result.ReplyCode != 0 || calls != 1 || s.mails.Load() != 0 {
		t.Fatal("AUTHORIZATION_OR_ERROR_IDENTITY_CHANGED")
	}
}

// Error() deliberately panics: diagnostic classification must never call it.
type diagnosticSecretError struct{}
func (diagnosticSecretError) Error() string { panic("ERROR_TEXT_ACCESSED") }

func TestGuardedSMTPDiagnosticTypedErrorOnly(t *testing.T) {
	code, class := smtppool.DiagnoseGuardedError(diagnosticSecretError{})
	if code != 0 || class != smtppool.GuardedErrorOther { t.Fatal("OTHER_CLASS_MISMATCH") }
	for _, n := range []int{99, 600, 1234567} {
		code, class := smtppool.DiagnoseGuardedError(&textproto.Error{Code:n, Msg:"PRIVATE_SENTINEL"})
		if code != 0 || class != smtppool.GuardedErrorOther { t.Fatal("UNBOUNDED_REPLY_CODE") }
	}
	code, class = smtppool.DiagnoseGuardedError(fmt.Errorf("wrapped: %w", &textproto.Error{Code:451, Msg:"PRIVATE_SENTINEL"}))
	if code != 451 || class != smtppool.GuardedErrorSMTPTransient { t.Fatal("WRAPPED_CODE_MISMATCH") }
}
