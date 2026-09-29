'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const F=require('./ab-audience-regular-fixture.cjs'),API=require('../n8n/growth/ab-audience-panel-api.cjs');
const read=file=>fs.readFileSync(path.resolve(__dirname,'../n8n/growth',file),'utf8');
async function prove(db,{createRoleTransaction=null}={}){
 const f=await F.setup(db,{prepareCases:false,beforeWorkerReady:async()=>{
  for(const file of ['ab-audience-regular.sql','segment-regular-admission-access.sql','ab-audience-runtime-access.sql'])await db.exec(read(file));
 }});
 await db.query("UPDATE shrigma_panel_permission_v1 SET caps=caps||'[\"submit\"]'::jsonb WHERE principal_id='manager'");
 let errors=[];
 const transaction=createRoleTransaction?await createRoleTransaction():async work=>db.transaction(async tx=>{await tx.query('SET LOCAL ROLE crm_audience_api');return work({query:async(q,v=[])=>{try{return await tx.query(q,v);}catch(e){errors.push({code:e.code,message:e.message,query:q.slice(0,100)});throw e;}}});});
 const api=API.createABPanelAPI({transaction,enabled:true});
 const call=async(brand,method,extra={})=>{
  errors=[];const r=await api.handle({method:method==='mutate'?'POST':'GET',request:{headers:{Authorization:'Bearer synthetic-manager-key'},[method==='mutate'?'body':'query']:{method,brand,...extra}}});
  assert.equal(r.status,200,JSON.stringify({status:r.status,body:r.body,errors}));return r.body;
 };
 for(const brand of ['fish','aristo']){
  assert.equal((await call(brand,'capabilities')).schedule,true);
  assert.equal((await call(brand,'campaigns')).campaigns.length,2);
  const p=f.cases[brand].protocol,operation_id=randomUUID();
  const prepared=await call(brand,'mutate',{operation_id,request_payload:p});assert.equal(prepared.experiment.state,'prepared');
  const replay=await call(brand,'operation',{operation_id,action:'prepare'});assert.equal(replay.operation.state,'completed');
  const reviewed=await call(brand,'mutate',{operation_id:randomUUID(),request_payload:{contract:p.contract,action:'review_saved',test_id:p.test_id,brand,expected_version:1}});assert.equal(reviewed.review.mode,'saved-audience');
  const scheduled=await call(brand,'mutate',{operation_id:randomUUID(),request_payload:{contract:p.contract,action:'schedule',test_id:p.test_id,brand,expected_version:1,review_id:reviewed.review.review_id,confirm:'schedule_both'}});assert.equal(scheduled.experiment.state,'scheduled');
  assert.equal((await call(brand,'get',{test_id:p.test_id})).experiment.state,'scheduled');
  const cancelled=await call(brand,'mutate',{operation_id:randomUUID(),request_payload:{contract:p.contract,action:'cancel',test_id:p.test_id,brand,expected_version:scheduled.experiment.version,confirm:'cancel_both'}});assert.equal(cancelled.experiment.state,'cancelled');
 }
 // The API cannot edit consent/content/native state or forge an execution gate.
 for(const q of ["UPDATE subscribers SET status='enabled'","UPDATE subscriber_lists SET status='confirmed'","UPDATE campaigns SET status='scheduled'","UPDATE templates SET body='changed'","UPDATE settings SET value='true'","SELECT * FROM crm_audience_v2.regular_worker_deployment","SELECT * FROM crm_audience_v2.regular_sender_policy","SELECT * FROM crm_audience_v2.shopify_customer_fact","SELECT email FROM subscribers","INSERT INTO crm_audience_v2.ab_regular_pair(test_id) VALUES(gen_random_uuid())","INSERT INTO crm_audience_v2.ab_regular_lifecycle_intent(test_id) VALUES(gen_random_uuid())","SELECT public.crm_ab_control_v2('panel:manager','[]',gen_random_uuid(),'{}')"]){
  await assert.rejects(transaction(tx=>tx.query(q)),e=>e.code==='42501',q);
 }
 assert.equal((await db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
 return {brands:['fish','aristo'],restricted_role:true,pair_schedule:true,pair_cancel:true,operation_recovery:true,native_write_denied:true,sends:0};
}
if(require.main===module)test('restricted API role completes both panel paths without native write grants',async t=>{const db=new PGlite();t.after(()=>db.close());await prove(db);});
module.exports={prove};
