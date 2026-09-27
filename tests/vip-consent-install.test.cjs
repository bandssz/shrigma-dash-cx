'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {atomicInstallSQL,SIGNATURE}=require('../tools/vip-consent-install.cjs');
const sql=fs.readFileSync(path.join(__dirname,'../n8n/growth/vip-consent.sql'),'utf8');
const guard=`IF to_regprocedure('${SIGNATURE}') IS NOT NULL THEN RAISE EXCEPTION 'SYNTHETIC_ALREADY_INSTALLED'; END IF;`;
async function dbFor(t){const db=new PGlite();t.after(()=>db.close());return db;}
async function absentHealthy(db){assert.equal((await db.query(`SELECT to_regprocedure('${SIGNATURE}') f`)).rows[0].f,null);assert.equal((await db.query('SELECT 42 ok')).rows[0].ok,42);}
test('guard failure rolls back the request with no function and the same session remains usable',async t=>{
 const db=await dbFor(t),q=atomicInstallSQL(sql,"IF true THEN RAISE EXCEPTION 'SYNTHETIC_GUARD'; END IF;");
 assert.match(q,/^DO \$vip_install_0\$/);assert.match(q,/PERFORM set_config\('lock_timeout','3s',true\)/);
 await assert.rejects(db.exec(q),/SYNTHETIC_GUARD/);await absentHealthy(db);
});
test('failure after CREATE inside dynamic DDL reverts the created function and leaves no aborted transaction',async t=>{
 const db=await dbFor(t),q=atomicInstallSQL(sql,guard);
 // Inject only in the test after construction, to force a mid-DDL failure before REVOKE.
 const broken=q.replace('REVOKE ALL ON FUNCTION','SELECT missing_vip_install_fixture();\nREVOKE ALL ON FUNCTION');assert.notEqual(q,broken);
 await assert.rejects(db.exec(broken),/missing_vip_install_fixture/);await absentHealthy(db);
 await db.exec(q);assert.notEqual((await db.query(`SELECT to_regprocedure('${SIGNATURE}') f`)).rows[0].f,null);
});
test('successful installation preserves declared signature and removes PUBLIC execute',async t=>{
 const db=await dbFor(t);await db.exec(atomicInstallSQL(sql,guard));
 const r=(await db.query(`SELECT pg_get_function_identity_arguments(p.oid) signature,pg_get_function_result(p.oid) result,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute FROM pg_proc p WHERE p.oid='${SIGNATURE}'::regprocedure`)).rows[0];
 assert.equal(r.signature,'p_email text, p_origem text, p_corrigido boolean, p_source text');assert.equal(r.result,'TABLE(eligible boolean, reason text)');assert.equal(r.public_execute,false);
 await assert.rejects(db.exec(atomicInstallSQL(sql,guard)),/SYNTHETIC_ALREADY_INSTALLED/);assert.equal((await db.query('SELECT 1 ok')).rows[0].ok,1);
});
test('only outer transaction is removed; nested BEGIN/EXCEPTION, literals and comments remain untouched',()=>{
 const source=sql.replace('DECLARE',"-- BEGIN; COMMIT; $vip_ddl_0$ $vip_install_0$\nDECLARE"),q=atomicInstallSQL(source,guard);
 assert.match(q,/^DO \$vip_install_1\$/);assert.match(q,/EXECUTE \$vip_ddl_1\$/);
 const ddl=q.split('$vip_ddl_1$')[1],expected=source.replace(/^BEGIN;/m,'').replace(/^COMMIT;/m,'');assert.equal(ddl,expected);assert.ok(ddl.includes('EXCEPTION'));assert.ok(ddl.includes('BEGIN'));
});
test('extra statements/signatures, missing revoke, altered transaction or malformed quote are refused',()=>{
 for(const input of [sql.replace('shrigma_crm_vip_subscribe_v1(', 'different_function('),sql.replace('p_corrigido boolean','p_corrigido text'),sql.replace(/REVOKE ALL[^;]+;/,'GRANT EXECUTE ON FUNCTION public.shrigma_crm_vip_subscribe_v1(text,text,boolean,text) TO PUBLIC;'),sql.replace('COMMIT;','SELECT 1; COMMIT;'),sql.replace(/^BEGIN;/m,'START TRANSACTION;'),sql.replace(/COMMIT;\s*$/,''),sql+"SELECT 'unterminated"]){assert.throws(()=>atomicInstallSQL(input,guard),/VIP_INSTALL_/);}
 assert.throws(()=>atomicInstallSQL(sql,''),/VIP_INSTALL_GUARD/);
});
