package main

import (
 "encoding/json"
 "fmt"
 stdliblog "log"
)

// Called only after scanner Commit returned nil. Unknown data is never echoed.
// Existing quarantine decisions/SQL and scanner transaction are unchanged.
func regularQuarantineDiagnosticLines(body []byte) []string {
 refused := []string{"protected_pause campaign_id=0 phase=scanner_quarantine code=diagnostic_shape_unavailable error_class=none sqlstate=none"}
 if len(body) > 1048576 || len(body) < 2 { return refused }
 var rows []struct { CampaignID int `json:"campaign_id"`; Reason string `json:"reason"` }
 if err := json.Unmarshal(body,&rows); err != nil || rows == nil || len(rows) > 1024 { return refused }
 out := make([]string,0,len(rows))
 for _, row := range rows {
  if row.CampaignID < 1 { return refused }
  switch row.Reason {
  case "control_unavailable","material_unavailable","source_unavailable":
  default: return refused
  }
  out = append(out,fmt.Sprintf("protected_pause campaign_id=%d phase=scanner_quarantine code=%s error_class=none sqlstate=none",row.CampaignID,row.Reason))
 }
 return out
}
func logCommittedRegularQuarantine(body []byte) {
 for _, line := range regularQuarantineDiagnosticLines(body) { stdliblog.Print(line) }
}
