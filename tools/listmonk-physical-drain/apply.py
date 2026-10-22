"""Pinned post-composition SOURCE transform. Inert on import, no CLI/network.
Root must integrate this new build stage and derive NEW artifact identities.
The canonical 7b9 recipe runs first; this stage never changes SQL/regular gates.
"""
import hashlib,json
from pathlib import Path
HERE=Path(__file__).resolve().parent
BEFORE={
 'internal/manager/manager.go':'fc57c5c7c5c1bda612e59506ca641e128bc3aebe3c06d62d441dcfbe47157b5a',
 'internal/manager/pipe.go':'95cea4745a476c77518ecbbcbdfe4a9d865b454b4e095b239d283d26d0347749',
 'cmd/main.go':'e95edd4dc35c5c13ac483c0d6448c0efe0d5cd6035c02f9cc73d74170c400049',
 'internal/messenger/email/email.go':'7538708c2a1774ca0dacd81d4e6e7b21af68b62b16aca9fe019de8205241e265'}
def sha(b):return hashlib.sha256(b).hexdigest()
def once(s,a,b):
 if s.count(a)!=1:raise ValueError('PHYSICAL_SOURCE_ANCHOR_REFUSED')
 return s.replace(a,b,1)
def manager(s):
 s=once(s,'\tcloseOnce                 sync.Once\n','\tcloseOnce                 sync.Once\n\tphysical                  *physicalLifecycle\n')
 s=once(s,'\t\tslidingStart:         time.Now(),','\t\tslidingStart:         time.Now(),\n\t\tphysical:             newPhysicalLifecycle(),')
 for signature in ('func (m *Manager) PushMessage(msg models.Message) error {','func (m *Manager) PushCampaignMessage(msg CampaignMessage) error {'):
  s=once(s,signature,signature+'\n\trelease, admissionErr := m.physical.admit()\n\tif admissionErr != nil { return admissionErr }; defer release()')
 s=once(s,'func (m *Manager) Run() {\n','func (m *Manager) Run() {\n\trunDone, err := m.physical.registerProducer(); if err != nil { return }; defer runDone()\n')
 s=once(s,'\t\tgo m.scanCampaigns(m.cfg.ScanInterval)','\t\tscanDone, err := m.physical.registerProducer(); if err != nil { return }\n\t\tgo func(){defer scanDone();defer close(m.physical.scannerDone);m.scanCampaigns(m.cfg.ScanInterval)}()')
 s=once(s,'\t}\n\n\t// Spawn N message workers.','\t} else { close(m.physical.scannerDone) }\n\n\t// Spawn N message workers.')
 s=once(s,'\t\tgo m.worker()','\t\tworkerDone, err := m.physical.registerWorker(); if err != nil { return }\n\t\tgo func(){defer workerDone();m.worker()}()')
 s=once(s,'\t// Indefinitely wait on the pipe queue','\tm.physical.seal()\n\tcancel, scannerDone := m.physical.cancel, m.physical.scannerDone\n\tdraining, scannerJoined := false, false\n\t// Indefinitely wait on the pipe queue')
 s=once(s,'\tfor p := range m.nextPipes {\n\t\thas, err := p.NextSubscribers()','\tfor {\n\t\tif draining && scannerJoined && !m.HasRunningCampaigns() && len(m.nextPipes)==0 { return }\n\t\tvar p *pipe\n\t\tselect {\n\t\tcase <-cancel: draining=true;cancel=nil;continue\n\t\tcase <-scannerDone: scannerJoined=true;scannerDone=nil;continue\n\t\tcase <-m.physical.changed: continue\n\t\tcase next, ok := <-m.nextPipes: if !ok { return };p=next\n\t\t}\n\t\thas, err := p.NextSubscribers()')
 s=once(s,'\tfor range t.C {\n\t\tids, counts := m.getCurrentCampaigns()','\tfor {\n\t\tselect {case <-m.physical.cancel:return;case <-t.C:}\n\t\t// Do not begin another acquisition after the stop request. An already\n\t\t// acquired batch still follows the unchanged pipe/claim/finish path.\n\t\tselect {case <-m.physical.cancel:return;default:}\n\t\tids, counts := m.getCurrentCampaigns()')
 s=once(s,'\tnumMsg := 0\n\tfor {','\tnumMsg := 0\n\tcampaignQueue, messageQueue := m.campMsgQ, m.msgQ\n\tfor campaignQueue != nil || messageQueue != nil {')
 s=once(s,'case msg, ok := <-m.campMsgQ:\n\t\t\tif !ok {\n\t\t\t\treturn\n\t\t\t}','case msg, ok := <-campaignQueue:\n\t\t\tif !ok { campaignQueue=nil;continue }')
 s=once(s,'case msg, ok := <-m.msgQ:\n\t\t\tif !ok {\n\t\t\t\treturn\n\t\t\t}','case msg, ok := <-messageQueue:\n\t\t\tif !ok { messageQueue=nil;continue }')
 return s

def pipe(s):
 # Register only AFTER all pre-existing validations succeeded and BEFORE the
 # cleanup goroutine starts. The tracked scanner remains live through this Add.
 s=once(s,'\t// Add the campaign to the active map.','\tcleanupDone, drainErr := m.physical.registerCleanup()\n\tif drainErr != nil { return nil, drainErr }\n\t// Add the campaign to the active map.')
 s=once(s,'\tgo func() {\n\t\t// Wait for all the messages','\tgo func() {\n\t\tdefer cleanupDone()\n\t\t// Wait for all the messages')
 return s

def email(s):
 s=once(s,'import (\n','import (\n\t"sync"\n')
 s=once(s,'\tname    string\n}', '\tname    string\n\tphysicalMu sync.Mutex\n\tphysicalClosed bool\n\tphysicalPending sync.WaitGroup\n\tphysicalDone chan struct{}\n}')
 return once(s,'func (e *Emailer) Push(m models.Message) error {','func (e *Emailer) Push(m models.Message) error {\n\trelease, err := e.physicalAdmit(); if err != nil {return err}; defer release()')

def main(s):
 a='\t<-awaitReload(chReload, closerWait, func() {'
 s=once(s,a,'\treloadDone := awaitReload(chReload, closerWait, func() {')
 # Keep the SIGHUP callback byte-identical. SIGTERM MUST NOT enter awaitReload.
 a='\t\tcloserWait <- true\n\t})\n}'
 b='''\t\tcloserWait <- true
\t})
\tterm := make(chan os.Signal, 1)
\tsignal.Notify(term, syscall.SIGTERM)
\tdefer signal.Stop(term)
\tclosingResources := false
\tfor {
\t\tselect {
\t\tcase <-reloadDone: return
\t\tcase <-term:
\t\t\tif closingResources { lo.Print("PHYSICAL_RESOURCE_CLOSE_REFUSED"); continue }
\t\t\tctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
\t\t\terr := mgr.DrainPhysical(ctx, srv)
\t\t\tif err != nil {
\t\t\t\tcancel()
\t\t\t\tlo.Print("PHYSICAL_DRAIN_REFUSED")
\t\t\t\tcontinue // No success/exit/Exec on deadline or incomplete work.
\t\t\t}
\t\t\t// Import notifications bypass Manager.msgQ. Close actual SMTP
\t\t\t// admission only after already-queued Manager workers have joined.
\t\t\tfor _, messenger := range app.messengers {
\t\t\t\tif smtp, ok := messenger.(*email.Emailer); ok {
\t\t\t\t\tif smtpErr := smtp.DrainPhysical(ctx); smtpErr != nil { err=smtpErr; break }
\t\t\t\t}
\t\t\t}
\t\t\tcancel()
\t\t\tif err != nil { lo.Print("PHYSICAL_SMTP_DRAIN_REFUSED"); continue }
\t\t\tclosingResources = true // Never repeat a partial pool/resource close.
\t\t\tapp.graphCache.close()
\t\t\tif err := db.Close(); err != nil { lo.Print("PHYSICAL_DB_CLOSE_REFUSED"); continue }
\t\t\tclosed := true
\t\t\tfor _, messenger := range app.messengers {
\t\t\t\tif err := messenger.Close(); err != nil { closed=false }
\t\t\t}
\t\t\tif !closed { lo.Print("PHYSICAL_POOL_CLOSE_REFUSED"); continue }
\t\t\tlo.Print("PHYSICAL_DRAIN_COMPLETED")
\t\t\treturn
\t\t}
\t}
}'''
 return once(s,a,b)

def transform(source):
 out={}
 for name,fn in [('internal/manager/manager.go',manager),('internal/manager/pipe.go',pipe),('cmd/main.go',main),('internal/messenger/email/email.go',email)]:
  body=source[name]
  if sha(body)!=BEFORE[name]:raise ValueError('PHYSICAL_BEFORE_PIN_REFUSED')
  out[name]=fn(body.decode()).encode()
 return out

def apply(root):
 root=Path(root).resolve(strict=True)
 pins=json.loads((HERE/'ASSETS.json').read_text())['files']
 source={name:(root/name).read_bytes() for name in BEFORE}
 proposed=transform(source)
 for extra in ['internal/manager/physical_drain.go','internal/messenger/email/physical_drain.go']:
  proposed[extra]=(HERE/'overlay'/extra).read_bytes()
 for name,b in proposed.items():
  if sha(b)!=pins[name]['sha256'] or len(b)!=pins[name]['bytes']:raise ValueError('PHYSICAL_AFTER_PIN_REFUSED')
  if name not in BEFORE and (root/name).exists():raise ValueError('PHYSICAL_NEW_NAME_REFUSED')
 for name,b in proposed.items():(root/name).write_bytes(b)
 return {name:sha(b) for name,b in proposed.items()}
