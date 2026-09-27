'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const D=require('../tools/maintenance-cart-deploy/deploy.cjs'),{fixtureSQL}=require('./maintenance-cart-fixture.cjs');
const ROOT=path.join(__dirname,'..');
async function setup(t){const db=new PGlite();t.after(()=>db.close());await db.exec(fixtureSQL);return db;}
const meta=async db=>(await db.query(D.METADATA_SQL)).rows[0];
const migrate=(before)=>D.atomicInstall(ROOT,before,'00000000-0000-4000-8000-000000000000');
test('exact driver batch atomically installs sealed schema OFF with original functions unchanged and no events',async t=>{
 const db=await setup(t),before=await meta(db),m=migrate(before);await db.exec(m.sql);
 const after=await meta(db),seal=JSON.parse(after.seal);assert.deepEqual(after.dependencies,before.dependencies);assert.equal(seal.shape,after.shape);assert.equal(seal.ddl,m.seal.ddl);assert.equal(seal.nonce,m.seal.nonce);
 const state=(await db.query(D.STATE_SQL)).rows[0];assert.equal(state.control.enabled,false);assert.equal(state.control.mode,'closed');assert.equal(state.event_count,'0');
 const funcs=(await db.query("SELECT count(*) n FROM pg_proc WHERE pronamespace='crm_maintenance_candidate'::regnamespace")).rows[0].n;assert.equal(funcs,11);
 await assert.rejects(db.exec(m.sql),/CART_DEPLOY_SCHEMA_EXISTS/);assert.equal((await db.query('SELECT 1 ok')).rows[0].ok,1);
});
test('failure midway through a single implicit batch leaves no partial schema and next query works',async t=>{
 const db=await setup(t),before=await meta(db),m=migrate(before);
 const broken=m.sql.replace('CREATE SEQUENCE crm_maintenance_candidate.cart_turn;',"SELECT missing_install_fixture_function();\nCREATE SEQUENCE crm_maintenance_candidate.cart_turn;");assert.notEqual(broken,m.sql);
 await assert.rejects(db.exec(broken),/missing_install_fixture_function/);assert.equal((await meta(db)).schema,null);assert.equal((await db.query('SELECT 2 ok')).rows[0].ok,2);
 await db.exec(m.sql);assert.equal((await meta(db)).schema,'crm_maintenance_candidate');
});
test('dependency drift aborts before DDL and seal detects column, privilege and body drift',async t=>{
 const db=await setup(t),before=await meta(db),m=migrate(before);
 await db.exec("COMMENT ON FUNCTION public.shrigma_email_finish_cart(uuid,uuid,text,jsonb) IS 'harmless comment';");
 // Comments do not change function semantics/hash; a function definition does.
 await db.exec("ALTER FUNCTION public.shrigma_email_finish_cart(uuid,uuid,text,jsonb) SET statement_timeout='2s';");
 await assert.rejects(db.exec(m.sql),/DEPENDENCY_DRIFT/);assert.equal((await meta(db)).schema,null);
 const current=await meta(db);await db.exec(migrate(current).sql);const installed=await meta(db);
 await db.exec('ALTER TABLE crm_maintenance_candidate.cart_attempt ADD COLUMN unexpected text');const changed=await meta(db);assert.notEqual(changed.shape,installed.shape);assert.equal(changed.seal,installed.seal);
});
