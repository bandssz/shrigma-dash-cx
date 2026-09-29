package email

import (
	"net/textproto"
	"strings"
	"testing"

	"github.com/knadh/listmonk/models"
	"github.com/knadh/smtppool/v2"
)

func TestGuardedConfigFingerprintUsesEffectiveSMTPConfiguration(t *testing.T) {
	server := &Server{Name: "primary", Username: "user", Password: "secret", AuthProtocol: "plain", TLSType: "none"}
	server.Host, server.Port, server.MaxConns = "smtp.example.invalid", 2525, 1
	e := &Emailer{name: "email", servers: []*Server{server}}
	first, err := e.GuardedConfigSHA256()
	if err != nil || len(first) != 64 {
		t.Fatalf("fingerprint unavailable: %q %v", first, err)
	}
	server.Password = "rotated"
	second, err := e.GuardedConfigSHA256()
	if err != nil || first == second || strings.Contains(first+second, "secret") {
		t.Fatalf("fingerprint did not bind effective secret config: %q %q %v", first, second, err)
	}
	e.servers = append(e.servers, server)
	if _, err := e.GuardedConfigSHA256(); err == nil {
		t.Fatal("multiple guarded SMTP servers produced an ambiguous fingerprint")
	}
}

func TestPushRegularGuardedRejectsUnsafeRecipientsBeforeAuthorization(t *testing.T) {
	for _, message := range []models.Message{
		{To: []string{"a@example.invalid", "b@example.invalid"}},
		{To: []string{"a@example.invalid"}, Headers: textproto.MIMEHeader{"Cc": {"b@example.invalid"}}},
		{To: []string{"a@example.invalid"}, Headers: textproto.MIMEHeader{"Bcc": {"b@example.invalid"}}},
	} {
		calls := 0
		result, err := (&Emailer{}).PushRegularGuarded(message, func(smtppool.GuardedEnvelope) error {
			calls++
			return nil
		})
		if err == nil || result.Outcome != smtppool.GuardedNotStarted || calls != 0 {
			t.Fatalf("unsafe recipients passed guard: %#v, %v, calls=%d", result, err, calls)
		}
	}
}
