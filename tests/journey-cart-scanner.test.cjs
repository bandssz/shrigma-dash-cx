'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createCartScanner}=require('../n8n/growth/journey-cart-scanner.cjs');
const {patchCollector,collectorHandoff,patchLegacySelector}=require('../n8n/growth/journey-cart-runtime-patch.cjs');
const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const now='2026-01-01T12:00:00.123456Z',ref='2026-01-01T11:30:00.123456Z';
function fixture({enabled=true,sources=[{subscriber_id:1,ref}],due=[],enroll,check}={}){
 const writes=[],queries=[];
 const scanner=createCartScanner({query:async(q,a)=>{queries.push([q,a]);return {rows:q.includes('control_v1')?[{observed_at:now,enabled,starts_at:'2026-01-01T11:00:00Z',template_cache_target:'fixture'}]:q.includes('FROM public.subscribers')?sources:due};},entries:{
  enroll:async(...a)=>{writes.push(['enroll',...a]);return enroll?enroll(...a):{created:true,entry_id:id(a[0]),state:'waiting'};},
  check:async x=>{writes.push(['check',x]);return check?check(x):{entry_id:x,state:'waiting',reason:'due'};},
  claim(){throw Error('Scanner must never claim');},send(){throw Error('Scanner must never send');}
 }});
 return {scanner,writes,queries};
}
test('default dry run reads a bounded deterministic batch with no enrollment/check/claim/transport',async()=>{
 const f=fixture({sources:[{subscriber_id:2,ref},{subscriber_id:1,ref}],due:[{entry_id:id(3),due_at:ref,subscriber_id:3,ref}]});
 const r=await f.scanner.run({sourceIds:[2,1,2]});assert.equal(r.mode,'dry_run');assert.equal(r.sends,0);assert.deepEqual(f.writes,[]);
 assert.deepEqual(r.capture.map(x=>x.subscriber_id),[1,2]);assert.equal(r.capture[0].ref,ref,'do not truncate source microseconds');assert.equal(r.due[0].action,'would_check');
 assert.ok(f.queries.every(([q])=>q.startsWith('SELECT ')));
});
test('capture reconciles sequentially using the same source identity and never sends',async()=>{
 const f=fixture({sources:[{subscriber_id:2,ref},{subscriber_id:1,ref}],due:[{entry_id:id(3),due_at:ref}]});
 const r=await f.scanner.run({mode:'capture',sourceIds:[2,1]});assert.deepEqual(f.writes,[['enroll',1,ref],['enroll',2,ref],['check',id(3)]]);assert.equal(r.sends,0);assert.equal(r.due[0].state,'waiting');
});
test('disabled cohort, future/old/malformed/missing sources cannot enroll',async()=>{
 const disabled=fixture({enabled:false});assert.equal((await disabled.scanner.run({mode:'capture',sourceIds:[1]})).capture[0].action,'cohort_disabled');assert.deepEqual(disabled.writes,[]);
 const f=fixture({sources:[{subscriber_id:1,ref:'bad'},{subscriber_id:2,ref:'2026-01-01T10:00:00Z'},{subscriber_id:3,ref:'2026-01-02T00:00:00Z'}]});
 assert.deepEqual((await f.scanner.run({mode:'capture',sourceIds:[1,2,3,4]})).capture.map(x=>x.action),['source_invalid','outside_cohort','outside_cohort','source_missing']);assert.deepEqual(f.writes,[]);
});
test('uncertain receipt stops writes and does not advance a cursor or try another identity',async()=>{
 for(const enroll of [()=>{throw Error('Lost receipt')},()=>({created:true,reason:'misleading receipt'})]){
  const f=fixture({sources:[{subscriber_id:1,ref},{subscriber_id:2,ref}],due:[{entry_id:id(3),due_at:ref},{entry_id:id(4),due_at:ref}],enroll});
  const r=await f.scanner.run({mode:'capture',sourceIds:[1,2],limit:1});assert.equal(r.stopped,true);assert.equal(r.next_cursor,null);assert.deepEqual(r.capture.map(x=>x.action),['capture_unconfirmed','not_attempted']);assert.equal(r.due[0].action,'not_attempted');assert.equal(f.writes.length,1);
 }
});
test('keyset cursor carries fixed scan time and exact submillisecond timestamp',async()=>{
 const f=fixture({due:[{entry_id:id(1),due_at:ref},{entry_id:id(2),due_at:ref}]});const first=await f.scanner.run({limit:1});
 assert.deepEqual(first.next_cursor,{as_of:now,due_at:ref,entry_id:id(1)});
 await f.scanner.run({limit:1,cursor:first.next_cursor});assert.deepEqual(f.queries.at(-1)[1],[2,now,ref,id(1)]);
});
test('invalid modes, batches and cursor fail before any read',async()=>{
 for(const options of [{mode:'send'},{limit:201},{sourceIds:[0]},{sourceIds:Array(201).fill(1)},{cursor:{as_of:now,due_at:ref,entry_id:'wrong'}}]){
  const f=fixture();await assert.rejects(f.scanner.run(options));assert.deepEqual(f.queries,[]);
 }
});
const workflow=q=>({versionId:'v1',active:true,nodes:[{name:'Upsert Carrinhos (Listmonk PG)',type:'n8n-nodes-base.postgres',parameters:{query:q},credentials:{postgres:{id:'synthetic'}}},{name:'Untouched',type:'fixture',parameters:{value:1}}],connections:{Untouched:{main:[]}}});
const collectorSql="WITH up AS (INSERT INTO subscribers SELECT 1 ON CONFLICT (email) DO UPDATE SET status=status WHERE subscribers.status <> 'blocklisted' RETURNING id, status), base AS (SELECT 1) SELECT (SELECT COUNT(*) FROM up) AS carrinhos_gravados,(SELECT COUNT(*) FROM base) AS novos_na_base_geral;";
test('collector patch changes only the additive receipt and preserves active/config/connections; stale export fails',()=>{
 const w=workflow(collectorSql),p=patchCollector(w,{expectedVersion:'v1'});assert.equal(w.nodes[0].parameters.query,collectorSql);assert.deepEqual({...p,nodes:w.nodes},w);assert.deepEqual(p.nodes[1],w.nodes[1]);assert.deepEqual(p.nodes[0].credentials,w.nodes[0].credentials);
 assert.equal(p.nodes[0].parameters.query.replace(/,\n       COALESCE.*AS journey_source_ids;/,';'),collectorSql);
 assert.throws(()=>patchCollector(w,{expectedVersion:'old'}));assert.throws(()=>patchCollector(p,{expectedVersion:'v1'}));
 assert.deepEqual(collectorHandoff([{carrinhos_gravados:'2',journey_source_ids:[2,1]}],{brand:'fish'}),{sourceIds:[1,2],mode:'dry_run'});
 for(const r of [{carrinhos_gravados:2,journey_source_ids:[1]},{carrinhos_gravados:2,journey_source_ids:[1,1]}])assert.throws(()=>collectorHandoff([r],{brand:'fish'}));
 assert.throws(()=>collectorHandoff([{carrinhos_gravados:0,journey_source_ids:[]}],{brand:'aristo'}));
});
test('selector patch excludes only the initial Fish cohort; other branches are byte-preserved',()=>{
 const q="SELECT cl.cart_at,CASE WHEN x THEN 't05' WHEN y THEN 't1' END FROM cl WHERE cl.toque IS NOT NULL AND active ORDER BY cl.id LIMIT 500;",w=workflow(q);w.nodes[0].name='Elegíveis (PG)';
 const p=patchLegacySelector(w,{expectedVersion:'v1'}).nodes[0].parameters.query;
 assert.equal(p.replace(/\n  AND NOT \(\$2::text='fish'.*\)\)/,'').trim(),q);assert.ok(p.includes("cl.toque='t05'"));assert.throws(()=>patchLegacySelector(w,{expectedVersion:'stale'}));
});
