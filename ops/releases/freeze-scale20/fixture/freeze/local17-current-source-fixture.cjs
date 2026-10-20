'use strict';
// Extends only an empty, isolated synthetic PG fixture. Never run on a source.
const fs=require('node:fs'),path=require('node:path');
const Source=require('/current-source/n8n/growth/segment-audience-store.cjs');
const A=require('/current-source/n8n/growth/segment-audience-contract.js');
const Shopify=require('/current-source/n8n/growth/segment-shopify-facts.cjs');
const {digest}=require('./freeze-internal17.cjs');
async function setup(admin,transaction){
 await admin.query(fs.readFileSync(path.join(__dirname,'local17-fixture.sql'),'utf8'));
 await admin.query(`ALTER ROLE crm_audience_api LOGIN;
 GRANT SELECT ON crm_audience_v2.request TO crm_audience_api;
 GRANT SELECT,UPDATE ON crm_audience_v2.audience TO crm_audience_api;
 ALTER TABLE crm_audience_v2.config ADD COLUMN catalog jsonb;
 ALTER TABLE crm_audience_v2.config ADD COLUMN checked_at timestamptz;
 DROP FUNCTION crm_audience_v2.config_snapshot(text);
 CREATE FUNCTION crm_audience_v2.config_snapshot(b text) RETURNS SETOF crm_audience_v2.config LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$SELECT * FROM crm_audience_v2.config WHERE brand=b AND b IN ('fish','aristo') FOR SHARE$$;
 CREATE FUNCTION crm_audience_v2.catalog_lists(b text) RETURNS TABLE(id integer,name text,status text,optin text) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$SELECT l.id,l.name::text,l.status::text,l.optin::text FROM public.lists l WHERE b IN ('fish','aristo') AND public.shrigma_campaign_list_brand(l)=b ORDER BY l.id LIMIT 1001 FOR SHARE OF l$$;
 -- Synthetic producer attestations only; member SQL still uses real fixture
 -- facts, identities, native consent and operation-scoped product histories.
 CREATE OR REPLACE FUNCTION crm_audience_v2.shopify_source_current(b text,f text,p text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$SELECT EXISTS(SELECT 1 FROM crm_audience_v2.config c JOIN crm_audience_v2.shopify_source s USING(brand) CROSS JOIN LATERAL jsonb_array_elements(c.catalog->'fields')x WHERE c.brand=b AND s.current AND s.current_operation IS NOT NULL AND x->>'key'=f AND x->'available'='true'::jsonb AND x->>'source_hash'=p)$$;
 CREATE FUNCTION crm_audience_v2.shopify_snapshot(b text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$SELECT jsonb_build_object('current',s.current,'started_at',transaction_timestamp()-interval '1 hour','observed_at',transaction_timestamp()-interval '30 minutes','expires_at',transaction_timestamp()+interval '25 hours','customers',n,'mapped',n,'unresolved',0) FROM crm_audience_v2.shopify_source s CROSS JOIN LATERAL (SELECT count(*)::integer n FROM crm_audience_v2.shopify_customer_fact f WHERE f.brand=s.brand AND f.operation_id=s.current_operation)z WHERE s.brand=b$$;
 ALTER TABLE crm_audience_v2.audience ADD COLUMN name text NOT NULL DEFAULT '';
 ALTER TABLE crm_audience_v2.audience ADD COLUMN updated_by text NOT NULL DEFAULT 'panel:synthetic-native-owner';
 ALTER TABLE crm_audience_v2.audience ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
 ALTER TABLE crm_audience_v2.audience ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();`);
 const defs=JSON.parse(fs.readFileSync(path.join(__dirname,'local17-fixture-meta.json'))),entries={};
 for(const brand of ['aristo','fish']){
  const catalog={currency:'BRL',timezone:'America/Sao_Paulo',shop_id:'gid://shopify/Shop/'+(brand==='aristo'?'1':'2'),products:[1,2].map(n=>({id:'gid://shopify/Product/'+n,brand,name:'Synthetic product '+n,available:true})),origins:[]};catalog.fields=Object.keys(A.FIELDS).filter(k=>k!=='signup.recorded_origin').map(key=>({key,available:Shopify.FIELDS.includes(key),source_hash:Shopify.FIELDS.includes(key)?Shopify.sourceHash(brand,key,catalog):null}));
  await admin.query("UPDATE crm_audience_v2.config SET catalog=$2,checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '239 seconds' WHERE brand=$1",[brand,catalog]);
  const definition=A.normalize(defs[brand].definition);const current=await transaction(async tx=>{await tx.query(Source.SQL.setup);return Source.readCatalog(tx.query,brand);});if(!current.ready||!current.catalog.fields.find(x=>x.key==='purchase.product')?.available)throw Error('CURRENT_SOURCE_FIXTURE_UNAVAILABLE');const context=Source.pins(definition,current);
  await admin.query('UPDATE crm_audience_v2.audience SET name=$2,definition=$3,definition_hash=$4,context=$5,context_hash=$6 WHERE id=$1',[defs[brand].id,definition.name,definition,digest(definition),context,digest(context)]);entries[brand]={id:defs[brand].id,definition,context,catalogHash:current.catalog.catalog_hash};
 }
 return entries;
}
module.exports={setup,Source,Shopify};
