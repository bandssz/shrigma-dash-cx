'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createTemplateReleaseProvider}=require('../n8n/growth/journey-template-provider.cjs');
const id='11111111-1111-4111-8111-111111111111',claim='22222222-2222-4222-8222-222222222222';
const release=()=>({id,claim_token:claim,state:'creating',cache_target:'fixture',clone_name:'__shrigma_journey_tx_v1_'+id,snapshot:{type:'tx',subject:'Fixture',body:'<p>Fixture {{ .Tx.Data.value }}</p>',body_source:null}});
test('immutable release uses only fixed SQL and native template creation, never tx',async()=>{
 const calls=[],r=release();let posts=0;
 const p=createTemplateReleaseProvider({cacheTarget:'fixture',query:async(q,a)=>{calls.push([q,a]);return {rows:[{result:q.includes('_begin_')?{should_create:true,release:r}:{...r,state:'ready',clone_template_id:10}}]};},nativeCreate:async b=>{posts++;assert.deepEqual(b,{name:r.clone_name,...r.snapshot});return {status:200,body:{data:{id:10,is_default:false,...b}}};}});
 assert.equal((await p.create(id)).state,'ready');assert.equal(posts,1);assert.equal(calls.length,2);
 assert.ok(calls.every(([q])=>q.includes('$1')&&!q.includes(id)));assert.ok(!('send' in p));assert.ok(!('activate' in p));
});
test('empty, false, wrong-content or wrong-identity native receipts cannot mark cache ready',async()=>{
 for(const receipt of [undefined,{status:200,body:null},{status:200,body:{data:true}},{status:200,body:{data:{id:10,is_default:false,name:release().clone_name,...release().snapshot,body:'Other'}}}]){
  let confirms=0;const p=createTemplateReleaseProvider({cacheTarget:'fixture',query:async q=>{if(q.includes('_confirm_'))confirms++;return {rows:[{result:{should_create:true,release:release()}}]};},nativeCreate:async()=>receipt});
  await assert.rejects(p.create(id),/acknowledgement unconfirmed/);assert.equal(confirms,0);
 }
});
test('pending or ready release never repeats native POST; mismatched cache fails before native call',async()=>{
 for(const state of ['creating','ready']){
  let posts=0;const p=createTemplateReleaseProvider({cacheTarget:'fixture',query:async()=>({rows:[{result:{should_create:false,release:{...release(),state}}}]}),nativeCreate:async()=>{posts++}});
  assert.equal((await p.create(id)).created,false);assert.equal(posts,0);
 }
 let posts=0;const p=createTemplateReleaseProvider({cacheTarget:'fixture',query:async()=>({rows:[{result:{should_create:true,release:{...release(),cache_target:'other'}}}]}),nativeCreate:async()=>{posts++}});
 await assert.rejects(p.create(id),/binding unconfirmed/);assert.equal(posts,0);
});
test('invalid release/source cannot reach SQL or native API',async()=>{
 let calls=0;const p=createTemplateReleaseProvider({cacheTarget:'fixture',query:async()=>{calls++},nativeCreate:async()=>{calls++}});
 assert.throws(()=>p.prepare(0));await assert.rejects(p.create('invalid'));assert.equal(calls,0);
 assert.throws(()=>createTemplateReleaseProvider({query:async()=>{},nativeCreate:async()=>{},cacheTarget:''}));
});
