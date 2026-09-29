'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const F=require('./ab-audience-regular-fixture.cjs');

test('A/B regular fixture exposes two reviewed drafts per brand while admission remains inspection-only',async t=>{
 const db=new PGlite();t.after(()=>db.close());const x=await F.setup(db,{renewableCatalogBeforeBinding:true});
 assert.equal(x.catalogRenewal.length,2);assert.ok(x.catalogRenewal.every(row=>row.fresh));
 const runtime=await x.workerState();
 assert.equal(runtime.deployment_enabled,true);assert.equal(runtime.suspended,false);assert.equal(runtime.lease_current,true);
 assert.equal(runtime.policies_enabled,true);assert.equal(Number(runtime.delivery_controls),0);
 for(const brand of ['fish','aristo']){
  const prepared=x.cases[brand],inspection=await x.inspectAdmission(prepared);
  assert.equal(inspection.status,200,JSON.stringify(inspection));
  assert.deepEqual(inspection.body.inspection.blockers,['external_material_unconfirmed','execution_path_not_installed']);
  assert.equal(inspection.body.authorizes_send,false);assert.equal(inspection.body.authorizes_selection,false);assert.equal(inspection.body.execution_blocked,true);
  assert.equal(prepared.saved.experiment.state,'prepared');assert.equal(prepared.saved.experiment.transport_bound,false);
  assert.equal(prepared.saved.experiment.arms.length,2);
  const ids=prepared.saved.experiment.arms.map(a=>a.campaign_id);
  const rows=(await db.query('SELECT id,status,sent,started_at FROM campaigns WHERE id=ANY($1) ORDER BY id',[ids])).rows;
  assert.equal(rows.length,2);assert.ok(rows.every(r=>r.status==='draft'&&r.sent===0&&r.started_at===null));
  const bindings=(await db.query('SELECT campaign_id,audience_id,audience_revision FROM crm_audience_v2.campaign_binding WHERE campaign_id=ANY($1) ORDER BY campaign_id',[ids])).rows;
  assert.equal(bindings.length,2);assert.equal(bindings[0].audience_id,bindings[1].audience_id);assert.equal(bindings[0].audience_revision,bindings[1].audience_revision);
 }
});

test('fixture can stop after binding and protocol so the real panel drives prepare and review',async t=>{
 const db=new PGlite();t.after(()=>db.close());const x=await F.setup(db,{prepareCases:false});
 for(const brand of ['fish','aristo']){
  assert.deepEqual(Object.keys(x.cases[brand]).sort(),['audience','protocol']);
  assert.equal(x.cases[brand].protocol.brand,brand);
  assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_scope WHERE test_id=$1',[x.cases[brand].protocol.test_id])).rows[0].n,0);
 }
});
