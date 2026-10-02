'use strict';
process.env.CRM_AUDIENCE_SHOPIFY_PRODUCT_SEMANTICS='v1';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const {setupRecordedComponent}=require('./segment-recorded-origin-fixture.cjs');
const Install=require('../n8n/growth/segment-shopify-rfm-install.cjs');
const Rollback=require('../n8n/growth/segment-shopify-rfm-rollback.cjs');
const hash=value=>Install.sha(Install.canonical(value));
const review=Install.sha('SYNTHETIC_RFM_ROLLBACK_REVIEW_ONLY');
async function candidate(t){
 const db=new PGlite();t.after(()=>db.close());
 await setupRecordedComponent(db);await db.exec('CREATE ROLE crm_shopify_sync NOLOGIN NOINHERIT');
 const baseline=(await db.query(Rollback.baselineSQL())).rows[0].baseline,now=Date.now();
 const install=Install.compile({expectedSnapshot:baseline.snapshot,expectedSnapshotSha256:hash(baseline.snapshot),
  pins:Install.sourcePins(),reviewSha256:review,notBefore:new Date(now-1000).toISOString(),expiresAt:new Date(now+5*60*1000).toISOString()});
 await db.exec(install.sql);
 const installedPost=(await db.query(Rollback.postSQL())).rows[0].post,installed=Date.parse(installedPost.installed_at);
 const currentPost=(await db.query(Rollback.postSQL())).rows[0].post;
 const inputs={installPlan:install,baseline,installedPost,currentPost,expectedInstalledPostSha256:hash(installedPost),pins:Rollback.sourcePins(),reviewSha256:review,
  notBefore:new Date(installed).toISOString(),expiresAt:new Date(Date.now()+5*60*1000).toISOString()};
 return {db,install,baseline,installedPost,inputs};
}
test('rollback compiler captures four exact old function definitions and restores only an untouched OFF install',async t=>{
 const c=await candidate(t),plan=Rollback.compile(c.inputs);
 assert.equal(c.baseline.definitions.length,4);
 assert.equal((plan.sql.match(/^BEGIN;$/gm)||[]).length,1);
 assert.equal((plan.sql.match(/^COMMIT;$/gm)||[]).length,1);
 assert.equal((plan.sql.match(/DROP FUNCTION .* RESTRICT;/g)||[]).length,13);
 assert.equal((plan.sql.match(/DROP TABLE .* RESTRICT;/g)||[]).length,4);
 assert.doesNotMatch(plan.sql,/\bCASCADE\b/);
 assert.deepEqual([plan.authorizes_send,plan.sql_sha256],[false,Rollback.sha(plan.sql)]);
 await c.db.exec(plan.sql);
 const readback=(await c.db.query(Rollback.readbackSQL())).rows[0].readback;
 assert.deepEqual(Rollback.reconcileReadback(plan,readback),{state:'rolled_back_off',authorizes_send:false});
 assert.equal((await c.db.query("SELECT to_regclass('crm_audience_v2.rfm_source') IS NULL AS absent")).rows[0].absent,true);
});
test('source drift, metadata drift and RFM writes refuse compilation or execution without deleting history',async t=>{
 const c=await candidate(t),plan=Rollback.compile(c.inputs);
 const badPins=structuredClone(c.inputs);badPins.pins['n8n/growth/segment-shopify-rfm-rollback.cjs']='0'.repeat(64);
 assert.throws(()=>Rollback.compile(badPins),/RFM_ROLLBACK_SOURCE_DRIFT/);
 assert.throws(()=>Rollback.compile({...c.inputs,expectedInstalledPostSha256:'0'.repeat(64)}),/RFM_ROLLBACK_POST_PIN/);
 await c.db.exec('ALTER TABLE crm_audience_v2.rfm_source ADD COLUMN synthetic_drift text');
 const changedPost=(await c.db.query(Rollback.postSQL())).rows[0].post;
 assert.throws(()=>Rollback.compile({...c.inputs,currentPost:changedPost}),/RFM_ROLLBACK_CURRENT_POST_DRIFT/);
 await assert.rejects(c.db.exec(plan.sql),/RFM_ROLLBACK_METADATA_DRIFT/);
 await c.db.exec('ROLLBACK');
 await c.db.exec('ALTER TABLE crm_audience_v2.rfm_source DROP COLUMN synthetic_drift');
 await c.db.exec("UPDATE crm_audience_v2.config SET catalog=jsonb_set(coalesce(catalog,'{}'::jsonb),'{synthetic}',to_jsonb('relationship.rfm'::text)) WHERE brand='fish'");
 await assert.rejects(c.db.exec(plan.sql),/RFM_ROLLBACK_DATA_DRIFT/);
 await c.db.exec('ROLLBACK');
 assert.equal((await c.db.query("SELECT to_regclass('crm_audience_v2.rfm_source') IS NOT NULL AS installed")).rows[0].installed,true);
});
test('written source and external dependent view each prevent rollback without erasing the install',async t=>{
 const c=await candidate(t),plan=Rollback.compile(c.inputs);
 const zeros='0'.repeat(64);
 await c.db.query(`INSERT INTO crm_audience_v2.rfm_source
  (brand,shop_id,customer_query_sha256,paid_orders_query_sha256,workflow_id,producer_revision,algorithm_sha256,source_hash)
  VALUES ('fish','gid://shopify/Shop/1',$1,$1,'synthetic','abcdef0',$1,$1)`,[zeros]);
 await assert.rejects(c.db.exec(plan.sql),/RFM_ROLLBACK_RECEIPT_DRIFT/);
 await c.db.exec('ROLLBACK');
 assert.equal((await c.db.query('SELECT count(*)::integer AS n FROM crm_audience_v2.rfm_source')).rows[0].n,1);
 await c.db.exec("DELETE FROM crm_audience_v2.rfm_source WHERE brand='fish'");
 await c.db.exec('CREATE SCHEMA rfm_rollback_probe');
 await c.db.exec('CREATE VIEW rfm_rollback_probe.source AS SELECT brand FROM crm_audience_v2.rfm_source');
 await assert.rejects(c.db.exec(plan.sql),/depend on it|depends on it|dependent objects still exist/);
 await c.db.exec('ROLLBACK');
 assert.equal((await c.db.query("SELECT to_regclass('crm_audience_v2.rfm_source') IS NOT NULL AS installed")).rows[0].installed,true);
});
