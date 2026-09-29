'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const F=require('./ab-audience-regular-fixture.cjs'),R=require('../n8n/growth/ab-audience-regular-admission.cjs');
const admissionSQL=fs.readFileSync(path.resolve(__dirname,'../n8n/growth/ab-audience-regular.sql'),'utf8');

async function setup(t){
 const db=new PGlite();t.after(()=>db.close());const fixture=await F.setup(db,{beforeWorkerReady:async({db})=>db.exec(admissionSQL)});
 await db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"validate\",\"read_content\",\"submit\"]' WHERE principal_id='manager'");
 const service=R.createABRegularAdmission({transaction:fixture.transaction,timeoutMs:10000});
 const call=async(request,key='synthetic-manager-key')=>{const out=await service.execute({request,key});return {status:out._http,body:out._body};};
 const prepareRequest=brand=>{const p=fixture.cases[brand];return {acao:R.ACTIONS.prepare,brand,test_id:p.protocol.test_id,expected_version:p.saved.experiment.version,expected_scope_hash:p.saved.scope_hash,audience_review_id:p.review.review_id};};
 const scheduleRequest=(p,review,key='ab-regular-schedule-0001')=>({...p,acao:R.ACTIONS.schedule,admission_review_id:review.body.review.admission_review_id,confirm:'agendar_duas',idempotency_key:key});
 return {db,fixture,service,call,prepareRequest,scheduleRequest};
}

for(const brand of ['fish','aristo'])test(brand+': inspection hooks create a bounded pair review and one reconciliable schedule receipt',async t=>{
 const f=await setup(t),p=f.prepareRequest(brand),review=await f.call(p);assert.equal(review.status,200,JSON.stringify(review));
 assert.equal(review.body.review.contract,R.VERSION);assert.equal(review.body.review.arms.length,2);assert.ok(Date.parse(review.body.review.expires_at)-Date.parse(review.body.review.checked_at)<=60000);
 const request=f.scheduleRequest(p,review,'schedule-'+brand+'-0001'),scheduled=await f.call(request);assert.equal(scheduled.status,200,JSON.stringify(scheduled));assert.equal(scheduled.body.scheduled.campaigns.length,2);
 assert.deepEqual(await f.call(request),scheduled);assert.deepEqual(await f.call({acao:R.ACTIONS.operation,brand,idempotency_key:request.idempotency_key}),scheduled);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_regular_request')).rows[0].n,1);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign WHERE enabled AND NOT suspended')).rows[0].n,2);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_regular_pair WHERE test_id=$1',[p.test_id])).rows[0].n,1);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM campaigns c JOIN crm_ab_arm_v2 a ON a.campaign_id=c.id WHERE a.test_id=$1 AND c.status='scheduled' AND c.sent=0 AND c.started_at IS NULL",[p.test_id])).rows[0].n,2);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM crm_ab_experiment_v2 WHERE test_id=$1 AND state='scheduled' AND transport_bound AND source_complete AND tracking_continuous",[p.test_id])).rows[0].n,1);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM shrigma_email_dispatch WHERE flow='campaign'",[])).rows[0].n,0);
});

test('lost commit acknowledgement returns 202 and operation lookup recovers the original receipt without a second schedule',async t=>{
 const f=await setup(t),p=f.prepareRequest('fish'),review=await f.call(p),request=f.scheduleRequest(p,review,'lost-ack-0001');
 f.fixture.control.afterCommit=()=>{throw Error('lost ACK');};const uncertain=await f.call(request);assert.equal(uncertain.status,202,JSON.stringify(uncertain));assert.equal(uncertain.body.automatic_retry,false);
 f.fixture.control.afterCommit=null;const found=await f.call({acao:R.ACTIONS.operation,brand:'fish',idempotency_key:request.idempotency_key});assert.equal(found.status,200);assert.equal(found.body.scheduled.status,'scheduled');
});

test('schedule requires submit, the same actor/review pins and exact idempotent payload',async t=>{
 const f=await setup(t),p=f.prepareRequest('fish'),review=await f.call(p),request=f.scheduleRequest(p,review,'identity-0001');
 await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"validate\",\"read_content\"]' WHERE principal_id='manager'");assert.equal((await f.call(request)).status,403);
 await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps=caps||'[\"submit\"]'::jsonb WHERE principal_id='manager'");assert.equal((await f.call({...request,admission_review_id:'00000000-0000-4000-8000-000000000999'})).status,409);
 const ok=await f.call(request);assert.equal(ok.status,200);assert.equal((await f.call({...request,audience_review_id:'00000000-0000-4000-8000-000000000998'})).status,409);
});

test('request and render boundaries reject attachments, routing overrides and sender drift',()=>{
 assert.throws(()=>R.request({acao:R.ACTIONS.prepare,brand:'fish'}),/AB_REGULAR_ADMISSION_INPUT/);
 const runtime={configuration_set:'fixture',envelope_from:'sender@example.test'},base={campaign:{headers:[{'Reply-To':'reply@example.test'}],from_email:'sender@example.test',subject:'Subject',body:'Body',altbody:'Text'},template:{body:'{{ template "content" . }}'},media:[]};
 assert.equal(R.materialValid({snapshot:base},runtime),true);
 assert.equal(R.materialValid({snapshot:{...base,media:[{id:1}]}},runtime),false);
 assert.equal(R.materialValid({snapshot:{...base,campaign:{...base.campaign,headers:[{'Reply-To':'reply@example.test',Cc:'x@example.test'}]}}},runtime),false);
 assert.equal(R.materialValid({snapshot:{...base,campaign:{...base.campaign,from_email:'other@example.test'}}},runtime),false);
 assert.equal(R.materialValid({snapshot:{...base,campaign:{...base.campaign,body:'{{ now }}'}}},runtime),false);
});
