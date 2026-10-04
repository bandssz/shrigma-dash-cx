'use strict';
// Real auth/SQLite and in-process HTTP; synthetic issuers and fetch only.
const test=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {fixture,hosts,CAPS}=require('./corporate-writer-fixture.cjs');
const S=require('../services/dashboard-operational/server.cjs');
const P=require('../services/dashboard-operational/proxy.cjs');
const B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs');
const A=require('../services/dashboard-operational/crm-audience-read-bridge.cjs');
const T=require('../services/dashboard-operational/crm-template-read-bridge.cjs');
const audienceHost=new URL(A.DESTINATIONS['audience-read']).hostname;
const manifest={schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns}};
function settings(f){return{...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedAudienceRead:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':B.DESTINATIONS['crm-read'],campaigns:B.DESTINATIONS.campaigns},allowedUpstreamHosts:[new URL(B.DESTINATIONS['crm-read']).hostname,new URL(B.DESTINATIONS.campaigns).hostname,audienceHost],dynamicRouteManifest:manifest};}
function env(f){const s=settings(f);return{DASHBOARD_MODE:s.mode,DASHBOARD_UPSTREAM_PROFILE:s.upstreamProfile,DASHBOARD_MANAGER_HOST:s.managerHost,DASHBOARD_AREA_HOSTS:JSON.stringify(s.areaHosts),DASHBOARD_EMAIL_DOMAINS:JSON.stringify(s.allowedEmailDomains),DASHBOARD_UPSTREAMS:JSON.stringify(s.upstreams),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(s.allowedUpstreamHosts),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify(manifest),DASHBOARD_CRM_MANAGED_READ:'enabled',DASHBOARD_CRM_MANAGED_READ_UI:'enabled',DASHBOARD_CRM_MANAGED_AUDIENCE_READ:'enabled',DASHBOARD_CRM_MANAGER_ISSUER_ID:s.crmManagedRead.issuerId,DASHBOARD_CRM_MANAGER_NAMESPACE_ID:s.crmManagedRead.namespaceId,DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN:'R'.repeat(43),DASHBOARD_CRM_MANAGED_WRITER:'enabled',DASHBOARD_CRM_WRITER_DESCRIPTOR:JSON.stringify(f.config.crmManagedWriter),DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN:'S'.repeat(43),DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_ADMIN_EMAIL:s.bootstrapAdminEmail,DASHBOARD_BOOTSTRAP_SHA256:s.bootstrapTokenSha256,DASHBOARD_ENCRYPTION_KEY:s.encryptionKey.toString('hex')};}
function app(t,f,fetchImpl,extra={}){const server=S.createServer({...settings(f),...extra},{auth:f.auth,managedCrmRuntime:{kick:()=>Promise.resolve(),close:()=>Promise.resolve()},fetchImpl});t.after(()=>server.removeAllListeners());assert.equal(server.listening,false);return server;}
function request(server,ctx,url,{method='GET',body,origin=ctx.origin}={}){return new Promise(resolve=>{const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{url,method,headers:{host:ctx.host,origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf,...(body?{'content-type':'application/json'}:{})},socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();res.setHeader=()=>{};res.end=bytes=>{res.writableEnded=true;res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};server.emit('request',req,res);});}
const freshness={contract:'crm-audience-read-freshness-v1',catalog_refreshed_at:'2026-10-03T11:59:00.000Z',catalog_expires_at:'2026-10-03T12:03:00.000Z',catalog_age_seconds:60,read_at:'2026-10-03T12:00:00.000Z',current:true,stale:false,coverage:'unconfirmed',schedule_proof:false};
const lists=brand=>({brand,base_list_id:brand==='fish'?17:16,lists:[{id:brand==='fish'?17:16,brand,name:'Synthetic base',available:true}],freshness});
function response(value,url){const r=new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});Object.defineProperty(r,'url',{value:String(url)});return r;}
const read=ctx=>({...ctx,method:'GET'});

test('corporate constructors admit Audience READ with the closed WRITER descriptor; templates and generic draft remain closed',async t=>{
 const f=await fixture(t),e=env(f),s=S.settingsFromEnv(e);
 assert.equal(s.crmManagedAudienceRead,true);assert.equal(s.crmManagedWriter.mode,'corporate-read-writer-v1');app(t,f,()=>assert.fail('constructor must be inert'));
 for(const delta of [{DASHBOARD_CRM_DRAFT_WRITE:'enabled'},{DASHBOARD_CRM_AUDIENCE_DRAFT:'enabled'},{DASHBOARD_CRM_MANAGED_READ_UI:'disabled'},{DASHBOARD_CRM_WRITER_DESCRIPTOR:JSON.stringify({...f.config.crmManagedWriter,namespaceId:f.config.crmManagedRead.namespaceId})},{DASHBOARD_CRM_WRITER_DESCRIPTOR:JSON.stringify({...f.config.crmManagedWriter,url:'https://arbitrary.invalid'})},{DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(settings(f).allowedUpstreamHosts.filter(x=>x!==audienceHost))},{DASHBOARD_CRM_MANAGED_WRITER:'disabled'}])assert.throws(()=>S.settingsFromEnv({...e,...delta}));
 for(const delta of [{crmDraftWrite:true},{crmAudienceDraft:true},{crmManagedReadUi:false},{crmManagedWriter:undefined},{crmManagedWriter:{...f.config.crmManagedWriter,namespaceId:f.config.crmManagedRead.namespaceId}},{allowedUpstreamHosts:settings(f).allowedUpstreamHosts.filter(x=>x!==audienceHost)},{upstreams:{...settings(f).upstreams,'audience-read':'https://arbitrary.invalid'}}])assert.throws(()=>app(t,f,()=>assert.fail('refused constructor must be inert'),delta));
 const allowed=[...settings(f).allowedUpstreamHosts,new URL(T.DESTINATIONS['template-read']).hostname];
 assert.throws(()=>S.settingsFromEnv({...e,DASHBOARD_CRM_MANAGED_TEMPLATE_READ:'enabled',DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(allowed)}),/Managed template read backend not admitted/);
 assert.throws(()=>app(t,f,()=>assert.fail('template must remain closed'),{crmManagedTemplateRead:true,allowedUpstreamHosts:allowed}),/Managed template read backend not admitted/);
});

test('both brands use only the individual dcrm READ before and after FULL; WRITER stays distinct and audience mutations stay unavailable',async t=>{
 const f=await fixture(t),id=await f.manager(),ctx=await f.login(),calls=[];let foreign=false;
 const source={capabilities:{endpoints:{read:B.DESTINATIONS['crm-read']},segments:{read:true,save:true,count:true,operation:true},campaign_audience:{read:true,inspect:true,operation:true,validate:true,bind:true,release:true},templates:{read_content:true,list_history:true,read_contract:'crm-template-read-v1'}}};
 const readKey=f.auth.getUpstreamCredential({...read(ctx),area:'growth',edit:false,slot:'crm-panel-read'}),before=f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(id);
 const server=app(t,f,async(url,init)=>{const u=new URL(url);assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.headers.Authorization,'Bearer '+readKey);calls.push(u.href);if(u.origin+u.pathname===A.DESTINATIONS['audience-read'])return response(lists(foreign?'aristo':u.searchParams.get('brand')),url);assert.equal(u.origin+u.pathname,B.DESTINATIONS['crm-read']);return response(source,url);});
 for(const full of [false,true]){
  if(full)assert.deepEqual(await f.issue(id),{state:'ready'});
  assert.equal(f.auth.campaignWriterReady(ctx),full);
  const proof=f.auth.managedCrmReadAuthorization(read(ctx));assert.match(proof.principalId,/^dcrm-/);assert.deepEqual(proof.caps,['read_content','list_history','submission']);assert.equal(proof.slot,'crm-panel-read');
  for(const brand of ['fish','aristo']){const r=await request(server,ctx,'/api/segments?acao=publicos_listas&brand='+brand);assert.equal(r.status,200);assert.equal(r.body.brand,brand);assert.equal(r.body.freshness.schedule_proof,false);assert.equal(JSON.stringify(r).includes(readKey),false);}
 }
 const writer=f.db.prepare('SELECT * FROM campaign_writer_attestation_v1 WHERE user_id=?').get(id);assert.match(writer.principal_id,/^dcrmw-/);assert.notEqual(writer.principal_id,f.auth.managedCrmReadAuthorization(read(ctx)).principalId);assert.deepEqual(f.auth.campaignWriterAuthorization(ctx,{brand:'fish',action:'salvar'}).caps,CAPS);
 const writerKey=f.auth.getUpstreamCredential({...ctx,area:'growth',edit:true,slot:'growth-campaign'});assert.notEqual(writerKey,readKey);assert.deepEqual(f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(id),before);
 const cache=await request(server,ctx,'/api/crm-read?action=cache_growth&painel=growth');assert.equal(cache.status,200);assert.deepEqual(cache.body.capabilities.segments,{read:true,save:false,count:false,operation:false});assert.deepEqual(cache.body.capabilities.campaign_audience,{read:true,inspect:false,operation:false,validate:false,bind:false,release:false});assert.equal(Object.hasOwn(cache.body.capabilities.templates,'read_contract'),false);
 const count=calls.length;
 for(const url of ['/api/segments?acao=publicos_listas&brand=olivas','/api/segments?acao=publicos_listas&brand=fish&brand=aristo','/api/segments?acao=segmento_operacao&brand=fish&idempotency_key=synthetic-receipt','/api/segments?acao=segmento_contexto_v2&brand=fish','/api/templates?acao=listar&marca=fish'])assert.ok([403,503].includes((await request(server,ctx,url)).status));
 assert.equal((await request(server,ctx,'/api/segments',{method:'POST',body:{acao:'segmento_criar',brand:'fish'}})).status,403);assert.equal(calls.length,count);
 foreign=true;assert.equal((await request(server,ctx,'/api/segments?acao=publicos_listas&brand=fish')).status,502);assert.equal(calls.length,count+1);
});

test('combined READ refuses expiry or revocation during the response without returning data or retrying',async t=>{
 for(const kind of ['expire','revoke'])await t.test(kind,async t=>{
  const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const ctx=await f.login();let calls=0;
  const server=app(t,f,async(url)=>{calls++;if(kind==='expire')f.advance(14*86400000+1);else f.auth.revokeUser({context:f.context,userId:id});return response(lists('fish'),url);});
  const r=await request(server,ctx,'/api/segments?acao=publicos_listas&brand=fish');assert.equal(r.status,503);assert.equal(r.body.error,'AUDIENCE_READ_NOT_READY');assert.equal(Object.hasOwn(r.body,'lists'),false);assert.equal(calls,1);assert.equal(f.auth.campaignWriterReady(ctx),false);
  const next=await request(server,ctx,'/api/segments?acao=publicos_listas&brand=fish');assert.equal(next.status,401);assert.equal(calls,1);
  if(kind==='expire'){const fresh=await f.login();assert.equal((await request(server,fresh,'/api/segments?acao=publicos_listas&brand=fish')).status,503);assert.equal(calls,1);}
 });
});

test('a substituted WRITER slot cannot satisfy individual READ binding or cause a fallback request',async t=>{
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const ctx=await f.login();let calls=0;
 const server=app(t,f,async()=>{calls++;assert.fail('tampered READ must not fetch');});
 const w=f.db.prepare("SELECT encrypted_key,key_digest FROM upstream_credentials WHERE user_id=? AND slot='growth-campaign'").get(id);f.db.prepare("UPDATE upstream_credentials SET encrypted_key=?,key_digest=? WHERE user_id=? AND slot='crm-panel-read'").run(w.encrypted_key,w.key_digest,id);
 assert.equal((await request(server,ctx,'/api/segments?acao=publicos_listas&brand=fish')).status,503);assert.equal(calls,0);assert.equal(f.auth.managedCrmJournal.credentialReady(id),false);
});
