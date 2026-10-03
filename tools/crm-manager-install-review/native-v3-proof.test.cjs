'use strict';
// No transport, environment inspection or test is started by importing this file.
const assert=require('node:assert/strict');
const F=require('./native-fixture.cjs');
const EXPECTED='4f5b8bdec729d2924c043da6bd3c0f8f2ce01a82af614187cefa1322ecef11c9';
const stateSql="SELECT current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,current_setting('idle_in_transaction_session_timeout') AS idle_timeout";
async function profile(db){
 try{const result=await db.exec('BEGIN;SET LOCAL search_path=pg_catalog;'+F.source('profile.sql')+'ROLLBACK;');return F.flattenRows(result)[0].profile_sha256;}
 finally{await db.exec('ROLLBACK');}
}
async function exact(db,file){try{return{result:await db.exec(F.source(file))};}catch(error){return{code:error?.code,message:error?.message};}finally{await db.exec('ROLLBACK');}}
function refused(result,message){assert.equal(result.code,'P0001');assert.equal(result.message,message);}
async function snapshot(db){return{legacy:await F.legacySnapshot(db),profile:await profile(db),roles:(await db.query('SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname IN ($1,$2) ORDER BY rolname',[F.OWNER,F.SERVICE])).rows,counts:await Promise.all(F.tables.map(async name=>({name,n:(await db.query('SELECT count(*)::int AS n FROM public.'+name)).rows[0].n})))};}
async function noLogin(container){
 const {execFile}=require('node:child_process');
 assert.match(container,/^shrigma-manager-v3-proof-[0-9]+-[0-9]+$/);
 for(const role of [F.OWNER,F.SERVICE]){
  const result=await new Promise(resolve=>execFile('/usr/bin/docker',['--host','unix:///var/run/docker.sock','exec',container,'psql','--no-psqlrc','--no-password','-h','127.0.0.1','-U',role,'-d','listmonk','-c','SELECT 1'],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000,maxBuffer:2048},(err,stdout,stderr)=>resolve({failed:Boolean(err),stdout,stderr})));
  // Authentication uses the container's native loopback TRUST HBA rule. Thus
  // rejection cannot be attributed merely to missing password under SCRAM.
  assert.equal(result.failed,true);assert.equal(result.stdout,'');
  assert.equal(result.stderr.includes('role "'+role+'" is not permitted to log in'),true);
 }
}
async function assertRestored(db,baseline){
 assert.deepEqual(await F.legacySnapshot(db),baseline);
 const names=(await db.query("SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('crm_manager_function_owner_v1','crm_manager_provisioner')) AS roles,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'shrigma_crm_manager_%') AS relations,(SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'shrigma_crm_manager_%') AS functions,(SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND (t.typname LIKE 'shrigma_crm_manager_%' OR t.typname LIKE '_shrigma_crm_manager_%')) AS types")).rows[0];
 assert.deepEqual(names,{roles:0,relations:0,functions:0,types:0});
 assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass)")).rows[0].n,4);
}
async function install(db){const r=await exact(db,'installer.sql');if(r.code)throw Error('NATIVE_V3_INSTALL_FAILED');}
async function rollback(db){const r=await exact(db,'rollback.sql');if(r.code)throw Error('NATIVE_V3_ROLLBACK_FAILED');}
const issuer="INSERT INTO public.shrigma_crm_manager_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains) VALUES('c1111111-1234-4234-8234-123456789abc','c2222222-1234-4234-8234-123456789abc','crm_manager_provisioner',ARRAY['example.test'])";
const cases=[
 ['issuer row',issuer,"DELETE FROM public.shrigma_crm_manager_issuer_v1 WHERE namespace_id='c2222222-1234-4234-8234-123456789abc'"],
 ['operation row',issuer+";INSERT INTO public.shrigma_crm_manager_operation_v1(namespace_id,operation_id,action,request_sha256) VALUES('c2222222-1234-4234-8234-123456789abc','c3333333-1234-4234-8234-123456789abc','prepare_read',repeat('0',64))","DELETE FROM public.shrigma_crm_manager_operation_v1 WHERE namespace_id='c2222222-1234-4234-8234-123456789abc';DELETE FROM public.shrigma_crm_manager_issuer_v1 WHERE namespace_id='c2222222-1234-4234-8234-123456789abc'"],
 ['LOGIN flag','ALTER ROLE crm_manager_provisioner LOGIN','ALTER ROLE crm_manager_provisioner NOLOGIN'],
 ['external dependency','CREATE VIEW public.rollback_external_dependency AS SELECT * FROM public.shrigma_crm_manager_subject_v1','DROP VIEW public.rollback_external_dependency RESTRICT'],
 ['extra legacy column grant','GRANT UPDATE(caps) ON public.shrigma_panel_permission_v1 TO crm_manager_function_owner_v1','REVOKE UPDATE(caps) ON public.shrigma_panel_permission_v1 FROM crm_manager_function_owner_v1 RESTRICT'],
 ['changed function body',"CREATE OR REPLACE FUNCTION public.shrigma_crm_manager_canonical_v1(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$BEGIN RETURN 'synthetic changed body';END$$",null]
];
async function guarded(t,fn){try{await fn();}catch(error){if(error?.message==='NATIVE_V3_PROFILE_MISMATCH')throw error;throw Error('NATIVE_V3_FIXTURE_ASSERTION_FAILED');}}
async function proveNativeV3(t,{Client,container}){
 const db=await F.createNativeFixture(Client);
 try{
  const baseline=await F.legacySnapshot(db),state=(await db.query(stateSql)).rows[0],hbaBefore=await F.scope(db);
  assert.deepEqual(hbaBefore.reports[0].rows[0],{target:'provisioner_hba',rule_errors:0,candidate_rules:4,ambiguous_selector_rules:0});
  assert.deepEqual(hbaBefore.reports[1].rows.map(r=>[r.target,r.total,r.trust,r.scram]),[['local',1,1,0],['loopback_only',2,2,0],['non_loopback',1,0,1],['unclassified',0,0,0]]);
  assert.equal(hbaBefore.reports[2].rows.length,18);assert.equal(hbaBefore.reports[2].rows[0].entry_count,1);assert.equal(hbaBefore.reports[2].rows.slice(1).every(r=>r.entry_count===0),true);
  // This is a separate authenticated session to the SAME disposable cluster.
  // A divergent database context must refuse before any new namespace or role.
  await t.test('exact SQL refuses divergent context and rolls back before DDL',()=>guarded(t,async()=>{
   const other=new Client({...F.clientConfig(),database:'postgres'});await other.connect();try{let result;try{await other.query(F.source('installer.sql'));}catch(e){result={code:e.code,message:e.message};}finally{await other.query('ROLLBACK');}refused(result,'MANAGER_INSTALL_REFUSED');}finally{await other.end();}
   await assertRestored(db,baseline);
  }));
  await t.test('exact V3 native install, restricted NOLOGIN roles, exact fingerprint and full rollback',()=>guarded(t,async()=>{
   await install(db);await F.assertInstalled(db);assert.deepEqual(await F.legacySnapshot(db),baseline);assert.deepEqual(await F.scope(db),hbaBefore);
   await noLogin(container);
   const actual=await profile(db);
   if(actual!==EXPECTED){t.diagnostic(JSON.stringify({phase:'frozen-fingerprint',expected:EXPECTED,actual}));throw Error('NATIVE_V3_PROFILE_MISMATCH');}
   const installed=await snapshot(db);refused(await exact(db,'installer.sql'),'MANAGER_INSTALL_REFUSED');assert.deepEqual(await snapshot(db),installed);
   await rollback(db);await assertRestored(db,baseline);assert.deepEqual((await db.query(stateSql)).rows[0],state);
  }));
  // A failed positive fingerprint gates all subsequent cases; never learn or
  // adopt an actual native hash. No SQL file/gate is patched by this harness.
  await assertRestored(db,baseline);
  for(const[label,patch,undo]of cases)await t.test('rollback refusal preserves installed state: '+label,()=>guarded(t,async()=>{
   await install(db);assert.equal(await profile(db),EXPECTED);
   const original=undo===null?(await db.query("SELECT pg_get_functiondef('public.shrigma_crm_manager_canonical_v1(jsonb)'::regprocedure) AS definition")).rows[0].definition:null;
   await db.exec(patch);const before=await snapshot(db),settings=(await db.query(stateSql)).rows[0];
   refused(await exact(db,'rollback.sql'),'MANAGER_EMPTY_ROLLBACK_REFUSED');assert.deepEqual(await snapshot(db),before);assert.deepEqual((await db.query(stateSql)).rows[0],settings);
   // Undo only a synthetic, deliberately introduced fixture violation. The
   // exact installer/rollback files remain byte-for-byte unchanged throughout.
   await db.exec(undo||original);assert.equal(await profile(db),EXPECTED);await rollback(db);await assertRestored(db,baseline);
  }));
 }finally{try{await db.exec('ROLLBACK');}finally{await db.close();}}
}
module.exports={proveNativeV3};
if(require.main===module){
 const test=require('node:test'),enabled=process.env.CRM_MANAGER_V3_NATIVE_PROOF==='1';
 test('frozen native V3 proof needs deliberate isolated fixture opt-in',{skip:!enabled,timeout:120000},async t=>{
  assert.equal(process.versions.node.split('.')[0],'22');
  const pg=require('pg');assert.equal(require('pg/package.json').version,'8.13.1');
  const container=process.env.CRM_MANAGER_V3_CONTAINER;assert.match(container||'',/^shrigma-manager-v3-proof-[0-9]+-[0-9]+$/);
  await guarded(t,()=>proveNativeV3(t,{Client:pg.Client,container}));
 });
}
