package manager

import (
    "context"
    "errors"
    "testing"
    "time"
)

func TestPhysicalDrainAdmissionClosesBeforeWait(t *testing.T) {
    d:=newPhysicalDrainLifecycle();d.sealStartup()
    release,err:=d.admit();if err!=nil{t.Fatal("ADMISSION_FAILED")}
    if d.begin()!=nil{t.Fatal("BEGIN_FAILED")}
    if _,err=d.admit();!errors.Is(err,errPhysicalDrainAdmissionClosed){t.Fatal("ADMISSION_REOPENED")}
    ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond);defer cancel()
    if !errors.Is(d.waitProducers(ctx),context.DeadlineExceeded){t.Fatal("ADMITTED_ENQUEUE_IGNORED")}
    release();release()
    ctx2,cancel2:=context.WithTimeout(context.Background(),time.Second);defer cancel2()
    if d.waitProducers(ctx2)!=nil{t.Fatal("ADMITTED_ENQUEUE_NOT_JOINED")}
}

func TestPhysicalDrainProducerJoinAndWorkerJoin(t *testing.T) {
    d:=newPhysicalDrainLifecycle()
    producer,err:=d.registerProducer();if err!=nil{t.Fatal("REGISTER_PRODUCER_FAILED")}
    worker,err:=d.registerWorker();if err!=nil{t.Fatal("REGISTER_WORKER_FAILED")}
    d.sealStartup();if d.begin()!=nil{t.Fatal("BEGIN_FAILED")}
    if _,err=d.registerWorker();err==nil{t.Fatal("LATE_WORKER_REGISTERED")}
    if d.markQueuesClosed()==nil{t.Fatal("QUEUE_CLOSED_BEFORE_PRODUCERS")}
    select{case <-d.cancel:default:t.Fatal("SCANNER_CANCEL_MISSING")}
    producer()
    ctx,cancel:=context.WithTimeout(context.Background(),time.Second);defer cancel()
    if d.waitProducers(ctx)!=nil || d.markQueuesClosed()!=nil{t.Fatal("PRODUCER_JOIN_FAILED")}
    short,stop:=context.WithTimeout(context.Background(),20*time.Millisecond);defer stop()
    if !errors.Is(d.waitWorkers(short),context.DeadlineExceeded){t.Fatal("ACTIVE_SEND_IGNORED")}
    worker();worker()
    if d.waitWorkers(ctx)!=nil{t.Fatal("WORKER_NOT_JOINED")}
}

func TestPhysicalDrainContextExpiryDoesNotDeclareDrained(t *testing.T) {
    d:=newPhysicalDrainLifecycle();d.sealStartup();if d.begin()!=nil{t.Fatal("BEGIN_FAILED")}
    ctx,cancel:=context.WithCancel(context.Background());cancel()
    if !errors.Is(d.waitProducers(ctx),context.Canceled){t.Fatal("CANCEL_CONVERTED_TO_SUCCESS")}
    if d.markQueuesClosed()==nil{t.Fatal("QUEUE_CLOSED_AFTER_REFUSAL")}
}
