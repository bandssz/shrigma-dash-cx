'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {setup,evidence,rule}=require('./segment-shopify-facts-fixture.cjs');
test('completed nightly evidence feeds the existing authenticated counter in both brands and preserves opt-out',async t=>{
 const {db,ingest,enable,count}=await setup(t);
 for(const b of ['fish','aristo'])assert.deepEqual(await ingest(evidence(b)),{status:'ready',replayed:false,customers:2,mapped:2,unresolved:0,authorizes_send:false});
 const off=await count('fish',rule());assert.equal(off.status,422);assert.equal(off.body.error,'SEGMENT_LIST_UNAVAILABLE');
 await enable();
 for(const b of ['fish','aristo']){const r=await count(b,rule());assert.equal(r.status,200);assert.equal(r.body.eligible_count,1);assert.equal(r.body.source_confirmed,true);}
 const date=await count('fish',rule('purchase.last_date','eq','2026-08-31'));assert.equal(date.body.eligible_count,1);
 const money=await count('fish',rule('purchase.amount','gte','125.10'));assert.equal(money.body.eligible_count,1);
 await db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=17");
 const removed=await count('fish',rule());assert.equal(removed.body.eligible_count,0);assert.equal(removed.body.source_confirmed,true);
});
test('identity absence, duplicate addresses, changed UUID and completed empty export never become no purchase',async t=>{
 for(const kind of ['missing','duplicate','uuid','empty']){
  await t.test(kind,async sub=>{const {db,ingest,enable,count}=await setup(sub);
   let rows=kind==='empty'?[]:kind==='missing'?[{id:1,orders:'0'}]:[{id:1,orders:'0'},{id:2,orders:'0'}];
   if(kind==='duplicate')rows.push({id:3,email:'PERSON2@example.test',orders:'4'});
   await ingest(evidence('fish',rows));await enable();
   if(kind==='uuid')await db.exec('UPDATE subscribers SET uuid=gen_random_uuid() WHERE id=2');
   const r=await count('fish',rule());assert.equal(r.body.source_confirmed,false);assert.equal(r.body.eligible_count,null);
  });
 }
});
test('a Customer identity cannot silently move to another native UUID or replace a prior Customer',async t=>{
 const {db,ingest,enable,count}=await setup(t);await ingest(evidence());await enable();
 await db.exec("UPDATE subscribers SET email='replaced@example.test' WHERE id=2;INSERT INTO subscribers(id,status,uuid,email) VALUES(6,'enabled',gen_random_uuid(),'person2@example.test');INSERT INTO subscriber_lists VALUES(6,17,'confirmed')");
 const r=await ingest(evidence('fish',[{id:1,orders:'0'},{id:2,orders:'0'}],'2'));assert.equal(r.unresolved,1);
 assert.equal((await count('fish',rule())).body.eligible_count,null);
 assert.equal((await db.query("SELECT count(*)::integer AS n FROM crm_audience_v2.shopify_identity WHERE brand='fish'")).rows[0].n,2);
});
test('stale source and wrong producer stop confirmed counts; semantic pins cannot be forged',async t=>{
 const {db,ingest,enable,count}=await setup(t);const e=evidence();await ingest(e);await enable();
 const bad=structuredClone(e);bad.query_sha256='f'.repeat(64);await assert.rejects(()=>ingest(bad),/SHOPIFY_INGEST_PRODUCER/);
 await db.exec("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '27 hours'");
 assert.equal((await count('fish',rule())).status,422);
 await db.exec("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '2 minutes';UPDATE crm_audience_v2.shopify_source SET field_hashes='{}'");
 assert.equal((await count('fish',rule())).body.eligible_count,null);
});
test('large Uint64 and decimal facts retain exact database comparisons and replay is immutable',async t=>{
 const {db,ingest,enable,count}=await setup(t);const e=evidence('fish',[{id:1,orders:'18446744073709551615',amount:'9007199254740993.010000000000000001'},{id:2,orders:'0'}]);
 const first=await ingest(e);const second=await ingest(e);assert.equal(first.replayed,false);assert.equal(second.replayed,true);
 await enable();assert.equal((await count('fish',rule('purchase.count','gt',2147483647))).body.eligible_count,1);
 const fact=(await db.query("SELECT orders_count::text AS n,amount_spent::text AS amount FROM crm_audience_v2.shopify_customer_fact WHERE customer_gid='gid://shopify/Customer/1'")).rows[0];
 assert.equal(fact.n,'18446744073709551615');assert.equal(fact.amount,'9007199254740993.010000000000000001');
 e.customers[0].orders_count='0';await assert.rejects(()=>ingest(e),/SHOPIFY_INGEST_REPLAY_CONFLICT/);
});
test('incomplete multi-chunk exports are not current and duplicate chunk replay never finalizes twice',async t=>{
 const {db,ingest}=await setup(t);const rows=Array.from({length:5001},(_,i)=>({id:i+1,orders:'0'}));const e=evidence('fish',rows);
 assert.equal((await ingest(e,0)).status,'staging');assert.equal((await ingest(e,0)).status,'staging');
 assert.equal((await db.query("SELECT current_operation FROM crm_audience_v2.shopify_source WHERE brand='fish'")).rows[0].current_operation,null);
 assert.equal((await ingest(e,1)).status,'ready');assert.equal((await ingest(e,1)).replayed,true);
 assert.equal((await db.query('SELECT count(*)::integer AS n FROM crm_audience_v2.shopify_customer_fact')).rows[0].n,5001);
});
test('international email keeps its evidence but cannot resolve identity or turn into never purchased',async t=>{
 const {db,ingest,enable,count}=await setup(t);const e=evidence('fish',[{id:1,orders:'0'},{id:2,email:'Júlia@example.test',orders:'0'}]);
 const receipt=await ingest(e);assert.equal(receipt.unresolved,1);await enable();
 const row=(await db.query("SELECT identity_state,subscriber_id,subscriber_uuid FROM crm_audience_v2.shopify_customer_fact WHERE customer_gid='gid://shopify/Customer/2'")).rows[0];
 assert.deepEqual(row,{identity_state:'unsupported_email',subscriber_id:null,subscriber_uuid:null});
 const result=await count('fish',rule());assert.equal(result.body.source_confirmed,false);assert.equal(result.body.unknown_reason,'external_source_unavailable');
});
test('even an empty native base cannot confirm a disabled or stale advertised Shopify source',async t=>{
 const {db,ingest,enable,catalog}=await setup(t);await ingest(evidence());await enable();const c=await catalog('fish');
 await db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17;UPDATE crm_audience_v2.shopify_source SET enabled=false WHERE brand='fish'");
 const Counter=require('../n8n/growth/segment-audience-listmonk.cjs'),F=require('./segment-audience-store-fixture.cjs');
 const result=await Counter.countAudience({definition:F.definition('fish',rule()),baseListId:17,catalog:c,query:db.query.bind(db)});
 assert.equal(result.source_confirmed,false);assert.equal(result.eligible_count,null);assert.equal(result.unknown_reason,'external_source_unavailable');
});
test('public snapshot reports observation time accurately and reveals no customer records',async t=>{
 const {db,ingest,enable,catalog}=await setup(t);const e=evidence();await ingest(e);await enable();
 const c=await catalog('fish');assert.equal(c.shopify_snapshot.observed_at,e.observed_at);assert.notEqual(c.shopify_snapshot.observed_at,e.completed_at);
 assert.deepEqual(Object.keys(c.shopify_snapshot).sort(),['current','expires_at','observed_at','started_at']);
 assert.doesNotMatch(JSON.stringify(c),/person1|customer_gid|subscriber_uuid/);
 const Facts=require('../n8n/growth/segment-shopify-facts.cjs'),crypto=require('node:crypto'),fs=require('node:fs');
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../n8n/growth/segment-shopify-customer-bulk.graphql'))).digest('hex'),Facts.QUERY_SHA256);
});

test('an interrupted chunk retry tolerates only a later observation of identical export and keeps first evidence time',async t=>{
 const {db,ingest}=await setup(t);const e=evidence('fish',Array.from({length:5001},(_,i)=>({id:i+1,orders:'0'})));
 assert.equal((await ingest(e,0)).status,'staging');const first=e.observed_at;e.observed_at=new Date().toISOString();
 assert.equal((await ingest(e,0)).replayed,true);assert.equal((await ingest(e,1)).status,'ready');
 const row=(await db.query("SELECT observed_at,provenance FROM crm_audience_v2.shopify_batch WHERE brand='fish'")).rows[0];
 assert.equal(new Date(row.observed_at).toISOString(),first);assert.equal(row.provenance.observed_at,first);
 e.source_sha256='f'.repeat(64);await assert.rejects(()=>ingest(e,0),/SHOPIFY_INGEST_REPLAY_CONFLICT/);
});

test('completing a new source prunes obsolete payloads but preserves source and identity provenance',async t=>{
 const {db,ingest}=await setup(t);await ingest(evidence());
 await db.exec("UPDATE crm_audience_v2.shopify_batch SET started_at=clock_timestamp()-interval '8 days'");
 await ingest(evidence('fish',[{id:1,orders:'0'},{id:2,orders:'2'}],'2'));
 assert.equal((await db.query('SELECT count(*)::integer AS n FROM crm_audience_v2.shopify_customer_fact')).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*)::integer AS n FROM crm_audience_v2.shopify_batch')).rows[0].n,2);
 assert.equal((await db.query("SELECT count(*)::integer AS n FROM crm_audience_v2.shopify_identity WHERE first_operation='gid://shopify/BulkOperation/1'")).rows[0].n,2);
});

test('contradictory Customer zero is unknown while historical order dates may predate the surviving Customer',async t=>{
 const {db,ingest,enable,count}=await setup(t);const e=evidence('fish',[{id:1,orders:'0',amount:'10.00'},{id:2,orders:'1'}]);
 e.customers[1].created_at='2026-09-10T00:00:00Z';await ingest(e);await enable();
 const result=await count('fish',rule());assert.equal(result.body.source_confirmed,false);assert.equal(result.body.eligible_count,null);
 const direct=(await db.query("SELECT crm_audience_v2.shopify_customer_match($1,2,'fish',field_hashes->>'purchase.last_date') AS matched FROM crm_audience_v2.shopify_source WHERE brand='fish'",[JSON.stringify(rule('purchase.last_date','eq','2026-08-31'))])).rows[0];assert.equal(direct.matched,true);
});
