'use strict';
// Actual in-process HTTP request handler, pinned proxy and Response body parsing.
// Identity and transport are injected, so no secrets, TCP, database or sends.
const test=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const S=require('../services/dashboard-operational/server.cjs');
const P=require('../services/dashboard-operational/proxy.cjs');
// Construction is allowed for emitting HTTP requests in process. Every path
// capable of opening a socket, connecting PG or starting a child is refused.
const denyTransport=()=>{throw Error('BRAND_BFF_TEST_TRANSPORT_REFUSED');};
for(const name of ['node:net','node:tls','node:http','node:https','node:dgram']){
 const m=require(name);for(const key of ['connect','createConnection','request','get','createSocket'])if(typeof m[key]==='function')m[key]=denyTransport;
 if(m.Socket?.prototype)m.Socket.prototype.connect=denyTransport;
 if(m.Server?.prototype)m.Server.prototype.listen=denyTransport;
}
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[key]=denyTransport;
globalThis.fetch=denyTransport;

const hosts={manager:'gerencial.shrigma.com.br',growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'};
function identity(role='manager',brand='fish',area='growth'){
 const user={id:role==='superadmin'?'synthetic-master':'synthetic-'+brand,role,email:role==='superadmin'?'master@synthetic.invalid':'manager@synthetic.invalid',areas:role==='superadmin'?['growth','organico','influs']:[area],brand:role==='superadmin'?null:brand,brands:role==='superadmin'?['fish','aristo']:[brand],brandAccess:role==='superadmin'?'all':'single'},calls={credential:[],brand:[],journal:0};let valid=true;
 const auth={
  authorize(ctx){if(!valid)throw Object.assign(Error('SESSION_DENIED'),{status:401,code:'SESSION_DENIED'});if(ctx.admin&&role!=='superadmin'||ctx.area&&!user.areas.includes(ctx.area))throw Object.assign(Error('AREA_DENIED'),{status:403,code:'AREA_DENIED'});return user;},
  authorizeBrand(ctx,b){const found=this.authorize(ctx);calls.brand.push({brand:b,context:ctx});if(!['fish','aristo'].includes(b))throw Object.assign(Error('BRAND_REQUIRED'),{status:400,code:'BRAND_REQUIRED'});if(role!=='superadmin'&&b!==brand)throw Object.assign(Error('BRAND_DENIED'),{status:403,code:'BRAND_DENIED'});return found;},
  getUpstreamCredential(ctx){calls.credential.push(ctx);this.authorize(ctx);if(role==='manager')assert.equal(ctx.brand,brand);return 'a'.repeat(64);},
  campaignDraft(){calls.journal++;return null;},audienceDraft(){calls.journal++;return null;},
  createInvite(q){calls.invite=q;return{host:hosts.growth,userId:'synthetic-new-user',token:'synthetic-invite-token'};},
  session(){return{authenticated:true,user};}
 };
 return{auth,user,calls,revoke(){valid=false;}};
}
function settings(upstreams={'crm-read':P.FIXED_DESTINATIONS['crm-read']},extra={}){
 const dynamic=Object.fromEntries(Object.entries(upstreams).filter(([route])=>Object.hasOwn(P.REVIEWED_DYNAMIC.routes,route)));
 return{mode:'operational',upstreamProfile:'production',managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['synthetic.invalid'],upstreams,allowedUpstreamHosts:[...new Set(Object.values(upstreams).map(s=>new URL(s).hostname))],...(Object.keys(dynamic).length?{dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:dynamic}}:{}),...extra};
}
function app(t,i,fetchImpl,config=settings()){const server=S.createServer(config,{auth:i.auth,fetchImpl});t.after(()=>server.removeAllListeners());assert.equal(server.listening,false);return server;}
function request(server,pathname,{host=hosts.growth,method='GET',body}={}){return new Promise(resolve=>{const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{url:pathname,method,headers:{host,origin:'https://'+host,cookie:'synthetic=session','x-csrf-token':'synthetic-csrf',...(body?{'content-type':'application/json'}:{})},socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();res.setHeader=()=>{};res.end=bytes=>{res.writableFinished=true;res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};server.emit('request',req,res);});}
const response=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
const cachePath='/api/crm-read?action=cache_growth&painel=growth';
const data={gerado_em:'2026-10-04T05:00:00.000Z',_painel:'todos',_escopo:'todos',label:'foreign label must disappear',global_total:999,crm_credencial:[{marca:'aristo',chave:'foreign-key-label'}],crm_operacao:{templates:[{brand:'aristo',body:'FOREIGN-OPERACAO'}]},crm_diario:[{marca:'fish',enviados:12,dia:'2026-10-04',nested:{brand:'aristo',private:'FOREIGN-NESTED'}},{marca:'aristo',enviados:99,private:'FOREIGN-ROW'},{marca:'olivas',enviados:1}],crm_campanha:[{marca:'fishermans',campanha_id:7},{marca:'aristocrata',campanha_id:8}],crm_attribution:{schema_version:2,window_days:30,default_model:'last_click',money_basis:'net_payment_brl',generated_at:'2026-10-04T05:00:00.000Z',unsafe_note:'FOREIGN-ATTRIBUTION',global_total:111,daily:[{brand:'fish',receita:100},{brand:'aristo',receita:999}],dispatch_evidence:{schema_version:1,basis:'utm_and_chronology',daily:[{brand:'fish',enviados:12},{brand:'aristo',enviados:99}]},pix_charge:{schema_version:1,basis:'original_emv_appmax_event',daily:[{marca:'fish',pedidos_com_cobranca_registrada:3},{marca:'aristo',pedidos_com_cobranca_registrada:9}]}},capabilities:{endpoints:{read:P.FIXED_DESTINATIONS['crm-read'],leak:'https://foreign.invalid/aristo'},segments:{read:true,save:true,private:'FOREIGN-CAP'},templates:{read_contract:'crm-template-read-v1',read_content:true},global_count:88,note:'FOREIGN-CAP'}};

test('single-brand cache is projected on the server and cannot include aggregates, other rows or nested data',async t=>{
 const i=identity();let calls=0;
 const server=app(t,i,async(url)=>{calls++;assert.equal(new URL(url).searchParams.has('brand'),false);return response(data);});
 const r=await request(server,cachePath);assert.equal(r.status,200);assert.equal(calls,1);assert.equal(i.calls.credential[0].brand,'fish');
 assert.deepEqual(r.body.crm_diario,[{marca:'fish',enviados:12,dia:'2026-10-04'}]);assert.deepEqual(r.body.crm_campanha,[{marca:'fish',campanha_id:7}]);assert.deepEqual(r.body.crm_attribution.daily,[{brand:'fish',receita:100}]);assert.deepEqual(r.body.crm_attribution.dispatch_evidence.daily,[{brand:'fish',enviados:12}]);assert.deepEqual(r.body.crm_attribution.pix_charge.daily,[{marca:'fish',pedidos_com_cobranca_registrada:3}]);
 assert.equal(r.body.brand,'fish');assert.deepEqual(r.body.brands,['fish']);assert.equal(r.body._painel,'growth');assert.equal(r.body._escopo,'growth');assert.deepEqual(r.body.crm_credencial,[]);assert.equal(r.body.gerado_em,data.gerado_em);
 for(const key of ['label','global_total','crm_operacao'])assert.equal(Object.hasOwn(r.body,key),false);
 assert.equal(JSON.stringify(r.body).includes('FOREIGN'),false);assert.equal(JSON.stringify(r.body).includes('aristo'),false);assert.equal(r.body.capabilities.segments.save,false);assert.equal(Object.hasOwn(r.body.capabilities.templates,'read_contract'),false);
});

test('unmarked, contradictory or unsupported cache data is refused instead of returned as a single-brand aggregate',async t=>{
 for(const [body,status]of [[{crm_diario:[{enviados:3}]},502],[{crm_diario:[{marca:'fish',brand:'aristo'}]},502],[{crm_diario:{}},502],[{crm_operacao:{total:123},capabilities:{read:true}},503]]){
  const server=app(t,identity(),async()=>response(body)),r=await request(server,cachePath);assert.equal(r.status,status);assert.equal(Object.hasOwn(r.body,'crm_diario'),false);
 }
});

test('master keeps both brands and all its existing aggregate data',async t=>{
 const i=identity('superadmin');const server=app(t,i,async()=>response(data));const r=await request(server,cachePath,{host:hosts.manager});assert.equal(r.status,200);assert.deepEqual(r.body.crm_diario,data.crm_diario);assert.deepEqual(r.body.crm_operacao,data.crm_operacao);assert.equal(i.calls.credential[0].brand,undefined);
});

test('direct campaign, media and audience queries deny a foreign brand before selecting a credential or transport',async t=>{
 const i=identity(),upstreams={'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,campaigns_media:P.REVIEWED_DYNAMIC.routes.campaigns_media,segments:P.REVIEWED_DYNAMIC.routes.segments};let calls=0;
 const server=app(t,i,async()=>{calls++;assert.fail('foreign brand must not fetch');},settings(upstreams));
 for(const url of ['/api/campaigns?acao=campanha_catalogo&brand=aristo','/api/campaigns?acao=campanha_listar&brand=aristo','/api/campaigns?acao=campanha_obter&brand=aristo&id=167','/api/campaigns_media?brand=aristo','/api/segments?acao=segmentos_listar&brand=aristo&offset=0&limit=20','/api/segments?acao=segmento_obter&brand=aristo&id=12345678-1234-4234-8234-123456789abc'])assert.equal((await request(server,url)).status,403);
 assert.equal(calls,0);assert.equal(i.calls.credential.length,0);
});

test('a same-brand URL cannot return a campaign or catalog containing the other brand',async t=>{
 for(const [url,body]of [['/api/campaigns?acao=campanha_obter&brand=fish&id=167',{campaign:{id:167,definition:{brand:'aristo'}}}],['/api/campaigns?acao=campanha_listar&brand=fish',{campaigns:[{id:167,definition:{brand:'fish'}},{id:168,definition:{brand:'aristo'}}]}],['/api/campaigns?acao=campanha_catalogo&brand=fish',{brand:'fish',lists:[{id:17,brand:'fish'}],templates:[{id:9,brand:'aristo',body:'FOREIGN'}],initiatives:[]}]]){
  let calls=0;const server=app(t,identity(),async()=>{calls++;return response(body);},settings({campaigns:P.REVIEWED_DYNAMIC.routes.campaigns}));const r=await request(server,url);assert.equal(r.status,url.includes('campanha_catalogo')?503:502);assert.equal(calls,1);assert.equal(JSON.stringify(r.body).includes('FOREIGN'),false);
 }
});

test('same-brand campaign read retains the reviewed catalog and draft contract',async t=>{
 const i=identity(),body={campaign:{id:167,status:'draft',definition:{brand:'fish',list_ids:[150,152]}}};const server=app(t,i,async()=>response(body),settings({campaigns:P.REVIEWED_DYNAMIC.routes.campaigns}));const r=await request(server,'/api/campaigns?acao=campanha_obter&brand=fish&id=167');assert.equal(r.status,200);assert.deepEqual(r.body,body);assert.equal(i.calls.credential[0].brand,'fish');
});

test('revocation during cache fetch discards the result without a retry or fallback credential',async t=>{
 const i=identity();let calls=0;const server=app(t,i,async()=>{calls++;i.revoke();return response(data);});const r=await request(server,cachePath);assert.equal(r.status,401);assert.equal(Object.hasOwn(r.body,'crm_diario'),false);assert.equal(calls,1);assert.equal(i.calls.credential.length,1);
});

test('unreviewed Organic and Influencer contracts deny single-brand production reads before any credential or fetch',async t=>{
 for(const [area,url,requestOptions]of [['organico','/api/cx?painel=organico',{host:hosts.organico}],['influs','/api/influ',{host:hosts.influs,method:'POST',body:{acao:'listar',ini:'2026-10-01',fim:'2026-10-04',marca:'fish'}}]]){
  const i=identity('manager','fish',area);let calls=0;const server=app(t,i,async()=>{calls++;assert.fail('unreviewed area must not fetch');},settings({cx:P.FIXED_DESTINATIONS.cx,influ:P.FIXED_DESTINATIONS.influ}));const r=await request(server,url,requestOptions);assert.equal(r.status,503);assert.equal(r.body.error,'BRAND_READ_CONTRACT_NOT_READY');assert.equal(calls,0);assert.equal(i.calls.credential.length,0);
 }
});

test('unreviewed template paths never use a scoped user credential, and foreign marca is rejected first',async t=>{
 const i=identity();const server=app(t,i,()=>assert.fail('template must not fetch'));
 assert.equal((await request(server,'/api/templates?acao=listar&marca=aristo')).status,403);
 const r=await request(server,'/api/templates?acao=listar&marca=fish');assert.equal(r.status,503);assert.equal(r.body.error,'BRAND_READ_CONTRACT_NOT_READY');assert.equal(i.calls.credential.length,0);
});

test('auth draft journal routes reject a foreign brand before reading a journal',async t=>{
 const i=identity();const server=app(t,i,()=>assert.fail('journal must not fetch'),settings({campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments},{crmDraftWrite:true,crmAudienceDraft:true}));
 for(const url of ['/auth/campaign-draft?brand=aristo','/auth/audience-draft?brand=aristo'])assert.equal((await request(server,url)).status,403);
 assert.equal(i.calls.journal,0);
});

test('identity advertises the server grant and invite passes the required brand to identity creation',async t=>{
 const i=identity();const server=app(t,i,()=>assert.fail('identity must not fetch'));const r=await request(server,'/api/crm-read?action=identity&painel=growth');assert.equal(r.status,200);assert.equal(r.body.brand,'fish');assert.deepEqual(r.body.brands,['fish']);assert.equal(r.body.brandAccess,'single');
 const m=identity('superadmin'),master=app(t,m,()=>assert.fail('invite must not fetch'));const invited=await request(master,'/auth/users',{host:hosts.manager,method:'POST',body:{action:'invite',email:'new@synthetic.invalid',role:'manager',areas:['growth'],brand:'aristo',requestedAccess:'read'}});assert.equal(invited.status,201);assert.equal(m.calls.invite.brand,'aristo');
});

async function realIdentity(t){
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{createAuth}=require('../services/dashboard-operational/auth.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brand-bff-identity-')),email='master@synthetic.invalid',password='Synthetic only password 2026!',bootstrap='synthetic-bootstrap';
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:email,bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32)});
 t.after(()=>{auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 await auth.completeBootstrap({email,token:bootstrap,password,host:hosts.manager,origin:'https://'+hosts.manager});
 const master=await auth.login({email,password,host:hosts.manager,origin:'https://'+hosts.manager}),context={host:hosts.manager,method:'POST',cookieHeader:master.cookie.split(';')[0],csrf:master.csrf,origin:'https://'+hosts.manager};
 const members={};
 for(const brand of ['fish','aristo']){
  const email=brand+'@synthetic.invalid',invite=auth.createInvite({context,email,areas:['growth'],brand,requestedAccess:'read'});
  await auth.acceptInvite({token:invite.token,password,host:invite.host,origin:'https://'+invite.host});
  const login=await auth.login({email,password,host:hosts.growth,origin:'https://'+hosts.growth});
  members[brand]={id:invite.userId,cookie:login.cookie.split(';')[0],csrf:login.csrf};
  auth.setUpstreamCredential({context,userId:invite.userId,slot:'growth-read',bearer:'synthetic-read-'+brand});
  auth.setUpstreamCredential({context,userId:invite.userId,slot:'growth-campaign-read',bearer:'synthetic-campaign-'+brand});
 }
 return{auth,context,members};
}
function realRequest(server,member,url){return new Promise(resolve=>{const req=Readable.from([]);Object.assign(req,{url,method:'GET',headers:{host:hosts.growth,origin:'https://'+hosts.growth,cookie:member.cookie,'x-csrf-token':member.csrf},socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();res.setHeader=()=>{};res.end=bytes=>{res.writableFinished=true;res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};server.emit('request',req,res);});}

test('actual corporate identities and encrypted credentials isolate both brands at the HTTP boundary',async t=>{
 const f=await realIdentity(t),fetches=[],server=S.createServer(settings({cx:P.FIXED_DESTINATIONS.cx,campaigns:P.REVIEWED_DYNAMIC.routes.campaigns}),{auth:f.auth,fetchImpl:async(url,init)=>{fetches.push({url:String(url),authorization:init.headers.Authorization});return response(data);}});t.after(()=>server.removeAllListeners());
 for(const brand of ['fish','aristo']){
  const r=await realRequest(server,f.members[brand],'/api/cx?painel=growth');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.brand,brand);assert.ok(r.body.crm_diario.every(row=>row.marca===brand));assert.equal(fetches.at(-1).authorization,'Bearer synthetic-read-'+brand);
  const before=fetches.length,other=brand==='fish'?'aristo':'fish';assert.equal((await realRequest(server,f.members[brand],'/api/campaigns?acao=campanha_obter&brand='+other+'&id=167')).status,403);assert.equal(fetches.length,before);
 }
});

test('actual brand grant cannot be widened by forged UI selection, query duplicates or payload fields',async t=>{
 const f=await realIdentity(t);let fetches=0;const server=S.createServer(settings({cx:P.FIXED_DESTINATIONS.cx,campaigns:P.REVIEWED_DYNAMIC.routes.campaigns}),{auth:f.auth,fetchImpl:async()=>{fetches++;assert.fail('forged input must not fetch');}});t.after(()=>server.removeAllListeners());
 for(const url of ['/api/campaigns?acao=campanha_listar&brand=aristo','/api/campaigns?acao=campanha_listar&brand=fish&brand=aristo','/api/cx?painel=growth&brand=aristo','/api/cx?painel=organico'])assert.equal((await realRequest(server,f.members.fish,url)).status,403);
 assert.equal(fetches,0);
});

test('actual revoked identity cannot return a body fetched before revocation',async t=>{
 const f=await realIdentity(t);let fetches=0;const server=S.createServer(settings({cx:P.FIXED_DESTINATIONS.cx}),{auth:f.auth,fetchImpl:async()=>{fetches++;f.auth.revokeUser({context:f.context,userId:f.members.fish.id});return response(data);}});t.after(()=>server.removeAllListeners());
 const r=await realRequest(server,f.members.fish,'/api/cx?painel=growth');assert.equal(r.status,401);assert.equal(Object.hasOwn(r.body,'crm_diario'),false);assert.equal(fetches,1);assert.equal((await realRequest(server,f.members.fish,'/api/cx?painel=growth')).status,401);assert.equal(fetches,1);
});

function managedRequest(server,ctx,url,{method='GET',body}={}){return new Promise(resolve=>{const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{url,method,headers:{host:ctx.host,origin:ctx.origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf,...(body?{'content-type':'application/json'}:{})},socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();res.setHeader=()=>{};res.end=bytes=>{res.writableFinished=true;res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};server.emit('request',req,res);});}

test('managed READ carries the actual single-brand identity through the existing frozen bridge binding',async t=>{
 const {fixture}=require('./corporate-writer-fixture.cjs'),B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs');
 const f=await fixture(t);await f.manager();const ctx=await f.login();let calls=0;
 const config={...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':B.DESTINATIONS['crm-read'],campaigns:B.DESTINATIONS.campaigns},allowedUpstreamHosts:[new URL(B.DESTINATIONS['crm-read']).hostname,new URL(B.DESTINATIONS.campaigns).hostname],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns}}};
 const body={brand:'fish',lists:[{brand:'fish',id:17}],templates:[],initiatives:[]};
 const server=S.createServer(config,{auth:f.auth,managedCrmRuntime:{kick:()=>Promise.resolve(),close:()=>Promise.resolve()},fetchImpl:async(url,init)=>{calls++;assert.equal(init.headers.Authorization,'Bearer '+f.auth.getUpstreamCredential({...ctx,method:'GET',area:'growth',slot:'crm-panel-read',brand:'fish'}));return response(body);}});t.after(()=>server.removeAllListeners());
 const accepted=await managedRequest(server,ctx,'/api/campaigns?acao=campanha_catalogo&brand=fish');assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.brand,'fish');assert.equal(calls,1);
 const refused=await managedRequest(server,ctx,'/api/campaigns?acao=campanha_catalogo&brand=aristo');assert.equal(refused.status,403);assert.equal(calls,1);
});

test('FULL individual WRITER cannot validate or schedule a campaign of another brand',async t=>{
 const {fixture}=require('./corporate-writer-fixture.cjs'),B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs');
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const ctx=await f.login();let calls=0;
 const config={...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':B.DESTINATIONS['crm-read'],campaigns:B.DESTINATIONS.campaigns},allowedUpstreamHosts:[new URL(B.DESTINATIONS['crm-read']).hostname,new URL(B.DESTINATIONS.campaigns).hostname],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns}}};
 const server=S.createServer(config,{auth:f.auth,managedCrmRuntime:{kick:()=>Promise.resolve(),close:()=>Promise.resolve()},fetchImpl:async()=>{calls++;assert.fail('cross-brand WRITER must not fetch');}});t.after(()=>server.removeAllListeners());
 for(const acao of ['campanha_validar','campanha_agendar']){
  const body={acao,brand:'aristo',id:167,expected_version:'a'.repeat(32),idempotency_key:'synthetic_client_key_123',...(acao==='campanha_agendar'?{confirm:'agendar',audience_review_id:'12345678-1234-4234-8234-123456789abc'}:{})};
  const r=await managedRequest(server,ctx,'/api/campaigns',{method:'POST',body});assert.equal(r.status,403,JSON.stringify(r.body));
 }
 assert.equal(calls,0);
});

test('matching-brand rows cannot smuggle arbitrary scalar columns or other relations metrics',async t=>{
 const body={crm_diario:[{marca:'fish',enviados:12,other_brand_secret:'ARISTO-PRIVATE',aristo_revenue:9000,receita:8000}],crm_campanha:[{marca:'fish',campanha_id:7,other_brand_secret:'ARISTO-PRIVATE',aristo_revenue:9000}],crm_attribution:{schema_version:2,daily:[{marca:'fish',receita:100,other_brand_secret:'ARISTO-PRIVATE',aristo_revenue:9000,dimension:['email']}],coverage:[{brand:'fish',day:'2026-10-04',checked_at:'2026-10-04T05:00:00.000Z',execution_id:'PRIVATE-GLOBAL-ID'}]}};
 const server=app(t,identity(),async()=>response(body)),r=await request(server,cachePath);assert.equal(r.status,200);
 assert.deepEqual(r.body.crm_diario,[{marca:'fish',enviados:12}]);assert.deepEqual(r.body.crm_campanha,[{marca:'fish',campanha_id:7}]);assert.deepEqual(r.body.crm_attribution.daily,[{marca:'fish',receita:100,dimension:['email']}]);
 assert.equal(JSON.stringify(r.body).includes('PRIVATE'),false);assert.equal(JSON.stringify(r.body).includes('9000'),false);assert.equal(JSON.stringify(r.body).includes('8000'),false);assert.equal(Object.hasOwn(r.body.crm_attribution.coverage[0],'execution_id'),false);
});

test('global unmarked catalogs fail closed and an empty catalog never declares template ownership or write readiness',async t=>{
 for(const body of [{brand:'fish',lists:[{id:17,brand:'fish',name:'Owned fish list',available:true}],templates:[{id:99,name:'Aristo global template',available:true}],initiatives:[]},{brand:'fish',lists:[],templates:[],initiatives:[{key:'private-aristo',utm_campaign:'private'}]},{brand:'fish',lists:[],templates:[{id:99,brand:'fish',name:'A brand field is not an ownership attestation'}],initiatives:[]}]){
  const server=app(t,identity(),async()=>response(body),settings({campaigns:P.REVIEWED_DYNAMIC.routes.campaigns})),r=await request(server,'/api/campaigns?acao=campanha_catalogo&brand=fish');assert.equal(r.status,503);assert.equal(r.body.error,'BRAND_CATALOG_SCOPE_NOT_READY');assert.equal(Object.hasOwn(r.body,'templates'),false);assert.equal(Object.hasOwn(r.body,'initiatives'),false);
 }
 const body={brand:'fish',current:true,read_at:'2026-10-04T05:00:00.000Z',lists:[{brand:'fish',id:17,name:'Fish',available:true,other_brand_secret:'PRIVATE'}],templates:[],initiatives:[],other_brand_secret:'PRIVATE'};
 const server=app(t,identity(),async()=>response(body),settings({campaigns:P.REVIEWED_DYNAMIC.routes.campaigns})),r=await request(server,'/api/campaigns?acao=campanha_catalogo&brand=fish');assert.equal(r.status,200);assert.equal(r.body.current,false);assert.equal(r.body.template_selection_available,false);assert.equal(r.body.write,false);assert.equal(r.body.scope_status,'catalog_ownership_unavailable');assert.equal(JSON.stringify(r.body).includes('PRIVATE'),false);
});

test('campaign read only returns selected campaign and definition fields, even if the backend adds unmarked extras',async t=>{
 const body={campaign:{id:167,status:'draft',definition:{brand:'fish',list_ids:[17],other_brand_secret:'PRIVATE',initiative:{key:'owned',name:'Owned',other_brand_secret:'PRIVATE'}},other_brand_secret:'PRIVATE'},other_brand_secret:'PRIVATE',aristo_revenue:9000};
 const server=app(t,identity(),async()=>response(body),settings({campaigns:P.REVIEWED_DYNAMIC.routes.campaigns})),r=await request(server,'/api/campaigns?acao=campanha_obter&brand=fish&id=167');assert.equal(r.status,200);assert.equal(JSON.stringify(r.body).includes('PRIVATE'),false);assert.equal(JSON.stringify(r.body).includes('9000'),false);assert.deepEqual(r.body.campaign.definition.initiative,{key:'owned',name:'Owned'});
});

test('managed READ cannot bypass the catalog ownership gate or projection for marked campaign records',async t=>{
 const {fixture}=require('./corporate-writer-fixture.cjs'),B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs');
 const f=await fixture(t);await f.manager();const ctx=await f.login();let calls=0;
 const config={...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':B.DESTINATIONS['crm-read'],campaigns:B.DESTINATIONS.campaigns},allowedUpstreamHosts:[new URL(B.DESTINATIONS['crm-read']).hostname,new URL(B.DESTINATIONS.campaigns).hostname],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns}}};
 const server=S.createServer(config,{auth:f.auth,managedCrmRuntime:{kick:()=>Promise.resolve(),close:()=>Promise.resolve()},fetchImpl:async(url)=>{calls++;if(new URL(url).searchParams.get('acao')==='campanha_catalogo')return response({brand:'fish',lists:[{brand:'fish',id:17}],templates:[{id:99,name:'PRIVATE-GLOBAL'}],initiatives:[]});return response({campaign:{id:167,definition:{brand:'fish'},other_brand_secret:'PRIVATE'},other_brand_secret:'PRIVATE'});}});t.after(()=>server.removeAllListeners());
 const refused=await managedRequest(server,ctx,'/api/campaigns?acao=campanha_catalogo&brand=fish');assert.equal(refused.status,503);assert.equal(refused.body.error,'BRAND_CATALOG_SCOPE_NOT_READY');assert.equal(JSON.stringify(refused.body).includes('PRIVATE'),false);
 const allowed=await managedRequest(server,ctx,'/api/campaigns?acao=campanha_obter&brand=fish&id=167');assert.equal(allowed.status,200);assert.deepEqual(allowed.body,{campaign:{id:167,definition:{brand:'fish'}}});assert.equal(calls,2);
});

test('same-brand FULL WRITER stays unavailable for save, validation, scheduling and CREATE until template ownership is established',async t=>{
 const {fixture}=require('./corporate-writer-fixture.cjs'),B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs');
 const f=await fixture(t),id=await f.manager();assert.deepEqual(await f.issue(id),{state:'ready'});const ctx=await f.login();let calls=0;
 const config={...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmCorporateCreate:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':B.DESTINATIONS['crm-read'],campaigns:B.DESTINATIONS.campaigns},allowedUpstreamHosts:[new URL(B.DESTINATIONS['crm-read']).hostname,new URL(B.DESTINATIONS.campaigns).hostname],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns}}};
 const server=S.createServer(config,{auth:f.auth,managedCrmRuntime:{kick:()=>Promise.resolve(),close:()=>Promise.resolve()},fetchImpl:async()=>{calls++;assert.fail('unowned template must not reach backend');}});t.after(()=>server.removeAllListeners());
 const session=await managedRequest(server,ctx,'/auth/session');assert.equal(session.status,200);assert.equal(session.body.features.campaignSubmitWrite,false);assert.equal(session.body.features.campaignCreate,false);assert.equal(session.body.features.campaignTemplateOwnershipUnavailable,true);
 for(const acao of ['campanha_salvar','campanha_validar','campanha_agendar']){
  const definition={schema_version:'crm-campaign-v1',brand:'fish',channel:'email',initiative:{key:'synthetic',name:'Synthetic'},utm_campaign:'synthetic',name:'Synthetic fish',subject:'Synthetic',from_email:'test@fishermans.com.br',reply_to:'test@fishermans.com.br',list_ids:[17],template_id:999,html:'<p>Potential foreign template</p>',text:'Synthetic',tags:[],send_at:null};
  const body={acao,brand:'fish',id:167,expected_version:'a'.repeat(32),idempotency_key:'synthetic_client_key_123',...(acao==='campanha_salvar'?{definition}:acao==='campanha_agendar'?{confirm:'agendar',audience_review_id:'12345678-1234-4234-8234-123456789abc'}:{})};
  const r=await managedRequest(server,ctx,'/api/campaigns',{method:'POST',body});assert.equal(r.status,503,JSON.stringify(r.body));assert.equal(r.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');
 }
 const created=await managedRequest(server,ctx,'/auth/campaign-create',{method:'POST',body:{brand:'fish',idempotency_key:'synthetic_client_key_123'}});assert.equal(created.status,503);assert.equal(created.body.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');assert.equal(calls,0);
});

test('cart projection preserves the real G.carrinho metrics and measured/null distinction without another brand',async t=>{
 const G=require('../growth-data.js'),day='2026-10-04';
 const own={marca:'fish',dia:day,carrinhos:10,valor_em_jogo:1000,com_consent:8,voltaram_72h:4,receita_voltaram:300,recuperados:2,receita_recuperada:200};
 const body={crm_carrinho:[{...own,other_brand_secret:'PRIVATE-ARISTO',aristo_revenue:9000},{...own,marca:'aristo',valor_em_jogo:90000}]};
 const server=app(t,identity(),async()=>response(body)),r=await request(server,cachePath);
 assert.equal(r.status,200);
 const measured=G.carrinho(r.body,'fish',day,day),original=G.carrinho({crm_carrinho:[own]},'fish',day,day);
 assert.equal(measured.valor,1000);assert.equal(measured.receita,200);assert.deepEqual(measured,original);assert.deepEqual(r.body.crm_carrinho,[own]);
 assert.equal(measured.consent,8);assert.equal(measured.voltaram,4);assert.equal(measured.receitaVoltaram,300);
 const nullRow={...own,recuperados:null,receita_recuperada:null};
 const second=app(t,identity(),async()=>response({crm_carrinho:[nullRow]})),missing=await request(second,cachePath);
 assert.equal(missing.status,200);assert.equal(G.carrinho(missing.body,'fish',day,day).recuperados,null);
 assert.equal(G.carrinho(missing.body,'fish',day,day).receita,null);assert.equal(JSON.stringify(r.body).includes('PRIVATE'),false);
});

test('unadmitted CRM relations and marker-only/incomplete measurements never become measured rows or a usable cache contract',async t=>{
 const unreviewed=['crm_ab','crm_teste','crm_testes','crm_teste_ab','crm_arvore_snapshot'];
 const extra=Object.fromEntries(unreviewed.map(key=>[key,[{marca:'fish',aristo_revenue:9000,other_brand_secret:'PRIVATE'}]]));
 const server=app(t,identity(),async()=>response({...extra,crm_diario:[{marca:'fish',enviados:12}]})),r=await request(server,cachePath);
 assert.equal(r.status,200);for(const key of unreviewed)assert.equal(Object.hasOwn(r.body,key),false,key);
 for(const body of [extra,Object.fromEntries(unreviewed.map(key=>[key,[]])),{crm_diario:[{marca:'fish'}]},{crm_carrinho:[{marca:'fish',dia:'2026-10-04',carrinhos:0}]}]){
  const closed=app(t,identity(),async()=>response(body)),out=await request(closed,cachePath);
  assert.equal(out.status,503);assert.equal(out.body.error,'BRAND_READ_CONTRACT_NOT_READY');assert.equal(Object.hasOwn(out.body,'crm_carrinho'),false);
 }
});

test('SQL attribution quality counts and closed UTM tuples survive projection so consumers retain tracking and original results',async t=>{
 const GA=require('../growth-attribution.js'),day='2026-10-04',checked='2026-10-04T05:00:00.000Z';
 const utm={source:'listmonk',medium:'campanha',campaign:'fish-copo',content:'peca',term:''};
 const own={marca:'fish',canal:'email',campanha_id:7,nome:'Fish',status:'finished',familia:'fish-copo',enviados:20,publico:20,entregues:20,abriram:4,clicaram:2,enviado_em:checked,agendado_em:null,utms:[utm],segmentos:['Fish'],tags:[]};
 const quality={marca:'fish',dia:day,pedidos_lidos:3,pagos_elegiveis:3,jornada_pendente:0,jornada_parcial:0,pagos_com_ultima_sessao:2,pagos_sem_ultima_sessao:1,pagos_sem_origem_nao_direta:1};
 const daily=[{marca:'fish',dia:day,model:'last_click',grain:'family',dimension:['fish-copo'],pedidos:3,receita:150},{marca:'fish',dia:day,model:'last_click',grain:'piece',dimension:['email','campanha','fish-copo','peca','','listmonk'],pedidos:3,receita:150}];
 const attribution={schema_version:2,generated_at:checked,quality:[quality],coverage:[{brand:'fish',day,checked_at:checked}],daily,campaigns:[own]};
 const raw={crm_attribution:{...attribution,quality:[{...quality,other_brand_secret:'PRIVATE'}],campaigns:[{...own,utms:[{...utm,other_brand_secret:'PRIVATE',aristo_revenue:9000}]},{...own,marca:'aristo',campanha_id:9}]}},server=app(t,identity(),async()=>response(raw)),r=await request(server,cachePath);
 assert.equal(r.status,200);assert.deepEqual(r.body.crm_attribution.quality,[quality]);
 assert.deepEqual(r.body.crm_attribution.campaigns[0].utms,[utm]);assert.equal(r.body.crm_attribution.campaigns.length,1);
 const cov=GA.coverage(r.body,'fish',day,day);assert.equal(cov.lastVisitKnown,2);assert.equal(cov.lastVisitMissing,1);assert.equal(cov.nonDirectMissing,1);
 const actual=GA.campaigns(r.body,'fish',day,day),expected=GA.campaigns({crm_attribution:attribution},'fish',day,day);
 assert.deepEqual(actual,expected);assert.equal(actual[0].members[0].tracked,true);assert.equal(actual[0].members[0].result.receita,150);
 assert.equal(JSON.stringify(r.body).includes('PRIVATE'),false);assert.equal(JSON.stringify(r.body).includes('9000'),false);
 for(const utms of [[{...utm,source:{secret:'PRIVATE'}}],[{source:'listmonk'}]]){
  const malformed=app(t,identity(),async()=>response({crm_attribution:{campaigns:[{...own,utms}]}})),out=await request(malformed,cachePath);
  assert.equal(out.status,502);assert.equal(out.body.error,'BRAND_RESPONSE_UNSCOPED');
 }
});

test('per-brand CRM source/health/delivery columns retain the fields the actual Growth consumers read, excluding private diagnostics',async t=>{
 const stamp='2026-10-04T05:00:00.000Z';
 const source={marca:'fish',fonte:'shopify_conversao',tipo:'coleta',status:'atrasado',cadencia_seg:86400,coletado_em:stamp};
 const account={brand:'fish',nome:'Fish transacional',estado:'alerta',verificado_em:stamp,alerta_desde:stamp};
 const flow={brand:'fish',chave:'aceite:fish:pedido-pago',nome:'Fish',estado:'alerta',verificado_em:stamp,alerta_desde:stamp,n_aceites:4,n_gatilho:5,n_saida:4};
 const delivery={marca:'fish',dia:'2026-10-04',flow:'pedido',piece:'pago',registros:5,aceitos:4,enviados_provedor:4,entregues:3,lidos:2,falhas:1,falhas_reportadas:1,erros_sincronos:0,pendentes_entrega:0,sem_disparo_confirmado:1,conflitos_status:0,ultimo_registro_em:stamp,ultimo_status_em:stamp};
 const body={crm_fontes:[{...source,erro:'PRIVATE-DIAGNOSTIC'}],wa_saude:[{...account,waba_id:'PRIVATE'}],wa_fluxo_saude:[{...flow,motivo:'PRIVATE'}],crm_wa_envios:[{...delivery,other_brand_secret:'PRIVATE'}]};
 const server=app(t,identity(),async()=>response(body)),r=await request(server,cachePath);
 assert.equal(r.status,200);assert.deepEqual(r.body.crm_fontes,[source]);assert.deepEqual(r.body.wa_saude,[account]);
 assert.deepEqual(r.body.wa_fluxo_saude,[flow]);assert.deepEqual(r.body.crm_wa_envios,[delivery]);
 assert.equal(Object.hasOwn(r.body,'crm_wa_cobertura'),false);assert.equal(JSON.stringify(r.body).includes('PRIVATE'),false);
});


test('master retains the already admitted consolidated Influencer selector; managers cannot use todas or another brand',async t=>{
 const body={acao:'listar',ini:'2026-10-01',fim:'2026-10-04',marca:'todas',conciliacao_pedidos:true};
 const upstream={influ:P.FIXED_DESTINATIONS.influ},m=identity('superadmin');let calls=0;
 const original={influs:[{marca:'fish',nome:'Fish'},{marca:'aristo',nome:'Aristo'},{marca:'olivas',nome:'Olivas'}],pedidos:[{marca:'fish',receita:20},{marca:'aristo',receita:50}]};
 const server=app(t,m,async(url,init)=>{calls++;assert.equal(String(url),P.FIXED_DESTINATIONS.influ);assert.deepEqual(JSON.parse(init.body),body);return response(original);},settings(upstream));
 const master=await request(server,'/api/influ',{host:hosts.manager,method:'POST',body});
 assert.equal(master.status,200);assert.deepEqual(master.body,original);assert.equal(calls,1);assert.equal(m.calls.brand.length,0);assert.equal(m.calls.credential[0].brand,undefined);
 for(const marca of ['todas','aristo']){
  const member=identity('manager','fish','influs'),closed=app(t,member,async()=>assert.fail('invalid manager selector must not fetch'),settings(upstream));
  const denied=await request(closed,'/api/influ',{host:hosts.influs,method:'POST',body:{...body,marca}});assert.equal(denied.status,marca==='todas'?400:403);assert.equal(member.calls.credential.length,0);
 }
 const invalid=await request(server,'/api/influ',{host:hosts.manager,method:'POST',body:{...body,marca:'olivas'}});assert.equal(invalid.status,403);assert.equal(calls,1);
});

test('owner user list exposes effective content availability without rewriting physical writer readiness or unrelated users',async t=>{
 const i=identity('superadmin'),writer={state:'ready',canApprove:true,canRenew:true};
 const rows=[...['fish','aristo'].map(brand=>({...identity('manager',brand).user,crmWriter:writer,permissions:{growth:{read:true,edit:true}},requestedAccess:'edit'})),identity('manager','fish','organico').user,i.user];
 i.auth.users=({context})=>{i.auth.authorize({...context,admin:true});return rows;};
 const server=app(t,i,()=>assert.fail('user list must not contact an upstream'));
 const r=await request(server,'/auth/users',{host:hosts.manager});assert.equal(r.status,200);
 for(const user of r.body.users.slice(0,2)){
  assert.deepEqual(user.campaignContentAccess,{available:false,reason:'BRAND_TEMPLATE_OWNERSHIP_NOT_READY'});
  assert.deepEqual(user.crmWriter,writer);assert.equal(user.permissions.growth.edit,true);
 }
 for(const user of r.body.users.slice(2))assert.equal(Object.hasOwn(user,'campaignContentAccess'),false);
 for(const user of rows)assert.equal(Object.hasOwn(user,'campaignContentAccess'),false);
 const member=identity(),denied=app(t,member,()=>assert.fail('member must not contact an upstream'));
 member.auth.users=({context})=>{member.auth.authorize({...context,admin:true});return rows;};
 assert.equal((await request(denied,'/auth/users')).status,403);
});


test('cart recovery count/revenue must both be measured or both null; neither mixed direction can turn missing recovery into zero',async t=>{
 const row={marca:'fish',dia:'2026-10-04',carrinhos:10,valor_em_jogo:1000,com_consent:8,voltaram_72h:4,receita_voltaram:300};
 const replies=[];
 for(const pair of [{recuperados:2,receita_recuperada:null},{recuperados:null,receita_recuperada:200}]){
  const server=app(t,identity(),async()=>response({crm_carrinho:[{...row,...pair}]}));
  replies.push(await request(server,cachePath));
 }
 assert.deepEqual(replies.map(reply=>reply.status),[503,503]);
 for(const reply of replies){assert.equal(reply.body.error,'BRAND_READ_CONTRACT_NOT_READY');assert.equal(Object.hasOwn(reply.body,'crm_carrinho'),false);}
 for(const pair of [{recuperados:2,receita_recuperada:200},{recuperados:null,receita_recuperada:null}]){
  const server=app(t,identity(),async()=>response({crm_carrinho:[{...row,...pair}]})),reply=await request(server,cachePath);
  assert.equal(reply.status,200);assert.deepEqual(reply.body.crm_carrinho,[{...row,...pair}]);
 }
});

function sandboxAudienceFixture(){
 const stamp='2026-10-04T05:00:00.000Z',segment={id:'12345678-1234-4234-8234-123456789abc',brand:'fish',name:'Synthetic owned audience',definition:{schema_version:'crm-audience-v2',brand:'fish',name:'Synthetic owned audience',rule:{op:'in_list',list_id:17}},version:1,archived:false,created_at:stamp,updated_at:stamp,updated_by:'panel:synthetic-editor',semantic_context:{currency:null,timezone:null,current:true}};
 const catalog={brand:'fish',current:true,currency:null,timezone:null,shop_id:null,fields:Object.keys(require('../services/dashboard-operational/segment-audience-contract.js').FIELDS).map(key=>({key,available:false,source_hash:null})),products:[],origins:[],lists:[{id:17,brand:'fish',name:'Synthetic Fish base',available:true}],coverage:'unconfirmed',checked_at:stamp,catalog_hash:'1'.repeat(64)};
 return{segments:[segment],limit:50,offset:0,catalog,capabilities:{draft:false,count:false,send:false}};
}
function sandboxAudienceSettings(){return settings(P.SANDBOX_DESTINATIONS,{upstreamProfile:'crm-sandbox',bootstrapAdminEmail:'master@synthetic.invalid',crmAudienceDraft:true,dynamicRouteManifest:null});}
const sandboxAudiencePath='/api/segments?acao=segmentos_listar&brand=fish&offset=0&limit=50';

test('closed crm-sandbox preserves the legacy saved-audience list/get contract and separately attested draft capability',async t=>{
 const body=sandboxAudienceFixture(),i=identity();i.auth.audienceDraftReady=()=>true;let calls=0;
 const server=app(t,i,async(raw)=>{calls++;assert.equal(new URL(raw).hostname,P.SANDBOX_HOST);return response(new URL(raw).searchParams.get('acao')==='segmento_obter'?{segment:body.segments[0]}:body);},sandboxAudienceSettings());
 const list=await request(server,sandboxAudiencePath);assert.equal(list.status,200,JSON.stringify(list.body));assert.deepEqual(list.body.segments,body.segments);assert.deepEqual(list.body.catalog,body.catalog);assert.deepEqual(list.body.capabilities,{draft:true,count:false,send:false});
 const get=await request(server,'/api/segments?acao=segmento_obter&brand=fish&id='+body.segments[0].id);assert.equal(get.status,200,JSON.stringify(get.body));assert.deepEqual(get.body,{segment:body.segments[0]});assert.equal(calls,2);
 assert.equal((await request(server,sandboxAudiencePath.replace('brand=fish','brand=aristo'))).status,403);assert.equal(calls,2);assert.equal(i.calls.credential.length,2);
});

test('closed sandbox audience reads reject foreign or malformed nested records, unmarked extras and credential echo after parsing',async t=>{
 const changes=[
  b=>b.catalog=null,
  b=>b.catalog.brand='aristo',b=>b.catalog.lists[0].brand='aristo',
  b=>b.catalog.products=[{id:'gid://shopify/Product/1',brand:'aristo',name:'PRIVATE',available:true}],
  b=>b.catalog.origins=[{key:'popup',brand:'aristo',name:'PRIVATE',available:false,provenance_hash:null}],
  b=>b.segments[0].brand='aristo',b=>b.segments[0].definition.brand='aristo',
  b=>b.segments[0].definition.rule.other_brand_secret='PRIVATE',
  b=>b.segments[0].semantic_context.other_brand_secret='PRIVATE',
  b=>b.segments[0].other_brand_secret='PRIVATE',b=>b.catalog.other_brand_secret='PRIVATE',
  b=>b.catalog.fields[0].other_brand_secret='PRIVATE',b=>b.catalog.lists[0].other_brand_secret='PRIVATE',
  b=>b.other_brand_secret='PRIVATE',b=>b.capabilities.other_brand_secret='PRIVATE',
  b=>b.limit=20,b=>b.offset=1,b=>b.segments[0].definition.name='Different name',
  b=>b.segments[0].version=1000000000,b=>b.segments[0].semantic_context.current='true',b=>b.segments[0].semantic_context.currency=['USD'],
  b=>b.catalog.lists[0].name='a'.repeat(64)
 ];
 for(const change of changes){const body=sandboxAudienceFixture();change(body);const server=app(t,identity(),async()=>response(body),sandboxAudienceSettings()),r=await request(server,sandboxAudiencePath);assert.equal(r.status,502,JSON.stringify(r));assert.equal(r.body.error,'BRAND_RESPONSE_UNSCOPED');assert.equal(Object.hasOwn(r.body,'segments'),false);assert.equal(JSON.stringify(r.body).includes('PRIVATE'),false);}
 const wrong=sandboxAudienceFixture().segments[0],server=app(t,identity(),async()=>response({segment:{...wrong,id:'12345678-1234-4234-8234-123456789abd'}}),sandboxAudienceSettings());assert.equal((await request(server,'/api/segments?acao=segmento_obter&brand=fish&id='+wrong.id)).status,502);
});

test('a valid legacy sandbox audience payload cannot admit the production read path or a broadened sandbox profile',async t=>{
 const body=sandboxAudienceFixture(),server=app(t,identity(),async()=>response(body),settings({segments:P.REVIEWED_DYNAMIC.routes.segments})),r=await request(server,sandboxAudiencePath);
 assert.equal(r.status,503);assert.equal(r.body.error,'BRAND_READ_CONTRACT_NOT_READY');assert.equal(Object.hasOwn(r.body,'segments'),false);
 assert.throws(()=>S.createServer({...sandboxAudienceSettings(),allowedEmailDomains:['synthetic.invalid','oaristocrata.com']},{auth:identity().auth,fetchImpl:()=>assert.fail('broadened profile must not fetch')}),/sandbox settings/);
 assert.throws(()=>S.createServer({...sandboxAudienceSettings(),upstreams:{segments:P.REVIEWED_DYNAMIC.routes.segments},allowedUpstreamHosts:[new URL(P.REVIEWED_DYNAMIC.routes.segments).hostname]},{auth:identity().auth,fetchImpl:()=>assert.fail('production destination must not fetch')}));
});
