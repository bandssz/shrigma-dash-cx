package main

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

type scanDiagnosticDriverFailure struct {
	state string
	raw   string
}

func (e scanDiagnosticDriverFailure) Error() string    { return e.raw }
func (e scanDiagnosticDriverFailure) SQLState() string { return e.state }

func TestCampaignScanDiagnosticKeepsPhaseAndSQLState(t *testing.T) {
	for _, tc := range []struct {
		name, phase, state string
		cause              error
	}{
		{"begin", "begin", "08001", scanDiagnosticDriverFailure{"08001", "raw driver details"}},
		{"select", "select", "42601", scanDiagnosticDriverFailure{"42601", "raw statement and identifiers"}},
		{"wrapped", "select", "57014", fmt.Errorf("raw wrapper: %w", scanDiagnosticDriverFailure{"57014", "raw parameters"})},
		{"no-state", "select", "unknown", errors.New("raw connection data")},
		{"nil-cause", "begin", "unknown", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := campaignScanDiagnostic(tc.phase, tc.cause).Error()
			want := "campaign scan unavailable [phase=" + tc.phase + " sqlstate=" + tc.state + "]"
			if got != want {
				t.Fatalf("unexpected diagnostic: %q", got)
			}
		})
	}
}

func TestCampaignScanDiagnosticRejectsInvalidSQLState(t *testing.T) {
	for _, state := range []string{"", "4260", "426010", "42p01", "42\n01", "42 01", "42é01", "private-driver-value"} {
		got := campaignScanDiagnostic("select", scanDiagnosticDriverFailure{state, "raw"}).Error()
		if got != "campaign scan unavailable [phase=select sqlstate=unknown]" {
			t.Fatalf("invalid SQLSTATE was exposed: %q", got)
		}
	}
}

func TestCampaignScanDiagnosticExcludesDriverPayload(t *testing.T) {
	payload := "SELECT customer_column FROM customer_table; connection=synthetic-secret recipient=synthetic-client"
	cause := fmt.Errorf("wrapper %s: %w", payload, scanDiagnosticDriverFailure{"42501", payload})
	got := campaignScanDiagnostic(payload, cause).Error()
	if got != "campaign scan unavailable [phase=unknown sqlstate=42501]" {
		t.Fatalf("unexpected diagnostic: %q", got)
	}
	for _, forbidden := range []string{"SELECT", "customer_", "connection=", "recipient=", "synthetic-", "wrapper"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("driver payload escaped into diagnostic: %q", got)
		}
	}
}

func TestCampaignScanDiagnosticDoesNotExposeInvalidWrappedState(t *testing.T) {
	cause := fmt.Errorf("raw outer: %w", scanDiagnosticDriverFailure{"42601\nSELECT", "raw inner"})
	if got := campaignScanDiagnostic("begin", cause).Error(); got != "campaign scan unavailable [phase=begin sqlstate=unknown]" {
		t.Fatalf("invalid wrapped state was exposed: %q", got)
	}
}
