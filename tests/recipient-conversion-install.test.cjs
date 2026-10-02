'use strict';
// Portable compiler/boundary checks. PostgreSQL catalog locking and native
// transaction behavior are covered by the separate PG17 proof.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {setupShopifySelection}=require('./segment-shopify-selection-fixture.cjs');
const Install=require('../n8n/growth/recipient-conversion-install.cjs');
const ROOT=path.resolve(__dirname,'..');
const raw=fs.readFileSync(path.join(ROOT,'n8n/growth/recipient-conversion-evidence.sql'),'utf8');

async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());
 await setupShopifySelection(db);
 await db.exec(fs.readFileSync(path.join(ROOT,'n8n/growth/ab-experiment-core.sql'),'utf8'));
 await db.exec(`CREATE FUNCTION public.digest(data bytea,algorithm text) RETURNS bytea
  LANGUAGE plpgsql IMMUTABLE AS $$BEGIN
   IF lower(algorithm)<>'sha256' THEN RAISE EXCEPTION 'SYNTHETIC_DIGEST_ALGORITHM';END IF;
   RETURN sha256(data);
  END$$`);
 return db;
}
async function compile(db){
 const snapshot=(await db.query(Install.snapshotSQL())).rows[0].snapshot;
 const now=Date.now();
 return {snapshot,plan:Install.compile({
  expectedSnapshot:snapshot,
  expectedSnapshotSha256:Install.sha(Install.canonical(snapshot)),
  pins:Install.sourcePins(),
  reviewSha256:Install.sha('SYNTHETIC_PORTABLE_INSTALL_REVIEW_ONLY'),
  notBefore:new Date(now-1000).toISOString(),
  expiresAt:new Date(now+5*60*1000).toISOString(),
 })};
}
async function absent(db){
 return (await db.query("SELECT to_regnamespace('crm_email_conversion_candidate') IS NULL AS value")).rows[0].value;
}

test('raw migration without the compiler marker is refused and leaves no schema',async t=>{
 const db=await fixture(t);
 await assert.rejects(db.exec(raw),/RECIPIENT_CONVERSION_INSTALL_GUARD/);
 await db.exec('ROLLBACK');
 assert.equal(await absent(db),true);
});

test('compiler pins its loaded sources and the exact snapshot hash',async t=>{
 const db=await fixture(t),{snapshot}=await compile(db),pins=Install.sourcePins();
 assert.throws(()=>Install.compile({
  expectedSnapshot:snapshot,expectedSnapshotSha256:'0'.repeat(64),pins,
  reviewSha256:'1'.repeat(64),notBefore:new Date(Date.now()-1000).toISOString(),
  expiresAt:new Date(Date.now()+60000).toISOString(),
 }),/RECIPIENT_INSTALL_SNAPSHOT_PIN/);
 assert.throws(()=>Install.compile({
  expectedSnapshot:snapshot,expectedSnapshotSha256:Install.sha(Install.canonical(snapshot)),
  pins:{...pins,'n8n/growth/recipient-conversion-evidence.sql':'0'.repeat(64)},
  reviewSha256:'1'.repeat(64),notBefore:new Date(Date.now()-1000).toISOString(),
  expiresAt:new Date(Date.now()+60000).toISOString(),
 }),/RECIPIENT_INSTALL_SOURCE_DRIFT/);
});

test('compiled install rejects committed metadata drift and rolls back its schema',async t=>{
 const db=await fixture(t),{plan}=await compile(db);
 await db.exec('ALTER FUNCTION public.shrigma_email_recipient_key(text) COST 999');
 await assert.rejects(db.exec(plan.sql),/RECIPIENT_CONVERSION_METADATA_DRIFT/);
 await db.exec('ROLLBACK');
 assert.equal(await absent(db),true);
});
