package smtppool

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/smtp"
	"net/textproto"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// All SMTP traffic stays inside this test process on loopback. The peer is a
// script, not SES, and no external account or customer address is involved.
type smtpScript struct {
	listener net.Listener
	mode string
	counts atomic.Int32
	mail atomic.Int32
	data atomic.Int32
	complete atomic.Int32
	accepted atomic.Int32
	closed atomic.Bool
	wg sync.WaitGroup
	tlsConfig *tls.Config
	armBody *atomic.Bool
}

func newScript(t *testing.T, mode string) *smtpScript {
	t.Helper()
	key,err:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);if err!=nil {t.Fatal(err)}
	template:=&x509.Certificate{SerialNumber:big.NewInt(1),Subject:pkix.Name{CommonName:"localhost"},DNSNames:[]string{"localhost"},NotBefore:time.Now().Add(-time.Minute),NotAfter:time.Now().Add(time.Hour),KeyUsage:x509.KeyUsageDigitalSignature,ExtKeyUsage:[]x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der,err:=x509.CreateCertificate(rand.Reader,template,template,&key.PublicKey,key);if err!=nil {t.Fatal(err)}
	listener,err:=net.Listen("tcp","127.0.0.1:0");if err!=nil {t.Fatal(err)}
	s:=&smtpScript{listener:listener,mode:mode,tlsConfig:&tls.Config{Certificates:[]tls.Certificate{{Certificate:[][]byte{der},PrivateKey:key}}}}
	s.wg.Add(1)
	go func(){defer s.wg.Done();for {c,err:=listener.Accept();if err!=nil{return};n:=s.counts.Add(1);s.wg.Add(1);go func(){defer s.wg.Done();s.serve(c,n)}()}}()
	t.Cleanup(func(){s.closed.Store(true);listener.Close();s.wg.Wait()})
	return s
}

func(s *smtpScript)serve(raw net.Conn,n int32){
	defer raw.Close();_ = raw.SetDeadline(time.Now().Add(4*time.Second))
	var c net.Conn=raw
	if s.mode=="tls-first-plaintext"&&n==1 {fmt.Fprint(raw,"451 synthetic plaintext failure\r\n");return}
	if strings.HasPrefix(s.mode,"tls-") {tc:=tls.Server(raw,s.tlsConfig);if tc.Handshake()!=nil{return};c=tc}
	if s.mode=="greeting451"&&n==1 {fmt.Fprint(c,"451 synthetic greeting failure\r\n");return}
	fmt.Fprint(c,"220 synthetic.invalid SMTP fixture\r\n")
	r:=bufio.NewReader(c)
	for{
		line,err:=r.ReadString('\n');if err!=nil{return};verb:=strings.ToUpper(strings.Fields(line)[0])
		switch verb {
		case "EHLO","HELO":
			if s.mode=="starttls-missing"&&n>1 {fmt.Fprint(c,"250-synthetic.invalid\r\n250 STARTTLS\r\n")}else{fmt.Fprint(c,"250 synthetic.invalid\r\n")}
		case "STARTTLS":
			fmt.Fprint(c,"220 start TLS\r\n");tc:=tls.Server(c,s.tlsConfig);if tc.Handshake()!=nil{return};c=tc;r=bufio.NewReader(c)
		case "MAIL":
			s.mail.Add(1)
			if s.mode=="tls-record-at-mail"&&n==1 {fmt.Fprint(raw,"451 synthetic plaintext over established TLS\r\n");return}
			if s.mode=="mailEOF"&&n==1{return}
			if s.mode=="mail451-always"||s.mode=="mail451"&&n==1 {fmt.Fprint(c,"451 synthetic MAIL temporary failure\r\n");continue}
			if s.mode=="mail550" {fmt.Fprint(c,"550 synthetic permanent failure\r\n");continue}
			fmt.Fprint(c,"250 sender accepted\r\n")
		case "RCPT":
			if s.mode=="rcpt451"&&n==1 {fmt.Fprint(c,"451 synthetic RCPT failure\r\n");continue}
			fmt.Fprint(c,"250 recipient accepted\r\n")
		case "DATA":
			s.data.Add(1)
			if s.mode=="data451"&&n==1 {fmt.Fprint(c,"451 synthetic DATA command failure\r\n");continue}
			if s.armBody!=nil{s.armBody.Store(true)}
			fmt.Fprint(c,"354 send data\r\n")
			for {body,err:=r.ReadString('\n');if err!=nil{return};if body==".\r\n"{break}}
			s.complete.Add(1)
			if s.mode=="ack451" {fmt.Fprint(c,"451 synthetic final rejection\r\n");continue}
			s.accepted.Add(1)
			if s.mode=="ack-lost"{return}
			fmt.Fprint(c,"250 synthetic-fixture-message-id\r\n")
		case "RSET":
			if s.mode=="resetEOF"{return};fmt.Fprint(c,"250 reset complete\r\n")
		case "QUIT":fmt.Fprint(c,"221 bye\r\n");return
		default:fmt.Fprint(c,"500 unsupported synthetic command\r\n")
		}
	}
}

func poolFor(t *testing.T,s *smtpScript,attempts int,ssl SSLType)*Pool{
	t.Helper();addr:=s.listener.Addr().(*net.TCPAddr)
	p,err:=New(Opt{Host:"127.0.0.1",Port:addr.Port,MaxConns:2,MaxMessageRetries:attempts,PoolWaitTimeout:time.Second,SSL:ssl,TLSConfig:&tls.Config{InsecureSkipVerify:true}})
	if err!=nil{t.Fatal(err)};t.Cleanup(p.Close);return p
}
func message()Email{return Email{From:"sender@synthetic.invalid",To:[]string{"recipient@synthetic.invalid"},Subject:"local synthetic only",Text:[]byte("synthetic body")}}
func waitCounts(t *testing.T,s *smtpScript,connections,complete,accepted int32){
	t.Helper();deadline:=time.Now().Add(time.Second);for time.Now().Before(deadline){if s.counts.Load()==connections&&s.complete.Load()==complete&&s.accepted.Load()==accepted{return};time.Sleep(time.Millisecond)}
	t.Fatalf("counts connections=%d complete=%d accepted=%d, want %d/%d/%d",s.counts.Load(),s.complete.Load(),s.accepted.Load(),connections,complete,accepted)
}

func TestPreDataTemporaryFailuresFreshConnection(t *testing.T){
	for _,mode:=range []string{"greeting451","mail451","rcpt451","data451","mailEOF"}{t.Run(mode,func(t *testing.T){
		s:=newScript(t,mode);p:=poolFor(t,s,2,SSLNone);if err:=p.Send(message());err!=nil{t.Fatalf("pre-DATA recovery: %v",err)};waitCounts(t,s,2,1,1)
		if p.createdConns.Load()!=1{t.Fatal("failed connection was not discarded")}
	})}
}
func TestPreDataTLSFailuresFreshConnection(t *testing.T){
	for _,mode:=range []string{"tls-first-plaintext","tls-record-at-mail","starttls-missing"}{t.Run(mode,func(t *testing.T){
		s:=newScript(t,mode);ssl:=SSLTLS;if mode=="starttls-missing"{ssl=SSLSTARTTLS};p:=poolFor(t,s,2,ssl)
		if err:=p.Send(message());err!=nil{t.Fatalf("TLS pre-DATA recovery: %v",err)};waitCounts(t,s,2,1,1)
	})}
}
func TestPreDataPermanentSMTPNoRetry(t *testing.T){
	s:=newScript(t,"mail550");p:=poolFor(t,s,3,SSLNone);if p.Send(message())==nil{t.Fatal("permanent error hidden")};waitCounts(t,s,1,0,0)
}
func TestPreDataAttemptsAreTotalAndBounded(t *testing.T){
	for _,attempts:=range []int{0,1,3}{t.Run(fmt.Sprint(attempts),func(t *testing.T){s:=newScript(t,"mail451-always");p:=poolFor(t,s,attempts,SSLNone);if p.Send(message())==nil{t.Fatal("failure hidden")};want:=int32(attempts);if want==0{want=1};waitCounts(t,s,want,0,0)})}
}
func TestInvalidEnvelopeNoRetryOrData(t *testing.T){
	s:=newScript(t,"ok");p:=poolFor(t,s,3,SSLNone);m:=message();m.From="broken address";if p.Send(m)==nil{t.Fatal("invalid sender hidden")};waitCounts(t,s,1,0,0);if s.mail.Load()!=0{t.Fatal("invalid envelope reached MAIL")}
}
func TestFinalACKLostOrNegativeNeverRetry(t *testing.T){
	for _,mode:=range []string{"ack-lost","ack451"}{t.Run(mode,func(t *testing.T){s:=newScript(t,mode);p:=poolFor(t,s,3,SSLNone);if p.Send(message())==nil{t.Fatal("unconfirmed ACK treated as success")};accepted:=int32(0);if mode=="ack-lost"{accepted=1};waitCounts(t,s,1,1,accepted)})}
}
func TestAcceptedThenResetFailureNeverRetry(t *testing.T){
	s:=newScript(t,"resetEOF");p:=poolFor(t,s,3,SSLNone);if err:=p.Send(message());err!=nil{t.Fatalf("positive final ACK lost to reset failure: %v",err)};waitCounts(t,s,1,1,1)
}

type failBodyWriteConn struct{net.Conn;armed *atomic.Bool;failed atomic.Bool}
func(c *failBodyWriteConn)Write(b []byte)(int,error){
	if c.armed.Load()&&c.failed.CompareAndSwap(false,true){n:=len(b);if n>128{n=128};written,_:=c.Conn.Write(b[:n]);return written,&net.OpError{Op:"write",Net:"tcp",Err:io.ErrClosedPipe}}
	return c.Conn.Write(b)
}
func TestBodyWriteFailureNeverRetryOrFinalize(t *testing.T){
	s:=newScript(t,"ok");arm:=&atomic.Bool{};s.armBody=arm;p:=poolFor(t,s,3,SSLNone)
	network,err:=net.DialTimeout("tcp",s.listener.Addr().String(),time.Second);if err!=nil{t.Fatal(err)}
	wrapped:=&failBodyWriteConn{Conn:network,armed:arm};client,err:=smtp.NewClient(wrapped,"localhost");if err!=nil{t.Fatal(err)}
	p.createdConns.Store(1);p.conns <- &conn{conn:client,netConn:wrapped}
	m:=message();m.Text=[]byte(strings.Repeat("large synthetic message body\n",20000))
	if p.Send(m)==nil{t.Fatal("body-write uncertainty treated as success")};if !wrapped.failed.Load(){t.Fatal("body-write error injection did not execute")}
	waitCounts(t,s,1,0,0);if p.createdConns.Load()!=0{t.Fatal("failed body socket retained")}
}
func TestSuccessfulConnectionsStillReused(t *testing.T){
	s:=newScript(t,"ok");p:=poolFor(t,s,2,SSLNone);for range 2{if err:=p.Send(message());err!=nil{t.Fatal(err)}};waitCounts(t,s,1,2,2)
}
func TestGuardedPathRemainsSingleAttempt(t *testing.T){
	s:=newScript(t,"mail451-always");p:=poolFor(t,s,3,SSLNone);result,err:=p.SendGuarded(message(),func(GuardedEnvelope)error{return nil})
	if err==nil||result.Outcome!=GuardedOutcomeUnknown{t.Fatal("guarded outcome contract changed")};waitCounts(t,s,1,0,0)
}
func TestGuardedAuthorizationStillBeforeMAIL(t *testing.T){
	s:=newScript(t,"ok");p:=poolFor(t,s,3,SSLNone);result,err:=p.SendGuarded(message(),func(GuardedEnvelope)error{return errors.New("synthetic denied")})
	if err==nil||result.Outcome!=GuardedNotStarted{t.Fatal("guarded authorization contract changed")};waitCounts(t,s,1,0,0);if s.mail.Load()!=0{t.Fatal("unauthorized MAIL")}
}
func TestPreDataClassifierClosed(t *testing.T){
	cases:=[]struct{err error;want bool}{
		{io.EOF,true},{&net.OpError{Op:"read",Net:"tcp",Err:io.ErrClosedPipe},true},
		{tls.RecordHeaderError{Msg:"synthetic bad record"},true},{errSTARTTLSMissing,true},
		{&textproto.Error{Code:451,Msg:"synthetic temporary"},true},
		{&textproto.Error{Code:550,Msg:"synthetic permanent"},false},{&textproto.Error{Code:535,Msg:"synthetic auth"},false},
		{ErrPoolClosed,false},{errors.New("unrecognized error"),false},
	}
	for i,c:=range cases{if got:=canRetryBeforeData(c.err);got!=c.want{t.Fatalf("classifier case %d got %v",i,got)}}
}
func TestClosedPoolDoesNotDial(t *testing.T){
	p,err:=New(Opt{Host:"127.0.0.1",Port:1,MaxConns:1,MaxMessageRetries:3});if err!=nil{t.Fatal(err)};p.Close()
	if !errors.Is(p.Send(message()),ErrPoolClosed)||p.createdConns.Load()!=0{t.Fatal("closed pool retried or dialed")}
}
