'use strict';
const audienceFixture=require('./campaign-audience-fixture.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
global.CampaignContract=require('../campaign-contract');
global.CampaignTracking=require('../n8n/growth/campaign-tracking');
const A=require('../growth-campaign-api'),createLocks=require('./campaign-lock-fixture.cjs');
const END='https://campaign.example.test/operations',NOW=Date.parse('2026-09-19T12:00:00Z');
const API={capabilities:{campaigns:{contract_version:A.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:"listmonk-6.1-regular-v1"},endpoints:{campaigns:END}}};
const definition=()=>({schema_version:A.VERSION,brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Nome legível',subject:'Assunto',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[125],template_id:1,html:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',tags:[],send_at:'2026-09-20T15:00:00Z'});
const campaign=()=>({id:100,version:'v1',status:'draft',sent:0,started_at:null,send_at:definition().send_at,definition:definition()});
const catalog={brand:'fish',current:true,lists:[{id:125,name:'Clientes recorrentes',brand:'fish',available:true}],templates:[{id:1,name:'Modelo principal',type:'campaign',available:true,version:'t1'}],initiatives:[]};
function fixture(handler){
 const data=new Map(),calls=[];let currentKey='synthetic-write-secret',counter=0;
 const storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};
 const options={locks:createLocks(),capabilities:A.caps(API),brand:'fish',storage,readKey:()=> 'synthetic-read-secret',writeKey:()=>currentKey,now:()=>NOW,uuid:()=>`fixture-operation-${++counter}`,keyFingerprint:async k=>createHash('sha256').update(k).digest('hex'),fetch:async(url,init)=>{
  const u=new URL(url),request=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(u.searchParams);calls.push({url,init,request});
  const result=request.acao==='campanha_catalogo'?{status:200,body:catalog}:await handler(request,init,data);
  return {status:result.status,json:async()=>result.body};
 }};
 return {options,data,calls,client:A.createClient(options),reload:()=>A.createClient(options),setKey:k=>{currentKey=k;},count:()=>counter};
}
test('only the exact announced campaign contract, HTTPS endpoint and staged flags enable actions',()=>{
 assert.equal(A.caps({}).save,false);assert.equal(A.caps({capabilities:{...API.capabilities,endpoints:{}}}).save,false);
 assert.equal(A.caps({capabilities:{...API.capabilities,campaigns:{...API.capabilities.campaigns,save:'true'}}}).save,false);
 for(const url of ['http://x.test','https://u:p@x.test/path','https://x.test/path?k=secret'])assert.equal(A.caps({capabilities:{...API.capabilities,endpoints:{campaigns:url}}}).endpoint,null);
 assert.deepEqual(A.caps({capabilities:{...API.capabilities,campaigns:{...API.capabilities.campaigns,brands:['fish','olivas']}}}).brands,['fish']);
});
test('a slow confirmed write keeps its original journal until receipt instead of the shorter read timeout',async()=>{
 const original=global.AbortSignal,signals=[];
 global.AbortSignal={timeout:ms=>{const s={deadline:ms,aborted:false};signals.push(s);return s;}};
 try{
  const f=fixture(async(req,init,data)=>{
   const stored=[...data.values()].map(JSON.parse).find(s=>s.operation?.request?.acao==='campanha_salvar');
   assert.equal(stored.operation.phase,'pending');
   if(init.signal.deadline<34000)throw Error('simulated browser timeout before durable receipt');
   return {status:201,body:{campaign:campaign()}};
  });
  await f.client.catalog();await f.client.save(definition());
  assert.equal(f.client.snapshot().operation.phase,'succeeded');assert.equal(f.count(),1);
  assert.ok(signals[0].deadline<34000,'reading retains its existing shorter budget');
  assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);
 }finally{global.AbortSignal=original;}
});
test('save, validate and schedule bind versions, require confirmation and keep the key out of the operation journal',async()=>{
 const a=audienceFixture(campaign(),NOW);const f=fixture(async req=>{const c=campaign();if(req.acao==='campanha_agendar')c.status='scheduled';return {status:req.acao==='campanha_salvar'?201:200,body:{campaign:c,...(req.acao==='campanha_validar'?{validation:{policy:A.VERSION,version:c.version,ok:true,audience:a}}:{}),...(req.acao==='campanha_agendar'?{audience:{...a,rechecked_at:a.checked_at}}:{})}};});
 await f.client.catalog();await f.client.save(definition());assert.equal(f.client.snapshot().campaign.id,100);
 await assert.rejects(()=>f.client.validate({...definition(),subject:'Alterado'}),{code:'UNSAVED_CHANGES'});
 await f.client.validate(definition());await assert.rejects(()=>f.client.schedule(definition(),'outra palavra'),{code:'CONFIRM_REQUIRED'});
 await f.client.schedule(definition(),'agendar',a.review_id);assert.equal(f.client.snapshot().campaign.status,'scheduled');
 const writes=f.calls.filter(c=>c.init.method==='POST');assert.equal(writes.length,3);assert.equal(new Set(writes.map(x=>x.request.idempotency_key)).size,3);
 assert.equal(writes[1].request.expected_version,'v1');assert.equal(writes[2].request.expected_version,'v1');assert.equal(writes[2].request.confirm,'agendar');
 for(const c of writes){assert.equal(c.init.redirect,'error');assert.equal(c.init.credentials,'omit');assert.equal(c.request.k,'synthetic-write-secret');}
 const stored=[...f.data.values()].join('');assert.ok(!stored.includes('synthetic-write-secret'));assert.ok(!stored.includes('synthetic-read-secret'));
});
test('the journal exists before transport; lost response freezes every new write across reload with the same key retained',async()=>{
 const f=fixture(async(req,init,data)=>{assert.ok([...data.values()].some(v=>JSON.parse(v).operation?.phase==='pending'));throw Error('network timeout after create');});
 await f.client.catalog();await assert.rejects(()=>f.client.save(definition()));const op=f.client.snapshot().operation;
 assert.equal(op.phase,'uncertain');assert.equal(f.client.locked(),true);
 const reloaded=f.reload();await reloaded.catalog();await assert.rejects(()=>reloaded.save(definition()),{code:'OPERATION_PENDING'});
 assert.equal(f.count(),1);assert.equal(reloaded.snapshot().operation.key,op.key);assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);
 await assert.rejects(()=>reloaded.newDraft(),{code:'OPERATION_PENDING'});
});
test('operation lookup uses the original write principal and unknown or not-found stays locked',async()=>{
 const f=fixture(async req=>req.acao==='campanha_operacao'?{status:404,body:{error:'OPERATION_NOT_FOUND'}}:{status:502,body:{error:'OUTCOME_UNKNOWN'}});
 await f.client.catalog();await assert.rejects(()=>f.client.save(definition()));f.setKey('different-author');
 await assert.rejects(()=>f.client.consult(),{code:'OPERATION_ACTOR_CHANGED'});assert.equal(f.calls.filter(c=>c.request.acao==='campanha_operacao').length,0);
 f.setKey('synthetic-write-secret');await assert.rejects(()=>f.client.consult());assert.equal(f.client.locked(),true);
 assert.equal(f.calls.at(-1).request.k,undefined);assert.equal(f.calls.at(-1).init.headers.Authorization,'Bearer synthetic-write-secret');assert.equal(f.calls.at(-1).request.idempotency_key,f.client.snapshot().operation.key);
});
test('confirmed rejected post-create step reopens its owned draft instead of permitting a new creation',async()=>{
 let updates=0;const f=fixture(async req=>{
  if(req.acao==='campanha_operacao')return {status:200,body:{operation:{brand:'fish',state:'rejected',providerId:100,response:{status:422,body:{error:'CONTENT_UNVALIDATED',provider_id:100}}}}};
  if(req.acao==='campanha_obter')return {status:200,body:{campaign:campaign()}};
  if(req.id){updates++;assert.equal(req.id,100);assert.equal(req.expected_version,'v1');return {status:200,body:{campaign:campaign()}};}
  return {status:422,body:{error:'CONTENT_UNVALIDATED',provider_id:100}};
 });
 await f.client.catalog();await assert.rejects(()=>f.client.save(definition()));assert.equal(f.client.locked(),true);
 await f.client.consult();assert.equal(f.client.locked(),false);assert.equal(f.client.snapshot().campaign.id,100);
 await f.client.save(definition());assert.equal(updates,1);assert.equal(f.calls.filter(c=>c.init.method==='POST'&&!c.request.id).length,1);
});
test('successful operation polling recovers the confirmed result; malformed success never becomes a new draft',async()=>{
 const f=fixture(async req=>req.acao==='campanha_operacao'?{status:200,body:{operation:{brand:'fish',state:'succeeded',response:{status:201,body:{campaign:campaign()}}}}}:req.acao==='campanha_obter'?{status:200,body:{campaign:campaign()}}:{status:200,body:{accepted:true}});
 await f.client.catalog();await assert.rejects(()=>f.client.save(definition()));assert.equal(f.client.locked(),true);
 await f.reload().consult();assert.equal(f.reload().locked(),false);assert.equal(f.reload().snapshot().campaign.id,100);
});
test('reconciliation keeps the historical receipt but requires the current campaign revision',async()=>{
 let available=false;
 const current={...campaign(),status:'cancelled',version:'v-after-cancellation'};
 const f=fixture(async req=>{
  if(req.acao==='campanha_operacao')return {status:200,body:{operation:{brand:'fish',state:'succeeded',response:{status:201,body:{campaign:campaign()}}}}};
  if(req.acao==='campanha_obter')return available?{status:200,body:{campaign:current}}:{status:503,body:{error:'READ_UNAVAILABLE'}};
  return {status:200,body:null};
 });
 await f.client.catalog();await assert.rejects(()=>f.client.save(definition()));
 await assert.rejects(()=>f.client.consult(),{code:'READBACK_UNCONFIRMED'});assert.equal(f.client.locked(),true);
 assert.equal(f.client.snapshot().operation.phase,'succeeded');assert.equal(f.client.snapshot().recoveryId,100);
 available=true;await f.client.consult();assert.equal(f.client.locked(),false);
 assert.equal(f.client.snapshot().campaign.status,'cancelled');assert.equal(f.client.snapshot().campaign.version,current.version);
 assert.equal(f.client.snapshot().operation.response.body.campaign.status,'draft','original receipt remains historical');
 assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1,'reconciliation never repeats the write');
});
test('unavailable durable browser storage prevents transport; server capability denial confirms no claim',async()=>{
 const f=fixture(async()=>({status:401,body:{error:'UNAUTHORIZED'}}));await f.client.catalog();
 f.options.storage.setItem=()=>{throw Error('quota');};await assert.rejects(()=>f.client.save(definition()),{code:'JOURNAL_UNAVAILABLE'});assert.equal(f.calls.filter(c=>c.init.method==='POST').length,0);
 const g=fixture(async()=>({status:403,body:{error:'CAPABILITY_MISSING',operation_id:null}}));await g.client.catalog();await assert.rejects(()=>g.client.save(definition()));assert.equal(g.client.locked(),false);assert.equal(g.client.snapshot().operation.phase,'rejected');
});
test('a second open client observes the already persisted pending operation and cannot replace its key',async()=>{
 let release;const wait=new Promise(resolve=>{release=resolve;}),f=fixture(async()=>{await wait;return {status:502,body:{error:'OUTCOME_UNKNOWN'}};});
 const other=f.reload();await f.client.catalog();await other.catalog();const first=f.client.save(definition());
 await new Promise(setImmediate);await assert.rejects(()=>other.save(definition()),{code:'OPERATION_PENDING'});release();await assert.rejects(()=>first);assert.equal(f.count(),1);
});
test('endpoint changes and corrupted journals cannot hide a pending operation; withdrawn flags prevent writes',async()=>{
 const f=fixture(async()=>({status:502,body:{error:'OUTCOME_UNKNOWN'}}));await f.client.catalog();await assert.rejects(()=>f.client.save(definition()));
 assert.throws(()=>A.createClient({...f.options,capabilities:{...f.options.capabilities,endpoint:'https://replacement.example.test/operations'}}),{code:'JOURNAL_INVALID'});
 const g=fixture(async()=>({status:200,body:{campaign:campaign()}}));await g.client.catalog();g.client.updateCapabilities({...g.options.capabilities,save:false});
 await assert.rejects(()=>g.client.save(definition()),{code:'CAPABILITY_UNAVAILABLE'});assert.equal(g.calls.filter(c=>c.init.method==='POST').length,0);
 g.data.set(A.JOURNAL+'fish','{broken');assert.throws(()=>g.reload(),{code:'JOURNAL_INVALID'});
});

test('without a cross-tab lock writes fail closed while catalog, list and operation lookup remain read-only',async()=>{
 const f=fixture(async req=>req.acao==='campanha_listar'?{status:200,body:{campaigns:[campaign()]}}:req.acao==='campanha_operacao'?{status:200,body:{operation:{brand:'fish',state:'outcome_unknown'}}}:{status:502,body:{error:'OUTCOME_UNKNOWN'}});
 const noLock=A.createClient({...f.options,locks:null});await noLock.catalog();assert.equal((await noLock.list()).length,1);
 assert.equal(noLock.canWrite(),false);await assert.rejects(()=>noLock.save(definition()),{code:'WRITE_LOCK_UNAVAILABLE'});await assert.rejects(()=>noLock.newDraft(),{code:'WRITE_LOCK_UNAVAILABLE'});assert.equal(f.count(),0);
 await f.client.catalog();await assert.rejects(()=>f.client.save(definition()));const before=[...f.data.values()];
 const answer=await noLock.consult();assert.equal(answer.readOnly,true);assert.equal(answer.consultation.state,'outcome_unknown');assert.deepEqual([...f.data.values()],before);assert.equal(noLock.locked(),true);
});
test('two tabs cannot overlap before the journal write, reset an in-flight operation, or create again from a stale selection',async()=>{
 let release;const paused=new Promise(r=>{release=r;}),f=fixture(async()=>({status:201,body:{campaign:campaign()}}));
 const original=f.options.keyFingerprint;f.options.keyFingerprint=async k=>{await paused;return original(k);};
 const first=A.createClient(f.options),other=A.createClient(f.options);await first.catalog();await other.catalog();const writing=first.save(definition());
 await new Promise(setImmediate);assert.equal(f.data.size,0);
 await assert.rejects(()=>other.save(definition()),{code:'OPERATION_PENDING'});await assert.rejects(()=>other.newDraft(),{code:'OPERATION_PENDING'});await assert.rejects(()=>other.reopen(100),{code:'OPERATION_PENDING'});
 release();await writing;await assert.rejects(()=>other.save(definition()),{code:'CAMPAIGN_CHANGED'});assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);assert.equal(f.count(),1);
});
test('cancellation uses the current scheduled version and requires a newly confirmed cancelled revision',async()=>{
 const f=fixture(async req=>{const c=campaign();if(req.acao==='campanha_obter')c.status='scheduled';if(req.acao==='campanha_cancelar'){c.status='cancelled';c.version='v2';}return {status:200,body:{campaign:c}};});
 await f.client.reopen(100);await assert.rejects(()=>f.client.cancel('agendar'),{code:'CONFIRM_REQUIRED'});await f.client.cancel('cancelar');
 const sent=f.calls.find(c=>c.request.acao==='campanha_cancelar').request;assert.equal(sent.id,100);assert.equal(sent.expected_version,'v1');assert.equal(sent.confirm,'cancelar');assert.equal(f.client.snapshot().campaign.status,'cancelled');assert.equal(f.client.snapshot().validation,null);
 const g=fixture(async()=>({status:200,body:{campaign:{...campaign(),status:'scheduled'}}}));await g.client.reopen(100);await assert.rejects(()=>g.client.cancel('cancelar'));assert.equal(g.client.locked(),true);
});

test('missing audience capability preserves reading, saving and cancellation without advertising review or scheduling',()=>{
 for(const audience_review of [undefined,'different-policy',true]){const c=A.caps({capabilities:{...API.capabilities,campaigns:{...API.capabilities.campaigns,audience_review}}});assert.equal(c.read,true);assert.equal(c.operation,true);assert.equal(c.save,true);assert.equal(c.cancel,true);assert.equal(c.validate,false);assert.equal(c.schedule,false);}
});
const audienceHandler=(req,a)=>({status:200,body:{campaign:{...campaign(),...(req.acao==='campanha_agendar'?{status:'scheduled'}:{})},...(req.acao==='campanha_validar'?{validation:{policy:A.VERSION,version:'v1',ok:true,audience:a}}:{}),...(req.acao==='campanha_agendar'?{audience:{...a,rechecked_at:a.checked_at}}:{})}});
test('review identity is explicit, checked again under the shared journal lock, and never selected silently',async()=>{
 const a=audienceFixture(campaign(),NOW),f=fixture(async req=>audienceHandler(req,a));await f.client.catalog();await f.client.save(definition());await f.client.validate(definition());
 for(const review of [undefined,'wrong'])await assert.rejects(()=>f.client.schedule(definition(),'agendar',review),{code:'AUDIENCE_REVIEW_REQUIRED'});
 const slot=A.JOURNAL+'fish',changed=JSON.parse(f.data.get(slot));changed.validation.audience.review_id='00000000-0000-4000-8000-000000000002';f.data.set(slot,JSON.stringify(changed));
 await assert.rejects(()=>f.client.schedule(definition(),'agendar',a.review_id),{code:'AUDIENCE_REVIEW_REQUIRED'});assert.equal(f.calls.some(c=>c.request.acao==='campanha_agendar'),false);
});
test('expired, empty and disabled reviews do not issue schedule transport',async()=>{
 for(const patch of [{eligible_count:0,unique_members_count:0},{native_disabled_count:1},{checked_at:new Date(NOW-300001).toISOString(),expires_at:new Date(NOW-1).toISOString()}]){
  const a=audienceFixture(campaign(),NOW,patch),f=fixture(async req=>audienceHandler(req,a));await f.client.catalog();await f.client.save(definition());await f.client.validate(definition());await assert.rejects(()=>f.client.schedule(definition(),'agendar',a.review_id));assert.equal(f.calls.some(c=>c.request.acao==='campanha_agendar'),false);
 }
});
test('a successful schedule with a different audience receipt remains uncertain and cannot repeat',async()=>{
 const a=audienceFixture(campaign(),NOW),f=fixture(async req=>{const r=audienceHandler(req,a);if(req.acao==='campanha_agendar')r.body.audience.review_id='00000000-0000-4000-8000-000000000002';return r;});await f.client.catalog();await f.client.save(definition());await f.client.validate(definition());await assert.rejects(()=>f.client.schedule(definition(),'agendar',a.review_id));assert.equal(f.client.locked(),true);await assert.rejects(()=>f.reload().schedule(definition(),'agendar',a.review_id),{code:'OPERATION_PENDING'});assert.equal(f.calls.filter(c=>c.request.acao==='campanha_agendar').length,1);
});
test('legacy validation receipt remains recoverable while no new scheduling can use it',async()=>{
 const receipt={status:200,body:{campaign:campaign(),validation:{policy:A.VERSION,version:'v1',ok:true}}};
 const f=fixture(async req=>req.acao==='campanha_operacao'?{status:200,body:{operation:{brand:'fish',state:'succeeded',response:receipt}}}:req.acao==='campanha_validar'?receipt:{status:200,body:{campaign:campaign()}});
 await f.client.catalog();await f.client.save(definition());await assert.rejects(()=>f.client.validate(definition()));assert.equal(f.client.locked(),true);await f.client.consult();assert.equal(f.client.locked(),false);assert.deepEqual(f.client.snapshot().operation.response,receipt);await assert.rejects(()=>f.client.schedule(definition(),'agendar'),{code:'AUDIENCE_REVIEW_REQUIRED'});assert.equal(f.calls.some(c=>c.request.acao==='campanha_agendar'),false);
});
test('legacy successful schedule without audience proof can be polled without replaying or rewriting its receipt',async()=>{
 const c={...campaign(),status:'scheduled'},receipt={status:200,body:{campaign:c,operation_id:'legacy'}};
 const f=fixture(async req=>req.acao==='campanha_operacao'?{status:200,body:{operation:{brand:'fish',state:'succeeded',response:receipt}}}:{status:200,body:{campaign:req.acao==='campanha_obter'?c:campaign()}});await f.client.catalog();await f.client.save(definition());
 const slot=A.JOURNAL+'fish',s=JSON.parse(f.data.get(slot));s.operation.phase='uncertain';s.operation.request={...s.operation.request,acao:'campanha_agendar',id:100,expected_version:'v1',confirm:'agendar'};f.data.set(slot,JSON.stringify(s));
 const client=f.reload();await client.consult();assert.equal(client.locked(),false);assert.equal(client.snapshot().campaign.status,'scheduled');assert.deepEqual(client.snapshot().operation.response,receipt);assert.equal(f.calls.filter(c=>c.init.method==='POST').length,1);
});

const RECOVERY_SOURCE='00000000-0000-4000-8000-000000000160',RECOVERY_OPERATION='00000000-0000-4000-8000-000000000161';
const recoveryRecord=(req,receipt)=>({id:RECOVERY_OPERATION,operation_key:req.idempotency_key,action:'recuperar',providerId:160,brand:'fish',state:'succeeded',response:{status:200,body:receipt}});
const recoveryCaps=()=>A.caps({capabilities:{...API.capabilities,campaigns:{...API.capabilities.campaigns,recover:true,recovery_policy:A.RECOVERY_POLICY}}});
function recoveryFixture(handler){
 const original={...definition(),send_at:'2099-09-20T15:00:00.000Z',html:'https://fishermans.com.br/ {{ UnsubscribeURL }}',text:'https://fishermans.com.br/ {{ UnsubscribeURL }}'},native={...campaign(),id:160,version:'native-160',send_at:null,definition:{...original,send_at:null}};
 const oldKey='original-save-attempt-160',oldReceipt={status:502,body:{error:'OUTCOME_UNKNOWN',message:'Original immutable receipt',provider_id:160}},record={id:RECOVERY_SOURCE,operation_key:oldKey,brand:'fish',action:'salvar',state:'outcome_unknown',providerId:160,response:oldReceipt};
 const proof={policy:A.RECOVERY_POLICY,source_operation_id:RECOVERY_SOURCE,campaign:native,frozen:false},receipt={campaign:native,operation_id:RECOVERY_OPERATION,source_operation_id:RECOVERY_SOURCE,recovery_policy:A.RECOVERY_POLICY};
 const f=fixture(async(req,init,data)=>handler?handler(req,init,{record,proof,receipt,native,original,data}):req.acao==='campanha_operacao'?{status:200,body:req.idempotency_key===oldKey?{operation:record,recovery:proof}:{operation:recoveryRecord(req,receipt)}}:req.acao==='campanha_obter'?{status:200,body:{campaign:native}}:{status:200,body:receipt});
 f.options.capabilities=recoveryCaps();f.data.set(A.JOURNAL+'fish',JSON.stringify({version:1,brand:'fish',endpoint:END,campaign:null,validation:null,operation:{phase:'uncertain',actorFingerprint:createHash('sha256').update('synthetic-write-secret').digest('hex'),key:oldKey,request:{acao:'campanha_salvar',brand:'fish',definition:original,idempotency_key:oldKey},last_error:'OUTCOME_UNKNOWN',created_at:new Date(NOW).toISOString()}}));f.client=f.reload();
 return {...f,original,native,record,proof,receipt,oldKey};
}
test('content preflight rejects homepage-only links before reserving an identity or issuing a POST',async()=>{
 const f=fixture(async()=>{throw Error('no transport expected');});await f.client.catalog();const bad={...definition(),html:'https://fishermans.com.br/ {{ UnsubscribeURL }}',text:'https://fishermans.com.br/ {{ UnsubscribeURL }}'};
 await assert.rejects(()=>f.client.save(bad),{code:'NO_COMMERCIAL_LINK'});assert.equal(f.count(),0);assert.equal(f.data.has(A.JOURNAL+'fish'),false);assert.equal(f.calls.filter(x=>x.init.method==='POST').length,0);
});
test('recovery requires an exact announced policy and a proof tied to the original operation, author and native draft',async()=>{
 for(const patch of [{recover:false},{recovery_policy:'different'}, {save:false},{operation:false}])assert.equal(A.caps({capabilities:{...API.capabilities,campaigns:{...API.capabilities.campaigns,recover:true,recovery_policy:A.RECOVERY_POLICY,...patch}}}).recover,false);
 for(const change of [p=>p.record.operation_key='other-attempt-160',p=>p.record.id=RECOVERY_OPERATION,p=>p.record.action='validar',p=>p.record.state='pending',p=>p.record.brand='aristo',p=>p.record.providerId=999,p=>p.proof.frozen=true,p=>p.proof.campaign.status='scheduled',p=>p.proof.campaign.sent=1,p=>p.proof.campaign.started_at='2026-09-19T12:00:00Z',p=>delete p.record.operation_key]){
  const f=recoveryFixture(async(req,init,p)=>{change(p);return {status:200,body:{operation:p.record,recovery:p.proof}};});await f.client.consult().catch(e=>assert.equal(e.code,'RESPONSE_UNCONFIRMED'));assert.equal(f.client.canRecover(),false);assert.equal(f.client.locked(),true);await assert.rejects(()=>f.client.recover(f.proof,'recuperar'),{code:'RECOVERY_UNCONFIRMED'});assert.equal(f.calls.some(x=>x.init.method==='POST'),false);
 }
});
test('confirmed recovery stores the original receipt and requested date before POST, reads current state, then updates the same native ID',async()=>{
 const f=recoveryFixture(async(req,init,p)=>{
  if(req.acao==='campanha_operacao')return {status:200,body:req.idempotency_key===p.record.operation_key?{operation:p.record,recovery:p.proof}:{operation:recoveryRecord(req,p.receipt)}};
  if(req.acao==='campanha_obter')return {status:200,body:{campaign:p.native}};
  if(req.acao==='campanha_recuperar'){const s=JSON.parse(p.data.get(A.JOURNAL+'fish'));assert.deepEqual(s.sourceOperation.serverRecord,p.record);assert.deepEqual(s.sourceOperation.request.definition,p.original);assert.equal(s.operation.phase,'pending');assert.notEqual(s.operation.key,s.sourceOperation.key);return {status:200,body:p.receipt};}
  assert.equal(req.acao,'campanha_salvar');assert.equal(req.id,160);return {status:200,body:{campaign:{...p.native,version:'edited-160',definition:req.definition,send_at:req.definition.send_at}}};
 });await f.client.consult();assert.equal(f.client.canRecover(),true);assert.equal(f.client.locked(),true);
 await assert.rejects(()=>f.client.recover(f.proof,'salvar'),{code:'CONFIRM_REQUIRED'});assert.equal(f.calls.some(x=>x.init.method==='POST'),false);
 await f.client.recover(f.proof,'recuperar');assert.equal(f.client.locked(),false);assert.equal(f.client.snapshot().campaign.id,160);assert.deepEqual(f.client.snapshot().sourceOperation.serverRecord.response,f.record.response);assert.equal(f.reload().snapshot().sourceOperation.request.definition.send_at,'2099-09-20T15:00:00.000Z');
 await f.client.catalog();await f.client.save({...definition(),send_at:f.original.send_at});const posts=f.calls.filter(x=>x.init.method==='POST').map(x=>x.request);assert.deepEqual(posts.map(x=>x.acao),['campanha_recuperar','campanha_salvar']);assert.equal(posts[1].id,160);assert.equal(posts[1].expected_version,'native-160');
});
test('recovery rechecks proof and capabilities immediately before POST and rejects a changed author',async()=>{
 for(const variant of ['revision','capability','author']){
  let reads=0,f;f=recoveryFixture(async(req,init,p)=>{reads++;if(reads===2){if(variant==='revision')p.proof.campaign.version='changed';if(variant==='capability')f.client.updateCapabilities({...recoveryCaps(),recover:false});}return {status:200,body:{operation:p.record,recovery:p.proof}};});await f.client.consult();const proof=f.client.snapshot().recoveryProof;if(variant==='author')f.setKey('different-write-key');await assert.rejects(()=>f.client.recover(proof,'recuperar'));assert.equal(f.count(),0);assert.equal(f.calls.some(x=>x.init.method==='POST'),false);assert.equal(f.client.locked(),true);assert.equal(f.client.snapshot().operation.key,f.oldKey);
 }
});
test('a lost recovery response survives reload and polls only the new identity without replaying the POST',async()=>{
 let accepted=false;
 const f=recoveryFixture(async(req,init,p)=>{
  if(req.acao==='campanha_recuperar'){accepted=true;throw Error('response lost');}
  if(req.acao==='campanha_operacao')return {status:200,body:accepted?{operation:{id:RECOVERY_OPERATION,operation_key:req.idempotency_key,action:'recuperar',providerId:160,brand:'fish',state:'succeeded',response:{status:200,body:p.receipt}}}:{operation:p.record,recovery:p.proof}};
  return {status:200,body:{campaign:p.native}};
 });await f.client.consult();await assert.rejects(()=>f.client.recover(f.proof,'recuperar'));const key=f.client.snapshot().operation.key,client=f.reload();assert.notEqual(key,f.oldKey);assert.equal(client.locked(),true);assert.deepEqual(client.snapshot().sourceOperation.serverRecord.response,f.record.response);await assert.rejects(()=>client.newDraft(),{code:'OPERATION_PENDING'});await assert.rejects(()=>client.recover(f.proof,'recuperar'),{code:'RECOVERY_UNCONFIRMED'});
 await client.consult();assert.equal(f.calls.at(-2).request.idempotency_key,key);assert.equal(client.locked(),false);assert.equal(client.snapshot().campaign.id,160);assert.equal(f.calls.filter(x=>x.init.method==='POST').length,1);
 const slot=A.JOURNAL+'fish',broken=JSON.parse(f.data.get(slot));delete broken.sourceOperation;f.data.set(slot,JSON.stringify(broken));assert.throws(()=>f.reload(),{code:'JOURNAL_INVALID'});
});
test('recovery never unlocks on malformed receipt, failed current readback, or a rejected reconciliation',async()=>{
 for(const failure of ['receipt','readback','rejected']){
  let post=false;const f=recoveryFixture(async(req,init,p)=>{
   if(req.acao==='campanha_recuperar'){post=true;return failure==='rejected'?{status:409,body:{error:'RECOVERY_CHANGED'}}:{status:200,body:{...p.receipt,...(failure==='receipt'?{source_operation_id:RECOVERY_OPERATION}:{})}};}
   if(req.acao==='campanha_operacao')return post&&failure==='rejected'?{status:200,body:{operation:{id:RECOVERY_OPERATION,operation_key:req.idempotency_key,action:'recuperar',brand:'fish',state:'rejected',providerId:null,response:{status:409,body:{error:'RECOVERY_CHANGED'}}}}}:{status:200,body:post?{operation:recoveryRecord(req,p.receipt)}:{operation:p.record,recovery:p.proof}};
   return {status:502,body:{error:'readback unavailable'}};
  });await f.client.consult();await assert.rejects(()=>f.client.recover(f.proof,'recuperar'));if(failure==='rejected')await assert.rejects(()=>f.client.consult(),{code:'RECOVERY_REJECTED'});assert.equal(f.client.locked(),true);await assert.rejects(()=>f.reload().newDraft(),{code:'OPERATION_PENDING'});assert.equal(f.calls.filter(x=>x.init.method==='POST').length,1);assert.deepEqual(f.client.snapshot().sourceOperation.serverRecord.response,f.record.response);
 }
});
test('a recovery lookup must identify the same new operation and receipt before changing the journal',async()=>{
 for(const change of [r=>r.operation_key='other-recovery-attempt',r=>r.action='salvar',r=>r.id=RECOVERY_SOURCE,r=>r.providerId=999]){
  let post=false;const f=recoveryFixture(async(req,init,p)=>{if(req.acao==='campanha_recuperar'){post=true;throw Error('response lost');}if(!post)return {status:200,body:{operation:p.record,recovery:p.proof}};const operation={id:RECOVERY_OPERATION,operation_key:req.idempotency_key,action:'recuperar',providerId:160,brand:'fish',state:'succeeded',response:{status:200,body:p.receipt}};change(operation);return {status:200,body:{operation}};});
  await f.client.consult();await assert.rejects(()=>f.client.recover(f.proof,'recuperar'));const before=f.data.get(A.JOURNAL+'fish');await assert.rejects(()=>f.client.consult(),{code:'RESPONSE_UNCONFIRMED'});assert.equal(f.data.get(A.JOURNAL+'fish'),before);assert.equal(f.client.locked(),true);assert.equal(f.calls.filter(x=>x.init.method==='POST').length,1);
 }
});
test('two clients cannot reconcile the same original attempt twice',async()=>{
 let release,entered;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const f=recoveryFixture(async(req,init,p)=>{if(req.acao==='campanha_operacao')return {status:200,body:req.idempotency_key===p.record.operation_key?{operation:p.record,recovery:p.proof}:{operation:recoveryRecord(req,p.receipt)}};if(req.acao==='campanha_recuperar'){entered();await held;return {status:200,body:p.receipt};}return {status:200,body:{campaign:p.native}};});
 await f.client.consult();const second=f.reload(),pending=f.client.recover(f.proof,'recuperar');await started;await assert.rejects(()=>second.recover(f.proof,'recuperar'),{code:'OPERATION_PENDING'});release();await pending;await assert.rejects(()=>second.recover(f.proof,'recuperar'),{code:'RECOVERY_UNCONFIRMED'});assert.equal(f.calls.filter(x=>x.init.method==='POST').length,1);
});
test('confirmed recovery requires its matching durable receipt before unlock, tolerating only JSON key order',async()=>{
 for(const mismatch of [true,false]){
  let posted=false;const f=recoveryFixture(async(req,init,p)=>{
   if(req.acao==='campanha_recuperar'){posted=true;return {status:200,body:p.receipt};}
   if(req.acao==='campanha_operacao'){
    if(!posted)return {status:200,body:{operation:p.record,recovery:p.proof}};
    const body=Object.fromEntries(Object.entries(p.receipt).reverse());if(mismatch)body.operation_id='00000000-0000-4000-8000-000000000162';
    return {status:200,body:{operation:{...recoveryRecord(req,body),id:body.operation_id}}};
   }return {status:200,body:{campaign:p.native}};
  });await f.client.consult();if(mismatch){await assert.rejects(()=>f.client.recover(f.proof,'recuperar'),{code:'RESPONSE_UNCONFIRMED'});assert.equal(f.client.locked(),true);assert.equal(f.calls.some(x=>x.request.acao==='campanha_obter'),false);}else{await f.client.recover(f.proof,'recuperar');assert.equal(f.client.locked(),false);}
  assert.equal(f.calls.filter(x=>x.init.method==='POST').length,1);assert.deepEqual(f.client.snapshot().sourceOperation.serverRecord.response,f.record.response);
 }
});
