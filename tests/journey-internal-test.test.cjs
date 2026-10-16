'use strict';
const test=require('node:test'),a=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{createRunner}=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/journey-internal-test-runtime.cjs'),engine=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/public/crm-preview/journey-engine.js');
const path=require('node:path'),runtimeRoot=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const id='11111111-1111-4111-8111-111111111111',id2='22222222-2222-4222-8222-222222222222';
test('dedicated TEST environment binding admits both brands and invalidates the old private API on rotation',()=>{
 const {createBindingReader}=require(runtimeRoot+'/journey-internal-test-binding.cjs'),config={from:{aristo:'Aristo <contato@oaristocrata.com>',fish:'Fish <contato@fishermans.com.br>'},purpose:'crm.journey-internal-test',templateId:116,templateSha256:'a'.repeat(64),token:'SYNTHETIC-TEST-ONLY',username:'synthetic-test-api'},env={DASHBOARD_JOURNEY_TEST_BINDING:JSON.stringify(config)},reader=createBindingReader({env,file:'/no-such-fixture-file'});
 for(const brand of ['fish','aristo']){const binding=reader.getBinding(brand);a.equal(binding.brand,brand);a.equal(binding.templateId,116);a.equal(reader.privateApi(binding).fromEmail,config.from[brand]);a(!JSON.stringify(binding).includes(config.token));const previous=binding;env.DASHBOARD_JOURNEY_TEST_BINDING=JSON.stringify({...config,token:'SYNTHETIC-ROTATED'});a.equal(reader.privateApi(previous),null);env.DASHBOARD_JOURNEY_TEST_BINDING=JSON.stringify(config);}
 for(const invalid of ['',null,JSON.stringify({...config,purpose:'crm.read'}),JSON.stringify({...config,extra:true}),JSON.stringify({...config,token:''}),JSON.stringify({...config,from:{aristo:'Bad\r\nBcc: customer@external.invalid'}}),'x'.repeat(8193)]){env.DASHBOARD_JOURNEY_TEST_BINDING=invalid;a.equal(reader.getBinding('aristo'),null);}
});
function fixture(t,{result='accepted',email='internal@shrigma.com.br',binding=true,wait=1,two=false,timeoutMs=15000,role='manager'}={}){
 const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('synthetic-user')");
 let time=0,active=true,canEdit=true,revision='test-binding-1',calls=[];
 let draft=engine.createDraft({brand:'aristo',id:'synthetic-draft'});draft.steps[0].waitMinutes=wait;
 if(two)draft.steps.push({...draft.steps[0],id:'step-2',waitMinutes:wait+1});
 const identity=()=>({id:'synthetic-user',role,active,email,productFronts:['growth'],productWriteFronts:['growth'],permissions:{growth:{read:true,edit:canEdit}},brands:['aristo']});
 const args={db,engine,now:()=>time,timeoutMs,authorize(_ctx,brand){if(brand!=='aristo'||!active)throw Error('denied');return identity();},getDraft:()=>draft,currentIdentity:identity,getBinding:()=>binding?{purpose:'crm.journey-internal-test',brand:'aristo',active:true,txSend:true,revision,templateId:1}:null,send:async p=>{calls.push(p);if(result==='lost')throw Error('private@example.invalid secret');if(result==='hanging')return new Promise(()=>{});return {state:result};}};
 let runner=createRunner(args);t.after(()=>db.close());
 const request={brand:'aristo',draftId:draft.id,version:1,requestId:id};
 return {db,args,request,calls,get runner(){return runner},time:t=>{time=t},deactivate(){active=false},revokeEdit(){canEdit=false},rotate(){revision='changed'},restart(){runner=createRunner(args)}};
}
test('no internal TEST starts without the dedicated tx binding or with an external mailbox',t=>{
 const f=fixture(t,{binding:false});a.throws(()=>f.runner.start({},f.request),{code:'TEST_TX_BINDING_REQUIRED'});a.equal(f.calls.length,0);
 const g=fixture(t,{email:'customer@external.invalid'});a.throws(()=>g.runner.start({},g.request),{code:'TEST_INTERNAL_IDENTITY_REQUIRED'});a.equal(g.calls.length,0);
});
test('one corporate TEST respects real wait, persists acceptance and never repeats the same nonce',async t=>{
 const f=fixture(t);f.runner.start({},f.request);await f.runner.tick();a.equal(f.calls.length,0);f.time(60000);await f.runner.tick();a.equal(f.calls.length,1);a.equal(f.calls[0].recipient,'internal@shrigma.com.br');a.match(f.calls[0].subject,/^\[TESTE\] /);
 f.runner.start({},f.request);f.restart();await f.runner.tick();a.equal(f.calls.length,1);const r=f.runner.inspect({},f.request);a.equal(r.status,'finished');a.equal(r.accepted,1);a.equal(r.delivered,null);a.equal(r.productionAudienceSelected,false);a(!JSON.stringify(r).includes('internal@'));
});
test('purchase, opt-out and pause stop the appropriate internal step',async t=>{
 for(const flag of ['purchase','optOut']){const f=fixture(t);f.runner.start({},f.request);f.runner.control({},{...f.request,[flag]:true});f.time(60000);await f.runner.tick();a.equal(f.calls.length,0);a.equal(f.runner.inspect({},f.request).status,'excluded');}
 const f=fixture(t);f.runner.start({},f.request);f.runner.control({},{...f.request,paused:true});f.time(60000);await f.runner.tick();a.equal(f.calls.length,0);f.runner.control({},{...f.request,paused:false});await f.runner.tick();a.equal(f.calls.length,1);
});
test('current WRITE revocation blocks both tick and preSend; READ profile never grants sending',async t=>{for(const when of ['beforeTick','preSend']){const f=fixture(t);f.runner.start({},f.request);const http=when==='preSend'?attachTransport(f,{duringGet(){f.revokeEdit();}}):[];if(when==='beforeTick')f.revokeEdit();f.time(60000);await f.runner.tick();await f.runner.tick();a.equal(f.calls.length,0);a.equal(http.filter(x=>x.method==='POST').length,0);a.equal(f.db.prepare('SELECT status FROM journey_internal_test_v1').get().status,'failed');}for(const role of ['manager','superadmin']){const f=fixture(t,{role});f.revokeEdit();a.throws(()=>f.runner.start({},f.request),{code:'TEST_INTERNAL_IDENTITY_REQUIRED'});a.equal(f.calls.length,0);}});
test('internal report projects every frozen step, including waits and disabled steps, without delivery claims',t=>{const f=fixture(t,{two:true});f.args.getDraft().steps[1].enabled=false;f.runner.start({},f.request);const r=f.runner.inspect({},f.request);a.equal(r.steps.length,2);a.equal(r.steps[0].state,'waiting');a.equal(r.steps[1].state,'disabled');a.equal(r.steps[0].due_at,'1970-01-01T00:01:00.000Z');a.match(r.steps[0].test_marker,/^QA /);a.notEqual(r.steps[0].test_marker,r.steps[1].test_marker);a.equal(r.accepted,0);a.equal(r.delivered,null);a.equal(f.calls.length,0);});
test('lost response or expired transport stays uncertain through restart and later ticks',async t=>{
 for(const result of ['lost','hanging']){const f=fixture(t,{result,timeoutMs:5});f.runner.start({},f.request);f.time(60000);await f.runner.tick();a.equal(f.calls.length,1);f.restart();await f.runner.tick();await f.runner.tick();const r=f.runner.inspect({},f.request);a.equal(r.status,'uncertain');a.equal(r.uncertain,1);a.equal(f.calls.length,1);a(!JSON.stringify(r).includes('secret'));a(!JSON.stringify(r).includes('@'));}
});
test('crash after reservation is uncertain; a restart does not repeat a possibly accepted message',async t=>{
 const f=fixture(t);f.runner.start({},f.request);f.db.prepare("UPDATE journey_internal_test_v1 SET status='attempting' WHERE request_id=?").run(id);
 f.db.prepare("INSERT INTO journey_internal_attempt_v1 VALUES('reserved-key',?,'step-1','reserved',NULL,0,0)").run(id);f.restart();f.time(60000);await f.runner.tick();a.equal(f.calls.length,0);a.equal(f.runner.inspect({},f.request).status,'uncertain');
});
test('revoked account or changed test binding is refused before transport',async t=>{
 const f=fixture(t);f.runner.start({},f.request);f.deactivate();f.time(60000);await f.runner.tick();a.equal(f.calls.length,0);a.equal(f.db.prepare('SELECT status FROM journey_internal_test_v1').get().status,'failed');
 const g=fixture(t);g.runner.start({},g.request);g.rotate();g.time(60000);await g.runner.tick();a.equal(g.calls.length,0);a.equal(g.runner.inspect({},g.request).status,'failed');
});
test('failure pauses following steps; a successful multi-step test uses the saved revision',async t=>{
 const f=fixture(t,{two:true});f.runner.start({},f.request);f.time(60000);await f.runner.tick();a.equal(f.calls.length,1);f.time(120000);await f.runner.tick();await f.runner.tick();a.equal(f.calls.length,2);a.equal(f.runner.inspect({},f.request).status,'finished');
 const g=fixture(t,{two:true,result:'refused'});g.runner.start({},g.request);g.time(120000);await g.runner.tick();await g.runner.tick();a.equal(g.calls.length,1);a.equal(g.runner.inspect({},g.request).status,'failed');
});

const {createTransport,TARGET}=require(runtimeRoot+'/journey-internal-test-transport.cjs'),crypto=require('node:crypto'),body='{{ .Tx.Data.test_text }}',bodyHash=crypto.createHash('sha256').update(body).digest('hex');
function transportFixture({status=200,type='tx',rotate=false}={}){
 let revision='1';const calls=[],binding={purpose:'crm.journey-internal-test',active:true,txSend:true,brand:'aristo',revision:'1',templateId:1};
 const transport=createTransport({privateApi:()=>({purpose:'crm.journey-internal-test',revision,username:'synthetic-test-user',token:'SYNTHETIC-ONLY-TEST-TOKEN',templateSha256:bodyHash,fromEmail:'[TESTE] <internal@shrigma.com.br>'}),fetchImpl:async(url,options)=>{calls.push({url,options});if(options.method==='GET'){if(rotate)revision='2';return new Response(JSON.stringify({data:{id:1,type,body}}),{headers:{'content-type':'application/json'}});}return new Response(JSON.stringify({data:true}),{status,headers:{'content-type':'application/json'}});}});
 return {transport,calls,args:{binding,recipient:'internal@shrigma.com.br',subject:'[TESTE] Jornada interna',text:'Texto sintético',signal:new AbortController().signal,preSend:()=>true}};
}
test('official v6.1 external transport sends one internal mailbox with the approved test template',async()=>{
 const f=transportFixture(),r=await f.transport(f.args);a.deepEqual(r,{state:'accepted'});a.deepEqual(f.calls.map(x=>x.options.method),['GET','POST']);a(f.calls.every(x=>x.url.startsWith(TARGET+'/api/')));
 const payload=JSON.parse(f.calls[1].options.body);a.deepEqual(payload.subscriber_emails,['internal@shrigma.com.br']);a.equal(payload.subscriber_mode,'external');a.equal(payload.template_id,1);a.equal(payload.data.test_text,'Texto sintético');a.equal(payload.subject,f.args.subject);a(!JSON.stringify(r).includes('TOKEN'));
});
test('test transport refuses external address, missing prefix, changed credential or non-test template before POST',async()=>{
 for(const extra of [{recipient:'client@external.invalid'},{subject:'Sem prefixo'},{subject:'[TESTE] bad\r\nBcc:client@external.invalid'}]){const f=transportFixture(),r=await f.transport({...f.args,...extra});a.equal(r.state,'refused');a.equal(f.calls.length,0);}
 const g=transportFixture({type:'campaign'});a.equal((await g.transport(g.args)).state,'refused');a.equal(g.calls.length,1);
 const h=transportFixture({rotate:true});a.deepEqual(await h.transport(h.args),{state:'not_sent',code:'TEST_BINDING_CHANGED'});a.equal(h.calls.length,1);
});
test('a possibly accepted 503 stays uncertain while definitive role rejection is refused, without retry',async()=>{
 const f=transportFixture({status:503});a.equal((await f.transport(f.args)).state,'uncertain');a.equal(f.calls.length,2);
 const g=transportFixture({status:403});a.deepEqual(await g.transport(g.args),{state:'refused',code:'TEST_TX_HTTP_403'});a.equal(g.calls.length,2);
});

function attachTransport(f,{duringGet,duringPost}={}){
 const http=[];
 f.args.send=createTransport({privateApi:b=>({purpose:'crm.journey-internal-test',revision:b.revision,username:'synthetic-test-user',token:'SYNTHETIC-ONLY-TEST-TOKEN',templateSha256:bodyHash,fromEmail:'[TESTE] <internal@shrigma.com.br>'}),fetchImpl:async(url,options)=>{
  http.push({url,method:options.method});
  if(options.method==='GET'){await duringGet?.();return new Response(JSON.stringify({data:{id:1,type:'tx',body}}));}
  await duringPost?.();return new Response(JSON.stringify({data:true}));
 }});f.restart();return http;
}
test('pause during template GET proves no POST, and explicit resume sends that step once',async t=>{
 const f=fixture(t);f.runner.start({},f.request);let once=true;
 const http=attachTransport(f,{duringGet(){if(once){once=false;f.runner.control({},{...f.request,paused:true});}}});
 f.time(60000);await f.runner.tick();a.deepEqual(http.map(x=>x.method),['GET']);
 let s=f.runner.inspect({},f.request);a.equal(s.paused,true);a.equal(s.steps[0].state,'not_sent');
 f.runner.control({},{...f.request,paused:false});await f.runner.tick();await f.runner.tick();
 a.deepEqual(http.map(x=>x.method),['GET','GET','POST']);s=f.runner.inspect({},f.request);a.equal(s.accepted,1);a.equal(s.status,'finished');
});
test('purchase, opt-out and account revocation during GET prevent the internal POST',async t=>{
 for(const action of ['purchase','optOut','revoke']){
  const f=fixture(t);f.runner.start({},f.request);
  const http=attachTransport(f,{duringGet(){if(action==='revoke')f.deactivate();else f.runner.control({},{...f.request,[action]:true});}});
  f.time(60000);await f.runner.tick();await f.runner.tick();a.equal(http.filter(x=>x.method==='POST').length,0);
  if(action!=='revoke')a.equal(f.runner.inspect({},f.request).status,'excluded');
 }
});
test('pause written during POST is preserved after API acceptance and blocks the next step',async t=>{
 const f=fixture(t,{two:true});f.runner.start({},f.request);let once=true;
 const http=attachTransport(f,{duringPost(){if(once){once=false;f.runner.control({},{...f.request,paused:true});}}});
 f.time(60000);await f.runner.tick();f.time(120000);await f.runner.tick();
 const s=f.runner.inspect({},f.request);a.equal(s.accepted,1);a.equal(s.paused,true);a.equal(s.status,'waiting');a.equal(http.filter(x=>x.method==='POST').length,1);
 f.runner.control({},{...f.request,paused:false});await f.runner.tick();await f.runner.tick();a.equal(http.filter(x=>x.method==='POST').length,2);a.equal(f.runner.inspect({},f.request).status,'finished');
});
test('more than twenty paused or future jobs cannot hide a due test',async t=>{
 const f=fixture(t,{wait:43200});
 for(let i=0;i<25;i++){f.args.getDraft().id='future-draft-'+i;const request={...f.request,draftId:f.args.getDraft().id,requestId:(i+1).toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111'};f.runner.start({},request);if(i%2)f.runner.control({},{...request,paused:true});}
 f.args.getDraft().id='due-draft';f.args.getDraft().steps[0].waitMinutes=1;const request={...f.request,draftId:f.args.getDraft().id,requestId:id2};f.runner.start({},request);f.time(60000);await f.runner.tick();a.equal(f.calls.length,1);a.equal(f.runner.inspect({},request).accepted,1);
});
test('late template response after deadline cannot issue a POST or clear uncertainty',async t=>{
 const f=fixture(t,{timeoutMs:5});f.runner.start({},f.request);let release;
 const gate=new Promise(r=>{release=r;}),http=attachTransport(f,{duringGet:()=>gate});
 f.time(60000);await f.runner.tick();a.equal(f.runner.inspect({},f.request).status,'uncertain');release();await new Promise(r=>setImmediate(r));
 a.equal(http.filter(x=>x.method==='POST').length,0);a.equal(f.runner.inspect({},f.request).status,'uncertain');
});
test('transport cannot bypass the synchronous runner check',async()=>{
 const f=transportFixture();a.deepEqual(await f.transport({...f.args,preSend:undefined}),{state:'refused',code:'TEST_PRESEND_REQUIRED'});a.equal(f.calls.length,0);
});

test('a different nonce cannot repeat a tested draft revision, including an uncertain one',async t=>{
 const f=fixture(t,{result:'lost'});f.runner.start({},f.request);f.time(60000);await f.runner.tick();
 a.throws(()=>f.runner.start({},{...f.request,requestId:id2}),{code:'TEST_VERSION_ALREADY_RUN'});a.equal(f.calls.length,1);
 a.throws(()=>f.runner.start({},{...f.request,draftId:'wrong-draft',requestId:id2}),{code:'TEST_DRAFT_CHANGED'});
});
test('private binding is purpose-specific and changes whenever its private content changes',()=>{
 const {createBindingReader}=require(runtimeRoot+'/journey-internal-test-binding.cjs');
 let config={purpose:'crm.journey-internal-test',username:'synthetic-test',token:'SYNTHETIC-ONLY-TEST-TOKEN',templateId:1,templateSha256:bodyHash,from:{aristo:'[TESTE] <synthetic-test-never-deliver@shrigma.com.br>'}};
 const reader=createBindingReader({readFile:()=>JSON.stringify(config)}),b=reader.getBinding('aristo');a(b);a.equal(reader.getBinding('fish'),null);a.equal(reader.privateApi(b).purpose,config.purpose);
 config={...config,token:'SYNTHETIC-ROTATED-TEST-TOKEN'};a.equal(reader.privateApi(b),null);a.notEqual(reader.getBinding('aristo').revision,b.revision);
 config.purpose='crm.scheduler-diagnostic';a.equal(reader.getBinding('aristo'),null);
});

test('actual cookie HTTP stores a draft, starts an internal test, pauses, reopens and rejects CSRF/read-only/cross-brand',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Readable,Writable}=require('node:stream');
 const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
 const {createAuth}=require(runtime+'/auth.cjs'),{createServer}=require(runtime+'/server.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journey-internal-http-')),host='gerencial.synthetic.invalid',origin='https://'+host,password='synthetic-internal-test-password',boot='synthetic-bootstrap',sends=[];
 const options={dbPath:path.join(dir,'test.sqlite'),managerHost:host,areaHosts:{growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'influ.synthetic.invalid'},allowedEmailDomains:['shrigma.com.br'],bootstrapAdminEmail:'synthetic-test-never-deliver@shrigma.com.br',bootstrapTokenSha256:crypto.createHash('sha256').update(boot).digest('hex'),encryptionKey:Buffer.alloc(32,3),simpleReadMode:true,crmNativeEnabled:true,journeyTestTransport:{getBinding:brand=>brand==='aristo'?{purpose:'crm.journey-internal-test',brand,active:true,txSend:true,revision:'synthetic-test',templateId:1}:null,send:async args=>{a.equal(args.preSend(),true);sends.push(args);return {state:'accepted'};}}};
 const auth=createAuth(options);await auth.completeBootstrap({email:options.bootstrapAdminEmail,token:boot,password,host,origin});
 const grantDb=new DatabaseSync(options.dbPath);grantDb.prepare('UPDATE grants SET can_edit=1 WHERE area=?').run('growth');grantDb.close();
 const login=await auth.login({email:options.bootstrapAdminEmail,password,host,origin}),cookie=login.cookie.split(';')[0],context={host,origin,method:'POST',cookieHeader:cookie,csrf:login.csrf};
 const app=createServer({...options,mode:'demo',publicDir:path.join(runtime,'public')},{auth});
 t.after(()=>{app.removeAllListeners();auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 async function request(method,url,body,csrf=login.csrf,sessionCookie=cookie,bearer){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url,headers:{host,origin,cookie:sessionCookie,...(bearer?{authorization:'Bearer '+bearer,accept:'application/json, text/event-stream'}:{}),...(body?{'content-type':'application/json'}:{}),...(csrf?{'x-csrf-token':csrf}:{})},socket:{remoteAddress:'synthetic'}});
  const chunks=[],res=new Writable({write(c,e,cb){chunks.push(c);cb();}});res.statusCode=200;res.setHeader=()=>{};res.getHeader=()=>undefined;const done=new Promise(r=>res.once('finish',r));app.emit('request',req,res);await done;return {status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())};
 }
 const draft=engine.createDraft({brand:'aristo',id:'synthetic-http-draft'});draft.steps[0].waitMinutes=0;const store={schema:engine.SCHEMA,drafts:[draft],runs:[]};
 // Exercise the exact compiled guard shipped to the browser, connected to
 // the real cookie/CSRF handler. A transport-only test misses route denial.
 const vm=require('node:vm'),{parseHTML}=require('linkedom'),dom=parseHTML('<html><body><div id="seg-marca"><button class="ativo" data-marca="aristo">Aristo</button></div></body></html>'),guardCalls=[];
 const window={dispatchEvent(){},parent:null,fetch:async(input,init={})=>{const url=new URL(String(input),origin);const result=await request(init.method||'GET',url.pathname+url.search,init.body?JSON.parse(init.body):undefined,new Headers(init.headers).get('X-CSRF-Token')||'');guardCalls.push({path:url.pathname,method:init.method||'GET'});return new Response(JSON.stringify(result.body),{status:result.status,headers:{'Content-Type':'application/json'}});}};window.parent=window;
 vm.runInNewContext(fs.readFileSync(path.join(runtime,'public/guard.compiled.js'),'utf8'),{window,document:dom.document,location:{origin,href:origin+'/app/crm/'},navigator:{},URL,URLSearchParams,Headers,Response,Request,FormData,CustomEvent:dom.window.CustomEvent,HTMLFormElement:dom.window.HTMLFormElement});
 a.equal((await window.fetch('/api/journey-test?brand=aristo')).status,200);
 a.equal((await request('POST','/api/journey-lab',{brand:'aristo',expected_revision:0,store})).status,200);
 const body={action:'start',brand:'aristo',draftId:draft.id,version:1,requestId:id};
 a.equal((await request('POST','/api/journey-test',body,'')).status,403);
 a.equal((await request('POST','/api/journey-test',{...body,recipient:'customer@external.invalid'})).status,400);
 a.equal((await window.fetch('/api/journey-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,201);
 a.equal(guardCalls.filter(c=>c.path==='/api/journey-test'&&c.method==='POST').length,1);
 a.equal((await request('POST','/api/journey-test',{action:'control',brand:'aristo',requestId:id,paused:true})).status,200);
 await auth.simpleAccounts.journeyTest.tick();a.equal(sends.length,0);
 await request('POST','/api/journey-test',{action:'control',brand:'aristo',requestId:id,paused:false});await auth.simpleAccounts.journeyTest.tick();await auth.simpleAccounts.journeyTest.tick();a.equal(sends.length,1);
 const status=await request('GET','/api/journey-test?brand=aristo');a.equal(status.status,200);a.equal(status.body.tests[0].status,'finished');a.equal(status.body.tests[0].accepted,1);a.equal(status.body.tests[0].delivered,null);a(!JSON.stringify(status.body).includes(options.bootstrapAdminEmail));
 const diagnostics=await request('GET','/api/test-diagnostics?brand=aristo');a.equal(diagnostics.status,200);a.equal(diagnostics.body.appendOnly,true);a.deepEqual(diagnostics.body.entries,[]);
 a.equal((await request('GET','/api/test-diagnostics?brand=fish')).status,200);
 a.equal((await request('GET','/api/test-diagnostics?brand=aristo&id='+id,undefined,'')).status,403);
 // This fixture explicitly grants WRITE; an absent private diagnostic is404.
 a.equal((await request('GET','/api/test-diagnostics?brand=aristo&id='+id)).status,404);
 a.equal((await request('GET','/api/test-diagnostics?brand=aristo&brand=fish')).status,400);
 const delegation=auth.nativeConnections.issue({context,brands:['aristo'],scopes:['crm.read'],expiresDays:1}),before=sends.length;
 const native=await request('POST','/api/native/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'crm_status',arguments:{}}},'', '',delegation.token);
 a.equal(native.status,200);const availability=native.body.result.structuredContent.body.internalJourneyTest;
 a.equal(availability.length,1);a.equal(availability[0].brand,'aristo');a.equal(availability[0].available,true);a.equal(availability[0].readOnly,true);a.equal(sends.length,before);a(!JSON.stringify(native.body).includes(options.bootstrapAdminEmail));
 const fishDelegation=auth.nativeConnections.issue({context,brands:['fish'],scopes:['crm.read'],expiresDays:1});
 const noBinding=await request('POST','/api/native/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'crm_status',arguments:{}}},'', '',fishDelegation.token);
 a.equal(noBinding.body.result.structuredContent.body.internalJourneyTest[0].error,'TEST_TX_BINDING_REQUIRED');a.equal(sends.length,before);
 const row=await auth.simpleAccounts.create({context,email:'synthetic-reader-never-deliver@shrigma.com.br',password,jobTitle:'gestor de CRM',fronts:['growth'],brands:['aristo']});
 const readLogin=await auth.login({email:row.user.email,password,host,origin}),readCookie=readLogin.cookie.split(';')[0];
 a.equal((await request('GET','/api/journey-test?brand=fish',undefined,readLogin.csrf,readCookie)).status,403);
 a.equal((await request('GET','/api/test-diagnostics?brand=fish',undefined,readLogin.csrf,readCookie)).status,403);
 a.equal((await request('GET','/api/test-diagnostics?brand=aristo&id='+id,undefined,readLogin.csrf,readCookie)).status,403);
 const read=await request('GET','/api/journey-test?brand=aristo',undefined,readLogin.csrf,readCookie);a.equal(read.body.available,false);a.deepEqual(read.body.tests,[]);
 a.equal((await request('POST','/api/journey-test',{...body,requestId:id2},readLogin.csrf,readCookie)).status,403);
 const editor=await auth.simpleAccounts.create({context,email:'synthetic-editor-never-deliver@shrigma.com.br',password,jobTitle:'CRM',fronts:['growth'],writeFronts:['growth'],brands:['aristo']});const editorLogin=await auth.login({email:editor.user.email,password,host,origin}),editorCookie=editorLogin.cookie.split(';')[0];
 a.equal((await request('GET','/api/test-diagnostics?brand=aristo&id='+id,undefined,editorLogin.csrf,editorCookie)).status,404);
 a.equal((await request('GET','/api/test-diagnostics?brand=aristo&id='+id,undefined,'',editorCookie)).status,403);
 // The real browser session deliberately omits CSRF. Exercise the actual
 // journey controls through the compiled guard and the cookie HTTP handler.
 const uiDraft=engine.createDraft({brand:'aristo',id:'synthetic-http-ui-draft'});uiDraft.steps[0].waitMinutes=43200;
 const uiStore={schema:engine.SCHEMA,drafts:[uiDraft],runs:[]};
 a.equal((await request('POST','/api/journey-lab',{brand:'aristo',expected_revision:1,store:uiStore})).status,200);
 async function journeyUI(sessionCookie,nonce){
  const d=parseHTML('<html><body><div id="seg-marca"><button class="ativo" data-marca="aristo">Aristo</button></div><main id="journey-ui"></main></body></html>'),calls=[];
  Object.defineProperty(d.window.HTMLInputElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked')},set(v){this.toggleAttribute('checked',Boolean(v))}});
  Object.defineProperty(Object.getPrototypeOf(d.document.createElement('select')),'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||''},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v))}});
  const w={dispatchEvent(){},parent:null,fetch:async(input,init={})=>{const u=new URL(String(input),origin),token=new Headers(init.headers).get('X-CSRF-Token')||'',r=await request(init.method||'GET',u.pathname+u.search,init.body?JSON.parse(init.body):undefined,token,sessionCookie);calls.push({path:u.pathname,method:init.method||'GET',protected:token.length>0,status:r.status});return new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}});}};w.parent=w;
  vm.runInNewContext(fs.readFileSync(path.join(runtime,'public/guard.compiled.js'),'utf8'),{window:w,document:d.document,location:{origin,href:origin+'/app/crm/'},navigator:{},URL,URLSearchParams,Headers,Response,Request,FormData,CustomEvent:d.window.CustomEvent,HTMLFormElement:d.window.HTMLFormElement});
  const source=async(url,init)=>{
   if(url.startsWith('/api/templates?'))return new Response(JSON.stringify(url.includes('fluxos_capacidade')?{contract:'crm-published-journey-read-v1',brand:'aristo',read:true,readOnly:true,write:false}:{checked_at:new Date().toISOString(),flows:[]}));
   if(url.startsWith('/api/segments?'))return new Response(JSON.stringify({segments:[]}));
   return w.fetch(url,init);
  };
  const values=new Map(),host=d.document.getElementById('journey-ui'),instance=require(runtime+'/public/crm-preview/journey-ui.js').create({host,engine,storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},fetchImpl:source,getSession:()=>w.ShrigmaReadSession(),serverStorage:true,availability:{internalJourneyTest:true},uuid:()=>nonce});
  instance.sync({brand:'aristo',section:'regua',tab:'lab'});await instance.read();
  const settle=async()=>{for(let i=0;i<200;i++){if(!instance.state().busy)return;await new Promise(r=>setImmediate(r));}a.fail('Journey control did not settle');};
  a.equal(Object.hasOwn(await w.ShrigmaReadSession(),'csrf'),false);
  return{instance,host,calls,settle};
 }
 const uiNonce='33333333-3333-4333-8333-333333333333',uiBody={action:'start',brand:'aristo',draftId:uiDraft.id,version:1,requestId:uiNonce},sendsBeforeUI=sends.length;
 a.equal((await request('POST','/api/journey-test',uiBody,'')).status,403);
 const ui=await journeyUI(cookie,uiNonce);ui.host.querySelector('[data-lab-internal-read]').click();await ui.settle();
 a.equal(ui.host.querySelector('[data-lab-internal-start]').disabled,false);ui.host.querySelector('[data-lab-internal-start]').click();await ui.settle();
 a.deepEqual(ui.calls.filter(c=>c.path==='/api/journey-test'&&c.method==='POST').map(c=>[c.protected,c.status]),[[true,201]]);
 a.equal(auth.simpleAccounts.journeyTest.list(context,'aristo').filter(x=>x.draftId===uiDraft.id).length,1);
 ui.host.querySelector('[data-lab-internal-pause]').click();await ui.settle();
 a.equal(auth.simpleAccounts.journeyTest.list(context,'aristo').find(x=>x.draftId===uiDraft.id).paused,true);a.equal(sends.length,sendsBeforeUI);
 const fixtureDb=new DatabaseSync(options.dbPath);fixtureDb.prepare('INSERT INTO simple_journey_lab_v1 VALUES(?,?,?,?,?,?)').run(row.user.id,'aristo',1,JSON.stringify(uiStore),0,0);fixtureDb.close();
 const readUI=await journeyUI(readCookie,'44444444-4444-4444-8444-444444444444');readUI.host.querySelector('[data-lab-internal-read]').click();await readUI.settle();
 a.equal(readUI.host.querySelector('[data-lab-internal-start]').disabled,true);readUI.host.querySelector('[data-lab-internal-start]').click();await readUI.settle();
 a.equal(readUI.calls.filter(c=>c.path==='/api/journey-test'&&c.method==='POST').length,0);a.equal(sends.length,sendsBeforeUI);
});
