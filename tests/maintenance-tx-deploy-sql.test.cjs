'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const D=require('../tools/maintenance-tx-deploy/deploy.cjs'),F=require('./maintenance-tx-deploy-fixture.cjs');
const nonce='11111111-1111-4111-8111-111111111111',meta=async db=>(await db.query(D.METADATA_SQL)).rows[0];
async function setup(t){const db=new PGlite();t.after(()=>db.close());const base=await F.installBase(db);return {db,...base};}
test('atomic additive SQL preserves every old row/function and open v2; new seal contains exact old seal',async t=>{
 const {db,before,control}=await setup(t),rows=await F.rowSnapshot(db),m=D.atomicInstall(F.ROOT,before,control,nonce);await db.exec(m.sql);
 const after=await meta(db),seal=JSON.parse(after.seal);assert.deepEqual(seal.previous,JSON.parse(before.seal));assert.equal(seal.shape,after.shape);assert.equal(seal.contract,D.CONTRACT);assert.deepEqual(after.dependencies,before.dependencies);assert.deepEqual(await F.rowSnapshot(db),rows);
 assert.equal((await db.query('SELECT count(*) n FROM crm_maintenance_candidate.tx_attempt')).rows[0].n,0);
 await assert.rejects(db.exec(m.sql),/OLD_SEAL_DRIFT/);assert.deepEqual(await F.rowSnapshot(db),rows);assert.throws(()=>D.previousSeal(after),/OLD_SEAL/);
 const publicExecute=(await db.query("SELECT count(*) n FROM pg_proc p WHERE p.pronamespace='crm_maintenance_candidate'::regnamespace AND p.proname LIKE 'tx_%' AND EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')")).rows[0].n;assert.equal(publicExecute,0);
});
test('mid-DDL failure rolls back extension and seal together, preserving queued carts and usable connection',async t=>{
 const {db,before,control}=await setup(t),rows=await F.rowSnapshot(db),m=D.atomicInstall(F.ROOT,before,control,nonce);
 const broken=m.sql.replace('CREATE TABLE crm_maintenance_candidate.tx_attempt','SELECT missing_tx_install_fixture();\nCREATE TABLE crm_maintenance_candidate.tx_attempt');assert.notEqual(broken,m.sql);
 await assert.rejects(db.exec(broken),/missing_tx_install_fixture/);assert.deepEqual(await meta(db),before);assert.deepEqual(await F.rowSnapshot(db),rows);assert.equal((await db.query("SELECT to_regclass('crm_maintenance_candidate.tx_turn') r")).rows[0].r,null);
 await db.exec(m.sql);assert.equal((await db.query('SELECT 1 ok')).rows[0].ok,1);
});
test('old seal/shape, dependency and gate drift are independently rejected before adding TX objects',async t=>{
 for(const change of ["COMMENT ON SCHEMA crm_maintenance_candidate IS '{}'",'ALTER TABLE crm_maintenance_candidate.cart_attempt ADD COLUMN unexpected boolean',"ALTER FUNCTION public.shrigma_email_finish_fish(uuid,uuid,text,jsonb) SET statement_timeout='2s'","UPDATE crm_maintenance_candidate.control SET version=3,mode='closed'",...['shrigma_email_claim_fish','shrigma_email_claim_aristo','shrigma_flow_slot','shrigma_flow_slot_wa_versioned_v1'].map(name=>before=>`ALTER FUNCTION ${before.dependencies.find(f=>f.name===name).signature} SET statement_timeout='2s'`)]){
  const {db,before,control}=await setup(t),m=D.atomicInstall(F.ROOT,before,control,nonce);await db.exec(typeof change==='function'?change(before):change);await assert.rejects(db.exec(m.sql),/DRIFT/);assert.equal((await db.query("SELECT to_regclass('crm_maintenance_candidate.tx_attempt') r")).rows[0].r,null);
 }
});
test('DDL is one implicit atomic DO, no gate update/adoption or reinstallation of the CART/base DDL',async t=>{
 const {before,control}=await setup(t),m=D.atomicInstall(F.ROOT,before,control,nonce);assert.equal((m.sql.match(/DO \$tx_install\$/g)||[]).length,1);assert.doesNotMatch(m.sql,/^BEGIN;|^COMMIT;|CREATE SCHEMA|CREATE TABLE crm_maintenance_candidate\.event\b|CREATE FUNCTION crm_maintenance_candidate\.cart_|control_v1\(/m);assert.match(m.sql,/control c WHERE singleton FOR SHARE/);assert.match(m.sql,/statement_timeout='15s'/);assert.match(m.sql,/COMMENT ON SCHEMA/);
});
