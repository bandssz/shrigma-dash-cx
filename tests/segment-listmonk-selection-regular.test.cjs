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
  // Catalog reads use the current ownership function, with the exclusive
  // brand registry already present in campaign-provider-schema.sql.
  await db.exec(read('n8n/growth/campaign-template-ownership.sql'));
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
  const bindingSQL=read('n8n/growth/segment-campaign-binding.sql');
  const releaseStart=bindingSQL.indexOf(' CREATE TABLE crm_audience_v2.campaign_binding_release (');
  const releaseEnd=bindingSQL.indexOf(' EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.campaign_binding_effective',releaseStart);
  const effective=bindingSQL.match(/ EXECUTE \$ddl\$(CREATE FUNCTION crm_audience_v2\.campaign_binding_effective\(cid integer\)[\s\S]*?)\$ddl\$;/);
  assert.ok(releaseStart>=0&&releaseEnd>releaseStart&&effective,'REGULAR_EFFECTIVE_BINDING_SOURCE');
  await db.exec(bindingSQL.slice(releaseStart,releaseEnd)+effective[1]+';\nREVOKE ALL ON crm_audience_v2.campaign_binding_release FROM PUBLIC;');
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
 assert.equal(regular.patched_sha256,'7abbff0c76a874e233f8cd6ae99c15b33632e34d1ac93b0b3ca337ed08868d9a');
 assert.equal(combined.patched_sha256,'3fd5311813ee746c8059796ef5aa713154430cf06e998e5be7424cb163d62daa');
 assert.doesNotMatch(regular.source,/crm_ab_/);assert.throws(()=>P.patchRegularSource(source+'\n'),/SOURCE_DRIFT/);
 for(const name of regular.changed_queries)assert.match(P.section(regular.source,name).text,/crm_audience_v2\.selection_regular_matches\([^,]+, s\.id\)/);
	const historicalWorker=P.patchRegularWorkerSource(source),rfmWorker=P.patchRfmWorkerSource(source);
	assert.equal(historicalWorker.patched_sha256,P.REGULAR_WORKER_SOURCE_SHA256,'the proven 084a worker remains byte-identical');
	assert.equal(rfmWorker.base_worker_sha256,historicalWorker.patched_sha256);assert.equal(rfmWorker.patched_sha256,P.RFM_WORKER_SOURCE_SHA256);assert.notEqual(rfmWorker.patched_sha256,historicalWorker.patched_sha256);
	assert.equal(rfmWorker.variant,'regular-worker-rfm-fast-path');assert.equal(rfmWorker.authorizes_send,false);
	assert.match(P.section(rfmWorker.source,'next-campaigns').text,/rfm_native_count\(ac\.context\)/);
	assert.match(P.section(rfmWorker.source,'next-campaigns').text,/NOT crm_audience_v2\.rfm_native_context_fast\(context\)/,'A\/B contexts remain on their proven membership-aware matcher');
	assert.match(P.section(rfmWorker.source,'next-campaign-subscribers').text,/rfm_native_subscriber_ids\(/);
	assert.doesNotMatch(P.section(rfmWorker.source,'next-campaign-subscribers').text,/LEFT JOIN rfmIDs|CASE WHEN crm_audience_v2\.rfm_native_context_fast/);
	assert.match(P.section(rfmWorker.source,'next-campaign-subscribers').text,/campLists AS \([\s\S]*fastContext AS MATERIALIZED \([\s\S]*EXISTS \(SELECT 1 FROM campLists\)[\s\S]*CROSS JOIN LATERAL crm_audience_v2\.rfm_native_subscriber_ids/);
	assert.match(P.section(rfmWorker.source,'next-campaign-subscribers').text,/selectedIDs AS MATERIALIZED[\s\S]*SELECT id FROM rfmIDs[\s\S]*UNION ALL[\s\S]*SELECT id FROM legacyIDs/);
	assert.match(P.section(rfmWorker.source,'next-campaign-subscribers').text,/legacyIDs AS MATERIALIZED[\s\S]*selection_regular_matches/);
	assert.equal(P.patchRegularWorkerSource(source).source,historicalWorker.source,'constructing the new candidate never mutates the historical worker');
 const x=await setup();try{
  const abObjects=(await x.db.query("SELECT count(*)::integer AS value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'crm_ab_%'")).rows[0].value;
  assert.equal(abObjects,0);await x.count();
  const counts=(await x.db.query('SELECT id,to_send FROM campaigns WHERE id IN(100,200,300,301) ORDER BY id')).rows;
  assert.deepEqual(counts,[{id:100,to_send:3},{id:200,to_send:4},{id:300,to_send:3},{id:301,to_send:3}]);
  assert.deepEqual(await x.batch(100),[5,7,8]);assert.deepEqual(await x.batch(200),[1,2,8,9]);
  assert.deepEqual(await x.batch(300),await x.batch(301,{sql:source}),'unbound regular campaign preserves upstream rows and order');
 }finally{await x.db.close();}
});

test('RFM worker query uses a disjoint fast branch while synthetic legacy contexts keep non-RFM, mixed, unbound and A/B behavior',options,async()=>{
 const x=await setup();try{
  const candidate=P.patchRfmWorkerSource(source);
  await x.db.exec(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":302}'::jsonb)).* FROM campaigns c WHERE id=300;
   INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(302,3,'Legacy Fish');
   CREATE FUNCTION crm_audience_v2.rfm_rule_valid(rule jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT rule->>'op'='condition' AND rule->>'field'='relationship.rfm'$$;
   CREATE FUNCTION crm_audience_v2.rfm_native_context_fast(ctx jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$SELECT ctx->'bound'='true'::jsonb AND crm_audience_v2.rfm_rule_valid(ctx#>'{definition,rule}') AND NOT(ctx ?| ARRAY['ab_test_id','ab_arm','ab_scope_hash'])$$;
   CREATE FUNCTION crm_audience_v2.rfm_native_count(ctx jsonb) RETURNS TABLE(to_send bigint,max_subscriber_id integer) LANGUAGE sql STABLE AS $$SELECT 2::bigint,7 WHERE crm_audience_v2.rfm_native_context_fast(ctx)$$;
	   CREATE FUNCTION crm_audience_v2.rfm_native_subscriber_ids(ctx jsonb,campaign_type text,list_ids integer[],after_id integer,max_id integer,batch_limit integer) RETURNS TABLE(id integer) LANGUAGE plpgsql STABLE AS $$BEGIN
	    IF NOT crm_audience_v2.rfm_native_context_fast(ctx) THEN RETURN;END IF;
	    IF (SELECT ca.status::text FROM campaigns ca WHERE ca.id=100)<>'running' THEN RAISE EXCEPTION 'SYNTHETIC_FAST_HELPER_CALLED_BEFORE_RUNNING';END IF;
	    RETURN QUERY SELECT candidate FROM unnest(ARRAY[5,7]) candidate WHERE candidate>after_id AND candidate<=max_id ORDER BY candidate LIMIT batch_limit;
	   END$$;
   CREATE OR REPLACE FUNCTION crm_audience_v2.selection_worker_context(cid integer) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT CASE cid
    WHEN 100 THEN '{"bound":true,"brand":"fish","base_list_id":17,"definition":{"rule":{"op":"condition","field":"relationship.rfm","operator":"is","value":"campeao"}}}'::jsonb
    WHEN 200 THEN '{"bound":true,"brand":"aristo","base_list_id":16,"definition":{"rule":{"op":"condition","field":"relationship.rfm","operator":"is","value":"campeao"}},"allowed_ids":[1,8],"ab_test_id":"00000000-0000-4000-8000-000000000099","ab_arm":"a","ab_scope_hash":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}'::jsonb
    WHEN 300 THEN '{"bound":true,"brand":"fish","base_list_id":3,"definition":{"rule":{"op":"in_list","list_id":3}},"allowed_ids":[1,3]}'::jsonb
    WHEN 302 THEN '{"bound":true,"brand":"fish","base_list_id":3,"definition":{"rule":{"op":"and","rules":[{"op":"in_list","list_id":3},{"op":"condition","field":"relationship.rfm","operator":"is","value":"campeao"}]}},"allowed_ids":[3]}'::jsonb
    ELSE '{"bound":false}'::jsonb END$$;
   CREATE OR REPLACE FUNCTION crm_audience_v2.selection_regular_matches(ctx jsonb,sid integer) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT CASE WHEN ctx->'bound'='false'::jsonb THEN true ELSE ctx->'allowed_ids' @> to_jsonb(sid) END$$;`);
	  const batch=async(id,list)=>(await x.db.query(P.section(candidate.source,'next-campaign-subscribers').text,[id,'regular',0,12,[list],100])).rows.map(r=>r.id);
	  await x.db.exec("UPDATE campaigns SET status='draft' WHERE id=100");assert.deepEqual(await batch(100,17),[],'bound draft does not invoke the synthetic fast helper');
	  await x.db.exec("UPDATE campaigns SET status='scheduled',send_at=clock_timestamp()-interval '1 minute' WHERE id=100");assert.deepEqual(await batch(100,17),[],'bound scheduled does not invoke the synthetic fast helper');
	  await x.db.query(P.section(candidate.source,'next-campaigns').text,[[],[]]);
  const counts=(await x.db.query('SELECT id,to_send,max_subscriber_id FROM campaigns WHERE id IN(100,200,300,301,302) ORDER BY id')).rows;
  assert.deepEqual(counts,[{id:100,to_send:2,max_subscriber_id:7},{id:200,to_send:2,max_subscriber_id:8},{id:300,to_send:2,max_subscriber_id:3},{id:301,to_send:3,max_subscriber_id:12},{id:302,to_send:1,max_subscriber_id:3}]);
  assert.deepEqual(await batch(100,17),[5,7],'exact root RFM uses the fast ID branch');
  assert.deepEqual(await batch(200,16),[1,8],'synthetic A/B markers keep the legacy matcher branch');
  assert.deepEqual(await batch(300,3),[1,3],'non-RFM remains legacy');
  assert.deepEqual(await batch(301,3),[1,3,12],'unbound preserves native list behavior');
  assert.deepEqual(await batch(302,3),[3],'mixed RFM remains legacy');
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
