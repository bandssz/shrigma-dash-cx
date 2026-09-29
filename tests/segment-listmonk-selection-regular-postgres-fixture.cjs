'use strict';
// Reusable PostgreSQL 17 fixture for the local regular-selection candidate.
// Synthetic rows only; no A/B schema, HTTP, worker, transport or remote host.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const P=require('../n8n/growth/segment-listmonk-selection.cjs'),A=require('../n8n/growth/segment-audience-contract.js');
const S=require('../n8n/growth/segment-audience-store.cjs'),H=require('../n8n/growth/segment-audience-review.cjs'),B=require('../n8n/growth/segment-campaign-binding.cjs');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const upstreamPath=process.env.AB_UPSTREAM_SOURCE||path.resolve(root,'../../runtime/crm-audit-20260924/ab-controls/listmonk-v6.1.0-campaigns.sql');
const catalog=()=>({currency:null,timezone:null,shop_id:null,fields:[],products:[],origins:[]});
const rules={fish:{op:'and',rules:[{op:'in_list',list_id:21},{op:'in_list',list_id:22}]},aristo:{op:'or',rules:[{op:'in_list',list_id:31},{op:'in_list',list_id:32}]}};
const uuid=brand=>brand==='fish'?'00000000-0000-4000-8000-000000000101':'00000000-0000-4000-8000-000000000201';

async function setupRegularPostgres(db,{subscribersPerBrand,rulesByBrand={},catalogByBrand={}}){
 assert.ok(Number.isSafeInteger(subscribersPerBrand)&&subscribersPerBrand>=6);
 const selectedRules={fish:rulesByBrand.fish??rules.fish,aristo:rulesByBrand.aristo??rules.aristo};
 const selectedCatalogs={fish:catalogByBrand.fish??catalog(),aristo:catalogByBrand.aristo??catalog()};
 const definition=brand=>A.normalize({schema_version:A.VERSION,brand,name:'Cost '+brand,rule:selectedRules[brand]});
 const source=fs.readFileSync(upstreamPath,'utf8'),regular=P.patchRegularSource(source);
 const exec=sql=>typeof db.exec==='function'?db.exec(sql):db.query(sql);
 const transaction=async work=>{
  const pooled=typeof db.connect==='function'&&Number.isInteger(db.totalCount),client=pooled?await db.connect():db;
  try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}
  catch(e){await client.query('ROLLBACK');throw e;}finally{if(pooled)client.release();}
 };
 await db.query("SET statement_timeout='10s'");
 await exec(read('tests/campaign-provider-schema.sql'));
 await exec(`ALTER TABLE templates ADD COLUMN is_default boolean DEFAULT true;
  ALTER TABLE campaigns ADD COLUMN to_send integer DEFAULT 0;
  ALTER TABLE campaigns ADD COLUMN max_subscriber_id integer DEFAULT 0;
  ALTER TABLE campaigns ADD COLUMN last_subscriber_id integer DEFAULT 0;
  CREATE INDEX regular_cost_list_member ON subscriber_lists(list_id,subscriber_id);
  CREATE TABLE campaign_views(campaign_id integer,subscriber_id integer,created_at timestamptz NOT NULL);
  CREATE TABLE link_clicks(campaign_id integer,subscriber_id integer,created_at timestamptz NOT NULL);`);
 await exec(read('n8n/growth/campaign-provider.sql').split('-- Current regular-campaign eligibility')[0]);
 await exec(`CREATE TABLE crm_dash_chave(chave text PRIMARY KEY,painel text,ativo boolean DEFAULT true,revogada_em timestamptz,expira_em timestamptz,chave_hash text,chave_hash_curta text);
  CREATE TABLE shrigma_panel_permission_v1(principal_id text,area text,caps jsonb,PRIMARY KEY(principal_id,area));
  CREATE FUNCTION public.shrigma_panel_operator_v1(text,text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';`);
 await exec(read('n8n/growth/segment-audience-store.sql'));
 await exec(`CREATE TABLE crm_audience_v2.campaign_binding(
  campaign_id integer PRIMARY KEY,brand text,binding_version integer,campaign_version text,audience_id uuid,audience_revision integer,
  definition_hash text,context_hash text,base_list_id integer,catalog_hash text,binding jsonb,binding_hash text);
  CREATE TABLE crm_audience_v2.campaign_binding_revision(campaign_id integer,binding_version integer,binding jsonb,binding_hash text,PRIMARY KEY(campaign_id,binding_version));
  INSERT INTO lists VALUES(21,'Fish leaf single',ARRAY['fish'],'active','single'),(22,'Fish leaf double',ARRAY['fish'],'active','double'),
   (31,'Aristo leaf double',ARRAY['aristo'],'active','double'),(32,'Aristo leaf single',ARRAY['aristo'],'active','single');
  TRUNCATE subscriber_lists,subscribers;
  UPDATE campaign_lists SET list_id=17,list_name='Base Fish' WHERE campaign_id=100;
  UPDATE campaign_lists SET list_id=16,list_name='Base Aristo' WHERE campaign_id=200;
  UPDATE campaigns SET status='scheduled',send_at=clock_timestamp()-interval '1 minute' WHERE id IN(100,200);`);
 await db.query(`INSERT INTO subscribers(id,status) SELECT n,CASE WHEN n=3 OR n=$1+3 THEN 'blocklisted' ELSE 'enabled' END FROM generate_series(1,$1*2)n`,[subscribersPerBrand]);
 await db.query("INSERT INTO subscriber_lists SELECT n,17,CASE WHEN n=2 THEN 'unsubscribed' ELSE 'confirmed' END FROM generate_series(1,$1)n",[subscribersPerBrand]);
 await db.query("INSERT INTO subscriber_lists SELECT $1+n,16,CASE WHEN n=2 THEN 'unsubscribed' ELSE 'confirmed' END FROM generate_series(1,$1)n",[subscribersPerBrand]);
 await db.query("INSERT INTO subscriber_lists SELECT n,21,'unconfirmed' FROM generate_series(1,$1)n WHERE n%2=0",[subscribersPerBrand]);
 await db.query("INSERT INTO subscriber_lists SELECT n,22,CASE WHEN n=6 THEN 'unsubscribed' ELSE 'confirmed' END FROM generate_series(1,$1)n WHERE n%3=0",[subscribersPerBrand]);
 await db.query("INSERT INTO subscriber_lists SELECT $1+n,31,CASE WHEN n=6 THEN 'unsubscribed' ELSE 'confirmed' END FROM generate_series(1,$1)n WHERE n%2=0",[subscribersPerBrand]);
 await db.query("INSERT INTO subscriber_lists SELECT $1+n,32,'unconfirmed' FROM generate_series(1,$1)n WHERE n%3=0",[subscribersPerBrand]);
 for(const brand of ['fish','aristo'])await db.query(`UPDATE crm_audience_v2.config SET enabled=true,base_list_id=$2,catalog=$3::jsonb,
  checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=$1`,[brand,brand==='fish'?17:16,JSON.stringify(selectedCatalogs[brand])]);
 const definitions={};
 for(const [brand,cid]of [['fish',100],['aristo',200]]){
  const d=definition(brand),current=await S.readCatalog(db.query.bind(db),brand),context=S.pins(d,current),id=uuid(brand);definitions[brand]=d;
  await transaction(async tx=>{
   await tx.query(`INSERT INTO crm_audience_v2.audience(id,brand,name,definition,definition_hash,context,context_hash,created_by,updated_by)
    VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,'panel:cost','panel:cost')`,[id,brand,d.name,JSON.stringify(d),H.digest(d),JSON.stringify(context),H.digest(context)]);
   await tx.query(`INSERT INTO crm_audience_v2.revision(audience_id,version,definition,definition_hash,context,context_hash,archived,actor)
    VALUES($1,1,$2::jsonb,$3,$4::jsonb,$5,false,'panel:cost')`,[id,JSON.stringify(d),H.digest(d),JSON.stringify(context),H.digest(context)]);
  });
  const native=(await db.query('SELECT shrigma_campaign_current($1) AS value',[cid])).rows[0].value;
  const binding={contract:B.VERSION,brand,campaign_id:cid,campaign_version:native.version,binding_version:1,audience_id:id,audience_revision:1,
   definition_hash:H.digest(d),context_hash:H.digest(context),base_list_id:current.base_list_id,definition:d,context,catalog_hash:current.catalog.catalog_hash,
   authorizes_selection:false,authorizes_send:false},bindingHash=H.digest(binding);
  await db.query(`INSERT INTO crm_audience_v2.campaign_binding VALUES($1,$2,1,$3,$4,1,$5,$6,$7,$8,$9::jsonb,$10)`,
   [cid,brand,native.version,id,binding.definition_hash,binding.context_hash,binding.base_list_id,binding.catalog_hash,JSON.stringify(binding),bindingHash]);
  await db.query('INSERT INTO crm_audience_v2.campaign_binding_revision VALUES($1,1,$2::jsonb,$3)',[cid,JSON.stringify(binding),bindingHash]);
 }
 await exec(read('n8n/growth/segment-listmonk-selection.sql'));
 await exec(read('n8n/growth/segment-regular-readiness.sql'));
 await db.query('UPDATE crm_audience_v2.selection_runtime SET enabled=true,candidate_query_sha256=$1,verified_at=clock_timestamp()',[regular.patched_sha256]);
 await exec('ANALYZE');
 const countSQL=P.section(regular.source,'next-campaigns').text,batchSQL=P.section(regular.source,'next-campaign-subscribers').text;
 const reset=()=>db.query("UPDATE campaigns SET status='scheduled',started_at=NULL,to_send=91,max_subscriber_id=92,send_at=clock_timestamp()-interval '1 minute' WHERE id IN(100,200)");
 const count=()=>db.query(countSQL,[[],[]]);
 const batch=(cid,{cursor=0,max=subscribersPerBrand*2,limit=1000}={})=>db.query(batchSQL,[cid,'regular',cursor,max,[cid===100?17:16],limit]);
 return {source,regular,countSQL,batchSQL,count,batch,reset,subscribersPerBrand,definitions,rulesByBrand:selectedRules,catalogByBrand:selectedCatalogs,
  expected:{fish:Math.floor(subscribersPerBrand/6)-1,aristo:Math.floor(subscribersPerBrand/2)+Math.floor(subscribersPerBrand/3)-Math.floor(subscribersPerBrand/6)-2}};
}
module.exports={setupRegularPostgres};
