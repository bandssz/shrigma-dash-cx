'use strict';
// Explicit one-shot migration only; no endpoint, credentials, role creation or retry.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {FileStore,canonical,sha}=require('../maintenance-cart-deploy/deploy.cjs');
const B=require('./barrier.cjs'),G=require('../graph-install/deploy.cjs');
const CONTRACT='crm-public-create-preservation-v1',SCHEMA='crm_schema_acl_migration_v1';
const FILES=['tools/graph-acl-migration/deploy.cjs','tools/graph-acl-migration/barrier.cjs'];
const same=(a,b)=>canonical(a)===canonical(b),lit=x=>"'"+String(x).replaceAll("'","''")+"'";
function check(ok,code){if(!ok)throw Error('GRAPH_ACL_'+code);}
const ACL=`(SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',a.grantee,'grantor',a.grantor,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a)`;
// No passwords, role-setting values or business rows are returned.
const METADATA_BODY=`SELECT current_database() AS database,current_user AS role,
 (SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,
 (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
 (SELECT jsonb_build_object('oid',oid,'owner',datdba) FROM pg_database WHERE datname=current_database()) AS database_identity,
 current_setting('standard_conforming_strings') AS standard_strings,
 current_setting('transaction_isolation') AS transaction_isolation,
 (extract(epoch FROM current_setting('statement_timeout')::interval)*1000)::integer AS statement_timeout_ms,
 (SELECT jsonb_build_object('oid',n.oid,'name',n.nspname,'owner',n.nspowner,'comment_hash',md5(coalesce(obj_description(n.oid,'pg_namespace'),'')),'acl',${ACL}) FROM pg_namespace n WHERE n.nspname='public') AS public_schema,
 (SELECT jsonb_agg(jsonb_build_object('oid',r.oid,'name',r.rolname,'superuser',r.rolsuper,'inherit',r.rolinherit,'createrole',r.rolcreaterole,'createdb',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,'bypassrls',r.rolbypassrls,'connlimit',r.rolconnlimit,'validuntil',r.rolvaliduntil,'config_hash',md5(coalesce(r.rolconfig::text,''))) ORDER BY r.oid) FROM pg_roles r) AS roles,
 (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor),'[]'::jsonb) FROM pg_auth_members m) AS memberships,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('database',s.setdatabase,'role',s.setrole,'config_hash',md5(s.setconfig::text)) ORDER BY s.setdatabase,s.setrole),'[]'::jsonb) FROM pg_db_role_setting s) AS role_settings,
 (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]'::jsonb) FROM pg_default_acl d) AS default_acls,
 (SELECT jsonb_agg(jsonb_build_object('oid',r.oid,'name',r.rolname,'create',has_schema_privilege(r.oid,'public','CREATE'),'usage',has_schema_privilege(r.oid,'public','USAGE'),'create_grant',has_schema_privilege(r.oid,'public','CREATE WITH GRANT OPTION'),'usage_grant',has_schema_privilege(r.oid,'public','USAGE WITH GRANT OPTION')) ORDER BY r.oid) FROM pg_roles r) AS capabilities,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('oid',r.oid,'name',r.rolname) ORDER BY r.oid),'[]'::jsonb) FROM pg_roles r CROSS JOIN pg_namespace n WHERE n.nspname='public' AND NOT r.rolsuper AND has_schema_privilege(r.oid,n.oid,'CREATE') AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>0 AND a.privilege_type='CREATE' AND pg_has_role(r.oid,a.grantee,'USAGE'))) AS dependent_roles,
 (SELECT to_jsonb(g) FROM (${B.STATE_SQL}) g) AS graph_state,
 to_regnamespace('${SCHEMA}')::text AS receipt_schema`;
const METADATA_SQL=METADATA_BODY+';';
const RECEIPT_SQL=`SELECT contract,nonce,retired,before_state,after_state,completed_at FROM ${SCHEMA}.receipt WHERE singleton;`;
function preflight(b){
 check(b&&typeof b.database==='string'&&typeof b.role==='string'&&b.superuser===true&&b.standard_strings==='on','IDENTITY');
 check(b.transaction_isolation==='read committed','ISOLATION');
 check(Number.isInteger(b.statement_timeout_ms)&&b.statement_timeout_ms>0&&b.statement_timeout_ms<=30000,'STATEMENT_TIMEOUT');
 check(b.public_schema?.name==='public'&&b.public_schema.owner===b.role_oid,'SCHEMA_OWNER');
 check(b.receipt_schema===null,'RECEIPT_COLLISION');
 check(Array.isArray(b.roles)&&b.roles.length>0&&Array.isArray(b.memberships)&&Array.isArray(b.default_acls)&&Array.isArray(b.role_settings)&&Array.isArray(b.capabilities)&&b.capabilities.length===b.roles.length&&Array.isArray(b.dependent_roles),'METADATA');
 const publicCreate=b.public_schema.acl.filter(a=>a.grantee==='0'&&a.privilege==='CREATE');
 check(publicCreate.length===1&&publicCreate[0].grantor===b.role_oid&&publicCreate[0].grantable===false,'PUBLIC_GRANTOR');
 check(b.capabilities.every(c=>c.create===true&&b.roles.some(r=>r.oid===c.oid&&r.name===c.name)),'CAPABILITIES');
 check(b.dependent_roles.every(r=>b.roles.some(v=>v.oid===r.oid&&v.name===r.name&&!v.superuser))&&new Set(b.dependent_roles.map(r=>r.oid)).size===b.dependent_roles.length,'DEPENDENT_ROLES');
 check(!b.roles.some(r=>r.name==='crm_graph_worker'),'WORKER_ALREADY_EXISTS');
 B.preflight(b);
}
function expectedAfter(before,graphShape=null,controlXmin=null){
 const after=JSON.parse(JSON.stringify(before));
 after.public_schema.acl=after.public_schema.acl.filter(a=>a.grantee!=='0'||a.privilege!=='CREATE');
 for(const r of before.dependent_roles)after.public_schema.acl.push({grantee:r.oid,grantor:before.role_oid,privilege:'CREATE',grantable:false});
 after.public_schema.acl.sort((a,b)=>a.grantee-b.grantee||a.grantor-b.grantor||a.privilege.localeCompare(b.privilege)||Number(a.grantable)-Number(b.grantable));
 after.dependent_roles=[];after.receipt_schema=SCHEMA;after.graph_state=B.after(before,graphShape,controlXmin);return after;
}
function atomicInstall(before,nonce,retired){
 preflight(before);check(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce),'NONCE');
 B.preflight(before,retired);check(retired!==undefined,'RETIREMENT_REFERENCE');
 check(!JSON.stringify(before).includes('$acl_preservation$'),'SQL_DELIMITER');
 const after=expectedAfter(before);
 const sql=`DO $acl_preservation$ DECLARE actual jsonb;target jsonb; BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'GRAPH_ACL_ISOLATION';END IF;
 IF (extract(epoch FROM current_setting('statement_timeout')::interval)*1000) NOT BETWEEN 1 AND 30000 THEN RAISE EXCEPTION 'GRAPH_ACL_STATEMENT_TIMEOUT';END IF;
 PERFORM set_config('lock_timeout','500ms',true);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('maintenance-cart-install',0)) OR NOT pg_try_advisory_xact_lock(hashtextextended('crm-graph-install',0)) OR NOT pg_try_advisory_xact_lock(hashtextextended('${CONTRACT}',0)) THEN RAISE EXCEPTION 'GRAPH_ACL_BUSY';END IF;
 -- Stabilize identities, SET ROLE edges, schema ACLs and receipt default grants.
 -- SHARE admits normal catalog readers; concurrent administrative DDL may wait.
 LOCK TABLE pg_catalog.pg_authid,pg_catalog.pg_auth_members,pg_catalog.pg_database,pg_catalog.pg_namespace,pg_catalog.pg_default_acl,pg_catalog.pg_db_role_setting IN SHARE MODE;
 LOCK TABLE crm_graph_candidate.control IN ACCESS EXCLUSIVE MODE;
 PERFORM 1 FROM crm_maintenance_candidate.control WHERE singleton FOR SHARE;
 SELECT to_jsonb(m) INTO actual FROM (${METADATA_BODY}) m;
 IF actual IS DISTINCT FROM ${lit(JSON.stringify(before))}::jsonb THEN RAISE EXCEPTION 'GRAPH_ACL_PREFLIGHT_DRIFT';END IF;
 ${B.DDL}
 FOR target IN SELECT value FROM jsonb_array_elements(${lit(JSON.stringify(before.dependent_roles))}::jsonb) LOOP
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I',target->>'name');
 END LOOP;
 REVOKE CREATE ON SCHEMA public FROM PUBLIC;
 CREATE SCHEMA ${SCHEMA};
 REVOKE ALL ON SCHEMA ${SCHEMA} FROM PUBLIC;
 CREATE TABLE ${SCHEMA}.receipt(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),contract text NOT NULL,nonce uuid NOT NULL UNIQUE,retired jsonb NOT NULL,before_state jsonb NOT NULL,after_state jsonb NOT NULL,completed_at timestamptz NOT NULL DEFAULT clock_timestamp());
 REVOKE ALL ON ${SCHEMA}.receipt FROM PUBLIC;
 SELECT to_jsonb(m) INTO actual FROM (${METADATA_BODY}) m;
 IF actual->'graph_state'->>'control_xmin' IS NOT DISTINCT FROM ${lit(before.graph_state.control_xmin)} THEN RAISE EXCEPTION 'GRAPH_ACL_RETIREMENT_ROW_VERSION';END IF;
 IF actual->'graph_state'->>'graph_shape' IS NOT DISTINCT FROM ${lit(before.graph_state.graph_shape)} THEN RAISE EXCEPTION 'GRAPH_ACL_RETIREMENT_SHAPE';END IF;
 IF actual IS DISTINCT FROM jsonb_set(jsonb_set(${lit(JSON.stringify(after))}::jsonb,'{graph_state,graph_shape}',actual->'graph_state'->'graph_shape'),'{graph_state,control_xmin}',actual->'graph_state'->'control_xmin') THEN RAISE EXCEPTION 'GRAPH_ACL_PRESERVATION_FAILED';END IF;
 INSERT INTO ${SCHEMA}.receipt(contract,nonce,retired,before_state,after_state) VALUES(${lit(CONTRACT)},${lit(nonce)}::uuid,${lit(JSON.stringify(retired))}::jsonb,${lit(JSON.stringify(before))}::jsonb,actual);
END $acl_preservation$;`;
 return {sql,nonce,before,after,retired};
}
function sources(root){return {...G.sources(root),...Object.fromEntries(FILES.map(f=>[f,sha(fs.readFileSync(path.join(root,f),'utf8'))]))};}
class Installer{
 constructor({root,io,store}){this.root=root;this.io=io;this.store=store;}
 async snapshot(){return {metadata:await this.io.metadata(),identity:await this.io.identity()};}
 async prepare(guard){
  check(!this.store.has('plan'),'PLAN_EXISTS');const before=await this.snapshot();this.store.put('before',before);
  check(guard?.snapshot_sha256===sha(before),'UNREVIEWED_SNAPSHOT');check(before.metadata.database==='listmonk','DATABASE_SCOPE');preflight(before.metadata);
  const migration=atomicInstall(before.metadata,crypto.randomUUID(),guard.retired);const p={contract:CONTRACT,before,migration,sources:sources(this.root)};p.hash=sha(p);this.store.put('plan',p);return this.summary(p);
 }
 plan(){const p=this.store.read('plan'),{hash,...body}=p;check(p.contract===CONTRACT&&sha(body)===hash,'PLAN_HASH');check(same(sources(this.root),p.sources),'SOURCE_DRIFT');return p;}
 summary(p){return {contract:CONTRACT,plan_hash:p.hash,sql_hash:sha(p.migration.sql),existing_roles_preserved:p.before.metadata.roles.length,direct_create_grants:p.before.metadata.dependent_roles.map(r=>r.name),new_unaffiliated_roles_create:false,worker_created:false,retired:p.migration.retired};}
 async install(hash){
  const p=this.plan();check(hash===p.hash,'PLAN_APPROVAL');check(!this.store.has('install-intent'),'UNCERTAIN_RECONCILE');
  const fresh=await this.snapshot();this.store.put('fresh-'+crypto.randomUUID(),fresh);check(same(fresh,p.before),'PREFLIGHT_DRIFT');
  this.store.put('install-intent',{at:new Date().toISOString(),plan_hash:hash,sql_hash:sha(p.migration.sql)});
  const response=await this.io.sql(p.migration.sql);this.store.put('install-response',{response});return this.verify(true);
 }
 async verify(record=false){
  const p=this.plan(),fresh=await this.snapshot();this.store.put('readback-'+crypto.randomUUID(),fresh);
  check(same(fresh.identity,p.before.identity),'TRANSPORT_DRIFT');B.verify(p.migration.before,fresh.metadata);check(same(fresh.metadata,expectedAfter(p.migration.before,fresh.metadata.graph_state.graph_shape,fresh.metadata.graph_state.control_xmin)),'STATE_UNCONFIRMED');
  const receipt=await this.io.receipt();check(receipt?.contract===CONTRACT&&receipt.nonce===p.migration.nonce&&same(receipt.before_state,p.migration.before)&&same(receipt.after_state,fresh.metadata)&&same(receipt.retired,p.migration.retired),'RECEIPT_UNCONFIRMED');
  const result={...this.summary(p),installed:true,readback_verified:true,public_create:false};if(record)this.store.put('install-verified',result);return result;
 }
 async reconcile(){check(this.store.has('install-intent')&&!this.store.has('install-verified'),'RECONCILE_STATE');return this.verify(true);}
}
module.exports={CONTRACT,SCHEMA,METADATA_SQL,RECEIPT_SQL,preflight,expectedAfter,atomicInstall,Installer,FileStore,sha,canonical};
