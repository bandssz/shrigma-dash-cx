'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Server=require('../growth-ab-server.js'),J=require('../growth-ab-journal.js'),G=require('../growth-data.js');
const {input,uuid,SCHEMA,SQL}=require('./ab-registry-postgres.cjs'),Protocol=require('../n8n/growth/ab-registry.cjs');
const copy=v=>JSON.parse(JSON.stringify(v)),actor='a'.repeat(64),endpoint='https://example.invalid/ab';
const request=(n=1)=>{const p=input(n).request_payload;return {acao:p.acao,teste:p.teste,bracos:p.bracos};};
function fixture(){
 const data=new Map(),receipts=new Map(),records=new Map(),calls=[];let tick=1000,n=0,held=false;
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const locks={async request(k,o,fn){if(held)return fn(null);held=true;try{return await fn({name:k});}finally{held=false;}}};
 const options={endpoint,storage,locks,match:G.registroTesteConfere,receipt:G.reciboTesteValido,serverContract:true,validServer:Server.validServer,uuid:()=>uuid(++n),now:()=>tick};
 const context=()=>({api:{crm_teste:[...records.values()].map(r=>copy(r.teste)),crm_teste_braco:[...records.values()].flatMap(r=>copy(r.bracos))},readProof:{startedAt:tick,completedAt:tick}});
 const state={storage,records,receipts,calls,options,context,client:()=>J.create(options),afterPost:null,alterGet:null,beforeGet:null};
 state.fetch=async(url,init)=>{
  calls.push({url,init});const q=Object.fromEntries(new URL(url).searchParams),key=init.method==='POST'?JSON.parse(init.body).k:init.headers['X-AB-Write-Key'];
  assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.ok(!url.includes('synthetic-write'));
  let result;
  if(init.method==='POST'){
   const saved=JSON.parse(storage.getItem(J.SLOT));assert.equal(saved.operations.at(-1).phase,'pending');assert.doesNotMatch(JSON.stringify(saved),/synthetic-write/);
   const b=JSON.parse(init.body),p=Protocol.request(b,actor),version=p.request_payload.expected_version+1;
   const record={teste:{...p.request_payload.teste,status:p.action==='criar'?'rodando':'inconclusivo',vencedor:null,registry_version:version},bracos:p.action==='criar'?p.request_payload.bracos.map(b=>({...copy(b),teste_id:p.teste_id})):copy(records.get(p.teste_id).bracos)};
   result={status:200,body:{contract:'ab_registry_v1',ok:true,code:'recorded',operation_id:p.operation_id,teste_id:p.teste_id,version,record,gravado_em:'2026-09-20T00:00:00.000Z'}};
   records.set(p.teste_id,record);receipts.set(p.operation_id,{operation_id:p.operation_id,actor_sha256:actor,action:p.action,teste_id:p.teste_id,request_payload:p.request_payload,state:'completed',response:result});
   if(state.afterPost)await state.afterPost(result);
  }else{
   if(state.beforeGet)await state.beforeGet(q);
   if(q.acao==='capacidades')result={status:200,body:{contract:'ab_registry_v1',write:true,operation:true,record:true,causal_engine:false}};
   else if(q.acao==='registro')result={status:200,body:{contract:'ab_registry_record_v1',teste_id:q.teste_id,record:copy(records.get(q.teste_id)||null)}};
   else result={status:200,body:{contract:'ab_registry_operation_v1',operation:copy(receipts.get(q.operation_id)||{operation_id:q.operation_id,actor_sha256:actor,action:q.operacao,teste_id:q.teste_id,state:'missing',request_payload:null,response:null})}};
   if(key==='wrong-write'&&result.body.operation)result.body.operation.actor_sha256='b'.repeat(64);
   if(state.alterGet)result=state.alterGet(q,copy(result));
  }
  return {status:result.status,json:async()=>copy(result.body)};
 };
 state.remote=(key='synthetic-write')=>Server.create({endpoint,key,fetch:state.fetch});
 return state;
}
const posts=f=>f.calls.filter(c=>c.init.method==='POST').length;
test('shared client/server validation rejects invalid bounds before any request or journal reservation',async()=>{
 const bad=[p=>p.teste.nome='x'.repeat(4001),p=>p.teste.hipotese='',p=>p.teste.efeito_minimo=1000001,p=>p.teste.efeito_minimo='1e3',p=>p.teste.marca='unknown',p=>p.teste.canal='sms',p=>p.bracos[0].campanha_id=2147483648,p=>p.bracos[0].campanha_id=true,p=>p.bracos[0].braco='x'.repeat(65),p=>p.bracos[0].utm_term='x'.repeat(257),p=>p.bracos[0].descricao='x'.repeat(4001),p=>p.bracos[1].braco='a',p=>p.bracos=Array.from({length:21},(_,i)=>({...p.bracos[0],braco:String(i)})),p=>p.teste.teste_id=' id '];
 for(const alter of bad){const f=fixture(),p=request();alter(p);await assert.rejects(f.client().run(p,{...f.context(),remote:f.remote()}));assert.equal(f.calls.length,0);assert.equal(f.storage.getItem(J.SLOT),null);}
 const f=fixture();f.records.set('fixture-1',{teste:{teste_id:'fixture-1',status:'rodando',registry_version:1000000000000000},bracos:[]});await assert.rejects(f.client().run({acao:'encerrar',teste:{teste_id:'fixture-1',status:'inconclusivo',vencedor:null,conclusao:'x'}},{...f.context(),remote:f.remote()}));assert.equal(f.calls.length,0);assert.equal(f.storage.getItem(J.SLOT),null);
});
test('one frozen POST follows preflight and durable journal; exact receipt confirms and archives',async()=>{
 const f=fixture(),p=request();p.teste.efeito_minimo='0.5';p.bracos[0].campanha_id='123';const c=f.client();
 assert.equal((await c.run(p,{...f.context(),remote:f.remote()})).phase,'confirmed');assert.equal(posts(f),1);
 assert.deepEqual(f.calls.map(c=>c.init.method),['GET','GET','GET','POST','GET']);const op=c.inspect().operations[0];assert.equal(op.server.payload.teste.efeito_minimo,0.5);assert.equal(op.server.payload.bracos[0].campanha_id,123);assert.equal(op.receipt.version,1);
 await assert.rejects(f.client().run(request(),{...f.context(),remote:f.remote()}),/já foi registrado/);assert.equal(posts(f),1);
});
test('lost POST after server commit recovers only via GET after reload, never by coincidental API rows',async()=>{
 const f=fixture();f.afterPost=()=>{throw Error('lost');};const c=f.client();assert.equal((await c.run(request(),{...f.context(),remote:f.remote()})).phase,'uncertain');
 const reloaded=f.client();assert.equal((await reloaded.reconcile(f.context().api,f.context().readProof)).changed,false);assert.equal(reloaded.inspect().operations[0].phase,'uncertain');
 assert.equal((await reloaded.reconcileRemote(f.remote())).confirmed.length,1);assert.equal(posts(f),1);assert.equal(reloaded.inspect().operations[0].phase,'confirmed');
});
test('missing, running, empty, 401 and mismatched actor/payload/revision stay frozen without POST retry',async()=>{
 const mutations=[(q,r)=>q.acao==='operacao'?{...r,body:{...r.body,operation:{...r.body.operation,state:'missing'}}}:r,(q,r)=>q.acao==='operacao'?{...r,body:{...r.body,operation:{...r.body.operation,state:'running'}}}:r,(q,r)=>q.acao==='operacao'?{status:200,body:{}}:r,(q,r)=>q.acao==='operacao'?{status:401,body:{erro:'chave invalida'}}:r,(q,r)=>{if(q.acao==='operacao')r.body.operation.actor_sha256='b'.repeat(64);return r;},(q,r)=>{if(q.acao==='operacao')r.body.operation.request_payload.teste.nome='other';return r;},(q,r)=>{if(q.acao==='operacao')r.body.operation.response.body.version=2;return r;}];
 for(const alter of mutations){const f=fixture();f.afterPost=()=>{throw Error('lost');};await f.client().run(request(),{...f.context(),remote:f.remote()});f.alterGet=alter;try{await f.client().reconcileRemote(f.remote());}catch{}assert.equal(f.client().inspect().operations[0].phase,'uncertain');await assert.rejects(f.client().run(request(2),{...f.context(),remote:f.remote()}),/aguardando/);assert.equal(posts(f),1);}
});
test('preflight denied authentication and changed form context never reserve or POST',async()=>{
 for(const status of [401,403]){const f=fixture();f.alterGet=()=>({status,body:{}});await assert.rejects(f.client().run(request(),{...f.context(),remote:f.remote()}),e=>e.code==='AB_AUTH_REQUIRED');assert.equal(f.storage.getItem(J.SLOT),null);assert.equal(posts(f),0);}
 const f=fixture();await assert.rejects(f.client().run(request(),{...f.context(),remote:f.remote(),guard:()=>false}),/mudou/);assert.equal(f.storage.getItem(J.SLOT),null);assert.equal(posts(f),0);
});
test('storage failure before POST blocks; failed terminal persistence is never reported confirmed',async()=>{
 const f=fixture();f.storage.setItem=()=>{throw Error('quota');};await assert.rejects(f.client().run(request(),{...f.context(),remote:f.remote()}),/preservar/);assert.equal(posts(f),0);
 const g=fixture(),save=g.storage.setItem;let writes=0;g.storage.setItem=(k,v)=>{if(++writes===3)throw Error('quota');save(k,v);};const result=await g.client().run(request(),{...g.context(),remote:g.remote()});assert.equal(result.phase,'uncertain');assert.equal(g.client().inspect().operations[0].phase,'uncertain');assert.equal(posts(g),1);
});
test('shared Web Lock covers preflight and prevents a second tab from reserving or posting',async()=>{
 const f=fixture();let release;f.beforeGet=()=>new Promise(r=>release=r);const p=f.client().run(request(),{...f.context(),remote:f.remote()});await Promise.resolve();await assert.rejects(f.client().run(request(2),{...f.context(),remote:f.remote()}),/Outra aba/);f.beforeGet=null;release();assert.equal((await p).phase,'confirmed');assert.equal(posts(f),1);
});
test('legacy unknown has no receipt identity, remains blocked after matching API or a new client',async()=>{
 const f=fixture(),old=J.create({...f.options,serverContract:false});await old.run(request(),f.context(),async()=>{throw Error('lost');});f.records.set('fixture-1',{teste:{...request().teste,status:'rodando'},bracos:request().bracos});
 assert.equal((await f.client().reconcile(f.context().api,f.context().readProof)).changed,false);assert.equal((await f.client().reconcileRemote(f.remote())).changed,false);assert.equal(f.calls.length,0);await assert.rejects(f.client().run(request(2),{...f.context(),remote:f.remote()}),/aguardando/);
});
test('CAS close requires fresh explicit revision and exact completed receipt; historical IDs are not rewritten',async()=>{
 const f=fixture(),id='historical:manual/id';f.records.set(id,{teste:{teste_id:id,status:'rodando',registry_version:0},bracos:[]});const req={acao:'encerrar',teste:{teste_id:id,status:'inconclusivo',vencedor:null,conclusao:'Descriptive only'}};
 const stale=f.context();stale.api.crm_teste[0].registry_version=1;await assert.rejects(f.client().run(req,{...stale,remote:f.remote()}),/revisão/);assert.equal(posts(f),0);
 assert.equal((await f.client().run(req,{...f.context(),remote:f.remote()})).phase,'confirmed');assert.equal(posts(f),1);assert.equal(f.client().inspect().operations[0].server.payload.expected_version,0);
});
test('the real shared protocol and PostgreSQL receipt satisfy the browser exact-identity contract',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();await db.exec(SCHEMA);await db.exec(SQL);const f=fixture();let postCount=0;
 const remote=Server.create({endpoint,key:'synthetic-write',fetch:async(url,init)=>{const q=Object.fromEntries(new URL(url).searchParams);let plan;if(init.method==='POST'){postCount++;plan={mode:'write',payload:Protocol.request(JSON.parse(init.body),actor)};assert.equal(f.client().inspect().operations[0].phase,'pending');}else plan=Protocol.read(q,actor);const r=(await db.query('SELECT crm_ab_registry_v1($1,$2::jsonb) AS result',[plan.mode,JSON.stringify(plan.payload)])).rows[0].result;return {status:r.status,json:async()=>r.body};}});
 try{assert.equal((await f.client().run(request(),{...f.context(),remote})).phase,'confirmed');assert.equal(postCount,1);const op=f.client().inspect().operations[0];assert.equal((await remote.lookup(op)).phase,'confirmed');assert.equal(postCount,1);}finally{await db.close();}
});

test('a completed receipt with a contradictory materialized record stays uncertain despite an exact envelope and payload',async()=>{
 const mutations=[r=>r.teste.nome='changed',r=>r.teste.efeito_minimo=2,r=>r.bracos=[],r=>r.bracos[0].campanha_id=42,r=>r.bracos[0].utm_term='other',r=>r.bracos[0].teste_id='other-id',r=>r.bracos[1]={...r.bracos[0]}];
 for(const mutate of mutations){const f=fixture();f.afterPost=()=>{throw Error('lost');};await f.client().run(request(),{...f.context(),remote:f.remote()});mutate(f.receipts.get(uuid(1)).response.body.record);await assert.rejects(f.client().reconcileRemote(f.remote()),/Resultado do recibo indisponível/);assert.equal(f.client().inspect().operations[0].phase,'uncertain');assert.equal(posts(f),1);}
 const f=fixture();f.records.set('historical',{teste:{teste_id:'historical',registry_version:0,status:'rodando'},bracos:[]});f.afterPost=()=>{throw Error('lost');};const p={acao:'encerrar',teste:{teste_id:'historical',status:'inconclusivo',vencedor:null,conclusao:'frozen note'}};await f.client().run(p,{...f.context(),remote:f.remote()});f.receipts.get(uuid(1)).response.body.record.teste.conclusao='another note';await assert.rejects(f.client().reconcileRemote(f.remote()));assert.equal(f.client().inspect().operations[0].phase,'uncertain');assert.equal(posts(f),1);
});
