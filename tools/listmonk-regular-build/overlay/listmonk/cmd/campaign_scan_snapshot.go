package main

import (
	"errors"
	"sync"
	"time"
)

type campaignScanPhase string

const (
	campaignScanBegin  campaignScanPhase = "BeginTxx"
	campaignScanSelect campaignScanPhase = "SelectContext"
)

// campaignScanSnapshot describes the last captured scan failure, not current
// health or a campaign result. It deliberately has no error or campaign field.
type campaignScanSnapshot struct {
	Phase     campaignScanPhase `json:"phase"`
	SQLState  string            `json:"sqlstate"`
	Timestamp string            `json:"timestamp"`
}

type campaignScanSnapshotStore struct {
	mu   sync.RWMutex
	last *campaignScanSnapshot
}

var campaignScanLastFailure campaignScanSnapshotStore

// campaignScanAllowedState is a finite output vocabulary. Unlisted driver
// codes and non-driver failures become unknown, without retaining the cause.
// This vocabulary does not change campaignScanDiagnostic's approved behavior.
func campaignScanAllowedState(cause error) string {
	var driver interface{ SQLState() string }
	if !errors.As(cause, &driver) {
		return "unknown"
	}
	switch code := driver.SQLState(); code {
	case "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
		"0A000", "25006", "25P02", "40001", "40P01", "42501", "42601",
		"42703", "42804", "42883", "42P01", "53100", "53200", "53300",
		"55P03", "57014", "57P01", "57P02", "57P03", "58000", "58030",
		"XX000", "XX001", "XX002":
		return code
	default:
		return "unknown"
	}
}

func (s *campaignScanSnapshotStore) record(phase campaignScanPhase, cause error) {
	s.recordAt(phase, cause, time.Now())
}

func (s *campaignScanSnapshotStore) recordAt(phase campaignScanPhase, cause error, at time.Time) {
	if cause == nil || at.IsZero() || (phase != campaignScanBegin && phase != campaignScanSelect) {
		return
	}
	next := campaignScanSnapshot{
		Phase: phase, SQLState: campaignScanAllowedState(cause),
		Timestamp: at.UTC().Format(time.RFC3339Nano),
	}
	s.mu.Lock()
	s.last = &next
	s.mu.Unlock()
}

func (s *campaignScanSnapshotStore) read() *campaignScanSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.last == nil {
		return nil
	}
	out := *s.last
	return &out
}
