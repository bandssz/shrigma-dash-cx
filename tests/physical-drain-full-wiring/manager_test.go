package manager

import (
 "context"
 "io"
 "log"
 "net"
 "net/http"
 "sync"
 "testing"
 "time"
 "github.com/knadh/listmonk/models"
)

type physicalMessenger struct{entered,release chan struct{};once sync.Once}
func(p *physicalMessenger)Name()string{return "physical"}
func(p *physicalMessenger)Push(models.Message)error{p.once.Do(func(){close(p.entered)});<-p.release;return nil}
func(p *physicalMessenger)Flush()error{return nil}
func(p *physicalMessenger)Close()error{return nil}
func physicalServer(t *testing.T)*http.Server{
 t.Helper();l,e:=net.Listen("tcp","127.0.0.1:0");if e!=nil{t.Fatal("HTTP_LISTEN_REFUSED")}
 s:=&http.Server{Handler:http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.WriteHeader(204)})}
 go s.Serve(l);t.Cleanup(func(){s.Close()});return s
}
func TestPhysicalFullWiringIdleRunJoins(t *testing.T){
 m:=New(Config{Concurrency:2,ScanCampaigns:false},nil,nil,log.New(io.Discard,"",0))
 runDone:=make(chan struct{});go func(){defer close(runDone);m.Run()}()
 ctx,cancel:=context.WithTimeout(context.Background(),time.Second);defer cancel()
 if e:=m.DrainPhysical(ctx,physicalServer(t));e!=nil{t.Fatal("IDLE_DRAIN_REFUSED")}
 select{case <-runDone:case <-time.After(time.Second):t.Fatal("RUN_NOT_JOINED")}
 if m.PushMessage(models.Message{})!=errPhysicalAdmission{t.Fatal("ADMISSION_REOPENED")}
}
func TestPhysicalFullWiringBothQueuesMustJoin(t *testing.T){
 // A closed campaign channel may not abandon a queued non-campaign message.
 m:=New(Config{Concurrency:1,MessageRate:1,ScanCampaigns:false},nil,nil,log.New(io.Discard,"",0))
 p:=&physicalMessenger{entered:make(chan struct{}),release:make(chan struct{})};m.AddMessenger(p)
 m.msgQ<-models.Message{Messenger:"physical"};close(m.campMsgQ);close(m.msgQ)
 done:=make(chan struct{});go func(){defer close(done);m.worker()}()
 select{case <-p.entered:case <-time.After(time.Second):t.Fatal("SECOND_QUEUE_ABANDONED")}
 select{case <-done:t.Fatal("WORKER_ENDED_BEFORE_PUSH");default:}
 close(p.release);select{case <-done:case <-time.After(time.Second):t.Fatal("WORKER_NOT_JOINED")}
}
func TestPhysicalFullWiringExpiredDrainNeverExit(t *testing.T){
 m:=New(Config{Concurrency:1,ScanCampaigns:false},nil,nil,log.New(io.Discard,"",0))
 p:=&physicalMessenger{entered:make(chan struct{}),release:make(chan struct{})};m.AddMessenger(p)
 go m.Run();<-m.physical.startup
 if m.PushMessage(models.Message{Messenger:"physical"})!=nil{t.Fatal("SYNTHETIC_ENQUEUE_REFUSED")};<-p.entered
 server:=physicalServer(t)
 ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond)
 e:=m.DrainPhysical(ctx,server);cancel()
 if e!=context.DeadlineExceeded{t.Fatal("TIMEOUT_BECAME_DRAIN")}
 close(p.release)
 retry,cancel2:=context.WithTimeout(context.Background(),time.Second);defer cancel2()
 if m.DrainPhysical(retry,server)!=nil{t.Fatal("EXISTING_DRAIN_NOT_JOINED")}
}
