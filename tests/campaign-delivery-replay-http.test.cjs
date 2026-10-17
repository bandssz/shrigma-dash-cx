'use strict';
// Actual server/auth and synthetic provider; no production credentials or sends.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,hosts,command}=require('./dashboard-operational-campaign-submit.test.cjs');
const schedulePosts=f=>f.calls.filter(x=>x.method==='POST'&&x.command.acao==='campanha_agendar').length;
test('a replay whose preflight raced with completion recovers the same receipt instead of409 or a secondPOST',async t=>{
 const f=await fixture(t),p=await f.manager('race@synthetic.invalid');let r=await f.post(hosts.growth,'/api/campaigns',command('validar',f.origin.row(),'synthetic_race_review_01'),p);assert.equal(r.status,200);
 const q=command('agendar',f.origin.row(),'synthetic_race_schedule_01',{audience_review_id:r.json.validation.audience.review_id});let release,entered,hold=true;const barrier=new Promise(r=>{release=r;}),waiting=new Promise(r=>{entered=r;});
 f.behavior(async({payload,dispatch})=>{if(hold&&payload.acao==='campanha_obter'){hold=false;entered();await barrier;}return dispatch();});
 const waitingRequest=f.post(hosts.growth,'/api/campaigns',q,p);await waiting;
 const completed=await f.post(hosts.growth,'/api/campaigns',q,p);assert.equal(completed.status,200,completed.raw);release();
 const recovered=await waitingRequest;assert.equal(recovered.status,200,recovered.raw);assert.equal(recovered.json.state,'succeeded');assert.equal(schedulePosts(f),1);assert.equal(f.origin.effects.schedule,1);
});
test('a refused new schedule keeps original409, with no reserved intention orPOST',async t=>{
 const f=await fixture(t),p=await f.manager('refused@synthetic.invalid'),q=command('agendar',{...f.origin.row(),version:'b'.repeat(32)},'synthetic_refused_schedule',{audience_review_id:'11111111-1111-4111-8111-111111111111'});
 const r=await f.post(hosts.growth,'/api/campaigns',q,p);assert.equal(r.status,409);assert.equal(r.json.error,'CAMPAIGN_SCHEDULE_READ_UNCONFIRMED');assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM crm_campaign_delivery_v1').get()).n,0);assert.equal(schedulePosts(f),0);
});
test('GET failure before a new intention preserves502 without reserve orPOST',async t=>{
 const f=await fixture(t),p=await f.manager('preflight@synthetic.invalid');f.behavior(()=>Promise.reject(Error('synthetic GET unavailable')));
 const q=command('agendar',f.origin.row(),'synthetic_preflight_failure',{audience_review_id:'11111111-1111-4111-8111-111111111111'}),r=await f.post(hosts.growth,'/api/campaigns',q,p);
 assert.equal(r.status,502);assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM crm_campaign_delivery_v1').get()).n,0);assert.equal(schedulePosts(f),0);
});
