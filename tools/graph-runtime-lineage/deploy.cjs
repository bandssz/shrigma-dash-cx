'use strict';
// Explicit adoption of separately installed, reviewed runtime migrations.
// Preserves the entire historical seal and adds one independently pinned review.
// Does not install migrations, create credentials, grant privileges or enable LOGIN.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const D=require('../graph-worker-credential/deploy.cjs'),A=require('../graph-worker-access/contract.cjs');
const {canonical,sha,FileStore}=D,CONTRACT=A.RUNTIME,REVIEW='crm-graph-runtime-adoption-review-v1';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),same=(a,b)=>canonical(a)===canonical(b);
const keys=(x,n)=>object(x)&&same(Object.keys(x).sort(),n.slice().sort());
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),md5=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const copy=x=>JSON.parse(JSON.stringify(x)),lit=x=>"'"+String(x).replaceAll("'","''")+"'";
function check(ok,code){if(!ok)throw Error('GRAPH_RUNTIME_LINEAGE_'+code);}
function normalize(metadata){const m=copy(metadata);for(const k of ['graph_seal','maintenance_seal'])if(typeof m.graph?.[k]==='string')m.graph[k]=JSON.parse(m.graph[k]);return m;}
function state(metadata){const m=normalize(metadata);return {graph_seal:m.graph.graph_seal,maintenance_seal:m.graph.maintenance_seal,role_identity:m.worker_identity};}
const operational=m=>({...m.graph,worker_role_identity:m.worker_identity});
function sourceManifest(value){check(object(value)&&Object.keys(value).length>0&&Object.keys(value).length<=128&&Object.entries(value).every(([k,v])=>/^(?:n8n\/growth|tools|services\/crm-(?:audience|flows))\/[A-Za-z0-9._/-]+$/.test(k)&&!k.includes('..')&&digest(v)),'SOURCE_MANIFEST');}
function sources(root){return {...D.sources(root),'tools/graph-runtime-lineage/deploy.cjs':sha(fs.readFileSync(path.join(root,'tools/graph-runtime-lineage/deploy.cjs'),'utf8'))};}
function review(value,before,predecessor){
 check(keys(value,['contract','observed_metadata_hash','historical_state_hash','catalog_evidence_hash','effective_privilege_review_hash','native_stack_proof_hash','approved_migrations','sources'])&&value.contract===REVIEW&&['observed_metadata_hash','historical_state_hash','catalog_evidence_hash','effective_privilege_review_hash','native_stack_proof_hash'].every(k=>digest(value[k])),'ADOPTION_REVIEW');
 check(value.observed_metadata_hash===sha(before)&&value.historical_state_hash===sha(state(before)),'INDEPENDENT_METADATA_PIN');
 sourceManifest(value.sources);
 check(Array.isArray(value.approved_migrations)&&value.approved_migrations.length>0&&value.approved_migrations.length<=32,'MIGRATION_REVIEWS');
 let previous='';
 for(const m of value.approved_migrations){
  check(keys(m,['id','sources','terminal_receipt_hash'])&&typeof m.id==='string'&&/^[a-z][a-z0-9-]{0,95}$/.test(m.id)&&m.id>previous&&digest(m.terminal_receipt_hash),'MIGRATION_REVIEW');previous=m.id;sourceManifest(m.sources);
  check(Object.entries(m.sources).every(([k,v])=>value.sources[k]===v),'MIGRATION_SOURCE_PIN');
 }
 check(keys(predecessor,['baseAnchor','txReceipt']),'PREDECESSOR');
 A.validateHistoricalState({metadata:operational(before),...predecessor});return value;
}
function preflight(before,inputs){
 check(before?.database==='listmonk'&&before.role==='postgres'&&before.superuser===true&&before.server_version_num===170010&&before.standard_strings==='on'&&before.transaction_isolation==='read committed'&&before.transaction_read_only==='off','IDENTITY');
 check(Number.isInteger(before.statement_timeout_ms)&&before.statement_timeout_ms>0&&before.statement_timeout_ms<=30000&&same(before.search_schemas,['pg_catalog','public']),'SESSION');
 check(same(before.event_triggers,[])&&same(before.hooks,{shared_preload_libraries:'',session_preload_libraries:'',local_preload_libraries:'',pgaudit_log:null,auto_explain_log_min_duration:null}),'HOOKS');
 check(before.receipt_schema===null&&before.auth?.password_null===true&&before.auth.scram===false&&digest(before.auth.auth_proof_hash),'CREDENTIAL_ALREADY_PREPARED');
 check(same(before.off,{cart_off:true,epochs:'0',owners:'0',sources:'0',clones:'0'})&&same(before.graph?.graph_control,{singleton:true,enabled:false})&&before.graph?.maintenance_control?.enabled===true&&before.graph.maintenance_control.mode==='open'&&before.graph.maintenance_control.version===2&&before.graph.maintenance_control.cutoff_at===null&&same(before.graph.public_create_schemas,[]),'NOT_OFF');
 const reviewed=review(inputs.adoptionReview,before,inputs.predecessor),s=state(before);
 check(['graph_shape','public_shape','maintenance_shape','maintenance_legacy_shape'].every(k=>md5(before.graph[k]))&&before.graph.maintenance_shape===s.graph_seal.maintenance_shape&&before.graph.maintenance_legacy_shape===s.maintenance_seal.shape&&same(before.graph.worker_role,s.role_identity.role),'MAINTENANCE_OR_ROLE_DRIFT');
 check(object(inputs.scopeReview)&&inputs.scopeReview.scope_hash===sha(inputs.scopeReview.connection_scope)&&same(inputs.scopeReview.database_inventory,before.database_inventory),'SCOPE');
 A.validateConnectionScope(inputs.scopeReview.connection_scope,before.worker_identity.oid,inputs.scopeReview);
 return reviewed;
}
function atomicAdopt({root,before,inputs,nonce}){
 const reviewed=preflight(before,inputs);check(uuid(nonce),'NONCE');
 // Caller-reviewed migration bytes must still be the exact local release bytes.
 for(const [p,h] of Object.entries(reviewed.sources))check(sha(fs.readFileSync(path.join(root,p),'utf8'))===h,'REVIEWED_SOURCE_DRIFT');
 const prior=state(before),body=`IF pg_catalog.current_setting('transaction_isolation')<>'read committed' OR pg_catalog.current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'GRAPH_RUNTIME_LINEAGE_ISOLATION';END IF;
 IF (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 30000 THEN RAISE EXCEPTION 'GRAPH_RUNTIME_LINEAGE_TIMEOUT';END IF;
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('maintenance-cart-install',0)) OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('crm-graph-install',0)) OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('crm-graph-worker-access',0)) THEN RAISE EXCEPTION 'GRAPH_RUNTIME_LINEAGE_BUSY';END IF;
 LOCK TABLE pg_catalog.pg_authid,pg_catalog.pg_auth_members,pg_catalog.pg_database,pg_catalog.pg_namespace,pg_catalog.pg_description,pg_catalog.pg_default_acl,pg_catalog.pg_db_role_setting,pg_catalog.pg_proc,pg_catalog.pg_depend,pg_catalog.pg_extension,pg_catalog.pg_event_trigger,pg_catalog.pg_class,pg_catalog.pg_attribute,pg_catalog.pg_attrdef,pg_catalog.pg_constraint,pg_catalog.pg_trigger,pg_catalog.pg_index,pg_catalog.pg_sequence IN SHARE MODE;
 LOCK TABLE crm_graph_candidate.control,crm_graph_candidate.cart_control_v1,crm_graph_candidate.cart_epoch_v1,crm_graph_candidate.cart_owner_v1,crm_graph_candidate.source_event_v1,crm_graph_candidate.native_template_v1,crm_maintenance_candidate.control IN SHARE MODE;
 SELECT pg_catalog.to_jsonb(m) INTO actual FROM (${D.METADATA_BODY}) m;
 IF actual IS DISTINCT FROM ${lit(JSON.stringify(before))}::jsonb THEN RAISE EXCEPTION 'GRAPH_RUNTIME_LINEAGE_PREFLIGHT_DRIFT';END IF;`;
 const extension={contract:CONTRACT,nonce,ddl:sha(body),base_plan_hash:inputs.predecessor.baseAnchor.reviewed.plan_hash,base_receipt_hash:inputs.predecessor.baseAnchor.reviewed.receipt_hash,previous_graph_seal_hash:sha(prior.graph_seal),role_oid:prior.role_identity.oid,review_hash:sha(reviewed),observed_metadata_hash:sha(before),graph_shape:before.graph.graph_shape,public_shape:before.graph.public_shape};
 const after={...copy(prior),graph_seal:{...copy(prior.graph_seal),runtime_lineage_extension:extension}},expected=normalize(before);expected.graph.graph_seal=copy(after.graph_seal);
 const sql=`DO $graph_runtime_lineage$ DECLARE actual jsonb; BEGIN
 ${body}
 EXECUTE pg_catalog.format('COMMENT ON SCHEMA crm_graph_candidate IS %L',${lit(JSON.stringify(after.graph_seal))}::jsonb::text);
 SELECT pg_catalog.to_jsonb(m) INTO actual FROM (${D.METADATA_BODY}) m;
 actual:=pg_catalog.jsonb_set(pg_catalog.jsonb_set(actual,'{graph,graph_seal}',(actual#>>'{graph,graph_seal}')::jsonb),'{graph,maintenance_seal}',(actual#>>'{graph,maintenance_seal}')::jsonb);
 IF actual IS DISTINCT FROM ${lit(JSON.stringify(expected))}::jsonb THEN RAISE EXCEPTION 'GRAPH_RUNTIME_LINEAGE_AFTER_DRIFT';END IF;
END $graph_runtime_lineage$;`;
 check(!JSON.stringify(before).includes('$graph_runtime_lineage$')&&!JSON.stringify(expected).includes('$graph_runtime_lineage$'),'SQL_DELIMITER');
 const runtimePlan={contract:CONTRACT,nonce,before:prior,observed_metadata_hash:sha(before),adoption_review_hash:sha(reviewed),sources:sources(root),migration:{body,sql,extension}};runtimePlan.hash=sha(runtimePlan);
 const runtimeReceipt={contract:CONTRACT,nonce,plan_hash:runtimePlan.hash,sql_hash:sha(sql),before:prior,after,review_hash:sha(reviewed),observed_metadata_hash:sha(before)};
 const runtimeReview={plan_hash:runtimePlan.hash,receipt_hash:sha(runtimeReceipt),sql_hash:sha(sql),body_hash:sha(body),sources:copy(runtimePlan.sources),adoption_review_hash:sha(reviewed),observed_metadata_hash:sha(before)};
 const predecessor={...copy(inputs.predecessor),runtimePlan,runtimeReceipt,runtimeReview};
 A.validateOperational({metadata:operational(expected),...predecessor});
 return {runtimePlan,runtimeReceipt,runtimeReview,expected_metadata:expected,predecessor};
}
class Adopter{
 constructor({root,io,store}){this.root=root;this.io=io;this.store=store;}
 async snapshot(){return D.snapshot(await this.io.snapshot());}
 async auditScope(expected){check(typeof this.io.scopeAudit==='function','LIVE_SCOPE_REQUIRED');check(same(await this.io.scopeAudit({worker_login:false}),expected),'LIVE_SCOPE_DRIFT');}
 async prepare(guard){
  check(!this.store.has('plan'),'PLAN_EXISTS');const before=await this.snapshot();this.store.put('before',before);
  check(guard?.snapshot_sha256===sha(before),'UNREVIEWED_SNAPSHOT');
  const inputs={predecessor:guard.predecessor,scopeReview:guard.scopeReview,adoptionReview:guard.adoptionReview};
  await this.auditScope(inputs.scopeReview);const migration=atomicAdopt({root:this.root,before:before.metadata,inputs,nonce:crypto.randomUUID()});
  const p={contract:CONTRACT,before,inputs,migration,sources:sources(this.root)};p.hash=sha(p);this.store.put('plan',p);return this.summary(p);
 }
 plan(){const p=this.store.read('plan'),{hash,...body}=p;check(p.contract===CONTRACT&&sha(body)===hash&&same(p.sources,sources(this.root)),'PLAN_OR_SOURCE_DRIFT');check(same(p.migration,atomicAdopt({root:this.root,before:p.before.metadata,inputs:p.inputs,nonce:p.migration.runtimePlan.nonce})),'MIGRATION_DRIFT');return p;}
 summary(p){return {contract:CONTRACT,plan_hash:p.hash,runtime_plan_hash:p.migration.runtimePlan.hash,sql_hash:sha(p.migration.runtimePlan.migration.sql),lineage_adopted:false,worker_login:false,credential_prepared:false,execution_enabled:false};}
 async adopt(hash){
  const p=this.plan();check(hash===p.hash,'PLAN_APPROVAL');check(!this.store.has('adopt-intent'),'UNCERTAIN_RECONCILE');
  const fresh=await this.snapshot();this.store.put('fresh-'+crypto.randomUUID(),fresh);check(same(fresh.metadata,p.before.metadata)&&same(fresh.identity,p.before.identity),'PREFLIGHT_DRIFT');await this.auditScope(p.inputs.scopeReview);
  this.store.put('adopt-intent',{plan_hash:hash,sql_hash:sha(p.migration.runtimePlan.migration.sql),session_pid:fresh.session_pid});
  try{await this.io.sql(p.migration.runtimePlan.migration.sql);this.store.put('adopt-response',{acknowledged:true});}catch{this.store.put('adopt-response',{acknowledged:false,code:'WRITE_UNCONFIRMED'});throw Error('GRAPH_RUNTIME_LINEAGE_WRITE_UNCONFIRMED');}return this.verify();
 }
 async verify(){
  const p=this.plan();check(this.store.has('adopt-intent'),'INTENT_REQUIRED');let fresh;try{fresh=D.snapshot(await this.io.independentReadback());}catch{throw Error('GRAPH_RUNTIME_LINEAGE_READBACK_UNCONFIRMED');}
  this.store.put('readback-'+crypto.randomUUID(),fresh);check(fresh.session_pid!==this.store.read('adopt-intent').session_pid,'INDEPENDENT_READBACK');
  check(same(fresh.identity,p.before.identity)&&same(normalize(fresh.metadata),p.migration.expected_metadata),'AFTER_DRIFT');await this.auditScope(p.inputs.scopeReview);
  A.validateOperational({metadata:operational(fresh.metadata),...p.migration.predecessor});
  const result={...this.summary(p),lineage_adopted:true,readback_verified:true,independent_commit_verified:true,runtime_receipt_hash:sha(p.migration.runtimeReceipt)};
  for(const [name,value] of [['runtime-receipt',p.migration.runtimeReceipt],['runtime-review',p.migration.runtimeReview],['adopt-verified',result]]){if(this.store.has(name))check(same(this.store.read(name),value),'LOCAL_EVIDENCE_DRIFT');else this.store.put(name,value);}return result;
 }
 async reconcile(){check(this.store.has('adopt-intent')&&!this.store.has('adopt-verified'),'RECONCILE_STATE');return this.verify();}
}
module.exports={CONTRACT,REVIEW,Adopter,FileStore,atomicAdopt,preflight,review,normalize,state,sources};
