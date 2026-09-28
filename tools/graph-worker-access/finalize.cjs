'use strict';
// Explicit NOLOGIN -> LOGIN transition after a separately committed encrypted
// preparation. No password, reset, grants, source admission or service operation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const D=require('../graph-worker-credential/deploy.cjs'),A=require('./contract.cjs');
const {sha,canonical,FileStore}=D;
const CONTRACT='crm-graph-worker-access-finalize-v1';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),same=(a,b)=>canonical(a)===canonical(b),clone=x=>JSON.parse(JSON.stringify(x));
const keys=(x,n)=>object(x)&&same(Object.keys(x).sort(),n.slice().sort()),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const lit=x=>"'"+String(x).replaceAll("'","''")+"'";
function check(ok,code){if(!ok)throw Error('GRAPH_WORKER_FINALIZE_'+code);}
function normalizeMetadata(value){const m=clone(value);for(const field of ['graph_seal','maintenance_seal']){if(typeof m.graph?.[field]==='string')m.graph[field]=JSON.parse(m.graph[field]);}return m;}
function state(metadata){const m=normalizeMetadata(metadata);return {graph_seal:m.graph.graph_seal,maintenance_seal:m.graph.maintenance_seal,role_identity:clone(m.worker_identity)};}
function operational(metadata){return {...metadata.graph,worker_role_identity:metadata.worker_identity};}
function validatePrepared(proof,before,root){
 check(keys(proof,['plan','verified','receipt','reviewed']),'PREPARED_PROOF');const {plan:p,verified:v,receipt:r,reviewed:pins}=proof;
 check(keys(pins,['plan_hash','verified_hash','receipt_hash','sources'])&&['plan_hash','verified_hash','receipt_hash'].every(k=>digest(pins[k])),'PREPARED_PINS');
 check(object(p)&&p.contract===D.CONTRACT&&p.hash===pins.plan_hash,'PREPARED_PLAN');const {hash,...body}=p;
 check(hash===sha(body)&&same(p.sources,pins.sources)&&same(p.sources,D.sources(root)),'PREPARED_SOURCES');
 check(sha(v)===pins.verified_hash&&v?.plan_hash===p.hash&&v.sql_hash===sha(p.migration.sql)&&v.credential_prepared===true&&v.readback_verified===true&&v.independent_commit_verified===true&&v.worker_login===false&&v.execution_enabled===false,'PREPARED_VERIFIED');
 check(sha(r)===pins.receipt_hash&&v.receipt_hash===pins.receipt_hash&&v.auth_proof_hash===r.auth_proof_hash&&v.ciphertext_sha256===r.ciphertext_sha256&&v.after_state_hash===sha(r.after_state),'PREPARED_RECEIPT');
 D.preflight(p.before.metadata,p.inputs);check(same(D.atomicPrepare(p.before.metadata,p.inputs),p.migration),'PREPARED_SQL');
 D.expectedAfter(p.before.metadata,before.metadata);D.validateReceipt(r,p.before.metadata,before.metadata,p.migration);
 check(same(before.identity,p.before.identity),'PREPARED_TRANSPORT');return proof;
}
function recoveryProof(proof,prepared){
 const r=prepared.receipt;
 check(keys(proof,['contract','role','database','nonce','key_sha256','key_fingerprint','validation_receipt_hash','ciphertext_sha256','receipt_hash','recovered_in_memory'])&&proof.contract==='crm-graph-worker-recovery-v1'&&proof.role==='crm_graph_worker'&&proof.database==='listmonk'&&proof.recovered_in_memory===true&&proof.receipt_hash===sha(r)&&['nonce','key_sha256','key_fingerprint','validation_receipt_hash','ciphertext_sha256'].every(k=>proof[k]===r[k]),'RECOVERY_PROOF');
 // Trusted operator attestation, pinned before writing. This is not an online
 // PostgreSQL authentication result and never contains a password or its hash.
 return proof;
}
function sources(root){return {...D.sources(root),...Object.fromEntries(['tools/graph-worker-access/finalize.cjs','tools/graph-worker-access/snapshot.cjs'].map(f=>[f,sha(fs.readFileSync(path.join(root,f),'utf8'))]))};}
function receiptGuard(receipt){
 const fields=['contract','nonce','role_oid','key_sha256','key_fingerprint','validation_receipt_hash','predecessor_hash','scope_hash','ciphertext_sha256','auth_proof_hash'];
 return `IF (SELECT count(*) FROM ${D.SCHEMA}.receipt)<>1 OR NOT EXISTS(SELECT 1 FROM ${D.SCHEMA}.receipt r WHERE r.singleton AND ${fields.map(k=>`r.${k}::text=${lit(receipt[k])}`).join(' AND ')} AND pg_catalog.to_char(r.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=${lit(receipt.completed_at)} AND pg_catalog.encode(pg_catalog.sha256(r.ciphertext),'hex')=r.ciphertext_sha256 AND r.before_state=${lit(JSON.stringify(receipt.before_state))}::jsonb AND r.after_state=${lit(JSON.stringify(receipt.after_state))}::jsonb) THEN RAISE EXCEPTION 'GRAPH_WORKER_FINALIZE_RECEIPT_DRIFT';END IF;`;
}
function atomicFinalize({root,before,preparedProof,scopeReview,recovery,nonce}){
 D.snapshot(before);validatePrepared(preparedProof,before,root);recoveryProof(recovery,preparedProof);check(uuid(nonce),'NONCE');
 check(object(scopeReview)&&scopeReview.scope_hash===sha(scopeReview.connection_scope)&&same(scopeReview.database_inventory,before.metadata.database_inventory),'SCOPE');
 A.validateConnectionScope(scopeReview.connection_scope,before.metadata.worker_identity.oid,scopeReview);
 const original=preparedProof.plan.inputs.predecessor;
 A.validateOperational({metadata:operational(before.metadata),...original});
 const prior=state(before.metadata),nextRole={...prior.role_identity.role,login:true};check(prior.role_identity.role.login===false,'ALREADY_LOGIN');
 const body=`IF pg_catalog.current_setting('transaction_isolation')<>'read committed' OR pg_catalog.current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'GRAPH_WORKER_FINALIZE_ISOLATION';END IF;
 IF (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 30000 THEN RAISE EXCEPTION 'GRAPH_WORKER_FINALIZE_TIMEOUT';END IF;
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('maintenance-cart-install',0)) OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('crm-graph-install',0)) OR NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('crm-graph-worker-access',0)) THEN RAISE EXCEPTION 'GRAPH_WORKER_FINALIZE_BUSY';END IF;
 LOCK TABLE pg_catalog.pg_authid,pg_catalog.pg_auth_members,pg_catalog.pg_database,pg_catalog.pg_namespace,pg_catalog.pg_default_acl,pg_catalog.pg_db_role_setting,pg_catalog.pg_proc,pg_catalog.pg_depend,pg_catalog.pg_extension,pg_catalog.pg_event_trigger IN SHARE MODE;
 LOCK TABLE crm_graph_candidate.control,crm_graph_candidate.cart_control_v1,crm_graph_candidate.cart_epoch_v1,crm_graph_candidate.cart_owner_v1,crm_graph_candidate.source_event_v1,crm_graph_candidate.native_template_v1,crm_maintenance_candidate.control,${D.SCHEMA}.receipt IN SHARE MODE;
 SELECT pg_catalog.to_jsonb(m) INTO actual FROM (${D.METADATA_BODY}) m;
 IF actual IS DISTINCT FROM ${lit(JSON.stringify(before.metadata))}::jsonb THEN RAISE EXCEPTION 'GRAPH_WORKER_FINALIZE_PREFLIGHT_DRIFT';END IF;
 ${receiptGuard(preparedProof.receipt)}
 ALTER ROLE crm_graph_worker LOGIN;
 IF ${D.catalogSQL(A.ROLE_IDENTITY_SQL)} IS DISTINCT FROM ${lit(JSON.stringify({...prior.role_identity,role:nextRole}))}::jsonb OR ${D.AUTH_SQL} IS DISTINCT FROM ${lit(JSON.stringify(before.metadata.auth))}::jsonb THEN RAISE EXCEPTION 'GRAPH_WORKER_FINALIZE_AUTH_DRIFT';END IF;`;
 const extension={contract:A.CONTRACT,nonce,ddl:sha(body),base_plan_hash:original.baseAnchor.reviewed.plan_hash,base_receipt_hash:original.baseAnchor.reviewed.receipt_hash,previous_graph_seal_hash:sha(prior.graph_seal),role_oid:prior.role_identity.oid,previous_role:clone(prior.graph_seal.worker_role),connection_scope_hash:scopeReview.scope_hash,credential_version:'pgp:'+preparedProof.receipt.nonce,auth_proof_hash:before.metadata.auth.auth_proof_hash};
 const after={graph_seal:{...prior.graph_seal,worker_role:nextRole,worker_access_extension:extension},maintenance_seal:clone(prior.maintenance_seal),role_identity:{...clone(prior.role_identity),role:nextRole}};
 const expected=normalizeMetadata(before.metadata);expected.worker_identity=clone(after.role_identity);expected.graph.worker_role=clone(nextRole);expected.graph.graph_seal=clone(after.graph_seal);
 const sql=`DO $worker_access$ DECLARE actual jsonb; BEGIN
 ${body}
 EXECUTE pg_catalog.format('COMMENT ON SCHEMA crm_graph_candidate IS %L',${lit(JSON.stringify(after.graph_seal))}::jsonb::text);
 SELECT pg_catalog.to_jsonb(m) INTO actual FROM (${D.METADATA_BODY}) m;
 actual:=pg_catalog.jsonb_set(pg_catalog.jsonb_set(actual,'{graph,graph_seal}',(actual#>>'{graph,graph_seal}')::jsonb),'{graph,maintenance_seal}',(actual#>>'{graph,maintenance_seal}')::jsonb);
 IF actual IS DISTINCT FROM ${lit(JSON.stringify(expected))}::jsonb THEN RAISE EXCEPTION 'GRAPH_WORKER_FINALIZE_AFTER_DRIFT';END IF;
END $worker_access$;`;
 check(!body.includes('$worker_access$')&&!JSON.stringify(expected).includes('$worker_access$'),'SQL_DELIMITER');
 const accessPlan={contract:A.CONTRACT,nonce,before:prior,connection_scope:clone(scopeReview.connection_scope),database_inventory:clone(scopeReview.database_inventory),auth_proof_hash:extension.auth_proof_hash,sources:sources(root),migration:{body,sql,extension}};accessPlan.hash=sha(accessPlan);
 const accessReceipt={contract:A.CONTRACT,nonce,plan_hash:accessPlan.hash,sql_hash:sha(sql),before:prior,after,connection_scope:clone(scopeReview.connection_scope),auth_proof_hash:extension.auth_proof_hash};
 const accessReview={plan_hash:accessPlan.hash,receipt_hash:sha(accessReceipt),sql_hash:sha(sql),body_hash:sha(body),sources:clone(accessPlan.sources),database_inventory:clone(scopeReview.database_inventory),diagnostic_read_exceptions:clone(scopeReview.diagnostic_read_exceptions)};
 const proof={baseAnchor:original.baseAnchor,accessPlan,accessReceipt,accessReview,txReceipt:original.txReceipt};
 A.validateOperational({metadata:operational({...expected,graph:{...expected.graph,graph_seal:after.graph_seal,maintenance_seal:after.maintenance_seal}}),...proof});
 return {accessPlan,accessReceipt,accessReview,expected_metadata:expected};
}
class Finalizer{
 constructor({root,io,store}){this.root=root;this.io=io;this.store=store;}
 async snapshot(){const value=await this.io.snapshot();check(object(value)&&Object.hasOwn(value,'receipt'),'SNAPSHOT');const {receipt,...base}=value;D.snapshot(base);return {...base,receipt};}
 async auditScope(expected,login){
  check(typeof this.io.scopeAudit==='function','LIVE_SCOPE_REQUIRED');
  // The trusted adapter must perform new catalog reads on EVERY invocation.
  // Fingerprints normalize only the expected NOLOGIN->LOGIN bit after checking
  // its actual value; all grants, OIDs, objects, settings and diagnostics stay
  // covered. A reviewed file alone is not an implementation of this callback.
  const actual=await this.io.scopeAudit({worker_login:login});
  check(same(actual,expected),'LIVE_SCOPE_DRIFT');
  A.validateConnectionScope(actual.connection_scope,actual.connection_scope.role_oid,actual);
 }
 async prepare(guard){
  check(!this.store.has('plan'),'PLAN_EXISTS');const captured=await this.snapshot();this.store.put('before',captured);check(guard?.snapshot_sha256===sha(captured),'UNREVIEWED_SNAPSHOT');
  const {receipt,...before}=captured;check(same(receipt,guard.preparedProof?.receipt),'CURRENT_RECEIPT');
  await this.auditScope(guard.scopeReview,false);
  const inputs={preparedProof:guard.preparedProof,scopeReview:guard.scopeReview,recovery:guard.recovery,nonce:crypto.randomUUID()};
  const migration=atomicFinalize({root:this.root,before,...inputs});const p={contract:CONTRACT,before,inputs,migration,sources:sources(this.root)};p.hash=sha(p);this.store.put('plan',p);return this.summary(p);
 }
 plan(){const p=this.store.read('plan'),{hash,...body}=p;check(p.contract===CONTRACT&&sha(body)===hash&&same(p.sources,sources(this.root)),'PLAN_OR_SOURCE_DRIFT');check(same(p.migration,atomicFinalize({root:this.root,before:p.before,...p.inputs})),'MIGRATION_DRIFT');return p;}
 summary(p){return {contract:CONTRACT,plan_hash:p.hash,access_plan_hash:p.migration.accessPlan.hash,sql_hash:sha(p.migration.accessPlan.migration.sql),role:'crm_graph_worker',role_oid:p.before.metadata.worker_identity.oid,login_enabled:false,online_auth_verified:false,execution_enabled:false,service_created:false};}
 async finalize(hash){
  const p=this.plan();check(hash===p.hash,'PLAN_APPROVAL');check(!this.store.has('finalize-intent'),'UNCERTAIN_RECONCILE');
  const captured=await this.snapshot(),{receipt,...fresh}=captured;this.store.put('fresh-'+crypto.randomUUID(),captured);
  check(same(fresh.metadata,p.before.metadata)&&same(fresh.identity,p.before.identity)&&same(receipt,p.inputs.preparedProof.receipt),'PREFLIGHT_DRIFT');
  await this.auditScope(p.inputs.scopeReview,false);
  this.store.put('finalize-intent',{plan_hash:hash,sql_hash:sha(p.migration.accessPlan.migration.sql),session_pid:fresh.session_pid});
  try{await this.io.sql(p.migration.accessPlan.migration.sql);this.store.put('finalize-response',{acknowledged:true});}catch{this.store.put('finalize-response',{acknowledged:false,code:'WRITE_UNCONFIRMED'});throw Error('GRAPH_WORKER_FINALIZE_WRITE_UNCONFIRMED');}
  return this.verify(true);
 }
 async verify(record=false){
  const p=this.plan();check(this.store.has('finalize-intent'),'INTENT_REQUIRED');let captured;try{captured=await this.io.independentReadback();}catch{throw Error('GRAPH_WORKER_FINALIZE_READBACK_UNCONFIRMED');}
  check(object(captured)&&Object.hasOwn(captured,'receipt'),'READBACK');const {receipt,...fresh}=captured;D.snapshot(fresh);this.store.put('readback-'+crypto.randomUUID(),captured);
  check(fresh.session_pid!==this.store.read('finalize-intent').session_pid,'INDEPENDENT_READBACK');
  check(same(fresh.identity,p.before.identity)&&same(receipt,p.inputs.preparedProof.receipt),'TRANSPORT_OR_RECEIPT_DRIFT');
  check(same(normalizeMetadata(fresh.metadata),p.migration.expected_metadata),'AFTER_DRIFT');
  await this.auditScope(p.inputs.scopeReview,true);
  const {accessPlan,accessReceipt,accessReview}=p.migration,predecessor=p.inputs.preparedProof.plan.inputs.predecessor;
  A.validateOperational({metadata:operational(fresh.metadata),...predecessor,accessPlan,accessReceipt,accessReview});
  const result={...this.summary(p),login_enabled:true,readback_verified:true,independent_commit_verified:true,auth_proof_hash:fresh.metadata.auth.auth_proof_hash,access_receipt_hash:sha(accessReceipt)};
  if(record){for(const [name,value] of [['access-receipt',accessReceipt],['access-review',accessReview],['finalize-verified',result]]){if(this.store.has(name))check(same(this.store.read(name),value),'LOCAL_EVIDENCE_DRIFT');else this.store.put(name,value);}}return result;
 }
 async reconcile(){check(this.store.has('finalize-intent')&&!this.store.has('finalize-verified'),'RECONCILE_STATE');return this.verify(true);}
}
module.exports={CONTRACT,Finalizer,FileStore,atomicFinalize,validatePrepared,recoveryProof,normalizeMetadata,sources};
