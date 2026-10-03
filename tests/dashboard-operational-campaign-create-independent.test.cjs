'use strict';
// Independent synthetic CREATE probes; actual core and SQLite, no sockets.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./dashboard-operational-campaign-create-fixture.cjs');
const SOURCE_PIN='52c4722be8ad3b722fcf1bbade97d4f45f98bec8073109c4a072a09d195a846f';
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../services/dashboard-operational/crm-campaign-create.cjs'))).digest('hex'),SOURCE_PIN);
const posts=f=>f.calls.filter(c=>c.method==='POST').length;
test('lost ACK before core, restart and prolonged STATUS absence preserve one uncertain intent',async t=>{
 const f=fixture(t);f.behavior(({method,dispatch})=>method==='POST'?Promise.reject(Error('SYNTHETIC_TRANSPORT_CANARY')):dispatch());
 assert.deepEqual(await f.creator.submit(f.ctx,f.command()),{state:'pending',campaign:null});const saved=f.row();assert.equal(saved.phase,'uncertain');assert.equal(f.origin.effects.create,0);
 f.restart();f.advance(86400000);f.behavior(null);const before=f.calls.length;
 assert.deepEqual(await f.creator.reconcile(f.ctx,f.selector()),{state:'pending',campaign:null});
 assert.deepEqual(await f.creator.submit(f.ctx,f.command()),{state:'pending',campaign:null});
 const after=f.row();assert.equal(after.remote_key,saved.remote_key);assert.equal(after.input_ciphertext,saved.input_ciphertext);assert.equal(after.phase,'uncertain');assert.equal(after.campaign_id,null);
 assert.equal(f.calls.slice(before).every(c=>c.method==='GET'&&c.q.acao==='campanha_operacao'),true);assert.equal(posts(f),1);assert.equal(f.origin.effects.create,0);
 await assert.rejects(f.creator.submit(f.ctx,f.command('independent_second_key_0002')),{code:'CAMPAIGN_CREATE_PENDING'});
});
test('lost ACK after core survives restart, immutable catalogue and a missing current projection',async t=>{
 const f=fixture(t);f.behavior(async({method,dispatch})=>{const r=await dispatch();if(method==='POST')throw Error('SYNTHETIC_ACK_CANARY');return r;});
 assert.equal((await f.creator.submit(f.ctx,f.command())).state,'pending');assert.equal(f.origin.effects.create,1);assert.equal(f.row().campaign_id,null);const saved=f.row();
 f.restart();f.behavior(({q,dispatch})=>q.acao==='campanha_obter'?{status:404,body:{error:'MISSING'}}:dispatch());
 assert.deepEqual(await f.creator.reconcile(f.ctx,f.selector()),{state:'pending',campaign:null});assert.equal(f.row().phase,'confirmed');assert.equal(f.row().campaign_id,1001);assert.equal(f.row().remote_key,saved.remote_key);
 const current=f.origin.rows.get(1001);f.origin.rows.set(1001,{...current,version:'d'.repeat(32),status:'running',sent:2,started_at:new Date().toISOString()});
 f.behavior(({q,dispatch})=>q.acao==='campanha_catalogo'?{status:200,body:{brand:'fish',current:false,lists:[],templates:[]}}:dispatch());const result=await f.creator.reconcile(f.ctx,f.selector());
 assert.equal(result.state,'succeeded');assert.equal(result.campaign.id,1001);assert.equal(result.campaign.status,'running');assert.equal(result.campaign.sent,2);assert.equal(posts(f),1);assert.equal(f.origin.effects.create,1);assert.equal(f.calls.filter(c=>c.q.acao==='campanha_catalogo').length,1);
});
test('partial 201 cannot bind an ID; the intact same-key receipt subsequently recovers it',async t=>{
 const f=fixture(t);f.behavior(async({q,dispatch})=>{const r=await dispatch();if(q.acao==='campanha_operacao')delete r.body.operation.response.body.operation_id;return r;});
 assert.deepEqual(await f.creator.submit(f.ctx,f.command()),{state:'pending',campaign:null});assert.equal(f.row().campaign_id,null);assert.equal(f.row().remote_operation_id,null);assert.equal(f.origin.effects.create,1);
 f.behavior(async({q,dispatch})=>{const r=await dispatch();if(q.acao==='campanha_operacao')r.body.operation.providerId=1002;return r;});
 assert.equal((await f.creator.reconcile(f.ctx,f.selector())).state,'pending');assert.equal(f.row().campaign_id,null);
 f.behavior(null);assert.equal((await f.creator.reconcile(f.ctx,f.selector())).campaign.id,1001);assert.equal(posts(f),1);assert.equal(f.origin.effects.create,1);
});
test('second factory during an in-flight POST is GET-only; actor, payload and sibling guards remain closed',async t=>{
 const f=fixture(t),other=f.build();let entered,release;const started=new Promise(r=>{entered=r;});
 f.behavior(async({method,dispatch})=>{if(method==='POST'){entered();await new Promise(r=>{release=r;});}return dispatch();});
 const original=f.creator.submit(f.ctx,f.command());await started;assert.equal(f.row().phase,'uncertain');assert.equal(f.db.isTransaction,false);
 assert.deepEqual(await other.submit(f.ctx,f.command()),{state:'pending',campaign:null});assert.equal(posts(f),1);
 const before=f.calls.length;await assert.rejects(other.reconcile({...f.ctx,userId:crypto.randomUUID()},f.selector()),{code:'CAMPAIGN_CREATE_UNKNOWN'});
 await assert.rejects(other.reconcile({...f.ctx,mac:'b'.repeat(64)},f.selector()),{code:'CAMPAIGN_CREATE_DENIED'});
 const changed=f.command();changed.definition.subject='Another synthetic subject';await assert.rejects(other.submit(f.ctx,changed),{code:'CAMPAIGN_CREATE_CONFLICT'});assert.equal(f.calls.length,before);
 const blocked=f.build({hasOpenDelivery:()=>true});await assert.rejects(blocked.submit(f.ctx,f.command('blocked_aristo_key_0003','aristo')),{code:'CAMPAIGN_CREATE_PENDING'});assert.equal(f.calls.length,before);
 release();assert.equal((await original).state,'succeeded');assert.equal(posts(f),1);assert.equal(f.origin.effects.create,1);
});
