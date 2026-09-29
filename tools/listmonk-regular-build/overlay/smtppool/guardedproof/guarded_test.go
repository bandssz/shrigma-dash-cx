package guardedproof_test

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/knadh/smtppool/v2"
)

type serverMode int

const (
	acceptMessage serverMode = iota
	rejectData
	dropFinalACK
	dropDuringWrite
	muteGreeting
	muteFinalACK
	muteReset
)

type smtpLoopback struct {
	listener net.Listener
	mode     serverMode
	mails    atomic.Int32
	data     atomic.Int32
	mu       sync.Mutex
	payloads [][]byte
	done     chan struct{}
}

func startSMTP(t *testing.T, mode serverMode) *smtpLoopback {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &smtpLoopback{listener: ln, mode: mode, done: make(chan struct{})}
	go s.serve()
	t.Cleanup(func() {
		_ = ln.Close()
		<-s.done
	})
	return s
}

func (s *smtpLoopback) serve() {
	defer close(s.done)
	for {
		c, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(c)
	}
}

func (s *smtpLoopback) handle(c net.Conn) {
	defer c.Close()
	if s.mode == muteGreeting {
		time.Sleep(3 * time.Second)
		return
	}
	_, _ = fmt.Fprint(c, "220 loopback.example ESMTP\r\n")
	scanner := bufio.NewScanner(c)
	for scanner.Scan() {
		line := scanner.Text()
		command := strings.ToUpper(strings.SplitN(line, " ", 2)[0])
		switch command {
		case "EHLO", "HELO":
			_, _ = fmt.Fprint(c, "250-loopback.example\r\n250 PIPELINING\r\n")
		case "MAIL":
			s.mails.Add(1)
			_, _ = fmt.Fprint(c, "250 sender ok\r\n")
		case "RCPT":
			_, _ = fmt.Fprint(c, "250 recipient ok\r\n")
		case "DATA":
			s.data.Add(1)
			if s.mode == rejectData {
				_, _ = fmt.Fprint(c, "451 data unavailable\r\n")
				continue
			}
			_, _ = fmt.Fprint(c, "354 end with dot\r\n")
			if s.mode == dropDuringWrite {
				if tcp, ok := c.(*net.TCPConn); ok {
					_ = tcp.SetLinger(0)
				}
				return
			}
			var payload []byte
			for scanner.Scan() {
				bodyLine := scanner.Text()
				if bodyLine == "." {
					break
				}
				if strings.HasPrefix(bodyLine, "..") {
					bodyLine = bodyLine[1:]
				}
				payload = append(payload, bodyLine...)
				payload = append(payload, '\r', '\n')
			}
			s.mu.Lock()
			s.payloads = append(s.payloads, append([]byte(nil), payload...))
			s.mu.Unlock()
			if s.mode == dropFinalACK {
				return
			}
			if s.mode == muteFinalACK {
				time.Sleep(3 * time.Second)
				return
			}
			_, _ = fmt.Fprint(c, "250 queued\r\n")
		case "RSET":
			if s.mode == muteReset {
				time.Sleep(3 * time.Second)
				return
			}
			_, _ = fmt.Fprint(c, "250 reset\r\n")
		case "QUIT":
			_, _ = fmt.Fprint(c, "221 bye\r\n")
			return
		default:
			_, _ = fmt.Fprint(c, "502 unsupported\r\n")
		}
	}
}

func TestMutedGreetingTimesOutBeforeAuthorization(t *testing.T) {
	s := startSMTP(t, muteGreeting)
	p := newPool(t, s)
	calls := 0
	started := time.Now()
	result, err := p.SendGuarded(message([]byte("body")), func(smtppool.GuardedEnvelope) error {
		calls++
		return nil
	})
	if err == nil || result.Outcome != smtppool.GuardedNotStarted || calls != 0 {
		t.Fatalf("muted greeting did not fail before authorization: %#v, %v, calls=%d", result, err, calls)
	}
	if elapsed := time.Since(started); elapsed > 2500*time.Millisecond {
		t.Fatalf("muted greeting exceeded bounded wait: %v", elapsed)
	}
	if s.mails.Load() != 0 {
		t.Fatalf("muted greeting issued MAIL: %d", s.mails.Load())
	}
}

func TestMutedFinalACKTimesOutUnknownWithoutRetry(t *testing.T) {
	s := startSMTP(t, muteFinalACK)
	p := newPool(t, s)
	started := time.Now()
	result, err := p.SendGuarded(message([]byte("body")), func(smtppool.GuardedEnvelope) error { return nil })
	if err == nil || result.Outcome != smtppool.GuardedOutcomeUnknown || s.mails.Load() != 1 {
		t.Fatalf("muted ACK result: %#v, %v, MAIL=%d", result, err, s.mails.Load())
	}
	if elapsed := time.Since(started); elapsed > 2500*time.Millisecond {
		t.Fatalf("muted ACK exceeded bounded wait: %v", elapsed)
	}
}

func TestMutedResetPreservesAcceptedAndIsBounded(t *testing.T) {
	s := startSMTP(t, muteReset)
	p := newPool(t, s)
	started := time.Now()
	result, err := p.SendGuarded(message([]byte("body")), func(smtppool.GuardedEnvelope) error { return nil })
	if err != nil || result.Outcome != smtppool.GuardedAccepted || s.mails.Load() != 1 {
		t.Fatalf("muted RSET changed accepted result: %#v, %v, MAIL=%d", result, err, s.mails.Load())
	}
	if elapsed := time.Since(started); elapsed > 2500*time.Millisecond {
		t.Fatalf("muted RSET exceeded bounded wait: %v", elapsed)
	}
}

func (s *smtpLoopback) port() int {
	return s.listener.Addr().(*net.TCPAddr).Port
}

func (s *smtpLoopback) firstPayload() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.payloads) == 0 {
		return nil
	}
	return append([]byte(nil), s.payloads[0]...)
}

func newPool(t *testing.T, s *smtpLoopback) *smtppool.Pool {
	t.Helper()
	p, err := smtppool.New(smtppool.Opt{
		Host:              "127.0.0.1",
		Port:              s.port(),
		MaxConns:          1,
		MaxMessageRetries: 9, // Guarded sends must ignore this legacy setting.
		PoolWaitTimeout:   2 * time.Second,
		SSL:               smtppool.SSLNone,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

func message(body []byte) smtppool.Email {
	return smtppool.Email{
		From:    "Sender <sender@example.invalid>",
		To:      []string{"Recipient <recipient@example.invalid>"},
		Subject: "guarded proof",
		Text:    body,
	}
}

func TestAcceptedBindsExactPayloadAndEnvelope(t *testing.T) {
	s := startSMTP(t, acceptMessage)
	p := newPool(t, s)
	var authorized smtppool.GuardedEnvelope
	result, err := p.SendGuarded(message([]byte("exact body")), func(envelope smtppool.GuardedEnvelope) error {
		authorized = envelope
		return nil
	})
	if err != nil || result.Outcome != smtppool.GuardedAccepted {
		t.Fatalf("expected accepted, got %#v, %v", result, err)
	}
	if authorized.From != "sender@example.invalid" || authorized.To != "recipient@example.invalid" {
		t.Fatalf("callback received wrong envelope: %#v", authorized)
	}
	payload := s.firstPayload()
	// net/smtp's dot writer appends the SMTP-required trailing CRLF. The test
	// message's MIME byte slice does not end with CRLF, so remove that transport
	// framing before comparing the callback digest to the Write input.
	payload = bytes.TrimSuffix(payload, []byte("\r\n"))
	wantHash := fmt.Sprintf("%x", sha256.Sum256(payload))
	if authorized.PayloadSHA256 != wantHash {
		t.Fatalf("callback digest %s does not bind written payload %s", authorized.PayloadSHA256, wantHash)
	}
}

func TestAuthorizationDeniedStartsNoSMTPTransaction(t *testing.T) {
	s := startSMTP(t, acceptMessage)
	p := newPool(t, s)
	denied := errors.New("consent revoked")
	calls := 0
	result, err := p.SendGuarded(message([]byte("never sent")), func(smtppool.GuardedEnvelope) error {
		calls++
		return denied
	})
	if !errors.Is(err, denied) || result.Outcome != smtppool.GuardedNotStarted || calls != 1 {
		t.Fatalf("unexpected denied result: %#v, %v, calls=%d", result, err, calls)
	}
	if s.mails.Load() != 0 || s.data.Load() != 0 {
		t.Fatalf("authorization denial issued SMTP transaction: MAIL=%d DATA=%d", s.mails.Load(), s.data.Load())
	}

	// A denial returns the unused connection cleanly. A later independent send
	// can use it, but the denied operation itself is never retried.
	result, err = p.SendGuarded(message([]byte("later")), func(smtppool.GuardedEnvelope) error { return nil })
	if err != nil || result.Outcome != smtppool.GuardedAccepted || s.mails.Load() != 1 {
		t.Fatalf("clean connection was not reusable: %#v, %v, MAIL=%d", result, err, s.mails.Load())
	}
}

func TestConsentIsRecheckedAfterWaitingForConnection(t *testing.T) {
	s := startSMTP(t, acceptMessage)
	p := newPool(t, s)
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		_, _ = p.SendGuarded(message([]byte("first")), func(smtppool.GuardedEnvelope) error {
			close(firstEntered)
			<-releaseFirst
			return errors.New("first denied")
		})
	}()
	<-firstEntered

	secondDone := make(chan struct{})
	var secondResult smtppool.GuardedSendResult
	var secondErr error
	var consent atomic.Bool
	consent.Store(true)
	go func() {
		defer close(secondDone)
		secondResult, secondErr = p.SendGuarded(message([]byte("second")), func(smtppool.GuardedEnvelope) error {
			if !consent.Load() {
				return errors.New("consent revoked while waiting")
			}
			return nil
		})
	}()
	time.Sleep(50 * time.Millisecond)
	consent.Store(false)
	close(releaseFirst)
	<-firstDone
	<-secondDone
	if secondErr == nil || secondResult.Outcome != smtppool.GuardedNotStarted {
		t.Fatalf("waiting send was not denied: %#v, %v", secondResult, secondErr)
	}
	if s.mails.Load() != 0 || s.data.Load() != 0 {
		t.Fatalf("waiting denial issued SMTP transaction: MAIL=%d DATA=%d", s.mails.Load(), s.data.Load())
	}
}

func TestFailureAfterMAILIsUnknownAndNeverRetried(t *testing.T) {
	for _, tc := range []struct {
		name string
		mode serverMode
		body []byte
	}{
		{name: "DATA rejected", mode: rejectData, body: []byte("body")},
		{name: "final ACK lost", mode: dropFinalACK, body: []byte("body")},
		{name: "connection lost during write", mode: dropDuringWrite, body: []byte(strings.Repeat("x", 16<<20))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := startSMTP(t, tc.mode)
			p := newPool(t, s)
			result, err := p.SendGuarded(message(tc.body), func(smtppool.GuardedEnvelope) error { return nil })
			if err == nil || result.Outcome != smtppool.GuardedOutcomeUnknown {
				t.Fatalf("expected outcome_unknown, got %#v, %v", result, err)
			}
			if s.mails.Load() != 1 {
				t.Fatalf("guarded path retried or skipped MAIL: %d", s.mails.Load())
			}
		})
	}
}

func TestMultipleRecipientsAreRejectedBeforeAuthorization(t *testing.T) {
	s := startSMTP(t, acceptMessage)
	p := newPool(t, s)
	for _, invalid := range []smtppool.Email{
		{From: "sender@example.invalid", To: []string{"a@example.invalid", "b@example.invalid"}, Text: []byte("x")},
		{From: "sender@example.invalid", To: []string{"a@example.invalid"}, Cc: []string{"b@example.invalid"}, Text: []byte("x")},
		{From: "sender@example.invalid", To: []string{"a@example.invalid"}, Bcc: []string{"b@example.invalid"}, Text: []byte("x")},
	} {
		calls := 0
		result, err := p.SendGuarded(invalid, func(smtppool.GuardedEnvelope) error { calls++; return nil })
		if err == nil || result.Outcome != smtppool.GuardedNotStarted || calls != 0 {
			t.Fatalf("invalid recipients passed guard: %#v, %v, calls=%d", result, err, calls)
		}
	}
	if s.mails.Load() != 0 {
		t.Fatalf("invalid recipients issued MAIL: %d", s.mails.Load())
	}
}
