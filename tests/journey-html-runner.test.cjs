'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const path=require('node:path'),root=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createRunner}=require(root+'/journey-internal-test-runtime.cjs');
const oldRunner=require('./fixtures/journey-internal-test-return-90af.cjs').createRunner;
const engine=require(root+'/public/crm-preview/journey-engine.js'),Input=require(root+'/model-piece-input.cjs');
const {create}=require(root+'/simple-crm-model-pieces.cjs');
const {createBindingReader}=require(root+'/journey-internal-test-binding.cjs');
const {createHtmlBindingReader,CONTRACT,TEMPLATE_SHA,TEMPLATE_BODY}=require(root+'/journey-internal-html-binding.cjs');
const {createHtmlTransport}=require(root+'/journey-internal-test-transport.cjs');
function fixture(t,{brand='aristo',duringGet,result='accepted',two=false}={}){
 const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('analyst'),('colleague')");t.after(()=>db.close());
 let active=true,now=1000,edit=true,email='felipebandeira+codex@oaristocrata.com';const calls=[],plain=[];
 const identity=()=>({id:'analyst',email,role:'manager',active,brands:[brand],productFronts:['growth'],productWriteFronts:['growth'],permissions:{growth:{read:true,edit}}});
 const authorize=(_ctx,b)=>{if(!active||b!==brand||!edit)throw Object.assign(Error('denied'),{code:'PRODUCT_WRITE_DENIED'});return identity();};
 const pieces=create({db,authorize:ctx=>{if(!active||ctx.brand!==brand)throw Error('denied');return {...identity(),id:ctx.colleague?'colleague':'analyst'};},now:()=>now});
 function piece(name='Peça sintética',html='<h1>Modelo sintético</h1><p>HTML completo.</p>'){
  const rascunho=Input.prepare({name,subject:'Assunto do modelo',format:'html',content:html},brand),r=pieces.append({context:{method:'POST',colleague:true},brand,body:{acao:'rascunho',idempotency_key:crypto.randomUUID(),rascunho}});return r.operation.response.body.draft_id;
 }
 let draft=engine.createDraft({brand,id:'html-synthetic-draft'});draft.steps[0].waitMinutes=0;draft.steps[0].subject='[TESTE] Jornada HTML';draft.steps[0].text='Texto alternativo confirmado na etapa.';
 if(two)draft.steps.push({...draft.steps[0],id:'step-2'});
 const config={purpose:'crm.journey-internal-test',username:'synthetic-user',token:'SYNTHETIC-ONLY',templateId:116,templateSha256:'a'.repeat(64),from:{[brand]:'Marca <internal@oaristocrata.com>'}},env={DASHBOARD_JOURNEY_TEST_BINDING:JSON.stringify(config),DASHBOARD_JOURNEY_HTML_TEMPLATE:JSON.stringify({contract:CONTRACT,templateId:117,templateSha256:TEMPLATE_SHA})};
 const base=createBindingReader({env}),htmlBinding=createHtmlBindingReader({baseBinding:base,env});let f;
 const sendHtml=createHtmlTransport({privateApi:htmlBinding.privateApi,fetchImpl:async(url,options)=>{calls.push({url,options});if(options.method==='GET'){await duringGet?.(f);return new Response(JSON.stringify({data:{id:117,type:'tx',is_default:false,body:TEMPLATE_BODY}}));}if(result==='lost')throw Error('synthetic transport lost');return new Response(JSON.stringify({data:true}),{status:result==='uncertain'?503:200});}});
 const args={db,engine,authorize,authorizeRead:authorize,currentIdentity:identity,getDraft:()=>draft,getBinding:base.getBinding,send:async x=>{plain.push(x);return {state:'accepted'};},getModelPiece:pieces.internalTestSnapshot,getHtmlBinding:htmlBinding.getBinding,sendHtml,now:()=>now};
 let runner=createRunner(args);const id=piece(),request={brand,draftId:draft.id,version:draft.revision,requestId:crypto.randomUUID(),models:draft.steps.filter(s=>s.enabled).map(s=>({stepId:s.id,pieceId:id,version:1}))};
 f={db,args,request,calls,plain,pieces,piece,env,base,get draft(){return draft},get runner(){return runner},restart(){runner=createRunner(args);},legacy(){return oldRunner(args);},revoke(){edit=false;},deactivate(){active=false;},mutateDraft(){draft={...draft,title:'Changed after start'};},tickTime(n){now=n;},changeEmail(v){email=v;}};return f;
}
test('HTML jobs freeze a colleague-owned model on both brands and report acceptance separately from delivery',async t=>{
 for(const brand of ['aristo','fish']){const f=fixture(t,{brand});const r=f.runner.startHtml({},f.request);a.equal(r.contentFormat,'html');a.equal(r.accepted,0);a.equal(r.delivered,null);a.equal(f.db.prepare('SELECT count(*) n FROM journey_internal_html_snapshot_v1').get().n,1);await f.runner.tick();await f.runner.tick();a.equal(f.calls.filter(x=>x.options.method==='POST').length,1);a.equal(f.plain.length,0);const body=JSON.parse(f.calls.find(x=>x.options.method==='POST').options.body);a.match(body.data.test_html,/<h1>Modelo sintético<\/h1>/);a.equal(body.altbody,f.draft.steps[0].text);a.equal(f.runner.inspect({},f.request).delivered,null);a.equal(f.runner.inspect({},f.request).status,'finished');}
});
test('job, all snapshots and return marker roll back together when an insert fails',t=>{
 const f=fixture(t,{two:true});f.db.exec("CREATE TRIGGER html_fail_second BEFORE INSERT ON journey_internal_html_snapshot_v1 WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'synthetic failure');END");a.throws(()=>f.runner.startHtml({},f.request));
 for(const table of ['journey_internal_test_v1','journey_internal_html_job_v1','journey_internal_html_snapshot_v1','journey_internal_contract_v2'])a.equal(f.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
});
test('same nonce returns the frozen job; changed references or another nonce cannot duplicate a draft revision',async t=>{
 const f=fixture(t);f.runner.startHtml({},f.request);a.equal(f.runner.startHtml({},f.request).requestId,f.request.requestId);const other=f.piece('Outra peça');a.throws(()=>f.runner.startHtml({},{...f.request,models:[{...f.request.models[0],pieceId:other}]}),{code:'TEST_REQUEST_CHANGED'});a.throws(()=>f.runner.startHtml({},{...f.request,requestId:crypto.randomUUID()}),{code:'TEST_VERSION_ALREADY_RUN'});a.throws(()=>f.runner.start({},f.request),{code:'TEST_REQUEST_CHANGED'});f.restart();await f.runner.tick();f.restart();await f.runner.tick();a.equal(f.calls.filter(x=>x.options.method==='POST').length,1);
});
test('missing HTML models never fall back to plaintext; unresolved variables refuse the new job',t=>{
 const f=fixture(t);a.throws(()=>f.runner.startHtml({},{...f.request,models:undefined}),{code:'TEST_HTML_MODELS_REQUIRED'});f.draft.steps[0].text='{{ .Subscriber.Name }}';a.throws(()=>f.runner.startHtml({},f.request),{code:'TEST_HTML_MODEL_CONTENT_REFUSED'});a.equal(f.db.prepare('SELECT count(*) n FROM journey_internal_test_v1').get().n,0);a.equal(f.plain.length,0);
});
test('return image holds HTML before reservation, explicit supported resume sends once',async t=>{
 const f=fixture(t);f.runner.startHtml({},f.request);await f.legacy().tick();a.equal(f.calls.length,0);a.equal(f.runner.inspect({},f.request).status,'compatibility_hold');f.runner.control({},{brand:f.request.brand,requestId:f.request.requestId,paused:false});await f.runner.tick();a.equal(f.calls.filter(x=>x.options.method==='POST').length,1);a.equal(f.plain.length,0);
});
test('return image appearing during template GET fences POST and remains uncertain without retry',async t=>{
 let once=false;const f=fixture(t,{duringGet:async x=>{if(!once){once=true;await x.legacy().tick();}}});f.runner.startHtml({},f.request);await f.runner.tick();a.equal(f.calls.filter(x=>x.options.method==='POST').length,0);a.equal(f.plain.length,0);a.equal(f.runner.inspect({},f.request).status,'uncertain');await f.runner.tick();a.equal(f.calls.filter(x=>x.options.method==='POST').length,0);
});
test('missing or corrupted snapshot blocks all transport, including the plaintext sender',async t=>{
 for(const action of ['delete','corrupt']){const f=fixture(t);f.runner.startHtml({},f.request);f.db.exec(action==='delete'?'DELETE FROM journey_internal_html_snapshot_v1':"UPDATE journey_internal_html_snapshot_v1 SET payload_json='{}'");await f.runner.tick();a.equal(f.calls.length,0);a.equal(f.plain.length,0);a.equal(f.runner.inspect({},f.request).status,'failed');}
});
test('pause and WRITE revocation during GET prevent HTML POST',async t=>{
 for(const flag of ['pause','revoke']){const f=fixture(t,{duringGet:x=>flag==='pause'?x.runner.control({},{brand:x.request.brand,requestId:x.request.requestId,paused:true}):x.revoke()});f.runner.startHtml({},f.request);await f.runner.tick();a.equal(f.calls.filter(x=>x.options.method==='POST').length,0);a.equal(f.plain.length,0);}
});
test('uncertain HTML receipt survives restart without another POST or plaintext fallback',async t=>{
 const f=fixture(t,{result:'uncertain'});f.runner.startHtml({},f.request);await f.runner.tick();f.restart();await f.runner.tick();a.equal(f.calls.filter(x=>x.options.method==='POST').length,1);a.equal(f.runner.inspect({},f.request).status,'uncertain');a.equal(f.plain.length,0);
});
test('tampered stored model fails integrity before job creation',t=>{
 const f=fixture(t);f.db.prepare("UPDATE crm_model_piece_v1 SET request_sha256=? WHERE draft_id=?").run('0'.repeat(64),f.request.models[0].pieceId);a.throws(()=>f.runner.startHtml({},f.request),{code:'TEST_HTML_MODEL_INTEGRITY'});a.equal(f.db.prepare('SELECT count(*) n FROM journey_internal_test_v1').get().n,0);
});
test('another active or uncertain revision blocks a new TEST across both content formats',t=>{
 for(const before of ['html','text'])for(const after of ['html','text'])for(const state of ['waiting','attempting','compatibility_hold','uncertain']){
  const f=fixture(t);(before==='html'?f.runner.startHtml:f.runner.start)({},f.request);f.db.prepare('UPDATE journey_internal_test_v1 SET status=?').run(state);f.draft.revision=2;
  a.throws(()=>(after==='html'?f.runner.startHtml:f.runner.start)({},{...f.request,version:2,requestId:crypto.randomUUID()}),{code:'TEST_DRAFT_ALREADY_ACTIVE'});a.equal(f.db.prepare('SELECT count(*) n FROM journey_internal_test_v1').get().n,1);
 }
});
test('orphaned HTML snapshot is held even when the HTML job row and marker are missing',async t=>{
 const f=fixture(t);f.runner.startHtml({},f.request);f.db.exec('DELETE FROM journey_internal_contract_v2;DELETE FROM journey_internal_html_job_v1');await f.runner.tick();a.equal(f.calls.length,0);a.equal(f.plain.length,0);a.equal(f.runner.inspect({},f.request).compatibilityHold,true);a.equal(f.runner.inspect({},f.request).status,'compatibility_hold');
});
test('later source edits cannot change the HTML already frozen in an internal job',async t=>{
 const f=fixture(t);f.runner.startHtml({},f.request);f.db.prepare("UPDATE crm_model_piece_v1 SET request_json='{}',request_sha256=?").run('0'.repeat(64));await f.runner.tick();const post=f.calls.find(x=>x.options.method==='POST');a(post);a.match(JSON.parse(post.options.body).data.test_html,/<h1>Modelo sintético<\/h1>/);a.equal(f.plain.length,0);
});

test('HTML canary is enforced on POST and before send, without changing plaintext access',async t=>{const f=fixture(t);f.changeEmail('other-internal@oaristocrata.com');a.equal(f.runner.availability({},'aristo').htmlAvailable,false);a.throws(()=>f.runner.startHtml({},f.request),{code:'TEST_HTML_CANARY_ACCOUNT_REQUIRED'});a.equal(f.db.prepare('SELECT count(*) n FROM journey_internal_test_v1').get().n,0);f.runner.start({},f.request);await f.runner.tick();a.equal(f.plain.length,1);const g=fixture(t,{duringGet:x=>x.changeEmail('other-internal@oaristocrata.com')});g.runner.startHtml({},g.request);await g.runner.tick();a.equal(g.calls.filter(x=>x.options.method==='POST').length,0);});
