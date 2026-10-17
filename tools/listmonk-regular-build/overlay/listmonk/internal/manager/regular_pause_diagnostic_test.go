package manager

import (
 "bytes"
 "context"
 "log"
 "strings"
 "sync"
 "testing"

 "github.com/knadh/listmonk/models"
)

// Deliberately unusable Error() proves the logger never reads free text.
type regularPausePoisonError struct{ state string }
func (e regularPausePoisonError) Error() string { panic("free error text accessed") }
func (e regularPausePoisonError) SQLState() string { return e.state }

type regularPauseFixtureStore struct { gateCalls,selectCalls,claimCalls,finishCalls,finalizeCalls,statusCalls,countCalls int; pauseErr error }
func (s *regularPauseFixtureStore) NextCampaigns([]int64,[]int64)([]*models.Campaign,error){ panic("unexpected scanner") }
func (s *regularPauseFixtureStore) NextSubscribers(int,int)([]models.Subscriber,error){ s.selectCalls++; panic("unexpected SELECT") }
func (s *regularPauseFixtureStore) GetCampaign(int)(*models.Campaign,error){ panic("unexpected campaign read") }
func (s *regularPauseFixtureStore) GetAttachment(int)(models.Attachment,error){ panic("unexpected attachment") }
func (s *regularPauseFixtureStore) UpdateCampaignStatus(int,string)error{ s.statusCalls++;return s.pauseErr }
func (s *regularPauseFixtureStore) UpdateCampaignCounts(int,int,int,int)error{ s.countCalls++;panic("unexpected counter") }
func (s *regularPauseFixtureStore) CreateLink(string)(string,error){ panic("unexpected link") }
func (s *regularPauseFixtureStore) BlocklistSubscriber(int64)error{ panic("unexpected blocklist") }
func (s *regularPauseFixtureStore) DeleteSubscriber(int64)error{ panic("unexpected delete") }
func (s *regularPauseFixtureStore) HeartbeatRegularWorker(RegularWorkerHeartbeat)(RegularWorkerHeartbeatResult,error){ panic("unexpected heartbeat") }
func (s *regularPauseFixtureStore) RegularDeliveryGate(int)(RegularDeliveryGate,error){ s.gateCalls++;return RegularDeliveryGate{},regularPausePoisonError{"55P03"} }
func (s *regularPauseFixtureStore) ClaimRegularDelivery(RegularDeliveryClaim)(RegularDeliveryClaimResult,error){ s.claimCalls++;panic("unexpected claim") }
func (s *regularPauseFixtureStore) FinishRegularDelivery(int,int,string,string,string)error{ s.finishCalls++;panic("unexpected finish") }
func (s *regularPauseFixtureStore) FinalizeRegularDelivery(int)error{ s.finalizeCalls++;panic("unexpected finalize") }
var _ Store = (*regularPauseFixtureStore)(nil)
var _ RegularDeliveryStore = (*regularPauseFixtureStore)(nil)
func regularPauseFixture()(*Manager,*pipe,*regularPauseFixtureStore,*bytes.Buffer){
 b:=&bytes.Buffer{};s:=&regularPauseFixtureStore{}
 m:=&Manager{cfg:Config{MessageRate:10},store:s,log:log.New(b,"",0),pipes:map[int]*pipe{}}
 c:=&models.Campaign{};c.ID=171
 p:=&pipe{camp:c,m:m,wg:&sync.WaitGroup{}}
 return m,p,s,b
}
func regularPauseNoDelivery(t *testing.T,s *regularPauseFixtureStore){t.Helper();if s.selectCalls+s.claimCalls+s.finishCalls+s.finalizeCalls+s.countCalls!=0{t.Fatal("unexpected delivery operation")}}

// These three execute the unchanged real gate/refusal paths. The BEFORE files
// produce the same stop/no-delivery result but fail the finite-marker assertion.
func TestRegularPauseQueueGate(t *testing.T){
 m,p,s,b:=regularPauseFixture();p.wg.Add(1);done:=make(chan struct{});n:=0
 m.processQueuedCampaignMessage(CampaignMessage{Campaign:p.camp,pipe:p,regularDone:done},&n)
 select{case <-done:default:t.Fatal("completion not closed")};p.wg.Wait()
 if !p.stopped.Load()||!p.withErrors.Load()||s.gateCalls!=1{t.Fatal("gate decision changed")};regularPauseNoDelivery(t,s)
 if !strings.Contains(b.String(),"campaign_id=171 phase=queue_gate code=gate_unavailable error_class=postgres sqlstate=55P03"){t.Fatal("FINITE_PAUSE_MARKER_MISSING")}
}
func TestRegularPauseSubscriberGate(t *testing.T){
 _,p,s,b:=regularPauseFixture();more,err:=p.NextSubscribers()
 if more||err==nil||!p.stopped.Load()||!p.withErrors.Load()||!p.bound.Load()||s.gateCalls!=1{t.Fatal("selection gate decision changed")};regularPauseNoDelivery(t,s)
 if !strings.Contains(b.String(),"phase=subscriber_gate code=gate_unavailable"){t.Fatal("FINITE_PAUSE_MARKER_MISSING")}
}
func TestRegularPausePreflight(t *testing.T){
 m,p,s,b:=regularPauseFixture();p.wg.Add(1);m.processBoundCampaignMessage(CampaignMessage{Campaign:p.camp,pipe:p},"");p.wg.Wait()
 if !p.stopped.Load()||!p.withErrors.Load()||s.gateCalls!=0{t.Fatal("preflight changed")};regularPauseNoDelivery(t,s)
 if !strings.Contains(b.String(),"phase=preflight code=configuration_unavailable"){t.Fatal("FINITE_PAUSE_MARKER_MISSING")}
}
func TestRegularPauseClosedTypedError(t *testing.T){
 line:=regularPauseDiagnosticLine(171,regularPauseSubscriberSelect,regularPauseSelectionUnavailable,regularPausePoisonError{"57014"})
 if line!="protected_pause campaign_id=171 phase=subscriber_select code=selection_unavailable error_class=postgres sqlstate=57014"{t.Fatal("typed diagnostic changed")}
 line=regularPauseDiagnosticLine(-1,"secret\naddress","private",regularPausePoisonError{"private"})
 if line!="protected_pause campaign_id=0 phase=unknown code=unknown error_class=postgres sqlstate=other"{t.Fatal("untrusted value escaped")}
}
func TestRegularPauseContextClass(t *testing.T){
 if !strings.Contains(regularPauseDiagnosticLine(171,regularPausePreflight,regularPauseStoreUnavailable,context.DeadlineExceeded),"error_class=deadline sqlstate=none"){t.Fatal("deadline")}
 if !strings.Contains(regularPauseDiagnosticLine(171,regularPausePreflight,regularPauseStoreUnavailable,context.Canceled),"error_class=canceled sqlstate=none"){t.Fatal("canceled")}
}
func TestRegularPauseCleanupSingleWrite(t *testing.T){
 for _,err:=range []error{nil,regularPausePoisonError{"55P03"}}{
  _,p,s,b:=regularPauseFixture();s.pauseErr=err;p.bound.Store(true);p.withErrors.Store(true);p.cleanup()
  if s.statusCalls!=1{t.Fatal("pause write count changed")};regularPauseNoDelivery(t,s)
  if !strings.Contains(b.String(),"phase=pause_write code="+string(regularPauseWriteCode(err))){t.Fatal("pause ACK marker")}
 }
}
func TestRegularPauseFinalizeCleanupNoRetry(t *testing.T){
 _,p,s,b:=regularPauseFixture();p.bound.Store(true);p.boundFinalizeFailed.Store(true);p.cleanup()
 if s.statusCalls!=0{t.Fatal("finalization retried")};regularPauseNoDelivery(t,s)
 if !strings.Contains(b.String(),"phase=cleanup code=finalization_unavailable"){t.Fatal("finalization marker")}
}
func TestRegularPauseClaimReasonClosed(t *testing.T){
 if regularClaimPauseCode("outcome_unknown")!=regularPauseClaimUnknown||regularClaimPauseCode("in_flight")!=regularPauseClaimInFlight||regularClaimPauseCode("reserved")!=regularPauseClaimReserved||regularClaimPauseCode("customer@example.invalid")!=regularPauseClaimRefused{t.Fatal("claim classification")}
}
