'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const F=require('./segment-campaign-binding-fixture.cjs'),B=require('../n8n/growth/segment-campaign-binding.cjs'),H=require('../n8n/growth/segment-audience-review.cjs');
async function fixture(t){const db=new PGlite();t.after(()=>db.close());return F.setup(db);}

test('release is append-only, restores legacy lists, and rebind advances the historical version',async t=>{
 const f=await fixture(t);
 for(const [brand,id] of [['fish',100],['aristo',200]]){
  const a=await f.createAudience(brand,'release-'+brand),first=await f.bind((await f.inspect(brand,id,a)).body.intent,'bind-'+brand),binding=first.body.binding;
  const released=await f.release(brand,id,binding,'release-'+brand);assert.equal(released.status,200);assert.equal(released.body.binding,null);assert.equal(released.body.released.binding_version,1);
  assert.equal(released.body.released.release_hash,H.digest(Object.fromEntries(Object.entries(released.body.released).filter(([k])=>k!=='release_hash'))));
  assert.equal((await f.bindingCall({acao:B.ACTIONS.read,brand,campaign_id:id})).body.binding,null);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_release WHERE campaign_id=$1',[id])).rows[0].n,1);
  await assert.rejects(f.db.query('UPDATE crm_audience_v2.campaign_binding_release SET actor=actor WHERE campaign_id=$1',[id]),/SEGMENT_BINDING_RELEASE_IMMUTABLE|AUDIENCE_HISTORY_IMMUTABLE/);
  const next=(await f.inspect(brand,id,a)).body.intent;assert.equal(next.expected_binding_version,1);const rebound=await f.bind(next,'rebind-'+brand);assert.equal(rebound.status,200);assert.equal(rebound.body.binding.binding_version,2);
  assert.equal((await f.db.query('SELECT binding_version FROM crm_audience_v2.campaign_binding_effective($1)',[id])).rows[0].binding_version,2);
  assert.equal((await f.release(brand,id,rebound.body.binding,'release-again-'+brand)).status,200);
  assert.equal((await f.legacySchedule(id)).status,'scheduled');
 }
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_revision')).rows[0].n,4);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_release')).rows[0].n,4);
});

test('release CAS, brand, operator and campaign blockers fail closed with durable receipts',async t=>{
 const f=await fixture(t),a=await f.createAudience(),bound=(await f.bind((await f.inspect('fish',100,a)).body.intent,'block-bind')).body.binding;
 const wrong=await f.release('aristo',100,bound,'wrong-brand');assert.ok([404,409].includes(wrong.status));
 assert.equal((await f.release('fish',100,{...bound,binding_hash:'0'.repeat(64)},'wrong-hash')).body.error,'SEGMENT_BINDING_VERSION_CONFLICT');
 assert.equal((await f.release('fish',100,bound,'reader-release','synthetic-reader-key')).status,403);
 await f.db.query("INSERT INTO shrigma_campaign_operation(actor,operation_key,request_hash,brand,action,state,provider_id) VALUES('fixture','pending-campaign-0001',$1,'fish','agendar','pending',100)",['a'.repeat(64)]);
 const blocked=await f.release('fish',100,bound,'blocked-operation');assert.equal(blocked.status,409);assert.equal(blocked.body.error,'SEGMENT_BINDING_RELEASE_BLOCKED');assert.deepEqual(await f.operation('fish','blocked-operation'),blocked);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_release')).rows[0].n,0);
});

test('a current draft edit and unavailable saved audience do not trap the historical binding',async t=>{
 const f=await fixture(t),a=await f.createAudience(),bound=(await f.bind((await f.inspect('fish',100,a)).body.intent,'stale-bind')).body.binding;
 await f.db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer','100',true)");await tx.query("UPDATE campaigns SET subject=subject||' edited' WHERE id=100");});
 await f.db.query('UPDATE crm_audience_v2.audience SET archived=true WHERE id=$1',[a.id]);
 const current=await f.current(100),xmin=(await f.db.query('SELECT xmin::text AS xmin FROM campaigns WHERE id=100')).rows[0].xmin;assert.notEqual(current.version,bound.campaign_version);
 const released=await f.release('fish',100,bound,'stale-release',undefined,current.version);assert.equal(released.status,200);
 assert.equal(released.body.released.campaign_version,current.version);assert.equal((await f.bindingCall({acao:B.ACTIONS.read,brand:'fish',campaign_id:100})).body.binding,null);
 assert.notEqual((await f.db.query('SELECT xmin::text AS xmin FROM campaigns WHERE id=100')).rows[0].xmin,xmin);
});

test('concurrent release and rebind serialize on one head and never revive the released pin',async t=>{
 const f=await fixture(t),a=await f.createAudience(),bound=(await f.bind((await f.inspect('fish',100,a)).body.intent,'race-bind')).body.binding;
 const intent=(await f.inspect('fish',100,a)).body.intent;
 const [released,rebound]=await Promise.all([f.release('fish',100,bound,'race-release'),f.bind(intent,'race-rebind')]);
 assert.ok([1,2].includes([released.status,rebound.status].filter(x=>x===200).length));
 const effective=(await f.db.query('SELECT binding_version,binding_hash FROM crm_audience_v2.campaign_binding_effective(100)')).rows;
 if(rebound.status===200){assert.equal(effective.length,1);assert.equal(effective[0].binding_version,2);}else{assert.equal(released.status,200);assert.equal(effective.length,0);}
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_revision WHERE campaign_id=100 AND binding_version=1')).rows[0].n,1);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_release WHERE campaign_id=100 AND binding_version=1')).rows[0].n,released.status===200?1:0);
});
