'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite'),F=require('./ab-audience-prepare-fixture.cjs');
const P=require('../n8n/growth/ab-audience-prepare.cjs'),S=require('../n8n/growth/segment-audience-store.cjs'),H=require('../n8n/growth/segment-audience-review.cjs'),Count=require('../n8n/growth/segment-audience-listmonk.cjs');
const init=async t=>{const db=new PGlite();t.after(()=>db.close());return F.setup(db);};
for(const brand of ['fish','aristo'])test(brand+': allocate only the confirmed audience before splitting, with immutable original denominator',async t=>{
 const x=await init(t),a=await x.bindBoth(brand),p=await x.protocol(brand),preview=await x.inspect(p);
 assert.equal(preview._http,200,JSON.stringify(preview));assert.equal(preview._body.authorizes_send,false);assert.equal(preview._body.minimum_reached,true);
 const c=await S.readCatalog(x.db.query.bind(x.db),brand),count=await Count.countAudience({definition:a.definition,baseListId:c.base_list_id,catalog:c.catalog,query:x.db.query.bind(x.db)});
 assert.equal(preview._body.intent.eligible_count,count.eligible_count);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_experiment_v2')).rows[0].n,0);
 const r=await x.prepare(p,preview._body.intent);assert.equal(r._http,201,JSON.stringify(r));assert.equal(r._body.execution_blocked,true);
 const members=await x.members(p.test_id),expected=brand==='fish'?[1,2,3,4]:[1,2,3,4,5];
 assert.deepEqual(members.map(m=>m.subscriber_id),expected);assert.equal(Math.abs(members.filter(m=>m.arm==='a').length-members.filter(m=>m.arm==='b').length)<=1,true);
 assert.equal(r._body.experiment.arms.reduce((n,a)=>n+a.allocated,0),expected.length);
 const before=await x.db.query('SELECT seed FROM crm_ab_experiment_v2 WHERE test_id=$1',[p.test_id]);
 await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=$1",[c.base_list_id]);
 await x.db.query('INSERT INTO subscriber_lists VALUES(9,$1,\'confirmed\')',[brand==='fish'?101:201]);
 assert.deepEqual(await x.members(p.test_id),members);assert.deepEqual(await x.db.query('SELECT seed FROM crm_ab_experiment_v2 WHERE test_id=$1',[p.test_id]),before);
 const measured=(await x.db.query('SELECT crm_ab_measure_v2($1) AS m',[p.test_id])).rows[0].m;
 assert.equal(measured.arms.reduce((n,a)=>n+a.allocated,0),expected.length);assert.equal(measured.integrity.transport_bound,false);assert.equal(measured.integrity.source_complete,false);
 assert.deepEqual((await x.db.query('SELECT DISTINCT status,sent,started_at FROM campaigns WHERE id=ANY($1)',[p.arms.map(a=>a.campaign_id)])).rows,[{status:'draft',sent:0,started_at:null}]);
 assert.doesNotMatch(JSON.stringify(r),/member_ids|subscriber_id|synthetic-manager-key/);
});
test('minimum uses the filtered audience, not the larger native base, and refusal has a durable receipt',async t=>{
 const x=await init(t);await x.bindBoth();const p=await x.protocol('fish',3),review=await x.inspect(p),op=F.uuid(501);
 assert.equal(review._body.intent.eligible_count,4);assert.equal(review._body.minimum_reached,false);
 const r=await x.prepare(p,review._body.intent,op);assert.equal(r._http,422);assert.equal(r._body.error,'AB_AUDIENCE_MINIMUM_NOT_REACHED');assert.deepEqual(await x.operation('fish',op),r);
 for(const table of ['crm_ab_experiment_v2','crm_ab_arm_v2','crm_ab_member_v2','crm_audience_v2.ab_scope'])assert.equal((await x.db.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
});
test('lost ACK recovers the same seed, cohort and receipt; replay never reallocates',async t=>{
 const x=await init(t);await x.bindBoth();const p=await x.protocol(),review=await x.inspect(p),op=F.uuid(502);
 x.control.afterCommit=()=>{throw Error('synthetic lost ACK');};const uncertain=await x.prepare(p,review._body.intent,op);assert.equal(uncertain._http,202);assert.equal(uncertain._body.automatic_retry,false);x.control.afterCommit=null;
 const members=await x.members(p.test_id),r=await x.operation('fish',op);assert.equal(r._http,201);
 assert.deepEqual(await x.prepare(p,review._body.intent,op),r);assert.deepEqual(await x.members(p.test_id),members);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_request')).rows[0].n,1);
 assert.equal((await x.prepare({...p,name:'Different operation'},review._body.intent,op))._http,409);
 assert.equal((await x.call({acao:P.ACTIONS.operation,brand:'fish',operation_id:op},'synthetic-other-key'))._http,404);
});
test('changes to cohort, pins or validity before confirmation do not allocate',async t=>{
 for(const change of ['membership','scope','expired','archived','source']){
  const x=await init(t),a=await x.bindBoth(),p=await x.protocol(),review=await x.inspect(p),intent=structuredClone(review._body.intent);
  if(change==='membership')await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=101 AND subscriber_id=1");
  if(change==='scope')intent.scope_hash='f'.repeat(64);
  if(change==='expired')intent.expires_at='2000-01-01T00:00:00.000Z';
  if(change==='archived')await x.db.query('UPDATE crm_audience_v2.audience SET archived=true WHERE id=$1',[a.id]);
  if(change==='source')await x.db.query("UPDATE crm_audience_v2.config SET enabled=false WHERE brand='fish'");
  const r=await x.prepare(p,intent);assert.ok([409,503].includes(r._http),change+':'+JSON.stringify(r));assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_experiment_v2')).rows[0].n,0);
 }
});
test('external predicates remain unknown even in OR and cannot allocate',async t=>{
 const x=await init(t);await x.bindBoth('fish',{op:'or',rules:[{op:'in_list',list_id:101},{op:'condition',field:'purchase.count',operator:'gt',value:0}]});
 const p=await x.protocol(),r=await x.inspect(p);assert.equal(r._http,503);assert.equal(r._body.error,'AB_AUDIENCE_SOURCE_UNAVAILABLE');assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_experiment_v2')).rows[0].n,0);
});
test('permission loss after resolving and errors after inserting force complete rollback',async t=>{
 for(const stage of ['revoke','receipt','final-clock']){
  const x=await init(t);await x.bindBoth();const p=await x.protocol(),review=await x.inspect(p);let once=false;
  x.control.afterQuery=async(q,v,tx)=>{if(!once&&q===P.SQL.insertExperiment){once=true;
   if(stage==='revoke')await tx.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\"]' WHERE principal_id='manager'");
   if(stage==='receipt')throw Error('synthetic persistence failure');
   if(stage==='final-clock')await tx.query("UPDATE crm_audience_v2.config SET expires_at=clock_timestamp()-interval '1 second' WHERE brand='fish'");
  }};
  const r=await x.prepare(p,review._body.intent);assert.equal(r._http,stage==='revoke'?403:202,JSON.stringify(r));assert.equal(once,true);x.control.afterQuery=null;
  for(const table of ['crm_ab_experiment_v2','crm_ab_arm_v2','crm_ab_member_v2','crm_audience_v2.ab_scope','crm_audience_v2.ab_request'])assert.equal((await x.db.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0,stage+':'+table);
 }
});
test('request boundary rejects client IDs, false protocols and unauthorized actors before allocation',async t=>{
 const x=await init(t);await x.bindBoth();const p=await x.protocol(),review=await x.inspect(p);
 for(const protocol of [null,false,0])assert.equal((await x.call({acao:P.ACTIONS.inspect,brand:'fish',protocol}))._http,400);
 assert.equal((await x.call({acao:P.ACTIONS.inspect,brand:'fish',protocol:p,member_ids:[1,2]}))._http,400);
 for(const key of ['synthetic-reader-key','synthetic-writer-key','synthetic-cx-key'])assert.ok([401,403].includes((await x.call({acao:P.ACTIONS.prepare,brand:'fish',protocol:p,intent:review._body.intent,operation_id:F.uuid(509)},key))._http));
 assert.equal(P.ENABLED,false);assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_experiment_v2')).rows[0].n,0);
});
test('both arms must bind the same audience; a missing or different binding cannot be inferred',async t=>{
 const x=await init(t),first=await x.createAudience('fish','first-arm-audience',{op:'in_list',list_id:101});
 // The composed fixture's inspect is the A/B action; use the binding service
 // explicitly to prepare this deliberately asymmetric pair.
 const B=require('../n8n/growth/segment-campaign-binding.cjs');
 let checked=await x.bindingCall({acao:B.ACTIONS.inspect,brand:'fish',campaign_id:100,audience_id:first.id,audience_revision:first.version});
 assert.equal((await x.bind(checked.body.intent,'asymmetric-bind-a')).status,201);
 let p=await x.protocol();assert.equal((await x.inspect(p))._body.error,'AB_AUDIENCE_BINDING_REQUIRED');
 const second=await x.createAudience('fish','second-arm-audience',{op:'in_list',list_id:17});
 checked=await x.bindingCall({acao:B.ACTIONS.inspect,brand:'fish',campaign_id:101,audience_id:second.id,audience_revision:second.version});assert.equal((await x.bind(checked.body.intent,'asymmetric-bind-b')).status,201);
 p=await x.protocol();assert.equal((await x.inspect(p))._body.error,'AB_AUDIENCE_SCOPE_DIFFERS');
 assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_ab_experiment_v2')).rows[0].n,0);
});
test('arm label order stays explicit when campaign numeric order is reversed',async t=>{
 const x=await init(t);await x.bindBoth();const p=await x.protocol();p.arms=[{...p.arms[1],arm:'a'},{...p.arms[0],arm:'b'}];
 const preview=await x.inspect(p),r=await x.prepare(p,preview._body.intent);assert.equal(r._http,201,JSON.stringify(r));
 assert.deepEqual(r._body.experiment.arms.map(a=>a.campaign_id),[101,100]);assert.deepEqual((await x.members(p.test_id)).map(m=>m.subscriber_id),[1,2,3,4]);
});
