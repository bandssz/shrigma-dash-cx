'use strict';
// Native CI only; no socket, env inspection or tests start on import.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const A=require('./activation.cjs'),F=require('../crm-manager-install-review/native-fixture.cjs');
const R=require('../../tests/crm-manager-provision-postgres.test.cjs');
const {proveTransactionTimeout500}=require('../crm-manager-install-review/native-transaction-timeout-proof.cjs');
const BROKER_ADMISSION_SQL="SELECT current_database()='listmonk' AS database_ok,session_user='crm_manager_provisioner' AS session_ok,current_user=session_user AS actor_ok,current_setting('server_version_num')::int/10000=17 AS version_ok,coalesce((SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=2 FROM pg_roles WHERE rolname=session_user),false) AS role_ok,NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=session_user) AS memberships_ok,has_function_privilege(session_user,'public.shrigma_crm_manager_prepare_v1(jsonb)','EXECUTE') AND has_function_privilege(session_user,'public.shrigma_crm_manager_commit_v1(jsonb)','EXECUTE') AND has_function_privilege(session_user,'public.shrigma_crm_manager_revoke_v1(jsonb)','EXECUTE') AND has_function_privilege(session_user,'public.shrigma_crm_manager_status_v1(jsonb)','EXECUTE') AND NOT has_function_privilege(session_user,'public.shrigma_crm_manager_apply_v1(jsonb,text)','EXECUTE') AND NOT has_function_privilege(session_user,'public.shrigma_crm_manager_canonical_v1(jsonb)','EXECUTE') AND NOT has_function_privilege(session_user,'public.shrigma_crm_manager_error_v1(jsonb,uuid,uuid,text)','EXECUTE') AS rpc_ok,NOT has_schema_privilege(session_user,'public','CREATE') AND NOT has_database_privilege(session_user,current_database(),'CREATE') AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['crm_dash_chave','shrigma_panel_permission_v1','shrigma_crm_manager_issuer_v1','shrigma_crm_manager_subject_v1','shrigma_crm_manager_operation_v1','shrigma_crm_manager_generation_v1']) t WHERE has_table_privilege(session_user,'public.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(session_user,'public.'||t,'SELECT,INSERT,UPDATE')) AS table_scope_ok,coalesce((SELECT ssl=false FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false) AND current_setting('ssl')='off' AS tls_ok";
const BROKER_ADMISSION_KEYS=Object.freeze(["database_ok","session_ok","actor_ok","version_ok","role_ok","memberships_ok","rpc_ok","table_scope_ok","tls_ok"]);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const refused=e=>e?.code==='P0001'&&e?.message==='READ_ACTIVATION_REVIEW_REFUSED';
function credential(){
 const password=crypto.randomBytes(32).toString('base64url'),salt=crypto.randomBytes(16);
 const salted=crypto.pbkdf2Sync(password,salt,4096,32,'sha256');
 const key=crypto.createHmac('sha256',salted).update('Client Key').digest();
 const stored=crypto.createHash('sha256').update(key).digest(),server=crypto.createHmac('sha256',salted).update('Server Key').digest();
 return {password,verifier:'SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+stored.toString('base64')+':'+server.toString('base64')};
}
async function checked(t,name,fn){
 return t.test(name,async()=>{try{await fn();}catch{throw Error('NATIVE_READ_ACTIVATION_PROOF_FAILED');}});
}
async function prove(t,{Client}){
 const db=await F.createNativeFixture(Client),secret=credential();
 try{
  // Prove native 25P04 rollback/lock release before installing this fixture.
  const emptyBaseline=await F.legacySnapshot(db);
  await proveTransactionTimeout500(t,{Client,db,baseline:emptyBaseline});
  // Match the observed real extension class in this disposable DB only.
  await db.exec("CREATE EXTENSION pgcrypto VERSION '1.3'");
  assert.deepEqual((await db.query("SELECT extversion FROM pg_extension WHERE extname='pgcrypto'")).rows,[{extversion:'1.3'}]);
  const baseline=await F.legacySnapshot(db);
  await db.exec(F.source('installer.sql'));await F.assertInstalled(db);
  async function inspect(phase){
   const p=A.buildPlan('stage');
   await db.exec("SET transaction_timeout='500ms';SELECT pg_stat_clear_snapshot();");
   assert.equal((await db.query("SELECT current_setting('transaction_timeout') AS timeout")).rows[0].timeout,'500ms');
   await db.exec(p.readOnlyBegin.text);
   try{
    await db.query(p.scopeQuery.text,p.scopeQuery.values);
    const rows=F.flattenRows(await db.exec(p.readback.text));assert.equal(rows.length,3);
    return A.admitSnapshot({profileSha256:rows[0].profile_sha256,objects:rows[1],state:rows[2].state},phase);
   }finally{await db.exec('ROLLBACK');}
  }
  async function dispatch(p){
   for(const q of p.commands)await db.query(q.text,q.values);
   const policy=A.admitPolicy((await db.query(p.policyQuery.text)).rows[0].policy);
   assert.equal(policy.phase,'supported');assert.equal(policy.pgcryptoPresent,true);assert.equal(policy.pgcryptoVersionSupported,true);
   assert.equal((await db.query("SELECT current_setting('transaction_timeout') AS timeout")).rows[0].timeout,'500ms');
   if(p.requiresSecret){const q=p.passwordQuery(secret.verifier);assert.deepEqual((await db.query(q.text,q.values)).rows,[{accepted:true}]);}
   await db.exec(p.mutating.text);
   assert.equal((await db.exec(p.commit.text)).command,'COMMIT');
   return inspect(p.after);
  }
  async function service(fn,{wrong=false}={}){
   // Actual authenticated pg Client, not SET SESSION AUTHORIZATION.
   // This is the known synthetic loopback:5438 fixture, NOT production alias.
   const original=F.clientConfig();
   assert.deepEqual({host:original.host,port:original.port,database:original.database,user:original.user},{host:'127.0.0.1',port:5438,database:'listmonk',user:'postgres'});
   const client=new Client({...original,user:A.SPEC.loginRole,password:wrong?secret.password+'-wrong':secret.password,application_name:'shrigma-manager-read-activation-private-fixture'});
   try{
    if(wrong){await assert.rejects(client.connect(),e=>e?.code==='28P01');return;}
    await client.connect();
    const identity=(await client.query("SELECT current_database() AS database,current_user AS actor,session_user AS session_role,current_setting('server_version_num')::int/10000 AS major,current_setting('cluster_name') AS cluster")).rows[0];
    assert.deepEqual(identity,{database:'listmonk',actor:A.SPEC.loginRole,session_role:A.SPEC.loginRole,major:17,cluster:'shrigma-native-v3-disposable-only'});
    return await fn(client);
   }finally{try{await client.end();}catch{}}
  }
  const status={schema:'crm-manager-provision-request-v1',issuerId:A.SPEC.issuerId,namespaceId:A.SPEC.namespaceId,action:'status',operationId:'33333333-1234-4234-8234-123456789abc',expectedRequestSha256:'0'.repeat(64)};
  const rpc=async(client,name,request)=>(await client.query('SELECT public.shrigma_crm_manager_'+name+'_v1($1::jsonb) AS body',[R.canonical(request)])).rows[0].body;
  await checked(t,'native17 pgcrypto1.3 leaves core4f; exact stage stays inactive/no PREP in500ms',async()=>{
   assert.equal((await inspect('empty')).phase,'empty');
   assert.equal((await dispatch(A.buildPlan('stage'))).phase,'staged');
   const s=(await inspect('staged'));assert.deepEqual(s.counts,{subjects:0,operations:0,generations:0,liveKeys:0});
  });
  await checked(t,'native17 own SCRAM password enforced; inactive issuer denies STATUS',async()=>{
   await service(()=>{}, {wrong:true});
   await service(async client=>{const body=await rpc(client,'status',status);assert.equal(body.schema,'crm-manager-provision-error-v1');assert.equal(body.code,'ISSUER_DENIED');});
   assert.equal((await inspect('staged')).counts.operations,0);
  });
  await checked(t,'native17 exact activation; broker admission SQL9true plus foundfalse under real serviceClient',async()=>{
   assert.equal((await dispatch(A.buildPlan('activate'))).phase,'active');
   assert.equal(sha(BROKER_ADMISSION_SQL),'061b26a7034191e0c79c6980e7afdb79e114d2e0c1cf5c859ecde23c943a656b');
   await service(async client=>{
    const rows=(await client.query(BROKER_ADMISSION_SQL)).rows;assert.equal(rows.length,1);assert.deepEqual(Object.keys(rows[0]).sort(),[...BROKER_ADMISSION_KEYS].sort());assert.equal(BROKER_ADMISSION_KEYS.every(k=>rows[0][k]===true),true);
    await client.query('BEGIN READ ONLY');
    try{const body=await rpc(client,'status',status);assert.equal(body.schema,'crm-manager-provision-status-v1');assert.equal(body.found,false);assert.equal(body.issuerId,A.SPEC.issuerId);}finally{await client.query('ROLLBACK');}
    await assert.rejects(client.query('SELECT * FROM public.shrigma_crm_manager_issuer_v1'),e=>e?.code==='42501');
   });
   assert.deepEqual((await inspect('active')).counts,{subjects:0,operations:0,generations:0,liveKeys:0});
  });
  const q=R.createPrepare({issuerId:A.SPEC.issuerId,namespaceId:A.SPEC.namespaceId,owner:'synthetic-pilot@oaristocrata.com'});
  await checked(t,'native17 READcaps3 prepare only; deactivation refuses live controlled key without dropping data',async()=>{
   await service(async client=>{assert.equal((await rpc(client,'prepare',q)).state,'prepared');});
   const before=await inspect('active');assert.equal(before.counts.liveKeys,1);
   const p=A.buildPlan('disable',{fromPhase:'active'});
   try{for(const d of p.commands)await db.query(d.text,d.values);await assert.rejects(db.exec(p.mutating.text),refused);}finally{await db.exec('ROLLBACK');}
   assert.deepEqual(await inspect('active'),before);
   const caps=(await db.query('SELECT caps FROM public.shrigma_panel_permission_v1 WHERE principal_id=$1',[q.principalId])).rows;
   assert.deepEqual(caps,[{caps:['read_content','list_history','submission']}]);
  });
  await checked(t,'native17 reconcile/revoke then exact disable; receipts/admin/core preserved and LOGIN denied',async()=>{
   await service(async client=>{assert.equal((await rpc(client,'revoke',R.createRevoke(q))).state,'revoked');});
   const records=(await db.query('SELECT operation_id,request_sha256,response FROM public.shrigma_crm_manager_operation_v1 ORDER BY operation_id')).rows;
   assert.equal(records.length,2);
   const disabled=await dispatch(A.buildPlan('disable',{fromPhase:'active'}));assert.equal(disabled.phase,'disabled');assert.equal(disabled.counts.liveKeys,0);assert.equal(disabled.counts.operations,2);
   assert.deepEqual((await db.query('SELECT operation_id,request_sha256,response FROM public.shrigma_crm_manager_operation_v1 ORDER BY operation_id')).rows,records);
   const preserved=await F.legacySnapshot(db);
   // Exclude exactly the one NEW managed principal introduced by this fixture;
   // every preexisting identity/permission/catalog/default/grant stays exact.
   preserved.rows=preserved.rows.filter(k=>k.chave!==q.principalId);
   preserved.permissions=preserved.permissions.filter(p=>p.principal_id!==q.principalId);
   assert.deepEqual(preserved,baseline);
   const retained=(await db.query('SELECT ativo,revogada_em IS NOT NULL AS revoked FROM public.crm_dash_chave WHERE chave=$1',[q.principalId])).rows;
   assert.deepEqual(retained,[{ativo:false,revoked:true}]);
   const client=new Client({...F.clientConfig(),user:A.SPEC.loginRole,password:secret.password});
   try{await assert.rejects(client.connect(),e=>e?.code==='28000');}finally{try{await client.end();}catch{}}
  });
 }finally{secret.password='';secret.verifier='';try{await db.exec('ROLLBACK');}catch{}await db.close();}
}
if(require.main===module)test('READ activation exact SQL on a NEW native17 synthetic fixture',{timeout:120000},async t=>{
 try{
  assert.equal(process.env.CRM_MANAGER_V3_NATIVE_PROOF,'1');assert.equal(process.env.CRM_MANAGER_READ_ACTIVATION_NATIVE_PROOF,'1');
  assert.match(process.env.CRM_MANAGER_V3_CONTAINER||'',/^shrigma-manager-v3-proof-[0-9]+-[0-9]+$/);
  assert.equal(process.versions.node.split('.')[0],'22');
  const pg=require('pg');assert.equal(require('pg/package.json').version,'8.13.1');
  class QuietClient extends pg.Client{constructor(config){super(config);this.on('error',()=>{});}}
  await prove(t,{Client:QuietClient});
 }catch{throw Error('NATIVE_READ_ACTIVATION_PROOF_FAILED');}
});
module.exports=Object.freeze({prove});
