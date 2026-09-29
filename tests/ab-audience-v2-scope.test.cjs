'use strict';
// Negative scope proof only. Real guarded bindings + SQL allocation/review;
// both runtimes stay OFF and neither campaign is scheduled or sent.
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const F=require('./segment-campaign-binding-fixture.cjs');
const {read,uuid}=require('./ab-experiment-fixture.cjs');
const C=require('../growth-ab-experiment-contract.js');
const Count=require('../n8n/growth/segment-audience-listmonk.cjs');
const Store=require('../n8n/growth/segment-audience-store.cjs');

test('negative proof: current A/B core and review allocate the base before a bound v2 audience, so minimum and denominator can be wrong',async t=>{
 const db=new PGlite();t.after(()=>db.close());const f=await F.setup(db);
 await db.exec(`
  INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":101,"send_at":null}'::jsonb)).* FROM campaigns c WHERE id=100;
  INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":201,"send_at":null}'::jsonb)).* FROM campaigns c WHERE id=200;
  INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(101,17,'Fish base'),(201,16,'Aristo base');
  SELECT set_config('shrigma.campaign_writer','101',true);
  UPDATE campaigns SET send_at=(SELECT send_at FROM campaigns WHERE id=100) WHERE id=101;
  SELECT set_config('shrigma.campaign_writer','201',true);
  UPDATE campaigns SET send_at=(SELECT send_at FROM campaigns WHERE id=200) WHERE id=201;
  SELECT set_config('shrigma.campaign_writer','',true);
  INSERT INTO subscribers VALUES(6,'enabled');
  INSERT INTO subscriber_lists VALUES(6,16,'confirmed'),(6,201,'unsubscribed');
  CREATE TABLE link_clicks(id serial PRIMARY KEY,campaign_id integer,subscriber_id integer,created_at timestamptz NOT NULL);
  CREATE TABLE settings(key text PRIMARY KEY,value jsonb);
  INSERT INTO settings VALUES('privacy.disable_tracking','false'),('privacy.individual_tracking','true');
 `);
 for(const file of ['n8n/growth/ab-experiment-core.sql','n8n/growth/ab-experiment-selection.sql','n8n/growth/ab-experiment-coordinator.sql'])await db.exec(read(file));
 let sequence=0;
 for(const [brand,ids,leaf,excluded] of [['fish',[100,101],101,2],['aristo',[200,201],201,6]]){
  const audience=await f.createAudience(brand,'negative-scope-'+brand,{op:'in_list',list_id:leaf});
  for(const cid of ids){const preview=await f.inspect(brand,cid,audience);assert.equal(preview.status,200);assert.equal((await f.bind(preview.body.intent,'negative-bind-'+cid)).status,201);}
  const current=await Store.readCatalog(db.query.bind(db),brand);
  const counted=await Count.countAudience({definition:audience.definition,baseListId:current.base_list_id,catalog:current.catalog,query:db.query.bind(db)});
  assert.equal(counted.source_confirmed,true);assert.equal(counted.eligible_count,1);
  const arms=[];for(const [i,cid]of ids.entries())arms.push({arm:['a','b'][i],campaign_id:cid,expected_version:(await f.current(cid)).version});
  const p={contract:C.CONTRACT,test_id:uuid(++sequence),brand,channel:'email',name:'Negative v2 audience scope',hypothesis:'No allocation outside the selected audience',
   arms,allocation:{method:'random-permutation-v1',a_basis_points:5000},rule:{method:C.RULE,metric:'unique_tracked_click_per_allocated',window_hours:24,minimum_per_arm:1,minimum_effect_pp:.1,alpha:.05}};
  const control=async(request,id)=>(await db.query('SELECT crm_ab_control_v2($1,$2::jsonb,$3::uuid,$4::jsonb) AS r',['panel:synthetic','["draft","validate","submit","read_content"]',uuid(id),JSON.stringify(request)])).rows[0].r;
  assert.equal((await control(p,100+sequence)).body.error,'AB_V2_TRANSPORT_UNAVAILABLE','normal control remains unavailable; this test does not enable it');
  // Direct trusted SQL core call isolates allocation semantics. It is not a
  // claim that the disabled public coordinator authorizes configuration.
  const prepared=(await db.query('SELECT crm_ab_prepare_v2($1,$2::jsonb,$3::uuid,$4::jsonb) AS r',['panel:synthetic','["draft"]',uuid(200+sequence),JSON.stringify(p)])).rows[0].r;
  assert.deepEqual(prepared.arms.map(a=>a.allocated),[1,1]);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM crm_ab_member_v2 WHERE test_id=$1 AND subscriber_id=$2',[p.test_id,excluded])).rows[0].n,1,'known non-member of the bound audience was allocated');
  assert.ok(counted.eligible_count<2*p.rule.minimum_per_arm,'the selected audience cannot satisfy the protocol minimum');
  const source_reviews={};for(const [i,cid]of ids.entries())source_reviews[['a','b'][i]]=(await db.query('SELECT fixture_audience_review($1) AS v',[cid])).rows[0].v.audience.review_id;
  const reviewed=await control({contract:C.CONTRACT,action:'review',test_id:p.test_id,brand,expected_version:1,source_reviews},300+sequence);
  assert.equal(reviewed.status,200,JSON.stringify(reviewed));assert.deepEqual(reviewed.body.review.arms.map(a=>a.counts.eligible),[1,1]);
  const measurement=(await db.query('SELECT crm_ab_measure_v2($1) AS m',[p.test_id])).rows[0].m;
  assert.equal(measurement.arms.reduce((n,a)=>n+a.allocated,0),2);assert.equal(measurement.arms.reduce((n,a)=>n+a.native_sent,0),0);
  assert.equal((await control({contract:C.CONTRACT,action:'schedule',test_id:p.test_id,brand,expected_version:1,review_id:reviewed.body.review.review_id,confirm:'schedule_both'},400+sequence)).body.error,'AB_V2_TRANSPORT_UNAVAILABLE');
 }
 assert.equal((await db.query('SELECT enabled FROM crm_ab_runtime_v2')).rows[0].enabled,false);
 assert.deepEqual((await db.query('SELECT DISTINCT status,sent,started_at FROM campaigns WHERE id IN(100,101,200,201)')).rows,[{status:'draft',sent:0,started_at:null}]);
 assert.equal((await db.query("SELECT count(*)::integer AS n FROM pg_trigger WHERE tgname='shrigma_audience_campaign_send_guard_v1' AND tgenabled='O'")).rows[0].n,1);
});
