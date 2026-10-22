package email

import (
 "context"
 "errors"
)

var errPhysicalSMTPAdmission = errors.New("PHYSICAL_SMTP_ADMISSION_CLOSED")

// Covers direct notifications/import callbacks, not only Manager.msgQ. New
// callbacks can continue to exist but cannot acquire SMTP after this barrier.
// This does NOT claim the importer itself, or arbitrary background DB work,
// has been cancelled/joined. The real SMTP Push body and SendGuarded are intact.
func (e *Emailer) physicalAdmit() (func(),error) {
 e.physicalMu.Lock();defer e.physicalMu.Unlock()
 if e.physicalClosed{return nil,errPhysicalSMTPAdmission}
 e.physicalPending.Add(1)
 return e.physicalPending.Done,nil
}
func (e *Emailer) DrainPhysical(ctx context.Context) error {
 if err:=ctx.Err();err!=nil{return err}
 e.physicalMu.Lock()
 if !e.physicalClosed {
  e.physicalClosed=true;e.physicalDone=make(chan struct{})
  go func(){e.physicalPending.Wait();close(e.physicalDone)}()
 }
 done:=e.physicalDone;e.physicalMu.Unlock()
 select{case <-ctx.Done():return ctx.Err();case <-done:return ctx.Err()}
}
