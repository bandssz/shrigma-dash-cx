'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
global.CampaignContract=require('../campaign-contract');
const A=require('../growth-campaign-api'),createLocks=require('./campaign-lock-fixture.cjs');
const END='https://campaign.example.test/operations',NOW=Date.parse('2026-09-19T12:00:00Z');
const API={capabilities:{campaigns:{contract_version:A.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true},endpoints:{campaigns:END}}};
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
 const f=fixture(async req=>{const c=campaign();if(req.acao==='campanha_agendar')c.status='scheduled';return {status:req.acao==='campanha_salvar'?201:200,body:{campaign:c,...(req.acao==='campanha_validar'?{validation:{policy:A.VERSION,version:c.version,ok:true}}:{})}};});
 await f.client.catalog();await f.client.save(definition());assert.equal(f.client.snapshot().campaign.id,100);
 await assert.rejects(()=>f.client.validate({...definition(),subject:'Alterado'}),{code:'UNSAVED_CHANGES'});
 await f.client.validate(definition());await assert.rejects(()=>f.client.schedule(definition(),'outra palavra'),{code:'CONFIRM_REQUIRED'});
 await f.client.schedule(definition(),'agendar');assert.equal(f.client.snapshot().campaign.status,'scheduled');
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
 assert.equal(f.calls.at(-1).request.k,'synthetic-write-secret');assert.equal(f.calls.at(-1).request.idempotency_key,f.client.snapshot().operation.key);
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
