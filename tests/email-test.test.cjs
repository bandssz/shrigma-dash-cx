'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {setup,uuid,draft,GEC,P}=require('./fixtures/email-test-fixture.cjs');
test('pure plan binds fixed recipient and exact shared renderer, prefixes once, rejects unsupported expressions/fields',()=>{
 const r=draft(),n=GEC.payload(r),s={eligible:true,draft_id:'d_fixture',version:1,rascunho:r,components:{subject:n.subject,body_html:n.body},native:{id:100,type:'tx',subject:n.subject,body:n.body}};
 const p=P.plan(s,GEC);assert.equal(p.recipient,P.RECIPIENT);assert.equal(p.subject,'✅ FINAL — '+r.assunto);assert.deepEqual(p.data,{first_name:'Felipe'});assert.equal(P.preview(p).snapshot,undefined);assert.equal(p.rendered_subject,'✅ FINAL — Oi Felipe');assert.match(p.body_html,/<p>Olá Felipe<\/p>/);assert.doesNotMatch(p.body_html,/\{\{/);
 for(const bad of [{recipient:'other@example.invalid'},{cc:[]},{expected_version:'1'},{confirm:'yes'}])assert.throws(()=>P.request({...{draft_id:'d_fixture',expected_version:1,idempotency_key:uuid(1),confirm:'enviar_teste'},...bad}));
 for(const expr of ['{{ .Subscriber.Email }}','{{ .Tx.Data.secret }}','{{ if .Tx.Data.first_name }}x{{ end }}']){const x={...r,assunto:expr},tpl=GEC.payload(x);assert.equal(P.plan({...s,rascunho:x,components:{subject:tpl.subject,body_html:tpl.body},native:{...s.native,subject:tpl.subject,body:tpl.body}},GEC).eligible,false);}
 assert.equal(P.transportOutcome({statusCode:200,body:{data:true}}),'accepted');for(const r of [{statusCode:500},{statusCode:200,body:{}},{statusCode:401},{}])assert.equal(P.transportOutcome(r),'outcome_unknown');
});
test('one claim/version globally, durable before transport; replay/actor mismatch never yields transport again',async()=>{const s=await setup();try{
 const snap=await s.snapshot();assert.equal(snap.eligible,true,'absence of Fish membership is not converted into opt-out or inserted');const c=await s.claim(1);assert.equal(c.should_send,true);assert.equal(c.payload.subscriber_email,P.RECIPIENT);assert.equal(c.payload.subscriber_mode,'external');assert.match(c.payload.headers[2]['X-SES-MESSAGE-TAGS'],/crm_test=true/);
 assert.equal((await s.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch WHERE is_test AND transport_state=\'in_flight\'')).rows[0].n,1);
 assert.equal((await s.claim(1)).should_send,false);assert.equal((await s.claim(2)).result._body.operation.code,'version_already_attempted');assert.equal((await s.claim(1,null,'panel:other')).result._http,409);
 assert.equal((await s.receipt(1))._body.operation.http_accepted,false);assert.equal((await s.receipt(1,'panel:other'))._http,409);
 const done=(await s.db.query("SELECT crm_email_test_finish_v1($1,$2,'accepted') r",[uuid(1),c.claim_token])).rows[0].r;assert.equal(done._body.operation.http_accepted,true);assert.deepEqual(done._body.operation.ses,{});assert.equal(done._body.operation.claim_token,undefined);assert.equal(done._body.operation.recipient_key,undefined);
 await s.db.query("INSERT INTO shrigma_email_status VALUES($1,true,'matched','delivery',now())",[c.dispatch_id]);assert.ok((await s.receipt(1))._body.operation.ses.delivery);
 assert.equal((await s.db.query('SELECT count(*)::int n FROM subscriber_lists')).rows[0].n,1);assert.equal((await s.claim(3)).should_send,false);
 }finally{await s.db.close();}});
test('opt-out, global status, manager, validation/native/version checks fail before dispatch and rejected identity stays rejected',async()=>{
 for(const [patch,code] of [["INSERT INTO subscriber_lists VALUES(1,17,'unsubscribed')",'recipient_opted_out'],["UPDATE subscribers SET status='disabled'",'recipient_disabled'],["UPDATE subscribers SET status='blocklisted'",'recipient_disabled'],["UPDATE shrigma_template_draft SET version=2",'version_conflict'],["DELETE FROM shrigma_template_evento",'published_validated_version_required'],["UPDATE templates SET body='Changed'",'published_content_mismatch']]){const s=await setup();try{await s.db.exec(patch);const r=await s.claim(1);assert.equal(r.should_send,false);assert.equal(r.result._body.operation.code,code);assert.equal((await s.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);if(code==='recipient_opted_out'){await s.db.exec("UPDATE subscriber_lists SET status='confirmed'");assert.equal((await s.claim(1)).result._body.operation.code,code);}}finally{await s.db.close();}}
 const s=await setup();try{for(const actor of ['legacy-writer','panel:viewer'])assert.equal((await s.claim(1,null,actor)).result._http,403);}finally{await s.db.close();}
});
test('stale snapshot, arbitrary plan data, revoked actor and uncertain transport cannot be used for an extra send',async()=>{const s=await setup();try{
 const p=P.plan(await s.snapshot(),GEC);p.data.first_name='Real customer';assert.equal((await s.claim(1,p)).result._body.operation.code,'plan_changed');
 const c=await s.claim(2);await s.db.query("SELECT crm_email_test_finish_v1($1,$2,'outcome_unknown')",[uuid(2),c.claim_token]);assert.equal((await s.receipt(2))._body.operation.state,'outcome_unknown');assert.equal((await s.claim(3)).should_send,false);
 await s.db.exec("UPDATE crm_dash_chave SET revogada_em=now() WHERE chave='manager'");assert.equal((await s.receipt(2))._http,403);
 }finally{await s.db.close();}});
test('brand opt-out remains effective on a retired or cross list; other-brand membership never grants it away',async()=>{const s=await setup();try{
 await s.db.exec("INSERT INTO lists VALUES(50,ARRAY['fish','aposentada','cross']);INSERT INTO subscriber_lists VALUES(1,50,'unsubscribed')");
 assert.equal((await s.claim(1)).result._body.operation.code,'recipient_opted_out');
 assert.equal((await s.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
 }finally{await s.db.close();}});
