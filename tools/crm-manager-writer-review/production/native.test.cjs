'use strict';
// Fresh isolated native CI fixture only. Import performs no env/SQL/socket I/O.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const I=require('./installer.cjs'),A=require('../../crm-manager-read-activation-review/activation.cjs'),F=require('../../crm-manager-install-review/native-fixture.cjs'),R=require('../../../tests/crm-manager-provision-postgres.test.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function syntheticCredential(){const password=crypto.randomBytes(32).toString('base64url'),salt=crypto.randomBytes(16),salted=crypto.pbkdf2Sync(password,salt,4096,32,'sha256'),stored=crypto.createHash('sha256').update(crypto.createHmac('sha256',salted).update('Client Key').digest()).digest(),server=crypto.createHmac('sha256',salted).update('Server Key').digest();return{password,verifier:'SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+stored.toString('base64')+':'+server.toString('base64')};}
async function prove(t,{Client}){
 const db=await F.createNativeFixture(Client),secret=syntheticCredential();
 async function sub(name,fn){await t.test(name,async()=>{try{await fn();}catch{throw Error('WRITER_PRODUCTION_NATIVE_PROOF_FAILED');}});}
 async function budget(p){await db.exec(p.budget.text);assert.equal((await db.query("SELECT current_setting('transaction_timeout') AS v")).rows[0].v,'500ms');}
 async function snapshot(p){const r=F.flattenRows(await db.exec(p.readback.text));assert.equal(r.length,5);A.admitSnapshot({profileSha256:r[0].profile_sha256,objects:r[1],state:r[2].state},p.readPhase);return{readState:r[2].state,readCore:r[0].profile_sha256,legacy:r[3].legacy_sha256,counts:r[4]};}
 async function inspect(p){await budget(p);await db.exec(p.readOnlyBegin.text);try{await db.exec(p.logging.text);await db.query(p.scope.text,p.scope.values);await db.exec(p.legacyGuard.text);return await snapshot(p);}finally{await db.exec(p.rollback.text);}}
 async function mutate(action,phase){const p=I.buildPlan(action,phase),before=await inspect(p);await budget(p);await db.exec(p.begin.text);try{
  await db.exec(p.logging.text);await db.query(p.scope.text,p.scope.values);await db.exec(p.readGuard.text);await db.exec(p.locks.text);await db.exec(p.legacyGuard.text);assert.deepEqual(await snapshot(p),before);
  // Exact component body: no SQL substitution, SET ROLE or relaxed admission.
  await db.exec(p.mutating.text);await db.exec(p.readGuard.text);await db.exec(p.legacyGuard.text);const after=await snapshot(p);assert.equal(after.readCore,I.READ_CORE);assert.deepEqual(after.readState,before.readState);assert.equal(after.legacy,before.legacy);assert.deepEqual(after.counts,{context_verified:true,...(action==='install'?I.INSTALLED:I.ABSENT)});
  if(action==='install'){const r=F.flattenRows(await db.exec(p.writerProfile.text));assert.deepEqual(r[0],{issuer_empty:true,subject_empty:true,operation_empty:true,generation_empty:true});assert.equal(r[1].profile_sha256,I.PROFILE);}
  assert.equal((await db.exec(p.commit.text)).command,'COMMIT');const final=await inspect(p);assert.deepEqual(final,after);return final;
 }catch(e){try{await db.exec(p.rollback.text);}catch{}throw e;}}
 async function activation(p){for(const q of p.commands)await db.query(q.text,q.values);if(p.requiresSecret){const q=p.passwordQuery(secret.verifier);assert.equal((await db.query(q.text,q.values)).rows[0].accepted,true);}await db.exec(p.mutating.text);assert.equal((await db.exec(p.commit.text)).command,'COMMIT');}
 try{
  // All baseline writes belong to this CSPRNG-independent, EMPTY native fixture.
  await db.exec("CREATE EXTENSION pgcrypto VERSION '1.3'");await db.exec(F.source('installer.sql'));await F.assertInstalled(db);
  for(const phase of ['empty','staged'])await sub('PG17 exact 500ms WRITER install/rollback preserves READ '+phase,async()=>{if(phase==='staged')await activation(A.buildPlan('stage'));await mutate('install',phase);await mutate('rollback',phase);});
  await activation(A.buildPlan('activate'));
  const q=R.createPrepare({issuerId:A.SPEC.issuerId,namespaceId:A.SPEC.namespaceId,owner:'synthetic-native-pilot@oaristocrata.com'});
  await sub('READ active contains real fixture principal/receipt; WRITER does not mutate it',async()=>{
   const cfg=F.clientConfig();assert.equal(cfg.host,'127.0.0.1');assert.equal(cfg.port,5438);
   const service=new Client({...cfg,user:A.SPEC.loginRole,password:secret.password,application_name:'shrigma-writer-production-native-fixture'});
   try{await service.connect();const body=(await service.query('SELECT public.shrigma_crm_manager_prepare_v1($1::jsonb) AS body',[R.canonical(q)])).rows[0].body;assert.equal(body.state,'prepared');}finally{await service.end();}
   const readRows=await db.query('SELECT operation_id,request_sha256,response FROM public.shrigma_crm_manager_operation_v1 ORDER BY operation_id'),legacy=await F.legacySnapshot(db);
   await mutate('install','active');assert.deepEqual((await db.query('SELECT operation_id,request_sha256,response FROM public.shrigma_crm_manager_operation_v1 ORDER BY operation_id')).rows,readRows.rows);
   await mutate('rollback','active');assert.deepEqual(await F.legacySnapshot(db),legacy);
  });
  await sub('same TX legacy drift refuses install; no WRITER objects and no READ alteration',async()=>{
   const p=I.buildPlan('install','active'),before=await inspect(p);await budget(p);await db.exec(p.begin.text);
   try{await db.exec(p.logging.text);await db.query(p.scope.text,p.scope.values);await db.exec(p.readGuard.text);await db.exec(p.locks.text);await db.exec('ALTER TABLE public.crm_dash_chave ADD COLUMN synthetic_drift text');await assert.rejects(db.exec(p.legacyGuard.text),e=>e.code==='P0001'&&e.message==='WRITER_PRODUCTION_REFUSED');}finally{await db.exec(p.rollback.text);}
   assert.deepEqual(await inspect(p),before);
  });
  await sub('WRITER issuer rows refuse rollback; rollback keeps historical rows and READ current',async()=>{
   await mutate('install','active');const p=I.buildPlan('rollback','active');await budget(p);await db.exec("INSERT INTO public.crm_manager_writer_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains,active) VALUES('88888888-8888-4888-8888-888888888888','99999999-9999-4999-8999-999999999999','crm_manager_writer_service_v1',ARRAY['synthetic.test'],false)");await db.exec(p.begin.text);
   try{await db.exec(p.logging.text);await db.query(p.scope.text,p.scope.values);await db.exec(p.readGuard.text);await db.exec(p.locks.text);await assert.rejects(db.exec(p.mutating.text),e=>e.code==='P0001'&&e.message==='CRM_MANAGER_WRITER_EMPTY_ROLLBACK_REFUSED');}finally{await db.exec(p.rollback.text);}
   assert.deepEqual((await db.query('SELECT active FROM public.crm_manager_writer_issuer_v1')).rows,[{active:false}]);await db.exec('DELETE FROM public.crm_manager_writer_issuer_v1'); // This fixture owns its synthetic row; production runner has no DELETE.
   await mutate('rollback','active');
  });
  await sub('readonly same-intent catalog confirmation has no component query or DDL',async()=>{const p=I.buildPlan('reconcile','active'),s=await inspect(p);assert.equal(p.mutating,null);assert.deepEqual(s.counts,{context_verified:true,...I.ABSENT});assert.equal(s.readState.liveKeys,1);assert.equal(s.readState.operations,1);assert.equal(hash(JSON.stringify(s.readState)).length,64);});
 }finally{secret.password='';secret.verifier='';try{await db.exec('ROLLBACK');}catch{}await db.close();}
}
if(require.main===module)test('WRITER production SQL on fresh listmonk native PG17 fixture',{timeout:120000},async t=>{try{
 assert.equal(process.env.CRM_MANAGER_V3_NATIVE_PROOF,'1');assert.equal(process.env.CRM_WRITER_PRODUCTION_NATIVE_PROOF,'1');assert.match(process.env.CRM_MANAGER_V3_CONTAINER||'',/^shrigma-manager-v3-proof-[0-9]+-[0-9]+$/);assert.equal(process.versions.node.split('.')[0],'22');const pg=require('pg');assert.equal(require('pg/package.json').version,'8.13.1');class QuietClient extends pg.Client{constructor(p){super(p);this.on('error',()=>{});}}await prove(t,{Client:QuietClient});
 }catch{throw Error('WRITER_PRODUCTION_NATIVE_PROOF_FAILED');}});
module.exports=Object.freeze({prove});
