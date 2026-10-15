'use strict';
// Candidate only. Test jobs use the login database; they never enroll a public.
// Transport must be a dedicated, admitted tx:send binding, not diagnostic READ.
const {createHash}=require('node:crypto'),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function createRunner({db,engine,authorize,getDraft,currentIdentity,getBinding,send,now=Date.now,timeoutMs=15000}={}){
 if(!db?.exec||!db.prepare||[authorize,getDraft,currentIdentity,getBinding,send,now].some(v=>typeof v!=='function')||!engine?.validateDraft||!Number.isInteger(timeoutMs)||timeoutMs<5||timeoutMs>30000)fail('TEST_CONFIG_INVALID',503);
 db.exec("CREATE TABLE IF NOT EXISTS journey_internal_test_v1(request_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL,draft_json TEXT NOT NULL,identity_hash TEXT NOT NULL,binding_hash TEXT NOT NULL,started_at INTEGER NOT NULL,status TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,purchase INTEGER NOT NULL DEFAULT 0,opt_out INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS journey_internal_attempt_v1(attempt_key TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES journey_internal_test_v1(request_id),step_id TEXT NOT NULL,state TEXT NOT NULL,code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
 const time=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('TEST_CLOCK_INVALID',503);return t;};
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}};
 function identity(id,brand){const u=currentIdentity(id);if(!u||u.active!==true||!u.brands?.includes(brand)||u.role!=='superadmin'&&!u.writeFronts?.includes('growth')||typeof u.email!=='string'||! /^[^@\s]+@(shrigma\.com\.br|oaristocrata\.com|fishermans\.com\.br)$/i.test(u.email))fail('TEST_INTERNAL_IDENTITY_REQUIRED');return {user:u,hash:hash([u.id,u.email.toLowerCase(),u.role,u.writeFronts||[],u.brands])};}
 function binding(brand){const b=getBinding(brand);if(!b||b.purpose!=='crm.journey-internal-test'||b.active!==true||b.txSend!==true||b.brand!==brand||typeof b.revision!=='string'||!b.revision||!Number.isSafeInteger(b.templateId)||b.templateId<1)fail('TEST_TX_BINDING_REQUIRED',503);return {value:b,hash:hash([b.purpose,b.brand,b.revision,b.templateId])};}
 const find=id=>db.prepare('SELECT * FROM journey_internal_test_v1 WHERE request_id=?').get(id);
 function summary(r){if(!r)fail('TEST_NOT_FOUND',404);const attempts=db.prepare('SELECT step_id,state,code,created_at,updated_at FROM journey_internal_attempt_v1 WHERE request_id=? ORDER BY created_at,step_id').all(r.request_id);return {requestId:r.request_id,brand:r.brand,draftId:JSON.parse(r.draft_json).id,version:JSON.parse(r.draft_json).revision,mode:'internal',recipient:'current-corporate-account',status:r.status,paused:!!r.paused,steps:attempts,accepted:attempts.filter(a=>a.state==='accepted').length,uncertain:attempts.filter(a=>['reserved','uncertain'].includes(a.state)).length,delivered:null,productionAudienceSelected:false};}
 function owner(context,brand,id){const u=authorize(context,brand),r=find(id);if(!r||r.user_id!==u.id||r.brand!==brand)fail('TEST_NOT_FOUND',404);identity(u.id,brand);return r;}
 function start(context,{brand,draftId,version,requestId}){
  const u=authorize(context,brand);if(!UUID.test(requestId||''))fail('TEST_REQUEST_INVALID',400);
  const who=identity(u.id,brand),b=binding(brand),d=getDraft(context,brand,draftId);engine.validateDraft(d);if(d.id!==draftId||d.brand!==brand||d.revision!==version)fail('TEST_DRAFT_CHANGED',409);
  return transaction(()=>{const old=find(requestId);if(old){const prior=JSON.parse(old.draft_json);if(old.user_id!==u.id||old.brand!==brand||prior.id!==draftId||prior.revision!==version)fail('TEST_REQUEST_CHANGED',409);return summary(old);}
   const sameVersion=db.prepare("SELECT 1 FROM journey_internal_test_v1 WHERE user_id=? AND brand=? AND json_extract(draft_json,'$.id')=? AND json_extract(draft_json,'$.revision')=?").get(u.id,brand,draftId,version);
   if(sameVersion)fail('TEST_VERSION_ALREADY_RUN',409);
   db.prepare('INSERT INTO journey_internal_test_v1(request_id,user_id,brand,draft_json,identity_hash,binding_hash,started_at,status) VALUES(?,?,?,?,?,?,?,?)').run(requestId,u.id,brand,JSON.stringify(d),who.hash,b.hash,time(),'waiting');return summary(find(requestId));});
 }
 const inspect=(context,{brand,requestId})=>summary(owner(context,brand,requestId));
 function availability(context,brand){
  try{const u=authorize(context,brand);identity(u.id,brand);binding(brand);return {available:true,mode:'internal',recipient:'current-corporate-account',productionAudienceSelected:false};}
  catch(e){return {available:false,mode:'internal',error:['TEST_TX_BINDING_REQUIRED','TEST_INTERNAL_IDENTITY_REQUIRED'].includes(e?.code)?e.code:'TEST_WRITE_REQUIRED',productionAudienceSelected:false};}
 }
 function list(context,brand){const u=authorize(context,brand);return db.prepare('SELECT * FROM journey_internal_test_v1 WHERE user_id=? AND brand=? ORDER BY started_at DESC,request_id LIMIT 50').all(u.id,brand).map(summary);}
 function control(context,{brand,requestId,paused,purchase,optOut}){
  owner(context,brand,requestId);for(const v of [paused,purchase,optOut])if(v!==undefined&&typeof v!=='boolean')fail('TEST_CONTROL_INVALID',400);
  return transaction(()=>{const r=owner(context,brand,requestId);if(['finished','excluded','uncertain','failed'].includes(r.status))return summary(r);
   db.prepare('UPDATE journey_internal_test_v1 SET paused=?,purchase=?,opt_out=? WHERE request_id=?').run(Number(paused??!!r.paused),Number(purchase??!!r.purchase),Number(optOut??!!r.opt_out),requestId);return summary(find(requestId));});
 }
 let working=false;
 async function tick(){
  if(working)return {busy:true};working=true;try{
   // These are internal test jobs only. Examine the whole active queue so
   // paused jobs or long waits cannot permanently hide a due test behind them.
   const rows=db.prepare("SELECT * FROM journey_internal_test_v1 WHERE status IN ('waiting','attempting') ORDER BY started_at,request_id").all();
   for(const old of rows){let reservation;
    try{reservation=transaction(()=>{
     const r=find(old.request_id),who=identity(r.user_id,r.brand),b=binding(r.brand);
     if(who.hash!==r.identity_hash||b.hash!==r.binding_hash)fail('TEST_BINDING_CHANGED',409);
     if(r.status==='attempting'||db.prepare("SELECT 1 FROM journey_internal_attempt_v1 WHERE request_id=? AND state IN ('reserved','uncertain')").get(r.request_id)){db.prepare("UPDATE journey_internal_test_v1 SET status='uncertain' WHERE request_id=?").run(r.request_id);return null;}
     if(r.paused)return null;const d=JSON.parse(r.draft_json);engine.validateDraft(d);
     if(r.opt_out||d.exitOnPurchase&&r.purchase){db.prepare("UPDATE journey_internal_test_v1 SET status='excluded' WHERE request_id=?").run(r.request_id);return null;}
     let cursor=r.cursor;while(cursor<d.steps.length&&!d.steps[cursor].enabled)cursor++;
     if(cursor===d.steps.length){db.prepare("UPDATE journey_internal_test_v1 SET status='finished',cursor=? WHERE request_id=?").run(cursor,r.request_id);return null;}
     const step=d.steps[cursor],t=time();if(t<r.started_at+step.waitMinutes*60000)return null;
     const attemptKey=hash([r.request_id,d.id,d.revision,step.id]),existing=db.prepare('SELECT state FROM journey_internal_attempt_v1 WHERE attempt_key=?').get(attemptKey);
     if(existing&&existing.state!=='not_sent'){db.prepare("UPDATE journey_internal_test_v1 SET status='uncertain' WHERE request_id=?").run(r.request_id);return null;}
     if(existing)db.prepare("UPDATE journey_internal_attempt_v1 SET state='reserved',code=NULL,updated_at=? WHERE attempt_key=? AND state='not_sent'").run(t,attemptKey);
     else db.prepare("INSERT INTO journey_internal_attempt_v1 VALUES(?,?,?,'reserved',NULL,?,?)").run(attemptKey,r.request_id,step.id,t,t);
     db.prepare("UPDATE journey_internal_test_v1 SET status='attempting',cursor=? WHERE request_id=?").run(cursor,r.request_id);
     return {requestId:r.request_id,attemptKey,step,cursor,who,binding:b,identityHash:r.identity_hash,bindingHash:r.binding_hash,brand:r.brand};
    });}catch{db.prepare("UPDATE journey_internal_test_v1 SET status=CASE WHEN status='attempting' THEN 'uncertain' ELSE 'failed' END,paused=1 WHERE request_id=? AND status IN ('waiting','attempting')").run(old.request_id);continue;}
    if(!reservation)continue;
    let result={state:'uncertain',code:'TEST_RESPONSE_UNKNOWN'};
    try{
     const current=identity(old.user_id,reservation.brand),b=binding(reservation.brand);if(current.hash!==reservation.identityHash||b.hash!==reservation.bindingHash)fail('TEST_BINDING_CHANGED');
     // Dedicated transport validates fixed Listmonk destination and template;
     // no arbitrary recipients, audience members or retry policy come from UI.
     let timer;const controller=new AbortController();
     // Synchronous recheck after the template GET, immediately before the one
     // POST. A deadline, pause, opt-out or revocation during GET prevents send.
     const preSend=()=>{
      const job=find(reservation.requestId),attempt=db.prepare('SELECT state FROM journey_internal_attempt_v1 WHERE attempt_key=?').get(reservation.attemptKey);
      if(controller.signal.aborted||!job||job.status!=='attempting'||attempt?.state!=='reserved')fail('TEST_ATTEMPT_CHANGED');
      const identityNow=identity(job.user_id,job.brand),bindingNow=binding(job.brand);
      if(identityNow.hash!==reservation.identityHash||bindingNow.hash!==reservation.bindingHash)fail('TEST_BINDING_CHANGED');
      const saved=JSON.parse(job.draft_json);
      if(job.paused)fail('TEST_PAUSED_BEFORE_SEND');
      if(job.opt_out||saved.exitOnPurchase&&job.purchase)fail('TEST_EXCLUDED_BEFORE_SEND');
      return true;
     };
     let r;try{r=await Promise.race([send({binding:b.value,recipient:current.user.email,subject:reservation.step.subject,text:reservation.step.text,requestId:reservation.requestId,attemptKey:reservation.attemptKey,diagnosticContext:{userId:current.user.id,requestId:reservation.requestId},signal:controller.signal,preSend}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('TEST_SEND_DEADLINE'));},timeoutMs);})]);}finally{clearTimeout(timer);}
     if(r?.state==='accepted')result={state:'accepted',code:null};
     else if(r?.state==='refused')result={state:'refused',code:/^[A-Z0-9_]{3,64}$/.test(r.code||'')?r.code:'TEST_SEND_REFUSED'};
     else if(r?.state==='not_sent')result={state:'not_sent',code:/^TEST_(PAUSED|EXCLUDED|BINDING_CHANGED|ATTEMPT_CHANGED)/.test(r.code||'')?r.code:'TEST_SEND_NOT_STARTED'};
    }catch(e){if(e?.code==='TEST_BINDING_CHANGED')result={state:'refused',code:'TEST_BINDING_CHANGED'};}
    transaction(()=>{const a=db.prepare('SELECT state FROM journey_internal_attempt_v1 WHERE attempt_key=?').get(reservation.attemptKey);if(a?.state!=='reserved')return;
     db.prepare('UPDATE journey_internal_attempt_v1 SET state=?,code=?,updated_at=? WHERE attempt_key=?').run(result.state,result.code,time(),reservation.attemptKey);
     const job=find(reservation.requestId),saved=JSON.parse(job.draft_json),excluded=!!job.opt_out||saved.exitOnPurchase&&!!job.purchase;
     const status=result.state==='accepted'?excluded?'excluded':'waiting':result.state==='not_sent'?excluded?'excluded':'waiting':result.state==='refused'?'failed':'uncertain';
     // Preserve controls written while the POST was in flight. API acceptance
     // records this step once; it never removes a concurrent pause/opt-out.
     db.prepare('UPDATE journey_internal_test_v1 SET status=?,cursor=?,paused=? WHERE request_id=?').run(status,reservation.cursor+Number(result.state==='accepted'),result.state==='refused'?1:job.paused,reservation.requestId);
    });
   }return {processed:rows.length};
  }finally{working=false;}
 }
 return Object.freeze({start,inspect,control,tick,availability,list});
}
module.exports={createRunner};
