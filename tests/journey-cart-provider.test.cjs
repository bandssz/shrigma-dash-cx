'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createCartEntryProvider}=require('../n8n/growth/journey-cart-provider.cjs');
const id='11111111-1111-4111-8111-111111111111',dispatch='22222222-2222-4222-8222-222222222222',claim='33333333-3333-4333-8333-333333333333';
const input=()=>({brand:'fish',toque:'t05',piece:'carrinho-30min',subscriber_id:1,ref:'2026-01-01T00:00:00Z',tx:{template_id:60}});
test('adapter only uses fixed bound SQL and does not mutate caller payload',async()=>{
 const calls=[],p=createCartEntryProvider({cacheTarget:'fixture',query:async(q,args)=>{calls.push({q,args});if(q.includes('shrigma_email_claim_cart'))return {rows:[{should_send:false,reason:'journey_paused'}]};if(q.includes('ORDER BY'))return {rows:[]};return {rows:[{result:{state:'waiting'}}]};}}),b=input();
 await p.enroll(1,b.ref);await p.get(id);await p.check(id);await p.due(20);await p.claim(id,b);
 assert.equal(calls.length,5);assert.ok(!Object.hasOwn(b,'journey_entry_id'));assert.equal(JSON.parse(calls[4].args[0]).journey_entry_id,id);
 for(const {q,args} of calls){assert.ok(q.includes('$1'));assert.ok(Array.isArray(args));assert.ok(!q.includes(id));}
 assert.ok(!Object.hasOwn(p,'activate'));assert.ok(!Object.hasOwn(p,'send'));
});
test('invalid source identity, oversized batch, other brand/stage and caller-supplied entry are rejected',async()=>{
 let queries=0;const p=createCartEntryProvider({cacheTarget:'fixture',query:async()=>{queries++;return {rows:[]}}});
 for(const [sid,ref] of [[0,'2026-01-01'],[1,'invalid'],[Number.MAX_SAFE_INTEGER+1,'2026-01-01T00:00:00Z']])assert.throws(()=>p.enroll(sid,ref));
 assert.throws(()=>p.get('bad'));await assert.rejects(p.due(501));
 for(const b of [{...input(),brand:'aristo'},{...input(),toque:'t1'},{...input(),journey_entry_id:id}])await assert.rejects(p.claim(id,b));
 assert.equal(queries,0);
});
test('unconfirmed claim or mismatched durable context cannot become a transport authorization',async()=>{
 const b=input();for(const row of [{should_send:true},{should_send:true,dispatch_id:dispatch,claim_token:claim,payload:{},context:{...b,journey_entry_id:'other'}},{should_send:false}]){
  const p=createCartEntryProvider({cacheTarget:'fixture',query:async()=>({rows:[row]})});await assert.rejects(p.claim(id,b));
 }
 const row={should_send:true,dispatch_id:dispatch,claim_token:claim,payload:{template_id:10},context:{...b,template_id:10,journey_entry_id:id}};
 const entry={state:'reserved',reason:'claimed',transport_state:'in_flight',dispatch_id:dispatch,template_cache_target:'fixture',template_id:10,template_release_id:claim};
 assert.deepEqual(await createCartEntryProvider({cacheTarget:'fixture',query:async q=>({rows:[q.includes('_check_v1')?{result:entry}:row]})}).claim(id,b),row);
 for(const patch of [{reason:'purchase_after_reservation'},{reason:'opt_out_after_reservation'},{transport_state:'outcome_unknown'},{transport_state:'accepted'},{template_id:60},{template_cache_target:'other'},{template_release_id:null},{dispatch_id:claim}])await assert.rejects(createCartEntryProvider({cacheTarget:'fixture',query:async q=>({rows:[q.includes('_check_v1')?{result:{...entry,...patch}}:row]})}).claim(id,b));
});
