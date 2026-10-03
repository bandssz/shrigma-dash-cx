'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {fixture,pending,hosts,CAPS,sha}=require('./corporate-writer-fixture.cjs');
const DIR=path.resolve(__dirname,'../services/dashboard-operational'),R=require(DIR+'/crm-manager-runtime.cjs'),P=require(DIR+'/proxy.cjs'),S=require(DIR+'/server.cjs');
const readUrl='https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read';
const campaignUrl='https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35';
function upstream(){return{'crm-read':readUrl,campaigns:campaignUrl};}
function manifest(){return{schema:'shrigma_dashboard_dynamic_upstreams_v1',sourceRevision:'4517cc3d3060a75e9d11c360479054cb0bd4d459',routes:{campaigns:campaignUrl}};}
function settings(f){return{...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:upstream(),allowedUpstreamHosts:['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host'],dynamicRouteManifest:manifest()};}
async function handler(server,context,body){return new Promise(resolve=>{const req=Readable.from([Buffer.from(JSON.stringify(body))],{objectMode:false});Object.assign(req,{url:'/auth/users',method:'POST',headers:{host:context.host,origin:context.origin,cookie:context.cookieHeader,'x-csrf-token':context.csrf,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();res.setHeader=()=>{};res.end=body=>{res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(body))});};server.emit('request',req,res);});}
async function refreshAdmin(f){const l=await f.auth.login({email:f.config.bootstrapAdminEmail,password:'Synthetic writer manager password 2026!',host:f.config.managerHost,origin:'https://'+f.config.managerHost});Object.assign(f.context,{cookieHeader:l.cookie.split(';')[0],csrf:l.csrf});}
function readContext(context){return{...context,method:'GET'};}
function env(f){return{DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:f.config.managerHost,DASHBOARD_AREA_HOSTS:JSON.stringify(f.config.areaHosts),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com"]',DASHBOARD_UPSTREAMS:JSON.stringify(upstream()),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(settings(f).allowedUpstreamHosts),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify(manifest()),DASHBOARD_CRM_MANAGED_READ:'enabled',DASHBOARD_CRM_MANAGED_READ_UI:'enabled',DASHBOARD_CRM_MANAGER_ISSUER_ID:f.config.crmManagedRead.issuerId,DASHBOARD_CRM_MANAGER_NAMESPACE_ID:f.config.crmManagedRead.namespaceId,DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN:'R'.repeat(43),DASHBOARD_CRM_MANAGED_WRITER:'enabled',DASHBOARD_CRM_WRITER_DESCRIPTOR:JSON.stringify(f.config.crmManagedWriter),DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN:'S'.repeat(43),DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_ADMIN_EMAIL:'felipebandeira@oaristocrata.com',DASHBOARD_BOOTSTRAP_SHA256:f.config.bootstrapTokenSha256,DASHBOARD_ENCRYPTION_KEY:f.config.encryptionKey.toString('hex')};}

test('corporate settings require the explicit descriptor, fixed domain/admin and distinct READ/WRITER identifiers',async t=>{
 const f=await fixture(t),v=env(f),s=S.settingsFromEnv(v);assert.equal(s.crmManagedWriter.mode,'corporate-read-writer-v1');assert.equal(S.authOptionsFor(s).crmManagedWriter.namespaceId,f.config.crmManagedWriter.namespaceId);
 for(const patch of [{DASHBOARD_CRM_MANAGED_WRITER:'disabled'},{DASHBOARD_EMAIL_DOMAINS:'["synthetic.invalid"]'},{DASHBOARD_ADMIN_EMAIL:'other@oaristocrata.com'},{DASHBOARD_CRM_MANAGED_READ_UI:'disabled'},{DASHBOARD_CRM_WRITER_DESCRIPTOR:JSON.stringify({...f.config.crmManagedWriter,namespaceId:f.config.crmManagedRead.namespaceId})},{DASHBOARD_CRM_WRITER_DESCRIPTOR:JSON.stringify({...f.config.crmManagedWriter,url:'https://arbitrary.invalid'})}])assert.throws(()=>S.settingsFromEnv({...v,...patch}));
 assert.throws(()=>P.validateUpstreams(upstream(),settings(f).allowedUpstreamHosts,manifest(),'production',{crmCampaignSubmitWrite:true,crmCorporateWriter:{...f.config.crmManagedWriter}}));
});
test('READ remains available while edit is requested and after the separate FULL writer promotion',async t=>{
 const f=await fixture(t),id=await f.manager(),ctx=await f.login(),before=f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(id),master=f.masterBaseline();
 assert.equal(f.auth.campaignWriterReady(ctx),false);assert.match(f.auth.managedCrmReadAuthorization(readContext(ctx)).principalId,/^dcrm-/);f.approval(id);assert.equal(f.auth.campaignWriterReady(ctx),false);assert.equal(f.auth.managedCrmJournal.credentialReady(id),true);
 assert.deepEqual(await f.coordinator.run(f.operation(id)),{state:'ready'});assert.equal(f.auth.campaignWriterReady(ctx),true);assert.equal(f.auth.managedCrmJournal.credentialReady(id),true);assert.match(f.auth.managedCrmReadAuthorization(readContext(ctx)).principalId,/^dcrm-/);assert.deepEqual(f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(id),before);assert.deepEqual(f.masterBaseline(),master);assert.deepEqual(f.events,['prepare_writer','writer_status','commit_writer','FULL_ATTEST']);
});
test('a pending READ credential cannot approve edit, and a forged SQLite edit flag cannot widen READ',async t=>{
 const f=await fixture(t),i=f.invite();await f.accept(i);assert.throws(()=>f.approval(i.userId),e=>e.code==='CRM_ACCESS_NOT_READY');assert.equal(f.auth.managedCampaignWriterJournal.pending().length,0);f.promoteRead(i.userId);
 f.db.prepare("UPDATE grants SET can_edit=1 WHERE user_id=?").run(i.userId);assert.equal(f.auth.managedCrmJournal.credentialReady(i.userId),false);assert.equal(f.auth.campaignWriterReady(await f.login()),false);
});
test('dedicated corporate approval route checks admin/Origin/CSRF and kicks only after committed intent',async t=>{
 const f=await fixture(t),id=await f.manager();let kicks=0;const server=S.createServer(settings(f),{auth:f.auth,managedCrmRuntime:{kick:()=>{assert.equal(f.db.isTransaction,false);assert.equal(f.auth.managedCampaignWriterJournal.pending().length,1);kicks++;return Promise.resolve();},close:()=>Promise.resolve()},fetchImpl:()=>{throw Error('NO_UPSTREAM');}});t.after(()=>server.removeAllListeners());
 for(const context of [await f.login(),{...f.context,csrf:'forged'},{...f.context,origin:'https://other.shrigma.com.br'}])assert.equal((await handler(server,context,{action:'crm_writer_approve',userId:id})).status,403);
 assert.equal(kicks,0);assert.equal((await handler(server,f.context,{action:'crm_writer_approve',userId:id,unexpected:true})).status,400);
 const reply=await handler(server,f.context,{action:'crm_writer_approve',userId:id});assert.equal(reply.status,202);assert.deepEqual(reply.body,{ok:true,state:'provisioning'});await new Promise(resolve=>setImmediate(resolve));assert.equal(kicks,1);assert.doesNotMatch(JSON.stringify(reply),/bearer|principal|namespace|lifecycle|operationId/);
});
test('the combined handler still serves campaign READ through the individual READ principal while editing is pending',async t=>{
 const f=await fixture(t),id=await f.manager(),ctx=await f.login();f.approval(id);const calls=[];
 const server=S.createServer(settings(f),{auth:f.auth,managedCrmRuntime:{kick:()=>Promise.resolve(),close:()=>Promise.resolve()},fetchImpl:async(url,options)=>{calls.push({url:String(url),auth:options.headers.Authorization});const response=new Response(JSON.stringify({brand:'fish',lists:[],templates:[],initiatives:[]}),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:String(url)});return response;}});t.after(()=>server.removeAllListeners());
 const reply=await new Promise(resolve=>{const req=Readable.from([]);Object.assign(req,{url:'/api/campaigns?acao=campanha_catalogo&brand=fish',method:'GET',headers:{host:ctx.host,origin:ctx.origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf},socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();res.setHeader=()=>{};res.end=body=>{res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(body))});};server.emit('request',req,res);});
 assert.equal(reply.status,200);assert.equal(calls.length,1);assert.equal(calls[0].url,campaignUrl+'?acao=campanha_catalogo&brand=fish');assert.ok(calls[0].auth.startsWith('Bearer '));assert.equal(f.auth.campaignWriterReady(ctx),false);
});
test('voluntary downgrade and reapproval are blocked by unresolved campaigns in another brand',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});pending(f,id,'crm_campaign_create_v1','confirmed','aristo');const before=f.db.prepare('SELECT * FROM crm_campaign_create_v1').all();
 assert.throws(()=>f.auth.setRequestedAccess({context:f.context,userId:id,requestedAccess:'read'}),e=>e.code==='CAMPAIGN_RECONCILIATION_REQUIRED');assert.equal(f.adapter.getSubject(id).canEdit,true);assert.deepEqual(f.db.prepare('SELECT * FROM crm_campaign_create_v1').all(),before);assert.equal(f.db.prepare("SELECT count(*) n FROM crm_writer_bridge_op_v1 WHERE kind='revoke'").get().n,0);
});
test('staged downgrade confirms WRITER revoke, renews only READ and reapproves a new writer lifecycle',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const prior=f.adapter.getSubject(id),reader=f.auth.managedCrmJournal.readBinding(id);f.auth.setRequestedAccess({context:f.context,userId:id,requestedAccess:'read'});
 assert.equal(f.auth.managedCrmJournal.credentialReady(id),true);assert.equal(f.auth.users({context:f.context}).find(u=>u.id===id).crmWriter.state,'revoking');assert.throws(()=>f.approval(id));const revoke=f.auth.managedCampaignWriterJournal.pending()[0];assert.deepEqual(await f.coordinator.run(revoke),{state:'revoked'});
 f.auth.renewManagedCrm({context:f.context,userId:id});f.promoteRead(id);assert.equal(f.auth.managedCrmJournal.readBinding(id).generation,reader.generation+1);assert.deepEqual(await f.issue(id),{state:'ready'});assert.notEqual(f.adapter.getSubject(id).lifecycleId,prior.lifecycleId);assert.ok(f.adapter.getSubject(id).version>prior.version);assert.equal(f.db.prepare('SELECT count(*) n FROM crm_writer_retired_binding_v1').get().n,1);
});
test('expired credentials refuse writes; confirmed dual revoke and reinvite are the bounded expired READ recovery path',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});f.advance(1209600001);await refreshAdmin(f);assert.equal(f.auth.campaignWriterReady(await f.login()),false);assert.throws(()=>f.auth.renewManagedCrm({context:f.context,userId:id}));f.auth.revokeUser({context:f.context,userId:id});assert.equal(f.auth.managedCampaignWriterJournal.pending().length,1);assert.equal(f.auth.managedCrmJournal.pendingOperations(8).length,1);assert.throws(()=>f.invite());
 assert.deepEqual(await f.coordinator.run(f.auth.managedCampaignWriterJournal.pending()[0]),{state:'revoked'});f.confirmReadRevoke(id);const i=f.invite();assert.equal(i.userId,id);await f.accept(i);f.promoteRead(id);assert.equal(f.auth.managedCrmJournal.credentialReady(id),true);assert.equal(f.adapter.getSubject(id).canEdit,false);
});
test('forced manager disable revokes both lifecycles and preserves campaign reservations and encrypted identity evidence',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});pending(f,id,'crm_campaign_delivery_v1','confirmed','aristo');const prior=f.db.prepare('SELECT * FROM crm_campaign_delivery_v1').all();f.auth.revokeUser({context:f.context,userId:id});assert.deepEqual(f.db.prepare('SELECT * FROM crm_campaign_delivery_v1').all(),prior);assert.equal(f.auth.managedCampaignWriterJournal.pending().length,1);assert.equal(f.auth.managedCrmJournal.pendingOperations(8).length,1);const retired=f.db.prepare('SELECT * FROM crm_writer_retired_binding_v1').get();assert.match(retired.encrypted_key,/^v1\./);assert.match(retired.principal_id,/^dcrmw-/);assert.doesNotMatch(JSON.stringify(f.auth.users({context:f.context})),/encrypted_key|credential_mac|principal_id|namespace_id/);
});
test('the admin UI offers a dedicated campaign approval without claiming template/media/audience edit',()=>{
 const ui=fs.readFileSync(DIR+'/public/entry.js','utf8');assert.match(ui,/Aprovar edição de campanhas/);assert.match(ui,/crm_writer_approve/);assert.match(ui,/user\.crmWriter\?\.canApprove===true/);assert.doesNotMatch(ui,/crm_writer_renew/);
});

test('staggered READ expiry closes new campaign POSTs while old WRITER GET identity stays recoverable',async t=>{
 const f=await fixture(t),id=await f.manager();f.advance(13*86400000);await refreshAdmin(f);assert.deepEqual(await f.issue(id),{state:'ready'});
 f.advance(86400000+1);const ctx=await f.login();assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);assert.equal(f.auth.campaignWriterReady(ctx),false);
 for(const action of ['criar','salvar','validar','agendar','cancelar'])assert.throws(()=>f.auth.campaignWriterAuthorization(ctx,{brand:'fish',action}),e=>e.code==='CRM_ACCESS_NOT_READY');
 for(const action of ['operacao','operacao_criar','obter'])assert.equal(f.auth.campaignWriterAuthorization({...ctx,method:'GET'},{brand:'aristo',action}).canEdit,true);
 assert.equal(f.adapter.bindingForUser(id)!==null,true);assert.equal(f.adapter.publicState(id).ready,false);assert.equal(f.adapter.publicState(id).state,'blocked');
 assert.equal(f.events.filter(x=>x==='prepare_writer').length,1);assert.equal(f.events.filter(x=>x==='commit_writer').length,1);
});
test('READ loss during FULL compensates the exact committed lifecycle once without any local edit grant',async t=>{
 const f=await fixture(t),id=await f.manager();f.advance(14*86400000-1);await refreshAdmin(f);f.duringAttest=()=>f.advance(2);
 assert.deepEqual(await f.issue(id),{state:'revoked'});const op=f.operation(id),state=f.auth.managedCampaignWriterJournal.state(op);
 assert.equal(state.phase,'revoked');assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);assert.equal(f.adapter.getSubject(id).canEdit,false);assert.equal(f.adapter.bindingForUser(id),null);
 assert.equal(f.db.prepare("SELECT count(*) n FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(id).n,0);
 const rows=f.db.prepare('SELECT kind,request_json FROM crm_writer_bridge_op_v1 ORDER BY rowid').all(),issue=JSON.parse(rows[0].request_json),revoke=JSON.parse(rows[1].request_json);
 for(const key of ['userId','lifecycleId','namespaceId','issuerId','owner'])assert.equal(revoke[key],issue[key]);assert.equal(rows[1].kind,'revoke');
 assert.equal(f.events.filter(x=>x==='revoke_writer').length,1);assert.deepEqual(await f.coordinator.run(op),{state:'revoked'});assert.equal(f.events.filter(x=>x==='revoke_writer').length,1);
});
test('READ revoked locally also denies new POSTs without rotating the unresolved WRITER principal',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const before=f.adapter.bindingForUser(id),ctx=await f.login();
 f.db.prepare("DELETE FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").run(id);
 assert.throws(()=>f.auth.campaignWriterAuthorization(ctx,{brand:'fish',action:'salvar'}),e=>e.code==='CRM_ACCESS_NOT_READY');
 assert.equal(f.auth.campaignWriterAuthorization({...ctx,method:'GET'},{brand:'fish',action:'operacao'}).credentialMac,before.credential_mac);
 assert.equal(f.auth.managedCampaignWriterJournal.pending().length,0);assert.equal(f.adapter.bindingForUser(id).principal_id,before.principal_id);
});

test('only complete final or isolated V25 corporate host tuples construct; mixed/arbitrary tuples stay closed',async t=>{
 const tuples=[hosts,{manager:'dashboard-v25-gerencial.tazdb8.easypanel.host',growth:'dashboard-v25-crm.tazdb8.easypanel.host',organico:'dashboard-v25-organico.tazdb8.easypanel.host',influs:'dashboard-v25-influs.tazdb8.easypanel.host'}];
 for(const tuple of tuples){const f=await fixture(t,tuple);assert.equal(R.corporateHostsAllowed(f.config.managerHost,f.config.areaHosts),true);assert.equal(S.settingsFromEnv(env(f)).managerHost,tuple.manager);
  const server=S.createServer(settings(f),{auth:f.auth,managedCrmRuntime:{kick:()=>Promise.resolve(),close:()=>Promise.resolve()},fetchImpl:()=>{throw Error('NO_UPSTREAM');}});server.removeAllListeners();
  for(const wrong of [{...f.config.areaHosts,growth:tuple===hosts?tuples[1].growth:hosts.growth},{...f.config.areaHosts,influs:'arbitrary.easypanel.host'},{...f.config.areaHosts,extra:'extra.easypanel.host'}]){
   assert.equal(R.corporateHostsAllowed(f.config.managerHost,wrong),false);assert.throws(()=>S.settingsFromEnv({...env(f),DASHBOARD_AREA_HOSTS:JSON.stringify(wrong)}));assert.throws(()=>require(DIR+'/auth.cjs').createAuth({...f.config,areaHosts:wrong}));assert.throws(()=>S.createServer({...settings(f),areaHosts:wrong},{auth:f.auth}));
  }
 }
});

test('corporate CREATE POST stays closed after the constructor fix and unbranded descriptors cannot enable Creator',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const ctx=await f.login();
 const creator=require(DIR+'/crm-campaign-create.cjs');assert.throws(()=>creator.createCampaignCreator({enabled:true,profile:'corporate-read-writer-v1',allowedEmailDomains:['oaristocrata.com'],corporateWriter:{...f.config.crmManagedWriter}}),e=>e.code==='CAMPAIGN_CREATE_DENIED');
 const server=S.createServer(settings(f),{auth:f.auth,managedCrmRuntime:{kick:()=>Promise.resolve(),close:()=>Promise.resolve()},fetchImpl:()=>{throw Error('NO_UPSTREAM');}});t.after(()=>server.removeAllListeners());
 const reply=await new Promise(resolve=>{const req=Readable.from([Buffer.from('{}')],{objectMode:false});Object.assign(req,{url:'/auth/campaign-create',method:'POST',headers:{host:ctx.host,origin:ctx.origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();res.setHeader=()=>{};res.end=b=>{res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(b))});};server.emit('request',req,res);});
 assert.equal(reply.status,403);assert.equal(reply.body.error,'EDIT_NOT_READY');assert.equal(f.db.prepare('SELECT count(*) n FROM crm_campaign_create_v1').get().n,0);
});
test('the real WRITER runtime joins concurrent kicks, uses one fixed private transport and stops after close',async t=>{
 const f=await fixture(t),id=await f.manager();f.approval(id);const calls=[],functions=require(DIR+'/crm-manager-writer-client.cjs').FUNCTIONS;
 const runtime=R.createWriterManagerRuntime({auth:f.auth,descriptor:f.config.crmManagedWriter,readDescriptor:f.config.crmManagedRead,allowedEmailDomains:['oaristocrata.com'],provisionerToken:'W'.repeat(43)},{now:()=>f.now,requestImpl:(url,options,callback)=>{
  assert.equal(f.db.isTransaction,false);assert.ok(url.startsWith(R.WRITER_ORIGIN+'/internal/v1/crm-writers/'));assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);assert.equal(options.headers.Authorization,'CRM-Writer-Provisioner '+'W'.repeat(43));
  const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=()=>{};request.end=body=>{const command=JSON.parse(body);assert.equal(Object.hasOwn(command,'bearer'),false);calls.push(command.action);Promise.resolve(f.invoke({procedure:functions[command.action],parameters:[body]})).then(result=>{const response=new EventEmitter();Object.assign(response,{statusCode:200,headers:{'content-type':'application/json'},rawHeaders:[],destroy:()=>{}});callback(response);response.emit('data',Buffer.from(JSON.stringify(result)));response.emit('end');}).catch(e=>request.emit('error',e));};return request;
 },fetchImpl:async(url,options)=>{const IDENTITY=require(DIR+'/crm-campaign-writer-attestation.cjs').IDENTITY_URL;assert.equal(url,IDENTITY);assert.equal(options.redirect,'manual');const row=f.db.prepare("SELECT request_json FROM crm_writer_bridge_op_v1 WHERE kind='issue'").get(),q=JSON.parse(row.request_json);const response=new Response(JSON.stringify({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:q.owner,allowedPanels:['growth'],permissions:{growth:{who:'panel:'+q.principalId,label:q.owner,caps:[...CAPS]},influs:null}}),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:IDENTITY});return response;}});
 const a=runtime.kick(),b=runtime.kick();assert.equal(a,b);assert.deepEqual(await a,{ready:1,pending:0,expired:0,revoked:0});assert.deepEqual(calls,['prepare_writer','writer_status','commit_writer']);assert.equal(f.auth.campaignWriterReady(await f.login()),true);
 assert.deepEqual(await runtime.kick(),{ready:0,pending:0,expired:0,revoked:0});await runtime.close();assert.deepEqual(await runtime.kick(),{ready:0,pending:0,expired:0,revoked:0});assert.equal(calls.length,3);
});
