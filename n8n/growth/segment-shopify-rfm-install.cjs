'use strict';
// Pure compiler for an OFF RFM installation. It never opens a connection.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const Catalog=require('./recipient-conversion-install.cjs');
const ROOT=path.resolve(__dirname,'../..'),SQL_FILE='n8n/growth/segment-shopify-rfm.sql';
const SOURCE_FILES=[
 SQL_FILE,'n8n/growth/segment-shopify-rfm-install.cjs',
 'n8n/growth/recipient-conversion-install.cjs',
 'n8n/growth/segment-shopify-rfm.cjs',
 'n8n/growth/segment-shopify-rfm-evidence.cjs',
 'n8n/growth/segment-shopify-customer-bulk.graphql',
 'n8n/growth/segment-shopify-rfm-paid-orders-bulk.graphql',
 'n8n/growth/segment-shopify-selection.sql',
 'n8n/growth/segment-shopify-count-performance.sql',
 'services/crm-shopify-sync/worker.cjs'
];
const HASH=/^[a-f0-9]{64}$/,sha=x=>createHash('sha256').update(x).digest('hex');
const PATCHED=[
 'crm_audience_v2.selection_catalog_valid(jsonb, text)',
 'crm_audience_v2.selection_rule(jsonb, integer, text, integer, jsonb)',
 'crm_audience_v2.selection_regular_rule_match(jsonb, integer[], integer, text)',
 'crm_audience_v2.refresh_native_catalog(text)'
];
const LOADED_SELF_SHA=sha(fs.readFileSync(__filename));
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const fail=(condition,code)=>{if(!condition)throw Error('RFM_INSTALL_'+code);};
const literal=s=>"'"+s.replaceAll("'","''")+"'";
function captureSources(){
 const bytes=Object.fromEntries(SOURCE_FILES.map(name=>[name,fs.readFileSync(path.join(ROOT,name))]));
 return {bytes,pins:Object.fromEntries(SOURCE_FILES.map(name=>[name,sha(bytes[name])]))};
}
function sourcePins(){return captureSources().pins;}
function snapshotSQL(){
 const source="SELECT coalesce(jsonb_agg(jsonb_build_object('brand',brand,'shop_id',shop_id,'enabled',enabled,'current_operation',current_operation,'query_sha256',query_sha256,'producer_revision',producer_revision) ORDER BY brand),'[]'::jsonb) FROM crm_audience_v2.shopify_source";
 const roleAccess="SELECT coalesce(jsonb_agg(jsonb_build_object('role',r.rolname,"+
  "'owner_member',pg_has_role(r.oid,(SELECT nspowner FROM pg_namespace WHERE nspname='crm_audience_v2'),'MEMBER'),"+
  "'schema_create',has_schema_privilege(r.oid,'crm_audience_v2','CREATE'),"+
  "'peer_member',pg_has_role(r.oid,(CASE WHEN r.rolname='crm_audience_api' THEN 'crm_shopify_sync' ELSE 'crm_audience_api' END)::regrole::oid,'MEMBER')) ORDER BY r.rolname),'[]'::jsonb) "+
  "FROM pg_roles r WHERE r.rolname IN('crm_audience_api','crm_shopify_sync')";
 return "SELECT (s.snapshot-'contract')||jsonb_build_object('contract','crm-rfm-install-snapshot-v1','guards',jsonb_build_object("+
  "'worker_off',NOT EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled),"+
  "'delivery_off',NOT EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled),"+
  "'shopify_sources',("+source+"),'role_access',("+roleAccess+"))) AS snapshot FROM ("+Catalog.snapshotSQL()+") s";
}
function validateSnapshot(s){
 fail(s&&s.contract==='crm-rfm-install-snapshot-v1'&&s.owner==='postgres'&&s.session_owner==='postgres','IDENTITY');
 fail(typeof s.server_version_num==='string'&&/^17[0-9]{4}$/.test(s.server_version_num),'PG17_REQUIRED');
 for(const key of ['schemas','functions','relations','triggers','policies','roles','memberships','default_acls','extensions'])
  fail(Array.isArray(s[key]),'SNAPSHOT_SHAPE');
 fail(Buffer.byteLength(canonical(s))<=2_000_000,'SNAPSHOT_LIMIT');
 const schema=s.schemas.find(x=>x.name==='crm_audience_v2');
 fail(schema&&schema.owner==='postgres','SCHEMA_OWNER');
 const relations=new Map(s.relations.map(x=>[x.name,x]));
 const required={
  'crm_audience_v2.shopify_source':['brand','shop_id','current_operation','enabled','query_sha256','producer_revision'],
  'crm_audience_v2.shopify_identity':['brand','customer_gid','subscriber_id','subscriber_uuid'],
  'crm_audience_v2.regular_worker_deployment':['enabled'],
  'crm_audience_v2.regular_delivery_campaign':['enabled'],
  'public.subscribers':['id','uuid','email']
 };
 for(const [name,columns]of Object.entries(required)){
  const r=relations.get(name);
  fail(r&&r.owner==='postgres'&&r.kind==='r'&&columns.every(c=>r.columns.some(x=>x.name===c)),'RELATION_CONTRACT');
 }
 fail(!s.relations.some(x=>x.name.startsWith('crm_audience_v2.rfm_'))&&!s.functions.some(x=>x.name.startsWith('crm_audience_v2.rfm_')),'ALREADY_INSTALLED');
 const functions=new Map(s.functions.map(x=>[x.name,x]));
 for(const name of PATCHED){
  const f=functions.get(name);fail(f&&f.owner==='postgres'&&HASH.test(f.body_sha256)&&HASH.test(f.config_sha256),'FUNCTION_CONTRACT');
 }
 for(const name of ['crm_audience_api','crm_shopify_sync']){
  const role=s.roles.find(x=>x.name===name);
  fail(role&&role.super===false&&role.bypassrls===false,'ROLE_BOUNDARY');
 }
 const g=s.guards;
 fail(g&&g.worker_off===true&&g.delivery_off===true,'WORKER_ACTIVE');
 fail(Array.isArray(g.role_access)&&g.role_access.length===2&&
  ['crm_audience_api','crm_shopify_sync'].every(name=>g.role_access.some(x=>
   x.role===name&&x.owner_member===false&&x.schema_create===false&&x.peer_member===false)),'ROLE_EFFECTIVE_ACCESS');
 fail(Array.isArray(g.shopify_sources)&&g.shopify_sources.length===2&&
  ['aristo','fish'].every(b=>g.shopify_sources.some(x=>x.brand===b&&/^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/.test(x.shop_id)&&HASH.test(x.query_sha256))),'SOURCE_BASELINE');
 return sha(canonical(s));
}
function rawBody(raw){
 const lines=raw.split('\n'),begins=lines.filter(x=>x==='BEGIN;').length,commits=lines.filter(x=>x==='COMMIT;').length;
 fail(begins===2&&commits===2&&raw.endsWith('COMMIT;\n'),'SQL_BOUNDARY');
 return lines.filter(x=>x!=='BEGIN;'&&x!=='COMMIT;').join('\n');
}
const CATALOG_LOCKS=['pg_am','pg_amop','pg_amproc','pg_attribute','pg_attrdef','pg_authid','pg_auth_members','pg_class','pg_collation','pg_constraint','pg_default_acl','pg_depend','pg_enum','pg_extension','pg_index','pg_language','pg_namespace','pg_opclass','pg_operator','pg_opfamily','pg_policy','pg_proc','pg_range','pg_rewrite','pg_trigger','pg_type'].map(x=>'pg_catalog.'+x).join(', ');
function normalizedPostSQL(before){
 const relations="(SELECT coalesce(jsonb_agg(item ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(s.snapshot->'relations') WITH ORDINALITY x(item,n) WHERE item->>'name' NOT LIKE 'crm_audience_v2.rfm_%')";
 const oldHash="(SELECT prior->'body_sha256' FROM jsonb_array_elements("+before+"->'functions') prior WHERE prior->>'name'=item->>'name')";
 const functions="(SELECT coalesce(jsonb_agg(CASE WHEN item->>'name' IN ("+PATCHED.map(literal).join(',')+") THEN jsonb_set(item,'{body_sha256}',"+oldHash+") ELSE item END ORDER BY n),'[]'::jsonb) FROM jsonb_array_elements(s.snapshot->'functions') WITH ORDINALITY x(item,n) WHERE item->>'name' NOT LIKE 'crm_audience_v2.rfm_%')";
 return "SELECT jsonb_set(jsonb_set(s.snapshot,'{relations}',"+relations+"),'{functions}',"+functions+") AS normalized FROM ("+snapshotSQL()+") s";
}
function readbackSQL(){
 return "SELECT jsonb_build_object('marker',marker,'snapshot_sha256',snapshot_sha256,'pins_sha256',pins_sha256,"+
  "'enabled',enabled,'source_rows',(SELECT count(*) FROM crm_audience_v2.rfm_source),"+
  "'batch_rows',(SELECT count(*) FROM crm_audience_v2.rfm_batch),"+
  "'fact_rows',(SELECT count(*) FROM crm_audience_v2.rfm_fact),"+
  "'function_count',(SELECT count(*) FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname LIKE 'rfm_%')) AS readback "+
  "FROM crm_audience_v2.rfm_install_receipt";
}
function reconcileReadback(plan,readback){
 fail(plan&&plan.contract==='crm-rfm-install-plan-v1'&&HASH.test(plan.marker||''),'PLAN');
 fail(readback&&readback.marker===plan.marker&&readback.snapshot_sha256===plan.snapshot_sha256&&
  readback.pins_sha256===plan.pins_sha256&&readback.enabled===false&&
  Number.isInteger(readback.source_rows)&&readback.source_rows===0&&
  Number.isInteger(readback.batch_rows)&&readback.batch_rows===0&&
  Number.isInteger(readback.fact_rows)&&readback.fact_rows===0&&
  Number.isInteger(readback.function_count)&&readback.function_count===13,'READBACK_UNCERTAIN');
 return {state:'committed_off',authorizes_send:false};
}
function compile({expectedSnapshot,expectedSnapshotSha256,pins,reviewSha256,notBefore,expiresAt}={}){
 const sources=captureSources(),snapshotHash=validateSnapshot(expectedSnapshot);
 fail(HASH.test(expectedSnapshotSha256||'')&&snapshotHash===expectedSnapshotSha256,'SNAPSHOT_PIN');
 fail(canonical(pins)===canonical(sources.pins)&&sources.pins['n8n/growth/segment-shopify-rfm-install.cjs']===LOADED_SELF_SHA,'SOURCE_DRIFT');
 fail(HASH.test(reviewSha256||''),'REVIEW_REQUIRED');
 const begin=Date.parse(notBefore),end=Date.parse(expiresAt);
 fail(Number.isFinite(begin)&&Number.isFinite(end)&&end>begin&&end-begin<=10*60*1000,'FRESHNESS');
 const snapshotLiteral=literal(JSON.stringify(expectedSnapshot))+'::jsonb';
 const guard="EXECUTE "+literal(snapshotSQL())+" INTO actual; IF actual IS DISTINCT FROM "+snapshotLiteral+" THEN RAISE EXCEPTION 'RFM_INSTALL_METADATA_DRIFT'; END IF;";
 const afterGuard="EXECUTE "+literal(normalizedPostSQL(snapshotLiteral))+" INTO actual; IF actual IS DISTINCT FROM "+snapshotLiteral+" THEN RAISE EXCEPTION 'RFM_INSTALL_AFTER_METADATA_DRIFT'; END IF;";
 const marker=sha(canonical({snapshotHash,pins,reviewSha256,notBefore,expiresAt}));
 const pinsHash=sha(canonical(pins));
 const freshness="IF clock_timestamp()<"+literal(new Date(begin).toISOString())+"::timestamptz OR clock_timestamp()>="+literal(new Date(end).toISOString())+"::timestamptz THEN RAISE EXCEPTION 'RFM_INSTALL_EXPIRED'; END IF;";
 const effectiveAccessGuard=
  "IF EXISTS(SELECT 1 FROM (VALUES('crm_audience_api'),('crm_shopify_sync')) runtime(role_name) "+
  "CROSS JOIN (VALUES('crm_audience_v2.rfm_source'),('crm_audience_v2.rfm_batch'),('crm_audience_v2.rfm_fact'),('crm_audience_v2.rfm_install_receipt')) objects(table_name) "+
  "WHERE has_table_privilege(runtime.role_name,objects.table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) "+
  "OR EXISTS(SELECT 1 FROM (VALUES('crm_audience_api'),('crm_shopify_sync')) runtime(role_name) CROSS JOIN pg_proc p "+
  "WHERE p.pronamespace='crm_audience_v2'::regnamespace AND p.proname LIKE 'rfm_%' "+
  "AND has_function_privilege(runtime.role_name,p.oid,'EXECUTE') "+
  "AND NOT(runtime.role_name='crm_audience_api' AND p.proname IN('rfm_snapshot','rfm_source_current','rfm_match','rfm_count_for_rule')) "+
  "AND NOT(runtime.role_name='crm_shopify_sync' AND p.proname='rfm_ingest_snapshot')) "+
  "THEN RAISE EXCEPTION 'RFM_INSTALL_EFFECTIVE_ACCESS'; END IF;";
 const ddl=[
  'BEGIN;',
  'SET LOCAL standard_conforming_strings=on;',
  "SET LOCAL lock_timeout='500ms';",
  "SET LOCAL statement_timeout='20s';",
  "DO $sealed$ BEGIN IF current_user<>'postgres' OR session_user<>'postgres' OR current_setting('transaction_isolation')<>'read committed' OR current_setting('server_version_num')::integer<170000 THEN RAISE EXCEPTION 'RFM_INSTALL_BOUNDARY'; END IF; "+
   freshness+" PERFORM pg_advisory_xact_lock(hashtextextended('crm-rfm-install-v1',0)); END $sealed$;",
  'LOCK TABLE '+CATALOG_LOCKS+' IN SHARE ROW EXCLUSIVE MODE;',
  'LOCK TABLE crm_audience_v2.shopify_source,crm_audience_v2.regular_worker_deployment,crm_audience_v2.regular_delivery_campaign IN SHARE ROW EXCLUSIVE MODE;',
  'DO $sealed$ DECLARE actual jsonb; BEGIN '+freshness+' '+guard+' END $sealed$;',
  "SELECT set_config('shrigma.rfm.install_guard',"+literal(marker)+",true);",
  rawBody(sources.bytes[SQL_FILE].toString('utf8')),
  "CREATE TABLE crm_audience_v2.rfm_install_receipt(marker text PRIMARY KEY CHECK(marker~'^[0-9a-f]{64}$'),snapshot_sha256 text NOT NULL CHECK(snapshot_sha256~'^[0-9a-f]{64}$'),pins_sha256 text NOT NULL CHECK(pins_sha256~'^[0-9a-f]{64}$'),installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),enabled boolean NOT NULL DEFAULT false CHECK(NOT enabled));",
  'INSERT INTO crm_audience_v2.rfm_install_receipt(marker,snapshot_sha256,pins_sha256) VALUES('+literal(marker)+','+literal(snapshotHash)+','+literal(pinsHash)+');',
  'REVOKE ALL ON crm_audience_v2.rfm_install_receipt FROM PUBLIC;',
  'REVOKE ALL ON TABLE crm_audience_v2.rfm_source,crm_audience_v2.rfm_batch,crm_audience_v2.rfm_fact,crm_audience_v2.rfm_install_receipt FROM PUBLIC;',
  "DO $sealed$ DECLARE r record;p record; BEGIN "+
   "FOR p IN SELECT oid::regprocedure AS identity FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname LIKE 'rfm_%' LOOP "+
   "EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',p.identity); END LOOP; "+
   "FOR r IN SELECT rolname FROM pg_roles WHERE rolname<>'postgres' LOOP "+
   "EXECUTE format('REVOKE ALL ON TABLE crm_audience_v2.rfm_source,crm_audience_v2.rfm_batch,crm_audience_v2.rfm_fact,crm_audience_v2.rfm_install_receipt FROM %I',r.rolname); "+
   "FOR p IN SELECT oid::regprocedure AS identity FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname LIKE 'rfm_%' LOOP "+
   "EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',p.identity,r.rolname); END LOOP; END LOOP; END $sealed$;",
  'GRANT EXECUTE ON FUNCTION crm_audience_v2.rfm_snapshot(text),crm_audience_v2.rfm_source_current(text,text),crm_audience_v2.rfm_match(jsonb,integer,text,text),crm_audience_v2.rfm_count_for_rule(jsonb,text,integer,text) TO crm_audience_api;',
  'GRANT EXECUTE ON FUNCTION crm_audience_v2.rfm_ingest_snapshot(jsonb,jsonb) TO crm_shopify_sync;',
  "DO $sealed$ DECLARE actual jsonb; BEGIN "+freshness+
   " IF (SELECT count(*) FROM crm_audience_v2.rfm_install_receipt)<>1 OR EXISTS(SELECT 1 FROM crm_audience_v2.rfm_install_receipt WHERE marker<>"+literal(marker)+" OR enabled) "+
   "OR EXISTS(SELECT 1 FROM crm_audience_v2.rfm_source) OR EXISTS(SELECT 1 FROM crm_audience_v2.rfm_batch) OR EXISTS(SELECT 1 FROM crm_audience_v2.rfm_fact) "+
   "OR (SELECT count(*) FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace AND proname LIKE 'rfm_%')<>13 "+
   "OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='crm_audience_v2'::regnamespace AND c.relname IN('rfm_source','rfm_batch','rfm_fact','rfm_install_receipt') "+
   "AND (pg_get_userbyid(c.relowner)<>'postgres' OR c.relrowsecurity OR c.relforcerowsecurity)) "+
   "OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='crm_audience_v2'::regnamespace AND p.proname LIKE 'rfm_%' AND pg_get_userbyid(p.proowner)<>'postgres') "+
   "THEN RAISE EXCEPTION 'RFM_INSTALL_AFTER_DRIFT'; END IF; "+
   "IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a "+
   "WHERE c.relnamespace='crm_audience_v2'::regnamespace AND c.relname IN('rfm_source','rfm_batch','rfm_fact','rfm_install_receipt') AND a.grantee<>c.relowner) "+
   "OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a "+
   "WHERE p.pronamespace='crm_audience_v2'::regnamespace AND p.proname LIKE 'rfm_%' AND a.grantee<>p.proowner "+
   "AND NOT(a.grantee=to_regrole('crm_audience_api')::oid AND p.proname IN('rfm_snapshot','rfm_source_current','rfm_match','rfm_count_for_rule')) "+
   "AND NOT(a.grantee=to_regrole('crm_shopify_sync')::oid AND p.proname='rfm_ingest_snapshot')) "+
   "THEN RAISE EXCEPTION 'RFM_INSTALL_PRIVATE_ACCESS'; END IF; "+effectiveAccessGuard+' '+afterGuard+" END $sealed$;",
  'COMMIT;',
  ''
 ].join('\n');
 return {contract:'crm-rfm-install-plan-v1',sql:ddl,sql_sha256:sha(ddl),snapshot_sha256:snapshotHash,pins_sha256:pinsHash,source_pins:pins,review_sha256:reviewSha256,not_before:notBefore,expires_at:expiresAt,marker,enabled:false,authorizes_send:false,readback_sql:readbackSQL()};
}
module.exports={snapshotSQL,validateSnapshot,compile,sourcePins,readbackSQL,reconcileReadback,sha,canonical};
