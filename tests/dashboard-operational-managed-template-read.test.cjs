'use strict';
// Auth/SQLite + in-process HTTP. No socket, real transport, provider or PG.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const denied=()=>{throw Error('TEST_REAL_NETWORK_DENIED');};
for(const name of ['node:http','node:https']){const m=require(name);m.request=denied;m.get=denied;}
const net=require('node:net');net.connect=denied;net.createConnection=denied;net.Server.prototype.listen=denied;
require('node:tls').connect=denied;require('node:dgram').createSocket=denied;globalThis.fetch=denied;
const ROOT=process.env.TEMPLATE_READ_REVIEW_SOURCE_ROOT||path.join(__dirname,'..');
const {fixture,hosts}=require(path.join(ROOT,'tests/helpers/crm-managed-read-auth-fixture.cjs'));
const S=require(path.join(ROOT,'services/dashboard-operational/server.cjs'));
const P=require(path.join(ROOT,'services/dashboard-operational/proxy.cjs'));
const B=require(path.join(ROOT,'services/dashboard-operational/crm-manager-read-bridge.cjs'));
const T=require(path.join(ROOT,'services/dashboard-operational/crm-template-read-bridge.cjs'));
const GTA=require(path.join(ROOT,'growth-templates-api.js'));
const templateHost=new URL(T.DESTINATIONS['template-read']).hostname;
const manifest={schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns,campaigns_media:B.DESTINATIONS.campaigns_media}};
function settings(f,extra={}){return {...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedTemplateRead:true,upstreams:Object.fromEntries(Object.entries(B.DESTINATIONS).map(([k,v])=>[k,new URL(v)])),allowedUpstreamHosts:[...new Set(Object.values(B.DESTINATIONS).map(v=>new URL(v).hostname)),templateHost],dynamicRouteManifest:manifest,publicDir:__dirname,...extra};}
async function ready(t,brand='fish',{commit=true}={}){
 const f=await fixture();t.after(()=>f.close());const email=brand+'-manager@synthetic.invalid',i=f.invite(email,'growth',brand);await f.accept(i);const login=await f.login(email),ctx=f.reader(login);
 if(commit){const op=f.queued(login.user.id),client=f.client(),prepared=await f.prepare(client,op);await f.commit(client,op,prepared.prepared);}
 return {f,ctx,login};
}
function app(t,f,fetchImpl,extra={}){const a=S.createServer(settings(f,extra),{auth:f.auth,fetchImpl,managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});t.after(()=>a.removeAllListeners());assert.equal(a.listening,false);return a;}
function request(a,ctx,url,{method='GET',body,csrf,authorization}={}){return new Promise(resolve=>{
 const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{url,method,headers:{host:ctx.host,cookie:ctx.cookieHeader,...(authorization?{authorization}:{}),...(body?{'content-type':'application/json',origin:'https://'+ctx.host,'x-csrf-token':csrf}:{})},socket:{remoteAddress:'127.0.0.1'}});
 const res=new EventEmitter();res.setHeader=()=>{};res.end=bytes=>{res.writableEnded=true;res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};res.destroy=()=>{res.destroyed=true;resolve({status:500,body:{error:'TEST_DESTROYED'}});};a.emit('request',req,res);
});}
const AT='2026-10-04T12:00:00Z';
const item=(brand,id)=>({key:'email.template.'+id,brand,channel:'email',id:String(id),name:'Registered email '+id,type:'campaign',draft_id:null,components:{subject:'Synthetic',body_html:'<p>Registered '+brand+'</p>',altbody:null},content_available:true,content_hash:'a'.repeat(64),updated_at:AT});
const page=(brand,items=[item(brand,brand==='fish'?1:2)])=>({contract:'crm-template-read-v1',brand,channel:'email',templates:items,offset:0,limit:20,total:items.length,next_offset:null,coverage:'registered_email_only',consultado_em:AT,schedule_proof:false});
const cache=(capabilities)=>({crm_diario:[],crm_campanha:[],crm_fluxo:[],crm_conversao:[],...(capabilities?{capabilities}:{})});
const response=v=>new Response(JSON.stringify(v),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});

test('ready managers read the registered email page through #222 using their own credential and fixed brand',async t=>{
 for(const brand of ['fish','aristo']){
  const {f,ctx}=await ready(t,brand),calls=[],credential=f.auth.getUpstreamCredential(ctx);
  const a=app(t,f,async(url,init)=>{calls.push(String(url));assert.equal(String(url),T.DESTINATIONS['template-read']+`?acao=listar&brand=${brand}&channel=email&offset=0&limit=20`);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,'Bearer '+credential);assert.equal(init.headers.Origin,undefined);assert.equal(init.headers.Cookie,undefined);assert.equal(init.body,undefined);return response(page(brand));});
  const r=await request(a,ctx,`/api/templates?acao=listar&marca=${brand}`,{authorization:'Bearer ignored-browser-credential'});
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.coverage,'registered_email_only');assert.equal(r.body.schedule_proof,false);assert.ok(r.body.templates.every(v=>v.brand===brand));assert.equal(calls.length,1);
 }
});

test('OFF and foreign/absent/all/extra selectors refuse before credential lookup and fetch',async t=>{
 const {f,ctx,login}=await ready(t);let calls=0,keys=0;const auth={...f.auth,getUpstreamCredential(arg){keys++;return f.auth.getUpstreamCredential(arg);}};
 const a=S.createServer(settings(f),{auth,fetchImpl:async()=>{calls++;assert.fail('must not dispatch');},managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});t.after(()=>a.removeAllListeners());
 for(const query of ['acao=listar&marca=aristo','acao=listar','acao=listar&marca=todas','acao=listar&marca=olivas','acao=listar&marca=fish&marca=aristo','acao=listar&marca=fish&k=browser','acao=listar&marca=fish&canal=whatsapp','acao=listar&marca=fish&limit=21'])assert.ok([400,403,503].includes((await request(a,ctx,'/api/templates?'+query)).status),query);
 assert.equal((await request(a,ctx,'/api/templates',{method:'POST',body:{acao:'salvar',marca:'fish'},csrf:login.csrf})).status,403);
 assert.ok([401,403].includes((await request(a,{...ctx,host:hosts.organico},'/api/templates?acao=listar&marca=fish')).status));
 const off=app(t,f,async()=>{calls++;assert.fail('OFF must not dispatch');},{crmManagedTemplateRead:false});assert.equal((await request(off,ctx,'/api/templates?acao=listar&marca=fish')).status,503);
 assert.equal(keys,0);assert.equal(calls,0);
});

test('an ON listener cannot return a global, unregistered, foreign, or alleged schedule catalog',async t=>{
 const {f,ctx}=await ready(t);let body;const a=app(t,f,async()=>response(body));
 for(const bad of [{templates:[{id:1,name:'Global',type:'campaign',version:'a'.repeat(32),available:true}]},page('fish',[item('fish',1),item('aristo',2)]),page('aristo'),{...page('fish'),coverage:'all'},{...page('fish'),schedule_proof:true},page('fish',[{...item('fish',1),brand:null}])]){
  body=bad;const r=await request(a,ctx,'/api/templates?acao=listar&marca=fish');assert.equal(r.status,502,JSON.stringify(bad));assert.deepEqual(r.body,{error:'TEMPLATE_READ_RESPONSE_DENIED'});
 }
});

test('managed readiness announces only READ and the existing frontend consumes that scoped contract',async t=>{
 const {f,ctx}=await ready(t);let body=cache();const calls=[];const a=app(t,f,async(url)=>{calls.push(String(url));return response(String(url).startsWith(T.DESTINATIONS['template-read'])?page('fish'):body);});
 const originalCapabilities=[undefined,null,{},[],{templates:{read_content:false,draft:true,validate:true,submit:true,submit_email:true,read_contract:'forged'},endpoints:{templates:'https://global.invalid/templates'}}];
 for(const original of originalCapabilities){
  body=cache(original);const r=await request(a,ctx,'/api/crm-read?action=cache_growth&painel=growth');assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual(r.body.capabilities.templates,{read_content:true,list_history:true,read_contract:'crm-template-read-v1',draft:false,validate:false,submit:false});assert.notEqual(r.body.capabilities.templates.submit_email,true);assert.equal(r.body.capabilities.endpoints.templates,'https://'+ctx.host+'/api/templates');
  const cap=GTA.caps(r.body);assert.equal(cap.leitura_marca,true);assert.equal(cap.pode.read_content,true);assert.equal(cap.pode.draft,false);
  const client=GTA.cliente({endpoint:cap.endpoint,leituraMarca:cap.leitura_marca,chaveLeitura:'ignored',fetch:async(url,init)=>{const u=new URL(url);const out=await request(a,ctx,u.pathname+u.search,{authorization:init.headers.Authorization});return {status:out.status,json:async()=>out.body};}});
  const listed=await client.listar('fish','email');assert.equal(listed.ok,true);assert.deepEqual(listed.body.templates.map(v=>v.id),['1']);
 }
 assert.equal(calls.filter(v=>v.startsWith(T.DESTINATIONS['template-read'])).length,originalCapabilities.length);
});

test('OFF cannot be promoted by a legacy cache; master path keeps its own policy',async t=>{
 const {f,ctx}=await ready(t),calls=[];let source;const fetchImpl=async(url)=>{calls.push(String(url));return response(source);};
 const off=app(t,f,fetchImpl,{crmManagedTemplateRead:false}),on=app(t,f,fetchImpl),master={host:hosts.manager,cookieHeader:f.context.cookieHeader};
 for(const capabilities of [{templates:{read_content:true,list_history:true,read_contract:'crm-template-read-v1'},endpoints:{templates:'https://global.invalid/templates'}},[],['read_content','draft']]){
  source=cache(capabilities);const r=await request(off,ctx,'/api/crm-read?action=cache_growth&painel=growth'),m=await request(on,master,'/api/crm-read?action=cache_growth&painel=growth');
  for(const result of [r,m]){assert.equal(result.status,200);assert.equal(result.body.capabilities.templates?.read_contract,undefined);assert.equal(result.body.capabilities.endpoints?.templates,undefined);assert.equal(GTA.caps(result.body).leitura_marca,false);}
  if(Array.isArray(capabilities))assert.deepEqual(m.body.capabilities,capabilities.filter(v=>v!=='draft'));
 }
 assert.ok(calls.every(v=>!v.startsWith(T.DESTINATIONS['template-read'])));
});

test('uncommitted or revoked managed identities never receive a ready catalog',async t=>{
 const {f,ctx}=await ready(t,'fish',{commit:false});let calls=0;const a=app(t,f,async()=>{calls++;assert.fail('uncommitted principal must not fetch');});
 assert.equal((await request(a,ctx,'/api/templates?acao=listar&marca=fish')).status,503);assert.equal(calls,0);
 const readyIdentity=await ready(t,'aristo'),b=app(t,readyIdentity.f,async()=>{calls++;assert.fail('revoked identity must not fetch');});readyIdentity.f.auth.revokeUser({context:readyIdentity.f.context,userId:readyIdentity.login.user.id});
 assert.equal((await request(b,readyIdentity.ctx,'/api/templates?acao=listar&marca=aristo')).status,401);assert.equal(calls,0);
});

test('revocation while the response is in flight discards the entire template page',async t=>{
 const {f,ctx,login}=await ready(t);let finish;const pending=new Promise(resolve=>finish=resolve);const a=app(t,f,()=>pending);
 const r=request(a,ctx,'/api/templates?acao=listar&marca=fish');await new Promise(resolve=>setImmediate(resolve));f.auth.revokeUser({context:f.context,userId:login.user.id});finish(response(page('fish')));
 const result=await r;assert.equal(result.status,503);assert.deepEqual(result.body,{error:'TEMPLATE_READ_NOT_READY'});
});

test('the global campaign selector and manager WRITE remain closed with template READ ON',async t=>{
 const {f,ctx,login}=await ready(t);const calls=[];const a=app(t,f,async(url)=>{calls.push(String(url));return response({brand:'fish',lists:[],templates:[{id:1,name:'Global campaign',type:'campaign',version:'a'.repeat(32),available:true}],initiatives:[]});});
 const catalog=await request(a,ctx,'/api/campaigns?acao=campanha_catalogo&brand=fish');assert.equal(catalog.status,503);assert.deepEqual(catalog.body,{error:'BRAND_CATALOG_SCOPE_NOT_READY'});
 const before=calls.length;for(const acao of ['campanha_criar','campanha_salvar','campanha_validar','campanha_agendar'])assert.equal((await request(a,ctx,'/api/campaigns',{method:'POST',body:{acao,brand:'fish'},csrf:login.csrf})).status,403);assert.equal(calls.length,before);assert.ok(calls.every(v=>!v.startsWith(T.DESTINATIONS['template-read'])));
});

test('missing host and unmanaged/sandbox profiles refuse construction without transport',async t=>{
 const {f}=await ready(t);for(const delta of [{allowedUpstreamHosts:settings(f).allowedUpstreamHosts.filter(v=>v!==templateHost)},{crmManagedReadUi:false},{crmManagedRead:undefined},{mode:'synthetic',upstreams:{}},{crmDraftWrite:true},{crmAudienceDraft:true}])assert.throws(()=>app(t,f,denied,delta));
});

test('BFF → existing #222 store → existing SQL filters the registry, with unchanged rows and no assigned XID',async t=>{
 const {PGlite}=require('@electric-sql/pglite'),X=require(path.join(ROOT,'tests/claude-template-read-fixture.cjs')),Store=require(path.join(ROOT,'services/crm-template-read/store.cjs'));
 const db=new PGlite();t.after(()=>db.close());await X.install(db);const identities=[];
 for(const brand of ['fish','aristo']){
  const r=await ready(t,brand),proof=r.f.auth.managedCrmReadAuthorization(r.ctx),credential=r.f.auth.getUpstreamCredential(r.ctx);identities.push({...r,brand});
  await db.query("INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'growth',$2,$3)",[proof.principalId,proof.owner,X.sha(credential)]);
  await db.query("INSERT INTO public.shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb)",[proof.principalId,JSON.stringify(T.CAPS)]);
 }
 const before=await X.snapshot(db),statements=[];const transaction=Store.createReadTransaction({pool:{connect:async()=>({async query(q,v){const sql=typeof q==='string'?q:q.text,args=typeof q==='string'?v:q.values;statements.push(sql);const result=await db.query(sql,args||[]);if(/^BEGIN /.test(sql))await db.query('SET LOCAL ROLE crm_template_reader');return result;},release(){}})}});
 const store=Store.createTemplateReadStore({transaction});
 for(const {f,ctx,brand} of identities){
  let calls=0;const a=app(t,f,async(url,init)=>{calls++;const u=new URL(url);assert.equal(u.origin+u.pathname,T.DESTINATIONS['template-read']);const r=await store.handle({authorization:init.headers.Authorization,pairs:[...u.searchParams]});await r.settled;return new Response(r.text??JSON.stringify(r.body),{status:r.status,headers:{'content-type':'application/json; charset=utf-8'}});});
  const r=await request(a,ctx,'/api/templates?acao=listar&marca='+brand);assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.templates.map(v=>v.id),brand==='fish'?['1','6','8']:['2','9']);assert.equal(r.body.coverage,'registered_email_only');assert.equal(r.body.schedule_proof,false);
  assert.equal((await request(a,ctx,'/api/templates?acao=listar&marca='+(brand==='fish'?'aristo':'fish'))).status,403);assert.equal(calls,1);
 }
 assert.deepEqual(await X.snapshot(db),before);assert.equal(transaction.active(),0);assert.equal(statements.filter(v=>v==='ROLLBACK').length,2);assert.equal(statements.filter(v=>v===Store.SQL.xid).length,2);assert.ok(statements.every(v=>new Set(['BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY','ROLLBACK',"SET LOCAL statement_timeout='8000ms'",...Object.values(Store.SQL)]).has(v)));
});
