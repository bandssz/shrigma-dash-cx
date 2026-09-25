'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{setup,uuid}=require('./fixtures/email-test-fixture.cjs'),W=require('../n8n/growth/email-test-workflow-patch.cjs');
const run=(code,json,prepara)=>vm.runInNewContext('(function(){'+code+'})()',{$json:json,$:()=>({first:()=>({json:prepara})})})[0].json;
test('production Code nodes and SQL form one ordered claim/transport/receipt pipeline with synthetic transport only',async()=>{const s=await setup();try{
 const context={email_test_action:'email_teste',who:'panel:manager',request_payload:s.request(1)},plan=run(W.PLAN,{snapshot:await s.snapshot()},context);
 assert.equal(plan._step,'claim');const claimed=(await s.db.query(plan.sql,Array.from(plan.sqlParameters))).rows[0];const routed=run(W.CLAIM,claimed);
 assert.equal(routed._step,'send');assert.equal((await s.receipt(1))._body.operation.state,'claimed');
 let transportCalls=0;const fakeTransport=p=>{transportCalls++;assert.equal(p.subscriber_email,'felipebandeira@oaristocrata.com');assert.equal(p.template_id,100);return {statusCode:200,body:{data:true}};};
 const final=run(W.FINISH,fakeTransport(routed.payload),routed),result=(await s.db.query(final.sql,Array.from(final.sqlParameters))).rows[0].result;
 assert.equal(result._body.operation.http_accepted,true);assert.deepEqual(result._body.operation.ses,{});
 const replayPlan=run(W.PLAN,{snapshot:await s.snapshot()},context),replay=(await s.db.query(replayPlan.sql,Array.from(replayPlan.sqlParameters))).rows[0];assert.equal(run(W.CLAIM,replay)._step,'response');assert.equal(transportCalls,1);
 }finally{await s.db.close();}});
test('preview refuses unsupported data before transport; SQL records that refusal durably for its identity',async()=>{const s=await setup();try{
 const snapshot=await s.snapshot();snapshot.rascunho.assunto='{{ .Tx.Data.secret }}';snapshot.native.subject=snapshot.rascunho.assunto;snapshot.components.subject=snapshot.rascunho.assunto;
 await s.db.query('UPDATE shrigma_template_draft SET rascunho=$1,components=$2',[snapshot.rascunho,snapshot.components]);await s.db.query('UPDATE templates SET subject=$1',[snapshot.native.subject]);
 const preview=run(W.PLAN,{snapshot:await s.snapshot()},{email_test_action:'email_teste_previa'});assert.equal(preview._body.eligible,false);assert.equal(preview._body.code,'unsupported_test_variable');
 const plan=run(W.PLAN,{snapshot:await s.snapshot()},{email_test_action:'email_teste',who:'panel:manager',request_payload:s.request(1)});const claim=(await s.db.query(plan.sql,Array.from(plan.sqlParameters))).rows[0];assert.equal(run(W.CLAIM,claim)._step,'response');assert.equal((await s.receipt(1))._body.operation.state,'rejected');assert.equal((await s.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
 }finally{await s.db.close();}});
