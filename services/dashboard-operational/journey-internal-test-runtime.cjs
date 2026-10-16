'use strict';
// Candidate only. Test jobs use the login database; they never enroll a public.
// Transport must be a dedicated, admitted tx:send binding, not diagnostic READ.
const {createHash}=require('node:crypto'),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function createRunner({db,engine,authorize,authorizeRead=authorize,getDraft,currentIdentity,getBinding,send,now=Date.now,timeoutMs=15000}={}){
 if(!db?.exec||!db.prepare||[authorize,authorizeRead,getDraft,currentIdentity,getBinding,send,now].some(v=>typeof v!=='function')||!engine?.validateDraft||!Number.isInteger(timeoutMs)||timeoutMs<5||timeoutMs>30000)fail('TEST_CONFIG_INVALID',503);
 db.exec("CREATE TABLE IF NOT EXISTS journey_internal_test_v1(request_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL,draft_json TEXT NOT NULL,identity_hash TEXT NOT NULL,binding_hash TEXT NOT NULL,started_at INTEGER NOT NULL,status TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,purchase INTEGER NOT NULL DEFAULT 0,opt_out INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS journey_internal_attempt_v1(attempt_key TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES journey_internal_test_v1(request_id),step_id TEXT NOT NULL,state TEXT NOT NULL,code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
 // Compatibility release only: there is deliberately no adoption writer yet.
 // Its successor may append future revisions, and this version must remain a
 // safe return image which cannot execute the immutable base plan by accident.
 db.exec("CREATE TABLE IF NOT EXISTS journey_internal_revision_v2(request_id TEXT NOT NULL REFERENCES journey_internal_test_v1(request_id),revision INTEGER NOT NULL,expected_revision INTEGER NOT NULL,frozen_cursor INTEGER NOT NULL,baseline_sha256 TEXT NOT NULL,draft_json TEXT NOT NULL,adopted_at INTEGER NOT NULL,PRIMARY KEY(request_id,revision))");
 db.exec("CREATE TABLE IF NOT EXISTS journey_internal_contract_v2(request_id TEXT NOT NULL REFERENCES journey_internal_test_v1(request_id),contract TEXT NOT NULL,minimum_runner INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(request_id,contract))");
 const time=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('TEST_CLOCK_INVALID',503);return t;};
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}};
 function identity(id,brand){const u=currentIdentity(id);if(!u||u.active!==true||!u.brands?.includes(brand)||u.permissions?.growth?.read!==true||u.permissions?.growth?.edit!==true||!u.productFronts?.includes('growth')||u.role!=='superadmin'&&!u.productWriteFronts?.includes('growth')||typeof u.email!=='string'||! /^[^@\s]+@(shrigma\.com\.br|oaristocrata\.com|fishermans\.com\.br)$/i.test(u.email))fail('TEST_INTERNAL_IDENTITY_REQUIRED');return {user:u,hash:hash([u.id,u.email.toLowerCase(),u.role,u.productFronts,u.productWriteFronts||[],u.brands,u.permissions.growth])};}
 function binding(brand){const b=getBinding(brand);if(!b||b.purpose!=='crm.journey-internal-test'||b.active!==true||b.txSend!==true||b.brand!==brand||typeof b.revision!=='string'||!b.revision||!Number.isSafeInteger(b.templateId)||b.templateId<1)fail('TEST_TX_BINDING_REQUIRED',503);return {value:b,hash:hash([b.purpose,b.brand,b.revision,b.templateId])};}
 const find=id=>db.prepare('SELECT * FROM journey_internal_test_v1 WHERE request_id=?').get(id);
 const adopted=id=>!!db.prepare('SELECT 1 FROM journey_internal_revision_v2 WHERE request_id=? LIMIT 1').get(id);
 const requiresNewRunner=id=>adopted(id)||!!db.prepare('SELECT 1 FROM journey_internal_contract_v2 WHERE request_id=? LIMIT 1').get(id);
 function effectiveDraft(r){
  let draft=JSON.parse(r.draft_json);engine.validateDraft(draft);if(draft.brand!==r.brand)fail('TEST_REVISION_CHAIN_INVALID',503);
  const baseline=hash(draft),plans=db.prepare('SELECT * FROM journey_internal_revision_v2 WHERE request_id=? ORDER BY revision LIMIT 101').all(r.request_id);if(plans.length>100)fail('TEST_REVISION_CHAIN_INVALID',503);let cursor=0;
  for(const plan of plans){const next=JSON.parse(plan.draft_json);engine.validateDraft(next);
   if(plan.baseline_sha256!==baseline||plan.expected_revision!==draft.revision||plan.revision!==next.revision||next.revision<=draft.revision||!Number.isSafeInteger(plan.frozen_cursor)||plan.frozen_cursor<cursor||plan.frozen_cursor>draft.steps.length||next.steps.length<plan.frozen_cursor||!Number.isSafeInteger(plan.adopted_at)||plan.adopted_at<r.started_at)fail('TEST_REVISION_CHAIN_INVALID',503);
   for(const key of ['schema','id','brand','mode','productionEnabled','source','trigger','audience','audienceRef','exitOnPurchase','exitOnOptOut'])if(hash(next[key]??null)!==hash(draft[key]??null))fail('TEST_REVISION_CHAIN_INVALID',503);
   if(hash(next.steps.slice(0,plan.frozen_cursor))!==hash(draft.steps.slice(0,plan.frozen_cursor)))fail('TEST_REVISION_CHAIN_INVALID',503);
   draft=next;cursor=plan.frozen_cursor;
  }
  if(!Number.isSafeInteger(r.cursor)||r.cursor<cursor||r.cursor>draft.steps.length)fail('TEST_REVISION_CHAIN_INVALID',503);
  return draft;
 }
 function testMarker(requestId,stepId){return 'QA '+requestId.slice(0,8)+'/'+hash(stepId).slice(0,6);}
 function summary(r){
  if(!r)fail('TEST_NOT_FOUND',404);const draft=effectiveDraft(r),attempts=db.prepare('SELECT step_id,state,code,created_at,updated_at FROM journey_internal_attempt_v1 WHERE request_id=? ORDER BY created_at,step_id').all(r.request_id);
  const steps=draft.steps.map(step=>{const a=attempts.find(a=>a.step_id===step.id);return {step_id:step.id,template_name:step.templateName,channel:step.channel,enabled:step.enabled,due_at:new Date(r.started_at+step.waitMinutes*60000).toISOString(),test_marker:testMarker(r.request_id,step.id),state:a?.state||(!step.enabled?'disabled':r.status==='excluded'?'excluded':['failed','uncertain'].includes(r.status)?'blocked':r.paused?'paused':'waiting'),code:a?.code||null,created_at:a?.created_at??null,updated_at:a?.updated_at??null};});
  return {requestId:r.request_id,brand:r.brand,draftId:draft.id,version:draft.revision,mode:'internal',recipient:'current-corporate-account',status:r.status,paused:!!r.paused,steps,accepted:attempts.filter(a=>a.state==='accepted').length,uncertain:attempts.filter(a=>['reserved','uncertain'].includes(a.state)).length,delivered:null,productionAudienceSelected:false,...(requiresNewRunner(r.request_id)?{compatibilityHold:true}:{})};
 }
 function owner(context,brand,id,write=false){const u=(write?authorize:authorizeRead)(context,brand),r=find(id);if(!r||r.user_id!==u.id||r.brand!==brand)fail('TEST_NOT_FOUND',404);if(write)identity(u.id,brand);return r;}
 function start(context,{brand,draftId,version,requestId}){
  const u=authorize(context,brand);if(!UUID.test(requestId||''))fail('TEST_REQUEST_INVALID',400);
  const who=identity(u.id,brand),b=binding(brand),d=getDraft(context,brand,draftId);engine.validateDraft(d);if(d.id!==draftId||d.brand!==brand||d.revision!==version)fail('TEST_DRAFT_CHANGED',409);
  return transaction(()=>{const old=find(requestId);if(old){const prior=JSON.parse(old.draft_json);if(old.user_id!==u.id||old.brand!==brand||prior.id!==draftId||prior.revision!==version)fail('TEST_REQUEST_CHANGED',409);return summary(old);}
   const sameVersion=db.prepare("SELECT 1 FROM journey_internal_test_v1 t WHERE t.user_id=? AND t.brand=? AND json_extract(t.draft_json,'$.id')=? AND (json_extract(t.draft_json,'$.revision')=? OR EXISTS(SELECT 1 FROM journey_internal_revision_v2 p WHERE p.request_id=t.request_id AND p.revision=?))").get(u.id,brand,draftId,version,version);
   if(sameVersion)fail('TEST_VERSION_ALREADY_RUN',409);
   if(db.prepare("SELECT 1 FROM journey_internal_test_v1 t WHERE t.user_id=? AND t.brand=? AND json_extract(t.draft_json,'$.id')=? AND (t.status IN ('waiting','attempting','compatibility_hold','uncertain') OR EXISTS(SELECT 1 FROM journey_internal_attempt_v1 a WHERE a.request_id=t.request_id AND a.state IN ('reserved','uncertain'))) LIMIT 1").get(u.id,brand,draftId))fail('TEST_DRAFT_ALREADY_ACTIVE',409);
   db.prepare('INSERT INTO journey_internal_test_v1(request_id,user_id,brand,draft_json,identity_hash,binding_hash,started_at,status) VALUES(?,?,?,?,?,?,?,?)').run(requestId,u.id,brand,JSON.stringify(d),who.hash,b.hash,time(),'waiting');return summary(find(requestId));});
 }
 const inspect=(context,{brand,requestId})=>summary(owner(context,brand,requestId));
 function availability(context,brand){
  try{const u=authorize(context,brand);identity(u.id,brand);binding(brand);return {available:true,mode:'internal',recipient:'current-corporate-account',productionAudienceSelected:false};}
  catch(e){return {available:false,mode:'internal',error:['TEST_TX_BINDING_REQUIRED','TEST_INTERNAL_IDENTITY_REQUIRED'].includes(e?.code)?e.code:'TEST_WRITE_REQUIRED',productionAudienceSelected:false};}
 }
 function list(context,brand){const u=authorizeRead(context,brand);return db.prepare('SELECT * FROM journey_internal_test_v1 WHERE user_id=? AND brand=? ORDER BY started_at DESC,request_id LIMIT 50').all(u.id,brand).map(summary);}
 function control(context,{brand,requestId,paused,purchase,optOut}){
  owner(context,brand,requestId,true);for(const v of [paused,purchase,optOut])if(v!==undefined&&typeof v!=='boolean')fail('TEST_CONTROL_INVALID',400);
  return transaction(()=>{const r=owner(context,brand,requestId,true);if(['finished','excluded','uncertain','failed'].includes(r.status))return summary(r);
   if(requiresNewRunner(requestId)){effectiveDraft(r);if(paused!==true||purchase!==undefined||optOut!==undefined)fail('TEST_COMPATIBILITY_HOLD',409);}
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
     if(requiresNewRunner(r.request_id)){effectiveDraft(r);const uncertain=r.status==='attempting'||!!db.prepare("SELECT 1 FROM journey_internal_attempt_v1 WHERE request_id=? AND state IN ('reserved','uncertain')").get(r.request_id);db.prepare('UPDATE journey_internal_test_v1 SET status=?,paused=1 WHERE request_id=?').run(uncertain?'uncertain':'compatibility_hold',r.request_id);return null;}
     if(r.status==='attempting'||db.prepare("SELECT 1 FROM journey_internal_attempt_v1 WHERE request_id=? AND state IN ('reserved','uncertain')").get(r.request_id)){db.prepare("UPDATE journey_internal_test_v1 SET status='uncertain' WHERE request_id=?").run(r.request_id);return null;}
     const d=JSON.parse(r.draft_json);engine.validateDraft(d);
     if(r.opt_out||d.exitOnPurchase&&r.purchase){db.prepare("UPDATE journey_internal_test_v1 SET status='excluded',paused=0 WHERE request_id=?").run(r.request_id);return null;}
     if(r.paused)return null;
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
      if(requiresNewRunner(job.request_id))fail('TEST_ATTEMPT_CHANGED');
      const identityNow=identity(job.user_id,job.brand),bindingNow=binding(job.brand);
      if(identityNow.hash!==reservation.identityHash||bindingNow.hash!==reservation.bindingHash)fail('TEST_BINDING_CHANGED');
      const saved=JSON.parse(job.draft_json);
      if(job.paused)fail('TEST_PAUSED_BEFORE_SEND');
      if(job.opt_out||saved.exitOnPurchase&&job.purchase)fail('TEST_EXCLUDED_BEFORE_SEND');
      return true;
     };
     let r;try{r=await Promise.race([send({binding:b.value,recipient:current.user.email,subject:reservation.step.subject.slice(0,220)+' · '+testMarker(reservation.requestId,reservation.step.id),text:reservation.step.text,requestId:reservation.requestId,attemptKey:reservation.attemptKey,diagnosticContext:{userId:current.user.id,requestId:reservation.requestId},signal:controller.signal,preSend}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('TEST_SEND_DEADLINE'));},timeoutMs);})]);}finally{clearTimeout(timer);}
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
