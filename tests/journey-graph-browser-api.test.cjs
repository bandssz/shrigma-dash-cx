'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const API=require('../growth-journey-graph-api.js');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const definition={version:'journey_graph_v1',brand:'fish',name:'Carrinho',nodes:[],edges:[]};
function boot(options={}){
 const values=new Map(),calls=[],ledger=new Map();let counter=1,actor='panel:synthetic',locked=false,drop=false,absent=false,rejection=options.reject?409:0;
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},locks={request:async(k,o,f)=>{if(locked)return f(null);locked=true;try{return await f({});}finally{locked=false;}}};
 const envelope=b=>({contract:API.CONTRACT,authorizes_send:false,authorizes_publish:false,...b});
 const response=(status,b)=>({status,json:async()=>envelope(b)});
 const fetch=async(url,o)=>{const p=o.method==='POST'?JSON.parse(o.body):Object.fromEntries(new URL(url).searchParams);calls.push({p,o});
  if(p.action==='operation')return ledger.has(p.request_id)?response(200,ledger.get(p.request_id)):response(202,{state:'unconfirmed',request_id:p.request_id,actor,retry_same_request_only:true});
  if(o.method==='GET')return response(200,{catalog:{brand:p.brand}});
  if(rejection)return response(rejection,{error:rejection===403?'GRAPH_PERMISSION_REQUIRED':'GRAPH_VERSION_CONFLICT'});
  if(absent)throw Error('never arrived');
  const result={state:'succeeded',request_id:p.request_id,actor,request_payload:p,receipt:{contract:'journey_graph_store_v1',operation_id:p.request_id,journey_id:p.journey_id||id(500),brand:p.brand,version:p.expected_version?p.expected_version+1:1,revision:1,published_revision:null,paused:true,authorizes_send:false}};
  ledger.set(p.request_id,result);if(drop)throw Error('response lost');return response(201,result);
 };
 const deps={endpoint:'https://example.test/graph',key:()=> 'synthetic-key',storage,locks,crypto:{randomUUID:()=>id(counter++)},fetch,...options};
 return {client:API.create(deps),reload:()=>API.create(deps),calls,values,ledger,storage,setActor:x=>actor=x,lose:()=>drop=true,absent:x=>absent=x,reject:x=>rejection=x};
}
test('creates once, requires durable adoption, and never persists the bearer',async()=>{
 const x=boot(),r=await x.client.run({action:'create',brand:'fish',definition});assert.equal(r.state,'succeeded');assert.equal(x.calls.filter(c=>c.o.method==='POST').length,1);
 assert.ok(x.reload().inspect().pending);await assert.rejects(x.reload().run({action:'create',brand:'fish',definition}),/sem confirmação/);
 assert.doesNotMatch([...x.values.values()].join(''),/synthetic-key/);await x.client.acknowledge(r.receipt.operation_id);assert.equal(x.reload().inspect().pending,null);
});
test('lost response is reconciled by GET; no automatic retry',async()=>{
 const x=boot();x.lose();const r=await x.client.run({action:'create',brand:'fish',definition});assert.equal(r.state,'succeeded');assert.equal(x.calls.filter(c=>c.o.method==='POST').length,1);
 assert.equal(x.calls.at(-1).p.action,'operation');
});
test('missing operation survives reload; explicit resume uses exact UUID, payload and actor',async()=>{
 const x=boot();x.absent(true);const r=await x.client.run({action:'create',brand:'fish',definition});assert.equal(r.state,'unconfirmed');
 await x.reload().recover(r.request_id);assert.equal(x.calls.filter(c=>c.o.method==='POST').length,1);x.absent(false);
 const resumed=await x.reload().recover(r.request_id,{resume:true});assert.equal(resumed.state,'succeeded');
 const posts=x.calls.filter(c=>c.o.method==='POST');assert.deepEqual(posts[0].p,posts[1].p);
});
test('actor change, receipt mismatch and endpoint change cannot clear or replay an unknown operation',async()=>{
 const x=boot();x.absent(true);const r=await x.client.run({action:'create',brand:'fish',definition});x.setActor('panel:other');
 await assert.rejects(x.reload().recover(r.request_id,{resume:true}),/sem confirmação/);assert.equal(x.calls.filter(c=>c.o.method==='POST').length,1);
 x.setActor('panel:synthetic');x.absent(false);await x.reload().recover(r.request_id,{resume:true});x.ledger.get(r.request_id).request_payload={...definition};
 await assert.rejects(x.reload().recover(r.request_id),/sem confirmação/);assert.ok(x.reload().inspect().pending);
});
test('definite rejection releases the fence; storage failure prevents POST and corrupt journal blocks',async()=>{
 const x=boot({reject:true});await assert.rejects(x.client.run({action:'create',brand:'fish',definition}),/versão mais recente/);assert.equal(x.client.inspect().pending,null);
 const y=boot({storage:{getItem:()=>null,setItem:()=>{throw Error('quota');}}});await assert.rejects(y.client.run({action:'create',brand:'fish',definition}),/guardar a tentativa/);assert.equal(y.calls.filter(c=>c.o.method==='POST').length,0);
 x.values.set(API.SLOT,'bad');assert.equal(x.reload().inspect().blocked,true);
});
test('concurrent double click only posts once and exact request fields are enforced',async()=>{
 const x=boot();const r=await Promise.allSettled([x.client.run({action:'create',brand:'fish',definition}),x.client.run({action:'create',brand:'fish',definition})]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(x.calls.filter(c=>c.o.method==='POST').length,1);
 await assert.rejects(x.client.run({action:'create',brand:'aristo',definition}),/Confira/);
 await assert.rejects(x.client.run({action:'create',brand:'fish',definition,actor:'invented'}),/Confira/);
});

test('corrupt journal phases and receipts cannot remove the save fence',async()=>{
 const x=boot(),r=await x.client.run({action:'create',brand:'fish',definition});await x.client.acknowledge(r.receipt.operation_id);
 const saved=JSON.parse(x.values.get(API.SLOT));
 const corrupt=[j=>delete j.operations[0].receipt,j=>{j.operations[0].phase='pending';delete j.operations[0].receipt;},j=>j.operations[0].receipt.brand='aristo',j=>j.operations[0].receipt.version=2,j=>j.operations[0].extra='unexpected',j=>j.operations[0].endpoint='https://example.test/graph?key=not-allowed'];
 for(const mutate of corrupt){const j=structuredClone(saved);mutate(j);x.values.set(API.SLOT,JSON.stringify(j));const client=x.reload();assert.equal(client.inspect().blocked,true);await assert.rejects(client.run({action:'create',brand:'fish',definition}),/registro de salvamento/);}
 assert.equal(x.calls.filter(c=>c.o.method==='POST').length,1);
});
test('known confirmation is never downgraded or retried when lookup later returns missing',async()=>{
 const x=boot(),r=await x.client.run({action:'create',brand:'fish',definition});await x.client.acknowledge(r.receipt.operation_id);const saved=x.values.get(API.SLOT);x.ledger.clear();
 await assert.rejects(x.reload().recover(r.receipt.operation_id,{resume:true}),/sem confirmação/);
 assert.equal(x.values.get(API.SLOT),saved);assert.equal(x.calls.filter(c=>c.o.method==='POST').length,1);
});
test('confirmed immutable receipt cannot change to another valid create identity',async()=>{
 const x=boot(),r=await x.client.run({action:'create',brand:'fish',definition}),saved=x.values.get(API.SLOT);x.ledger.get(r.receipt.operation_id).receipt.journey_id=id(501);
 await assert.rejects(x.reload().recover(r.receipt.operation_id),/sem confirmação/);assert.equal(x.values.get(API.SLOT),saved);
});
test('permission or version rejection on an uncertain retry cannot release the original fence',async()=>{
 for(const status of [403,409]){const x=boot();x.absent(true);const r=await x.client.run({action:'create',brand:'fish',definition});x.absent(false);x.reject(status);
 const result=await x.reload().recover(r.request_id,{resume:true});assert.equal(result.state,'unconfirmed');assert.equal(x.reload().inspect().pending.phase,'unknown');
 await assert.rejects(x.reload().run({action:'create',brand:'fish',definition}),/sem confirmação/);assert.equal(x.calls.filter(c=>c.o.method==='POST').length,2);}
});
test('read queries cannot replace selected brand or action, and cross-brand result is refused',async()=>{
 const x=boot();await assert.rejects(x.client.get('catalog','fish',{brand:'aristo'}),/Escolha/);await assert.rejects(x.client.get('catalog','fish',{action:'operation'}),/Escolha/);assert.equal(x.calls.length,0);
 const y=boot({fetch:async()=>({status:200,json:async()=>({contract:API.CONTRACT,authorizes_send:false,authorizes_publish:false,catalog:{brand:'aristo'}})})});await assert.rejects(y.client.get('catalog','fish'),/marca selecionada/);
});
test('two tabs share one lock and preserve the original unresolved attempt',async()=>{
 const x=boot(),other=x.reload();x.absent(true);const results=await Promise.allSettled([x.client.run({action:'create',brand:'fish',definition}),other.run({action:'create',brand:'fish',definition})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(x.calls.filter(c=>c.o.method==='POST').length,1);assert.equal(x.reload().inspect().operations.length,1);
});
test('an observed journal cannot lose or rewind an operation, including applied receipts',async()=>{
 const x=boot(),r=await x.client.run({action:'create',brand:'fish',definition});await x.client.acknowledge(r.receipt.operation_id);const saved=x.values.get(API.SLOT);
 const j=JSON.parse(saved);j.operations[0].applied=false;x.values.set(API.SLOT,JSON.stringify(j));assert.equal(x.client.inspect().blocked,true);
 x.values.set(API.SLOT,JSON.stringify({version:1,operations:[]}));assert.equal(x.client.inspect().blocked,true);
});
test('UTF-8 payload budget is enforced before preflight or POST',async()=>{
 const x=boot();await assert.rejects(x.client.run({action:'create',brand:'fish',definition:{...definition,name:'é'.repeat(100000)}}),/Confira/);assert.equal(x.calls.length,0);
});
