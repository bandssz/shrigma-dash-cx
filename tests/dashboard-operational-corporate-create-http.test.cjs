'use strict';
// Prepared component coverage uses synthetic FULL identities and an in-memory
// campaign provider. Production HTTP CREATE remains closed for missing template
// ownership; only receipt recovery GET is exercised through the HTTP handler.
// No socket, external fetch or production SQL is used.
const test=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {fixture,hosts,CAPS}=require('./corporate-writer-fixture.cjs');
const {createOrigin,definition}=require('./dashboard-operational-campaign-create-fixture.cjs');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs');
const Backend=require('../services/crm-campaign/server.cjs');
const campaignUrl=P.REVIEWED_DYNAMIC.routes.campaigns,readUrl=P.FIXED_DESTINATIONS['crm-read'];
const q=(key='corporate_create_attempt_01',brand='fish')=>({acao:'campanha_criar',brand,definition:definition(brand),idempotency_key:key});
const route=q=>'/auth/campaign-create?brand='+q.brand+'&idempotency_key='+q.idempotency_key;
const manifest=()=>({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:campaignUrl}});
function settings(f,on=false){return{...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':readUrl,campaigns:campaignUrl},allowedUpstreamHosts:[new URL(readUrl).hostname,new URL(campaignUrl).hostname],dynamicRouteManifest:manifest(),crmCorporateCreate:on};}
function env(f){const s=settings(f);return{DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:f.config.managerHost,DASHBOARD_AREA_HOSTS:JSON.stringify(f.config.areaHosts),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com"]',DASHBOARD_UPSTREAMS:JSON.stringify(s.upstreams),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(s.allowedUpstreamHosts),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify(manifest()),DASHBOARD_CRM_MANAGED_READ:'enabled',DASHBOARD_CRM_MANAGED_READ_UI:'enabled',DASHBOARD_CRM_MANAGER_ISSUER_ID:f.config.crmManagedRead.issuerId,DASHBOARD_CRM_MANAGER_NAMESPACE_ID:f.config.crmManagedRead.namespaceId,DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN:'R'.repeat(43),DASHBOARD_CRM_MANAGED_WRITER:'enabled',DASHBOARD_CRM_WRITER_DESCRIPTOR:JSON.stringify(f.config.crmManagedWriter),DASHBOARD_CRM_WRITER_PROVISIONER_TOKEN:'S'.repeat(43),DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_ADMIN_EMAIL:f.config.bootstrapAdminEmail};}
function request(app,ctx,path,{method='GET',body,patch={}}={}){return new Promise(resolve=>{const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))],{objectMode:false});Object.assign(req,{url:path,method,headers:{host:ctx.host,origin:ctx.origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf,...(body===undefined?{}:{'content-type':'application/json'}),...patch},socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();res.setHeader=()=>{};res.end=bytes=>{res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};app.emit('request',req,res);});}
async function setup(t,{issue=true}={}){
 const f=await fixture(t),id=await f.manager(),ctx=await f.login();if(issue)assert.deepEqual(await f.issue(id),{state:'ready'});
 const origin=createOrigin(()=>f.now),calls=[];let behavior=null;
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin+u.pathname,campaignUrl);assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Origin,undefined);
  const parsed=Backend.parse({method:options.method,headers:Object.fromEntries(Object.entries(options.headers).map(([k,v])=>[k.toLowerCase(),v])),rawHeaders:Object.entries(options.headers).flat()},u,options.method==='POST'?JSON.parse(options.body):undefined);
  const bearer=parsed.key,slot=f.db.prepare("SELECT c.user_id,c.encrypted_key,b.principal_id FROM upstream_credentials c JOIN crm_writer_auth_binding_v1 b ON c.user_id=b.user_id WHERE c.slot='growth-campaign' AND c.key_digest=?").get(f.digest(bearer));assert.ok(slot,'only the individual WRITER slot is accepted');assert.equal(f.decrypt(slot.encrypted_key),bearer);
  const reader=f.db.prepare("SELECT encrypted_key FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(slot.user_id);if(reader)assert.notEqual(f.decrypt(reader.encrypted_key),bearer);
  const payload=parsed.command;assert.equal(Object.hasOwn(payload,'k'),false);if(options.method==='POST'){assert.equal(options.headers.Authorization,undefined);assert.equal(JSON.parse(options.body).k,bearer);}else assert.equal(options.headers.Authorization,'Bearer '+bearer);
  calls.push({method:options.method,action:payload.acao,brand:payload.brand,key:payload.idempotency_key,actor:'panel:'+slot.principal_id});
  if(options.method==='POST'){const row=f.db.prepare('SELECT * FROM crm_campaign_create_v1 WHERE remote_key=?').get(payload.idempotency_key);assert.ok(row);assert.equal(f.db.isTransaction,false);assert.equal(row.phase,'uncertain');assert.match(row.input_ciphertext,/^v1\./);assert.match(row.catalog_ciphertext,/^v1\./);assert.match(row.normalized_ciphertext,/^v1\./);assert.equal(row.campaign_id,null);assert.notEqual(row.client_key,row.remote_key);assert.equal(payload.acao,'campanha_salvar');assert.equal(payload.definition.send_at,null);assert.equal(Object.hasOwn(payload,'id'),false);assert.equal(Object.hasOwn(payload,'expected_version'),false);}
  const dispatch=()=>origin.service.handle({actor:'panel:'+slot.principal_id,caps:[...CAPS]},payload);const out=behavior?await behavior({payload,options,dispatch}):await dispatch();return new Response(JSON.stringify(out.body),{status:out.status,headers:{'content-type':'application/json'}});
 };
 const make=on=>{const app=S.createServer(settings(f,on),{auth:f.auth,fetchImpl,managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});t.after(()=>app.removeAllListeners());assert.equal(app.listening,false);return app;};
 // Deliberately test the prepared journal component below the production
 // ownership admission gate. This adapter is local to this test; it does not
 // establish a backend template owner or enable an HTTP production mutation.
 const componentDescriptor=require('../services/dashboard-operational/crm-manager-runtime.cjs').corporateWriterDescriptor(f.config.crmManagedWriter,f.config.crmManagedRead,f.config.allowedEmailDomains);
 const preparedTransport=async(context,{method,command})=>{
  const scoped={...context,brand:command.brand};
  const user=f.auth.authorizeBrand({...scoped,area:'growth',edit:true},command.brand);
  const credential=f.auth.getUpstreamCredential({...scoped,slot:'growth-campaign',area:'growth',edit:true});
  assert.ok(credential,'component transport requires the individual WRITER');
  const query=method==='GET'?new URLSearchParams(Object.entries(command).map(([k,v])=>[k,String(v)])):new URLSearchParams();
  return P.forward({route:'campaigns',method,query,body:method==='POST'?command:undefined,user,credential,
   upstreams:{campaigns:new URL(campaignUrl)},origin:context.origin,crmCampaignSubmitWrite:true,
   crmCorporateWriter:componentDescriptor,fetchImpl});
 };
 const preparedSubmit=async(command,context=ctx)=>{
  try{const body=await f.auth.campaignCreateFor(preparedTransport).submit(context,command);
   return{status:body.state==='pending'?202:body.state==='rejected'?409:200,body};
  }catch(e){if(!Number.isInteger(e.status)||typeof e.code!=='string')throw e;return{status:e.status,body:{error:e.code}};}
 };
 const member=async(email,brand)=>{
  const invited=f.invite(email,'growth',brand);await f.accept(invited);f.promoteRead(invited.userId);
  assert.deepEqual(await f.issue(invited.userId),{state:'ready'});
  const context=await f.login(email);const user=f.auth.authorizeBrand({...context,area:'growth'},brand);
  assert.equal(user.brand,brand);assert.deepEqual(user.brands,[brand]);
  return{id:invited.userId,ctx:context};
 };
 return{f,id,ctx,origin,calls,fetchImpl,make,preparedSubmit,member,setBehavior:v=>{behavior=v;},post:(app,command,context=ctx)=>request(app,context,'/auth/campaign-create',{method:'POST',body:command}),get:(app,command,context=ctx)=>request(app,context,route(command)),count:()=>f.db.prepare('SELECT count(*) n FROM crm_campaign_create_v1').get().n};
}

test('production CREATE defaults OFF; ready FULL still advertises OFF and POST503 without template ownership, journal or effects',async t=>{
 const legacy={DASHBOARD_MODE:'synthetic',DASHBOARD_MANAGER_HOST:'gerencial.synthetic.invalid',DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'}),DASHBOARD_EMAIL_DOMAINS:'["synthetic.invalid"]'};
 const legacyOff=S.settingsFromEnv(legacy);assert.equal(legacyOff.crmCorporateCreate,false);
 assert.deepEqual(S.settingsFromEnv({...legacy,DASHBOARD_CRM_CORPORATE_CREATE:'disabled'}),legacyOff);
 assert.throws(()=>S.settingsFromEnv({...legacy,DASHBOARD_CRM_CORPORATE_CREATE:'enabled'}),/Corporate campaign create gate invalid/);
 const a=await setup(t),v=env(a.f);assert.equal(S.settingsFromEnv(v).crmCorporateCreate,false);
 assert.equal(S.settingsFromEnv({...v,DASHBOARD_CRM_CORPORATE_CREATE:'enabled'}).crmCorporateCreate,true);
 for(const bad of ['true','on','false','ENABLED'])assert.throws(()=>S.settingsFromEnv({...v,DASHBOARD_CRM_CORPORATE_CREATE:bad}));
 assert.throws(()=>S.settingsFromEnv({...v,DASHBOARD_CRM_MANAGED_WRITER:'disabled',DASHBOARD_CRM_CORPORATE_CREATE:'enabled'}));
 assert.throws(()=>S.createServer({...settings(a.f,true),crmCorporateCreate:'enabled'},{auth:a.f.auth}));
 assert.throws(()=>S.createServer({...settings(a.f,true),crmManagedWriter:undefined},{auth:a.f.auth}));
 const off=a.make(false),on=a.make(true);
 assert.equal((await a.post(off,q())).status,403);
 const denied=await a.post(on,q());assert.equal(denied.status,503);assert.equal(denied.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');
 assert.equal(a.count(),0);assert.equal(a.calls.length,0);assert.equal(a.origin.effects.create,0);assert.equal(a.origin.effects.schedule,0);
 for(const app of [off,on]){
  const session=await request(app,a.ctx,'/auth/session');
  assert.equal(session.body.features.campaignSubmitWrite,false);assert.equal(session.body.features.campaignCreate,false);
  assert.equal(session.body.features.campaignTemplateOwnershipUnavailable,true);
 }
});

test('prepared CREATE component commits encrypted intent before its only synthetic POST; two real brand identities bind receipts without scheduling',async t=>{
 const a=await setup(t),app=a.make(true),master=a.f.masterBaseline();
 const aristo=await a.member('aristo@oaristocrata.com','aristo');
 const members=[{id:a.id,ctx:a.ctx,brand:'fish',key:'corporate_fish_create_01'},{...aristo,brand:'aristo',key:'corporate_aristo_create_01'}];
 const readers=new Map(members.map(m=>[m.id,a.f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(m.id)]));
 for(const member of members){
  const command=q(member.key,member.brand),before=a.calls.length;
  const closed=await a.post(app,command,member.ctx);assert.equal(closed.status,503);assert.equal(closed.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');
  assert.equal(a.calls.length,before);assert.equal(a.count(),members.indexOf(member));
  const reply=await a.preparedSubmit(command,member.ctx);
  assert.equal(reply.status,200);assert.equal(reply.body.state,'succeeded');assert.equal(reply.body.campaign.status,'draft');
  assert.equal(reply.body.campaign.sendAt,null);assert.equal(reply.body.campaign.sent,0);
  const saved=a.f.db.prepare('SELECT * FROM crm_campaign_create_v1 WHERE user_id=? AND client_key=?').get(member.id,member.key);
  assert.equal(saved.phase,'succeeded');assert.equal(saved.campaign_id,reply.body.campaign.id);
  assert.equal(JSON.stringify(reply).includes(saved.remote_key),false);assert.equal(JSON.stringify(reply).includes('Synthetic HTML canary'),false);
  const recovered=await a.get(app,command,member.ctx);assert.equal(recovered.status,200);assert.equal(recovered.body.campaign.id,reply.body.campaign.id);
 }
 assert.notEqual(members[0].id,members[1].id);
 const before=a.calls.length,foreign=await a.get(app,q(members[1].key,'aristo'),a.ctx);
 assert.equal(foreign.status,403);assert.equal(foreign.body.error,'BRAND_DENIED');assert.equal(a.calls.length,before);
 assert.equal(a.origin.effects.create,2);assert.equal(a.origin.effects.schedule,0);assert.equal(a.calls.filter(v=>v.method==='POST').length,2);
 assert.deepEqual(a.f.masterBaseline(),master);
 for(const member of members)assert.deepEqual(a.f.db.prepare("SELECT * FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(member.id),readers.get(member.id));
 assert.equal(a.f.events.filter(v=>v==='FULL_ATTEST').length,2);
 assert.notEqual(a.calls.find(v=>v.method==='POST'&&v.brand==='fish').actor,a.calls.find(v=>v.method==='POST'&&v.brand==='aristo').actor);
});

test('prepared component lost ACK restarts through real HTTP GET with the same actor, brand and remote key; OFF never repeats POST',async t=>{
 const a=await setup(t),command=q(),on=a.make(true);
 a.setBehavior(async({options,dispatch})=>{const r=await dispatch();if(options.method==='POST')throw Error('SYNTHETIC_LOST_ACK');return r;});
 assert.equal((await a.preparedSubmit(command)).status,202);
 const prior=a.f.db.prepare('SELECT * FROM crm_campaign_create_v1').get();assert.equal(prior.phase,'uncertain');assert.equal(prior.campaign_id,null);assert.equal(a.origin.effects.create,1);
 a.f.restart();a.setBehavior(null);const off=a.make(false),out=await a.get(off,command);
 assert.equal(out.status,200);assert.equal(out.body.campaign.id,1001);assert.equal((await a.post(off,command)).status,403);
 const closed=await a.post(a.make(true),command);assert.equal(closed.status,503);assert.equal(closed.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');
 assert.equal(a.calls.filter(v=>v.method==='POST').length,1);
 assert.equal(a.calls.filter(v=>v.action==='campanha_operacao').every(v=>v.key===prior.remote_key&&v.actor===a.calls[0].actor&&v.brand===prior.brand),true);
 assert.equal(a.f.db.prepare('SELECT remote_key FROM crm_campaign_create_v1').get().remote_key,prior.remote_key);
});

test('prepared component lost request/repeated HTTP404 keeps pending, blocks new key/UPDATE and isolates separate actor and brand identities',async t=>{
 const a=await setup(t),command=q(),app=a.make(true);
 const other=await a.member('other@oaristocrata.com','fish'),aristo=await a.member('other-aristo@oaristocrata.com','aristo');
 a.setBehavior(({options,dispatch})=>options.method==='POST'?Promise.reject(Error('SYNTHETIC_LOST_REQUEST')):dispatch());
 assert.equal((await a.preparedSubmit(command)).status,202);
 const prior=a.f.db.prepare('SELECT * FROM crm_campaign_create_v1').get();a.f.restart();a.setBehavior(null);const re=a.make(true);
 for(let i=0;i<2;i++)assert.equal((await a.get(re,command)).status,202);
 assert.equal((await a.preparedSubmit(command)).status,202);
 assert.equal((await a.preparedSubmit(q('corporate_next_attempt_02'))).status,409);
 assert.equal(a.calls.filter(v=>v.method==='POST').length,1);assert.equal(a.origin.effects.create,0);
 assert.equal(a.f.db.prepare('SELECT phase,remote_key FROM crm_campaign_create_v1').get().remote_key,prior.remote_key);
 const changed=q();changed.definition.subject='Changed payload';assert.equal((await a.preparedSubmit(changed)).status,409);
 const before=a.calls.length,foreign=await a.get(re,{...command,brand:'aristo'});
 assert.equal(foreign.status,403);assert.equal(foreign.body.error,'BRAND_DENIED');assert.equal(a.calls.length,before);
 assert.equal((await a.get(re,command,other.ctx)).status,404);
 assert.equal((await a.preparedSubmit(command,other.ctx)).status,200);
 assert.equal((await a.preparedSubmit(q('corporate_aristo_attempt_02','aristo'),aristo.ctx)).status,200);
 assert.equal(a.origin.effects.create,2);assert.equal(a.origin.effects.schedule,0);
 assert.throws(()=>a.f.auth.campaignWriterAuthorization(a.ctx,{brand:'fish',action:'salvar'}),e=>e.code==='CAMPAIGN_CREATE_PENDING');
 const closed=await a.post(re,q('corporate_next_attempt_03'));assert.equal(closed.status,503);assert.equal(closed.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');
 assert.equal(a.calls.filter(v=>v.method==='POST').length,3);
});

test('prepared component READ/unpromoted/tampered FULL and malformed inputs reject; real HTTP master/Origin/CSRF fail with no effect or fallback',async t=>{
 const a=await setup(t,{issue:false}),app=a.make(true);
 assert.equal((await request(app,a.ctx,'/auth/session')).body.features.campaignCreate,false);
 assert.equal((await a.post(app,q())).status,403);assert.equal((await a.preparedSubmit(q())).status,403);
 a.f.approval(a.id);assert.equal((await a.preparedSubmit(q())).status,403);assert.equal(a.calls.length,0);
 assert.deepEqual(await a.f.coordinator.run(a.f.operation(a.id)),{state:'ready'});
 for(const ctx of [a.f.context,{...a.ctx,csrf:'forged'},{...a.ctx,origin:'https://foreign.shrigma.com.br'},{...a.ctx,host:hosts.organico}])assert.ok([401,403].includes((await a.post(app,q(),ctx)).status));
 for(const bad of [{...q(),id:167},{...q(),expected_version:'a'.repeat(32)},{...q(),k:'synthetic-shared-key'},{...q(),definition:{...definition(),send_at:new Date(a.f.now+3600000).toISOString()}}]){
  assert.equal((await a.preparedSubmit(bad)).status,400);
  const closed=await a.post(app,bad);assert.equal(closed.status,503);assert.equal(closed.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');
 }
 assert.equal(a.calls.length,0);assert.equal(a.count(),0);assert.equal(a.origin.effects.create,0);
 a.f.db.prepare("UPDATE crm_writer_bridge_op_v1 SET committed_mac=? WHERE kind='issue'").run('f'.repeat(64));
 assert.equal((await request(app,a.ctx,'/auth/session')).body.features.campaignCreate,false);
 assert.equal((await a.preparedSubmit(q())).status,403);assert.equal(a.calls.length,0);assert.equal(a.count(),0);
 const tampered=await a.post(app,q());assert.equal(tampered.status,503);assert.equal(tampered.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');
});

test('prepared component READ loss suppresses effect ACK; real HTTP GET recovers with unrotated WRITER and new CREATE stays closed',async t=>{
 const a=await setup(t),app=a.make(true),command=q();
 a.setBehavior(async({options,dispatch})=>{const r=await dispatch();if(options.method==='POST')a.f.db.prepare("DELETE FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").run(a.id);return r;});
 assert.equal((await a.preparedSubmit(command)).status,403);assert.equal(a.origin.effects.create,1);
 assert.equal(a.f.db.prepare('SELECT phase FROM crm_campaign_create_v1').get().phase,'uncertain');a.setBehavior(null);
 assert.equal((await a.get(app,command)).status,200);
 assert.equal((await a.preparedSubmit(q('corporate_readlost_new_02'))).status,403);
 const closed=await a.post(app,q('corporate_readlost_new_02'));assert.equal(closed.status,503);assert.equal(closed.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');
 assert.equal(a.calls.filter(v=>v.method==='POST').length,1);assert.equal(a.f.auth.managedCampaignWriterJournal.pending().length,0);
});

test('prepared component disable/expiry preserve intent evidence; HTTP receipt and further transport denied without TTL release or credential reuse',async t=>{
 for(const mode of ['disable','expiry']){
  const a=await setup(t),app=a.make(true);
  a.setBehavior(({options,dispatch})=>options.method==='POST'?Promise.reject(Error('SYNTHETIC_UNKNOWN')):dispatch());
  assert.equal((await a.preparedSubmit(q())).status,202);
  const prior=a.f.db.prepare('SELECT * FROM crm_campaign_create_v1').get(),calls=a.calls.length;
  if(mode==='disable')a.f.auth.revokeUser({context:a.f.context,userId:a.id});else{a.f.advance(1209600001);a.ctx=await a.f.login();}
  assert.ok([401,403].includes((await a.get(app,q(),a.ctx)).status));
  assert.equal((await a.preparedSubmit(q('corporate_expired_next_02'),a.ctx)).status,403);
  const denied=await a.post(app,q('corporate_expired_next_02'),a.ctx);
  if(mode==='disable')assert.equal(denied.status,401);else{assert.equal(denied.status,503);assert.equal(denied.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');}
  assert.equal(a.calls.length,calls);assert.deepEqual(a.f.db.prepare('SELECT * FROM crm_campaign_create_v1').get(),prior);assert.equal(a.origin.effects.create,0);
 }
});
