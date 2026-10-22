package main

import (
 "strings"
 "testing"
)
func TestRegularPauseQuarantineClosed(t *testing.T){
 lines:=regularQuarantineDiagnosticLines([]byte(`[{"campaign_id":171,"reason":"control_unavailable"},{"campaign_id":174,"reason":"source_unavailable"}]`))
 if len(lines)!=2||!strings.Contains(lines[0],"campaign_id=171 phase=scanner_quarantine code=control_unavailable")||!strings.Contains(lines[1],"code=source_unavailable"){t.Fatal("committed quarantine shape")}
 if len(regularQuarantineDiagnosticLines([]byte(`[]`)))!=0{t.Fatal("empty quarantine changed")}
}
func TestRegularPauseQuarantineRefusesUntrusted(t *testing.T){
 for _,body:=range []string{`null`,`{}`,`[{"campaign_id":1,"reason":"secret@example.invalid"}]`,`[{"campaign_id":-1,"reason":"control_unavailable"}]`,`[{"campaign_id":"1","reason":"control_unavailable"}]`,`not-json`,strings.Repeat("x",1048577)}{
  lines:=regularQuarantineDiagnosticLines([]byte(body))
  if len(lines)!=1||lines[0]!="protected_pause campaign_id=0 phase=scanner_quarantine code=diagnostic_shape_unavailable error_class=none sqlstate=none"{t.Fatal("private data escaped")}
 }
}
