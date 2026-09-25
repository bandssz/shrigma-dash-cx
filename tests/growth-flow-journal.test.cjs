'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),J=require('../growth-flow-journal.js');
const ID='10000000-0000-4000-8000-000000000001',ID2='10000000-0000-4000-8000-000000000002';
const draft={name:'Carrinho sintético',steps:[]},input={request_payload:{acao:'fluxo_salvar',key:'fish:carrinho',expected_version:2,definition:draft},context:{brand:'fish',name:'Carrinho sintético',baseVersion:2,dirty:true,draft}};
function storage(){const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};}
function locks(){let held=false;return {request:async(k,o,fn)=>{if(held)return fn(null);held=true;try{return await fn({});}finally{held=false;}}};}
function setup({store=storage(),lock=locks(),uuid=()=>ID,endpoint='https://example.invalid/flows'}={}){
 const calls=[],operations=new Map(),api=J.create({storage:store,locks:lock,uuid,endpoint,now:()=>1});
 const lookup=async(id,acao)=>{calls.push('GET');return {status:200,body:{contract:'flow_operation_v1',operation:operations.get(id)||{actor:'fixture',idempotency_key:id,acao,state:'missing',request_payload:null,response:null}}};};
 const transport=async p=>{calls.push('POST');assert.equal(JSON.parse(store.getItem(J.SLOT)).operations.at(-1).phase,'pending');const flow={key:p.key,brand:p.key.split(':')[0],version:p.expected_version+(p.acao==='fluxo_publicar'?0:1),published_version:p.expected_version,draft:p.definition||draft,available_steps:[],enabled:p.enabled};operations.set(p.idempotency_key,{actor:'fixture',idempotency_key:p.idempotency_key,acao:p.acao,state:'completed',request_payload:p,response:{_http:200,_body:{flow,valid:true}}});};
 return {store,lock,calls,operations,api,lookup,transport,run:(x=input,overrides={})=>api.run(x,{lookup,transport,...overrides})};
}
test('durable reservation before one POST; exact GET receipt and local apply unblock',async()=>{const s=setup(),r=await s.run();assert.deepEqual(s.calls,['GET','POST','GET']);assert.equal(r.ok,true);assert.equal(s.api.inspect().blocked,true);await s.api.apply(ID,async()=>true);assert.equal(s.api.inspect().blocked,false);assert.doesNotMatch(s.store.getItem(J.SLOT),/authorization|access_key|"k":/);});
test('timeout, missing receipt and reload cannot create another identity or POST after changing brand/action/endpoint',async()=>{
 const s=setup();await assert.rejects(s.run(input,{transport:async()=>{s.calls.push('POST');throw Error('timeout');}}),{code:'FLOW_UNKNOWN'});
 const reload=setup({store:s.store,lock:s.lock,uuid:()=>ID2,endpoint:'https://other.invalid/flows'});
 const aristo={request_payload:{acao:'fluxo_estado',key:'aristo:carrinho',expected_version:2,enabled:false,confirm:'pausar'},context:{...input.context,brand:'aristo'}};
 for(const x of [input,aristo])await assert.rejects(reload.run(x),{code:'FLOW_PENDING'});
 assert.deepEqual(reload.calls,[]);assert.equal(reload.api.inspect().pending.id,ID);await assert.rejects(reload.api.reconcile(ID,reload.lookup),{code:'FLOW_UNKNOWN'});
});
test('two tabs serialize and a stale tab cannot save over the resolved newer version',async()=>{
 const store=storage(),lock=locks(),a=setup({store,lock}),b=setup({store,lock,uuid:()=>ID2});let release;const barrier=new Promise(r=>release=r);
 const first=a.run(input,{transport:async p=>{await barrier;return a.transport(p);}});await new Promise(r=>setImmediate(r));await assert.rejects(b.run(),{code:'FLOW_BUSY'});release();await first;await a.api.apply(ID,async()=>true);
 await assert.rejects(b.run(),{code:'FLOW_STALE'});assert.equal(b.calls.length,0);
});
test('lost 409/422 response resolves by GET, preserves draft, and allows a corrected request only after apply',async()=>{
 for(const status of [409,422]){const s=setup();const r=await s.run(input,{transport:async p=>{await s.transport(p);s.operations.get(ID).response={_http:status,_body:{erro:status===409?'version_conflict':'validation'}};throw Error('response lost');}});assert.equal(r.status,status);assert.equal(s.api.inspect().pending.context.draft.name,draft.name);await assert.rejects(s.run(),{code:'FLOW_PENDING'});await s.api.apply(ID,async op=>{assert.equal(op.context.dirty,true);return true;});assert.equal(s.api.inspect().pending,null);}
});
test('5xx, malformed success, wrong actor/payload and missing stay unknown even if POST reports success',async()=>{
 for(const mode of ['5xx','version','actor','payload','missing']){const s=setup();await assert.rejects(s.run(input,{transport:async p=>{await s.transport(p);const o=s.operations.get(ID);if(mode==='5xx')o.response._http=500;if(mode==='version')o.response._body.flow.version=99;if(mode==='actor')o.actor='another';if(mode==='payload')o.request_payload={...p,key:'aristo:carrinho'};if(mode==='missing')s.operations.delete(ID);return {status:200};}}),{code:'FLOW_UNKNOWN'});const posts=s.calls.filter(x=>x==='POST').length;await assert.rejects(s.api.reconcile(ID,s.lookup),{code:'FLOW_UNKNOWN'});assert.equal(s.calls.filter(x=>x==='POST').length,posts);}
});
test('storage/locks/preflight fail before POST; terminal write failure keeps pending across reload',async()=>{
 for(const mode of ['read','write','locks','preflight']){const store=storage();if(mode==='read')store.getItem=()=>{throw Error();};if(mode==='write')store.setItem=()=>{throw Error();};const s=setup({store,lock:mode==='locks'?null:locks()});await assert.rejects(s.run(input,mode==='preflight'?{lookup:async()=>({status:403,body:{}})}:{}));assert.equal(s.calls.includes('POST'),false);}
 const store=storage(),set=store.setItem;let writes=0;store.setItem=(k,v)=>{if(++writes>1)throw Error();set(k,v);};const s=setup({store});await assert.rejects(s.run(),{code:'FLOW_STORAGE'});assert.equal(JSON.parse(store.getItem(J.SLOT)).operations[0].phase,'pending');await assert.rejects(setup({store,uuid:()=>ID2}).run(),{code:'FLOW_PENDING'});
});
test('pause/resume requires corresponding confirmation and no credentials are accepted as fields',()=>{
 for(const enabled of [true,false]){const p={acao:'fluxo_estado',key:'fish:carrinho',expected_version:2,enabled};assert.throws(()=>J.request(p),{code:'FLOW_CONFIRM'});assert.equal(J.request({...p,confirm:enabled?'retomar':'pausar'}).enabled,enabled);}
 assert.throws(()=>J.request({...input.request_payload,k:'do-not-store'}));
});
module.exports={storage,locks,setup,input,ID,ID2};
