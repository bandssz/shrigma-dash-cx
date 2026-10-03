'use strict';
// Offline fixture proof. Import registers no tests and reads no environment;
// proveRoleInstallation(f, t) accepts the already-admitted disposable DB fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('./crm-manager-provision-postgres.test.cjs');
const SQL=fs.readFileSync(path.join(__dirname,'../n8n/access/crm-manager-role-install-v1.sql'),'utf8');
const OWNER='crm_manager_function_owner_v1',LOGIN='crm_manager_provisioner';
const tables=['shrigma_crm_manager_issuer_v1','shrigma_crm_manager_subject_v1','shrigma_crm_manager_operation_v1','shrigma_crm_manager_generation_v1'];
const functions=['canonical','error','apply','prepare','commit','revoke','status'];
const asRole=async(db,role,fn)=>{
 assert.ok([OWNER,LOGIN,F.issuerA.login,F.issuerB.login].includes(role));
 await db.exec('SET SESSION AUTHORIZATION '+role);
 try{return await fn();}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}
};
const role=async(db,name)=>(await db.query('SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname=$1',[name])).rows[0];
const existingAcl=async db=>({
 defaults:(await db.query('SELECT * FROM pg_default_acl ORDER BY oid')).rows,
 public:(await db.query("SELECT p.oid,p.proowner,a.grantee,a.privilege_type,a.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.shrigma_template_auth_v2(text)'::regprocedure ORDER BY a.grantee,a.privilege_type")).rows,
 legacyOwners:(await db.query("SELECT relname,relowner FROM pg_class WHERE oid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass) ORDER BY relname")).rows
});

// Exactly one installation, on the caller's existing synthetic fixture. Root
// invokes this at the END of the native PostgreSQL16 CI concurrency suite.
async function proveRoleInstallation(f,t){
 assert.ok(f&&f.db&&typeof f.call==='function'&&typeof f.unchanged==='function');
 assert.ok(t&&typeof t.test==='function');
 const before=await existingAcl(f.db);
 const temp=(await f.db.query("SELECT EXISTS(SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='TEMPORARY') AS allowed")).rows[0].allowed;
 await f.db.exec(SQL);

 await t.test('ownership, flags, column-only lock authority and scoped definer commit',async()=>{
  const expected={rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false};
  assert.deepEqual(await role(f.db,OWNER),{rolcanlogin:false,...expected,rolconnlimit:-1});
  assert.deepEqual(await role(f.db,LOGIN),{rolcanlogin:true,...expected,rolconnlimit:2});
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ($1,$2))',[OWNER,LOGIN])).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM pg_authid WHERE rolname IN ($1,$2) AND rolpassword IS NOT NULL',[OWNER,LOGIN])).rows[0].n,0);
  for(const table of tables)assert.equal((await f.db.query('SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass',['public.'+table])).rows[0].owner,OWNER);
  for(const fn of functions){
   const r=(await f.db.query("SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1",['shrigma_crm_manager_'+fn+'_v1'])).rows;
   assert.equal(r.length,1);assert.equal(r[0].owner,OWNER);
  }
  for(const name of [OWNER,LOGIN])assert.equal((await f.db.query("SELECT has_schema_privilege($1,'public','CREATE') AS allowed",[name])).rows[0].allowed,false);
  assert.deepEqual((await f.db.query("SELECT has_table_privilege($1,'public.crm_dash_chave','SELECT') AS s,has_table_privilege($1,'public.crm_dash_chave','INSERT') AS i,has_table_privilege($1,'public.crm_dash_chave','UPDATE') AS u,has_table_privilege($1,'public.crm_dash_chave','DELETE') AS d",[OWNER])).rows[0],{s:true,i:true,u:true,d:false});
  assert.deepEqual((await f.db.query("SELECT has_table_privilege($1,'public.shrigma_panel_permission_v1','SELECT') AS s,has_table_privilege($1,'public.shrigma_panel_permission_v1','INSERT') AS i,has_table_privilege($1,'public.shrigma_panel_permission_v1','UPDATE') AS u,has_table_privilege($1,'public.shrigma_panel_permission_v1','DELETE') AS d",[OWNER])).rows[0],{s:true,i:true,u:false,d:true});
  const columns=(await f.db.query("SELECT attname,has_column_privilege($1,attrelid,attname,'UPDATE') AS owner_update,has_column_privilege($2,attrelid,attname,'UPDATE') AS login_update FROM pg_attribute WHERE attrelid='public.shrigma_panel_permission_v1'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",[OWNER,LOGIN])).rows;
  assert.ok(columns.some(c=>c.attname==='principal_id'));
  for(const c of columns){assert.equal(c.owner_update,c.attname==='principal_id');assert.equal(c.login_update,false);}
  await asRole(f.db,OWNER,async()=>{
   await f.db.query('UPDATE public.shrigma_panel_permission_v1 SET principal_id=principal_id WHERE false');
   for(const c of columns.filter(c=>c.attname!=='principal_id')){
    assert.match(c.attname,/^[a-z_]+$/);
    await assert.rejects(f.db.query('UPDATE public.shrigma_panel_permission_v1 SET '+c.attname+'='+c.attname+' WHERE false'),e=>e.code==='42501');
   }
  });
  // Both pre-existing issuer logins enter SECURITY DEFINER wrappers under the
  // new non-superuser owner; commit needs the exact permission-row lock grant.
  for(const issuer of [F.issuerA,F.issuerB]){
   const q=F.createPrepare({},issuer),p=await f.call(q,issuer);assert.equal(p.state,'prepared');
   const c=F.createCommit(q,p),receipt=await f.call(c,issuer);assert.equal(receipt.state,'committed');
   assert.deepEqual((await f.call(F.createStatus(c),issuer)).receipt,receipt);
   assert.deepEqual(await f.call(c,issuer),receipt);
   assert.equal((await f.call(F.createRevoke(q),issuer)).state,'revoked');
  }
  assert.deepEqual(await existingAcl(f.db),before);await f.unchanged();
 });

 await t.test('passwordless service login has four RPCs, no issuer, direct tables or user DDL',async()=>{
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM public.shrigma_crm_manager_issuer_v1 WHERE login_role=$1',[LOGIN])).rows[0].n,0);
  await asRole(f.db,LOGIN,async()=>{
   const q=F.createPrepare(),r=(await f.db.query('SELECT public.shrigma_crm_manager_prepare_v1($1::jsonb) AS body',[F.canonical(q)])).rows[0].body;
   assert.equal(r.code,'ISSUER_DENIED');assert.equal(r.issuerId,null);assert.equal(r.namespaceId,null);
   for(const table of ['crm_dash_chave','shrigma_panel_permission_v1',...tables]){
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await f.db.query('SELECT has_table_privilege(session_user,$1,$2) AS allowed',['public.'+table,privilege])).rows[0].allowed,false);
    await assert.rejects(f.db.query('SELECT * FROM public.'+table),e=>e.code==='42501');
    await assert.rejects(f.db.query('DELETE FROM public.'+table+' WHERE false'),e=>e.code==='42501');
   }
   await assert.rejects(f.db.query('CREATE TABLE public.forbidden_role_fixture(id int)'),e=>e.code==='42501');
   await assert.rejects(f.db.query('CREATE SCHEMA forbidden_role_fixture'),e=>e.code==='42501');
   for(const fn of ['prepare','commit','revoke','status'])assert.equal((await f.db.query("SELECT has_function_privilege(session_user,$1,'EXECUTE') AS allowed",['public.shrigma_crm_manager_'+fn+'_v1(jsonb)'])).rows[0].allowed,true);
   for(const signature of ['canonical_v1(jsonb)','error_v1(jsonb,uuid,uuid,text)','apply_v1(jsonb,text)'])assert.equal((await f.db.query("SELECT has_function_privilege(session_user,$1,'EXECUTE') AS allowed",['public.shrigma_crm_manager_'+signature])).rows[0].allowed,false);
   await assert.rejects(f.db.query('SELECT public.shrigma_crm_manager_canonical_v1($1::jsonb)',['{}']),e=>e.code==='42501');
  });await f.unchanged();
 });

 await t.test('PUBLIC legacy EXECUTE/TEMP and existing/default ACLs stay unchanged',async()=>{
  assert.deepEqual(await existingAcl(f.db),before);
  await asRole(f.db,LOGIN,async()=>{
   assert.equal((await f.db.query("SELECT has_function_privilege(session_user,'public.shrigma_template_auth_v2(text)','EXECUTE') AS allowed")).rows[0].allowed,true);
   assert.equal((await f.db.query("SELECT public.shrigma_template_auth_v2('synthetic') AS value")).rows[0].value,null);
   assert.equal((await f.db.query("SELECT has_database_privilege(session_user,current_database(),'TEMP') AS allowed")).rows[0].allowed,temp);
   if(temp)await f.db.exec('CREATE TEMP TABLE inherited_temp_fixture(id int);DROP TABLE inherited_temp_fixture');
  });
  assert.match(SQL,/PUBLIC TEMP \/ EXECUTE/);
  assert.doesNotMatch(SQL.replace(/^\s*--.*$/gm,''),/ALTER\s+DEFAULT\s+PRIVILEGES|REVOKE[^;]*FROM\s+PUBLIC|ALTER\s+ROLE|\bPASSWORD\b|INSERT\s+INTO/i);
  await f.unchanged();
 });
}

module.exports={proveRoleInstallation};

if(require.main===module){
 const test=require('node:test');
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||require.resolve('@electric-sql/pglite',{paths:[path.join(__dirname,'../services/crm-audience-sandbox')]}));
 const setup=t=>F.createFixture(t,{PGlite});
 test('exact role proposal on a disposable PGlite fixture',async t=>{await proveRoleInstallation(await setup(t),t);});
 test('duplicate role names and missing/tampered targets refuse before mutations',async t=>{
  for(const patch of ['CREATE ROLE crm_manager_function_owner_v1 NOLOGIN','CREATE ROLE crm_manager_provisioner NOLOGIN','DROP FUNCTION public.shrigma_crm_manager_status_v1(jsonb)','DROP INDEX public.shrigma_crm_manager_one_prepared_v1','ALTER FUNCTION public.shrigma_crm_manager_status_v1(jsonb) SET search_path=public','CREATE OR REPLACE FUNCTION public.shrigma_crm_manager_status_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT NULL::jsonb $$','GRANT CREATE ON SCHEMA public TO PUBLIC','GRANT SELECT ON public.crm_dash_chave TO PUBLIC']){
   await t.test(patch.split(' ').slice(0,4).join(' '),async sub=>{
    const f=await setup(sub);await f.db.exec(patch);
    const before=(await f.db.query('SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname IN ($1,$2) ORDER BY rolname',[OWNER,LOGIN])).rows;
    await assert.rejects(f.db.exec(SQL),/CRM_MANAGER_ROLE_INSTALL_REFUSED/);await f.db.exec('ROLLBACK');
    assert.deepEqual((await f.db.query('SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname IN ($1,$2) ORDER BY rolname',[OWNER,LOGIN])).rows,before);
    assert.equal((await f.db.query("SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.shrigma_crm_manager_generation_v1'::regclass")).rows[0].owner,'postgres');
    await f.unchanged();
   });
  }
 });
 test('later failure rolls back roles/ownership; repeated installation refuses',async t=>{
  const f=await setup(t),fail=SQL.replace(/COMMIT;\s*$/,'SELECT 1/0;COMMIT;');
  await assert.rejects(f.db.exec(fail),e=>e.code==='22012');await f.db.exec('ROLLBACK');
  assert.equal(await role(f.db,OWNER),undefined);assert.equal(await role(f.db,LOGIN),undefined);
  assert.equal((await f.db.query("SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='public.shrigma_crm_manager_prepare_v1(jsonb)'::regprocedure")).rows[0].owner,'postgres');
  await f.unchanged();await f.db.exec(SQL);
  await assert.rejects(f.db.exec(SQL),/CRM_MANAGER_ROLE_INSTALL_REFUSED/);await f.db.exec('ROLLBACK');
  assert.equal((await role(f.db,LOGIN)).rolconnlimit,2);await f.unchanged();
 });
}
