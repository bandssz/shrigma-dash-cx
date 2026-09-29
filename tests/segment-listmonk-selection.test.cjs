'use strict';
// SQL selection proof only. This disposable structural database deliberately
// does not install the binding guard: complete upstream count changes status.
// No guard is disabled, no runtime process runs, and no SMTP delivery is modeled.
// Real guarded binding transitions are covered by segment-campaign-binding tests.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,read,uuid}=require('./ab-experiment-fixture.cjs');
const P=require('../n8n/growth/segment-listmonk-selection.cjs');
const AB=require('../n8n/growth/ab-listmonk-cohort-patch.cjs');
const A=require('../n8n/growth/segment-audience-contract.js');
const S=require('../n8n/growth/segment-audience-store.cjs');
const H=require('../n8n/growth/segment-audience-review.cjs');
const B=require('../n8n/growth/segment-campaign-binding.cjs');
const Count=require('../n8n/growth/segment-audience-listmonk.cjs');
const sourcePath=process.env.AB_UPSTREAM_SOURCE||path.resolve(__dirname,'../../../runtime/crm-audit-20260924/ab-controls/listmonk-v6.1.0-campaigns.sql');
const available=fs.existsSync(sourcePath),source=available?fs.readFileSync(sourcePath,'utf8'):null;
const options={skip:available?false:'Requires the already-downloaded SHA-pinned AB_UPSTREAM_SOURCE; never fetches network.'};
const catalog=()=>({currency:null,timezone:null,shop_id:null,fields:[],products:[],origins:[]});
const definition=(brand,rule)=>A.normalize({schema_version:A.VERSION,brand,name:'Público sintético '+brand,rule});
const rules={fish:{op:'and',rules:[{op:'in_list',list_id:21},{op:'in_list',list_id:22}]},
 aristo:{op:'or',rules:[{op:'in_list',list_id:31},{op:'in_list',list_id:32}]}};
async function setup(){
 const x=await fixture(),db=x.db,patched=P.patchSource(source);
 try{
  await db.exec(`ALTER TABLE templates ADD COLUMN is_default boolean DEFAULT true;
   ALTER TABLE campaigns ADD COLUMN to_send integer DEFAULT 0;
   ALTER TABLE campaigns ADD COLUMN max_subscriber_id integer DEFAULT 0;
   ALTER TABLE campaigns ADD COLUMN last_subscriber_id integer DEFAULT 0;
   CREATE INDEX synthetic_selection_list_member ON subscriber_lists(list_id,subscriber_id);
   INSERT INTO lists VALUES(21,'Fish leaf single',ARRAY['fish'],'active','single'),(22,'Fish leaf double',ARRAY['fish'],'active','double'),
    (31,'Aristo leaf double',ARRAY['aristo'],'active','double'),(32,'Aristo leaf single',ARRAY['aristo'],'active','single');
   DELETE FROM subscriber_lists WHERE list_id=17 AND subscriber_id>200;
   UPDATE lists SET optin='double' WHERE id=16;
   INSERT INTO subscriber_lists SELECT n,16,'confirmed' FROM generate_series(1,200)n;
   INSERT INTO subscriber_lists SELECT n,21,'unconfirmed' FROM generate_series(1,140)n;
   INSERT INTO subscriber_lists SELECT n,22,CASE WHEN n%3=0 THEN 'unconfirmed' ELSE 'confirmed' END FROM generate_series(81,200)n;
   INSERT INTO subscriber_lists SELECT n,31,'confirmed' FROM generate_series(1,30)n;
   INSERT INTO subscriber_lists SELECT n,32,'unconfirmed' FROM generate_series(161,200)n;
   INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":300}'::jsonb)).* FROM campaigns c WHERE id=100;
   INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(300,3,'Fish');
   INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":400}'::jsonb)).* FROM campaigns c WHERE id=100;
   INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(400,17,'Base Fish');
   DELETE FROM campaign_lists WHERE campaign_id IN(100,101,200,201);
   INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(100,17,'Base Fish'),(101,17,'Base Fish'),(200,16,'Base Aristo'),(201,16,'Base Aristo');
   -- Installation dependency only, never called; no auth behavior is asserted.
   CREATE FUNCTION public.shrigma_panel_operator_v1(text,text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';`);
  await db.exec(read('tests/fixtures/journey-graph-auth.sql'));
  await db.exec('CREATE TABLE public.shrigma_panel_permission_v1(principal_id text,area text,caps jsonb,PRIMARY KEY(principal_id,area));');
  await db.exec(read('n8n/growth/segment-audience-store.sql'));
  // Schema-compatible snapshot tables, not a replacement installer. No mutation
  // authority is inferred from this structural selection-only fixture.
  await db.exec(`CREATE TABLE crm_audience_v2.campaign_binding(
   campaign_id integer PRIMARY KEY,brand text,binding_version integer,campaign_version text,
   audience_id uuid,audience_revision integer,definition_hash text,context_hash text,base_list_id integer,
   catalog_hash text,binding jsonb,binding_hash text);
   CREATE TABLE crm_audience_v2.campaign_binding_revision(campaign_id integer,binding_version integer,binding jsonb,binding_hash text,PRIMARY KEY(campaign_id,binding_version));`);
  for(const brand of ['fish','aristo'])await db.query(`UPDATE crm_audience_v2.config SET enabled=true,base_list_id=$2,catalog=$3::jsonb,
   checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=$1`,[brand,brand==='fish'?17:16,JSON.stringify(catalog())]);
  const protocols=[];
  for(const [i,brand]of ['fish','aristo'].entries()){
   const protocol=await x.protocol(brand,i+1);await x.prepare(protocol,101+i);protocols.push(protocol);
  }
  await db.exec(read('n8n/growth/ab-experiment-selection.sql'));
  // The old pin proves the unchanged A/B component; it is NOT an attestation
  // that this new composed candidate is the deployed native query.
  await db.query("UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256=$1,verified_at=now()",[P.AB_SOURCE_SHA256]);
  await db.exec("UPDATE crm_ab_experiment_v2 SET state='scheduled',window_start=now()-interval '1 minute',window_end=now()+interval '1 day',transport_bound=true,tracking_continuous=true;");
  for(const protocol of protocols){
   await db.query("SELECT set_config('shrigma.ab_schedule_v2',$1,false)",[protocol.test_id]);
   await db.query("UPDATE campaigns SET status='scheduled',send_at=now()-interval '1 minute' WHERE id=ANY($1::integer[])",[protocol.arms.map(a=>a.campaign_id)]);
  }
  await db.exec("SELECT set_config('shrigma.ab_schedule_v2','',false);UPDATE campaigns SET status='scheduled',send_at=now()-interval '1 minute' WHERE id IN(300,400);");
  let audienceSequence=100;
  async function bind(brand,rule=rules[brand]){
   const d=definition(brand,rule),current=await S.readCatalog(db.query.bind(db),brand),context=S.pins(d,current),id=uuid(++audienceSequence);
   await db.transaction(async tx=>{
    await tx.query(`INSERT INTO crm_audience_v2.audience(id,brand,name,definition,definition_hash,context,context_hash,created_by,updated_by)
     VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,'panel:synthetic','panel:synthetic')`,[id,brand,d.name,JSON.stringify(d),H.digest(d),JSON.stringify(context),H.digest(context)]);
    await tx.query(`INSERT INTO crm_audience_v2.revision(audience_id,version,definition,definition_hash,context,context_hash,archived,actor)
     VALUES($1,1,$2::jsonb,$3,$4::jsonb,$5,false,'panel:synthetic')`,[id,JSON.stringify(d),H.digest(d),JSON.stringify(context),H.digest(context)]);
   });
   for(const cid of brand==='fish'?[100,101,400]:[200,201]){
    const native=(await db.query('SELECT shrigma_campaign_current($1) AS c',[cid])).rows[0].c;
    const b={contract:B.VERSION,brand,campaign_id:cid,campaign_version:native.version,binding_version:1,audience_id:id,audience_revision:1,
     definition_hash:H.digest(d),context_hash:H.digest(context),base_list_id:current.base_list_id,definition:d,context,
     catalog_hash:current.catalog.catalog_hash,authorizes_selection:false,authorizes_send:false};
    const row={...b,binding:b,binding_hash:H.digest(b)};assert.deepEqual(B.binding(row),b,'same binding shape as the real writer');
    await db.query(`INSERT INTO crm_audience_v2.campaign_binding VALUES($1,$2,1,$3,$4,1,$5,$6,$7,$8,$9::jsonb,$10)
     ON CONFLICT(campaign_id) DO UPDATE SET audience_id=excluded.audience_id,definition_hash=excluded.definition_hash,context_hash=excluded.context_hash,
     campaign_version=excluded.campaign_version,base_list_id=excluded.base_list_id,catalog_hash=excluded.catalog_hash,binding=excluded.binding,binding_hash=excluded.binding_hash`,
    [cid,brand,native.version,id,b.definition_hash,b.context_hash,b.base_list_id,b.catalog_hash,JSON.stringify(b),row.binding_hash]);
    await db.query(`INSERT INTO crm_audience_v2.campaign_binding_revision VALUES($1,1,$2::jsonb,$3)
     ON CONFLICT(campaign_id,binding_version) DO UPDATE SET binding=excluded.binding,binding_hash=excluded.binding_hash`,[cid,JSON.stringify(b),row.binding_hash]);
   }
   return {d,context};
  }
  await bind('fish');await bind('aristo');await db.exec(read('n8n/growth/segment-listmonk-selection.sql'));
  const count=()=>db.query(P.section(patched.source,'next-campaigns').text,[[],[]]);
  const batch=async(cid,{cursor=0,max=1002,size=1002,sql=patched.source,listIds=cid===300?[3]:cid<200||cid===400?[17]:[16]}={})=>(await db.query(P.section(sql,'next-campaign-subscribers').text,[cid,'regular',cursor,max,listIds,size])).rows;
  const enable=()=>db.query('UPDATE crm_audience_v2.selection_runtime SET enabled=true,candidate_query_sha256=$1,verified_at=clock_timestamp()',[patched.patched_sha256]);
  const members=async cid=>(await db.query(`SELECT m.subscriber_id FROM crm_ab_member_v2 m JOIN crm_ab_arm_v2 a USING(test_id,arm) WHERE a.campaign_id=$1 ORDER BY m.subscriber_id`,[cid])).rows.map(r=>r.subscriber_id);
  return {...x,patched,bind,count,batch,enable,members};
 }catch(e){await db.close();throw e;}
}

test('composition keeps upstream and published A/B pins unchanged; canonical hashes agree',options,async()=>{
 const ab=AB.patchSource(source),composed=P.patchSource(source);
 assert.equal(ab.patched_sha256,P.AB_SOURCE_SHA256);assert.notEqual(composed.patched_sha256,ab.patched_sha256);
 assert.equal(composed.authorizes_send,false);assert.equal(composed.authorizes_selection,false);
 assert.throws(()=>P.patchSource(source+'\n'),/SOURCE_DRIFT/);
 for(const name of ['next-campaigns','next-campaign-subscribers'])assert.match(P.section(composed.source,name).text,/crm_audience_v2\.selection_allowed\([^,]+, s\.id\)/);
 const x=await setup();try{
  const rows=(await x.db.query('SELECT binding,binding_hash,crm_audience_v2.selection_hash(binding) AS actual FROM crm_audience_v2.campaign_binding')).rows;
  for(const r of rows)assert.equal(r.actual,r.binding_hash);
  for(const {name}of (await x.db.query('SELECT name FROM crm_audience_v2.selection_timezone')).rows)assert.doesNotThrow(()=>S.sourceConfig({...catalog(),timezone:name},'fish'),'cached timezone accepted by the actual JS catalog validator: '+name);
  assert.equal((await x.db.query('SELECT enabled FROM crm_audience_v2.selection_runtime')).rows[0].enabled,false);
  assert.equal((await x.batch(100)).length,0);assert.equal((await x.batch(200)).length,0);
  assert.equal((await x.batch(400)).length,0);await x.count();
  assert.equal((await x.db.query('SELECT to_send FROM campaigns WHERE id=400')).rows[0].to_send,0,'non-A/B binding cannot escape OFF via native OR');
  assert.deepEqual(await x.batch(300),await x.batch(300,{sql:source}),'legacy rows and order unchanged with runtime OFF');
 }finally{await x.db.close();}
});

test('complete upstream count and paginated batches compose both brands, AND/OR and disjoint A/B cohorts',options,async()=>{
 const x=await setup();try{
  await x.enable();await x.count();
  const stats=(await x.db.query('SELECT id,to_send,max_subscriber_id FROM campaigns ORDER BY id')).rows;
  const expectedAudience={fish:Array.from({length:60},(_,i)=>i+81).filter(n=>n%3!==0),aristo:[...Array.from({length:30},(_,i)=>i+1),...Array.from({length:40},(_,i)=>i+161)]};
  for(const brand of ['fish','aristo']){
   const current=await S.readCatalog(x.db.query.bind(x.db),brand),counted=await Count.countAudience({definition:definition(brand,rules[brand]),baseListId:current.base_list_id,catalog:current.catalog,query:x.db.query.bind(x.db)});
   assert.equal(counted.eligible_count,expectedAudience[brand].length,'same aggregate provider as the panel');
   const all=[];
   for(const cid of brand==='fish'?[100,101]:[200,201]){
    const assigned=new Set(await x.members(cid)),expected=expectedAudience[brand].filter(n=>assigned.has(n)),stat=stats.find(s=>s.id===cid),actual=[];
    assert.equal(stat.to_send,expected.length);assert.equal(stat.max_subscriber_id,Math.max(...expected));
    let cursor=0;
    for(;;){const rows=await x.batch(cid,{cursor,max:stat.max_subscriber_id,size:13});if(!rows.length)break;actual.push(...rows.map(r=>r.id));cursor=rows.at(-1).id;
     assert.equal((await x.db.query('SELECT last_subscriber_id FROM campaigns WHERE id=$1',[cid])).rows[0].last_subscriber_id,cursor);}
    assert.deepEqual(actual,expected);all.push(...actual);
   }
   assert.equal(new Set(all).size,all.length);assert.deepEqual(all.sort((a,b)=>a-b),expectedAudience[brand]);
  }
  assert.equal(stats.find(s=>s.id===300).to_send,1000);assert.deepEqual(await x.batch(300),await x.batch(300,{sql:source}));
  assert.equal(stats.find(s=>s.id===400).to_send,40);assert.deepEqual((await x.batch(400)).map(r=>r.id),expectedAudience.fish);
 }finally{await x.db.close();}
});

test('each next native batch rechecks base, leaves, global enabled and A/B revocation',options,async()=>{
 const x=await setup();try{
  await x.enable();await x.count();const fish=(await x.batch(100)).map(r=>r.id),aristo=(await x.batch(200)).map(r=>r.id);
  assert.ok(fish.length>5&&aristo.length>2);
  await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=17",[fish[0]]);
  await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=21",[fish[1]]);
  await x.db.query("UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=$1 AND list_id=22",[fish[2]]);
  await x.db.query("UPDATE subscribers SET status='disabled' WHERE id=$1",[fish[3]]);
  await x.db.query("UPDATE subscribers SET status='blocklisted' WHERE id=$1",[fish[4]]);
  await x.db.query('UPDATE crm_ab_member_v2 SET revoked_at=now() WHERE subscriber_id=$1 AND test_id=$2',[fish[5],uuid(1)]);
  await x.db.query("UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=$1 AND list_id=16",[aristo[0]]);
  assert.deepEqual((await x.batch(100)).map(r=>r.id),fish.slice(6));assert.deepEqual((await x.batch(200)).map(r=>r.id),aristo.slice(1));
  await x.count();const rows=(await x.db.query('SELECT id,to_send FROM campaigns WHERE id IN(100,200) ORDER BY id')).rows;
  assert.deepEqual(rows.map(r=>r.to_send),[fish.length-6,aristo.length-1]);
 }finally{await x.db.close();}
});

test('OFF, incomplete binding, changed context, invalid catalog and external OR branches fail closed',options,async()=>{
 const x=await setup();try{
  await x.enable();const baseline=(await x.batch(100)).map(r=>r.id);assert.ok(baseline.length);
  const cases=[
   ["UPDATE crm_audience_v2.selection_runtime SET enabled=false","UPDATE crm_audience_v2.selection_runtime SET enabled=true"],
   ["UPDATE crm_audience_v2.selection_runtime SET candidate_query_sha256=repeat('f',64)","UPDATE crm_audience_v2.selection_runtime SET candidate_query_sha256='"+x.patched.patched_sha256+"'"],
   ["UPDATE crm_audience_v2.selection_runtime SET verified_at=now()-interval '6 minutes'","UPDATE crm_audience_v2.selection_runtime SET verified_at=now()"],
   ["UPDATE crm_audience_v2.config SET enabled=false WHERE brand='fish'","UPDATE crm_audience_v2.config SET enabled=true WHERE brand='fish'"],
   ["UPDATE crm_audience_v2.config SET checked_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE brand='fish'","UPDATE crm_audience_v2.config SET checked_at=now(),expires_at=now()+interval '4 minutes' WHERE brand='fish'"],
   ["UPDATE lists SET optin='double' WHERE id=17","UPDATE lists SET optin='single' WHERE id=17"],
   ["UPDATE lists SET optin='single' WHERE id=22","UPDATE lists SET optin='double' WHERE id=22"],
   ["UPDATE lists SET status='archived' WHERE id=21","UPDATE lists SET status='active' WHERE id=21"],
   ["UPDATE lists SET tags=ARRAY['aristo'] WHERE id=21","UPDATE lists SET tags=ARRAY['fish'] WHERE id=21"],
   ["UPDATE lists SET name=repeat('😀',300) WHERE id=21","UPDATE lists SET name='Fish leaf single' WHERE id=21"],
   ["UPDATE crm_audience_v2.campaign_binding SET binding=binding-'context' WHERE campaign_id=100","UPDATE crm_audience_v2.campaign_binding b SET binding=h.binding FROM crm_audience_v2.campaign_binding_revision h WHERE h.campaign_id=b.campaign_id"],
   ["UPDATE crm_audience_v2.campaign_binding SET context_hash=repeat('f',64) WHERE campaign_id=100","UPDATE crm_audience_v2.campaign_binding SET context_hash=binding->>'context_hash' WHERE campaign_id=100"],
   ["UPDATE crm_audience_v2.campaign_binding_revision SET binding_hash=repeat('f',64) WHERE campaign_id=100","UPDATE crm_audience_v2.campaign_binding_revision h SET binding_hash=b.binding_hash FROM crm_audience_v2.campaign_binding b WHERE b.campaign_id=h.campaign_id"]
  ];
  for(const [change,restore]of cases){await x.db.exec(change);assert.equal((await x.batch(100)).length,0,change);await x.db.exec(restore);assert.deepEqual((await x.batch(100)).map(r=>r.id),baseline);}
  await x.db.exec('UPDATE campaign_lists SET list_id=21 WHERE campaign_id=400');
  assert.equal((await x.batch(400,{listIds:[21]})).length,0,'narrower native list cannot cut the selected base');
  await x.db.exec('UPDATE campaign_lists SET list_id=17 WHERE campaign_id=400');
  for(const bad of [{}, {...catalog(),currency:'bad'}, {...catalog(),timezone:'Not/AZone'}, {...catalog(),timezone:'Factory'}, {...catalog(),fields:[{key:'purchase.count',available:true,source_hash:null}]}, {...catalog(),origins:[{key:'popup',brand:'aristo',name:'wrong',available:false,provenance_hash:null}]}, {...catalog(),products:[{id:'gid://shopify/Product/1',brand:'fish',name:'😀'.repeat(300),available:true}]}, {...catalog(),origins:[{key:'popup',brand:'fish',name:'😀'.repeat(300),available:false,provenance_hash:null}]}]){
   await x.db.query("UPDATE crm_audience_v2.config SET catalog=$1::jsonb WHERE brand='fish'",[JSON.stringify(bad)]);
   assert.equal((await S.readCatalog(x.db.query.bind(x.db),'fish')).ready,false);assert.equal((await x.batch(100)).length,0);
  }
  // Refresh/data changes do not silently reinterpret the pinned list semantics.
  await x.db.query("UPDATE crm_audience_v2.config SET catalog=$1::jsonb,revision=revision+1,checked_at=now(),expires_at=now()+interval '4 minutes' WHERE brand='fish'",[JSON.stringify({...catalog(),currency:'USD',timezone:'UTC'})]);
  assert.deepEqual((await x.batch(100)).map(r=>r.id),baseline);
  // A valid external OR leaf remains unsupported, even when the list branch is true.
  const cfg={...catalog(),fields:[{key:'purchase.count',available:true,source_hash:'a'.repeat(64)}],currency:'BRL',timezone:'UTC',shop_id:'gid://shopify/Shop/1'};
  await x.db.query("UPDATE crm_audience_v2.config SET catalog=$1::jsonb WHERE brand='fish'",[JSON.stringify(cfg)]);
  await x.bind('fish',{op:'or',rules:[{op:'in_list',list_id:21},{op:'condition',field:'purchase.count',operator:'gt',value:0}]});
  assert.equal((await x.batch(100)).length,0);assert.equal((await x.batch(101)).length,0);
  assert.deepEqual(await x.batch(300),await x.batch(300,{sql:source}));
 }finally{await x.db.close();}
});
