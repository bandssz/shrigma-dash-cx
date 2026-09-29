package main

import (
	"testing"
	"time"
)

func TestRegularDeliveryGrantDeadlineSubtractsAllLocalElapsedTime(t *testing.T) {
	start := time.Now()
	checked := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	deadline, ok := regularDeliveryGrantDeadline(start, checked, checked.Add(4*time.Second))
	if !ok || !deadline.Equal(start.Add(4*time.Second)) {
		t.Fatalf("unexpected conservative deadline: %v %v", deadline, ok)
	}
	if _, ok := regularDeliveryGrantDeadline(start, checked, checked); ok {
		t.Fatal("zero database TTL must be rejected")
	}
}
