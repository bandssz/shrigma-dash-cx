package manager

// SOURCE DRAFT ONLY. The candidate639 Manager does not contain or call this
// lifecycle. It supplies synchronization primitives for a future reviewed
// integration; it is not an endpoint, authority, runtime receipt or shutdown.
import (
    "context"
    "errors"
    "sync"
)

var errPhysicalDrainAdmissionClosed = errors.New("PHYSICAL_DRAIN_ADMISSION_CLOSED")
var errPhysicalDrainOrder = errors.New("PHYSICAL_DRAIN_ORDER_REFUSED")

type physicalDrainLifecycle struct {
    mu sync.Mutex
    accepting bool
    startupSealed bool
    begun bool
    producersStopped bool
    queuesClosed bool
    cancel chan struct{}
    admitted sync.WaitGroup
    producers sync.WaitGroup
    workers sync.WaitGroup
    producerDone chan struct{}
    workerDone chan struct{}
}

func newPhysicalDrainLifecycle() *physicalDrainLifecycle {
    return &physicalDrainLifecycle{accepting:true, cancel:make(chan struct{})}
}

// Register the scanner, Run loop and every cleanup goroutine BEFORE launching
// them. No new campaign pipeline may be created once admission closes. A
// cleanup that enqueues a notification is a producer, not just a worker.
func (d *physicalDrainLifecycle) registerProducer() (func(), error) {
    d.mu.Lock(); defer d.mu.Unlock()
    if !d.accepting || d.begun { return nil, errPhysicalDrainOrder }
    d.producers.Add(1)
    var once sync.Once
    return func(){once.Do(d.producers.Done)}, nil
}

// Register the fixed worker pool before launching it. Add cannot race Wait.
func (d *physicalDrainLifecycle) registerWorker() (func(), error) {
    d.mu.Lock(); defer d.mu.Unlock()
    if d.startupSealed || d.begun { return nil, errPhysicalDrainOrder }
    d.workers.Add(1)
    var once sync.Once
    return func(){once.Do(d.workers.Done)}, nil
}

func (d *physicalDrainLifecycle) sealStartup() {
    d.mu.Lock(); defer d.mu.Unlock()
    d.startupSealed = true
}

// Wrap the complete PushMessage/PushCampaignMessage enqueue attempt. The
// caller MUST defer release even on timeout/error. Admission and Add are under
// the same mutex as begin(), so queue closure cannot overtake an admitted send.
func (d *physicalDrainLifecycle) admit() (func(), error) {
    d.mu.Lock(); defer d.mu.Unlock()
    if !d.accepting { return nil, errPhysicalDrainAdmissionClosed }
    d.admitted.Add(1)
    var once sync.Once
    return func(){once.Do(d.admitted.Done)}, nil
}

func (d *physicalDrainLifecycle) begin() error {
    d.mu.Lock(); defer d.mu.Unlock()
    if !d.startupSealed || d.begun { return errPhysicalDrainOrder }
    d.accepting = false
    d.begun = true
    close(d.cancel)
    d.producerDone = make(chan struct{})
    d.workerDone = make(chan struct{})
    go func(){d.admitted.Wait();d.producers.Wait();close(d.producerDone)}()
    go func(){d.workers.Wait();close(d.workerDone)}()
    return nil
}

func physicalDrainWait(ctx context.Context, done <-chan struct{}) error {
    // Expiration never becomes a success, even if completion races it.
    if err:=ctx.Err(); err!=nil { return err }
    select {
    case <-ctx.Done(): return ctx.Err()
    case <-done: return ctx.Err()
    }
}

func (d *physicalDrainLifecycle) waitProducers(ctx context.Context) error {
    d.mu.Lock(); begun,done:=d.begun,d.producerDone;d.mu.Unlock()
    if !begun { return errPhysicalDrainOrder }
    if err:=physicalDrainWait(ctx,done);err!=nil{return err}
    d.mu.Lock();d.producersStopped=true;d.mu.Unlock()
    return nil
}

// The real integration closes both queues only after HTTP Shutdown succeeds,
// all producers join, and the in-memory pipe map is empty. This method records
// queue closure AFTER it happened; it does not pretend to perform these checks.
func (d *physicalDrainLifecycle) markQueuesClosed() error {
    d.mu.Lock();defer d.mu.Unlock()
    if !d.producersStopped || d.queuesClosed { return errPhysicalDrainOrder }
    d.queuesClosed=true
    return nil
}

func (d *physicalDrainLifecycle) waitWorkers(ctx context.Context) error {
    d.mu.Lock();closed,done:=d.queuesClosed,d.workerDone;d.mu.Unlock()
    if !closed { return errPhysicalDrainOrder }
    // Worker Done must occur after synchronous SMTP AND finish SQL return.
    // Empty channel lengths are intentionally absent from this condition.
    return physicalDrainWait(ctx,done)
}
