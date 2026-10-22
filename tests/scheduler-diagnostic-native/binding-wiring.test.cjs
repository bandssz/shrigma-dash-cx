'use strict';
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),{Readable,Writable}=require('node:stream');
const runtime=process.env.SCHEDULER_BINDING_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createDelegationStore}=require(runtime+'/crm-native-delegation.cjs'),{createSchedulerBinding}=require(runtime+'/native-scheduler-binding.cjs');
const {createNativeMcp}=require(runtime+'/crm-native-mcp.cjs'),{settingsFromEnv,authOptionsFor}=require(runtime+'/server.cjs'),P=require(runtime+'/proxy.cjs'),O=require(runtime+'/native-scheduler-binding-operator.cjs');
const host='gerencial.shrigma.com.br',h=x=>crypto.createHash('sha256').update(x).digest('hex'),browser={method:'POST'},id='fixture-owner';
test('new separate scheduler binding preserves real store scopes and accepted health consent',async()=>{
 const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('fixture-owner');");
 let live=true;const identity=()=>({role:'superadmin',active:live,canEditGrowth:true,revision:h('original-owner')}),store=createDelegationStore({db,managerHost:host,consent:()=>({userId:id,sessionHash:h('actual-fixture-session')}),identity,mac:h,now:()=>1000});
 const issued=store.issue({context:browser,brands:['fish','aristo'],scopes:['crm.read','db.inspect']});
 const healthBinding={schema:'shrigma-delivery-health-consent-v1',ownerId:id,ownerRevision:identity().revision,brand:'fish',crmBindingHash:h('original-crm'),profileRevision:1,credentialBindingHash:h('private-pg'),resourceHash:h('original-pg-resource'),queryHash:h('fixed-health-read')};
 store.permitDeliveryHealth({context:browser,connectionId:issued.connection.id,binding:healthBinding});
 const prior=store.authenticate(issued.token),before=store.deliveryHealthConsent({context:browser,connectionId:prior.id,brand:'fish'});
 const current=(context,connectionId)=>({...store.schedulerDiagnosticOwner({context,connectionId}),profileRevision:h('original-crm-profile'),authorityHash:h('original-crm')});
 const vault=createSchedulerBinding({enabled:true,db,current,encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString(),mac:h,now:()=>1000,verify:async()=>({profileHash:h('actual-synthetic-profile'),authenticationView:'original-api-cache',settingsReadPermitted:true})});
 await vault.bind({context:browser,connectionId:prior.id,apiUser:'isolated_api',apiToken:'isolated-synthetic-api-token_123456',consent:true});
 a.deepEqual(store.authenticate(issued.token).scopes,prior.scopes);a.deepEqual(store.deliveryHealthConsent({context:browser,connectionId:prior.id,brand:'fish'}),before);
 const native=store.context(issued.token);a.equal(vault.status({context:native,connectionId:prior.id}).linked,true);
 store.revoke({context:browser,connectionId:prior.id});a.throws(()=>vault.status({context:native,connectionId:prior.id}),{code:'NATIVE_AUTH_REQUIRED'});db.close();
});
function env(){return {DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:'felipebandeira@oaristocrata.com',DASHBOARD_BOOTSTRAP_SHA256:'a'.repeat(64),DASHBOARD_ENCRYPTION_KEY:'b'.repeat(64),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_CRM_PUBLISHED_JOURNEY_READ:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:'/tmp/unused-fixture.sqlite',DASHBOARD_PUBLIC_DIR:'/tmp'};}
test('new binding admission defaults OFF and enables only production original Master/native READ profile',()=>{
 const base=env();a.equal(settingsFromEnv(base).crmNativeSchedulerBindingEnabled,undefined);const on=settingsFromEnv({...base,DASHBOARD_NATIVE_SCHEDULER_BINDING:'enabled'});a.equal(on.crmNativeSchedulerBindingEnabled,true);a.equal(authOptionsFor(on).crmNativeSchedulerBindingEnabled,true);
 for(const delta of [{DASHBOARD_NATIVE_SCHEDULER_BINDING:'true'},{DASHBOARD_NATIVE_MCP:'disabled'},{DASHBOARD_CRM_PUBLISHED_JOURNEY_READ:'disabled'},{DASHBOARD_MODE:'synthetic'}])a.throws(()=>settingsFromEnv({...base,DASHBOARD_NATIVE_SCHEDULER_BINDING:'enabled',...delta}),/invalid/);
});
test('existing native status reports binding availability through same dispatcher, without new GET profile/diagnostic',async()=>{
 const calls=[],proof={brands:['fish','aristo'],scopes:['crm.read'],userId:id,host,id:'connection-fixture'};
 const store={authenticate:()=>proof,context:token=>({nativeBearer:token,host,method:'GET'})};
 const mcp=createNativeMcp({auth:{nativeConnections:store},managerHost:host,invoke:async q=>{calls.push(q);if(q.path==='/auth/session')return {status:200,body:{authenticated:true,user:{role:'superadmin'},features:{nativeSchedulerBinding:true}}};if(q.path==='/healthz')return {status:200,body:{nativeMcp:true}};if(q.path==='/api/scheduler-binding-status')return {status:200,body:{schema:'shrigma-scheduler-binding-status-v1',connections:[],diagnosticRuntimeAdmitted:false}};throw Error('Unexpected diagnostic or profile fetch');}});
 const v=await mcp.call('crm_status',{},'isolated-token');a.equal(v.body.schedulerBindingReceipt.body.diagnosticRuntimeAdmitted,false);a.deepEqual(calls.map(q=>q.path),['/auth/session','/healthz','/api/scheduler-binding-status']);a(calls.every(q=>q.method==='GET'&&q.body===undefined));
});
async function operator(body,{hostOverride=host,native=false,method='POST',authorizer=()=>{},bind=async q=>({linked:true,consented:true,purpose:'crm.scheduler-diagnostic',connectionId:q.connectionId})}={}){
 const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method=method;req.headers={'content-type':'application/json'};
 const chunks=[],res=new Writable({write:b=>{chunks.push(Buffer.from(b));}});res.setHeader=()=>{};res.end=b=>{if(b)chunks.push(Buffer.from(b));};
 const auth={authorize:authorizer,nativeSchedulerBinding:{enabled:true,bind},nativeConnections:{}};const ctx={host:hostOverride,method,...(native?{nativeBearer:'isolated'}:{})};
 await O.handleSchedulerBindingOperator({req,res,url:new URL('https://'+host+O.API),ctx,auth,managerHost:host});
 return JSON.parse(Buffer.concat(chunks).toString());
}
test('private operator binds once with browser authority and never echoes secret or accepts selectors',async()=>{
 const body={action:'bind',connectionId:'a1111111-1111-4111-8111-111111111111',apiUser:'isolated_api',apiToken:'isolated-private-api-key_123456',consent:true};let calls=0;
 const v=await operator(body,{bind:async q=>{calls++;a.equal(q.apiToken,body.apiToken);return {linked:true,consented:true,purpose:'crm.scheduler-diagnostic',connectionId:q.connectionId};}});a.equal(calls,1);a(!JSON.stringify(v).includes(body.apiToken));
 for(const extra of ['actor','issuer','url','sql','grant','method'])await a.rejects(operator({...body,[extra]:'injection'}),{code:'SCHEDULER_ARGUMENTS_REFUSED'});
 await a.rejects(operator(body,{native:true}),{code:'SCHEDULER_BROWSER_REQUIRED'});await a.rejects(operator(body,{hostOverride:'crm.shrigma.com.br'}),{code:'SCHEDULER_BROWSER_REQUIRED'});await a.rejects(operator(body,{method:'GET'}),{code:'METHOD_DENIED'});
});
test('operator auth/CSRF denial happens before parsing or private profile transport',async()=>{
 let calls=0;await a.rejects(operator({action:'bind'},{authorizer:()=>{throw Object.assign(Error('CSRF_DENIED'),{code:'CSRF_DENIED'});},bind:()=>{calls++;}}),{code:'CSRF_DENIED'});a.equal(calls,0);
 new (require('node:vm').Script)(O.JS);a(O.HTML.includes('type="password"'));a(!O.HTML.includes('Consultar diagnóstico'));a(!O.JS.includes('localStorage'));a(!O.JS.includes('console.'));a(O.JS.includes("key.value=''"));a(O.JS.includes("body.apiToken=''"));a(O.JS.includes('Promise.race'));
});


test('real auth profile revision stays HMAC64 across original profile lifecycle and invalidates old binding',async()=>{
 const {createAuth}=require(runtime+'/auth.cjs'),masterHost='manager.synthetic.invalid',origin='https://'+masterHost;
 const auth=createAuth({dbPath:':memory:',managerHost:masterHost,areaHosts:{growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'affiliate.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'master@synthetic.invalid',bootstrapTokenSha256:h('isolated-bootstrap'),encryptionKey:Buffer.alloc(32,7).toString('hex'),now:()=>1800000000000});
 const db=new DatabaseSync(':memory:');try{
  await auth.completeBootstrap({email:'master@synthetic.invalid',token:'isolated-bootstrap',password:'Synthetic-Only-Password-2026!',host:masterHost,origin});
  const login=await auth.login({email:'master@synthetic.invalid',password:'Synthetic-Only-Password-2026!',host:masterHost,origin});
  const context={cookieHeader:login.cookie.split(';')[0],host:masterHost,origin,method:'POST',csrf:login.csrf};
  const invited=auth.createInvite({context,email:'profile-fixture@synthetic.invalid',areas:['growth'],brand:'fish'});
  const revision=()=>auth.users({context}).find(user=>user.id===invited.userId).profileRevision;
  const initial=revision();a.match(initial,/^[a-f0-9]{64}$/);
  db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('fixture-owner');CREATE TABLE crm_native_connections_v1(id TEXT PRIMARY KEY);INSERT INTO crm_native_connections_v1 VALUES('a1111111-1111-4111-8111-111111111111');");
  const connectionId='a1111111-1111-4111-8111-111111111111',current=()=>({ownerId:id,ownerRevision:h('owner'),connectionHash:h('connection'),authorityHash:h('authority'),profileRevision:revision()});
  const vault=createSchedulerBinding({enabled:true,db,current,encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString(),mac:h,now:()=>1000,verify:async()=>({profileHash:h('api'),authenticationView:'original-api-cache',settingsReadPermitted:true})});
  const native={method:'GET',nativeBearer:'isolated-native-token'};
  a.equal(vault.status({context:native,connectionId}).linked,false);
  await vault.bind({context:browser,connectionId,apiUser:'isolated_api',apiToken:'isolated-synthetic-api-token_123456',consent:true});a.equal(vault.status({context:native,connectionId}).linked,true);
  auth.revokeUser({context,userId:invited.userId});a.match(revision(),/^[a-f0-9]{64}$/);a.notEqual(revision(),initial);
  let reads=0;await a.rejects(vault.withVerifiedCredential({context:native,connectionId,read:async()=>{reads++;}}),{code:'SCHEDULER_API_BINDING_REQUIRED'});a.equal(reads,0);
 }finally{db.close();auth.close();}
});
