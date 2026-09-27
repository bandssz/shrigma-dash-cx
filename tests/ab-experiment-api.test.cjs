'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {uuid}=require('./ab-experiment-fixture.cjs');
const {setup}=require('./ab-experiment-api-fixture.cjs');
test('API is strict Growth panel auth, bounded aggregate reads and activation OFF; never accepts template access',async()=>{
 const x=await setup();try{
  for(const key of ['legacy-template','bad-prefix','other-panel','invalid'])assert.equal((await x.api('capabilities',{brand:'fish'},key)).status,401);
  assert.equal((await x.api('capabilities',{brand:'olivas'})).status,422);
  const caps=(await x.api('capabilities')).body;assert.equal(caps.enabled,false);assert.equal(caps.schedule,false);assert.equal(caps.automatic_send,false);
  assert.equal((await x.api('capabilities',{brand:'fish'},'reader')).body.configure,false);
  const campaigns=(await x.api('campaigns')).body;assert.deepEqual(campaigns.campaigns.map(c=>c.id),[101,100]);assert.equal(campaigns.limit,100);assert.equal(campaigns.recent_only,true);
  assert.doesNotMatch(JSON.stringify(campaigns),/fingerprint|subscriber_id|seed|body_source/);
  const list=(await x.api('list')).body;assert.deepEqual(list.experiments,[]);assert.equal(list.limit,20);assert.equal(list.recent_only,true);
  assert.equal((await x.api('campaigns',{brand:'fish',sql:'untrusted'})).status,422);
 }finally{await x.db.close();}
});
test('API operation reads bind brand/action/actor and recover the exact mutation after key rotation without replay',async()=>{
 const x=await setup();try{
  const oid=uuid(303),op={brand:'fish',operation_id:oid,action:'prepare'};
  const missing=(await x.api('operation',op)).body.operation;assert.equal(missing.state,'missing');assert.match(missing.actor,/^panel:[a-f0-9]{64}$/);
  const p=await x.protocol();await x.db.exec("UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='50a7d13f140674e8e252d1a47a70862f083a20fcaf1a8c771803c589bdb1adb9',verified_at=now()");
  const saved=await x.api('mutate',{brand:'fish',operation_id:oid,request_payload:p});assert.equal(saved.status,200);
  const rotated=(await x.api('operation',op,'rotated')).body.operation;assert.equal(rotated.actor,missing.actor);assert.equal(rotated.state,'completed');assert.deepEqual(rotated.request_payload,p);assert.deepEqual(rotated.response,saved);
  assert.equal((await x.api('operation',op,'other')).body.operation.state,'missing');
  assert.equal((await x.api('operation',{...op,brand:'aristo'})).status,409);assert.equal((await x.api('operation',{...op,action:'cancel'})).status,409);
  const got=(await x.api('get',{brand:'fish',test_id:p.test_id})).body;assert.deepEqual(got.experiment.protocol,p);assert.deepEqual(got.measurement.protocol,p);assert.equal(got.experiment.state,'prepared');
  assert.equal((await x.api('get',{brand:'aristo',test_id:p.test_id})).status,404);assert.equal((await x.api('list')).body.experiments.length,1);
  assert.doesNotMatch(JSON.stringify((await x.db.query('SELECT * FROM crm_ab_action_v2')).rows),/"manager"|"rotated"|panel:synthetic/);
  const blocked=await x.api('mutate',{brand:'aristo',operation_id:uuid(304),request_payload:await x.protocol('aristo',2)},'reader');assert.equal(blocked.status,403);
  assert.equal((await x.api('operation',{brand:'aristo',operation_id:uuid(304),action:'prepare'},'reader')).body.operation.response.status,403);
 }finally{await x.db.close();}
});
