'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),API=require('../growth-journey-graph-api.js');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),hash='a'.repeat(64);
const prepare={action:'prepare',brand:'fish',journey_id:id(10),expected_version:1,review_hash:hash,confirm:'preparar'};
function setup(){
 const values=new Map(),calls=[],receipts=new Map();let seq=20,absent=false,drop=false,actor='panel:manager';
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const fetch=async(url,options)=>{
  const u=new URL(url),p=options.method==='POST'?JSON.parse(options.body):Object.fromEntries(u.searchParams);calls.push({p,method:options.method,url:u.pathname});
  const response=(status,body)=>({status,json:async()=>({contract:API.LIFECYCLE,authorizes_publish:false,authorizes_activate:false,authorizes_enrollment:false,authorizes_send:false,...body})});
  if(p.action==='operation')return receipts.has(p.request_id)?response(200,receipts.get(p.request_id)):response(202,{state:'unconfirmed',request_id:p.request_id,actor,automatic_retry:false});
  if(absent)throw Error('no response');
  const common={request_id:p.request_id,brand:p.brand,journey_id:p.journey_id,base_version:p.expected_version,base_revision:1,prepared_id:p.action==='prepare'?p.request_id:id(20),prepared_hash:hash,release_id:id(70),authorizes_activate:false,authorizes_enrollment:false,authorizes_send:false};
  const receipt=p.action==='prepare'?{...common,contract:'journey_graph_lifecycle_prepare_v1',state:'prepared',review_hash:p.review_hash,revision_reserved:false,authorizes_publish:false}:{...common,contract:'journey_graph_lifecycle_publication_v1',state:'published_paused',version:2,published_revision:2,publication_hash:hash,content_hash:hash,paused:true};
  const result={state:'succeeded',request_id:p.request_id,actor,request_payload:p,receipt};receipts.set(p.request_id,result);if(drop)throw Error('lost ack');return response(200,result);
 };
 const options={endpoint:'https://example.test/draft',lifecycleEndpoint:'https://example.test/lifecycle',key:'synthetic-key',fetch,storage,locks:{request:async(_s,_o,fn)=>fn({})},crypto:{randomUUID:()=>id(seq++)}};
 return {reload:(over={})=>API.create({...options,...over}),calls,values,receipts,absent:x=>absent=x,drop:x=>drop=x,actor:x=>actor=x};
}
test('preparation and publication share the existing draft journal and require durable adoption',async()=>{
 const f=setup(),client=f.reload(),r=await client.run(prepare);assert.equal(r.receipt.state,'prepared');assert.equal(client.inspect().pending.payload.action,'prepare');
 await assert.rejects(client.run({action:'create',brand:'fish',definition:{version:'journey_graph_v1',brand:'fish',nodes:[],edges:[]}}),/sem confirmação/);
 await client.acknowledge(r.receipt.request_id);const pub=await client.run({action:'publish',brand:'fish',journey_id:id(10),expected_version:1,prepared_revision:2,prepared_hash:hash,confirm:'publicar'});
 assert.equal(pub.receipt.state,'published_paused');assert.ok(f.values.has(API.SLOT));assert.doesNotMatch([...f.values.values()].join(''),/synthetic-key/);
 await client.acknowledge(pub.receipt.request_id);assert.equal(f.reload().inspect().pending,null);assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
});
test('lost lifecycle acknowledgement reconciles once; an absent receipt never permits POST replay even when resume is requested',async()=>{
 const f=setup();f.drop(true);assert.equal((await f.reload().run(prepare)).state,'succeeded');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 const g=setup();g.absent(true);const r=await g.reload().run(prepare);assert.equal(r.state,'unconfirmed');g.absent(false);
 assert.equal((await g.reload().recover(r.request_id,{resume:true})).state,'unconfirmed');assert.equal(g.calls.filter(c=>c.method==='POST').length,1);
 g.actor('panel:other');await assert.rejects(g.reload().recover(r.request_id),/sem confirmação/);assert.equal(g.calls.filter(c=>c.method==='POST').length,1);
});
test('altered publication authority, brand, revision and payload cannot clear the durable fence',async()=>{
 for(const mutate of [r=>r.receipt.authorizes_send=true,r=>r.receipt.brand='aristo',r=>r.receipt.base_version=2,r=>r.request_payload.confirm='publicar']){
  const f=setup(),client=f.reload(),r=await client.run(prepare);mutate(f.receipts.get(r.receipt.request_id));await assert.rejects(f.reload().recover(r.receipt.request_id),/sem confirmação/);assert.ok(f.reload().inspect().pending);
 }
 assert.equal(API.validRequest({...prepare,request_id:id(1),prepared_revision:2}),false);
 assert.throws(()=>API.create({endpoint:'https://example.test/draft',lifecycleEndpoint:'https://example.test/lifecycle?key=x'}),/não está disponível/);
});

test('withdrawing lifecycle endpoint still permits only GET recovery at the original durable endpoint',async()=>{
 const f=setup();f.absent(true);const r=await f.reload().run(prepare),before=f.calls.length;
 const retired=f.reload({lifecycleEndpoint:null});assert.equal((await retired.recover(r.request_id,{resume:true})).state,'unconfirmed');
 assert.equal(f.calls.length,before+1);assert.equal(f.calls.at(-1).method,'GET');assert.equal(f.calls.at(-1).url,'/lifecycle');
 await assert.rejects(f.reload({lifecycleEndpoint:'https://different.test/new'}).recover(r.request_id),/origem/);assert.equal(f.calls.length,before+1);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
