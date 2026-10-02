'use strict';
// Pure shadow compiler. It does not connect, install, enable or send anything.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..'),SQL_FILE='n8n/growth/recipient-conversion-evidence.sql';
const SOURCE_FILES=[SQL_FILE,'n8n/growth/recipient-conversion-install.cjs','n8n/growth/segment-shopify-facts.sql','n8n/growth/segment-shopify-selection.sql','n8n/growth/segment-campaign-binding.sql','n8n/growth/ab-experiment-core.sql','n8n/growth/ab-audience-regular.sql'];
const HASH=/^[a-f0-9]{64}$/,sha=x=>createHash('sha256').update(x).digest('hex');
const LOADED_SELF_SHA=sha(fs.readFileSync(__filename));
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const fail=(condition,code)=>{if(!condition)throw Error('RECIPIENT_INSTALL_'+code);};
const literal=s=>"'"+s.replaceAll("'","''")+"'";
function captureSources(){const bytes=Object.fromEntries(SOURCE_FILES.map(name=>[name,fs.readFileSync(path.join(ROOT,name))]));return {bytes,pins:Object.fromEntries(SOURCE_FILES.map(name=>[name,sha(bytes[name])]))};}
function sourcePins(){return captureSources().pins;}
function snapshotSQL({after=false}={}){
 return `SELECT jsonb_build_object(
 'contract','crm-recipient-install-snapshot-v1',
 'database',current_database(),'server_version_num',current_setting('server_version_num'),
 'owner',current_user,'session_owner',session_user,
 'schemas',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',n.nspname,'owner',pg_get_userbyid(n.nspowner),'acl',coalesce(n.nspacl::text,'')) ORDER BY n.nspname COLLATE "C"),'[]') FROM pg_namespace n WHERE n.nspname IN('public','crm_audience_v2')),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')','owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'volatility',p.provolatile,'body_sha256',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),'config_sha256',encode(sha256(convert_to(coalesce(p.proconfig::text,''),'UTF8')),'hex'),'acl',coalesce(p.proacl::text,'')) ORDER BY n.nspname COLLATE "C",p.proname COLLATE "C",oidvectortypes(p.proargtypes) COLLATE "C"),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','crm_audience_v2') AND p.prokind IN('f','p')),
 'relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',n.nspname||'.'||c.relname,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,'acl',coalesce(c.relacl::text,''),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
 'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'acl',coalesce(a.attacl::text,''),'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'collation',a.attcollation::regcollation::text,'default_sha256',encode(sha256(convert_to(coalesce(pg_get_expr(d.adbin,d.adrelid),''),'UTF8')),'hex')) ORDER BY a.attnum),'[]') FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',k.conname,'def_sha256',encode(sha256(convert_to(pg_get_constraintdef(k.oid,true),'UTF8')),'hex')) ORDER BY k.conname COLLATE "C"),'[]') FROM pg_constraint k WHERE k.conrelid=c.oid),
 'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',ic.relname,'valid',i.indisvalid,'ready',i.indisready,'def_sha256',encode(sha256(convert_to(pg_get_indexdef(i.indexrelid),'UTF8')),'hex')) ORDER BY ic.relname COLLATE "C"),'[]') FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid)) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','crm_audience_v2') AND c.relkind IN('r','p','v','m','S')),
 'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',n.nspname||'.'||c.relname,'name',t.tgname,'enabled',t.tgenabled,'def_sha256',encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex')) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",t.tgname COLLATE "C"),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','crm_audience_v2') AND NOT t.tgisinternal ${after?"AND NOT(n.nspname='public' AND c.relname='shrigma_email_dispatch' AND t.tgname='crm_conversion_capture_claim_v1')":''}),
 'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',n.nspname||'.'||c.relname,'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',p.polroles::text,'using_sha256',encode(sha256(convert_to(coalesce(pg_get_expr(p.polqual,p.polrelid),''),'UTF8')),'hex'),'check_sha256',encode(sha256(convert_to(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''),'UTF8')),'hex')) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",p.polname COLLATE "C"),'[]') FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','crm_audience_v2')),
 'roles',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',rolname,'super',rolsuper,'inherit',rolinherit,'createrole',rolcreaterole,'createdb',rolcreatedb,'login',rolcanlogin,'replication',rolreplication,'bypassrls',rolbypassrls,'config_sha256',encode(sha256(convert_to(coalesce(rolconfig::text,''),'UTF8')),'hex')) ORDER BY rolname COLLATE "C"),'[]') FROM pg_roles),
 'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),'grantor',pg_get_userbyid(grantor),'admin',admin_option,'inherit',inherit_option,'set',set_option) ORDER BY pg_get_userbyid(roleid) COLLATE "C",pg_get_userbyid(member) COLLATE "C",pg_get_userbyid(grantor) COLLATE "C"),'[]') FROM pg_auth_members),
 'default_acls',(SELECT coalesce(jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(d.defaclrole),'schema',coalesce(n.nspname,''),'kind',d.defaclobjtype,'acl',d.defaclacl::text) ORDER BY pg_get_userbyid(d.defaclrole) COLLATE "C",coalesce(n.nspname,'') COLLATE "C",d.defaclobjtype),'[]') FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace),
 'extensions',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'owner',pg_get_userbyid(e.extowner),'schema',n.nspname) ORDER BY e.extname COLLATE "C"),'[]') FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace)
 ) AS snapshot`;
}
function validateSnapshot(s){
 fail(s&&s.contract==='crm-recipient-install-snapshot-v1'&&s.owner==='postgres'&&s.session_owner==='postgres'&&typeof s.database==='string'&&s.database.length>0,'IDENTITY');
 fail(typeof s.server_version_num==='string'&&/^17[0-9]{4}$/.test(s.server_version_num),'PG17_REQUIRED');
 for(const k of ['schemas','functions','relations','triggers','policies','roles','memberships','default_acls','extensions'])fail(Array.isArray(s[k]),'SNAPSHOT_SHAPE');
 const relations=new Map(s.relations.map(r=>[r.name,r]));
 const required={
  'public.shrigma_email_dispatch':['dispatch_id','brand','flow','piece','dedupe_key','recipient_key','recipient_key_version','claim_token','transport_state','started_at','accepted_at','is_test'],
  'public.subscribers':['id','uuid','email'], 'public.campaigns':['id','attribs','status'], 'public.crm_ab_arm_v2':['campaign_id'],
  'crm_audience_v2.shopify_source':['brand','current_operation','enabled','query_sha256','producer_revision','max_age_seconds'],
  'crm_audience_v2.shopify_batch':['brand','operation_id','status','provenance_sha256','observed_at','started_at'],
  'crm_audience_v2.shopify_customer_fact':['brand','customer_gid','subscriber_id','subscriber_uuid','identity_state','email','operation_id'],
  'crm_audience_v2.shopify_identity':['brand','customer_gid','subscriber_id','subscriber_uuid','email']};
 for(const [name,columns]of Object.entries(required)){const r=relations.get(name);fail(r&&r.owner==='postgres'&&r.kind==='r'&&columns.every(c=>r.columns.some(a=>a.name===c)),'RELATION_CONTRACT');}
 const functions=new Map(s.functions.map(f=>[f.name,f]));
 for(const name of ['public.shrigma_email_recipient_key(text)','crm_audience_v2.shopify_snapshot(text)','crm_audience_v2.campaign_binding_effective(integer)','crm_audience_v2.regular_delivery_claim(integer, integer, uuid, text, text, text, text, text, jsonb)','crm_audience_v2.regular_delivery_finish(integer, integer, uuid, uuid, text)']){
  const f=functions.get(name);fail(f&&f.owner==='postgres'&&HASH.test(f.body_sha256)&&HASH.test(f.config_sha256),'FUNCTION_CONTRACT');
  if(name.includes('regular_delivery_'))fail(f.definer===false&&f.volatility==='v','CLAIM_BOUNDARY');
 }
 fail(!s.triggers.some(t=>t.table==='public.shrigma_email_dispatch'&&t.name==='crm_conversion_capture_claim_v1'),'ALREADY_INSTALLED');
 fail(Buffer.byteLength(canonical(s))<=2_000_000,'SNAPSHOT_LIMIT');
 return sha(canonical(s));
}
function compile({expectedSnapshot,expectedSnapshotSha256,pins,reviewSha256,notBefore,expiresAt}={}){
 const sources=captureSources();
 const snapshotHash=validateSnapshot(expectedSnapshot);
 fail(HASH.test(expectedSnapshotSha256||'')&&snapshotHash===expectedSnapshotSha256,'SNAPSHOT_PIN');
 fail(canonical(pins)===canonical(sources.pins)&&sources.pins['n8n/growth/recipient-conversion-install.cjs']===LOADED_SELF_SHA,'SOURCE_DRIFT');
 fail(HASH.test(reviewSha256||''),'REVIEW_REQUIRED');
 const begin=Date.parse(notBefore),end=Date.parse(expiresAt);
 fail(Number.isFinite(begin)&&Number.isFinite(end)&&end>begin&&end-begin<=10*60*1000,'FRESHNESS');
 const raw=sources.bytes[SQL_FILE].toString('utf8'),start=raw.indexOf('BEGIN;\n');
 fail(start>=0&&raw.endsWith('COMMIT;\n'),'SQL_BOUNDARY');
 const body=raw.slice(start+7,-8),before=literal(JSON.stringify(expectedSnapshot))+'::jsonb';
 const locks=['pg_am','pg_amop','pg_amproc','pg_attribute','pg_attrdef','pg_authid','pg_auth_members','pg_class','pg_collation','pg_constraint','pg_default_acl','pg_depend','pg_enum','pg_extension','pg_index','pg_language','pg_namespace','pg_opclass','pg_operator','pg_opfamily','pg_policy','pg_proc','pg_range','pg_rewrite','pg_trigger','pg_type'].map(n=>'pg_catalog.'+n).join(', ');
 const freshness=`IF clock_timestamp()<${literal(new Date(begin).toISOString())}::timestamptz OR clock_timestamp()>=${literal(new Date(end).toISOString())}::timestamptz THEN RAISE EXCEPTION 'RECIPIENT_CONVERSION_INSTALL_EXPIRED'; END IF;`;
 const metadataGuard=sql=>`EXECUTE ${literal(sql)} INTO actual; IF actual IS DISTINCT FROM ${before} THEN RAISE EXCEPTION 'RECIPIENT_CONVERSION_METADATA_DRIFT'; END IF;`;
 const marker=sha(canonical({snapshotHash,pins,reviewSha256,notBefore,expiresAt}));
 const ddl=`BEGIN;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='20s';
DO $conversion_guard$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR current_setting('transaction_isolation')<>'read committed'
  OR clock_timestamp()<${literal(new Date(begin).toISOString())}::timestamptz OR clock_timestamp()>=${literal(new Date(end).toISOString())}::timestamptz
 THEN RAISE EXCEPTION 'RECIPIENT_CONVERSION_INSTALL_BOUNDARY'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-recipient-conversion-install-v1',0));
END $conversion_guard$;
LOCK TABLE ${locks} IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.shrigma_email_dispatch IN SHARE ROW EXCLUSIVE MODE;
DO $conversion_guard$ DECLARE actual jsonb; BEGIN ${freshness} ${metadataGuard(snapshotSQL())}
 PERFORM set_config('shrigma.recipient_conversion.install_guard',${literal(marker)},true);
END $conversion_guard$;
${body}
DO $conversion_guard$ DECLARE r record; actual jsonb; BEGIN
 -- Default privileges can grant additional roles when objects are created.
 -- Revoke only this new schema's grants; never alter existing default ACLs.
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname<>'postgres' LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA crm_email_conversion_candidate FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA crm_email_conversion_candidate FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_email_conversion_candidate FROM %I',r.rolname);
 END LOOP;
 ${metadataGuard(snapshotSQL({after:true}))}
 IF EXISTS(SELECT 1 FROM crm_email_conversion_candidate.capture_control_v1 WHERE enabled OR coverage_started_at IS NOT NULL)
  OR (SELECT count(*) FROM crm_email_conversion_candidate.capture_control_v1)<>2
  OR EXISTS(SELECT 1 FROM crm_email_conversion_candidate.claim_identity_v1)
  OR (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.shrigma_email_dispatch'::regclass AND t.tgname='crm_conversion_capture_claim_v1' AND t.tgenabled='O' AND t.tgfoid='crm_email_conversion_candidate.capture_claim_v1()'::regprocedure)<>1
 THEN RAISE EXCEPTION 'RECIPIENT_CONVERSION_AFTER_DRIFT'; END IF;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('crm_audience_api','crm_graph_worker','crm_shopify_sync') LOOP
  IF has_schema_privilege(r.rolname,'crm_email_conversion_candidate','USAGE')
   OR has_table_privilege(r.rolname,'crm_email_conversion_candidate.claim_identity_v1','SELECT')
   OR has_function_privilege(r.rolname,'crm_email_conversion_candidate.accepted_coverage_v1(text,integer)','EXECUTE')
  THEN RAISE EXCEPTION 'RECIPIENT_CONVERSION_PRIVATE_ACCESS'; END IF;
 END LOOP;
 ${freshness}
END $conversion_guard$;
COMMIT;
`;
 return {contract:'crm-recipient-install-plan-v1',sql:ddl,sql_sha256:sha(ddl),snapshot_sha256:snapshotHash,source_pins:pins,review_sha256:reviewSha256,not_before:notBefore,expires_at:expiresAt,enabled:false,authorizes_send:false};
}
module.exports={snapshotSQL,validateSnapshot,compile,sourcePins,sha,canonical};
