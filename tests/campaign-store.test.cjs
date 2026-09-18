'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createStore}=require('../n8n/growth/campaign-store');
test('SQL parameters isolate untrusted actor and operation key from the query',async()=>{
 let called;
 const claim={id:'one',acquired:true,hash:'a'.repeat(64),lease:'lease'};
 const store=createStore({query:async(sql,params)=>{called={sql,params};return {rows:[{result:claim}]};}});
 const actor="actor'); DELETE FROM campaigns; --";
 assert.deepEqual(await store.claim({actor,key:'test-operation-000001',hash:'a'.repeat(64),brand:'fish',action:'salvar'}),claim);
 assert.equal(called.sql,'SELECT public.shrigma_campaign_store($1::text,$2::jsonb) AS result');
 assert.equal(called.sql.includes(actor),false);
 assert.equal(JSON.parse(called.params[1]).actor,actor);
});
test('missing result and lost database response reject instead of allowing a new mutation',async()=>{
 for(const response of [null,{rows:[]},{rows:[{}]}]){
  const store=createStore({query:async()=>response});
  await assert.rejects(()=>store.claim({}),/unavailable/);
 }
 const store=createStore({query:async()=>{throw Error('timeout');}});
 await assert.rejects(()=>store.finish('id','lease',{state:'succeeded'}),/timeout/);
});
test('operation polling returns the database projection without inventing a result',async()=>{
 const store=createStore({query:async()=>({rows:[{result:null}]})});
 assert.equal(await store.getOperation('actor','test-operation-000001'),null);
});
test('an empty write acknowledgement cannot be reported as a confirmed save',async()=>{
 for(const result of [null,{},false,{ok:false}]){
  const store=createStore({query:async()=>({rows:[{result}]})});
  await assert.rejects(()=>store.finish('id','lease',{state:'succeeded'}),/unconfirmed/);
 }
});
test('finish binds its original identity even if a result contains another lease',async()=>{
 let payload;
 const store=createStore({query:async(sql,params)=>{payload=JSON.parse(params[1]);return {rows:[{result:{ok:true}}]};}});
 await store.finish('original-id','original-lease',{id:'other',lease:'other',state:'rejected',response:{status:422,body:{error:'INVALID'}}});
 assert.equal(payload.id,'original-id');assert.equal(payload.lease,'original-lease');
});
