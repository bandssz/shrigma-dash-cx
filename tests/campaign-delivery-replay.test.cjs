'use strict';
// Disposable SQLite + synthetic provider only. Never contacts a real recipient.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createCampaignDelivery}=require('../services/dashboard-operational/crm-campaign-delivery.cjs');
const {createOrigin,definition,C,T,CAPS}=require('./dashboard-operational-campaign-create-fixture.cjs');
async function fixture(t,brand='fish'){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const now=Date.now(),ctx={userId:crypto.randomUUID(),mac:'a'.repeat(64),active:true,caps:[...CAPS]},calls=[];
 const origin=createOrigin(()=>now),prepared=C.prepare({...definition(brand),send_at:new Date(now+3600000).toISOString()},{catalog:origin.catalog(brand),tracking:T,trackingId:101,now}).definition;
 const row={id:101,version:'a'.repeat(32),status:'draft',sent:0,started_at:null,send_at:prepared.send_at,definition:prepared};origin.rows.set(row.id,row);
 const reviewed=await origin.service.handle({actor:'panel:'+ctx.userId,caps:CAPS},{acao:'campanha_validar',brand,id:row.id,expected_version:row.version,idempotency_key:'synthetic_review_before_schedule'});assert.equal(reviewed.status,200);
 let behavior=null;
 const build=(options={})=>createCampaignDelivery({db,now:()=>now,authorize:c=>{if(!c.active)throw Error('NO_ACCESS');return{userId:c.userId,credentialMac:c.mac,role:'manager',slot:'growth-campaign',canEdit:true,caps:c.caps};},transport:async(c,{method,command})=>{
   assert.equal(db.isTransaction,false);calls.push({method,action:command.acao});if(method==='POST')assert.equal(db.prepare('SELECT phase FROM crm_campaign_delivery_v1 WHERE remote_key=?').get(command.idempotency_key).phase,'uncertain');
   const dispatch=()=>origin.service.handle({actor:'panel:'+c.userId,caps:CAPS},command);return behavior?behavior({method,command,dispatch}):dispatch();
 },...options});
 const q={acao:'campanha_agendar',brand,id:row.id,expected_version:row.version,idempotency_key:'synthetic_schedule_replay_01',confirm:'agendar',audience_review_id:reviewed.body.validation.audience.review_id};
 return{ctx,db,origin,calls,q,build,delivery:build(),behavior:fn=>{behavior=fn;},posts:()=>calls.filter(x=>x.method==='POST').length};
}
for(const brand of ['fish','aristo'])test(brand+': completed schedule replay recovers after version changes with one POST',async t=>{
 const f=await fixture(t,brand);assert.equal(await f.delivery.recoverSubmission(f.ctx,f.q),null);
 assert.equal((await f.delivery.submit(f.ctx,f.q)).state,'succeeded');assert.notEqual(f.origin.rows.get(101).version,f.q.expected_version);
 assert.equal((await f.delivery.recoverSubmission(f.ctx,f.q)).state,'succeeded');assert.equal((await f.delivery.submit(f.ctx,f.q)).state,'succeeded');assert.equal(f.posts(),1);assert.equal(f.origin.effects.schedule,1);
});
test('queued replay after restart only reads the original receipt, never dispatches',async t=>{
 const f=await fixture(t);f.behavior(({command,dispatch})=>command.acao==='campanha_obter'?Promise.reject(Error('Lost GET')):dispatch());assert.equal((await f.delivery.submit(f.ctx,f.q)).state,'pending');
 assert.equal(f.db.prepare('SELECT phase FROM crm_campaign_delivery_v1').get().phase,'queued');f.behavior(null);const restarted=f.build();
 assert.equal((await restarted.recoverSubmission(f.ctx,f.q)).state,'pending');assert.equal((await restarted.submit(f.ctx,f.q)).state,'pending');assert.equal(f.posts(),0);assert.equal(f.origin.effects.schedule,0);assert.equal(f.db.prepare('SELECT phase FROM crm_campaign_delivery_v1').get().phase,'queued');
});
test('lost ACK after scheduling recovers by GET only; a different key stays blocked while uncertain',async t=>{
 const f=await fixture(t);f.behavior(async({method,dispatch})=>{const r=await dispatch();if(method==='POST')throw Error('ACK lost');return r;});assert.equal((await f.delivery.submit(f.ctx,f.q)).state,'pending');
 await assert.rejects(f.delivery.submit(f.ctx,{...f.q,idempotency_key:'a_different_schedule_attempt'}),{code:'CAMPAIGN_DELIVERY_PENDING'});f.behavior(null);
 assert.equal((await f.build().recoverSubmission(f.ctx,f.q)).state,'succeeded');assert.equal(f.posts(),1);assert.equal(f.origin.effects.schedule,1);
});
test('full command, current credential and permission are checked even for a completed receipt',async t=>{
 const f=await fixture(t);await f.delivery.submit(f.ctx,f.q);
 for(const patch of [{id:102},{expected_version:'b'.repeat(32)},{audience_review_id:crypto.randomUUID()},{brand:'aristo'}])await assert.rejects(f.delivery.recoverSubmission(f.ctx,{...f.q,...patch}),{code:'CAMPAIGN_DELIVERY_CONFLICT'});
 f.ctx.mac='b'.repeat(64);await assert.rejects(f.delivery.recoverSubmission(f.ctx,f.q),{code:'CAMPAIGN_DELIVERY_CONFLICT'});f.ctx.mac='a'.repeat(64);f.ctx.active=false;await assert.rejects(f.delivery.recoverSubmission(f.ctx,f.q),{code:'CAMPAIGN_EDIT_DENIED'});assert.equal(f.posts(),1);
});
test('simultaneous requests share one intention; only its INSERT owner can dispatch',async t=>{
 const f=await fixture(t);let release,entered;const waiting=new Promise(r=>{entered=r;}),barrier=new Promise(r=>{release=r;});let first=true;
 f.behavior(async({command,dispatch})=>{if(first&&command.acao==='campanha_obter'){first=false;entered();await barrier;}return dispatch();});
 const a=f.delivery.submit(f.ctx,f.q);await waiting;assert.equal((await f.delivery.submit(f.ctx,f.q)).state,'pending');assert.equal(f.posts(),0);release();assert.equal((await a).state,'succeeded');assert.equal(f.posts(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM crm_campaign_delivery_v1').get().n,1);
});
test('three-capability service draft profile cannot recover or submit schedule/cancel',async t=>{
 const f=await fixture(t),M=require('../services/dashboard-operational/crm-manager-runtime.cjs');const descriptor=M.serviceDraftDescriptor(M.ownMasterWriterDescriptor('own-master-production-v1',['oaristocrata.com','shrigma.com.br','fishermans.com.br']));f.ctx.caps=CAPS.slice(0,3);const draft=f.build({serviceDraftProfile:descriptor});
 for(const q of [f.q,{acao:'campanha_cancelar',brand:'fish',id:101,expected_version:'a'.repeat(32),idempotency_key:'synthetic_cancel_draft_01',confirm:'cancelar'}]){await assert.rejects(draft.recoverSubmission(f.ctx,q),{code:'CAMPAIGN_EDIT_DENIED'});await assert.rejects(draft.submit(f.ctx,q),{code:'CAMPAIGN_EDIT_DENIED'});}assert.equal(f.posts(),0);
});
