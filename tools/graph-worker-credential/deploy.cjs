'use strict';
// One NOLOGIN credential preparation. No endpoint, plaintext return, LOGIN,
// operator key generation, service operation, reset or automatic retry.
const fs=require('node:fs'),path=require('node:path');
const {FileStore,canonical,sha}=require('../maintenance-cart-deploy/deploy.cjs');
const G=require('../graph-install/deploy.cjs'),A=require('../graph-worker-access/contract.cjs');
const CONTRACT='crm-graph-worker-credential-prepare-v1',SCHEMA='crm_worker_access_admin_v1',ROLE='crm_graph_worker';
const KEY_CONTRACT='crm-graph-worker-public-key-v1';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),same=(a,b)=>canonical(a)===canonical(b);
const keys=(x,n)=>object(x)&&same(Object.keys(x).sort(),n.slice().sort()),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const lit=x=>"'"+String(x).replaceAll("'","''")+"'",body=x=>x.replace(/;\s*$/,'');
function check(ok,code){if(!ok)throw Error('GRAPH_CREDENTIAL_'+code);}
// Qualify only trusted SQL template text, never caller-supplied JSON/key
// literals. In particular variadic builtin overloads must not resolve in public.
const CATALOG_FUNCTIONS=new Set(('acldefault aclexplode bool_and convert_to count current_database current_setting current_schemas encode decode format format_type jsonb_agg jsonb_build_array jsonb_build_object md5 obj_description oidvectortypes pg_get_constraintdef pg_get_expr pg_get_functiondef pg_get_indexdef pg_get_serial_sequence pg_get_triggerdef pg_get_userbyid pg_get_viewdef sha256 to_json to_jsonb to_regclass to_regprocedure set_config pg_try_advisory_xact_lock hashtextextended clock_timestamp to_char').split(' '));
function catalogSQL(text){
 let output='',i=0;
 while(i<text.length){
  const rest=text.slice(i);let m;
  if((m=/^'(?:[^']|'')*'/.exec(rest))||(m=/^"(?:[^"]|"")*"/.exec(rest))||(m=/^--[^\n]*(?:\n|$)/.exec(rest))||(m=/^\/\*[\s\S]*?\*\//.exec(rest))){output+=m[0];i+=m[0].length;continue;}
  if((m=/^[A-Za-z_][A-Za-z_0-9]*/.exec(rest))){const name=m[0];if(CATALOG_FUNCTIONS.has(name.toLowerCase())&&/^\s*\(/.test(rest.slice(name.length))&&!/\.\s*$/.test(output))output+='pg_catalog.';output+=name;i+=name.length;continue;}
  output+=text[i++];
 }
 return output;
}
function sqlTemplate(strings,...values){
 const trusted=strings.map((s,i)=>s+(i<values.length?'__GRAPH_CREDENTIAL_BIND_'+i+'__':'')).join('');
 return catalogSQL(trusted).replace(/__GRAPH_CREDENTIAL_BIND_(\d+)__/g,(_,i)=>values[Number(i)]);
}
const AUTH_SQL=sqlTemplate`(SELECT jsonb_build_object('password_null',r.rolpassword IS NULL,'scram',coalesce(r.rolpassword LIKE 'SCRAM-SHA-256$%',false),'auth_proof_hash',encode(sha256(convert_to(jsonb_build_object('role_oid',r.oid,'role',r.rolname,'verifier',r.rolpassword)::text,'UTF8')),'hex')) FROM pg_authid r WHERE r.rolname='${ROLE}')`;
const HOOKS_SQL=sqlTemplate`jsonb_build_object('shared_preload_libraries',current_setting('shared_preload_libraries'),'session_preload_libraries',current_setting('session_preload_libraries'),'local_preload_libraries',current_setting('local_preload_libraries'),'pgaudit_log',current_setting('pgaudit.log',true),'auto_explain_log_min_duration',current_setting('auto_explain.log_min_duration',true))`;
const CRYPTO_SQL=sqlTemplate`(SELECT jsonb_build_object('oid',e.oid::text,'name',e.extname,'version',e.extversion,'schema',n.nspname,'owner_oid',e.extowner::text,'functions',(SELECT jsonb_agg(jsonb_build_object('oid',p.oid::text,'name',p.proname,'arguments',oidvectortypes(p.proargtypes),'owner_oid',p.proowner::text,'language',l.lanname,'binary',p.probin,'symbol',p.prosrc,'definer',p.prosecdef,'strict',p.proisstrict,'volatility',p.provolatile,'parallel',p.proparallel,'kind',p.prokind,'returns',p.prorettype::regtype::text,'settings',p.proconfig,'acl',p.proacl,'definition_hash',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),'extension_member',EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_extension'::regclass AND d.refobjid=e.oid AND d.deptype='e')) ORDER BY p.proname) FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid IN(to_regprocedure('public.gen_random_bytes(integer)'),to_regprocedure('public.pgp_pub_encrypt(text,bytea,text)')))) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto')`;
const RECEIPT_SCHEMA_SQL=sqlTemplate`(SELECT jsonb_build_object('oid',n.oid::text,'owner_oid',n.nspowner::text,'acl',n.nspacl,'functions',(SELECT count(*) FROM pg_proc p WHERE p.pronamespace=n.oid),'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'owner_oid',c.relowner::text) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace=n.oid),'unexpected_acl',(SELECT count(*) FROM (SELECT a.grantee FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner UNION ALL SELECT a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a WHERE c.relnamespace=n.oid AND c.relkind IN('r','S','v','m','p') AND a.grantee<>c.relowner UNION ALL SELECT a.grantee FROM pg_class c JOIN pg_attribute at ON at.attrelid=c.oid CROSS JOIN LATERAL aclexplode(at.attacl) a WHERE c.relnamespace=n.oid AND a.grantee<>c.relowner) q),'shape',(SELECT md5(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'acl',a.attacl,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),'triggers',(SELECT jsonb_agg(jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled,md5(pg_get_functiondef(t.tgfoid))) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'index',CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) END) ORDER BY c.relname)::text) FROM pg_class c WHERE c.relnamespace=n.oid)) FROM pg_namespace n WHERE n.nspname='${SCHEMA}')`;
const METADATA_BODY=sqlTemplate`SELECT current_database() AS database,current_user AS role,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,current_setting('server_version_num')::integer AS server_version_num,current_setting('standard_conforming_strings') AS standard_strings,to_json(current_schemas(true)) AS search_schemas,current_setting('transaction_isolation') AS transaction_isolation,current_setting('transaction_read_only') AS transaction_read_only,(SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement_timeout_ms,
 (SELECT to_jsonb(g) FROM (${catalogSQL(body(G.METADATA_SQL))}) g) AS graph,(SELECT to_jsonb(o) FROM (${catalogSQL(body(G.OFF_SQL))}) o) AS off,
 ${catalogSQL(A.ROLE_IDENTITY_SQL)} AS worker_identity,${AUTH_SQL} AS auth,${CRYPTO_SQL} AS crypto,${HOOKS_SQL} AS hooks,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('oid',e.oid::text,'name',e.evtname,'event',e.evtevent,'owner_oid',e.evtowner::text,'function_oid',e.evtfoid::text,'enabled',e.evtenabled,'tags',e.evttags,'definition_hash',encode(sha256(convert_to(pg_get_functiondef(e.evtfoid),'UTF8')),'hex')) ORDER BY e.oid),'[]'::jsonb) FROM pg_event_trigger e) AS event_triggers,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('oid',d.oid::text,'role',d.defaclrole::text,'schema',d.defaclnamespace::text,'type',d.defaclobjtype,'acl',d.defaclacl) ORDER BY d.oid),'[]'::jsonb) FROM pg_default_acl d) AS default_acls,
 (SELECT jsonb_agg(jsonb_build_object('oid',d.oid::text,'name',d.datname) ORDER BY d.oid) FROM pg_database d WHERE NOT d.datistemplate AND d.datallowconn) AS database_inventory,
 ${RECEIPT_SCHEMA_SQL} AS receipt_schema`;
const METADATA_SQL=METADATA_BODY+';';
const RECEIPT_SQL=sqlTemplate`SELECT contract,nonce::text,role_oid::text,key_sha256,key_fingerprint,validation_receipt_hash,predecessor_hash,scope_hash,before_state,after_state,encode(ciphertext,'base64') AS ciphertext,ciphertext_sha256,auth_proof_hash,to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at FROM ${SCHEMA}.receipt WHERE singleton;`;
function publicKey(value){
 check(keys(value,['public_key_b64','key_sha256','key_fingerprint','nonce','validation_receipt_hash'])&&uuid(value.nonce)&&digest(value.key_sha256)&&digest(value.validation_receipt_hash)&&typeof value.key_fingerprint==='string'&&/^[a-f0-9]{40}$/.test(value.key_fingerprint)&&typeof value.public_key_b64==='string','PUBLIC_KEY');
 const binary=Buffer.from(value.public_key_b64,'base64');check(binary.length>128&&binary.length<16384&&binary.toString('base64')===value.public_key_b64&&shaBytes(binary)===value.key_sha256,'PUBLIC_KEY_BYTES');
 const record={contract:KEY_CONTRACT,version:1,role:ROLE,database:'listmonk',nonce:value.nonce,key_sha256:value.key_sha256,key_fingerprint:value.key_fingerprint};check(sha(record)===value.validation_receipt_hash,'PUBLIC_KEY_VALIDATION');return value;
}
function shaBytes(value){return require('node:crypto').createHash('sha256').update(value).digest('hex');}
function cryptoGuard(c,owner){
 check(c?.name==='pgcrypto'&&c.version==='1.3'&&c.schema==='public'&&c.owner_oid===owner&&Array.isArray(c.functions)&&c.functions.length===2,'CRYPTO_CATALOG');
 const definitions=[['gen_random_bytes','integer','pg_random_bytes'],['pgp_pub_encrypt','text, bytea, text','pgp_pub_encrypt_text']];
 for(const [i,[name,args,symbol]] of definitions.entries()){const f=c.functions[i];check(f.name===name&&f.arguments===args&&f.symbol===symbol&&f.owner_oid===owner&&f.language==='c'&&f.binary==='$libdir/pgcrypto'&&f.definer===false&&f.strict===true&&f.volatility==='v'&&f.parallel==='s'&&f.kind==='f'&&f.returns==='bytea'&&f.settings===null&&f.extension_member===true&&digest(f.definition_hash),'CRYPTO_FUNCTION');}
}
function schemaGuard(value,owner){check(value&&typeof value.oid==='string'&&value.owner_oid===owner&&value.unexpected_acl===0&&value.functions===0&&/^[a-f0-9]{32}$/.test(value.shape)&&same(value.relations,[{name:'receipt',kind:'r',owner_oid:owner},{name:'receipt_nonce_key',kind:'i',owner_oid:owner},{name:'receipt_pkey',kind:'i',owner_oid:owner}]),'RECEIPT_SCHEMA');}
function preflight(before,{predecessor,scopeReview,publicKey:key}){
 check(before?.database==='listmonk'&&before.role==='postgres'&&before.superuser===true&&before.server_version_num===170010&&before.standard_strings==='on'&&before.transaction_isolation==='read committed'&&before.transaction_read_only==='off','IDENTITY');
 check(Number.isInteger(before.statement_timeout_ms)&&before.statement_timeout_ms>0&&before.statement_timeout_ms<=30000,'STATEMENT_TIMEOUT');
 check(same(before.search_schemas,['pg_catalog','public']),'SEARCH_PATH');
 check(same(before.event_triggers,[]),'EVENT_TRIGGERS');
 check(same(before.hooks,{shared_preload_libraries:'',session_preload_libraries:'',local_preload_libraries:'',pgaudit_log:null,auto_explain_log_min_duration:null}),'AUDIT_HOOKS');
 check(before.receipt_schema===null&&before.auth?.password_null===true&&before.auth.scram===false&&digest(before.auth.auth_proof_hash),'ALREADY_PREPARED');
 check(same(before.off,{cart_off:true,epochs:'0',owners:'0',sources:'0',clones:'0'})&&same(before.graph?.graph_control,{singleton:true,enabled:false})&&before.graph?.maintenance_control?.enabled===true&&before.graph.maintenance_control.mode==='open'&&before.graph.maintenance_control.version===2&&before.graph.maintenance_control.cutoff_at===null&&same(before.graph.public_create_schemas,[]),'NOT_OFF');
 const runtimeFields=['runtimeReceipt','runtimePlan','runtimeReview'];const hasRuntime=runtimeFields.some(k=>Object.hasOwn(predecessor||{},k));
 check(keys(predecessor,['baseAnchor','txReceipt',...(hasRuntime?runtimeFields:[])]),'PREDECESSOR');
 A.validateOperational({metadata:{...before.graph,worker_role_identity:before.worker_identity},...predecessor});check(before.worker_identity.role.login===false,'LOGIN');
 check(object(scopeReview)&&digest(scopeReview.scope_hash)&&scopeReview.scope_hash===sha(scopeReview.connection_scope)&&same(scopeReview.database_inventory,before.database_inventory),'SCOPE_REVIEW');A.validateConnectionScope(scopeReview.connection_scope,before.worker_identity.oid,scopeReview);
 cryptoGuard(before.crypto,before.role_oid);check(Array.isArray(before.default_acls),'DEFAULT_ACLS');publicKey(key);return before;
}
function expectedAfter(before,after){
 check(after?.auth?.password_null===false&&after.auth.scram===true&&digest(after.auth.auth_proof_hash)&&after.auth.auth_proof_hash!==before.auth.auth_proof_hash,'AUTH_UNCONFIRMED');schemaGuard(after.receipt_schema,before.role_oid);
 check(same({...after,auth:before.auth,receipt_schema:null},before),'AFTER_DRIFT');return after;
}
function atomicPrepare(before,inputs){
 preflight(before,inputs);const key=inputs.publicKey,nonce=key.nonce,predecessor_hash=sha(inputs.predecessor),scope_hash=inputs.scopeReview.scope_hash;
 const sql=sqlTemplate`DO $credential_prepare$ DECLARE actual jsonb; after_state jsonb; secret text; encrypted bytea; target_oid oid; BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'GRAPH_CREDENTIAL_ISOLATION';END IF;
 IF (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 30000 THEN RAISE EXCEPTION 'GRAPH_CREDENTIAL_STATEMENT_TIMEOUT';END IF;
 PERFORM set_config('lock_timeout','500ms',true);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('maintenance-cart-install',0)) OR NOT pg_try_advisory_xact_lock(hashtextextended('crm-graph-install',0)) OR NOT pg_try_advisory_xact_lock(hashtextextended('crm-graph-worker-access',0)) THEN RAISE EXCEPTION 'GRAPH_CREDENTIAL_BUSY';END IF;
 LOCK TABLE pg_catalog.pg_authid,pg_catalog.pg_auth_members,pg_catalog.pg_database,pg_catalog.pg_namespace,pg_catalog.pg_default_acl,pg_catalog.pg_db_role_setting,pg_catalog.pg_proc,pg_catalog.pg_depend,pg_catalog.pg_extension,pg_catalog.pg_event_trigger IN SHARE MODE;
 LOCK TABLE crm_graph_candidate.control,crm_graph_candidate.cart_control_v1,crm_graph_candidate.cart_epoch_v1,crm_graph_candidate.cart_owner_v1,crm_graph_candidate.source_event_v1,crm_graph_candidate.native_template_v1,crm_maintenance_candidate.control IN SHARE MODE;
 SELECT to_jsonb(m) INTO actual FROM (${METADATA_BODY}) m;
 IF actual IS DISTINCT FROM ${lit(JSON.stringify(before))}::jsonb THEN RAISE EXCEPTION 'GRAPH_CREDENTIAL_PREFLIGHT_DRIFT';END IF;
 SELECT oid INTO STRICT target_oid FROM pg_authid WHERE rolname='${ROLE}' AND oid=${lit(before.worker_identity.oid)}::oid AND NOT rolcanlogin AND rolpassword IS NULL;
 CREATE SCHEMA ${SCHEMA};REVOKE ALL ON SCHEMA ${SCHEMA} FROM PUBLIC;
 CREATE TABLE ${SCHEMA}.receipt(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),contract text NOT NULL,nonce uuid NOT NULL UNIQUE,role_oid oid NOT NULL,key_sha256 text NOT NULL,key_fingerprint text NOT NULL,validation_receipt_hash text NOT NULL,predecessor_hash text NOT NULL,scope_hash text NOT NULL,before_state jsonb NOT NULL,after_state jsonb NOT NULL,ciphertext bytea NOT NULL,ciphertext_sha256 text NOT NULL,auth_proof_hash text NOT NULL,completed_at timestamptz NOT NULL DEFAULT clock_timestamp());
 REVOKE ALL ON ${SCHEMA}.receipt FROM PUBLIC;
 IF (${RECEIPT_SCHEMA_SQL})->>'unexpected_acl'<>'0' THEN RAISE EXCEPTION 'GRAPH_CREDENTIAL_RECEIPT_ACL';END IF;
 PERFORM set_config('password_encryption','scram-sha-256',true);
 BEGIN
  secret:=encode(public.gen_random_bytes(32),'hex');
  encrypted:=public.pgp_pub_encrypt(jsonb_build_object('nonce',${lit(nonce)},'role','${ROLE}','database','listmonk','password',secret)::text,decode(${lit(key.public_key_b64)},'base64'),'cipher-algo=aes256,compress-algo=0,disable-mdc=0');
  EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD %L','${ROLE}',secret);
  -- credential prepared; before receipt
  SELECT to_jsonb(m) INTO after_state FROM (${METADATA_BODY}) m;
  IF (after_state-'auth'-'receipt_schema') IS DISTINCT FROM (${lit(JSON.stringify(before))}::jsonb-'auth'-'receipt_schema') OR after_state#>>'{auth,password_null}'<>'false' OR after_state#>>'{auth,scram}'<>'true' OR after_state#>>'{auth,auth_proof_hash}'=${lit(before.auth.auth_proof_hash)} OR after_state#>>'{receipt_schema,unexpected_acl}'<>'0' THEN RAISE EXCEPTION 'GRAPH_CREDENTIAL_AFTER_DRIFT';END IF;
  INSERT INTO ${SCHEMA}.receipt(contract,nonce,role_oid,key_sha256,key_fingerprint,validation_receipt_hash,predecessor_hash,scope_hash,before_state,after_state,ciphertext,ciphertext_sha256,auth_proof_hash)
  VALUES(${lit(CONTRACT)},${lit(nonce)}::uuid,target_oid,${lit(key.key_sha256)},${lit(key.key_fingerprint)},${lit(key.validation_receipt_hash)},${lit(predecessor_hash)},${lit(scope_hash)},${lit(JSON.stringify(before))}::jsonb,after_state,encrypted,encode(sha256(encrypted),'hex'),after_state#>>'{auth,auth_proof_hash}');
 EXCEPTION
  WHEN query_canceled OR assert_failure THEN secret:=NULL;encrypted:=NULL;RAISE EXCEPTION 'GRAPH_CREDENTIAL_CANCELLED';
  WHEN OTHERS THEN secret:=NULL;encrypted:=NULL;RAISE EXCEPTION 'GRAPH_CREDENTIAL_FAILED';
 END;
 secret:=NULL;encrypted:=NULL;
END $credential_prepare$;`;
 check(!JSON.stringify(before).includes('$credential_prepare$'),'SQL_DELIMITER');return {sql,nonce,predecessor_hash,scope_hash,publicKey:key};
}
function identity(value){
 check(keys(value,['target','workflows','utility'])&&object(value.target)&&value.target.database==='listmonk'&&value.target.role==='postgres'&&value.target.isolated===true,'TRANSPORT_IDENTITY');
 check(keys(value.utility,['ids','version','node_hash'])&&Array.isArray(value.utility.ids)&&value.utility.ids.length===1&&typeof value.utility.ids[0]==='string'&&typeof value.utility.version==='string'&&value.utility.version.length>0&&digest(value.utility.node_hash),'UTILITY');
 check(Array.isArray(value.workflows)&&value.workflows.length===G.WORKFLOWS.length,'WORKFLOWS');
 for(const [i,w] of value.workflows.entries())check(keys(w,['id','version','hash','pg_ids'])&&w.id===G.WORKFLOWS[i]&&typeof w.version==='string'&&w.version.length>0&&digest(w.hash)&&same(w.pg_ids,value.utility.ids),'WORKFLOW_IDENTITY');return value;
}
function snapshot(value){check(keys(value,['metadata','identity','session_pid'])&&Number.isInteger(value.session_pid)&&value.session_pid>0,'SNAPSHOT');identity(value.identity);return value;}
const FILES=['tools/graph-worker-credential/deploy.cjs','tools/graph-worker-credential/operator.cjs','tools/graph-worker-credential/package.json','tools/graph-worker-credential/package-lock.json','tools/graph-worker-access/contract.cjs','tools/graph-worker-access/snapshot.cjs','tools/graph-worker-access/database-scope.cjs','tools/graph-admin-session/dbgate-6.cjs'];
function sources(root){return {...G.sources(root),...Object.fromEntries(FILES.map(f=>[f,sha(fs.readFileSync(path.join(root,f),'utf8'))]))};}
function validateReceipt(receipt,before,after,migration){
 check(keys(receipt,['contract','nonce','role_oid','key_sha256','key_fingerprint','validation_receipt_hash','predecessor_hash','scope_hash','before_state','after_state','ciphertext','ciphertext_sha256','auth_proof_hash','completed_at']),'RECEIPT');
 const key=migration.publicKey;check(receipt.contract===CONTRACT&&receipt.nonce===migration.nonce&&receipt.role_oid===before.worker_identity.oid&&receipt.key_sha256===key.key_sha256&&receipt.key_fingerprint===key.key_fingerprint&&receipt.validation_receipt_hash===key.validation_receipt_hash&&receipt.predecessor_hash===migration.predecessor_hash&&receipt.scope_hash===migration.scope_hash&&same(receipt.before_state,before)&&same(receipt.after_state,after)&&receipt.auth_proof_hash===after.auth.auth_proof_hash,'RECEIPT_BINDING');
 check(typeof receipt.ciphertext==='string'&&receipt.ciphertext.length>0&&receipt.ciphertext.length<=65536&&digest(receipt.ciphertext_sha256),'CIPHERTEXT');const b64=receipt.ciphertext.replace(/[\r\n]/g,''),bytes=Buffer.from(b64,'base64');check(bytes.toString('base64')===b64&&shaBytes(bytes)===receipt.ciphertext_sha256,'CIPHERTEXT_HASH');
 check(typeof receipt.completed_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.completed_at)&&new Date(receipt.completed_at).toISOString()===receipt.completed_at,'RECEIPT_TIME');return receipt;
}
class Preparer{
 constructor({root,io,store}){this.root=root;this.io=io;this.store=store;}
 async snapshot(){return snapshot(await this.io.snapshot());}
 async prepare(guard){check(!this.store.has('plan'),'PLAN_EXISTS');const before=await this.snapshot();this.store.put('before',before);check(guard?.snapshot_sha256===sha(before),'UNREVIEWED_SNAPSHOT');const inputs={predecessor:guard.predecessor,scopeReview:guard.scopeReview,publicKey:guard.publicKey};const migration=atomicPrepare(before.metadata,inputs);const p={contract:CONTRACT,before,inputs,migration,sources:sources(this.root)};p.hash=sha(p);this.store.put('plan',p);return this.summary(p);}
 plan(){const p=this.store.read('plan'),{hash,...value}=p;check(p.contract===CONTRACT&&sha(value)===hash,'PLAN_HASH');check(same(sources(this.root),p.sources),'SOURCE_DRIFT');return p;}
 summary(p){return {contract:CONTRACT,plan_hash:p.hash,sql_hash:sha(p.migration.sql),nonce:p.migration.nonce,role:ROLE,role_oid:p.before.metadata.worker_identity.oid,worker_login:false,execution_enabled:false,credential_prepared:false};}
 async provision(hash){const p=this.plan();check(hash===p.hash,'PLAN_APPROVAL');check(!this.store.has('provision-intent'),'UNCERTAIN_RECONCILE');const fresh=await this.snapshot();this.store.put('fresh-'+require('node:crypto').randomUUID(),fresh);check(same(fresh.metadata,p.before.metadata)&&same(fresh.identity,p.before.identity),'PREFLIGHT_DRIFT');this.store.put('provision-intent',{plan_hash:hash,sql_hash:sha(p.migration.sql),session_pid:fresh.session_pid});try{await this.io.sql(p.migration.sql);this.store.put('provision-response',{acknowledged:true});}catch{this.store.put('provision-response',{acknowledged:false,code:'WRITE_UNCONFIRMED'});throw Error('GRAPH_CREDENTIAL_WRITE_UNCONFIRMED');}return this.verify(true);}
 async verify(record=false){const p=this.plan();check(this.store.has('provision-intent'),'INTENT_REQUIRED');let read;try{read=await this.io.independentReadback();}catch{throw Error('GRAPH_CREDENTIAL_READBACK_UNCONFIRMED');}check(object(read)&&Object.hasOwn(read,'receipt'),'READBACK');const {receipt,...fresh}=read;snapshot(fresh);this.store.put('readback-'+require('node:crypto').randomUUID(),{...fresh,receipt});check(fresh.session_pid!==this.store.read('provision-intent').session_pid,'INDEPENDENT_READBACK');check(same(fresh.identity,p.before.identity),'TRANSPORT_DRIFT');expectedAfter(p.before.metadata,fresh.metadata);validateReceipt(receipt,p.before.metadata,fresh.metadata,p.migration);const result={...this.summary(p),credential_prepared:true,readback_verified:true,independent_commit_verified:true,auth_proof_hash:fresh.metadata.auth.auth_proof_hash,ciphertext_sha256:receipt.ciphertext_sha256,receipt_hash:sha(receipt),after_state_hash:sha(fresh.metadata)};if(record)this.store.put('provision-verified',result);return result;}
 async reconcile(){check(this.store.has('provision-intent')&&!this.store.has('provision-verified'),'RECONCILE_STATE');return this.verify(true);}
}
module.exports={catalogSQL,identity,snapshot,CONTRACT,SCHEMA,KEY_CONTRACT,METADATA_BODY,METADATA_SQL,AUTH_SQL,HOOKS_SQL,CRYPTO_SQL,RECEIPT_SCHEMA_SQL,RECEIPT_SQL,publicKey,preflight,expectedAfter,atomicPrepare,validateReceipt,Preparer,FileStore,sources,sha,canonical,shaBytes};
