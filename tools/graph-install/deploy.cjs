'use strict';
// Offline composition. Only the explicitly injected adapter can access production.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../maintenance-cart-deploy/deploy.cjs');
const {FileStore,canonical,sha}=C;
const CONTRACT='crm-graph-install-v1',MAINTENANCE_CONTRACT='maintenance-cart-graph-install-v1';
const GRAPH='crm_graph_candidate',MAINTENANCE='crm_maintenance_candidate';
const MIGRATIONS=['source','release','native','cart','dispatch-receipt','maintenance'].map(n=>'n8n/growth/journey-graph-'+n+'.sql');
const FILES=[...MIGRATIONS,'n8n/growth/journey-graph-worker-role.cjs','tools/graph-install/deploy.cjs','tools/maintenance-cart-deploy/deploy.cjs'];
const WORKFLOWS=['ekQxu1pUFyab8Iyd','mh8IXSuOzgOEnZwT','ecK2wke9fKnO3mfy','y6qJRcWcSfEZzwgZ'];
const BASE_TABLES=['control','entry','intent','journey','operation','revision','transition'];
const SIGNATURES=['shrigma_email_claim_cart(jsonb)','shrigma_email_finish_cart(uuid,uuid,text,jsonb)','shrigma_email_recipient_key(text)','shrigma_flow_slot(text,text,text,text,text,text)','shrigma_flow_wait(text,text,text,numeric)','shrigma_flow_stage_enabled(text,text,text)','digest(bytea,text)'];
const PUBLIC_TABLES=['subscribers','subscriber_lists','lists','templates','shrigma_template_email_registry','shrigma_flow_definition','shrigma_email_dispatch','shrigma_send_log','shrigma_exposure_7d'];
const lit=x=>"'"+String(x).replaceAll("'","''")+"'",same=(a,b)=>canonical(a)===canonical(b);
function check(ok,code){if(!ok)throw Error('GRAPH_INSTALL_'+code);}
// No row values. Fingerprints cover privileges, triggers, indexes and views too.
function relations(where){return `(SELECT jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'acl',a.attacl,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled,md5(pg_get_functiondef(t.tgfoid))) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid),
 'view',CASE WHEN c.relkind IN('v','m') THEN pg_get_viewdef(c.oid,true) END,
 'sequence',(SELECT to_jsonb(s)-'seqrelid' FROM pg_sequence s WHERE s.seqrelid=c.oid)) ORDER BY c.oid::regclass::text) FROM pg_class c WHERE ${where})`;}
function schemaShape(schema){return `(SELECT md5(jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl,
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace=n.oid AND p.prokind='f'),
 'relations',${relations('c.relnamespace=n.oid')},
 'defaults',(SELECT jsonb_agg(jsonb_build_array(d.defaclrole::regrole::text,d.defaclobjtype,d.defaclacl) ORDER BY d.defaclrole,d.defaclobjtype) FROM pg_default_acl d WHERE d.defaclnamespace IN(0,n.oid)))::text) FROM pg_namespace n WHERE n.nspname=${lit(schema)})`;}
const GRAPH_SHAPE=schemaShape(GRAPH),MAINTENANCE_SHAPE=schemaShape(MAINTENANCE);
const PUBLIC_SHAPE=`md5(jsonb_build_object('relations',${relations("c.relnamespace='public'::regnamespace AND (c.relname IN ("+PUBLIC_TABLES.map(lit).join(',')+") OR c.oid=to_regclass(pg_get_serial_sequence('public.shrigma_send_log','id')))")},
 'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid=ANY(ARRAY[${SIGNATURES.map(s=>`to_regprocedure(${lit('public.'+s)})`).join(',')}])),
 'public_definers',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)),p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prosecdef))::text)`;
const ROLE_SQL=`(SELECT jsonb_build_object('name',r.rolname,'login',r.rolcanlogin,'superuser',r.rolsuper,'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,'inherit',r.rolinherit,'replication',r.rolreplication,'bypassrls',r.rolbypassrls,'memberships',(SELECT count(*) FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)) FROM pg_roles r WHERE r.rolname='crm_graph_worker')`;
const METADATA_SQL=`SELECT current_database() AS database,current_user AS role,${GRAPH_SHAPE} AS graph_shape,${MAINTENANCE_SHAPE} AS maintenance_shape,${C.SHAPE} AS maintenance_legacy_shape,${PUBLIC_SHAPE} AS public_shape,
 (SELECT obj_description(n.oid,'pg_namespace') FROM pg_namespace n WHERE n.nspname='${GRAPH}') AS graph_seal,
 (SELECT obj_description(n.oid,'pg_namespace') FROM pg_namespace n WHERE n.nspname='${MAINTENANCE}') AS maintenance_seal,
 (SELECT jsonb_agg(c.relname ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace='${GRAPH}'::regnamespace AND c.relkind='r') AS graph_tables,
 (SELECT to_jsonb(c) FROM ${GRAPH}.control c WHERE singleton) AS graph_control,
 (SELECT to_jsonb(c) FROM ${MAINTENANCE}.control c WHERE singleton) AS maintenance_control,
 pg_get_serial_sequence('public.shrigma_send_log','id') AS send_log_sequence,
 (SELECT jsonb_build_object('signature','public.shrigma_email_recipient_key(text)','sha256',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),'definer',p.prosecdef) FROM pg_proc p WHERE p.oid=to_regprocedure('public.shrigma_email_recipient_key(text)')) AS recipient_key,
 ${ROLE_SQL} AS worker_role;`;
const OFF_SQL=`SELECT (SELECT coalesce(bool_and(NOT enabled AND cache_target IS NULL),false) AND count(*)=2 FROM ${GRAPH}.cart_control_v1) AS cart_off,
 (SELECT count(*)::text FROM ${GRAPH}.cart_epoch_v1) AS epochs,(SELECT count(*)::text FROM ${GRAPH}.cart_owner_v1) AS owners,
 (SELECT count(*)::text FROM ${GRAPH}.source_event_v1) AS sources,(SELECT count(*)::text FROM ${GRAPH}.native_template_v1) AS clones;`;
function sources(root){return Object.fromEntries(FILES.map(f=>[f,sha(fs.readFileSync(path.join(root,f),'utf8'))]));}
function previousSeal(before){let seal;try{seal=JSON.parse(before.maintenance_seal);}catch{}check(seal&&same(Object.keys(seal).sort(),['contract','ddl','nonce','shape'])&&seal.contract===C.CONTRACT&&/^[a-f0-9-]{36}$/.test(seal.nonce)&&/^[a-f0-9]{64}$/.test(seal.ddl)&&seal.shape===before.maintenance_legacy_shape,'MAINTENANCE_SEAL');return seal;}
function preflight(before){
 check(typeof before.database==='string'&&typeof before.role==='string'&&['graph_shape','maintenance_shape','public_shape','maintenance_legacy_shape'].every(k=>/^[a-f0-9]{32}$/.test(before[k])),'METADATA');
 check(before.graph_seal===null&&before.worker_role===null&&same(before.graph_tables,BASE_TABLES),'BASE_COLLISION');
 check(same(before.graph_control,{singleton:true,enabled:false}),'GRAPH_NOT_OFF');
 check(before.maintenance_control?.enabled===true&&before.maintenance_control.mode==='open'&&before.maintenance_control.version===2&&before.maintenance_control.cutoff_at===null,'MAINTENANCE_GATE');
 check(before.recipient_key?.definer===true&&before.recipient_key.signature==='public.shrigma_email_recipient_key(text)'&&/^[a-f0-9]{64}$/.test(before.recipient_key.sha256),'RECIPIENT_HELPER');
 check(/^public\.[a-z_][a-z0-9_]*$/.test(before.send_log_sequence),'SEQUENCE');previousSeal(before);
}
function ddlBody(source){if(!/^COMMIT;/m.test(source)){check(/DO \$install\$/.test(source)&&/END \$install\$;\s*$/.test(source)&&!/^BEGIN;|^COMMIT;/m.test(source),'SQL_BOUNDARY');return source;}check(/\bBEGIN;/.test(source)&&/COMMIT;\s*$/.test(source),'SQL_BOUNDARY');return source.replace(/\bBEGIN;/,'').replace(/COMMIT;\s*$/,'').replace(/SET LOCAL lock_timeout='3s';/g,'');}
function atomicInstall(root,before,nonce){
 preflight(before);check(/^[a-f0-9-]{36}$/.test(nonce),'NONCE');
 const role=require(path.join(root,'n8n/growth/journey-graph-worker-role.cjs')).buildWorkerRoleSql({sendLogSequence:before.send_log_sequence,recipientKeySignature:before.recipient_key.signature,recipientKeySha256:before.recipient_key.sha256});
 const ddl=MIGRATIONS.map(f=>ddlBody(fs.readFileSync(path.join(root,f),'utf8'))).join('\n')+'\n'+role;
 check(typeof role==='string'&&!ddl.includes('$graph_install_ddl$'),'DDL');
 const seal={contract:CONTRACT,nonce,ddl:sha(ddl),previous:previousSeal(before)};
 const maintenanceSeal={contract:MAINTENANCE_CONTRACT,nonce,ddl:seal.ddl,previous:seal.previous};
 const sql=`SET LOCAL statement_timeout='15s';
DO $graph_install$ DECLARE gs jsonb;ms jsonb; BEGIN
 PERFORM set_config('lock_timeout','500ms',true);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('maintenance-cart-install',0)) OR NOT pg_try_advisory_xact_lock(hashtextextended('crm-graph-install',0)) THEN RAISE EXCEPTION 'GRAPH_INSTALL_BUSY';END IF;
 IF current_database() IS DISTINCT FROM ${lit(before.database)} OR current_user IS DISTINCT FROM ${lit(before.role)} THEN RAISE EXCEPTION 'GRAPH_INSTALL_DB_IDENTITY';END IF;
 PERFORM 1 FROM ${GRAPH}.control WHERE singleton FOR SHARE;
 PERFORM 1 FROM ${MAINTENANCE}.control WHERE singleton FOR SHARE;
 IF ${GRAPH_SHAPE} IS DISTINCT FROM ${lit(before.graph_shape)} OR ${MAINTENANCE_SHAPE} IS DISTINCT FROM ${lit(before.maintenance_shape)} OR ${PUBLIC_SHAPE} IS DISTINCT FROM ${lit(before.public_shape)} THEN RAISE EXCEPTION 'GRAPH_INSTALL_SCHEMA_DRIFT';END IF;
 IF (SELECT to_jsonb(c) FROM ${GRAPH}.control c WHERE singleton) IS DISTINCT FROM ${lit(JSON.stringify(before.graph_control))}::jsonb OR (SELECT to_jsonb(c) FROM ${MAINTENANCE}.control c WHERE singleton) IS DISTINCT FROM ${lit(JSON.stringify(before.maintenance_control))}::jsonb THEN RAISE EXCEPTION 'GRAPH_INSTALL_CONTROL_DRIFT';END IF;
 IF (SELECT obj_description(n.oid,'pg_namespace') FROM pg_namespace n WHERE n.nspname='${GRAPH}') IS DISTINCT FROM NULL OR (SELECT obj_description(n.oid,'pg_namespace') FROM pg_namespace n WHERE n.nspname='${MAINTENANCE}') IS DISTINCT FROM ${lit(before.maintenance_seal)} OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_graph_worker') THEN RAISE EXCEPTION 'GRAPH_INSTALL_COLLISION';END IF;
 EXECUTE $graph_install_ddl$${ddl}$graph_install_ddl$;
 IF (SELECT enabled FROM ${GRAPH}.control WHERE singleton) OR EXISTS(SELECT 1 FROM ${GRAPH}.cart_control_v1 WHERE enabled OR cache_target IS NOT NULL) OR (SELECT rolcanlogin FROM pg_roles WHERE rolname='crm_graph_worker') THEN RAISE EXCEPTION 'GRAPH_INSTALL_NOT_OFF';END IF;
 gs:=${lit(JSON.stringify(seal))}::jsonb||jsonb_build_object('graph_shape',${GRAPH_SHAPE},'maintenance_shape',${MAINTENANCE_SHAPE},'public_shape',${PUBLIC_SHAPE},'worker_role',${ROLE_SQL});
 ms:=${lit(JSON.stringify(maintenanceSeal))}::jsonb||jsonb_build_object('shape',${C.SHAPE});
 EXECUTE format('COMMENT ON SCHEMA ${GRAPH} IS %L',gs::text);
 EXECUTE format('COMMENT ON SCHEMA ${MAINTENANCE} IS %L',ms::text);
END $graph_install$;`;
 return {sql,seal,maintenanceSeal};
}
function workflowSnapshot(w){check(w?.active===true&&w.versionId&&w.activeVersionId===w.versionId&&w.activeVersion?.versionId===w.versionId&&same(w.nodes,w.activeVersion.nodes)&&same(w.connections,w.activeVersion.connections),'WORKFLOW_UNPUBLISHED');return {id:w.id,version:w.versionId,hash:sha(w),pg_ids:[...new Set(w.nodes.filter(n=>n.credentials?.postgres).map(n=>n.credentials.postgres.id))].sort()};}
class Installer{
 constructor({root,io,store}){this.root=root;this.io=io;this.store=store;}
 async snapshot(){const utility=await this.io.utilityPG();check(Array.isArray(utility.ids)&&utility.ids.length===1,'UTILITY_PG');const workflows=[];for(const id of WORKFLOWS){const w=await this.io.getWorkflow(id);check(w.id===id,'WORKFLOW_ID');const proof=workflowSnapshot(w);check(same(proof.pg_ids,utility.ids),'RUNTIME_PG_REFERENCE');workflows.push(proof);}const metadata=await this.io.metadata();check(metadata.role==='postgres','RUNTIME_ROLE');return {metadata,workflows,utility};}
 async prepare(guard){check(!this.store.has('plan'),'PLAN_EXISTS');const before=await this.snapshot();this.store.put('before',before);check(guard?.snapshot_sha256===sha(before),'UNREVIEWED_SNAPSHOT');check(before.metadata.database==='listmonk','DATABASE_SCOPE');preflight(before.metadata);const migration=atomicInstall(this.root,before.metadata,crypto.randomUUID());const p={contract:CONTRACT,prepared_at:new Date().toISOString(),sources:sources(this.root),before,migration};p.hash=sha(p);this.store.put('plan',p);return this.summary(p);}
 plan(){const p=this.store.read('plan'),{hash,...body}=p;check(p.contract===CONTRACT&&sha(body)===hash,'PLAN_HASH');check(same(sources(this.root),p.sources),'SOURCE_DRIFT');return p;}
 summary(p){return {contract:CONTRACT,plan_hash:p.hash,sql_hash:sha(p.migration.sql),brands:['fish','aristo'],execution_enabled:false,worker_login:false,workflow_changes:0,service_created:false};}
 async install(hash){const p=this.plan();check(hash===p.hash,'PLAN_APPROVAL');check(!this.store.has('install-intent'),'UNCERTAIN_RECONCILE');const fresh=await this.snapshot();this.store.put('fresh-'+crypto.randomUUID(),fresh);check(same(fresh,p.before),'PREFLIGHT_DRIFT');this.store.put('install-intent',{at:new Date().toISOString(),plan_hash:hash,sql_hash:sha(p.migration.sql)});const result=await this.io.sql(p.migration.sql);this.store.put('install-response',{result});return this.verify(true);}
 async verify(record=false){const p=this.plan(),fresh=await this.snapshot();this.store.put('readback-'+crypto.randomUUID(),fresh);check(same(fresh.workflows,p.before.workflows)&&same(fresh.utility,p.before.utility),'WORKFLOW_DRIFT');const s=fresh.metadata;let gs,ms;try{gs=JSON.parse(s.graph_seal);ms=JSON.parse(s.maintenance_seal);}catch{throw Error('GRAPH_INSTALL_SEAL');}
 const {graph_shape,maintenance_shape,public_shape,worker_role,maintenance_extension,...base}=gs||{};check(same(base,p.migration.seal)&&graph_shape===s.graph_shape&&maintenance_shape===s.maintenance_shape&&public_shape===s.public_shape&&same(worker_role,s.worker_role),'SEAL_DRIFT');
 if(maintenance_extension){check(this.store.has('install-verified'),'MAINTENANCE_EXTENSION_BASELINE_REQUIRED');const baseline=this.store.read('install-verified').baseline;check(baseline&&maintenance_extension.previous_maintenance_shape===baseline.maintenance_shape&&ms?.previous?.shape===baseline.maintenance_legacy_shape&&graph_shape===baseline.graph_shape&&public_shape===baseline.public_shape&&same(worker_role,baseline.worker_role),'MAINTENANCE_EXTENSION_PREDECESSOR');const e=maintenance_extension;check(same(Object.keys(e).sort(),['contract','ddl','nonce','previous_maintenance_shape'])&&e.contract==='maintenance-tx-install-v1'&&/^[a-f0-9-]{36}$/.test(e.nonce)&&/^[a-f0-9]{64}$/.test(e.ddl)&&/^[a-f0-9]{32}$/.test(e.previous_maintenance_shape),'MAINTENANCE_EXTENSION');check(ms?.previous&&/^[a-f0-9]{32}$/.test(ms.previous.shape)&&same(ms.previous,{...p.migration.maintenanceSeal,shape:ms.previous.shape})&&same(ms,{contract:e.contract,nonce:e.nonce,ddl:e.ddl,previous:ms.previous,shape:s.maintenance_legacy_shape}),'MAINTENANCE_EXTENSION_CHAIN');}else check(same(ms,{...p.migration.maintenanceSeal,shape:s.maintenance_legacy_shape}),'MAINTENANCE_SEAL_DRIFT');check(s.database===p.before.metadata.database&&s.role===p.before.metadata.role&&same(s.graph_control,p.before.metadata.graph_control)&&same(s.maintenance_control,p.before.metadata.maintenance_control),'CONTROL_DRIFT');
 check(s.worker_role?.login===false&&s.worker_role.superuser===false&&s.worker_role.memberships===0,'WORKER_ROLE');const off=await this.io.off();check(off.cart_off===true&&['epochs','owners','sources','clones'].every(k=>off[k]==='0'),'NOT_OFF');const result={...this.summary(p),installed:true,readback_verified:true,workflows_unchanged:true,maintenance_control_unchanged:true,activation_available:false,baseline:maintenance_extension?this.store.read('install-verified').baseline:{graph_shape,maintenance_shape,public_shape,worker_role,maintenance_legacy_shape:s.maintenance_legacy_shape}};if(record)this.store.put('install-verified',result);return result;}
 async reconcile(){check(this.store.has('install-intent')&&!this.store.has('install-verified'),'RECONCILE_STATE');return this.verify(true);}
}
function createAPIAdapter({api,sql}){const base=require('../maintenance-tx-deploy/api-adapter.cjs').createAPIAdapter({api,sql});const one=async q=>{const rows=await sql(q);check(Array.isArray(rows)&&rows.length===1,'SQL_RESULT');return rows[0];};return {getWorkflow:base.getWorkflow,utilityPG:base.utilityPG,metadata:()=>one(METADATA_SQL),off:()=>one(OFF_SQL),sql};}
module.exports={Installer,FileStore,atomicInstall,preflight,previousSeal,METADATA_SQL,OFF_SQL,GRAPH_SHAPE,MAINTENANCE_SHAPE,PUBLIC_SHAPE,ROLE_SQL,CONTRACT,MAINTENANCE_CONTRACT,MIGRATIONS,BASE_TABLES,WORKFLOWS,canonical,sha,sources,createAPIAdapter};
