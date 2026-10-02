'use strict';
process.env.CRM_AUDIENCE_SHOPIFY_PRODUCT_SEMANTICS='v2';
// PostgreSQL 17.10 disposable database only. No producer, route or send is run.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Pool}=require('pg');
const {setupRecordedNativeV2}=require('./segment-recorded-origin-fixture.cjs');
const {buildNativePlan}=require('./segment-shopify-rfm-install-fixture.cjs');
const Install=require('../n8n/growth/segment-shopify-rfm-install.cjs');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.RFM_NATIVE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.port!=='55432'||u.pathname!=='/listmonk')
 throw Error('ISOLATED_DATABASE_REQUIRED');
const pool=new Pool({connectionString:uri,max:1,statement_timeout:30000,connectionTimeoutMillis:5000,application_name:'rfm-sealed-install-fixture'});
const db={query:(q,p)=>pool.query(q,p),exec:q=>pool.query(q)};
const raw=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-shopify-rfm.sql'),'utf8');
async function rejected(sql,pattern){
 try{await db.exec(sql);assert.fail('INSTALL_SHOULD_REJECT');}
 catch(e){if(e.message==='INSTALL_SHOULD_REJECT')throw e;assert.match(e.message,pattern);}
 finally{await db.exec('ROLLBACK').catch(()=>{});}
}
async function absent(){
 const row=(await db.query("SELECT to_regclass('crm_audience_v2.rfm_source') IS NULL AS source_absent,to_regclass('crm_audience_v2.rfm_install_receipt') IS NULL AS receipt_absent,NOT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname LIKE 'rfm_%') AS functions_absent")).rows[0];
 assert.deepEqual(row,{source_absent:true,receipt_absent:true,functions_absent:true});
}
async function main(){
 try{
  assert.equal((await db.query("SELECT current_setting('server_version_num') AS version")).rows[0].version,'170010');
  await setupRecordedNativeV2(db);
  await rejected(raw,/RFM_INSTALL_COMPILER_REQUIRED/);
  await absent();

  const plan=await buildNativePlan(db);
  await db.exec('ALTER TABLE crm_audience_v2.shopify_source ENABLE ROW LEVEL SECURITY');
  await rejected(plan.sql,/RFM_INSTALL_METADATA_DRIFT/);
  await absent();
  await db.exec('ALTER TABLE crm_audience_v2.shopify_source DISABLE ROW LEVEL SECURITY');

  // Force a failure after the base schema and functions have been created.
  // The compiled plan has one transaction, so the first half must disappear.
  const anchor='CREATE FUNCTION crm_audience_v2.rfm_catalog(';
  assert.equal(plan.sql.split(anchor).length,2);
  const injected=plan.sql.replace(anchor,"DO $synthetic_failure$ BEGIN RAISE EXCEPTION 'RFM_TEST_SECOND_PHASE'; END $synthetic_failure$;\n"+anchor);
  await rejected(injected,/RFM_TEST_SECOND_PHASE/);
  await absent();

  const fresh=await buildNativePlan(db);
  await db.exec(fresh.sql);
  const receipt=(await db.query(Install.readbackSQL())).rows[0].readback;
  assert.deepEqual(Install.reconcileReadback(fresh,receipt),{state:'committed_off',authorizes_send:false});
  assert.equal((await db.query("SELECT count(*)::integer n FROM crm_audience_v2.rfm_source")).rows[0].n,0);
  const privileges=(await db.query("SELECT has_table_privilege('crm_audience_api','crm_audience_v2.rfm_source','SELECT') AS api_table,has_table_privilege('crm_shopify_sync','crm_audience_v2.rfm_fact','SELECT') AS sync_table,has_table_privilege('crm_audience_api','crm_audience_v2.rfm_install_receipt','SELECT') AS receipt_table,has_function_privilege('crm_audience_api','crm_audience_v2.rfm_snapshot(text)','EXECUTE') AS api_read,has_function_privilege('crm_shopify_sync','crm_audience_v2.rfm_ingest_snapshot(jsonb,jsonb)','EXECUTE') AS sync_ingest,has_function_privilege('crm_audience_api','crm_audience_v2.rfm_ingest_snapshot(jsonb,jsonb)','EXECUTE') AS api_ingest")).rows[0];
  assert.deepEqual(privileges,{api_table:false,sync_table:false,receipt_table:false,api_read:true,sync_ingest:true,api_ingest:false});
  assert.equal((await db.query("SELECT NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='crm_audience_v2'::regnamespace AND p.proname LIKE 'rfm_%' AND a.grantee=0) AS no_public")).rows[0].no_public,true);
  await rejected(fresh.sql,/RFM_INSTALL_METADATA_DRIFT/);
  assert.deepEqual(Install.reconcileReadback(fresh,(await db.query(Install.readbackSQL())).rows[0].readback),{state:'committed_off',authorizes_send:false});
  console.log(JSON.stringify({success:true,postgres:'17.10',raw_refused:true,metadata_drift_refused:true,second_phase_rollback:true,replay_refused:true,readback_committed_off:true,private_acl:true,sources:0,sends:0,production_changed:false}));
 }finally{await pool.end();}
}
main().catch(e=>{process.stderr.write(String(e.message||e)+'\n');process.exitCode=1;});
