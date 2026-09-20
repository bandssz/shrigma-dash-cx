'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{webcrypto,createHash}=require('node:crypto'),J=require('../growth-template-journal.js');
const ID='10000000-0000-4000-8000-000000000001',ID2='10000000-0000-4000-8000-000000000002';
const content={canal:'email',marca:'fish',idioma:'pt_BR',categoria:'UTILITY',nome:'fixture',peca:'',cabecalho:'',corpo:'Conteúdo sintético',rodape:'',assunto:'Fixture',exemplos:{},botoes:[]};
const input={local_id:'fixture-local',request_payload:{acao:'rascunho',rascunho:content}};
function storage(){const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};}
function locks(){const held=new Set();return {request:async(key,opts,fn)=>{if(held.has(key))return fn(null);held.add(key);try{return await fn({name:key});}finally{held.delete(key);}}};}
function setup({store=storage(),lock=locks(),endpoint='https://example.invalid/templates',legacyPending=()=>false,uuid=()=>ID,persistLocal=async()=>true}={}){
  const calls=[],operations=new Map(),actor='fixture-author';
  const api=J.create({storage:store,locks:lock,endpoint,crypto:webcrypto,uuid,legacyPending,now:()=>1000});
  const lookup=async(id,acao)=>{calls.push('GET');return {status:200,body:{contract:'template_operation_v1',operation:operations.get(id)||{idempotency_key:id,acao,actor,hash_schema:'json-stable-sha256-v1',request_payload:null,request_sha256:null,state:'missing',response:null}}};};
  const transport=async payload=>{
    calls.push('POST');assert.equal(JSON.parse(store.getItem(J.SLOT)).operations.at(-1).phase,'pending');
    const claim='20000000-0000-4000-8000-000000000001',expected=J.payloadFor(payload),body=payload.acao==='rascunho'?{draft_id:payload.draft_id||'fixture-server',version:payload.expected_version?payload.expected_version+1:1,estado:'rascunho'}:payload.acao==='validar'?{draft_id:payload.draft_id,version:payload.expected_version,estado:'validado',erros:[],avisos:[]}:{draft_id:payload.draft_id,estado:'submetido',submission_id:'s_'+claim.replace(/-/g,''),operation_id:claim,provider:'listmonk'};
    operations.set(payload.idempotency_key,{idempotency_key:payload.idempotency_key,acao:payload.acao,actor,claim_id:payload.acao==='submeter'?claim:null,hash_schema:'json-stable-sha256-v1',request_payload:expected,request_sha256:await J.sha256(expected,webcrypto),state:'completed',response:{status:200,body}});
    return {status:200,body};
  };
  return {api,store,lock,calls,operations,actor,lookup,transport,persistLocal,run:(value=input,overrides={})=>api.run(value,{lookup,transport,persistLocal,...overrides})};
}

test('preflight authenticates the actor and durable readback precedes the only POST; archive contains no credential',async()=>{
  const s=setup(),out=await s.run();assert.equal(out.ok,true);assert.deepEqual(s.calls,['GET','POST','GET']);
  const op=s.api.inspect().operations[0];assert.equal(op.phase,'confirmed');assert.equal(op.actor,'fixture-author');assert.equal(op.id,ID);assert.equal(op.request_payload.idempotency_key,undefined);
  assert.equal(op.request_sha256,createHash('sha256').update(J.canonical(op.request_payload)).digest('hex'));
  assert.doesNotMatch(s.store.getItem(J.SLOT),/"k"|authorization|credential|actor_hash/);
});
test('a page death after first creation POST preserves the reservation across reload and changed local identity/payload/action',async()=>{
  const s=setup();await assert.rejects(s.run(input,{transport:async()=>{s.calls.push('POST');throw Error('timeout');}}),{code:'TPL_UNKNOWN'});
  const reload=setup({store:s.store,lock:s.lock,uuid:()=>ID2});
  for(const next of [input,{...input,local_id:'different',request_payload:{acao:'rascunho',rascunho:{...content,nome:'different'}}},{local_id:'other',request_payload:{acao:'validar',draft_id:'other-server',expected_version:3}}])await assert.rejects(reload.run(next),{code:'TPL_PENDING'});
  assert.equal(reload.calls.length,0);assert.equal(reload.api.inspect().operations.length,1);assert.equal(reload.api.inspect().operations[0].id,ID);
});
test('two tabs with different actors/endpoints cannot compete through preflight and POST',async()=>{
  const store=storage(),lock=locks(),a=setup({store,lock}),b=setup({store,lock,endpoint:'https://other.invalid/templates',uuid:()=>ID2});
  let release;const barrier=new Promise(resolve=>{release=resolve;});
  const first=a.run(input,{lookup:async(...args)=>{await barrier;return a.lookup(...args);}});
  await assert.rejects(b.run(),{code:'TPL_BUSY'});assert.equal(b.calls.length,0);release();await first;
  assert.equal(a.calls.filter(x=>x==='POST').length,1);
});
test('missing receipt, pending, unknown and malformed 2xx all remain blocked without POST replay',async()=>{
  for(const state of ['missing','pending','outcome_unknown','legacy_unverifiable','inconsistent','empty']){
    const s=setup();let get=0;
    const lookup=async(id,acao)=>{get++;if(get===1)return s.lookup(id,acao);return state==='empty'?{status:200,body:null}:{status:200,body:{contract:'template_operation_v1',operation:{idempotency_key:id,acao,actor:s.actor,hash_schema:'json-stable-sha256-v1',state}}};};
    await assert.rejects(s.run(input,{lookup,transport:async()=>{s.calls.push('POST');return {status:200,body:null};}}),{code:'TPL_UNKNOWN'});
    await assert.rejects(s.api.reconcile(ID,lookup),{code:'TPL_UNKNOWN'});
    assert.equal(s.calls.filter(x=>x==='POST').length,1);assert.equal(s.api.inspect().operations[0].phase,'unknown');
  }
});
test('a lost HTTP receipt is reconciled only by an exact read-only operation receipt',async()=>{
  const s=setup();const out=await s.run(input,{transport:async payload=>{await s.transport(payload);throw Error('receipt lost');}});
  assert.equal(out.ok,true);const count=s.calls.filter(x=>x==='POST').length;
  assert.equal((await s.api.reconcile(ID,s.lookup)).body.draft_id,'fixture-server');assert.equal(s.calls.filter(x=>x==='POST').length,count);
});
test('wrong request identity, payload, actor, hash, schema or revision cannot confirm',async()=>{
  for(const field of ['idempotency_key','acao','actor','request_payload','request_sha256','hash_schema','version']){
    const s=setup(),value={local_id:'fixture',request_payload:{acao:'validar',draft_id:'fixture-server',expected_version:2}};
    await assert.rejects(s.run(value,{transport:async p=>{await s.transport(p);const r=s.operations.get(ID);
      if(field==='request_payload')r.request_payload={...r.request_payload,expected_version:3};else if(field==='version')r.response.body.version=3;else r[field]='wrong';
    }}),{code:'TPL_UNKNOWN'});assert.equal(s.api.inspect().operations[0].phase,'unknown');
  }
});
test('unavailable locks, storage failure and local-draft persistence failure all stop before POST',async()=>{
  for(const mode of ['locks','read','reserve','readback','local']){
    const store=storage();if(mode==='read')store.getItem=()=>{throw Error();};
    if(mode==='reserve')store.setItem=()=>{throw Error();};
    if(mode==='readback')store.setItem=()=>{};
    const s=setup({store,lock:mode==='locks'?null:locks(),persistLocal:async()=>mode!=='local'});
    await assert.rejects(s.run());assert.equal(s.calls.includes('POST'),false);
  }
});
test('failed terminal persistence leaves the durable pending reservation and no second POST is possible',async()=>{
  const store=storage(),save=store.setItem;let writes=0;store.setItem=(k,v)=>{if(++writes>1)throw Error();save(k,v);};
  const s=setup({store});await assert.rejects(s.run(),{code:'TPL_STORAGE'});
  assert.equal(JSON.parse(store.getItem(J.SLOT)).operations[0].phase,'pending');
  await assert.rejects(s.run(),{code:'TPL_PENDING'});assert.equal(s.calls.filter(x=>x==='POST').length,1);
});
test('legacy pending is never replaced or interpreted as a new operation',async()=>{
  const s=setup({legacyPending:()=>true});await assert.rejects(s.run(),{code:'TPL_LEGACY'});assert.deepEqual(s.calls,[]);assert.equal(s.store.getItem(J.SLOT),null);
});
test('failed preflight including invalid key or missing GET contract does not reserve or post',async()=>{
  for(const response of [{status:401,body:{erro:'invalid_key'}},{status:403,body:{erro:'capability_missing'}},{status:200,body:{}},{status:200,body:{contract:'wrong'}}]){
    const s=setup();await assert.rejects(s.run(input,{lookup:async()=>response}),{code:response.status===401?'TPL_AUTH':'TPL_PREFLIGHT'});assert.equal(s.calls.length,0);assert.equal(s.store.getItem(J.SLOT),null);
  }
});
test('confirmed receipt blocks new writes until applying the local identity is durably acknowledged',async()=>{
  const s=setup();await s.run();assert.equal(s.api.inspect().blocked,true);
  const reload=setup({store:s.store,lock:s.lock,uuid:()=>ID2});await assert.rejects(reload.run(),{code:'TPL_PENDING'});
  await assert.rejects(reload.api.markApplied(ID,async()=>false),{code:'TPL_STORAGE'});assert.equal(reload.api.inspect().blocked,true);
  await reload.api.markApplied(ID,async()=>true);assert.equal(reload.api.inspect().blocked,false);
  await reload.run({...input,local_id:'second-legitimate-draft'});assert.equal(reload.calls.filter(x=>x==='POST').length,1);assert.equal(reload.api.inspect().operations.length,2);
});
test('an older tab cannot replace a locally applied server identity with a second creation',async()=>{
  const s=setup();await s.run();await s.api.markApplied(ID,async()=>true);
  const olderTab=setup({store:s.store,lock:s.lock,uuid:()=>ID2});
  await assert.rejects(olderTab.run(input),{code:'TPL_LOCAL_STALE'});assert.equal(olderTab.calls.length,0);
});
test('completed rejection is archived; generic rejection without an operation receipt stays unknown',async()=>{
  const s=setup();const out=await s.run(input,{transport:async p=>{await s.transport(p);s.operations.get(ID).response={status:422,body:{erros:[{codigo:'fixture_validation'}]}};}});
  assert.equal(out.ok,false);assert.equal(out.status,422);assert.equal(s.api.inspect().operations[0].phase,'rejected');
});
test('payload normalization matches the five backend fields and numeric JSON keys preserve native ordering',async()=>{
  assert.deepEqual(J.payloadFor(input.request_payload),{acao:'rascunho',rascunho:content,draft_id:null,expected_version:null,confirm:null});
  const value={z:{'10':'ten','2':'two',b:'B',a:'A'},a:[2,1]};
  const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  assert.equal(J.canonical(value),JSON.stringify(stable(value)));
  assert.equal(await J.sha256(value,webcrypto),createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'));
});
test('credential properties and malformed journals fail closed',async()=>{
  assert.throws(()=>J.request({...input.request_payload,k:'must-not-persist'}));
  assert.throws(()=>J.request({acao:'rascunho',rascunho:{...content,botoes:[{tipo:'url',texto:'Link',valor:'https://example.invalid',token:'must-not-persist'}]}}));
  const s=setup();s.store.setItem(J.SLOT,'{broken');await assert.rejects(s.run(),{code:'TPL_JOURNAL_INVALID'});assert.equal(s.calls.length,0);
});
