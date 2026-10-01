'use strict';
// Real composed graph, then a separately installed lifecycle migration in a
// disposable PG17.10. No production address, password generation, LOGIN or sends.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Client}=require('pg'),L=require('../tools/graph-runtime-lineage/deploy.cjs'),D=require('../tools/graph-worker-credential/deploy.cjs');
const A=require('../tools/graph-worker-access/contract.cjs'),G=require('../tools/graph-install/deploy.cjs');
const F=require('./graph-worker-credential-pg-fixture.cjs'),GF=require('./journey-graph-install-fixture.cjs');
const ROOT=path.join(__dirname,'..');let stage='isolation';
async function run(){
 assert.equal(process.env.CI,'true');assert.equal(process.env.GRAPH_RUNTIME_LINEAGE_TEST_ISOLATED,'1');
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');assert.equal(u.protocol,'postgres:');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'postgres');assert.equal(u.password,'synthetic-admin-password');assert.equal(u.pathname,'/listmonk');assert.equal(u.search,'');assert.equal(u.hash,'');assert.match(u.port,/^[0-9]{4,5}$/);assert.ok(Number(u.port)>=1024&&Number(u.port)<=65535);
 const options={connectionString:u.toString(),statement_timeout:20000,connectionTimeoutMillis:3000,options:'-c search_path=pg_catalog,public'},client=new Client(options),independent=new Client(options);
 let directory,writes=0;const read=async(c,sql)=>{const r=(await c.query(sql)).rows;assert.equal(r.length,1);return r[0];};
 try{
  await client.connect();await independent.connect();stage='real_graph_base';const installed=await F.installGraph(client),original=await read(client,D.METADATA_SQL),predecessor=F.predecessor(original.graph,original.worker_identity,installed.migration),originalSeal=JSON.parse(original.graph.graph_seal),rows=await GF.rowSnapshot({query:client.query.bind(client)});
  stage='real_lifecycle_addition';const sourcePath='n8n/growth/journey-graph-lifecycle-prepare.sql',source=fs.readFileSync(path.join(ROOT,sourcePath),'utf8');await client.query(source);
  const before=await read(client,D.METADATA_SQL);assert.notEqual(before.graph.graph_shape,original.graph.graph_shape);assert.equal(before.graph.graph_seal,original.graph.graph_seal);assert.deepEqual(before.worker_identity,original.worker_identity);assert.deepEqual(before.auth,original.auth);
  assert.throws(()=>A.validateOperational({metadata:{...before.graph,worker_role_identity:before.worker_identity},...predecessor}),/CURRENT_DRIFT/);
  const scopeReview=await F.scopeReview(options,before),sourcePins={[sourcePath]:D.sha(source)};
  const adoptionReview={contract:L.REVIEW,observed_metadata_hash:D.sha(before),historical_state_hash:D.sha(L.state(before)),catalog_evidence_hash:D.sha(scopeReview),effective_privilege_review_hash:D.sha({worker_before:original.worker_identity,worker_after:before.worker_identity}),native_stack_proof_hash:D.sha({original_graph:original.graph,installed_source:sourcePins}),approved_migrations:[{id:'lifecycle-prepare',sources:sourcePins,terminal_receipt_hash:D.sha({source:sourcePins,installed_metadata_hash:D.sha(before)})}],sources:sourcePins};
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'graph-runtime-native-'));const store=new L.FileStore(directory);
  const identity={target:{database:'listmonk',role:'postgres',isolated:true},workflows:G.WORKFLOWS.map(id=>({id,version:'synthetic-native-v1',hash:'3'.repeat(64),pg_ids:['synthetic-pg']})),utility:{ids:['synthetic-pg'],version:'synthetic-native-v1',node_hash:'4'.repeat(64)}};
  const snapshot=async c=>({metadata:await read(c,D.METADATA_SQL),identity,session_pid:(await read(c,'SELECT pg_backend_pid() pid')).pid});
  const io={snapshot:()=>snapshot(client),independentReadback:()=>snapshot(independent),scopeAudit:()=>F.scopeReview(options,before),sql:async sql=>{writes++;assert.equal(store.has('adopt-intent'),true);await client.query(sql);throw Error('SYNTHETIC_LOST_ACK');}};
  const adopter=new L.Adopter({root:ROOT,io,store});stage='prepare';const plan=await adopter.prepare({snapshot_sha256:D.sha(await io.snapshot()),predecessor,scopeReview,adoptionReview});
  stage='catalog_drift_before_intent';await client.query('ALTER TABLE crm_graph_candidate.lifecycle_review_v1 DISABLE TRIGGER lifecycle_review_immutable');
  await assert.rejects(()=>adopter.adopt(plan.plan_hash),/PREFLIGHT_DRIFT/);assert.equal(writes,0);assert.equal(store.has('adopt-intent'),false);await client.query('ALTER TABLE crm_graph_candidate.lifecycle_review_v1 ENABLE TRIGGER lifecycle_review_immutable');
  assert.deepEqual(await read(client,D.METADATA_SQL),before);
  stage='bounded_atomic_comment';await assert.rejects(()=>adopter.adopt(plan.plan_hash),/WRITE_UNCONFIRMED/);assert.equal(writes,1);assert.equal(store.has('adopt-verified'),false);
  stage='independent_commit_reconcile';const result=await adopter.reconcile();assert.equal(result.lineage_adopted,true);assert.equal(result.worker_login,false);assert.equal(result.credential_prepared,false);assert.equal(result.execution_enabled,false);assert.equal(writes,1);
  const after=await read(independent,D.METADATA_SQL),afterSeal=JSON.parse(after.graph.graph_seal),{runtime_lineage_extension,...old}=afterSeal;assert.deepEqual(old,originalSeal);assert.equal(runtime_lineage_extension.graph_shape,before.graph.graph_shape);
  assert.deepEqual(after.auth,original.auth);assert.deepEqual(after.worker_identity,original.worker_identity);assert.deepEqual(await GF.rowSnapshot({query:client.query.bind(client)}),rows);
  assert.equal((await read(client,'SELECT rolcanlogin AS login,rolpassword IS NULL AS password_null FROM pg_authid WHERE rolname=\'crm_graph_worker\'')).password_null,true);
  stage='credentials_accept_preserved_runtime_chain';const keyBytes=Buffer.alloc(192,42),key={public_key_b64:keyBytes.toString('base64'),key_sha256:D.shaBytes(keyBytes),key_fingerprint:'a'.repeat(40),nonce:'10000000-0000-4000-8000-000000000033'};key.validation_receipt_hash=D.sha({contract:D.KEY_CONTRACT,version:1,role:'crm_graph_worker',database:'listmonk',nonce:key.nonce,key_sha256:key.key_sha256,key_fingerprint:key.key_fingerprint});
  const currentScope=await F.scopeReview(options,after);assert.deepEqual(currentScope,scopeReview);
  const credentialCandidate=D.atomicPrepare(after,{predecessor:store.read('plan').migration.predecessor,scopeReview:currentScope,publicKey:key});assert.match(credentialCandidate.sql,/^DO \$credential_prepare\$/);assert.equal(writes,1);
  await assert.rejects(()=>adopter.adopt(plan.plan_hash),/UNCERTAIN_RECONCILE/);
  console.log(JSON.stringify({contract:'crm-graph-runtime-lineage-native-proof-v1',success:true,postgres:'17.10',real_graph_install:true,real_lifecycle_prepare:true,old_seal_preserved:true,preintent_catalog_drift_blocked:true,lost_ack_get_only_reconciled:true,independent_commit:true,credential_render_accepts_runtime_predecessor:true,worker_login:false,password_null:true,graph_data_unchanged:true,adoption_sql_writes:1,credential_sql_writes:0,sends:0,production_changed:false}));
 }finally{await Promise.allSettled([client.end(),independent.end()]);if(directory)fs.rmSync(directory,{recursive:true,force:true});}
}
run().catch(e=>{console.error('GRAPH_RUNTIME_LINEAGE_NATIVE_FAILED '+stage+' '+e.message);process.exit(1);});
