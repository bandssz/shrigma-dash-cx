package email

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/textproto"
	"strings"
	"time"

	"github.com/knadh/listmonk/models"
	"github.com/knadh/smtppool/v2"
)

const guardedSESTagsHeader = "X-Ses-Message-Tags"

// GuardedConfigSHA256 fingerprints the effective immutable SMTP configuration
// without returning or logging its source values. Guarded regular delivery is
// deliberately limited to one server so a receipt cannot be ambiguous about
// which configured transport produced its bytes.
func (e *Emailer) GuardedConfigSHA256() (string, error) {
	if len(e.servers) != 1 || e.servers[0] == nil {
		return "", errors.New("guarded regular e-mail requires exactly one configured SMTP server")
	}
	s := e.servers[0]
	maxRetries := s.MaxMessageRetries
	if maxRetries == 0 {
		maxRetries = 1
	}
	wait := s.PoolWaitTimeout
	if wait.Seconds() < 1 {
		wait = 2 * time.Second
	}
	material := struct {
		Schema            string
		Name              string
		Username          string
		Password          string
		AuthProtocol      string
		TLSType           string
		TLSSkipVerify     bool
		EmailHeaders      map[string]string
		Host              string
		Port              int
		HelloHostname     string
		MaxConns          int
		MaxMessageRetries int
		IdleTimeoutNS     int64
		PoolWaitTimeoutNS int64
		SSL               smtppool.SSLType
	}{
		Schema: "listmonk-regular-email-runtime-v1", Name: s.Name,
		Username: s.Username, Password: s.Password, AuthProtocol: s.AuthProtocol,
		TLSType: s.TLSType, TLSSkipVerify: s.TLSSkipVerify, EmailHeaders: s.EmailHeaders,
		Host: s.Host, Port: s.Port, HelloHostname: s.HelloHostname, MaxConns: s.MaxConns,
		MaxMessageRetries: maxRetries, IdleTimeoutNS: int64(s.IdleTimeout),
		PoolWaitTimeoutNS: int64(wait), SSL: s.SSL,
	}
	body, err := json.Marshal(material)
	if err != nil {
		return "", errors.New("guarded SMTP configuration fingerprint failed")
	}
	return fmt.Sprintf("%x", sha256.Sum256(body)), nil
}

// PushRegularGuarded builds one complete single-recipient e-mail and delegates
// one guarded SMTP attempt to smtppool. It never falls back to Push.
func (e *Emailer) PushRegularGuarded(m models.Message, authorize smtppool.GuardedAuthorize) (smtppool.GuardedSendResult, error) {
	notStarted := smtppool.GuardedSendResult{Outcome: smtppool.GuardedNotStarted}
	if authorize == nil {
		return notStarted, errors.New("guarded SMTP authorization callback is required")
	}
	if len(m.To) != 1 {
		return notStarted, errors.New("guarded regular e-mail requires exactly one To recipient")
	}
	if len(e.servers) == 0 {
		return notStarted, errors.New("guarded regular e-mail has no SMTP server")
	}
	if len(e.servers) != 1 {
		return notStarted, errors.New("guarded regular e-mail requires exactly one SMTP server")
	}

	var files []smtppool.Attachment
	if m.Attachments != nil {
		files = make([]smtppool.Attachment, 0, len(m.Attachments))
		for _, f := range m.Attachments {
			a := smtppool.Attachment{
				Filename: f.Name,
				Header:   f.Header,
				Content:  make([]byte, len(f.Content)),
			}
			copy(a.Content, f.Content)
			files = append(files, a)
		}
	}

	srv := e.servers[0]
	em := smtppool.Email{
		From:        m.From,
		To:          append([]string(nil), m.To...),
		Subject:     m.Subject,
		Attachments: files,
		Headers:     textproto.MIMEHeader{},
	}
	for k, v := range srv.EmailHeaders {
		em.Headers.Set(k, v)
	}
	for k, v := range m.Headers {
		if len(v) == 0 {
			return notStarted, errors.New("guarded regular e-mail contains an empty header value list")
		}
		if textproto.CanonicalMIMEHeaderKey(k) == guardedSESTagsHeader {
			serverTags := em.Headers.Get(guardedSESTagsHeader)
			if hasGuardedReservedTag(serverTags) {
				return notStarted, errors.New("guarded SMTP server config contains reserved SES tags")
			}
			if serverTags != "" {
				em.Headers.Set(k, serverTags+", "+v[0])
			} else {
				em.Headers.Set(k, v[0])
			}
			continue
		}
		em.Headers.Set(k, v[0])
	}
	if _, ok := em.Headers[textproto.CanonicalMIMEHeaderKey(hdrBcc)]; ok {
		return notStarted, errors.New("guarded regular e-mail forbids Bcc")
	}
	if _, ok := em.Headers[textproto.CanonicalMIMEHeaderKey(hdrCc)]; ok {
		return notStarted, errors.New("guarded regular e-mail forbids Cc")
	}
	if sender := em.Headers.Get(hdrReturnPath); sender != "" {
		em.Sender = sender
		em.Headers.Del(hdrReturnPath)
	}

	switch m.ContentType {
	case "plain":
		em.Text = []byte(m.Body)
	default:
		em.HTML = m.Body
		if len(m.AltBody) > 0 {
			em.Text = m.AltBody
		}
	}

	return srv.pool.SendGuarded(em, authorize)
}

func hasGuardedReservedTag(tags string) bool {
	for _, part := range strings.Split(tags, ",") {
		key := strings.TrimSpace(strings.SplitN(part, "=", 2)[0])
		if strings.EqualFold(key, "crm_dispatch_id") || strings.EqualFold(key, "crm_test") {
			return true
		}
	}
	return false
}
