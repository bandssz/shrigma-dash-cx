'use strict';
process.env.CRM_AUDIENCE_SHOPIFY_PRODUCT_SEMANTICS='v1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Install=require('../n8n/growth/segment-shopify-rfm-install.cjs');
const {componentSql}=require('./segment-shopify-rfm-install-fixture.cjs');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const {setupRecordedComponent}=require('./segment-recorded-origin-fixture.cjs');
const H='a'.repeat(64),ROOT=path.resolve(__dirname,'..');
function snapshot(){
 const relation=(name,columns)=>({name,owner:'postgres',kind:'r',columns:columns.map(name=>({name}))});
 const fn=name=>({name,owner:'postgres',body_sha256:H,config_sha256:H});
 return {
  contract:'crm-rfm-install-snapshot-v1',owner:'postgres',session_owner:'postgres',server_version_num:'170010',
  schemas:[{name:'crm_audience_v2',owner:'postgres'}],
  relations:[
   relation('crm_audience_v2.shopify_source',['brand','shop_id','current_operation','enabled','query_sha256','producer_revision']),
   relation('crm_audience_v2.shopify_identity',['brand','customer_gid','subscriber_id','subscriber_uuid']),
   relation('crm_audience_v2.regular_worker_deployment',['enabled']),
   relation('crm_audience_v2.regular_delivery_campaign',['enabled']),
   relation('public.subscribers',['id','uuid','email'])
  ],
  functions:[
   fn('crm_audience_v2.selection_catalog_valid(jsonb, text)'),
   fn('crm_audience_v2.selection_rule(jsonb, integer, text, integer, jsonb)'),
   fn('crm_audience_v2.selection_regular_rule_match(jsonb, integer[], integer, text)'),
   fn('crm_audience_v2.refresh_native_catalog(text)')
  ],
  triggers:[],policies:[],roles:[
   {name:'crm_audience_api',super:false,bypassrls:false},
   {name:'crm_shopify_sync',super:false,bypassrls:false}
  ],memberships:[],default_acls:[],extensions:[],
  guards:{worker_off:true,delivery_off:true,shopify_sources:[
   {brand:'aristo',shop_id:'gid://shopify/Shop/2',query_sha256:H},
   {brand:'fish',shop_id:'gid://shopify/Shop/1',query_sha256:H}
  ]}
 };
}
function args(s=snapshot()){
 const now=Date.now();
 return {expectedSnapshot:s,expectedSnapshotSha256:Install.sha(Install.canonical(s)),
  pins:Install.sourcePins(),reviewSha256:Install.sha('SYNTHETIC_RFM_REVIEW_ONLY'),
  notBefore:new Date(now-1000).toISOString(),expiresAt:new Date(now+5*60*1000).toISOString()};
}
test('the compiled RFM plan is one transaction and remains OFF',()=>{
 const plan=Install.compile(args());
 assert.equal((plan.sql.match(/^BEGIN;$/gm)||[]).length,1);
 assert.equal((plan.sql.match(/^COMMIT;$/gm)||[]).length,1);
 assert.match(plan.sql,/RFM_INSTALL_METADATA_DRIFT/);
 assert.match(plan.sql,/RFM_INSTALL_PRIVATE_ACCESS/);
 assert.match(plan.sql,/shrigma\.rfm\.install_guard/);
 assert.deepEqual([plan.enabled,plan.authorizes_send],[false,false]);
 assert.equal(plan.sql_sha256,Install.sha(plan.sql));
 const committed={marker:plan.marker,snapshot_sha256:plan.snapshot_sha256,pins_sha256:plan.pins_sha256,
  enabled:false,source_rows:0,batch_rows:0,fact_rows:0,function_count:13};
 assert.deepEqual(Install.reconcileReadback(plan,committed),{state:'committed_off',authorizes_send:false});
 assert.throws(()=>Install.reconcileReadback(plan,{...committed,source_rows:1}),/RFM_INSTALL_READBACK_UNCERTAIN/);
 assert.throws(()=>Install.reconcileReadback(plan,{...committed,marker:'0'.repeat(64)}),/RFM_INSTALL_READBACK_UNCERTAIN/);
});
test('stale baseline, drifted bytes and a long or expired window are refused',()=>{
 const valid=args(),bad=structuredClone(valid);
 bad.expectedSnapshotSha256='0'.repeat(64);
 assert.throws(()=>Install.compile(bad),/RFM_INSTALL_SNAPSHOT_PIN/);
 const changed=structuredClone(valid);
 changed.pins['n8n/growth/segment-shopify-rfm.sql']='0'.repeat(64);
 assert.throws(()=>Install.compile(changed),/RFM_INSTALL_SOURCE_DRIFT/);
 assert.throws(()=>Install.compile({...valid,expiresAt:new Date(Date.now()+11*60*1000).toISOString()}),/RFM_INSTALL_FRESHNESS/);
 assert.equal(Install.validateSnapshot(valid.expectedSnapshot),valid.expectedSnapshotSha256);
});
test('active delivery, pre-existing RFM objects and privileged runtime roles are refused',()=>{
 for(const mutate of [
  s=>{s.guards.worker_off=false;},
  s=>{s.guards.delivery_off=false;},
  s=>{s.relations.push({name:'crm_audience_v2.rfm_source',owner:'postgres',kind:'r',columns:[]});},
  s=>{s.roles[0].bypassrls=true;}
 ]){
  const s=snapshot();mutate(s);
  assert.throws(()=>Install.compile(args(s)),/RFM_INSTALL_(WORKER_ACTIVE|ALREADY_INSTALLED|ROLE_BOUNDARY)/);
 }
});
test('direct SQL requires a compiler marker; only the component fixture removes that boundary',()=>{
 const raw=fs.readFileSync(path.join(ROOT,'n8n/growth/segment-shopify-rfm.sql'),'utf8');
 assert.match(raw,/RFM_INSTALL_COMPILER_REQUIRED/);
 assert.doesNotMatch(componentSql(),/RFM_INSTALL_COMPILER_REQUIRED/);
 assert.equal((raw.match(/^BEGIN;$/gm)||[]).length,2);
});
test('a late failure rolls back the first RFM phase; committed receipt reconciles without replay',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await setupRecordedComponent(db);
 await db.exec('CREATE ROLE crm_shopify_sync NOLOGIN NOINHERIT');
 const raw=fs.readFileSync(path.join(ROOT,'n8n/growth/segment-shopify-rfm.sql'),'utf8');
 await assert.rejects(db.exec(raw),/RFM_INSTALL_COMPILER_REQUIRED/);
 await db.exec('ROLLBACK');
 const actual=(await db.query(Install.snapshotSQL())).rows[0].snapshot;
 const plan=Install.compile(args(actual)),anchor='CREATE FUNCTION crm_audience_v2.rfm_catalog(';
 assert.equal(plan.sql.split(anchor).length,2);
 await assert.rejects(db.exec(plan.sql.replace(anchor,"DO $synthetic_failure$ BEGIN RAISE EXCEPTION 'RFM_TEST_SECOND_PHASE'; END $synthetic_failure$;\n"+anchor)),/RFM_TEST_SECOND_PHASE/);
 await db.exec('ROLLBACK');
 assert.equal((await db.query("SELECT to_regclass('crm_audience_v2.rfm_source') IS NULL AS absent")).rows[0].absent,true);
 await db.exec('ALTER TABLE crm_audience_v2.shopify_source ENABLE ROW LEVEL SECURITY');
 await assert.rejects(db.exec(plan.sql),/RFM_INSTALL_METADATA_DRIFT/);
 await db.exec('ROLLBACK');
 await db.exec('ALTER TABLE crm_audience_v2.shopify_source DISABLE ROW LEVEL SECURITY');
 await db.exec(plan.sql);
 const readback=(await db.query(Install.readbackSQL())).rows[0].readback;
 assert.deepEqual(Install.reconcileReadback(plan,readback),{state:'committed_off',authorizes_send:false});
 await assert.rejects(db.exec(plan.sql),/RFM_INSTALL_METADATA_DRIFT/);
 await db.exec('ROLLBACK');
 assert.deepEqual(Install.reconcileReadback(plan,(await db.query(Install.readbackSQL())).rows[0].readback),{state:'committed_off',authorizes_send:false});
});
