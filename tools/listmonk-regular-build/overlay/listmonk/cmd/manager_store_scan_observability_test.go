package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/lib/pq"
)

// If the classifier formats this original error, the test fails immediately.
type scanSecretWrapper struct { inner error }
func (w scanSecretWrapper) Error() string { panic("original error formatted") }
func (w scanSecretWrapper) Unwrap() error { return w.inner }

func TestCampaignScanClosedClasses(t *testing.T) {
	codes := []string{"57014", "55P03", "40P01", "53300", "08006", "42501", "42P01", "42883", "25P02"}
	phases := []struct { value campaignScanPhase; name string }{
		{campaignScanBegin, "begin"}, {campaignScanBoundary, "boundary"},
		{campaignScanQuarantine, "quarantine"}, {campaignScanSelect, "select"}, {campaignScanCommit, "commit"},
	}
	for _, phase := range phases {
		for _, code := range codes {
			for _, wrapped := range []bool{false, true} {
				pg := &pq.Error{Code:pq.ErrorCode(code), Message:"secret-message", Detail:"secret-detail", Hint:"secret-hint", Where:"secret-query", Schema:"secret-schema", Table:"secret-customer", Column:"secret-env", InternalQuery:"secret-sql"}
				var err error = pg
				if wrapped { err = scanSecretWrapper{scanSecretWrapper{pg}} }
				out := campaignScanError(phase.value, err)
				want := "campaign scan unavailable phase=" + phase.name + " class=" + code
				if out.Error() != want { t.Fatal("unexpected closed classification") }
				if errors.Unwrap(out) != nil || strings.Contains(out.Error(), "secret") { t.Fatal("private error retained") }
			}
		}
	}
}

func TestCampaignScanUnknownAndContext(t *testing.T) {
	for _, code := range []string{"", "57014 secret", "570140", "5701", "57p14", "23505", "XXXXX", "\n42501"} {
		out := campaignScanError(campaignScanSelect, scanSecretWrapper{&pq.Error{Code:pq.ErrorCode(code), Message:"secret"}})
		if out.Error() != "campaign scan unavailable phase=select class=OTHER" { t.Fatal("invalid SQLSTATE escaped whitelist") }
	}
	for _, tc := range []struct{ err error; class string }{
		{nil,"OTHER"}, {scanSecretWrapper{nil},"OTHER"}, {(*pq.Error)(nil),"OTHER"},
		{context.Canceled,"CANCELED"}, {scanSecretWrapper{context.Canceled},"CANCELED"},
		{context.DeadlineExceeded,"DEADLINE"}, {scanSecretWrapper{context.DeadlineExceeded},"DEADLINE"},
	} {
		if campaignScanError(campaignScanQuarantine,tc.err).Error() != "campaign scan unavailable phase=quarantine class="+tc.class { t.Fatal("context class mismatch") }
	}
	if campaignScanError(campaignScanPhase(255),nil).Error() != "campaign scan unavailable phase=OTHER class=OTHER" { t.Fatal("phase not closed") }
}

type scanBoundaryFixture struct {
	calls []string
	ctx context.Context
	failAt int
	err error
}
func (f *scanBoundaryFixture) ExecContext(ctx context.Context, q string, args ...any) (sql.Result,error) {
	if ctx != f.ctx || len(args) != 0 { panic("boundary contract changed") }
	f.calls=append(f.calls,q)
	if len(f.calls)==f.failAt { return nil,f.err }
	return nil,nil
}
func TestCampaignScanBoundaryOrderAndFailure(t *testing.T) {
	ctx:=context.Background()
	for _, failAt:=range []int{0,1,2} {
		f:=&scanBoundaryFixture{ctx:ctx,failAt:failAt,err:scanSecretWrapper{&pq.Error{Code:"55P03",Message:"secret"}}}
		err:=setCampaignScanBoundary(ctx,f)
		if failAt==0 && err!=nil { t.Fatal("success boundary changed") }
		if failAt!=0 && (err==nil || err.Error()!="campaign scan unavailable phase=boundary class=55P03") { t.Fatal("boundary classification lost") }
		if len(f.calls)<1 || f.calls[0]!="SET LOCAL statement_timeout='10s'" { t.Fatal("statement boundary changed") }
		if failAt==1 && len(f.calls)!=1 { t.Fatal("execution continued after failure") }
		if failAt!=1 && (len(f.calls)!=2 || f.calls[1]!="SET LOCAL lock_timeout='500ms'") { t.Fatal("lock boundary changed") }
	}
}
