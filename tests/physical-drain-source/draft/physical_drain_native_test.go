package manager

// New focal fixture only: real Manager.worker -> Emailer.Push -> real SMTP
// pool -> loopback ACK-holding server -> Mailpit. No original service or data.
import (
    "bufio"
    "bytes"
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "log"
    "net"
    "net/http"
    "net/smtp"
    "os"
    "os/exec"
    "strings"
    "sync"
    "testing"
    "time"

    "github.com/knadh/listmonk/internal/messenger/email"
    "github.com/knadh/listmonk/models"
    "github.com/knadh/smtppool/v2"
    _ "github.com/lib/pq"
)

func TestPhysicalDrainHTTPShutdownCannotUseTimeoutAsSuccess(t *testing.T) {
    entered,release:=make(chan struct{}),make(chan struct{})
    var releaseOnce sync.Once
    unlock:=func(){releaseOnce.Do(func(){close(release)})};defer unlock()
    listener,err:=net.Listen("tcp","127.0.0.1:0");if err!=nil{t.Fatal("HTTP_LISTEN_REFUSED")}
    server:=&http.Server{Handler:http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){close(entered);<-release;w.WriteHeader(204)})}
    defer server.Close()
    serveDone:=make(chan struct{});go func(){defer close(serveDone);_ = server.Serve(listener)}()
    requestDone:=make(chan struct{});go func(){defer close(requestDone);c:=&http.Client{Timeout:3*time.Second};r,e:=c.Get("http://"+listener.Addr().String()+"/synthetic");if e==nil{r.Body.Close()}}()
    select{case <-entered:case <-time.After(time.Second):t.Fatal("HTTP_HANDLER_NOT_ENTERED")}
    ctx,cancel:=context.WithTimeout(context.Background(),20*time.Millisecond)
    err=server.Shutdown(ctx);cancel()
    if !errors.Is(err,context.DeadlineExceeded){t.Fatal("HTTP_TIMEOUT_INVENTED_DRAIN")}
    unlock()
    ctx2,cancel2:=context.WithTimeout(context.Background(),time.Second);defer cancel2()
    if server.Shutdown(ctx2)!=nil{t.Fatal("HTTP_NOT_JOINED")}
    <-serveDone;<-requestDone
}

func TestPhysicalDrainRealPoolLegacyGapAndProcessExit(t *testing.T) {
    if os.Getenv("PHYSICAL_DRAIN_FIXTURE_ISOLATED")!="1" || os.Getuid()!=1000 {t.Fatal("FIXTURE_ISOLATION_REFUSED")}
    executable,err:=os.Executable();if err!=nil{t.Fatal("FIXTURE_EXECUTABLE_REFUSED")}
    ctx,cancel:=context.WithTimeout(context.Background(),12*time.Second);defer cancel()
    child:=exec.CommandContext(ctx,executable,"-test.run=^TestPhysicalDrainChild$","-test.timeout=10s")
    child.Env=[]string{"PHYSICAL_DRAIN_CHILD=1","PHYSICAL_DRAIN_FIXTURE_ISOLATED=1",
        "PHYSICAL_DRAIN_FIXTURE_URL=postgresql://postgres@127.0.0.1:55432/listmonk",
        "PHYSICAL_DRAIN_MAILPIT_SMTP=127.0.0.1:51025","PHYSICAL_DRAIN_MAILPIT_API=http://127.0.0.1:58025/api/v1/messages",
        "PGOPTIONS=-c TimeZone=Etc/UTC"}
    output,err:=child.CombinedOutput()
    if err!=nil || ctx.Err()!=nil || !child.ProcessState.Exited() || child.ProcessState.ExitCode()!=0 {t.Fatal("FIXTURE_PROCESS_END_REFUSED")}
    if len(output)>65536 || !bytes.Contains(output,[]byte("PHYSICAL_DRAIN_FIXTURE_CLOSED\n")){t.Fatal("FIXTURE_CLOSE_MARKER_REFUSED")}
}

func physicalDrainMailpitTotal(t *testing.T) int {
    t.Helper()
    if os.Getenv("PHYSICAL_DRAIN_MAILPIT_API")!="http://127.0.0.1:58025/api/v1/messages" {t.Fatal("MAILPIT_URL_REFUSED")}
    client:=&http.Client{Timeout:2*time.Second}
    r,err:=client.Get(os.Getenv("PHYSICAL_DRAIN_MAILPIT_API"));if err!=nil{t.Fatal("MAILPIT_READ_REFUSED")}
    defer r.Body.Close()
    body,err:=io.ReadAll(io.LimitReader(r.Body,65537));if err!=nil || len(body)>65536 || r.StatusCode!=200{t.Fatal("MAILPIT_READ_BOUND_REFUSED")}
    var value struct{Total int `json:"total"`};if json.Unmarshal(body,&value)!=nil || value.Total<0{t.Fatal("MAILPIT_SHAPE_REFUSED")}
    return value.Total
}

// The child is launched explicitly by the parent, not counted as an empty
// top-level passing case. Its stdout contains no body, address or identifier.
func TestPhysicalDrainChild(t *testing.T) {
    if os.Getenv("PHYSICAL_DRAIN_CHILD")!="1" {t.Fatal("CHILD_ONLY")}
    if os.Getenv("PHYSICAL_DRAIN_FIXTURE_ISOLATED")!="1" || os.Getuid()!=1000 || os.Getenv("PHYSICAL_DRAIN_FIXTURE_URL")!="postgresql://postgres@127.0.0.1:55432/listmonk" || os.Getenv("PHYSICAL_DRAIN_MAILPIT_SMTP")!="127.0.0.1:51025" {t.Fatal("CHILD_ISOLATION_REFUSED")}
    before:=physicalDrainMailpitTotal(t)

    listener,err:=net.Listen("tcp","127.0.0.1:0");if err!=nil{t.Fatal("SMTP_LISTEN_REFUSED")}
    defer listener.Close()
    ackHeld,release,serverDone:=make(chan struct{}),make(chan struct{}),make(chan struct{})
    var releaseOnce sync.Once
    unlock:=func(){releaseOnce.Do(func(){close(release)})};defer unlock()
    serverErrors:=make(chan error,1)
    go func(){
        defer close(serverDone)
        conn,e:=listener.Accept();if e!=nil{serverErrors<-e;return};defer conn.Close()
        _ = conn.SetDeadline(time.Now().Add(6*time.Second))
        reader:=bufio.NewReader(conn);writer:=bufio.NewWriter(conn)
        reply:=func(line string)error{if _,e:=writer.WriteString(line+"\r\n");e!=nil{return e};return writer.Flush()}
        if e=reply("220 fixture");e!=nil{serverErrors<-e;return}
        for {
            line,e:=reader.ReadString('\n');if e!=nil{serverErrors<-e;return}
            command:=strings.ToUpper(strings.TrimSpace(line))
            switch {
            case strings.HasPrefix(command,"EHLO"),strings.HasPrefix(command,"HELO"),strings.HasPrefix(command,"MAIL FROM:"),strings.HasPrefix(command,"RCPT TO:"):
                e=reply("250 fixture")
            case command=="DATA":
                if e=reply("354 fixture");e!=nil{serverErrors<-e;return}
                var body bytes.Buffer
                for {line,e=reader.ReadString('\n');if e!=nil{serverErrors<-e;return};if line==".\r\n"{break};if body.Len()+len(line)>65536{serverErrors<-errors.New("SYNTHETIC_BODY_BOUND");return};body.WriteString(line)}
                e=smtp.SendMail("127.0.0.1:51025",nil,"sender@fixture.invalid",[]string{"recipient@fixture.invalid"},body.Bytes())
                if e!=nil{serverErrors<-e;return}
                close(ackHeld)
                <-release
                e=reply("250 fixture accepted")
            case command=="QUIT": _ = reply("221 fixture");return
            case command=="RSET",command=="NOOP":e=reply("250 fixture")
            default:e=errors.New("SYNTHETIC_COMMAND_REFUSED")
            }
            if e!=nil{serverErrors<-e;return}
        }
    }()
    port:=listener.Addr().(*net.TCPAddr).Port
    em,err:=email.New("email",email.Server{AuthProtocol:"none",TLSType:"none",Opt:smtppool.Opt{Host:"127.0.0.1",Port:port,MaxConns:1,MaxMessageRetries:1,PoolWaitTimeout:time.Second}})
    if err!=nil{t.Fatal("REAL_EMAILER_REFUSED")}
    emailClosed:=false
    defer func(){if !emailClosed{_ = em.Close()}}()
    m:=&Manager{msgQ:make(chan models.Message,1),campMsgQ:make(chan CampaignMessage,1),nextPipes:make(chan *pipe,1),messengers:map[string]Messenger{"email":em},log:log.New(io.Discard,"",0)}
    d:=newPhysicalDrainLifecycle();workerDone,err:=d.registerWorker();if err!=nil{t.Fatal("REGISTER_WORKER_REFUSED")};d.sealStartup()
    stopped:=make(chan struct{});go func(){defer close(stopped);defer workerDone();m.worker()}()
    releaseAdmission,err:=d.admit();if err!=nil{t.Fatal("ADMISSION_REFUSED")}
    err=m.PushMessage(models.Message{From:"sender@fixture.invalid",To:[]string{"recipient@fixture.invalid"},Subject:"synthetic",ContentType:"plain",Body:[]byte("synthetic"),Messenger:"email"});releaseAdmission()
    if err!=nil{t.Fatal("QUEUE_PUSH_REFUSED")}
    select{case <-ackHeld:case <-serverErrors:t.Fatal("REAL_POOL_PROTOCOL_REFUSED");case <-time.After(3*time.Second):t.Fatal("REAL_POOL_NOT_WAITING_ACK")}
    if len(m.msgQ)!=0 || physicalDrainMailpitTotal(t)!=before+1{t.Fatal("FIXTURE_NOT_ACCEPTED_WITH_EMPTY_QUEUE")}
    db,err:=sql.Open("postgres",os.Getenv("PHYSICAL_DRAIN_FIXTURE_URL")+"?sslmode=disable");if err!=nil{t.Fatal("PG_OPEN_REFUSED")}
    db.SetMaxOpenConns(1);db.SetMaxIdleConns(0)
    ctx,cancel:=context.WithTimeout(context.Background(),3*time.Second);defer cancel()
    tx,err:=db.BeginTx(ctx,&sql.TxOptions{ReadOnly:true});if err!=nil{db.Close();t.Fatal("PG_BEGIN_REFUSED")}
    failed:=func(code string){_ = tx.Rollback();_ = db.Close();t.Fatal(code)}
    if _,err=tx.ExecContext(ctx,"SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='500ms'");err!=nil{failed("PG_LIMIT_REFUSED")}
    var version,pending int
    var timeZone string
    if err=tx.QueryRowContext(ctx,"SELECT current_setting('server_version_num')::integer,(SELECT count(*) FROM public.shrigma_email_dispatch WHERE transport_state IN ('reserved','in_flight'))::integer,current_setting('TimeZone')").Scan(&version,&pending,&timeZone);err!=nil{failed("PG_READ_REFUSED")}
    if version!=170010 || pending!=0 || timeZone!="Etc/UTC" {failed("PG_FIXTURE_NOT_EMPTY_17_10")}
    if tx.Rollback()!=nil{db.Close();t.Fatal("PG_ROLLBACK_REFUSED")}
    if db.Close()!=nil{t.Fatal("PG_CLIENT_END_REFUSED")}

    if d.begin()!=nil{t.Fatal("DRAIN_BEGIN_REFUSED")}
    wait,cancelWait:=context.WithTimeout(context.Background(),time.Second)
    if d.waitProducers(wait)!=nil{t.Fatal("PRODUCER_JOIN_REFUSED")};cancelWait()
    // Actual candidate Close returns while the real worker is still in Push.
    m.Close()
    select{case <-stopped:t.Fatal("OLD_CLOSE_UNEXPECTEDLY_JOINED_SMTP");default:}
    close(m.campMsgQ) // Fixture-only completion of the otherwise open queue.
    if d.markQueuesClosed()!=nil{t.Fatal("QUEUES_CLOSED_MARK_REFUSED")}
    short,cancelShort:=context.WithTimeout(context.Background(),20*time.Millisecond)
    err=d.waitWorkers(short);cancelShort()
    if !errors.Is(err,context.DeadlineExceeded){t.Fatal("WAITGROUP_INVENTED_DRAIN")}
    unlock()
    final,cancelFinal:=context.WithTimeout(context.Background(),2*time.Second);defer cancelFinal()
    if d.waitWorkers(final)!=nil{t.Fatal("SMTP_NOT_JOINED_AFTER_ACK")}
    <-stopped
    if em.Close()!=nil{t.Fatal("MESSENGER_CLOSE_REFUSED")}
    emailClosed=true
    select{case <-serverDone:case <-time.After(time.Second):t.Fatal("SMTP_SERVER_NOT_ENDED")}
    if physicalDrainMailpitTotal(t)!=before+1{t.Fatal("RETRANSMISSION_OBSERVED")}
    fmt.Print("PHYSICAL_DRAIN_FIXTURE_CLOSED\n")
}
