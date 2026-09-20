'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const J=require('../influs-tts-manual.js'),Legacy=require('../influs-tts-actions.js'),C=require('../n8n/tiktok/manual-decision.cjs'),{digest}=require('../n8n/growth/template-operation-receipt.cjs');
const endpoint='https://example.invalid/action',key='synthetic-write-key',input={marca:'fish',application_id:'12345678901234567890',resultado:'APPROVE',motivo_rejeicao:null,observacao:'',autor:'Operador sintético'};
const clone=x=>structuredClone(x),id=x=>({marca:x.marca,application_id:x.application_id});
function storage(){const data=new Map();return {data,get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};}
function locks(){const held=new Set();return {request:async(name,o,fn)=>{assert.equal(o.mode,'exclusive');assert.equal(o.ifAvailable,true);if(held.has(name))return fn(null);held.add(name);try{return await fn({name});}finally{held.delete(name);}}};}
function fixture(options={}){
 const s=options.storage||storage(),l=options.locks||locks(),calls=[],ledger=options.ledger||new Map();let wait;
 const api={write:true,missing:false,lookupError:false,postError:false,mutate:null,...options.api};
 const fetch=async(url,o)=>{
  assert.equal(o.redirect,'error');assert.equal(o.credentials,'omit');assert.equal(o.cache,'no-store');assert.ok(!url.includes(key));const u=new URL(url);calls.push({method:o.method,action:u.searchParams.get('acao'),body:o.body?JSON.parse(o.body):null});
  if(o.method==='GET'){
   assert.equal(o.headers['X-TTS-Write-Key'],options.key||key);
   if(u.searchParams.get('acao')==='capacidades')return {status:200,json:async()=>({contract:'tts_manual_runtime_v1',operation:true,write:api.write,cutover_verified:api.write,admission_verified:api.write})};
   if(api.lookupError)throw Error('synthetic failure');
   const who=digest({scope:'tts-manual-v1',credential:options.key||key}),uuid=u.searchParams.get('operation_id');
   let envelope=api.missing?null:ledger.get(uuid);
   envelope=clone(envelope||{contract:'tts_manual_operation_v1',operation:{operation_id:uuid,actor_sha256:who,marca:u.searchParams.get('marca'),application_id:u.searchParams.get('application_id'),state:'missing',request_payload:null,response:null}});
   if(api.mutate)api.mutate(envelope);return {status:200,json:async()=>envelope};
  }
  const b=JSON.parse(o.body);assert.equal(b.k,key);assert.equal(b.acao,'revisar');
  if(api.postError)throw Error('network '+key);
  const p=C.normalize(b,{actor_sha256:digest({scope:'tts-manual-v1',credential:key}),owner:'synthetic-execution'});
  const response={status:200,body:{ok:true,operation_id:p.operation_id,linhas:[{application_id:p.application_id,decisao:p.request_payload.resultado==='APPROVE'?'manual_aprovada':'manual_rejeitada',status:p.request_payload.resultado==='APPROVE'?'AWAITING_SHIPMENT':'REJECT_CANCELLED'}]}};
  ledger.set(p.operation_id,{contract:'tts_manual_operation_v1',operation:{operation_id:p.operation_id,actor_sha256:p.actor_sha256,marca:p.marca,application_id:p.application_id,state:'accepted',request_payload:p.request_payload,response}});
  if(api.afterPost)await api.afterPost();return {status:response.status,json:async()=>clone(response.body)};
 };
 const j=J.create({storage:s,locks:l,endpoint,fetch,crypto:webcrypto});return {j,s,l,calls,ledger,api,fetch,posts:()=>calls.filter(c=>c.method==='POST')};
}
test('principal uses exactly server canonical UTF-8 SHA256, not operator name',async()=>{
 for(const value of [key,'á😀 e espaços'])assert.equal(await J.actorHash(value,webcrypto),digest({scope:'tts-manual-v1',credential:value}));
 assert.deepEqual(J.normalize(input),C.normalize({acao:'revisar',operation_id:'00000000-0000-4000-8000-000000000000',...input},{actor_sha256:'a'.repeat(64),owner:'fixture'}).request_payload);
});
test('write=false is checked before UUID reservation or POST; no journal is created',async()=>{
 const f=fixture({api:{write:false}});assert.equal((await f.j.capabilities(key)).write,false);
 await assert.rejects(f.j.run(input,key),{code:'TTS_WRITE_CLOSED'});assert.equal(f.s.data.size,0);assert.equal(f.posts().length,0);assert.deepEqual(f.calls.map(c=>c.action),['capacidades','capacidades']);
});
test('durable resource reservations precede the single POST; only exact GET confirms',async()=>{
 const f=fixture();f.api.afterPost=async()=>{assert.equal(f.j.inspect(input).state,'pending');assert.equal(JSON.parse(f.s.getItem(J.LEGACY_PREFIX+'fish:'+input.application_id)).state,'pending');};
 const out=await f.j.run(input,key);assert.equal(out.state,'accepted');assert.equal(f.posts().length,1);assert.equal(f.calls.at(-1).action,'operacao');
 assert.equal(out.request_payload.motivo_rejeicao,null);assert.equal(f.posts()[0].body.observacao,'');assert.doesNotMatch([...f.s.data.values()].join(''),/synthetic-write-key/);
 const legacy=JSON.parse(f.s.getItem(J.LEGACY_PREFIX+'fish:'+input.application_id));assert.equal(legacy.autor,undefined);assert.equal(legacy.request_payload,undefined);
 await assert.rejects(f.j.run({...input,resultado:'REJECT',motivo_rejeicao:'NOT_MATCH'},key),{code:'TTS_DECISION_RECORDED'});assert.equal(f.posts().length,1);
});
test('old v1 tab shares resource lock and compatible reservation, even through another endpoint',async()=>{
 const f=fixture();let began,finish;const started=new Promise(r=>began=r);f.api.afterPost=async()=>{began();await new Promise(r=>finish=r);};
 const p=f.j.run(input,key);await started;
 const old=Legacy.create({storage:f.s,locks:f.l,endpoint:'https://other.invalid/action'});let sends=0;
 await assert.rejects(old.run({brand:'fish',application_id:input.application_id,result:'REJECT'},async()=>{sends++;}),{code:'TTS_OUTCOME_UNKNOWN'});
 finish();await p;await assert.rejects(old.run({brand:'fish',application_id:input.application_id,result:'REJECT'},async()=>{sends++;}),{code:'TTS_OUTCOME_UNKNOWN'});assert.equal(sends,0);
});
test('legacy v1 pending/unknown/confirmed or malformed never gains proof from a current snapshot',async()=>{
 for(const state of ['pending','unknown','confirmed','malformed']){
  const f=fixture();f.s.setItem(J.LEGACY_PREFIX+'fish:'+input.application_id,state==='malformed'?'bad':JSON.stringify({version:1,brand:'fish',application_id:input.application_id,result:'APPROVE',endpoint,state}));
  const before=[...f.s.data];await assert.rejects(f.j.run(input,key));await assert.rejects(f.j.lookup(input,key));assert.deepEqual([...f.s.data],before);assert.equal(f.calls.length,0);
 }
});
test('failure between v1 and v2 persistence blocks old/new tabs, retains UUID and permits GET only',async()=>{
 const f=fixture(),set=f.s.setItem;f.s.setItem=(k,v)=>{if(k.startsWith(J.PREFIX))throw Error('quota');set(k,v);};
 await assert.rejects(f.j.run(input,key),{code:'TTS_JOURNAL_UNAVAILABLE'});assert.equal(f.posts().length,0);
 const partial=f.j.inspect(input);assert.equal(partial.partial,true);assert.match(partial.operation_id,/^[a-f0-9-]+$/);
 const old=Legacy.create({storage:f.s,locks:f.l,endpoint});await assert.rejects(old.run({brand:'fish',application_id:input.application_id,result:'APPROVE'},async()=>{throw Error('never');}),{code:'TTS_OUTCOME_UNKNOWN'});
 f.s.setItem=set;const reload=fixture({storage:f.s});const before=reload.calls.length;assert.equal((await reload.j.lookup(input,key)).state,'unknown');assert.equal(reload.posts().length,0);assert.equal(reload.calls.length,before+1);
 await assert.rejects(reload.j.run(input,key),{code:'TTS_OUTCOME_UNKNOWN'});
});
test('first-slot readback failure or later intent failure never invokes POST and never deletes',async()=>{
 for(const failAt of [1,3]){const f=fixture(),set=f.s.setItem;let n=0;f.s.setItem=(k,v)=>{if(++n===failAt)throw Error('quota');set(k,v);};await assert.rejects(f.j.run(input,key));assert.equal(f.posts().length,0);if(failAt>1)assert.ok(f.s.getItem(J.LEGACY_PREFIX+'fish:'+input.application_id));}
});
test('POST success alone with GET missing remains unknown after reload and never repeats',async()=>{
 const f=fixture();f.api.afterPost=async()=>{f.api.missing=true;};const out=await f.j.run(input,key);assert.equal(out.state,'unknown');assert.equal(f.posts().length,1);
 const again=fixture({storage:f.s,ledger:f.ledger,api:{missing:true}});assert.equal((await again.j.lookup(input,key)).state,'unknown');await assert.rejects(again.j.run(input,key),{code:'TTS_OUTCOME_UNKNOWN'});assert.equal(again.posts().length,0);
 again.api.missing=false;assert.equal((await again.j.lookup(input,key)).state,'accepted');assert.equal(again.posts().length,0);
});
test('network failure and pending states preserve reservation, including another key or endpoint',async()=>{
 const f=fixture({api:{postError:true}});assert.equal((await f.j.run(input,key)).state,'unknown');const previous=f.calls.length;
 await assert.rejects(f.j.lookup(input,'different-key'),{code:'TTS_AUTH_REQUIRED'});assert.equal(f.calls.length,previous);
 const other=J.create({storage:f.s,locks:f.l,endpoint:'https://other.invalid/path',fetch:f.fetch,crypto:webcrypto});await assert.rejects(other.run(input,key));await assert.rejects(other.lookup(input,key),{code:'TTS_ENDPOINT'});assert.equal(f.posts().length,1);
});
test('wrong actor, UUID, resource, decision, payload or status cannot confirm a receipt',async()=>{
 const edits=[o=>o.actor_sha256='f'.repeat(64),o=>o.operation_id='00000000-0000-4000-8000-000000000000',o=>o.marca='aristo',o=>o.application_id='777',o=>o.request_payload.autor='Other',o=>o.response.body.linhas[0].decisao='manual_rejeitada',o=>o.response.status=202];
 for(const edit of edits){const f=fixture();f.api.afterPost=async()=>{f.api.mutate=e=>edit(e.operation);};assert.equal((await f.j.run(input,key)).state,'unknown');assert.notEqual(f.j.inspect(input).state,'accepted');assert.equal(f.posts().length,1);}
});
test('failed terminal storage does not falsely confirm; exact later GET can recover without POST',async()=>{
 const f=fixture(),set=f.s.setItem;f.api.afterPost=async()=>{f.s.setItem=(k,v)=>{if(JSON.parse(v).state==='accepted')throw Error('quota');set(k,v);};};assert.equal((await f.j.run(input,key)).state,'unknown');assert.equal(f.j.inspect(input).state,'unknown');
 f.s.setItem=set;assert.equal((await f.j.lookup(input,key)).state,'accepted');assert.equal(f.posts().length,1);
});
test('terminal receipt cannot be downgraded by missing or stale response',async()=>{
 const f=fixture();await f.j.run(input,key);f.api.missing=true;await assert.rejects(f.j.lookup(input,key),{code:'TTS_RECEIPT'});assert.equal(f.j.inspect(input).state,'accepted');
});
test('invalid payload, unavailable locks and context changed block before reservation/POST',async()=>{
 for(const change of [p=>p.motivo_rejeicao='NOT_MATCH',p=>p.observacao=undefined,p=>p.autor=' ',p=>p.observacao=key]){const f=fixture(),p=clone(input);change(p);await assert.rejects(f.j.run(p,key));assert.equal(f.calls.length,0);assert.equal(f.s.data.size,0);}
 const f=fixture();await assert.rejects(f.j.run(input,key,{guard:()=>false}),{code:'TTS_CONTEXT'});assert.equal(f.posts().length,0);assert.equal(f.s.data.size,0);
 const no=J.create({storage:f.s,locks:null,endpoint,fetch:f.fetch,crypto:webcrypto});await assert.rejects(no.run(input,key),{code:'TTS_WRITE_UNAVAILABLE'});
});


test('unavailable old capability route cannot create a placeholder or POST',async()=>{
 for(const response of [null,{status:404,body:{ok:false}},{status:200,body:{contract:'old',write:true}}]){
  const s=storage(),calls=[];const j=J.create({storage:s,locks:locks(),endpoint,crypto:webcrypto,fetch:async(u,o)=>{calls.push(o.method);if(!response)throw Error('network');return {status:response.status,json:async()=>response.body};}});
  await assert.rejects(j.run(input,key),{code:'TTS_CONTRACT'});assert.deepEqual(calls,['GET']);assert.equal(s.data.size,0);
 }
});

test('local listing recovers current, partial and legacy slots by brand with a minimal safe projection',async()=>{
 const f=fixture();const accepted=await f.j.run(input,key);f.s.setItem('unrelated-secret-setting','never enumerate values');
 const legacy={version:1,brand:'aristo',application_id:'42',result:'REJECT',endpoint,state:'unknown'};f.s.setItem(J.LEGACY_PREFIX+'aristo:42',JSON.stringify(legacy));
 const list=f.j.list();assert.equal(list.length,2);assert.equal(f.j.list({marca:'fish'}).length,1);assert.equal(list.find(x=>x.marca==='fish').operation_id,accepted.operation_id);assert.equal(list.find(x=>x.marca==='aristo').legacy,true);
 assert.ok(list.every(x=>Object.keys(x).every(k=>['marca','application_id','state','operation_id','legacy','partial','message'].includes(k))));assert.doesNotMatch(JSON.stringify(list),/Operador|synthetic-write-key|actor_sha256|request_payload/);
 f.s.data.delete(J.PREFIX+'fish:'+input.application_id);assert.equal(f.j.list({marca:'fish'})[0].state,'blocked','deletion observed in the same page fails closed');assert.equal(fixture({storage:f.s}).j.list({marca:'fish'})[0].partial,true);f.s.setItem(J.LEGACY_PREFIX+'aristo:42','broken');assert.equal(f.j.list({marca:'aristo'})[0].state,'blocked');assert.equal(f.s.getItem(J.LEGACY_PREFIX+'aristo:42'),'broken');
 const keyFn=f.s.key;f.s.key=()=>{throw Error('storage unavailable');};assert.throws(()=>f.j.list(),{code:'TTS_JOURNAL_UNAVAILABLE'});f.s.key=keyFn;
});
