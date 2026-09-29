'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const F=require('./segment-audience-store-fixture.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const Facts=require('../n8n/growth/segment-shopify-facts.cjs'),Bulk=require('../n8n/growth/segment-shopify-bulk-evidence.cjs');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const rule=(field='purchase.count',operator='eq',value=0)=>({op:'condition',field,operator,value});
function evidence(brand='fish',records=[{id:1,orders:'0'},{id:2,orders:'3'}],operation='1'){
 const end=new Date(Date.now()-60000).toISOString(),start=new Date(Date.now()-120000).toISOString();
 const jsonl=records.map(r=>JSON.stringify({id:'gid://shopify/Customer/'+r.id,email:r.email===undefined?'person'+r.id+'@example.test':r.email,
  defaultEmailAddress:r.email===null?null:{emailAddress:r.email===undefined?'person'+r.id+'@example.test':r.email},firstName:'Fixture',
  numberOfOrders:r.orders??'1',amountSpent:{amount:r.amount??(r.orders==='0'?'0.00':'125.10'),currencyCode:'BRL'},
  lastOrder:r.orders==='0'?null:{createdAt:'2026-09-01T01:00:00Z'},createdAt:'2020-01-01T00:00:00Z',updatedAt:end})).join('\n');
 const input={brand,shop:brand+'-fixture.myshopify.com',jsonl,observedAt:new Date().toISOString(),querySha256:Facts.QUERY_SHA256,workflowId:'fixture-'+brand,workflowVersion:'shopify-facts-fixture-v1',operation:{data:{shop:{id:'gid://shopify/Shop/'+(brand==='fish'?1:2),myshopifyDomain:brand+'-fixture.myshopify.com',currencyCode:'BRL',ianaTimezone:'America/Sao_Paulo'},currentAppInstallation:{accessScopes:[{handle:'read_customers'}]},node:{id:'gid://shopify/BulkOperation/'+operation,status:'COMPLETED',errorCode:null,objectCount:String(records.length),rootObjectCount:String(records.length),createdAt:start,completedAt:end,fileSize:String(Buffer.byteLength(jsonl)),url:jsonl?'https://example.test/synthetic':null,partialDataUrl:null}}}};
 return Bulk.buildCustomerEvidence(input);
}
async function setup(t){
 const db=new PGlite();t.after(()=>db.close());const f=await F.setup(db,{countProvider:Counter.countAudience,timeoutMs:10000});
 await db.exec("ALTER TABLE subscribers ADD COLUMN uuid uuid DEFAULT gen_random_uuid() NOT NULL,ADD COLUMN email text; UPDATE subscribers SET email='person'||id||'@example.test'");
 await F.dropShopifyStubs(db); // Install real source functions for every Shopify proof.
 await db.exec(read('n8n/growth/segment-shopify-facts.sql'));
 for(const brand of ['fish','aristo']){
  const e=evidence(brand),catalog={...F.source(brand),fields:Object.keys(require('../n8n/growth/segment-audience-contract.js').FIELDS).map(key=>({key,available:Facts.FIELDS.includes(key),source_hash:Facts.FIELDS.includes(key)?Facts.sourceHash(brand,key,F.source(brand)):null})),products:[],origins:[]};
  const hashes=Object.fromEntries(Facts.FIELDS.map(key=>[key,Facts.sourceHash(brand,key,catalog)]));
  await db.query('INSERT INTO crm_audience_v2.shopify_source(brand,shop_id,domain,currency,timezone,query_sha256,workflow_id,producer_revision,field_hashes,ingestion_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)',[brand,catalog.shop_id,e.shop,catalog.currency,catalog.timezone,e.query_sha256,e.workflow_id,e.workflow_version,JSON.stringify(hashes)]);
  await db.query('UPDATE crm_audience_v2.config SET catalog=$2::jsonb WHERE brand=$1',[brand,JSON.stringify(catalog)]);
 }
 const ingest=async(e,part=0)=>{const {customers,...meta}=e;return (await db.query('SELECT crm_audience_v2.shopify_ingest_chunk($1,$2,$3) AS receipt',[JSON.stringify(meta),part,JSON.stringify(customers.slice(part*5000,(part+1)*5000))])).rows[0].receipt;};
 const enable=()=>db.exec('UPDATE crm_audience_v2.shopify_source SET enabled=true');
 const catalog=async brand=>{const r=await f.call({acao:'segmentos_listar',brand,limit:50,offset:0});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.catalog;};
 const count=async(brand,r)=>{const c=await catalog(brand);return f.call({acao:'segmento_contar',brand,definition:F.definition(brand,r),expected_catalog_hash:c.catalog_hash});};
 return {db,f,ingest,enable,catalog,count};
}
module.exports={setup,evidence,rule};
