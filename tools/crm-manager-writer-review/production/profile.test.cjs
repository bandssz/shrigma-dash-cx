'use strict';
// Lab SQL normalization only; never claims PG17/HBA/production admission.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const I=require('./installer.cjs'),R=require('../../../tests/crm-manager-provision-postgres.test.cjs'),W=require('../writer-provision.test.cjs');
test('normalized legacy fingerprint retains old triggers/ACL, ignores only exact WRITER additions, detects drift',async t=>{
 const {PGlite}=require('@electric-sql/pglite');
 const f=await W.createWriterFixture(t,{Engine:PGlite,readFixture:async(t,o)=>{const f=await R.createFixture(t,o);return{...f,callRead:f.call};}});
 // Closed synthetic stubs fill the two absent signatures only for this metadata
 // fingerprint test. They do not pass the full production auth body guard.
 await f.db.exec("CREATE FUNCTION public.shrigma_panel_auth_v1(text,text,text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::text $$; CREATE FUNCTION public.shrigma_crm_read_fast_v1(text,text,jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::jsonb $$;");
 const sql=fs.readFileSync(path.join(__dirname,'sql/legacy-profile.sql'),'utf8'),get=async()=>{const r=(await f.db.query(sql)).rows;assert.equal(r.length,1);assert.match(r[0].legacy_sha256,/^[0-9a-f]{64}$/);return r[0].legacy_sha256;};
 // regprocedure/pg_describe_object output is qualified by search_path. The
 // production runner and frozen component rollback both set pg_catalog inside
 // their transaction; querying this fingerprint at the fixture's public path
 // hashes a different textual projection of the SAME metadata.
 const profileSql=fs.readFileSync(path.join(__dirname,'sql/profile.sql'),'utf8');
 const unqualified=(await f.db.query(profileSql)).rows[0].profile_sha256;
 await f.db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL search_path=pg_catalog;');
 try{assert.equal((await f.db.query(profileSql)).rows[0].profile_sha256,I.PROFILE);}
 finally{await f.db.exec('ROLLBACK');}
 assert.notEqual(unqualified,I.PROFILE);assert.equal(await f.profile(),I.PROFILE);
 const installed=await get();
 await f.db.exec(f.rollback);const absent=await get();assert.equal(absent,installed);await f.db.exec(f.source);assert.equal(await get(),absent);
 await f.db.exec('BEGIN;ALTER TABLE public.crm_dash_chave ADD COLUMN synthetic_drift text;');assert.notEqual(await get(),installed);await f.db.exec('ROLLBACK');assert.equal(await get(),installed);
 await f.db.exec('BEGIN;GRANT DELETE ON public.crm_dash_chave TO central_leitor;');assert.notEqual(await get(),installed);await f.db.exec('ROLLBACK');assert.equal(await get(),installed);
 for(const drift of [
  'ALTER TABLE public.crm_dash_chave DISABLE TRIGGER ALL',
  'GRANT UPDATE(dono) ON public.crm_dash_chave TO central_leitor',
  'GRANT CREATE ON SCHEMA public TO central_leitor',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO central_leitor',
  'CREATE OR REPLACE FUNCTION public.shrigma_panel_auth_v1(text,text,text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT \'synthetic_drift\'::text $$'
 ]){await f.db.exec('BEGIN;'+drift);assert.notEqual(await get(),installed);await f.db.exec('ROLLBACK');assert.equal(await get(),installed);}
});
