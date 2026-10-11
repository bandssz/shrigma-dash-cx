package manager

// SOURCE DRAFT, no route and no installation. Required registration/cancel
// hooks are specified in WIRING.json. Calling this with an untracked manager
// cannot prove drainage; candidate639 does not call it or own this lifecycle.
import (
    "context"
    "net/http"
)

func (m *Manager) drainPhysicalQueues(ctx context.Context, d *physicalDrainLifecycle, server *http.Server) error {
    if d==nil || server==nil {return errPhysicalDrainOrder}
    if err:=d.begin();err!=nil{return err}
    // This must be the real server from initHTTPServer, not a health bool.
    if err:=server.Shutdown(ctx);err!=nil{return err}
    if err:=d.waitProducers(ctx);err!=nil{return err}
    m.pipesMut.RLock();active:=len(m.pipes);m.pipesMut.RUnlock()
    // The scoped handoff does not stop an active campaign to satisfy the gate.
    if active!=0 {return errPhysicalDrainOrder}
    if err:=ctx.Err();err!=nil{return err}
    queuesClosedHere:=false
    m.closeOnce.Do(func(){
        // Only legal after scanner/Run/cleanup/admitted enqueues all joined.
        close(m.nextPipes);close(m.campMsgQ);close(m.msgQ)
        queuesClosedHere=true
    })
    if !queuesClosedHere {return errPhysicalDrainOrder}
    if err:=d.markQueuesClosed();err!=nil{return err}
    if err:=d.waitWorkers(ctx);err!=nil{return err}
    // Keep the real heartbeat available through guarded SMTP and finish SQL.
    m.stopRegularHeartbeat()
    // No DB/pool closure or process exit on a failed/expired drain.
    return ctx.Err()
}
