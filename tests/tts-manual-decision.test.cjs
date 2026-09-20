'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createController,...api}=require('../n8n/tiktok/manual-decision.cjs');
const op='00000000-0000-4000-8000-000000000001',token='00000000-0000-4000-8000-000000000002';
const b=()=>({acao:'revisar',operation_id:op,marca:'fish',application_id:'123',resultado:'APPROVE',motivo_rejeicao:null,observacao:'synthetic',autor:'synthetic'});
const principal={actor_sha256:'a'.repeat(64),owner:'execution-fixture'};
function harness(options={}){
 let state=null,request=null,receipt=null,calls=[],sends=0;
 const body=()=>({ok:state==='accepted',operation_id:op,linhas:state==='accepted'?[{application_id:'123',status:'AWAITING_SHIPMENT',decisao:'manual_aprovada'}]:[]});
 const envelope=()=>({contract:'tts_manual_operation_v1',operation:{operation_id:op,marca:'fish',application_id:'123',actor_sha256:principal.actor_sha256,request_payload:request,state:state||'missing',response:['accepted','outcome_unknown','blocked'].includes(state)?{status:state==='accepted'?200:503,body:body()}:null}});
 const store=async(action,p)=>{
  calls.push(action);
  if(action==='get')return envelope();
  if(action==='claim'){
   if(state)return {allowed:false,code:'operation_exists',receipt:envelope()};
   state='reserved';request=p.request_payload;
   if(options.lostClaim)throw Error('fixture secret-bearing URL');
   return {...p,claim_token:token,allowed:true,code:'reserved',state,...options.claimWitness};
  }
  if(action==='dispatch'){
   assert.equal(state,'reserved');assert.equal(p.claim_token,token);state='in_flight';
   if(options.lostDispatch)throw Error('fixture secret-bearing URL');
   return {...p,allowed:true,code:'in_flight',state,...options.dispatchWitness};
  }
  if(action==='finish'){
   receipt=p.receipt;state=receipt.kind;
   if(options.lostFinish)throw Error('fixture secret-bearing URL');
   return {recorded:true,receipt:envelope()};
  }
  throw Error('unexpected action');
 };
 const transport=async()=>{sends++;assert.equal(state,'in_flight');if(options.timeout)throw Error('fixture secret-bearing URL');return options.response??{statusCode:200,body:{code:0,request_id:'synthetic-1'}};};
 return {store,transport,preflight:async()=>true,get state(){return state;},get sends(){return sends;},get calls(){return calls;},get receipt(){return receipt;},envelope};
}
test('strict request snapshots exclude key and caller-supplied principal',()=>{
 const p=api.normalize({...b(),k:'never-persist',actor_sha256:'b'.repeat(64),owner:'untrusted'},principal);
 assert.equal(p.actor_sha256,principal.actor_sha256);assert.equal(p.owner,principal.owner);assert.doesNotMatch(JSON.stringify(p),/never-persist|untrusted/);
 for(const delta of [{application_id:123},{application_id:'00123'},{application_id:'123x'},{operation_id:'123'},{resultado:'approve'},{autor:''},{autor:' synthetic'},{observacao:null},{motivo_rejeicao:'NOT_MATCH'}])assert.throws(()=>api.normalize({...b(),...delta},principal),/INVALID/);
 const q=api.query('claim',p);assert.equal(q.sql,'SELECT public.crm_tts_manual_store_v1($1::text,$2::jsonb) AS result');assert.equal(q.parameters[0],'claim');
});
test('one dispatch committed before one transport; repeat only returns the receipt',async()=>{
 const h=harness();assert.equal((await api.execute(b(),principal,h)).status,200);assert.deepEqual(h.calls,['claim','dispatch','finish']);assert.equal(h.sends,1);
 const result=await api.execute(b(),principal,h);assert.equal(result.status,409);assert.equal(h.sends,1);assert.equal(result.receipt.operation.state,'accepted');
 assert.equal((await api.get(b(),principal,h.store)).operation.state,'accepted');assert.equal(h.sends,1);
});
for(const loss of ['lostClaim','lostDispatch','lostFinish'])test(loss+' preserves state and never repeats transport',async()=>{
 const h=harness({[loss]:true});const first=await api.execute(b(),principal,h);assert.equal(first.status,503);assert.doesNotMatch(JSON.stringify(first),/secret-bearing/);
 await api.execute(b(),principal,h);assert.equal(h.sends,loss==='lostFinish'?1:0);
 const op=await api.get(b(),principal,h.store);assert.equal(op.operation.state,{lostClaim:'reserved',lostDispatch:'in_flight',lostFinish:'accepted'}[loss]);
});
test('omitted preflight never dispatches a reserved operation',async()=>{
 const h=harness();const r=await api.execute(b(),principal,{store:h.store,transport:h.transport});assert.equal(r.body.ok,false);assert.equal(h.state,'blocked');assert.equal(h.sends,0);
});
test('preflight unavailability retains a blocked reservation without a transport',async()=>{
 const h=harness();const r=await api.execute(b(),principal,{...h,preflight:async()=>{throw Error('token unavailable');}});assert.equal(r.body.ok,false);assert.equal(h.state,'blocked');assert.equal(h.sends,0);assert.deepEqual(h.calls,['claim','finish']);
});
test('wrong owner/payload/claim token cannot cross the transport boundary',async()=>{
 for(const options of [{claimWitness:{owner:'other'}},{dispatchWitness:{claim_token:op}},{dispatchWitness:{request_payload:{...b(),resultado:'REJECT'}}}]){
  const h=harness(options);assert.equal((await api.execute(b(),principal,h)).status,503);assert.equal(h.sends,0);
 }
});
test('timeout is outcome_unknown; no changing key, UUID or receipt can be an implicit retry',async()=>{
 const h=harness({timeout:true});assert.equal((await api.execute(b(),principal,h)).status,503);assert.equal(h.state,'outcome_unknown');assert.equal(h.receipt.reason,'transport_uncertain');
 await api.execute(b(),principal,h);assert.equal(h.sends,1);
});
test('empty, rejected, contradictory or unbound provider responses are uncertain',()=>{
 for(const r of [null,{statusCode:200,body:''},{statusCode:200,body:{code:0}},{statusCode:500,body:{code:0,request_id:'x'}},{statusCode:200,body:{code:0,request_id:'x',error:{}}},{statusCode:200,body:{code:42,request_id:'x'}},{statusCode:200,body:{code:'0',request_id:'x'}}])assert.equal(api.classify(r).kind,'outcome_unknown');
 assert.equal(api.classify({statusCode:200,body:{code:0,request_id:'synthetic-1'}}).kind,'accepted');
});
test('read receipt rejects wrong principal/resource/payload and never interprets missing as retry permission',async()=>{
 const h=harness();const p=api.normalize(b(),principal);assert.equal((await api.get(b(),principal,h.store)).operation.state,'missing');assert.equal(h.sends,0);
 await api.execute(b(),principal,h);for(const delta of [{actor_sha256:'b'.repeat(64)},{application_id:'456'},{operation_id:token},{request_payload:{...p.request_payload,observacao:'other'}}])assert.throws(()=>api.readReceipt({...h.envelope(),operation:{...h.envelope().operation,...delta}},p),/RECEIPT_INVALID/);
});
test('controller executes in a Code sandbox without require, process or fetch',async()=>{
 const isolated=vm.runInNewContext('('+createController.toString()+')()');
 assert.deepEqual(JSON.parse(JSON.stringify(isolated.normalize(b(),principal))),api.normalize(b(),principal));
 const h=harness();assert.equal((await isolated.execute(b(),principal,h)).status,200);assert.equal(h.sends,1);
});
test('controller crosses the actual SQL boundary with receipt loss and zero repeated effects',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),{SCHEMA,MIGRATION}=require('./tts-manual-decision-postgres.cjs');const db=new PGlite();let effects=0,loseFinish=true;
 try{
  await db.exec(SCHEMA);await db.exec(MIGRATION);await db.exec("UPDATE crm_tts_manual_control_v1 SET enabled=true,eligible_from=clock_timestamp()");await db.exec("INSERT INTO crm_tts_amostra(marca,application_id,status,is_approvable,approve_expira_em,decisao) VALUES('fish','123','PENDING',true,clock_timestamp()+interval '1 day','fila_manual')");
  const store=async(action,p)=>{const q=api.query(action,p);const r=(await db.query(q.sql,q.parameters)).rows[0].result;if(action==='finish'&&loseFinish){loseFinish=false;throw Error('receipt lost');}return r;};
  const dependencies={store,preflight:async()=>true,transport:async()=>{effects++;assert.equal((await api.get(b(),principal,store)).operation.state,'in_flight');return {statusCode:200,body:{code:0,request_id:'synthetic-accepted'}};}};
  assert.equal((await api.execute(b(),principal,dependencies)).status,503);
  assert.equal((await api.get(b(),principal,store)).operation.state,'accepted');
  assert.equal((await api.execute(b(),principal,dependencies)).body.code,'operation_already_reserved');
  assert.equal((await api.execute({...b(),operation_id:token},principal,dependencies)).body.code,'resource_reserved');
  assert.equal((await api.get(b(),{...principal,actor_sha256:'b'.repeat(64)},store)).operation.state,'missing');
  assert.equal(effects,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM crm_tts_coleta_log')).rows[0].n,1);
 }finally{await db.close();}
});
