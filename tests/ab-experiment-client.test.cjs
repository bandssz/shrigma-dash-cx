'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Client=require('../growth-ab-experiment-client.js');
const {setup}=require('./ab-experiment-api-fixture.cjs'),{uuid}=require('./ab-experiment-fixture.cjs');
const copy=v=>JSON.parse(JSON.stringify(v));
async function fixture(){
 const x=await setup();await x.db.exec("UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9',verified_at=now()");
 const saved=new Map(),calls=[];let held=false,n=700,key='manager';
 const locks={async request(name,options,fn){if(held)return fn(null);held=true;try{return await fn({name});}finally{held=false;}}};
 const storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)};
 const f={...x,saved,calls,storage,locks,setKey:k=>{key=k;},afterPost:null,beforeGet:null,transform:null};
 f.fetch=async(url,init)=>{
  assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(new URL(url).searchParams.has('k'),false);
  const data=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams),method=data.method,k=data.k||init.headers['X-AB-Write-Key'];delete data.method;delete data.k;
  calls.push({method:init.method,action:method,key:k});
  if(init.method==='GET'&&f.beforeGet)await f.beforeGet(method);
  const result=await x.api(method,data,k);if(method==='mutate'){assert.equal(JSON.parse(saved.get(Client.SLOT)).operations.at(-1).phase,'pending');if(f.afterPost)await f.afterPost(result);}
  if(f.transform)f.transform(method,result);return {status:result.status,json:async()=>copy(result.body)};
 };
 f.client=(opts={})=>Client.create({endpoint:'https://synthetic.invalid/experiment',brand:'fish',getKey:()=>key,fetch:f.fetch,storage,locks,uuid:()=>uuid(++n),...opts});
 return f;
}
const posts=f=>f.calls.filter(c=>c.method==='POST').length;
test('real SQL API and client preserve the exact receipt before local apply; one POST, no stored keys',async()=>{
 const f=await fixture();try{
  const c=f.client(),p=await f.protocol(),result=await c.mutate(p,p);assert.equal(result.status,200);assert.equal(posts(f),1);assert.equal(c.inspect().pending.phase,'confirmed');
  assert.doesNotMatch(f.saved.get(Client.SLOT),/"manager"|"rotated"|X-AB-Write-Key/);
  await assert.rejects(f.client().mutate({...p,test_id:uuid(2)}, {...p,test_id:uuid(2)}),/Resultado não confirmado/);
  await c.apply(result.operation_id,op=>{f.saved.set('restored-config',JSON.stringify(op.protocol));return true;});assert.equal(c.inspect().pending,null);
  assert.deepEqual((await c.read('get',{test_id:p.test_id})).experiment.protocol,p);assert.equal(posts(f),1);
  assert.deepEqual((await f.db.query('SELECT status FROM campaigns WHERE id IN(100,101) ORDER BY id')).rows.map(c=>c.status),['draft','draft']);
 }finally{await f.db.close();}
});
test('lost response remains durable across reload, another brand/key and endpoint; recovery only GET preserves original identity',async()=>{
 const f=await fixture();try{
  const p=await f.protocol();f.afterPost=()=>{throw Error('lost commit response');};f.transform=(method,r)=>{if(method==='operation'&&r.body.operation.state==='completed')r.body.operation.state='missing';};
  await assert.rejects(f.client().mutate(p,p),/Resultado não confirmado/);assert.equal(posts(f),1);const first=JSON.parse(f.saved.get(Client.SLOT)).operations[0];
  f.setKey('other');await assert.rejects(f.client().reconcile());assert.equal(posts(f),1);
  const q={...p,test_id:uuid(2),brand:'aristo'};await assert.rejects(f.client({brand:'aristo'}).mutate(q,q));
  await assert.rejects(f.client({endpoint:'https://different.invalid/experiment'}).reconcile(),/origem/);assert.equal(posts(f),1);
  f.transform=null;f.setKey('rotated');const result=await f.client().reconcile();assert.equal(result.status,200);assert.equal(result.operation_id,first.id);assert.equal(posts(f),1);
  const op=JSON.parse(f.saved.get(Client.SLOT)).operations[0];assert.equal(op.actor,first.actor);assert.deepEqual(op.request_payload,first.request_payload);
  assert.equal(f.calls.at(-1).action,'operation');
 }finally{await f.db.close();}
});
test('wrong durable actor, payload or version and 5xx never free the browser attempt',async()=>{
 const f=await fixture();try{
  const p=await f.protocol();f.transform=(method,r)=>{if(method==='operation'&&r.body.operation.state==='completed')r.body.operation.response.body.experiment.version=7;};
  await assert.rejects(f.client().mutate(p,p));assert.equal(posts(f),1);
  const cases=[o=>o.actor='panel:'+'b'.repeat(64),o=>o.request_payload.name='changed',o=>o.response.status=503,o=>o.response.body.experiment.protocol.hypothesis='changed'];
  for(const mutate of cases){f.transform=(method,r)=>{if(method==='operation')mutate(r.body.operation);};await assert.rejects(f.client().reconcile());assert.equal(f.client().inspect().pending.phase,'unknown');assert.equal(posts(f),1);}
  f.transform=null;const result=await f.client().reconcile();assert.equal(result.status,200);assert.equal(posts(f),1);
 }finally{await f.db.close();}
});
test('session change, missing durable storage, legacy pending or competing tab prevents any POST',async()=>{
 const f=await fixture();try{
  const p=await f.protocol();f.beforeGet=method=>{if(method==='operation')f.setKey('rotated');};await assert.rejects(f.client().mutate(p,p),/acesso mudou/);assert.equal(posts(f),0);assert.equal(f.saved.has(Client.SLOT),false);
  f.beforeGet=null;f.setKey('manager');await assert.rejects(f.client({storage:{getItem:()=>null,setItem:()=>{throw Error('quota');}}}).mutate(p,p));assert.equal(posts(f),0);
  f.saved.set(Client.LEGACY_SLOT,JSON.stringify({version:1,operations:[{phase:'uncertain'}]}));await assert.rejects(f.client().mutate(p,p));assert.equal(posts(f),0);f.saved.delete(Client.LEGACY_SLOT);
  let release;f.beforeGet=()=>new Promise(r=>{release=r;});const active=f.client().mutate(p,p);await new Promise(r=>setImmediate(r));await assert.rejects(f.client().mutate(p,p),/Outra aba/);f.beforeGet=null;release();assert.equal((await active).status,200);assert.equal(posts(f),1);
 }finally{await f.db.close();}
});
test('journal capacity and corrupted terminal state fail before another request and preserve records',async()=>{
 const f=await fixture();try{
  const p=await f.protocol(),c=f.client(),result=await c.mutate(p,p);await c.apply(result.operation_id,()=>true);
  const j=JSON.parse(f.saved.get(Client.SLOT)),op=j.operations[0];j.operations=Array.from({length:1000},(_,i)=>({...copy(op),id:uuid(10000+i)}));
  f.saved.set(Client.SLOT,JSON.stringify(j));const before=f.saved.get(Client.SLOT),count=f.calls.length;
  await assert.rejects(f.client().mutate(p,p),/limite/);assert.equal(f.calls.length,count);assert.equal(f.saved.get(Client.SLOT),before);assert.equal(f.client().inspect().available,true);
  for(const mutate of [o=>{o.phase='unknown';o.receipt=null;},o=>o.phase='rejected',o=>{o.phase='pending';o.applied=false;}]){
   const corrupted={...j,operations:[copy(op)]};mutate(corrupted.operations[0]);f.saved.set(Client.SLOT,JSON.stringify(corrupted));assert.equal(f.client().inspect().blocked,true);assert.equal(f.client().inspect().available,false);
  }
  assert.equal(f.calls.length,count);
 }finally{await f.db.close();}
});
