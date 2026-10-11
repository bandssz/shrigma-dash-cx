package email

// New direct-Emailer admission proof, using the actual smtppool. No model of
// Send and no fake pool: withhold the actual SMTP DATA response on loopback.
import (
 "bufio"
 "context"
 "net"
 "strconv"
 "strings"
 "sync"
 "sync/atomic"
 "testing"
 "time"
 "github.com/knadh/listmonk/models"
 "github.com/knadh/smtppool/v2"
)
func TestPhysicalFullWiringDirectSMTPAdmissionJoin(t *testing.T){
 listener,err:=net.Listen("tcp","127.0.0.1:0");if err!=nil{t.Fatal("SMTP_LISTEN_REFUSED")}
 defer listener.Close();entered,release,ended:=make(chan struct{}),make(chan struct{}),make(chan struct{})
 var dataCount atomic.Int32;var once sync.Once;unlock:=func(){once.Do(func(){close(release)})};defer unlock()
 go func(){
  defer close(ended);c,e:=listener.Accept();if e!=nil{return};defer c.Close();c.SetDeadline(time.Now().Add(3*time.Second))
  r:=bufio.NewReader(c);w:=bufio.NewWriter(c);reply:=func(s string){w.WriteString(s+"\r\n");w.Flush()};reply("220 fixture")
  for {line,e:=r.ReadString('\n');if e!=nil{return};cmd:=strings.ToUpper(strings.TrimSpace(line))
   switch {case cmd=="DATA":dataCount.Add(1);reply("354 fixture");for {line,e=r.ReadString('\n');if e!=nil{return};if line==".\r\n"{break}};close(entered);<-release;reply("250 accepted")
   case cmd=="QUIT":reply("221 fixture");return
   default:reply("250 fixture")}
  }
 }()
 _,port,_:=net.SplitHostPort(listener.Addr().String());n,_:=strconv.Atoi(port)
 m,e:=New("email",Server{AuthProtocol:"none",TLSType:"none",Opt:smtppool.Opt{Host:"127.0.0.1",Port:n,MaxConns:1,MaxMessageRetries:1,PoolWaitTimeout:time.Second}})
 if e!=nil{t.Fatal("REAL_POOL_REFUSED")};poolClosed:=false;defer func(){unlock();if !poolClosed{m.Close()}}()
 sendDone:=make(chan error,1);go func(){sendDone<-m.Push(models.Message{From:"sender@fixture.invalid",To:[]string{"recipient@fixture.invalid"},Subject:"synthetic",Body:[]byte("synthetic"),ContentType:"plain"})}()
 select{case <-entered:case <-time.After(time.Second):t.Fatal("REAL_SMTP_NOT_ENTERED")}
 ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond);e=m.DrainPhysical(ctx);cancel()
 if e!=context.DeadlineExceeded{t.Fatal("DIRECT_SMTP_NOT_JOINED")}
 // No second SMTP command/connection can result from this rejected Push.
 if m.Push(models.Message{})!=errPhysicalSMTPAdmission{t.Fatal("DIRECT_SMTP_ADMISSION_REOPENED")}
 unlock();select{case e=<-sendDone:if e!=nil{t.Fatal("REAL_SMTP_REFUSED")};case <-time.After(time.Second):t.Fatal("REAL_SEND_NOT_ENDED")}
 ctx2,cancel2:=context.WithTimeout(context.Background(),time.Second);defer cancel2();if m.DrainPhysical(ctx2)!=nil{t.Fatal("DIRECT_SMTP_DRAIN_REFUSED")}
 if dataCount.Load()!=1{t.Fatal("DIRECT_SMTP_RETRANSMITTED")};m.Close();poolClosed=true;listener.Close();select{case <-ended:case <-time.After(1500*time.Millisecond):t.Fatal("SMTP_FIXTURE_NOT_ENDED")}
}
