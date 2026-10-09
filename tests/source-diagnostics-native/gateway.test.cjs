'use strict';
// Original auth and gateway in a disposable source fixture; no production
// identity, database, grant, source service or network participates.
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable,Writable}=require('node:stream');
const runtime=process.env.SOURCE_DIAGNOSTICS_TEST_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs'),{settingsFromEnv,createServer}=require(runtime+'/server.cjs'),P=require(runtime+'/proxy.cjs');
const host='gerencial.shrigma.com.br',origin='https://'+host,email='felipebandeira@oaristocrata.com',sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',sourceBearer='isolated-source-service-key-000000000000',revision='79861de6f9c3628885e7840858011180b5af9899',query='bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086';
const originalResponse=(value,url)=>{const r=new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r;};
async function fixture(t,{enabled=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isolated-native-source-auth-')),dbPath=path.join(dir,'identity.sqlite'),masterKey='isolated-central-master-'+crypto.randomBytes(12).toString('hex');
 const env={DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:email,DASHBOARD_BOOTSTRAP_SHA256:sha('isolated-bootstrap'),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_WRITE:'enabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_NATIVE_SHOPIFY_SOURCE:'enabled',...(enabled?{DASHBOARD_NATIVE_SOURCE_DIAGNOSTICS:'enabled'}:{}),DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:dbPath,DASHBOARD_PUBLIC_DIR:dir};
 const calls=[];let started;
 const sourceTransport=async input=>{calls.push(input);if(input.path==='/healthz')return {status:200,revision,body:{service:'crm-shopify-sync',enabled:true,revision,product_semantics:'v2',stopping:false}};a.equal(input.bearer,sourceBearer);if(input.method==='POST'){started={...input.body};return {status:202,revision,body:{operation_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',idempotency_key:started.idempotency_key,brand:started.brand,state:'claimed',query_sha256:query,bulk_operation_id:null,next_chunk:0,chunks:null,error_code:null}};}return {status:200,revision,body:{operation_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',idempotency_key:started.idempotency_key,brand:started.brand,kind:'run',scheduled_for:started.scheduled_for,state:'claimed',query_sha256:query,bulk_operation_id:null,source_sha256:null,next_chunk:0,chunks:null,last_chunk:null,last_chunk_sha256:null,last_receipt:null,error_code:null}};};
 const settings=settingsFromEnv(env),auth=createAuth({...settings,crmNativeDatabaseEnabled:true,crmNativeSourceTransport:sourceTransport});t.after(()=>{auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 await auth.completeBootstrap({email,token:'isolated-bootstrap',password:'Isolated-Test-Password-2026!',host,origin});const login=await auth.login({email,password:'Isolated-Test-Password-2026!',host,origin}),ctx={cookieHeader:login.cookie.split(';')[0],host,origin,method:'POST',csrf:login.csrf},user=auth.session(ctx).user;
 auth.setUpstreamCredential({context:ctx,userId:user.id,slot:'growth-read',bearer:masterKey});await auth.activateOwnMasterCampaignWriter({context:ctx,fetchImpl:async url=>originalResponse({schema:'shrigma_access_identity_v1',role:'master',panel:'todos',owner:email,allowedPanels:['cx','growth','organico','influs'],permissions:{growth:{who:'panel:isolated-source-master',label:email,caps:['read_content','draft','validate','submit']},influs:null}},url)});
 const {createDiagnosticsController}=require(runtime+'/native-source-diagnostics-controller.cjs');
 const reads=[],sourceDiagnostics=createDiagnosticsController({enabled,driver:{Client:function(){},version:'8.23.1',packageSha256:'d'.repeat(64)},auth,coreFactory:()=>({inspect:async (input,proof)=>{reads.push({input,proof});return {schema:'fixture-diagnostic-read',operational:false};},close:async()=>({closed:true})})});t.after(()=>sourceDiagnostics.close());
 const issued=auth.nativeConnections.issue({context:ctx,brands:['fish'],scopes:['crm.read','crm.draft'],expiresDays:1}),server=createServer(settings,{auth,sourcePeerTransport:sourceTransport,sourceDiagnostics});t.after(()=>server.close());
 async function request(method,url,body,native=false){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=url;req.headers={host,origin,...(native?{authorization:'Bearer '+issued.token,accept:'application/json, text/event-stream'}:{cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf}),...(body===undefined?{}:{'content-type':'application/json'})};req.socket={remoteAddress:'isolated-source-fixture'};const chunks=[],res=new Writable({write(c,_e,cb){chunks.push(Buffer.from(c));cb();}});res.statusCode=200;res.setHeader=()=>{};res.getHeader=()=>undefined;const done=new Promise(r=>res.once('finish',r));server.emit('request',req,res);await done;return {status:res.statusCode,body:(()=>{const text=Buffer.concat(chunks).toString();try{return JSON.parse(text);}catch{return text;}})()};}
 const rpc=(name,args)=>request('POST','/api/native/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},true);
 async function prepare(){auth.nativeSourceSync.bind({context:ctx,bearer:sourceBearer,brands:['fish'],privateNetwork:true});auth.nativeConnections.permitSourceSync({context:ctx,connectionId:issued.connection.id});auth.nativeDatabaseVault.bind({context:ctx,username:'fixture_reader',password:'FixtureOnly.Private.123456789',privateNetwork:true});await auth.nativeSourceSync.run({context:ctx,brand:'fish',requestId});}
 return {env,settings,auth,ctx,issued,calls,request,rpc,prepare,reads};
}

const selection=f=>({connectionId:f.issued.connection.id,brand:'fish',requestId});
test('original owner page serves the mounted diagnostic section and external CSP script; status performs no READ',async t=>{
 const f=await fixture(t);await f.prepare();const page=await f.request('GET','/auth/native-source');a.equal(page.status,200);a.match(page.body,/id="diagnostics"/);a.match(page.body,/src="\/auth\/native-source-diagnostics.js"/);
 const script=await f.request('GET','/auth/native-source-diagnostics.js');a.equal(script.status,200);a.match(script.body,/authorize-diagnostics/);
 const status=await f.request('POST','/auth/native-source-settings',{action:'diagnostics-status'});a.equal(status.status,200);a.equal(status.body.attempts[0].requestId,requestId);a.equal(status.body.connections[0].diagnosticsAuthorized,false);a.equal(f.reads.length,0);
});
test('browser separate grant then same selected request works through native MCP and explicit operator READ',async t=>{
 const f=await fixture(t);await f.prepare();const before=f.calls.length;
 const no=await f.rpc('crm_source_diagnostics',{brand:'fish',requestId});a.equal(no.body.result.structuredContent.error,'NATIVE_SCOPE_DENIED');a.equal(f.reads.length,0);
 const permit=await f.request('POST','/auth/native-source-settings',{action:'authorize-diagnostics',...selection(f),consent:true});a.equal(permit.status,200);a.equal(permit.body.scope,'crm.source-diagnostics');a.equal(f.reads.length,0);
 const native=await f.rpc('crm_source_diagnostics',{brand:'fish',requestId});a.equal(native.body.result.structuredContent.status,200,JSON.stringify(native));
 const browser=await f.request('POST','/auth/native-source-settings',{action:'diagnose',...selection(f)});a.equal(browser.status,200);a.equal(f.reads.length,2);a.equal(f.calls.length,before);
 a.deepEqual(f.reads[0].input,{brand:'fish',operationId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'});
});
test('diagnostic route has native-only exact GET contract and cannot accept supplied operation UUID',async t=>{
 const f=await fixture(t);await f.prepare();const query='?brand=fish&requestId='+requestId;
 a.equal((await f.request('GET','/api/source-diagnostics'+query)).status,403);
 a.equal((await f.request('POST','/api/source-diagnostics'+query,{},true)).status,403);
 for(const suffix of ['&operationId=dddddddd-dddd-4ddd-8ddd-dddddddddddd','&brand=fish','&connectionId=wrong'])a.equal((await f.request('GET','/api/source-diagnostics'+query+suffix,undefined,true)).status,403);
 const invalid=await f.rpc('crm_source_diagnostics',{brand:'fish',requestId,operationId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'});a.equal(invalid.body.result.structuredContent.error,'NATIVE_ARGUMENTS_INVALID');
 const forged=await f.request('POST','/auth/native-source-settings',{action:'authorize-diagnostics',...selection(f),consent:true,operationId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'});a.equal(forged.status,400);a.equal(f.reads.length,0);
});
test('capability OFF hides MCP tool and diagnostic page section and denies diagnostic action',async t=>{
 const f=await fixture(t,{enabled:false});const page=await f.request('GET','/auth/native-source');a.equal(page.status,200);a.doesNotMatch(page.body,/id="diagnostics"/);
 const list=await f.request('POST','/api/native/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},true);a.equal(list.body.result.tools.some(x=>x.name==='crm_source_diagnostics'),false);
 const result=await f.request('POST','/auth/native-source-settings',{action:'diagnostics-status'});a.equal(result.status,400);a.equal(f.reads.length,0);
});
test('revoking original connection suppresses the diagnostic result through actual native MCP',async t=>{
 const f=await fixture(t);await f.prepare();const permit=await f.request('POST','/auth/native-source-settings',{action:'authorize-diagnostics',...selection(f),consent:true});a.equal(permit.status,200);f.auth.nativeConnections.revoke({context:f.ctx,connectionId:f.issued.connection.id});const result=await f.rpc('crm_source_diagnostics',{brand:'fish',requestId});a.equal(result.status,401);a.equal(f.reads.length,0);
});
