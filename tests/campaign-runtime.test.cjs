const audience=require('./campaign-audience-fixture.cjs');
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRuntime}=require('../n8n/growth/campaign-runtime');
const {createService}=require('../n8n/growth/campaign-service');
const {createStore}=require('../n8n/growth/campaign-store');
const {createProvider}=require('../n8n/growth/campaign-provider');
const {createNative}=require('../n8n/growth/campaign-native');
const copy=x=>JSON.parse(JSON.stringify(x)),NOW=Date.parse('2026-09-19T12:00:00Z');
const AUTH={actor:'synthetic-editor',caps:['read_content','draft','validate','submit']};
const definition=()=>({schema_version:'crm-campaign-v1',brand:'fish',channel:'email',initiative:{key:'fixture',name:'Fixture'},
 utm_campaign:'fixture',name:'Runtime fixture',subject:'Assunto de teste',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',
 list_ids:[125],template_id:1,html:'<a href="https://fishermans.com.br/products/kit">Kit</a> {{ UnsubscribeURL }}',
 text:'https://fishermans.com.br/products/kit\n{{ UnsubscribeURL }}',tags:[],send_at:'2026-09-20T15:00:00-03:00'});
const command=(action,extra={})=>({acao:'campanha_'+action,brand:'fish',idempotency_key:'runtime-'+action+'-000001',...extra});
const sql=kind=>'SELECT public.shrigma_campaign_'+kind+'($1::text,$2::jsonb) AS result';

// In-memory transport fixture only: no Listmonk calls, contacts, or sends. The
// production store/provider/native/service adapters run unchanged in both paths.
function backend(options={}){
 const campaigns=new Map(),operations=new Map(),validations=new Map(),effects=[];
 const counts={create:0,preview:0,update:0,schedule:0};let next=100;
 const catalog={brand:'fish',current:true,lists:[{id:125,brand:'fish',available:true}],templates:[{id:1,type:'campaign',available:true,version:'template-v1'}],initiatives:[]};
 const dbError=message=>Object.assign(new Error(message),{code:'P0001'});
 async function query(queryText,params){
  const kind=queryText===sql('store')?'store':queryText===sql('provider')?'provider':null;
  assert.ok(kind,'only fixed parameterized SQL is accepted');assert.equal(params.length,2);
  const [action,json]=params,p=JSON.parse(json);effects.push({kind,action,payload:copy(p)});let result;
  if(kind==='store'){
   if(action==='claim'){
    const key=p.actor+'|'+p.key,old=operations.get(key);
    if(old)result={...old,acquired:false,lease:null};
    else{result={...p,id:'operation-'+(operations.size+1),lease:'lease-'+(operations.size+1),acquired:true,state:'pending'};operations.set(key,result);}
   }else if(action==='get'){
    const op=operations.get(p.actor+'|'+p.key);result=op?{id:op.id,brand:op.brand,state:op.state,providerId:op.providerId??null,response:op.response??null}:null;
   }else if(action==='provider'||action==='finish'){
    const op=[...operations.values()].find(o=>o.id===p.id);assert.equal(op.lease,p.lease);
    if(action==='provider'){op.providerId=p.providerId;result={ok:true};}
    else{
     if(options.finishFailure)throw new Error('database unavailable');
     assert.equal(op.state,'pending','fixture never reclaims finalized operations');Object.assign(op,copy(p));result={ok:true};
    }
   }else if(action==='validation_set'){validations.set(p.providerId,p.validation);result={ok:true};}
   else if(action==='validation_get')result=validations.get(p.providerId)||null;
   else if(action==='validation_invalidate'){validations.delete(p.providerId);result={ok:true};}
   else assert.fail('unexpected store action');
  }else{
   if(action==='catalog')result=catalog;
   else if(action==='get')result=campaigns.get(p.id)||null;
   else if(action==='list')result=[...campaigns.values()];
   else if(action==='update'){
    counts.update++;if(options.updateError)throw options.updateError;
    const c=campaigns.get(p.id);if(c.version!==p.expectedVersion)throw dbError('VERSION_CONFLICT');
    Object.assign(c,{version:'v2',definition:copy(p.definition),send_at:p.definition.send_at});result=c;
    if(options.updateTimeoutAfterWrite)throw new Error('lost update response');
   }else if(action==='review'){
    const c=campaigns.get(p.id),v={policy:'crm-campaign-v1',version:c.version,ok:true,validated_at:new Date(NOW).toISOString(),audience:audience(c,NOW)};validations.set(p.id,v);result={campaign:c,validation:v};
   }else if(action==='schedule'){
    counts.schedule++;const c=campaigns.get(p.id);if(c.version!==p.expectedVersion)throw dbError('VERSION_CONFLICT');
    assert.equal(validations.get(p.id)?.version,c.version);c.status='scheduled';result={...c,audience:validations.get(p.id).audience};
   }else if(action==='cancel'){
    const c=campaigns.get(p.id);if(c.version!==p.expectedVersion)throw dbError('VERSION_CONFLICT');
    if(c.status!=='scheduled'||c.sent!==0||c.started_at!==null||Date.parse(c.send_at)<=NOW)throw dbError('CAMPAIGN_LOCKED');
    counts.cancel=(counts.cancel||0)+1;Object.assign(c,{version:'cancelled-v2',status:'cancelled'});result=c;
    const op=[...operations.values()].find(o=>o.id===p.operationId);assert.equal(op.action,'cancelar');op.providerId=c.id;
    if(options.cancelTimeoutAfterWrite)throw new Error('lost cancellation response');
   }else assert.fail('unexpected provider action');
  }
  return {rows:[{result:copy(result)}]};
 }
 async function request(r){
  effects.push({kind:r.path==='/api/campaigns'?'nativeCreate':'preview',request:copy(r)});
  if(r.path==='/api/campaigns'){
   counts.create++;assert.equal(r.json.send_at,null);assert.equal(r.json.type,'regular');
   const p=r.json,id=next++,d={schema_version:p.attribs.crm.policy,brand:p.attribs.crm.brand,channel:'email',
    initiative:{key:p.attribs.crm.initiative_key,name:p.attribs.crm.initiative_name},utm_campaign:p.attribs.crm.utm_campaign,
    name:p.name,subject:p.subject,from_email:p.from_email,reply_to:p.headers[0]['Reply-To'],list_ids:p.lists,template_id:p.template_id,
    html:p.body,text:p.altbody,tags:p.tags,send_at:null};
   campaigns.set(id,{id,version:'v1',status:'draft',sent:0,started_at:null,send_at:null,definition:d});
   if(options.createTimeoutAfterWrite)throw new Error('lost create response');
   return {status:201,body:{data:{id}}};
  }
  assert.match(r.path,/^\/api\/campaigns\/\d+\/preview$/);counts.preview++;
  return {status:options.compileFailure?422:200,body:options.compileFailure?'':'rendered synthetic content'};
 }
 const native=createNative({request}),direct=createService({store:createStore({query}),provider:createProvider({query,...native}),now:()=>NOW});
 async function perform(effect){
  if(effect.kind==='store'||effect.kind==='provider')return query(sql(effect.kind),[effect.action,JSON.stringify(effect.payload)]);
  if(effect.kind==='nativeCreate')return request({method:'POST',path:'/api/campaigns',json:effect.payload,responseType:'json'});
  if(effect.kind==='preview')return request({method:'POST',path:`/api/campaigns/${effect.idCampaign}/preview`,form:effect.payload,responseType:'text'});
  assert.fail('unexpected effect kind');
 }
 return {direct,perform,counts,effects,operations,campaigns};
}
function errorReceipt(effect_id,e){return {effect_id,ok:false,error:{message:e.message,...(e.code?{code:e.code}:{}),...(e.status?{status:e.status}:{}),...(e.nothingChanged!==undefined?{nothingChanged:e.nothingChanged}:{})}};}
async function drive(runtime,b,request,executionId='execution-1',auth=AUTH){
 let step=await runtime.start(auth,request,{executionId}),n=0;
 while(step.kind==='effect'){
  assert.ok(n++<64,'bounded effect loop');const state=copy(step.context);let receipt;
  try{receipt={effect_id:step.effect.id,ok:true,value:await b.perform(step.effect)};}catch(e){receipt=errorReceipt(step.effect.id,e);}
  step=await runtime.resume(state,copy(receipt),{executionId});
 }
 assert.equal(step.kind,'response');assert.ok(!Object.hasOwn(step,'context'),'terminal never exposes lease or transcript');return step.response;
}

test('runtime replay matches the original service through save, validate and schedule without repeating effects',async()=>{
 const r=createRuntime({now:()=>NOW}),a=backend(),b=backend();
 const save=command('salvar',{definition:definition()});
 const saved=await drive(r,b,save);assert.deepEqual(saved,await a.direct.handle(AUTH,save));
 assert.equal(saved.status,201);const {id,version}=saved.body.campaign;
 for(const [action,extras] of [['validar',{}],['agendar',{confirm:'agendar',audience_review_id:'00000000-0000-4000-8000-000000000001'}]]){
  const req=command(action,{id,expected_version:version,...extras});
  assert.deepEqual(await drive(r,b,req,'execution-'+action),await a.direct.handle(AUTH,req));
 }
 assert.deepEqual(b.effects,a.effects,'same adapter operation order and payloads');
 assert.deepEqual(b.counts,{create:1,preview:3,update:1,schedule:1});
 assert.equal([...b.operations.values()][0].state,'succeeded');
});

test('permission denial has no effects; transport keys, SQL and client identity are refused',async()=>{
 const r=createRuntime({now:()=>NOW}),b=backend(),req=command('salvar',{definition:definition()}),auth={...AUTH,caps:['read_content']};
 assert.deepEqual(await drive(r,b,req,'read-only',auth),await b.direct.handle(auth,req));assert.equal(b.effects.length,0);
 for(const extra of [{k:'synthetic-secret'},{sql:'SELECT 1'},{actor:'another-user'},{caps:['submit']},{transcript:[]},{effect:{kind:'nativeCreate'}}]){
  const out=await r.start(AUTH,{...req,...extra},{executionId:'forbidden-field'});assert.equal(out.kind,'response');assert.equal(out.response.body.error,'RUNTIME_RECONCILIATION_REQUIRED');
  assert.ok(!JSON.stringify(out).includes('synthetic-secret'));
 }
 const olivas=await r.start(AUTH,{...req,brand:'olivas'},{executionId:'no-expansion'});assert.equal(olivas.response.status,422);assert.equal(b.effects.length,0);
});

test('a lost creation response stays uncertain and a fresh retry never creates another draft',async()=>{
 const r=createRuntime({now:()=>NOW}),a=backend({createTimeoutAfterWrite:true}),b=backend({createTimeoutAfterWrite:true}),req=command('salvar',{definition:definition()});
 const first=await drive(r,b,req);assert.deepEqual(first,await a.direct.handle(AUTH,req));
 assert.equal(first.body.error,'OUTCOME_UNKNOWN');assert.equal([...b.operations.values()][0].state,'outcome_unknown');
 assert.equal([...b.campaigns.values()][0].status,'draft');
 assert.deepEqual(await drive(r,b,req,'retry-new-execution'),first);assert.equal(b.counts.create,1);
 const status=await drive(r,b,command('operacao',{idempotency_key:req.idempotency_key}),'inspect-operation');
 assert.equal(status.body.operation.state,'outcome_unknown');assert.ok(!Object.hasOwn(status.body.operation,'lease'));
});

test('definitive compilation rejection after creation preserves the draft ID and does not reopen its claim',async()=>{
 const r=createRuntime({now:()=>NOW}),a=backend({compileFailure:true}),b=backend({compileFailure:true}),req=command('salvar',{definition:definition()});
 const result=await drive(r,b,req);assert.deepEqual(result,await a.direct.handle(AUTH,req));
 assert.equal(result.status,422);assert.equal(result.body.error,'CONTENT_UNVALIDATED');assert.equal(result.body.provider_id,100);
 const op=[...b.operations.values()][0];assert.equal(op.state,'rejected');assert.equal(op.providerId,100);
 assert.deepEqual(await drive(r,b,req,'retry-rejection'),result);assert.equal(b.counts.create,1);assert.equal(b.counts.update,0);
});

test('an update timeout preserves identity and uncertainty; explicit SQL rollback preserves a definitive conflict',async()=>{
 for(const options of [{updateTimeoutAfterWrite:true},{updateError:Object.assign(new Error('VERSION_CONFLICT'),{code:'P0001'})},
  {updateError:Object.assign(new Error('rollback'),{code:'40001'})}]){
  const r=createRuntime({now:()=>NOW}),a=backend(options),b=backend(options),req=command('salvar',{definition:definition()});
  const result=await drive(r,b,req);assert.deepEqual(result,await a.direct.handle(AUTH,req));assert.equal(result.body.provider_id,100);
  assert.equal(result.body.error,options.updateTimeoutAfterWrite?'OUTCOME_UNKNOWN':options.updateError.code==='40001'?'CAMPAIGN_BUSY':'VERSION_CONFLICT');
  await drive(r,b,req,'new-execution-after-error');assert.equal(b.counts.create,1);
 }
});

test('unconfirmed finalization leaves the durable operation pending and blocks a fresh creation',async()=>{
 const r=createRuntime({now:()=>NOW}),a=backend({finishFailure:true}),b=backend({finishFailure:true}),req=command('salvar',{definition:definition()});
 const result=await drive(r,b,req);assert.deepEqual(result,await a.direct.handle(AUTH,req));assert.equal(result.body.error,'OUTCOME_UNKNOWN');
 assert.equal([...b.operations.values()][0].state,'pending');
 const retry=await drive(r,b,req,'retry-finalization');assert.equal(retry.body.error,'OPERATION_PENDING');assert.equal(b.counts.create,1);
});

test('concurrent HTTP attempts use independent contexts and the persistent claim permits one creation',async()=>{
 const r=createRuntime({now:()=>NOW}),b=backend(),req=command('salvar',{definition:definition()});
 const results=await Promise.all([drive(r,b,req,'concurrent-a'),drive(r,b,req,'concurrent-b')]);
 assert.equal(b.counts.create,1);assert.ok(results.some(x=>x.status===201));assert.ok(results.some(x=>x.body.error==='OPERATION_PENDING'));
});

test('context, execution and transcript mismatches stop before another effect',async()=>{
 const r=createRuntime({now:()=>NOW}),b=backend(),req=command('salvar',{definition:definition()});
 const first=await r.start(AUTH,req,{executionId:'bound'}),value=await b.perform(first.effect);
 const receipt={effect_id:first.effect.id,ok:true,value};
 for(const [state,result,id] of [[first.context,{...receipt,effect_id:'wrong'},'bound'],[first.context,receipt,'other-execution'],
  [{...first.context,now:NOW+1},receipt,'bound'],[{...first.context,request:{...req,brand:'aristo'}},receipt,'bound']]){
  const out=await r.resume(copy(state),copy(result),{executionId:id});assert.equal(out.kind,'response');assert.equal(out.response.body.error,'RUNTIME_RECONCILIATION_REQUIRED');
 }
 const second=await r.resume(first.context,receipt,{executionId:'bound'}),state=copy(second.context);
 state.transcript[0].fingerprint='0'.repeat(64);
 const out=await r.resume(state,{effect_id:second.effect.id,ok:true,value:{rows:[{result:{}}]}},{executionId:'bound'});
 assert.equal(out.kind,'response');assert.equal(b.counts.create,0);
});

test('step/size limits and malformed receipts fail closed, without deleting the claim or dispatching creation',async()=>{
 const r=createRuntime({now:()=>NOW,maxSteps:1}),b=backend(),req=command('salvar',{definition:definition()});
 const out=await drive(r,b,req);assert.equal(out.body.error,'RUNTIME_RECONCILIATION_REQUIRED');assert.equal(b.effects.length,1);
 assert.equal([...b.operations.values()][0].state,'pending');assert.equal(b.counts.create,0);
 const small=createRuntime({now:()=>NOW,maxBytes:1024}),oversized=await small.start(AUTH,{...req,definition:{...definition(),html:'x'.repeat(2000)}},{executionId:'large'});
 assert.equal(oversized.kind,'response');
 const normal=createRuntime({now:()=>NOW}),first=await normal.start(AUTH,req,{executionId:'malformed'});
 for(const bad of [{effect_id:first.effect.id,ok:true},{effect_id:first.effect.id,ok:false,error:{message:'x',headers:{authorization:'synthetic-secret'}}}]){
  const stopped=await normal.resume(first.context,bad,{executionId:'malformed'});assert.equal(stopped.kind,'response');assert.ok(!JSON.stringify(stopped).includes('synthetic-secret'));
 }
});

test('runtime clock remains fixed across serialization and content stays parameter data',async()=>{
 let clock=NOW;const r=createRuntime({now:()=>clock}),b=backend(),d=definition();
 d.html+="<p>O'Brien, café; $1; {{ UnsubscribeURL }}</p>";
 const first=await r.start(AUTH,command('salvar',{definition:d}),{executionId:'fixed-clock'});clock=Date.parse('2030-01-01T00:00:00Z');
 let step=first;
 while(step.kind==='effect'){
  assert.ok(!Object.hasOwn(step.effect,'sql'));assert.ok(!Object.hasOwn(step.effect,'url'));assert.equal(step.context.now,NOW);
  step=await r.resume(copy(step.context),{effect_id:step.effect.id,ok:true,value:await b.perform(step.effect)},{executionId:'fixed-clock'});
 }
 assert.equal(step.response.status,201);assert.ok(step.response.body.campaign.definition.html.includes("O'Brien, café; $1; {{ UnsubscribeURL }}"));
});

test('injected hashing uses the original service without Buffer or loading node crypto in the sandbox',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{hash}=require('../n8n/growth/campaign-service');
 let hashes=0,builtinAttempts=0;
 const serviceModule={exports:{}};
 const guardedRequire=name=>{
  if(name==='node:crypto'||name==='crypto'){builtinAttempts++;throw Error('Builtin unavailable');}
  return require(path.resolve(__dirname,'../n8n/growth',name));
 };
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../n8n/growth/campaign-service.js'),'utf8'),{module:serviceModule,require:guardedRequire});
 const runtimeModule={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../n8n/growth/campaign-runtime.js'),'utf8'),{
  module:runtimeModule,require:name=>name==='./campaign-service'?serviceModule.exports:guardedRequire(name)
 });
 const runtime=runtimeModule.exports.createRuntime({now:()=>NOW,hashValue:v=>{hashes++;return hash(v);}}),b=backend();
 const saved=await drive(runtime,b,command('salvar',{definition:definition()}));
 assert.equal(saved.status,201);assert.ok(hashes>0);assert.equal(builtinAttempts,0);
 const {id,version}=saved.body.campaign;
 const checked=await drive(runtime,b,command('validar',{id,expected_version:version}),'injected-validation');
 assert.equal(checked.status,200);assert.equal(builtinAttempts,0);
});

function scheduledFixture(b){
 const d=definition();b.campaigns.set(100,{id:100,version:'scheduled-v1',status:'scheduled',sent:0,started_at:null,send_at:d.send_at,definition:d});
 return command('cancelar',{id:100,expected_version:'scheduled-v1',confirm:'cancelar'});
}
test('explicit cancellation replays through guarded SQL only and returns its persisted receipt without another mutation',async()=>{
 const r=createRuntime({now:()=>NOW}),a=backend(),b=backend(),req=scheduledFixture(b);scheduledFixture(a);
 const result=await drive(r,b,req,'cancel-runtime');assert.deepEqual(result,await a.direct.handle(AUTH,req));
 assert.equal(result.status,200);assert.equal(result.body.campaign.status,'cancelled');assert.equal(result.body.campaign.sent,0);assert.equal(result.body.campaign.started_at,null);
 assert.deepEqual(b.effects,a.effects);assert.equal(b.counts.cancel,1);assert.equal(b.counts.create,0);assert.equal(b.counts.preview,0);
 assert.equal([...b.operations.values()][0].state,'succeeded');
 assert.deepEqual(await drive(r,b,req,'cancel-new-http-execution'),result);assert.equal(b.counts.cancel,1);
 assert.equal(b.effects.filter(e=>e.kind==='provider'&&e.action==='cancel').length,1);
});
test('lost cancellation result and unconfirmed finalization retain reservation and never repeat the cancellation',async()=>{
 for(const options of [{cancelTimeoutAfterWrite:true},{finishFailure:true}]){
  const r=createRuntime({now:()=>NOW}),b=backend(options),req=scheduledFixture(b);
  const result=await drive(r,b,req,'cancel-with-loss');assert.equal(result.body.error,'OUTCOME_UNKNOWN');assert.equal(result.body.provider_id,100);
  assert.equal(b.campaigns.get(100).status,'cancelled');assert.equal(b.counts.cancel,1);assert.equal(b.operations.size,1);
  const op=[...b.operations.values()][0];assert.equal(op.state,options.finishFailure?'pending':'outcome_unknown');assert.equal(op.providerId,100);
  const retry=await drive(r,b,req,'cancel-loss-new-execution');assert.equal(retry.body.error,options.finishFailure?'OPERATION_PENDING':'OUTCOME_UNKNOWN');assert.equal(b.counts.cancel,1);
  const poll=await drive(r,b,command('operacao',{idempotency_key:req.idempotency_key}),'poll-cancel');assert.equal(poll.body.operation.state,op.state);assert.ok(!Object.hasOwn(poll.body.operation,'lease'));
 }
});
test('a completely lost cancel receipt leaves the claim pending; resuming the original receipt cannot replay the mutation',async()=>{
 const r=createRuntime({now:()=>NOW}),b=backend(),req=scheduledFixture(b),executionId='cancel-receipt-loss';
 let step=await r.start(AUTH,req,{executionId});
 while(!(step.kind==='effect'&&step.effect.kind==='provider'&&step.effect.action==='cancel')){
  assert.equal(step.kind,'effect');step=await r.resume(copy(step.context),{effect_id:step.effect.id,ok:true,value:await b.perform(step.effect)},{executionId});
 }
 const value=await b.perform(step.effect),context=copy(step.context),receipt={effect_id:step.effect.id,ok:true,value};
 assert.equal(b.campaigns.get(100).status,'cancelled');assert.equal([...b.operations.values()][0].state,'pending');
 assert.equal((await drive(r,b,req,'new-execution-without-receipt')).body.error,'OPERATION_PENDING');assert.equal(b.counts.cancel,1);
 let resumed=await r.resume(context,receipt,{executionId});
 while(resumed.kind==='effect')resumed=await r.resume(copy(resumed.context),{effect_id:resumed.effect.id,ok:true,value:await b.perform(resumed.effect)},{executionId});
 assert.equal(resumed.response.status,200);assert.equal(b.counts.cancel,1);assert.equal(b.operations.size,1);assert.equal([...b.operations.values()][0].state,'succeeded');
});
