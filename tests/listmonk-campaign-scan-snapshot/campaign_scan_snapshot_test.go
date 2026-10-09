package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/knadh/listmonk/internal/auth"
	"github.com/labstack/echo/v4"
	"gopkg.in/volatiletech/null.v6"
)

type snapshotDriverFailure struct{ code string }

func (e *snapshotDriverFailure) Error() string { panic("free error message must never be read") }
func (e *snapshotDriverFailure) SQLState() string { return e.code }

type snapshotWrappedFailure struct{ cause error }

func (e snapshotWrappedFailure) Error() string { panic("wrapper message must never be read") }
func (e snapshotWrappedFailure) Unwrap() error { return e.cause }

func TestCampaignScanSnapshotEmptyAndNoReadMutation(t *testing.T) {
	var s campaignScanSnapshotStore
	for i := 0; i < 3; i++ {
		if s.read() != nil {
			t.Fatal("an unobserved process must return no diagnostic")
		}
	}
}

func TestCampaignScanSnapshotWrappedDriverAndClosedJSON(t *testing.T) {
	var s campaignScanSnapshotStore
	at := time.Date(2026, 10, 8, 11, 0, 0, 123456789, time.FixedZone("test", -3*60*60))
	s.recordAt(campaignScanSelect, snapshotWrappedFailure{&snapshotDriverFailure{"42501"}}, at)
	got := s.read()
	if got == nil || got.Phase != campaignScanSelect || got.SQLState != "42501" ||
		got.Timestamp != "2026-10-08T14:00:00.123456789Z" {
		t.Fatalf("unexpected bounded snapshot: %#v", got)
	}
	body, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(body, &fields); err != nil || len(fields) != 3 ||
		fields["phase"] != "SelectContext" || fields["sqlstate"] != "42501" {
		t.Fatalf("unexpected public fields: %s", body)
	}
	got.SQLState = "MUTATED"
	if s.read().SQLState != "42501" {
		t.Fatal("READ must return a copy")
	}
}

func TestCampaignScanSnapshotFiniteStateVocabulary(t *testing.T) {
	for _, tc := range []struct{ code, want string }{
		{"57014", "57014"}, {"08006", "08006"}, {"42P01", "42P01"},
		{"ZZZZZ", "unknown"}, {"42501;SELECT", "unknown"},
		{"4250", "unknown"}, {"42p01", "unknown"}, {"", "unknown"},
	} {
		if got := campaignScanAllowedState(&snapshotDriverFailure{tc.code}); got != tc.want {
			t.Fatalf("state %q: got %q, want %q", tc.code, got, tc.want)
		}
	}
	if got := campaignScanAllowedState(snapshotWrappedFailure{}); got != "unknown" {
		t.Fatalf("non-driver failure: %q", got)
	}
}

func TestCampaignScanSnapshotRejectInvalidRecords(t *testing.T) {
	var s campaignScanSnapshotStore
	at := time.Date(2026, 10, 8, 14, 0, 0, 0, time.UTC)
	cause := &snapshotDriverFailure{"57014"}
	s.recordAt(campaignScanBegin, cause, at)
	for _, tc := range []struct{ phase campaignScanPhase; cause error; at time.Time }{
		{"select query with customer data", cause, at},
		{campaignScanSelect, nil, at},
		{campaignScanSelect, cause, time.Time{}},
	} {
		s.recordAt(tc.phase, tc.cause, tc.at)
	}
	if got := s.read(); got.Phase != campaignScanBegin || got.Timestamp != at.Format(time.RFC3339Nano) {
		t.Fatal("invalid record changed the previous snapshot")
	}
}

func TestCampaignScanSnapshotConcurrentCopies(t *testing.T) {
	var s campaignScanSnapshotStore
	var wg sync.WaitGroup
	at := time.Date(2026, 10, 8, 14, 0, 0, 0, time.UTC)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				phase := campaignScanBegin
				if n%2 != 0 { phase = campaignScanSelect }
				s.recordAt(phase, &snapshotDriverFailure{"57014"}, at.Add(time.Duration(j)*time.Nanosecond))
				got := s.read()
				if got == nil || got.SQLState != "57014" ||
					(got.Phase != campaignScanBegin && got.Phase != campaignScanSelect) {
					t.Error("torn snapshot")
					return
				}
				got.Timestamp = "caller mutation"
			}
		}(i)
	}
	wg.Wait()
	if s.read().Timestamp == "caller mutation" {
		t.Fatal("caller modified the retained snapshot")
	}
}

func snapshotTestAPIUser() auth.User {
	return auth.User{
		Username: "synthetic-reader", Password: null.String{String: "synthetic-token", Valid: true},
		Type: auth.UserTypeAPI, Status: auth.UserStatusEnabled,
		PermissionsMap: map[string]struct{}{"settings:get": {}},
	}
}

func snapshotTestServer(user auth.User) *echo.Echo {
	// Deliberately do not call auth.New: it creates a session store and prune
	// goroutine. Original token middleware uses only this in-memory API cache.
	authentication := &auth.Auth{}
	authentication.CacheAPIUsers([]auth.User{user})
	e := echo.New()
	registerCampaignScanDiagnostic(e, authentication)
	return e
}

func TestCampaignScanSnapshotOriginalTokenAuthAndPermission(t *testing.T) {
	allowed := snapshotTestAPIUser()
	admin := snapshotTestAPIUser()
	admin.PermissionsMap = nil
	admin.UserRole.ID = auth.SuperAdminRoleID
	unpermitted := snapshotTestAPIUser()
	unpermitted.PermissionsMap = map[string]struct{}{"campaigns:get": {}}
	disabled := snapshotTestAPIUser()
	disabled.Status = auth.UserStatusDisabled
	sessionUser := snapshotTestAPIUser()
	sessionUser.Type = auth.UserTypeUser
	for _, tc := range []struct {
		name string; user auth.User; header, cookie string; want int
	}{
		{"allowed", allowed, "token synthetic-reader:synthetic-token", "", http.StatusOK},
		{"super-admin", admin, "token synthetic-reader:synthetic-token", "", http.StatusOK},
		{"campaign-only", unpermitted, "token synthetic-reader:synthetic-token", "", http.StatusForbidden},
		{"disabled", disabled, "token synthetic-reader:synthetic-token", "", http.StatusForbidden},
		{"user-session-type", sessionUser, "token synthetic-reader:synthetic-token", "", http.StatusForbidden},
		{"wrong-token", allowed, "token synthetic-reader:wrong", "", http.StatusForbidden},
		{"no-header", allowed, "", "", http.StatusForbidden},
		{"basic", allowed, "Basic c3ludGhldGljOnRlc3Q=", "", http.StatusForbidden},
		{"session-cookie", allowed, "token synthetic-reader:synthetic-token", "session=synthetic", http.StatusForbidden},
		{"any-cookie", allowed, "token synthetic-reader:synthetic-token", "other=synthetic", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := snapshotTestServer(tc.user)
			req := httptest.NewRequest(http.MethodGet, campaignScanDiagnosticPath, nil)
			if tc.header != "" { req.Header.Set("Authorization", tc.header) }
			if tc.cookie != "" { req.Header.Set("Cookie", tc.cookie) }
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d", rec.Code, tc.want)
			}
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("diagnostic response must not be cached")
			}
			if strings.Contains(rec.Body.String(), "synthetic-token") {
				t.Fatal("credential leaked")
			}
		})
	}
}

func TestCampaignScanSnapshotRepeatedNativeReadDoesNotCapture(t *testing.T) {
	campaignScanLastFailure = campaignScanSnapshotStore{}
	e := snapshotTestServer(snapshotTestAPIUser())
	read := func(method string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, campaignScanDiagnosticPath, nil)
		req.Header.Set("Authorization", "token synthetic-reader:synthetic-token")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}
	if got := read(http.MethodGet); got.Code != http.StatusOK || strings.TrimSpace(got.Body.String()) != "{\"data\":null}" {
		t.Fatalf("initial read: %d %s", got.Code, got.Body.String())
	}
	campaignScanLastFailure.recordAt(campaignScanBegin, &snapshotDriverFailure{"08006"},
		time.Date(2026, 10, 8, 14, 0, 0, 0, time.UTC))
	first, second := read(http.MethodGet), read(http.MethodGet)
	if first.Code != http.StatusOK || second.Code != http.StatusOK || first.Body.String() != second.Body.String() {
		t.Fatal("READ changed the captured diagnostic")
	}
	if got := read(http.MethodPost); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("non-READ verb accepted: %d", got.Code)
	}
}
