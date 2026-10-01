'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {setupProducts,productEvidence}=require('./segment-shopify-products-fixture.cjs'),A=require('./segment-audience-store-fixture.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const Facts=require('../n8n/growth/segment-shopify-facts.cjs'),Review=require('../n8n/growth/segment-audience-review.cjs');
const RECORDED_SQL='n8n/growth/segment-recorded-origin.sql',CURRENT_COUNT='4adcbdd47bcb8d731c2d35bd60ea0ff9';
const rule=(value='vip_alma')=>({op:'condition',field:'signup.recorded_origin',operator:'is',value});

// PGlite proves the exact versioned component bodies, never the PostgreSQL
// installation boundary. Only the single leading guard is omitted, by exact
// delimiters; no hash, function body or dependency is replaced.
function recordedComponentSql(){
 const sql=A.read(RECORDED_SQL),start='DO $boundary$\n',finish='END $boundary$;';
 const a=sql.indexOf(start),b=sql.indexOf(finish,a+start.length),end=b+finish.length;
 assert.ok(a>=0&&b>a,'RECORDED_COMPONENT_BOUNDARY_MISSING');
 assert.equal(sql.indexOf(start,a+1),-1,'RECORDED_COMPONENT_BOUNDARY_DUPLICATE');
 assert.equal(sql.indexOf(finish,end),-1,'RECORDED_COMPONENT_BOUNDARY_DUPLICATE');
 const boundary=sql.slice(a,end);assert.equal(boundary.split(CURRENT_COUNT).length-1,1,'RECORDED_COMPONENT_COUNT_PIN');
 return sql.slice(0,a)+sql.slice(end);
}

async function setupRecordedSchema(db){
 await db.exec(`ALTER TABLE subscribers ADD COLUMN name text NOT NULL DEFAULT 'Synthetic',ADD COLUMN attribs jsonb NOT NULL DEFAULT '{}';CREATE UNIQUE INDEX recorded_fixture_email ON subscribers(email);
 CREATE SEQUENCE recorded_fixture_subscriber START 1000;ALTER TABLE subscribers ALTER COLUMN id SET DEFAULT nextval('recorded_fixture_subscriber');
 ALTER TABLE subscriber_lists ADD COLUMN meta jsonb NOT NULL DEFAULT '{}',ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
 INSERT INTO lists(id,name,tags,status,optin) VALUES(19,'VIP Aristo',ARRAY['aristo'],'active','double');`);
 await db.exec(A.read('n8n/growth/vip-consent.sql'));await db.exec(A.read('n8n/growth/vip-recorded-origin.sql'));
}

async function finishRecorded(db,x,tier,native={}){
 const coverage=new Date(Date.now()-1000).toISOString();
 for(const [origin,producer,scope]of [['vip_alma','NAmTWZ7vddQ8LX1k','aaaaaaaa-1111-4111-8111-111111111111'],['vip_desodorante','ywJDsgBDhZOBgoxb','bbbbbbbb-1111-4111-8111-111111111111']])await db.query('INSERT INTO crm_audience_v2.recorded_origin_source(canonical_origin,scope_id,producer_id,producer_revision,coverage_started_at,enabled) VALUES($1,$2,$3,$4,$5,true)',[origin,scope,producer,'a'.repeat(64),coverage]);
 const record=async(sid,source='alma',event=randomUUID())=>(await db.query('SELECT * FROM crm_audience_v2.recorded_origin_subscribe_v2($1,$2,false,$3,$4,$5)',['person'+sid+'@example.test','synthetic-form',source,event,'a'.repeat(64)])).rows[0];
 for(const brand of ['fish','aristo'])await db.query('SELECT crm_audience_v2.refresh_native_catalog($1)',[brand]);
 const current=brand=>Store.readCatalog(db.query.bind(db),brand);
 const count=async(r=rule(),brand='aristo')=>{const c=await current(brand);return Counter.countAudience({definition:A.definition(brand,r),baseListId:brand==='fish'?17:16,catalog:c.catalog,query:db.query.bind(db)});};
 return {...x,current,record,count,coverage,tier,...native};
}

async function setupRecordedComponent(db){
 assert.equal(Facts.PRODUCT_SEMANTICS_MODE,'v1','RECORDED_COMPONENT_REQUIRES_V1');
 const x=await setupProducts(db);await db.exec(A.read('n8n/growth/segment-shopify-count-performance.sql'));await setupRecordedSchema(db);
 await db.exec(recordedComponentSql());
 return finishRecorded(db,x,'component-pglite-no-install-guard');
}

async function setupRecordedNativeV2(db){
 assert.equal(Facts.PRODUCT_SEMANTICS_MODE,'v2','RECORDED_NATIVE_REQUIRES_V2');
 const context=(await db.query("SELECT current_setting('server_version_num') version,current_user role")).rows[0];
 assert.deepEqual(context,{version:'170010',role:'postgres'});
 const x=await setupProducts(db);await db.exec(A.read('n8n/growth/segment-shopify-count-performance.sql'));await db.exec(A.read('n8n/growth/segment-shopify-sync-runtime.sql'));
 // setupProducts loaded Facts in v2 mode for the future API. The frozen source
 // operations below are genuine v1 snapshots, so restore their v1 product pin
 // exactly as the versioned v2 migration proof does before ingest/attestation.
 for(const brand of ['fish','aristo']){
  const source=A.source(brand),legacy=Review.digest({semantics:Facts.PRODUCT_SEMANTICS_V1,brand,field:'purchase.product',shop_id:source.shop_id,currency:source.currency,timezone:source.timezone});
  await db.query("UPDATE crm_audience_v2.shopify_source SET field_hashes=jsonb_set(field_hashes,'{purchase.product}',to_jsonb($2::text)) WHERE brand=$1",[brand,legacy]);
 }
 const evidence={fish:productEvidence('fish',[{id:1,products:[101]},{id:2,products:[]}],'951'),aristo:productEvidence('aristo',[{id:1,products:[201]},{id:2,products:[]}],'952')};
 for(const item of Object.values(evidence)){await x.ingestProducts(item);await x.enableProducts(item.brand);}
 await db.exec(A.read('n8n/growth/segment-shopify-product-quarantine.sql'));await setupRecordedSchema(db);
 // The current installer must reject the pre-v2 counter atomically.
 await assert.rejects(db.exec(A.read(RECORDED_SQL)),/RECORDED_ORIGIN_COUNT_BOUNDARY/);
 assert.equal((await db.query("SELECT to_regprocedure('crm_audience_v2.recorded_origin_match(jsonb,integer,text,text)') IS NULL absent")).rows[0].absent,true);
 await db.exec(A.read('n8n/growth/segment-shopify-product-history-completeness-v2.sql'));
 for(const [brand,item] of Object.entries(evidence)){
  const meta={brand,operation_id:item.operation_id,source_sha256:item.source_sha256,query_sha256:item.query_sha256,producer_revision:item.workflow_version,customer_count:item.counts.customers,incomplete_count:0,proof_sha256:(brand==='fish'?'a':'b').repeat(64)};
  const receipt=(await db.query('SELECT crm_audience_v2.shopify_apply_product_history_attestation($1,$2) value',[JSON.stringify(meta),'[]'])).rows[0].value;
  assert.equal(receipt.replayed,false);assert.equal(receipt.authorizes_send,false);await db.query('SELECT crm_audience_v2.refresh_native_catalog($1)',[brand]);
 }
 const countBody=(await db.query("SELECT md5(prosrc) body FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)')")).rows[0].body;
 assert.equal(countBody,CURRENT_COUNT);await db.exec(A.read(RECORDED_SQL));
 return finishRecorded(db,x,'native-postgres17-v2-guarded-install',{count_body_before_recorded:countBody,evidence});
}

module.exports={setupRecordedComponent,setupRecordedNativeV2,recordedComponentSql,rule};
