package models

import (
	"encoding/json"
	"testing"
)

func TestGraphCacheGuardRequiresExactJSONShape(t *testing.T) {
	valid := []byte(`{"contract":"journey_graph_cache_guard_v1","cache_target":"listmonk-primary","instance_id":"00000000-0000-4000-8000-000000000001","template_id":71,"subscriber_id":7,"native_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshot_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","dispatch_id":"00000000-0000-4000-8000-000000000002","token":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","expires_at":"2026-10-01T12:00:00.000Z"}`)
	var guard GraphCacheGuard
	if err := json.Unmarshal(valid, &guard); err != nil {
		t.Fatal(err)
	}
	if guard.TemplateID != 71 || guard.CacheTarget != "listmonk-primary" {
		t.Fatalf("unexpected decoded guard: %#v", guard)
	}
	for name, body := range map[string][]byte{
		"missing":   []byte(`{"contract":"journey_graph_cache_guard_v1"}`),
		"extra":     append(valid[:len(valid)-1], []byte(`,"unexpected":true}`)...),
		"duplicate": []byte(`{"contract":"journey_graph_cache_guard_v1","contract":"other","cache_target":"listmonk-primary","instance_id":"00000000-0000-4000-8000-000000000001","template_id":71,"subscriber_id":7,"native_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshot_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","dispatch_id":"00000000-0000-4000-8000-000000000002","token":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","expires_at":"2026-10-01T12:00:00.000Z"}`),
	} {
		t.Run(name, func(t *testing.T) {
			var got GraphCacheGuard
			if err := json.Unmarshal(body, &got); err == nil {
				t.Fatal("invalid graph guard JSON was accepted")
			}
		})
	}
}
