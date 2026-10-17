package manager

import (
 "context"
 "errors"
 "sync"
)

var errPhysicalAdmission = errors.New("PHYSICAL_DRAIN_ADMISSION_CLOSED")
var errPhysicalOrder = errors.New("PHYSICAL_DRAIN_ORDER_REFUSED")

// All Add operations precede the corresponding Wait: fixed producers/workers
// register before startup seals; cleanup registration is owned by the scanner,
// and cleanup Wait begins only AFTER scanner and Run have joined.
type physicalLifecycle struct {
 mu sync.Mutex
 accepting, sealed, begun, queuesClosed bool
 cancel, scannerDone, changed chan struct{}
 startup chan struct{}
 admitted, producers, cleanups, workers sync.WaitGroup
 producersDone, workersDone chan struct{}
}
func newPhysicalLifecycle() *physicalLifecycle {
 return &physicalLifecycle{accepting:true,cancel:make(chan struct{}),scannerDone:make(chan struct{}),changed:make(chan struct{},1),startup:make(chan struct{})}
}
func (d *physicalLifecycle) admit() (func(),error) {
 d.mu.Lock();defer d.mu.Unlock()
 if !d.accepting{return nil,errPhysicalAdmission}
 d.admitted.Add(1);return d.admitted.Done,nil
}
func (d *physicalLifecycle) registerProducer() (func(),error) {
 d.mu.Lock();defer d.mu.Unlock()
 if d.sealed||d.begun{return nil,errPhysicalOrder}
 d.producers.Add(1);return d.producers.Done,nil
}
func (d *physicalLifecycle) registerWorker() (func(),error) {
 d.mu.Lock();defer d.mu.Unlock()
 if d.sealed||d.begun{return nil,errPhysicalOrder}
 d.workers.Add(1);return d.workers.Done,nil
}
func (d *physicalLifecycle) registerCleanup() (func(),error) {
 // newPipe is internal and is called synchronously by the tracked scanner.
 // No scanner can add a cleanup after closing scannerDone.
 d.mu.Lock();defer d.mu.Unlock()
 if d.queuesClosed{return nil,errPhysicalOrder}
 select{case <-d.scannerDone:return nil,errPhysicalOrder;default:}
 d.cleanups.Add(1)
 return func(){d.cleanups.Done();d.notify()},nil
}
func (d *physicalLifecycle) notify(){select{case d.changed<-struct{}{}:default:}}
func (d *physicalLifecycle) seal(){d.mu.Lock();d.sealed=true;close(d.startup);d.mu.Unlock()}
func physicalWait(ctx context.Context,c <-chan struct{}) error {
 if err:=ctx.Err();err!=nil{return err}
 select{case <-ctx.Done():return ctx.Err();case <-c:return ctx.Err()}
}
func (d *physicalLifecycle) begin(ctx context.Context) error {
 if err:=physicalWait(ctx,d.startup);err!=nil{return err}
 d.mu.Lock();defer d.mu.Unlock()
 if d.begun{return nil} // Wait again after a refused deadline, never fabricate success.
 d.accepting=false;d.begun=true;close(d.cancel)
 d.producersDone=make(chan struct{});d.workersDone=make(chan struct{})
 go func(){d.admitted.Wait();d.producers.Wait();d.cleanups.Wait();close(d.producersDone)}()
 go func(){d.workers.Wait();close(d.workersDone)}()
 return nil
}

// DrainPhysical is called only by the actual SIGTERM branch with the actual
// HTTP server. It neither pauses campaigns nor changes delivery decisions.
// Existing pipe work, synchronous SMTP and its finish/cleanup SQL must return.
// Timeout refuses process exit; a channel length or DB aggregate is no ACK.
type physicalHTTPServer interface { Shutdown(context.Context) error }

func (m *Manager) DrainPhysical(ctx context.Context,server physicalHTTPServer) error {
 if server==nil||m.physical==nil{return errPhysicalOrder}
 d:=m.physical
 if err:=d.begin(ctx);err!=nil{return err}
 if err:=server.Shutdown(ctx);err!=nil{return err}
 if err:=physicalWait(ctx,d.producersDone);err!=nil{return err}
 if m.HasRunningCampaigns(){return errPhysicalOrder}
 d.mu.Lock()
 if !d.queuesClosed {
  closedHere:=false
  m.closeOnce.Do(func(){close(m.nextPipes);close(m.campMsgQ);close(m.msgQ);closedHere=true})
  if !closedHere {d.mu.Unlock();return errPhysicalOrder}
  d.queuesClosed=true
 }
 d.mu.Unlock()
 if err:=physicalWait(ctx,d.workersDone);err!=nil{return err}
 m.stopRegularHeartbeat() // Heartbeat remains real through guarded finish.
 return ctx.Err()
}
