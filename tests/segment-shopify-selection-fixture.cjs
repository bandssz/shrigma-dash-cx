'use strict';
const assert=require('node:assert/strict');
const F=require('./segment-regular-admission-fixture.cjs'),A=require('./segment-audience-store-fixture.cjs');
const {evidence,rule}=require('./segment-shopify-facts-fixture.cjs'),Facts=require('../n8n/growth/segment-shopify-facts.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
async function setupShopifySelection(db){
 const f=await F.setup(db);
 await db.exec("ALTER TABLE subscribers ADD COLUMN uuid uuid DEFAULT gen_random_uuid() NOT NULL,ADD COLUMN email text,ADD COLUMN created_at timestamptz DEFAULT now(),ADD COLUMN updated_at timestamptz DEFAULT now();UPDATE subscribers SET email='person'||id||'@example.test'");
 await A.dropShopifyStubs(db); // Install real source functions for every Shopify proof.
 await db.exec(A.read('n8n/growth/segment-shopify-facts.sql'));
 await db.exec(A.read('n8n/growth/segment-shopify-selection.sql'));
 const ingest=async(e)=>{const {customers,...meta}=e;return (await db.query('SELECT crm_audience_v2.shopify_ingest_chunk($1,$2,$3) AS receipt',[JSON.stringify(meta),0,JSON.stringify(customers)])).rows[0].receipt;};
 for(const brand of ['fish','aristo']){
  const source=A.source(brand),e=evidence(brand),hashes=Object.fromEntries(Facts.FIELDS.map(k=>[k,Facts.sourceHash(brand,k,source)]));
  await db.query('INSERT INTO crm_audience_v2.shopify_source(brand,shop_id,domain,currency,timezone,query_sha256,workflow_id,producer_revision,field_hashes,ingestion_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)',[brand,source.shop_id,e.shop,source.currency,source.timezone,e.query_sha256,e.workflow_id,e.workflow_version,JSON.stringify(hashes)]);
  await ingest(e);await db.query('UPDATE crm_audience_v2.shopify_source SET enabled=true WHERE brand=$1',[brand]);
  await db.query('SELECT crm_audience_v2.refresh_native_catalog($1)',[brand]);
 }
 let sequence=0;const rebind=async(brand,r)=>{sequence++;
  const current=await Store.readCatalog(db.query.bind(db),brand);f.catalogHashes[brand]=current.catalog.catalog_hash;
  const audience=await f.createAudience(brand,'shopify-'+brand+'-'+sequence,r),inspect=await f.inspect(brand,brand==='fish'?100:200,audience);
  assert.equal(inspect.status,200,JSON.stringify(inspect.body));const bound=await f.bind(inspect.body.intent,'shopify-binding-'+brand+'-'+sequence);assert.equal(bound.status,200,JSON.stringify(bound.body));return audience;
 };
 const match=async(brand,sid)=>(await db.query('SELECT crm_audience_v2.selection_regular_matches(crm_audience_v2.selection_worker_context($1),$2) AS matched',[brand==='fish'?100:200,sid])).rows[0].matched;
 return {db,f,ingest,rebind,match};
}
module.exports={setupShopifySelection};
