'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const F=require('./segment-regular-admission-fixture.cjs'),R=require('../n8n/growth/segment-regular-admission.cjs');
async function setup(t){const db=new PGlite();t.after(()=>db.close());return F.setup(db);}
for(const brand of ['fish','aristo'])test(brand+': authenticated prepare to atomic schedule pins material and uses selected audience',async t=>{
 const f=await setup(t),p=await f.prepareRequest(brand);
 assert.equal((await f.call(p)).status,503);await f.approve();
 const preview=await f.call(p);assert.equal(preview.status,200,JSON.stringify(preview));assert.ok(preview.body.review.eligible_count>0);
 const op=f.scheduleRequest(p,preview),r=await f.call(op);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.scheduled.status,'scheduled');
 assert.deepEqual(await f.call(op),r);assert.deepEqual(await f.call({acao:R.ACTIONS.operation,brand,idempotency_key:op.idempotency_key}),r);
 assert.equal((await f.call({...op,review_id:'00000000-0000-4000-8000-000000000999'})).status,409);
 const ctl=(await f.db.query('SELECT * FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=$1',[p.campaign_id])).rows;
 assert.equal(ctl.length,1);assert.equal(ctl[0].enabled,true);assert.equal(ctl[0].acknowledged_sent,0);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
});
test('permission and content drift deny scheduling with durable rejection, no legacy schedule and no orphan control',async t=>{
 const f=await setup(t);await f.approve();const p=await f.prepareRequest(),v=await f.call(p);assert.equal(v.status,200,JSON.stringify(v));
 const op=f.scheduleRequest(p,v);await f.db.query("UPDATE templates SET body=body||' changed' WHERE id=1");
 const r=await f.call(op);assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.body.error,'SEGMENT_BINDING_VERSION_CONFLICT');
 assert.deepEqual(await f.call({acao:R.ACTIONS.operation,brand:'fish',idempotency_key:op.idempotency_key}),r);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign')).rows[0].n,0);
 assert.equal((await f.current(100)).status,'draft');
 await f.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"validate\",\"read_content\"]' WHERE principal_id='manager'");
 assert.equal((await f.call({...op,idempotency_key:'no-submit-0001'})).status,403);
});
test('response loss after commit is reconciled by one original receipt, never sends or automatically repeats',async t=>{
 const f=await setup(t);await f.approve();const p=await f.prepareRequest(),v=await f.call(p),op=f.scheduleRequest(p,v);
 f.control.afterCommit=async()=>{throw Error('synthetic response lost');};const r=await f.call(op);assert.equal(r.status,202,JSON.stringify(r));assert.equal(r.body.automatic_retry,false);
 f.control.afterCommit=null;const found=await f.call({acao:R.ACTIONS.operation,brand:'fish',idempotency_key:op.idempotency_key});assert.equal(found.body.scheduled.status,'scheduled');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_admission_request')).rows[0].n,1);
});
test('opt-out, expired review and live lease loss cannot create an emitting approval',async t=>{
 const f=await setup(t);await f.approve();const p=await f.prepareRequest(),v=await f.call(p);assert.equal(v.status,200,JSON.stringify(v));
 await f.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");
 const r=await f.call(f.scheduleRequest(p,v));assert.equal(r.status,409);assert.equal(r.body.error,'REGULAR_ADMISSION_EMPTY');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign')).rows[0].n,0);
 await f.db.query('UPDATE crm_audience_v2.regular_worker_deployment SET enabled=false');
 assert.equal((await f.call(await f.prepareRequest('aristo'))).status,503);
});

test('submit revoked after scheduling SQL rolls back control, schedule and receipt together',async t=>{
 const f=await setup(t);await f.approve();const p=await f.prepareRequest(),v=await f.call(p);assert.equal(v.status,200);
 f.control.afterQuery=async(q,_v,tx)=>{if(q===R.SQL.schedule)await tx.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"read_content\",\"validate\"]' WHERE principal_id='manager'");};
 const r=await f.call(f.scheduleRequest(p,v));assert.equal(r.status,403,JSON.stringify(r));
 assert.equal((await f.current(100)).status,'draft');
 for(const table of ['regular_delivery_campaign','regular_admission_request'])assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.'+table)).rows[0].n,0);
});
test('template preflight matches native function policy and refuses envelope/routing overrides',()=>{
 const Render=require('../n8n/growth/segment-regular-render.cjs'),fs=require('node:fs');
 const go=fs.readFileSync(require.resolve('../tools/listmonk-regular-build/overlay/listmonk/internal/manager/regular_delivery.go'),'utf8').split('var regularForbiddenTemplateFunctions = map[string]struct{}{')[1].split('\n}')[0];
 assert.deepEqual([...go.matchAll(/"([A-Za-z0-9_]+)":/g)].map(m=>m[1]).sort(),[...Render.forbidden].sort());
 for(const text of ['{{ now }}','{{ printf "%s" (now) }}','{{- L "xx" -}}'])assert.equal(Render.allowed(text),false);
 for(const text of ['{{ .Subscriber.Attribs.date }}','{{ printf "now }}" }}','{{/* now */}}{{ TrackLink "url" }}','x@TrackLink'])assert.equal(Render.allowed(text),true);
 assert.equal(Render.headersAllowed([{'Reply-To':'one@example.invalid'}]),true);
 for(const headers of [[{'Reply-To':'one@example.invalid',Cc:'other@example.invalid'}],[{'Reply-To':'one@example.invalid','Return-Path':'other@example.invalid'}],[{'Reply-To':'one@example.invalid'},{'reply-to':'two@example.invalid'}],[{'Reply-To':'one@example.invalid\r\nBcc: bad@example.invalid'}]])assert.equal(Render.headersAllowed(headers),false);
});
