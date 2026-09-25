'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),J=require('../growth-email-test');
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
function setup({store,locks,mode='accepted',endpoint='https://example.invalid/templates',actor='panel:fixture',key=()=> 'do-not-persist-this-key'}={}){
 const data=new Map();store||={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};let held=false;locks||={request:async(k,o,f)=>{if(held)return f(null);held=true;try{return await f({});}finally{held=false;}}};
 const calls=[],ops=new Map();let seq=0;const client=J.create({endpoint,key,storage:store,locks,crypto:{randomUUID:()=>id(++seq)},fetch:async(url,o)=>{calls.push({url,method:o.method});assert.equal(o.headers.Authorization,'Bearer do-not-persist-this-key');assert.equal(o.redirect,'error');assert.equal(new URL(url).searchParams.has('k'),false);
  if(o.method==='POST'){const p=JSON.parse(o.body);assert.equal(JSON.parse(store.getItem(J.SLOT)).operations.at(-1).phase,'pending');assert.equal(p.k,undefined);const {acao,...payload}=p;if(mode==='missing')throw Error('lost');ops.set(p.idempotency_key,{idempotency_key:p.idempotency_key,actor,state:mode,http_accepted:mode==='accepted',request_payload:payload,request_sha256:'a'.repeat(64),request_hash_schema:'postgres-jsonb-text-sha256-v1',draft_id:p.draft_id,version:p.expected_version,ses:{},...mode==='rejected'?{code:'recipient_opted_out'}:{}});throw Error('POST response lost');}
  const q=new URL(url).searchParams;if(q.get('acao')==='email_teste_previa')return {status:200,json:async()=>({contract:J.CONTRACT,eligible:true})};const identity=q.get('idempotency_key');return {status:200,json:async()=>({contract:J.CONTRACT,operation:ops.get(identity)||{idempotency_key:identity,actor,state:'missing',request_payload:null}})};
 }});return {client,store,locks,calls,ops};
}
const input={draft_id:'d_fixture',expected_version:1,confirm:'enviar_teste'};
test('client persists before one POST and exact lookup resolves a lost acceptance without claiming delivery',async()=>{const s=setup();const r=await s.client.run(input);assert.equal(r.phase,'confirmed');assert.equal(r.operation.http_accepted,true);assert.deepEqual(r.operation.ses,{});assert.deepEqual(s.calls.map(c=>c.method),['GET','POST','GET']);assert.doesNotMatch(s.store.getItem(J.SLOT),/do-not-persist-this-key|Authorization/);await assert.rejects(s.client.run(input),{code:'TEST_ALREADY_ATTEMPTED'});await s.client.reconcile(id(1));assert.equal(s.calls.filter(c=>c.method==='POST').length,1);});
test('unknown receipt survives reload, actor/endpoint change and repeated explicit run without another POST',async()=>{const s=setup({mode:'missing'});await assert.rejects(s.client.run(input),{code:'TEST_UNKNOWN'});const same=setup({store:s.store,locks:s.locks});await assert.rejects(same.client.run(input),{code:'TEST_ALREADY_ATTEMPTED'});await assert.rejects(same.client.reconcile(id(1)),{code:'TEST_UNKNOWN'});const other=setup({store:s.store,endpoint:'https://different.invalid/templates'});await assert.rejects(other.client.reconcile(id(1)),{code:'TEST_ORIGIN'});assert.equal(s.calls.filter(c=>c.method==='POST').length,1);assert.equal(same.calls.filter(c=>c.method==='POST').length,0);});
test('definite refusal stays a refusal and optional SES data never changes HTTP acceptance',async()=>{const s=setup({mode:'rejected'});const r=await s.client.run(input);assert.equal(r.phase,'rejected');assert.equal(r.operation.http_accepted,false);s.ops.get(id(1)).ses={delivery:'2099-01-01T00:00:00Z'};const q=await s.client.reconcile(id(1));assert.equal(q.operation.http_accepted,false);assert.equal(q.phase,'rejected');});
test('storage failure, malformed input or missing Web Locks stop before any POST',async()=>{const s=setup({store:{getItem:()=>null,setItem:()=>{throw Error('quota');}}});await assert.rejects(s.client.run(input),{code:'TEST_STORAGE'});assert.equal(s.calls.filter(c=>c.method==='POST').length,0);for(const extra of [{recipient:'other@example.invalid'},{confirm:'yes'},{cc:['a@b.invalid']}])await assert.rejects(s.client.run({...input,...extra}),{code:'TEST_INPUT'});const t=setup({locks:{}});await assert.rejects(t.client.run(input),{code:'TEST_LOCK'});assert.equal(t.calls.length,0);});
test('current key and endpoint are fixed throughout the in-flight attempt',async()=>{let value='do-not-persist-this-key';const s=setup({key:()=>value});const r=s.client.run(input);value='different';await r;assert.equal(s.calls.filter(c=>c.method==='POST').length,1);});
test('two clients sharing origin lock cannot prepare concurrent POSTs; the loser preserves the winner journal',async()=>{
 let release;const gate=new Promise(r=>release=r);let held=false;
 const locks={request:async(k,o,fn)=>{if(held)return fn(null);held=true;try{await gate;return await fn({});}finally{held=false;}}};
 const a=setup({locks}),b=setup({locks,store:a.store});const pending=a.client.run(input);
 await assert.rejects(b.client.run(input),{code:'TEST_BUSY'});release();await pending;
 assert.equal(a.calls.filter(c=>c.method==='POST').length,1);assert.equal(b.calls.length,0);
 assert.equal(b.client.inspect().operations[0].phase,'confirmed');
});
test('unknown HTTP with matched SES delivery remains distinct; corrupt or mismatched receipt cannot replace a known result',async()=>{
 const s=setup({mode:'outcome_unknown'});assert.equal((await s.client.run(input)).phase,'unknown');
 const op=s.ops.get(id(1));op.ses={delivery:'2099-01-01T00:00:00Z',arbitrary:'ignored'};
 const r=await s.client.reconcile(id(1));assert.equal(r.phase,'confirmed');assert.equal(r.operation.http_accepted,false);assert.deepEqual(r.operation.ses,{delivery:'2099-01-01T00:00:00Z'});
 op.actor='panel:different';await assert.rejects(s.client.reconcile(id(1)),{code:'TEST_UNKNOWN'});assert.equal(s.client.inspect().operations[0].phase,'confirmed');
 op.actor='panel:fixture';op.request_hash_schema='unknown';await assert.rejects(s.client.reconcile(id(1)),{code:'TEST_UNKNOWN'});
 assert.equal(s.calls.filter(c=>c.method==='POST').length,1);
});
test('corrupt journal fails closed before either preflight or POST',async()=>{const s=setup();s.store.setItem(J.SLOT,'{invalid');await assert.rejects(s.client.run(input),{code:'TEST_STORAGE'});assert.equal(s.calls.length,0);assert.equal(s.client.inspect().blocked,true);});
