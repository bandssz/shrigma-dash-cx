'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const A=require('./ab-audience-admission-fixture.cjs');
const StoreFixture=require('./segment-audience-store-fixture.cjs');
const ShopifyFixture=require('./segment-shopify-facts-fixture.cjs');
const Facts=require('../n8n/growth/segment-shopify-facts.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs');

const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');

const renewableCatalog=brand=>{const source=StoreFixture.source(brand),shopify=new Set(Facts.AGGREGATE_FIELDS);return {...source,products:[],origins:[],fields:source.fields.map(({key})=>shopify.has(key)?{key,available:true,source_hash:Facts.sourceHash(brand,key,source)}:['email.opened','email.clicked'].includes(key)?{key,available:true,source_hash:Counter.engagementSourceHash(brand,key)}:{key,available:false,source_hash:null})};};

async function setup(db,{beforeWorkerReady=null,sendAfterSeconds=null,prepareCases=true,renewableCatalogBeforeBinding=false}={}){
 if(beforeWorkerReady!==null&&typeof beforeWorkerReady!=='function')throw Error('AB_REGULAR_FIXTURE_CALLBACK');
 if(sendAfterSeconds!==null&&(!Number.isSafeInteger(sendAfterSeconds)||sendAfterSeconds<901||sendAfterSeconds>86400))throw Error('AB_REGULAR_FIXTURE_SEND_AT');
 if(typeof prepareCases!=='boolean')throw Error('AB_REGULAR_FIXTURE_PREPARE_CASES');
 await db.query("SET TimeZone='UTC'");
 const fixture=await A.setup(db);
 if(renewableCatalogBeforeBinding){for(const brand of ['fish','aristo']){await db.query("UPDATE crm_audience_v2.config SET catalog=$2::jsonb,revision=revision+1,checked_at=clock_timestamp(),expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=$1",[brand,JSON.stringify(renewableCatalog(brand))]);const current=await Store.readCatalog(db.query.bind(db),brand);fixture.catalogHashes[brand]=current.catalog.catalog_hash;}}
 const sendAt=sendAfterSeconds===null?null:(await db.query("SELECT date_trunc('milliseconds',clock_timestamp())+make_interval(secs=>$1) AS at",[sendAfterSeconds])).rows[0].at;
 await db.transaction(async tx=>{for(const [id,reply]of [[100,'old@fishermans.com.br'],[101,'old@fishermans.com.br'],[200,'contato@oaristocrata.com'],[201,'contato@oaristocrata.com']]){
  await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(id)]);
  await tx.query('DELETE FROM campaign_media WHERE campaign_id=$1',[id]);
  await tx.query("UPDATE campaigns SET headers=jsonb_build_array(jsonb_build_object('Reply-To',$2::text)) WHERE id=$1",[id,reply]);
  if(sendAt!==null)await tx.query('UPDATE campaigns SET send_at=$2::timestamptz WHERE id=$1',[id,sendAt]);
 }});
 const prepareCase=async brand=>{
  const audience=await fixture.bindBoth(brand),protocol=await fixture.protocol(brand,1);
  if(!prepareCases)return {audience,protocol};
  const inspection=await fixture.inspect(protocol);
  if(inspection._http!==200)throw Error('AB_REGULAR_FIXTURE_INSPECT '+JSON.stringify({inspection,trace:fixture.trace.slice(-15)}));
  const saved=await fixture.prepare(protocol,inspection._body.intent);
  if(saved._http!==201)throw Error('AB_REGULAR_FIXTURE_PREPARE '+JSON.stringify(saved));
  const base={audience,protocol,saved:saved._body},review=await fixture.review(base);
  if(review._http!==201)throw Error('AB_REGULAR_FIXTURE_REVIEW '+JSON.stringify(review));
  return {...base,review:review._body.review};
 };
 const cases={fish:await prepareCase('fish'),aristo:await prepareCase('aristo')};
 await db.exec(`ALTER TABLE subscribers ADD COLUMN uuid uuid DEFAULT gen_random_uuid() NOT NULL;
  ALTER TABLE subscribers ADD COLUMN email text;
  ALTER TABLE subscribers ADD COLUMN created_at timestamptz DEFAULT now();
  ALTER TABLE subscribers ADD COLUMN updated_at timestamptz DEFAULT now();
  UPDATE subscribers SET email='person'||id||'@example.test';
  CREATE TABLE campaign_views(campaign_id integer,subscriber_id integer,created_at timestamptz NOT NULL);`);
 const native=read('tests/sql/journey-cart-fixture.sql');
 await db.exec(native.match(/CREATE TABLE shrigma_email_dispatch\([^\n]+;/)[0]);
 await db.exec(native.match(/CREATE FUNCTION shrigma_email_recipient_key\([^\n]+;/)[0]);
 await db.exec(read('n8n/growth/segment-runtime-access.sql'));
 for(const file of ['segment-listmonk-selection.sql','segment-regular-readiness.sql','segment-regular-delivery.sql','segment-regular-recovery.sql','segment-regular-worker-lease.sql','segment-regular-operation-guard.sql','segment-regular-admission.sql'])await db.exec(read('n8n/growth/'+file));
 await StoreFixture.dropShopifyStubs(db);
 await db.exec(read('n8n/growth/segment-shopify-facts.sql'));
 await db.exec(read('n8n/growth/segment-shopify-selection.sql'));

 const ingest=async evidence=>{const {customers,...meta}=evidence;return (await db.query(
  'SELECT crm_audience_v2.shopify_ingest_chunk($1,$2,$3) AS receipt',
  [JSON.stringify(meta),0,JSON.stringify(customers)])).rows[0].receipt;};
 for(const [index,brand]of ['fish','aristo'].entries()){
  const evidence=ShopifyFixture.evidence(brand,undefined,String(index+1)),source=StoreFixture.source(brand);
  const fieldHashes=Object.fromEntries(Facts.AGGREGATE_FIELDS.map(field=>[field,Facts.sourceHash(brand,field,source)]));
  await db.query(`INSERT INTO crm_audience_v2.shopify_source
   (brand,shop_id,domain,currency,timezone,query_sha256,workflow_id,producer_revision,field_hashes,ingestion_enabled)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,[brand,source.shop_id,evidence.shop,source.currency,source.timezone,evidence.query_sha256,evidence.workflow_id,evidence.workflow_version,JSON.stringify(fieldHashes)]);
  await ingest(evidence);
  await db.query('UPDATE crm_audience_v2.shopify_source SET enabled=true WHERE brand=$1',[brand]);
  await db.query("INSERT INTO crm_audience_v2.regular_sender_policy VALUES($1,$2,'000000000000','fixture','fixture',true)",[brand,brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com']);
 }
 if(beforeWorkerReady)await beforeWorkerReady({db,fixture,cases});
 const instance=randomUUID(),worker='a'.repeat(64),runtime='b'.repeat(64);
 await db.query(`UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true,
  worker_sha256=$1,runtime_sha256=$2,query_sha256='084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d',
  database_role=session_user,approved_at=clock_timestamp(),approved_by='fixture-only',topology_receipt_sha256=repeat('f',64)`,[worker,runtime]);
 const catalogBefore=renewableCatalogBeforeBinding?(await db.query("UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '5 minutes',expires_at=clock_timestamp()-interval '1 second' RETURNING brand,checked_at,expires_at")).rows:null;
 await db.query('SELECT crm_audience_v2.regular_worker_heartbeat($1,$2,$3)',[instance,worker,runtime]);
 let catalogRenewal=null;if(renewableCatalogBeforeBinding){const rows=(await db.query(`SELECT c.brand,c.checked_at,c.expires_at,c.expires_at>clock_timestamp()+interval '3 minutes' AS fresh FROM crm_audience_v2.config c ORDER BY c.brand`)).rows;
  if(rows.length!==2||rows.some(r=>!r.fresh||new Date(r.checked_at)<=new Date(catalogBefore.find(x=>x.brand===r.brand).checked_at)))throw Error('AB_REGULAR_FIXTURE_CATALOG_RENEWAL');catalogRenewal=rows;}
 const workerState=async()=>(await db.query(`SELECT d.enabled deployment_enabled,l.instance_id,l.suspended,l.expires_at>clock_timestamp() lease_current,
  (SELECT bool_and(enabled) FROM crm_audience_v2.regular_sender_policy) policies_enabled,
  (SELECT count(*) FROM crm_audience_v2.regular_delivery_campaign) delivery_controls
  FROM crm_audience_v2.regular_worker_deployment d CROSS JOIN crm_audience_v2.regular_worker_lease l WHERE d.singleton AND l.singleton`)).rows[0];
 return {...fixture,cases,instance,worker,runtime,ingest,workerState,catalogRenewal};
}
module.exports={setup};
