package smtppool

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/smtp"
	"net/textproto"
	"syscall"
	"time"
)

// GuardedOutcome describes whether a guarded SMTP attempt began and whether
// the server positively acknowledged the complete DATA transaction.
type GuardedOutcome string

const (
	GuardedNotStarted     GuardedOutcome = "not_started"
	GuardedAccepted       GuardedOutcome = "accepted"
	GuardedOutcomeUnknown GuardedOutcome = "outcome_unknown"
)

// GuardedSendResult is intentionally small. Callers must use Outcome, rather
// than error text, to decide whether reconciliation is required.
// GuardedPhase and GuardedErrorClass are closed diagnostic labels. They do not
// authorize delivery or refine/reclassify GuardedOutcome.
type GuardedPhase string

type GuardedReplyCode int

type GuardedErrorClass string

const (
	GuardedPhaseUnknown GuardedPhase = "unknown"
	GuardedPhasePreflight GuardedPhase = "preflight"
	GuardedPhaseBuild GuardedPhase = "message_build"
	GuardedPhasePool GuardedPhase = "pool_acquire"
	GuardedPhaseAuthorize GuardedPhase = "authorize"
	GuardedPhaseDeadline GuardedPhase = "socket_deadline"
	GuardedPhaseMail GuardedPhase = "mail"
	GuardedPhaseRcpt GuardedPhase = "rcpt"
	GuardedPhaseData GuardedPhase = "data_open"
	GuardedPhaseWrite GuardedPhase = "data_write"
	GuardedPhaseAck GuardedPhase = "data_final_reply"
	GuardedPhaseComplete GuardedPhase = "complete"

	GuardedErrorNone GuardedErrorClass = "none"
	GuardedErrorSMTPTransient GuardedErrorClass = "smtp_transient"
	GuardedErrorSMTPPermanent GuardedErrorClass = "smtp_permanent"
	GuardedErrorSMTPUnexpected GuardedErrorClass = "smtp_unexpected_reply"
	GuardedErrorTimeout GuardedErrorClass = "timeout"
	GuardedErrorCanceled GuardedErrorClass = "canceled"
	GuardedErrorEOF GuardedErrorClass = "eof"
	GuardedErrorReset GuardedErrorClass = "connection_reset"
	GuardedErrorBrokenPipe GuardedErrorClass = "broken_pipe"
	GuardedErrorOther GuardedErrorClass = "other"
)

type GuardedSendResult struct {
	Outcome GuardedOutcome
	Phase GuardedPhase
	ReplyCode GuardedReplyCode
	ErrorClass GuardedErrorClass
}

// DiagnoseGuardedError reads only typed codes and predicates. Never call
// Error(), format an error, or copy textproto.Error.Msg into a diagnostic.
func DiagnoseGuardedError(err error) (GuardedReplyCode, GuardedErrorClass) {
	if err == nil { return 0, GuardedErrorNone }
	var reply *textproto.Error
	if errors.As(err, &reply) && reply != nil && reply.Code >= 100 && reply.Code <= 599 {
		code := GuardedReplyCode(reply.Code)
		switch reply.Code / 100 {
		case 4: return code, GuardedErrorSMTPTransient
		case 5: return code, GuardedErrorSMTPPermanent
		default: return code, GuardedErrorSMTPUnexpected
		}
	}
	if errors.Is(err, context.Canceled) { return 0, GuardedErrorCanceled }
	var network net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &network) && network.Timeout()) { return 0, GuardedErrorTimeout }
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) { return 0, GuardedErrorEOF }
	if errors.Is(err, syscall.ECONNRESET) { return 0, GuardedErrorReset }
	if errors.Is(err, syscall.EPIPE) { return 0, GuardedErrorBrokenPipe }
	return 0, GuardedErrorOther
}

func guardedDiagnostic(outcome GuardedOutcome, phase GuardedPhase, err error) GuardedSendResult {
	code, class := DiagnoseGuardedError(err)
	return GuardedSendResult{Outcome: outcome, Phase: phase, ReplyCode: code, ErrorClass: class}
}

// GuardedEnvelope is the immutable, non-secret identity of the exact SMTP
// transaction about to start. PayloadSHA256 is lowercase hexadecimal SHA-256
// of the same byte slice passed to the DATA writer.
type GuardedEnvelope struct {
	From          string
	To            string
	PayloadSHA256 string
}

type GuardedAuthorize func(GuardedEnvelope) error

// SendGuarded performs exactly one SMTP attempt. authorize runs after a pool
// connection has been acquired and the complete envelope/message has been
// constructed, immediately before the first MAIL command.
//
// An authorize error means no SMTP transaction was started. Once MAIL is
// invoked, every failure is conservatively outcome_unknown and the connection
// is discarded. There is no retry and no fallback to Send.
func (p *Pool) SendGuarded(e Email, authorize GuardedAuthorize) (GuardedSendResult, error) {

	if authorize == nil {
		err := errors.New("guarded SMTP authorization callback is required")
		return guardedDiagnostic(GuardedNotStarted, GuardedPhasePreflight, err), err
	}
	if len(e.To) != 1 || len(e.Cc) != 0 || len(e.Bcc) != 0 {
		err := errors.New("guarded SMTP requires exactly one To recipient and no Cc/Bcc")
		return guardedDiagnostic(GuardedNotStarted, GuardedPhasePreflight, err), err
	}

	recipients, err := combineEmails(e.To, e.Cc, e.Bcc)
	if err != nil {
		return guardedDiagnostic(GuardedNotStarted, GuardedPhasePreflight, err), err
	}
	if len(recipients) != 1 {
		err := errors.New("guarded SMTP requires exactly one envelope recipient")
		return guardedDiagnostic(GuardedNotStarted, GuardedPhasePreflight, err), err
	}
	from, err := e.parseSender()
	if err != nil {
		return guardedDiagnostic(GuardedNotStarted, GuardedPhaseBuild, err), err
	}
	message, err := e.Bytes()
	if err != nil {
		return guardedDiagnostic(GuardedNotStarted, GuardedPhaseBuild, err), err
	}

	c, err := p.borrowGuardedConn()
	if err != nil {
		return guardedDiagnostic(GuardedNotStarted, GuardedPhasePool, err), err
	}
	digest := sha256.Sum256(message)
	envelope := GuardedEnvelope{
		From:          from,
		To:            recipients[0],
		PayloadSHA256: fmt.Sprintf("%x", digest),
	}
	if err := authorize(envelope); err != nil {
		p.releaseGuardedUnused(c)
		return guardedDiagnostic(GuardedNotStarted, GuardedPhaseAuthorize, err), err
	}

	// From this point onward, the result is phase-based and conservative. MAIL
	// may have reached the server even when the client observes an error.
	c.lastActivity = time.Now()
	if err := c.netConn.SetDeadline(time.Now().Add(p.opt.PoolWaitTimeout)); err != nil {
		p.discardGuarded(c)
		return guardedDiagnostic(GuardedNotStarted, GuardedPhaseDeadline, err), err
	}
	if err := c.conn.Mail(from); err != nil {
		p.discardGuarded(c)
		return guardedDiagnostic(GuardedOutcomeUnknown, GuardedPhaseMail, err), err
	}
	if err := c.conn.Rcpt(recipients[0]); err != nil {
		p.discardGuarded(c)
		return guardedDiagnostic(GuardedOutcomeUnknown, GuardedPhaseRcpt, err), err
	}
	w, err := c.conn.Data()
	if err != nil {
		p.discardGuarded(c)
		return guardedDiagnostic(GuardedOutcomeUnknown, GuardedPhaseData, err), err
	}
	if _, err := w.Write(message); err != nil {
		// Do not close the DATA writer: Close would emit the terminating dot and
		// could finalize a body that this caller considers incomplete.
		p.discardGuarded(c)
		return guardedDiagnostic(GuardedOutcomeUnknown, GuardedPhaseWrite, err), err
	}
	if err := w.Close(); err != nil {
		p.discardGuarded(c)
		return guardedDiagnostic(GuardedOutcomeUnknown, GuardedPhaseAck, err), err
	}

	// DATA Close returned the server's positive final reply. Pool cleanup can
	// no longer make delivery uncertain.
	p.returnGuardedAccepted(c)
	return guardedDiagnostic(GuardedAccepted, GuardedPhaseComplete, nil), nil
}

// borrowGuardedConn mirrors the pool's capacity rules, but new connections use
// a real socket deadline while reading the greeting and negotiating TLS/auth.
func (p *Pool) borrowGuardedConn() (*conn, error) {
	switch {
	case p.closed.Load():
		return nil, ErrPoolClosed
	case int(p.createdConns.Load()) < p.opt.MaxConns && len(p.conns) == 0:
		p.createdConns.Add(1)
		c, err := p.newGuardedConn()
		if err != nil {
			p.createdConns.Add(-1)
			return nil, err
		}
		return c, nil
	}

	timer := time.NewTimer(p.opt.PoolWaitTimeout)
	defer timer.Stop()
	select {
	case c := <-p.conns:
		return c, nil
	case <-p.stopBorrow:
		return nil, ErrPoolClosed
	case <-timer.C:
		return nil, errors.New("timed out waiting for free conn in guarded pool")
	}
}

func (p *Pool) newGuardedConn() (result *conn, err error) {
	addr := fmt.Sprintf("%s:%d", p.opt.Host, p.opt.Port)
	deadline := time.Now().Add(p.opt.PoolWaitTimeout)
	var network net.Conn

	switch p.opt.SSL {
	case SSLTLS:
		dialer := &net.Dialer{Timeout: p.opt.PoolWaitTimeout, Deadline: deadline}
		network, err = tls.DialWithDialer(dialer, "tcp", addr, p.opt.TLSConfig)
	default:
		network, err = net.DialTimeout("tcp", addr, p.opt.PoolWaitTimeout)
	}
	if err != nil {
		return nil, err
	}
	if err = network.SetDeadline(deadline); err != nil {
		_ = network.Close()
		return nil, err
	}

	client, err := smtp.NewClient(network, p.opt.Host)
	if err != nil {
		_ = network.Close()
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = client.Close()
		}
	}()

	if p.opt.HelloHostname != "" {
		if err = client.Hello(p.opt.HelloHostname); err != nil {
			return nil, err
		}
	}
	if p.opt.SSL == SSLSTARTTLS {
		var ok bool
		if ok, _ = client.Extension("STARTTLS"); !ok {
			return nil, errors.New("SMTP STARTTLS extension not found")
		}
		if err = client.StartTLS(p.opt.TLSConfig); err != nil {
			return nil, err
		}
	}
	if p.opt.Auth != nil {
		var ok bool
		if ok, _ = client.Extension("AUTH"); !ok {
			return nil, errors.New("SMTP AUTH extension not found")
		}
		if err = client.Auth(p.opt.Auth); err != nil {
			return nil, err
		}
	}
	if err = network.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	return &conn{conn: client, netConn: network}, nil
}

// releaseGuardedUnused returns a connection without issuing RSET. The guarded
// path has not sent MAIL yet, so there is no SMTP transaction to reset.
func (p *Pool) releaseGuardedUnused(c *conn) {
	c.lastActivity = time.Now()
	if err := c.netConn.SetDeadline(time.Time{}); err != nil {
		p.discardGuarded(c)
		return
	}
	if p.closed.Load() {
		p.discardGuarded(c)
		return
	}

	timer := time.NewTimer(p.opt.PoolWaitTimeout)
	defer timer.Stop()
	select {
	case p.conns <- c:
	case <-p.stopBorrow:
		p.discardGuarded(c)
	case <-timer.C:
		p.discardGuarded(c)
	}
}

// returnGuardedAccepted bounds RSET with the attempt deadline. Failure only
// discards the connection: DATA was already positively acknowledged.
func (p *Pool) returnGuardedAccepted(c *conn) {
	if err := c.conn.Reset(); err != nil {
		p.discardGuarded(c)
		return
	}
	if err := c.netConn.SetDeadline(time.Time{}); err != nil {
		p.discardGuarded(c)
		return
	}
	if p.closed.Load() {
		p.discardGuarded(c)
		return
	}
	timer := time.NewTimer(p.opt.PoolWaitTimeout)
	defer timer.Stop()
	select {
	case p.conns <- c:
	case <-p.stopBorrow:
		p.discardGuarded(c)
	case <-timer.C:
		p.discardGuarded(c)
	}
}

func (p *Pool) discardGuarded(c *conn) {
	p.createdConns.Add(-1)
	_ = c.conn.Close()
}
