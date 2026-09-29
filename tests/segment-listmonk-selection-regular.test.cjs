'use strict';
// Complete Listmonk v6.1.0 count and batch queries over a disposable structural
// database. No A/B schema, worker, transport or operational activation exists.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const P=require('../n8n/growth/segment-listmonk-selection.cjs'),A=require('../n8n/growth/segment-audience-contract.js');
const S=require('../n8n/growth/segment-audience-store.cjs'),H=require('../n8n/growth/segment-audience-review.cjs'),B=require('../n8n/growth/segment-campaign-binding.cjs');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const sourcePath=process.env.AB_UPSTREAM_SOURCE||path.resolve(__dirname,'../../../runtime/crm-audit-20260924/ab-controls/listmonk-v6.1.0-campaigns.sql');
const available=fs.existsSync(sourcePath),source=available?fs.readFileSync(sourcePath,'utf8'):null;
const options={skip:available?false:'Requires the already-downloaded SHA-pinned Listmonk v6.1.0 campaigns.sql; never fetches network.'};
const catalog=()=>({currency:null,timezone:null,shop_id:null,fields:[],products:[],origins:[]});
const rules={fish:{op:'and',rules:[{op:'in_list',list_id:21},{op:'in_list',list_id:22}]},aristo:{op:'or',rules:[{op:'in_list',list_id:31},{op:'in_list',list_id:32}]}};
const definition=brand=>A.normalize({schema_version:A.VERSION,brand,name:'Regular '+brand,rule:rules[brand]});
const uuid=brand=>brand==='fish'?'00000000-0000-4000-8000-000000000101':'00000000-0000-4000-8000-000000000201';

async function setup(){
 const db=new PGlite(),regular=P.patchRegularSource(source),combined=P.patchSource(source);
 try{
  await db.exec(read('tests/campaign-provider-schema.sql'));
  await db.exec(`ALTER TABLE templates ADD COLUMN is_default boolean DEFAULT true;
   ALTER TABLE campaigns ADD COLUMN to_send integer DEFAULT 0;
   ALTER TABLE campaigns ADD COLUMN max_subscriber_id integer DEFAULT 0;
   ALTER TABLE campaigns ADD COLUMN last_subscriber_id integer DEFAULT 0;
   CREATE INDEX regular_selection_list_member ON subscriber_lists(list_id,subscriber_id);
   CREATE TABLE crm_dash_chave(chave text PRIMARY KEY,painel text,ativo boolean DEFAULT true,revogada_em timestamptz,expira_em timestamptz,chave_hash text,chave_hash_curta text);
   CREATE TABLE shrigma_panel_permission_v1(principal_id text,area text,caps jsonb,PRIMARY KEY(principal_id,area));
   CREATE FUNCTION public.shrigma_panel_operator_v1(text,text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';`);
  const provider=read('n8n/growth/campaign-provider.sql');
  await db.exec(provider.slice(0,provider.indexOf('-- Current regular-campaign eligibility')));
  await db.exec(read('n8n/growth/segment-audience-store.sql'));
  await db.exec(`CREATE TABLE crm_audience_v2.campaign_binding(
   campaign_id integer PRIMARY KEY,brand text,binding_version integer,campaign_version text,audience_id uuid,audience_revision integer,
   definition_hash text,context_hash text,base_list_id integer,catalog_hash text,binding jsonb,binding_hash text);
   CREATE TABLE crm_audience_v2.campaign_binding_revision(campaign_id integer,binding_version integer,binding jsonb,binding_hash text,PRIMARY KEY(campaign_id,binding_version));
   INSERT INTO lists VALUES(21,'Fish leaf single',ARRAY['fish'],'active','single'),(22,'Fish leaf double',ARRAY['fish'],'active','double'),
    (31,'Aristo leaf double',ARRAY['aristo'],'active','double'),(32,'Aristo leaf single',ARRAY['aristo'],'active','single');
   TRUNCATE subscriber_lists,subscribers;
   INSERT INTO subscribers SELECT n,CASE WHEN n=11 THEN 'blocklisted' WHEN n=12 THEN 'disabled' ELSE 'enabled' END FROM generate_series(1,12)n;
   INSERT INTO subscriber_lists SELECT n,17,CASE WHEN n=10 THEN 'unsubscribed' ELSE 'confirmed' END FROM generate_series(1,12)n;
   INSERT INTO subscriber_lists SELECT n,16,CASE WHEN n=10 THEN 'unconfirmed' ELSE 'confirmed' END FROM generate_series(1,12)n;
   INSERT INTO subscriber_lists SELECT n,21,'unconfirmed' FROM generate_series(1,8)n;
   INSERT INTO subscriber_lists SELECT n,22,CASE WHEN n=6 THEN 'unconfirmed' ELSE 'confirmed' END FROM generate_series(5,10)n;
   INSERT INTO subscriber_lists VALUES(1,31,'confirmed'),(2,31,'confirmed'),(8,32,'unconfirmed'),(9,32,'unconfirmed');
   INSERT INTO subscriber_lists VALUES(1,3,'confirmed'),(3,3,'confirmed'),(11,3,'confirmed'),(12,3,'confirmed');
   UPDATE campaign_lists SET list_id=17,list_name='Base Fish' WHERE campaign_id=100;
   UPDATE campaign_lists SET list_id=16,list_name='Base Aristo' WHERE campaign_id=200;
   INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":300}'::jsonb)).* FROM campaigns c WHERE id=100;
   INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":301}'::jsonb)).* FROM campaigns c WHERE id=100;
   INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(300,3,'Legacy Fish'),(301,3,'Legacy Fish');
   UPDATE campaigns SET status='scheduled',send_at=clock_timestamp()-interval '1 minute' WHERE id IN(100,200,300,301);`);
  for(const brand of ['fish','aristo'])await db.query(`UPDATE crm_audience_v2.config SET enabled=true,base_list_id=$2,catalog=$3::jsonb,
   checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=$1`,[brand,brand==='fish'?17:16,JSON.stringify(catalog())]);
  for(const [brand,cid]of [['fish',100],['aristo',200]]){
   const d=definition(brand),current=await S.readCatalog(db.query.bind(db),brand),context=S.pins(d,current),id=uuid(brand);
   await db.transaction(async tx=>{await tx.query(`INSERT INTO crm_audience_v2.audience(id,brand,name,definition,definition_hash,context,context_hash,created_by,updated_by)
    VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,'panel:regular','panel:regular')`,[id,brand,d.name,JSON.stringify(d),H.digest(d),JSON.stringify(context),H.digest(context)]);
    await tx.query(`INSERT INTO crm_audience_v2.revision(audience_id,version,definition,definition_hash,context,context_hash,archived,actor)
    VALUES($1,1,$2::jsonb,$3,$4::jsonb,$5,false,'panel:regular')`,[id,JSON.stringify(d),H.digest(d),JSON.stringify(context),H.digest(context)]);});
   const native=(await db.query('SELECT shrigma_campaign_current($1) AS value',[cid])).rows[0].value;
   const binding={contract:B.VERSION,brand,campaign_id:cid,campaign_version:native.version,binding_version:1,audience_id:id,audience_revision:1,
    definition_hash:H.digest(d),context_hash:H.digest(context),base_list_id:current.base_list_id,definition:d,context,catalog_hash:current.catalog.catalog_hash,
    authorizes_selection:false,authorizes_send:false},bindingHash=H.digest(binding);
   await db.query(`INSERT INTO crm_audience_v2.campaign_binding VALUES($1,$2,1,$3,$4,1,$5,$6,$7,$8,$9::jsonb,$10)`,
    [cid,brand,native.version,id,binding.definition_hash,binding.context_hash,binding.base_list_id,binding.catalog_hash,JSON.stringify(binding),bindingHash]);
   await db.query('INSERT INTO crm_audience_v2.campaign_binding_revision VALUES($1,1,$2::jsonb,$3)',[cid,JSON.stringify(binding),bindingHash]);
  }
  await db.exec(read('n8n/growth/segment-listmonk-selection.sql'));
  await db.exec(read('n8n/growth/segment-regular-readiness.sql'));
  await db.query('UPDATE crm_audience_v2.selection_runtime SET enabled=true,candidate_query_sha256=$1,verified_at=clock_timestamp()',
   [regular.patched_sha256]);
  const count=()=>db.query(P.section(regular.source,'next-campaigns').text,[[],[]]);
  const batch=async(cid,{sql=regular.source,listIds=cid===100?[17]:cid===200?[16]:[3]}={})=>(await db.query(P.section(sql,'next-campaign-subscribers').text,[cid,'regular',0,12,listIds,100])).rows.map(r=>r.id);
  return {db,regular,combined,count,batch};
 }catch(e){await db.close();throw e;}
}

test('selection-only transforms the two complete upstream queries without A/B dependencies',options,async()=>{
 const regular=P.patchRegularSource(source),combined=P.patchSource(source);
 assert.equal(regular.variant,'selection-only');assert.equal(regular.requires_ab,false);
 assert.equal(regular.source_sha256,'37b1b131a6b9005141b1bf2e32dde53a68838184bc4348f6c97fb61b581c5882');
 assert.equal(regular.patched_sha256,'be2a4a422574fe328bf23f6f9cfef84a71a9f4be0f95ce9d3970a5ecf949933f');
 assert.equal(combined.patched_sha256,'3fd5311813ee746c8059796ef5aa713154430cf06e998e5be7424cb163d62daa');
 assert.doesNotMatch(regular.source,/crm_ab_/);assert.throws(()=>P.patchRegularSource(source+'\n'),/SOURCE_DRIFT/);
 for(const name of regular.changed_queries)assert.match(P.section(regular.source,name).text,/crm_audience_v2\.selection_regular_matches\([^,]+, s\.id\)/);
 const x=await setup();try{
  const abObjects=(await x.db.query("SELECT count(*)::integer AS value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'crm_ab_%'")).rows[0].value;
  assert.equal(abObjects,0);await x.count();
  const counts=(await x.db.query('SELECT id,to_send FROM campaigns WHERE id IN(100,200,300,301) ORDER BY id')).rows;
  assert.deepEqual(counts,[{id:100,to_send:3},{id:200,to_send:4},{id:300,to_send:3},{id:301,to_send:3}]);
  assert.deepEqual(await x.batch(100),[5,7,8]);assert.deepEqual(await x.batch(200),[1,2,8,9]);
  assert.deepEqual(await x.batch(300),await x.batch(301,{sql:source}),'unbound regular campaign preserves upstream rows and order');
 }finally{await x.db.close();}
});

test('regular readiness aborts state changes while legitimate empty audiences write an explicit zero',options,async()=>{
 const x=await setup();try{
  await x.count();assert.deepEqual(await x.batch(100),[5,7,8]);
  const state=async()=>(await x.db.query('SELECT status,sent,to_send,max_subscriber_id,last_subscriber_id,started_at,updated_at FROM campaigns WHERE id=100')).rows[0];
  const before=await state();
  await x.db.exec('UPDATE crm_audience_v2.selection_runtime SET enabled=false');
  await assert.rejects(x.count(),/SEGMENT_SELECTION_UNAVAILABLE/);
  await assert.rejects(x.batch(100),/SEGMENT_SELECTION_UNAVAILABLE/);
  assert.deepEqual(await state(),before,'readiness failure rolls back count, flags and cursor');
  await x.db.query('UPDATE crm_audience_v2.selection_runtime SET enabled=true,candidate_query_sha256=$1,verified_at=clock_timestamp()',[x.regular.patched_sha256]);

  await x.db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");
  await x.count();let empty=await state();
  assert.equal(empty.to_send,0);assert.equal(empty.max_subscriber_id,0);assert.equal(empty.last_subscriber_id,before.last_subscriber_id);
  assert.deepEqual(await x.batch(100),[]);assert.equal((await state()).last_subscriber_id,before.last_subscriber_id);

  await x.db.exec("UPDATE subscriber_lists SET status='confirmed' WHERE list_id=17;UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=21");
  assert.equal((await x.db.query('SELECT crm_audience_v2.selection_regular_ready(100) AS value')).rows[0].value,true);
  await x.count();empty=await state();assert.equal(empty.to_send,0);assert.equal(empty.max_subscriber_id,0,'a valid AND=false audience is empty, not unavailable');
 }finally{await x.db.close();}
});
