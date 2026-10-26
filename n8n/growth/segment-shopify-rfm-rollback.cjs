'use strict';
// Pure compiler for the narrow, immediate rollback of a committed OFF install.
// No connection, production defaults, credential, producer or scheduler.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const Install=require('./segment-shopify-rfm-install.cjs');
const ROOT=path.resolve(__dirname,'../..'),HASH=/^[a-f0-9]{64}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=Install.canonical;
const literal=value=>"'"+value.replaceAll("'","''")+"'";
const fail=(ok,code)=>{if(!ok)throw Error('RFM_ROLLBACK_'+code);};
const PATCHED=Object.freeze([
 'crm_audience_v2.selection_catalog_valid(jsonb, text)',
 'crm_audience_v2.selection_rule(jsonb, integer, text, integer, jsonb)',
 'crm_audience_v2.selection_regular_rule_match(jsonb, integer[], integer, text)',
 'crm_audience_v2.refresh_native_catalog(text)'
]);
// Reverse dependency order. Each DROP is explicit and RESTRICT; PostgreSQL may
// remove only internal table indexes/constraints, never a caller's object.
const CREATED_FUNCTIONS=Object.freeze([
 'crm_audience_v2.rfm_strip(jsonb)',
 'crm_audience_v2.rfm_catalog(text, jsonb)',
 'crm_audience_v2.rfm_ingest_snapshot(jsonb, jsonb)',
 'crm_audience_v2.rfm_native_subscriber_ids(jsonb, text, integer[], integer, integer, integer)',
 'crm_audience_v2.rfm_native_count(jsonb)',
 'crm_audience_v2.rfm_native_scope(jsonb)',
 'crm_audience_v2.rfm_native_context_fast(jsonb)',
 'crm_audience_v2.rfm_count_for_rule(jsonb, text, integer, text)',
 'crm_audience_v2.rfm_selection_match(jsonb, integer, text, text)',
 'crm_audience_v2.rfm_match(jsonb, integer, text, text)',
 'crm_audience_v2.rfm_source_current(text, text)',
 'crm_audience_v2.rfm_snapshot(text)',
 'crm_audience_v2.rfm_rule_valid(jsonb)'
]);
const CREATED_RELATIONS=Object.freeze([
 'crm_audience_v2.rfm_fact','crm_audience_v2.rfm_batch',
 'crm_audience_v2.rfm_source','crm_audience_v2.rfm_install_receipt'
]);
const CATALOG_LOCKS=['pg_am','pg_amop','pg_amproc','pg_attribute','pg_attrdef','pg_authid','pg_auth_members','pg_class','pg_collation','pg_constraint','pg_default_acl','pg_depend','pg_enum','pg_extension','pg_index','pg_language','pg_namespace','pg_opclass','pg_operator','pg_opfamily','pg_policy','pg_proc','pg_range','pg_rewrite','pg_trigger','pg_type'].map(name=>'pg_catalog.'+name).join(', ');
const DATA_LOCKS=[
 'crm_audience_v2.shopify_source','crm_audience_v2.regular_worker_deployment','crm_audience_v2.regular_delivery_campaign',
 'crm_audience_v2.config','crm_audience_v2.audience','crm_audience_v2.revision','crm_audience_v2.request',
 'public.campaigns',...CREATED_RELATIONS
].join(', ');
const SELF_SHA=sha(fs.readFileSync(__filename));
function sourcePins(){return {...Install.sourcePins(),'n8n/growth/segment-shopify-rfm-rollback.cjs':sha(fs.readFileSync(__filename))};}
function riskSQL(){
 return `SELECT jsonb_build_object(
  'worker_off',NOT EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled),
  'delivery_off',NOT EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled),
  'catalog_rfm',(SELECT count(*) FROM crm_audience_v2.config WHERE catalog::text LIKE '%relationship.rfm%'),
  'audience_rfm',(SELECT count(*) FROM crm_audience_v2.audience WHERE definition::text LIKE '%relationship.rfm%' OR context::text LIKE '%relationship.rfm%'),
  'revision_rfm',(SELECT count(*) FROM crm_audience_v2.revision WHERE definition::text LIKE '%relationship.rfm%' OR context::text LIKE '%relationship.rfm%'),
  'request_rfm',(SELECT count(*) FROM crm_audience_v2.request WHERE payload::text LIKE '%relationship.rfm%' OR response::text LIKE '%relationship.rfm%'),
  'campaign_rfm',(SELECT count(*) FROM public.campaigns WHERE attribs::text LIKE '%relationship.rfm%')) AS risk`;
}
function baselineSQL(){
 const identities=PATCHED.map(name=>literal(name)+'::regprocedure').join(',');
 return `SELECT jsonb_build_object('contract','crm-rfm-rollback-baseline-v1','snapshot',s.snapshot,'risk',r.risk,
  'definitions',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')','definition',pg_get_functiondef(p.oid)) ORDER BY p.proname),'[]'::jsonb)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid IN(${identities}))) AS baseline
  FROM (${Install.snapshotSQL()}) s CROSS JOIN (${riskSQL()}) r`;
}
function postSQL(){
 return `SELECT jsonb_build_object('contract','crm-rfm-rollback-post-v1','snapshot',s.snapshot,'risk',r.risk,
  'readback',b.readback,'receipt_rows',i.n,'installed_at',i.installed_at,'captured_at',clock_timestamp()) AS post
  FROM (${Install.snapshotSQL()}) s CROSS JOIN (${riskSQL()}) r CROSS JOIN (${Install.readbackSQL()}) b
   CROSS JOIN (SELECT count(*)::integer n,min(installed_at) installed_at FROM crm_audience_v2.rfm_install_receipt) i`;
}
function readbackSQL(){
 const absent=CREATED_RELATIONS.map(name=>`to_regclass(${literal(name)}) IS NULL`).join(' AND ');
 return `SELECT jsonb_build_object('snapshot',s.snapshot,'risk',r.risk,'objects_absent',(${absent})
  AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname LIKE 'rfm_%')) AS readback
  FROM (${Install.snapshotSQL()}) s CROSS JOIN (${riskSQL()}) r`;
}
function safeRisk(value){
 return value&&value.worker_off===true&&value.delivery_off===true&&
  ['catalog_rfm','audience_rfm','revision_rfm','request_rfm','campaign_rfm'].every(key=>Number.isInteger(value[key])&&value[key]===0);
}
function validateBaseline(value,installPlan){
 fail(value&&value.contract==='crm-rfm-rollback-baseline-v1'&&value.snapshot&&Array.isArray(value.definitions),'BASELINE_SHAPE');
 fail(Install.validateSnapshot(value.snapshot)===installPlan.snapshot_sha256,'BASELINE_PIN');
 fail(safeRisk(value.risk),'BASELINE_RFM_USAGE');
 const byName=new Map(value.snapshot.functions.map(item=>[item.name,item]));
 fail(value.definitions.length===PATCHED.length&&new Set(value.definitions.map(item=>item.name)).size===PATCHED.length,'DEFINITIONS');
 for(const name of PATCHED){
  const definition=value.definitions.find(item=>item.name===name)?.definition;
  fail(typeof definition==='string'&&definition.startsWith('CREATE OR REPLACE FUNCTION ')&&
    definition.length<=300000&&sha(definition)===byName.get(name)?.body_sha256,'DEFINITIONS');
 }
 return sha(canonical(value));
}
function validatePost(value,baseline,installPlan,expectedSha256){
 fail(value&&value.contract==='crm-rfm-rollback-post-v1'&&value.snapshot&&value.receipt_rows===1&&
  HASH.test(expectedSha256||'')&&sha(canonical(value))===expectedSha256,'POST_PIN');
 const installed=Date.parse(value.installed_at),captured=Date.parse(value.captured_at);
 fail(Number.isFinite(installed)&&Number.isFinite(captured)&&captured>=installed&&captured-installed<=120000,'POST_NOT_SEALED_AT_INSTALL');
 fail(safeRisk(value.risk),'POST_RFM_USAGE');
 Install.reconcileReadback(installPlan,value.readback);
 const before=baseline.snapshot,after=value.snapshot;
 fail(after.contract===before.contract&&after.owner==='postgres'&&after.session_owner==='postgres','POST_SHAPE');
 const newFunctions=after.functions.filter(item=>item.name.startsWith('crm_audience_v2.rfm_'));
 const newRelations=after.relations.filter(item=>item.name.startsWith('crm_audience_v2.rfm_'));
 fail(newFunctions.length===CREATED_FUNCTIONS.length&&
  new Set(newFunctions.map(item=>item.name)).size===CREATED_FUNCTIONS.length&&
  CREATED_FUNCTIONS.every(name=>newFunctions.some(item=>item.name===name&&item.owner==='postgres'))&&
  newRelations.length===CREATED_RELATIONS.length&&
  CREATED_RELATIONS.every(name=>newRelations.some(item=>item.name===name&&item.owner==='postgres')),'CREATED_SET');
 const prior=new Map(before.functions.map(item=>[item.name,item]));
 const normalized=structuredClone(after);
 normalized.functions=normalized.functions.filter(item=>!item.name.startsWith('crm_audience_v2.rfm_'));
 normalized.relations=normalized.relations.filter(item=>!item.name.startsWith('crm_audience_v2.rfm_'));
 for(const item of normalized.functions)if(PATCHED.includes(item.name))item.body_sha256=prior.get(item.name)?.body_sha256;
 fail(canonical(normalized)===canonical(before),'POST_METADATA_DRIFT');
 return sha(canonical(value));
}
// Persist installedPost and its independently reviewed digest immediately
// after commit. Re-read currentPost just before rollback. Recomputing the
// digest from currentPost would erase the evidence needed to detect drift.
function compile({installPlan,baseline,installedPost,currentPost,expectedInstalledPostSha256,pins,reviewSha256,notBefore,expiresAt}={}){
 fail(installPlan&&installPlan.contract==='crm-rfm-install-plan-v1'&&HASH.test(installPlan.marker||''),'INSTALL_PLAN');
 const local=sourcePins();
 fail(canonical(pins)===canonical(local)&&local['n8n/growth/segment-shopify-rfm-rollback.cjs']===SELF_SHA&&
  canonical(installPlan.source_pins)===canonical(Install.sourcePins()),'SOURCE_DRIFT');
 fail(HASH.test(reviewSha256||''),'REVIEW_REQUIRED');
 const start=Date.parse(notBefore),end=Date.parse(expiresAt),installed=Date.parse(installedPost?.installed_at);
 fail(Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end-start<=10*60*1000&&
  Number.isFinite(installed)&&installed>=Date.parse(installPlan.not_before)&&installed<=Date.parse(installPlan.expires_at)&&
  start>=installed&&end<=installed+15*60*1000,'FRESHNESS');
 const baselineHash=validateBaseline(baseline,installPlan),postHash=validatePost(installedPost,baseline,installPlan,expectedInstalledPostSha256);
 const currentCaptured=Date.parse(currentPost?.captured_at);
 fail(currentPost?.contract===installedPost.contract&&
  currentPost.installed_at===installedPost.installed_at&&currentPost.receipt_rows===installedPost.receipt_rows&&
  canonical(currentPost.snapshot)===canonical(installedPost.snapshot)&&
  canonical(currentPost.risk)===canonical(installedPost.risk)&&
  canonical(currentPost.readback)===canonical(installedPost.readback)&&
  Number.isFinite(currentCaptured)&&currentCaptured>=Date.parse(installedPost.captured_at)&&
  currentCaptured>=Date.now()-120000&&currentCaptured<=Date.now()+5000,'CURRENT_POST_DRIFT');
 const marker=sha(canonical({install:installPlan.marker,baselineHash,postHash,pins,reviewSha256,notBefore,expiresAt}));
 const freshness=`IF clock_timestamp()<${literal(new Date(start).toISOString())}::timestamptz OR clock_timestamp()>=${literal(new Date(end).toISOString())}::timestamptz THEN RAISE EXCEPTION 'RFM_ROLLBACK_EXPIRED'; END IF;`;
 const before=literal(JSON.stringify(baseline.snapshot))+'::jsonb',after=literal(JSON.stringify(installedPost.snapshot))+'::jsonb';
 const risk=literal(JSON.stringify(baseline.risk))+'::jsonb',receipt=literal(JSON.stringify(installedPost.readback))+'::jsonb';
 const originalDefinitions=PATCHED.map(name=>`EXECUTE ${literal(baseline.definitions.find(item=>item.name===name).definition)};`).join('\n');
 const drops=[...CREATED_FUNCTIONS.map(name=>`DROP FUNCTION ${name} RESTRICT;`),...CREATED_RELATIONS.map(name=>`DROP TABLE ${name} RESTRICT;`)].join('\n');
 const sql=`BEGIN;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='20s';
DO $sealed$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('server_version_num')::integer<170000 THEN RAISE EXCEPTION 'RFM_ROLLBACK_BOUNDARY'; END IF;
 ${freshness}
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-rfm-install-v1',0));
END $sealed$;
LOCK TABLE ${CATALOG_LOCKS} IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ${DATA_LOCKS} IN SHARE ROW EXCLUSIVE MODE;
DO $sealed$ DECLARE actual jsonb; BEGIN
 ${freshness}
 EXECUTE ${literal(Install.snapshotSQL())} INTO actual;
 IF actual IS DISTINCT FROM ${after} THEN RAISE EXCEPTION 'RFM_ROLLBACK_METADATA_DRIFT'; END IF;
 EXECUTE ${literal(riskSQL())} INTO actual;
 IF actual IS DISTINCT FROM ${risk} THEN RAISE EXCEPTION 'RFM_ROLLBACK_DATA_DRIFT'; END IF;
 EXECUTE ${literal(Install.readbackSQL())} INTO actual;
 IF actual IS DISTINCT FROM ${receipt} OR (SELECT count(*) FROM crm_audience_v2.rfm_install_receipt)<>1
  THEN RAISE EXCEPTION 'RFM_ROLLBACK_RECEIPT_DRIFT'; END IF;
 PERFORM set_config('shrigma.rfm.rollback_guard',${literal(marker)},true);
END $sealed$;
DO $sealed$ BEGIN
 ${originalDefinitions}
END $sealed$;
${drops}
DO $sealed$ DECLARE actual jsonb; BEGIN
 ${freshness}
 EXECUTE ${literal(Install.snapshotSQL())} INTO actual;
 IF actual IS DISTINCT FROM ${before} THEN RAISE EXCEPTION 'RFM_ROLLBACK_AFTER_DRIFT'; END IF;
 EXECUTE ${literal(riskSQL())} INTO actual;
 IF actual IS DISTINCT FROM ${risk} THEN RAISE EXCEPTION 'RFM_ROLLBACK_AFTER_DATA_DRIFT'; END IF;
END $sealed$;
COMMIT;
`;
 return {contract:'crm-rfm-rollback-plan-v1',sql,sql_sha256:sha(sql),baseline_sha256:baselineHash,baseline_snapshot_sha256:installPlan.snapshot_sha256,post_sha256:postHash,
  install_marker:installPlan.marker,marker,source_pins:pins,review_sha256:reviewSha256,not_before:notBefore,expires_at:expiresAt,
  authorizes_send:false,readback_sql:readbackSQL()};
}
function reconcileReadback(plan,value){
 fail(plan?.contract==='crm-rfm-rollback-plan-v1'&&HASH.test(plan.baseline_sha256||''),'PLAN');
 fail(value?.objects_absent===true&&safeRisk(value.risk)&&
  sha(canonical(value.snapshot))===plan.baseline_snapshot_sha256,'READBACK_UNCONFIRMED');
 return {state:'rolled_back_off',authorizes_send:false};
}
module.exports={baselineSQL,postSQL,readbackSQL,sourcePins,validateBaseline,validatePost,compile,reconcileReadback,sha,canonical};
