'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
function sourceRoot(){let dir=__dirname;for(let i=0;i<6;i++,dir=path.dirname(dir))if(fs.existsSync(path.join(dir,'services/dashboard-operational/server.cjs')))return dir;throw Error('TEST_SOURCE_ROOT_MISSING');}
const ROOT=sourceRoot();
const {fixture,hosts}=require(fs.existsSync(path.join(__dirname,'auth-fixture.cjs'))?'./auth-fixture.cjs':'./helpers/crm-managed-read-auth-fixture.cjs');
const B=require(path.join(ROOT,'services/dashboard-operational/crm-manager-read-bridge.cjs'));
const P=require(path.join(ROOT,'services/dashboard-operational/proxy.cjs'));
const S=require(path.join(ROOT,'services/dashboard-operational/server.cjs'));
const Backend=require(path.join(ROOT,'services/crm-campaign/server.cjs'));
const T=require(path.join(ROOT,'services/crm-campaign/transport.cjs'));
const Media=require(path.join(ROOT,'services/crm-campaign/media.cjs'));
const UPSTREAMS=Object.fromEntries(Object.entries(B.DESTINATIONS).map(([k,v])=>[k,new URL(v)]));
const manifest={schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns,campaigns_media:B.DESTINATIONS.campaigns_media}};
function response(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8'}});}
function campaign(brand,id){return{id,version:'a'.repeat(32),status:'draft',sent:0,started_at:null,send_at:null,definition:{brand,name:'Synthetic campaign'}};}
function catalog(brand){return{brand,current:true,read_at:'2026-10-03T00:00:00Z',lists:[{id:brand==='fish'?17:16,brand,name:'Synthetic list',available:true}],templates:[],initiatives:[]};}
async function ready(t,brand='fish'){
 const f=await fixture();t.after(()=>f.close());const email=brand+'-manager@synthetic.invalid',invitation=f.invite(email,'growth',brand);await f.accept(invitation);const login=await f.login(email),ctx=f.reader(login),userId=login.user.id,op=f.queued(userId);
 const client=f.client(),prepared=await f.prepare(client,op);await f.commit(client,op,prepared.prepared);
 return{f,ctx,userId,login};
}
function transport(auth,ctx){
 const calls=[],queries=[],native=[];
 const fetchImpl=async(url,options)=>{
  assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');assert.equal(options.headers['Accept-Encoding'],'identity');assert.equal(options.body,undefined);assert.equal(options.headers.Origin,undefined);assert.equal(options.headers.Cookie,undefined);
  const u=new URL(url),proof=auth.managedCrmReadAuthorization(ctx),key=auth.getUpstreamCredential(ctx);
  assert.equal(options.headers.Authorization,'Bearer '+key);assert.equal(u.search.includes(key),false);assert.match(proof.principalId,/^dcrm-[a-f0-9]{32}$/);
  const query=Object.fromEntries(u.searchParams);calls.push({path:u.pathname,brand:query.brand,action:query.acao||''});
  const pool={query:async(sql,params)=>{
   assert.equal(params[0],key);queries.push(sql);
   if(sql===T.AUTH_SQL)return{rows:[{auth:{actor:'panel:'+proof.principalId,caps:[...B.CAPS]}}]};
   assert.equal(sql,T.EFFECT_SQL);const command=JSON.parse(params[1]).command,effect=JSON.parse(params[2]);assert.equal(effect.kind,'provider');assert.ok(['catalog','list','get'].includes(effect.action));
   const value=effect.action==='catalog'?catalog(command.brand):effect.action==='list'?[campaign(command.brand,command.brand==='fish'?167:168)]:campaign(Number(command.id)===167?'fish':'aristo',Number(command.id));
   return{rows:[{result:value}]};
  }};
  const req={method:'GET',headers:{authorization:options.headers.Authorization},rawHeaders:['Authorization',options.headers.Authorization]};
  if(u.origin+u.pathname===B.DESTINATIONS.campaigns){
   const parsed=Backend.parse(req,u);const execute=T.createExecutor({pool,native:()=>{throw Error('SYNTHETIC_PRIVATE_NATIVE_WRITE_REFUSED');}}),out=await execute(parsed);return response(out.body,out.status);
  }
  assert.equal(u.origin+u.pathname,B.DESTINATIONS.campaigns_media);const parsed=Backend.mediaGet(req,u);
  const media=Media.createMediaExecutor({pool,native:{origin:'https://email.shrigma.com.br',list:async p=>{
   native.push({method:'GET',...p});return{status:200,body:{data:{total:1,page:p.page,per_page:p.perPage,results:[{id:1,filename:'legacy.png',url:'https://email.shrigma.com.br/uploads/legacy.png',content_type:'image/png',meta:{width:10,height:10},created_at:'2026-10-03T00:00:00Z'}]}}};
  },upload:()=>assert.fail('No upload')}});
  const out=await media({...parsed,method:'GET'});return response(out.body,out.status);
 };
 return{fetchImpl,calls,queries,native};
}
const input=(ctx,route,query)=>({context:ctx,route,method:'GET',query:new URLSearchParams(query),origin:'https://'+hosts.growth});
test('real SQLite managed principal reads campaign catalog, list, detail and media on both brands through current backend parser/runtime',async t=>{
 const transports=[];
 for(const brand of ['fish','aristo']){
  const{f,ctx,login}=await ready(t,brand),x=transport(f.auth,ctx),bridge=B.createManagedReadBridge({auth:f.auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl:x.fetchImpl});transports.push(x);
  const c=await bridge.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand}));assert.equal(c.body.brand,brand);assert.equal(c.body.lists[0].brand,brand);
  const l=await bridge.read(input(ctx,'campaigns',{acao:'campanha_listar',brand}));assert.equal(l.body.campaigns[0].definition.brand,brand);
  const d=await bridge.read(input(ctx,'campaigns',{acao:'campanha_obter',brand,id:String(brand==='fish'?167:168)}));assert.equal(d.body.campaign.definition.brand,brand);
  const m=await bridge.read(input(ctx,'campaigns_media',{brand,page:'1',per_page:'24'}));assert.equal(m.body.brand,brand);assert.equal(m.body.items.length,1);
  assert.equal(x.calls.length,4);assert.equal(x.native.every(x=>x.method==='GET'),true);assert.equal(x.queries.every(q=>q===T.AUTH_SQL||q===T.EFFECT_SQL),true);
  const bearer=f.auth.getUpstreamCredential(ctx);assert.equal(JSON.stringify(x.calls).includes(bearer),false);assert.equal(f.auth.users({context:f.context}).find(u=>u.id===login.user.id).permissions.growth.edit,false);
  assert.throws(()=>f.auth.getUpstreamCredential({...ctx,brand:brand==='fish'?'aristo':'fish'}),{code:'BRAND_DENIED'});
 }
 assert.equal(transports.reduce((n,x)=>n+x.calls.length,0),8);
});
test('exact GET fields/actions/destinations only: writes, receipt lookups, audience, templates and alias attempts do not call transport',async t=>{
 const{f,ctx}=await ready(t);let calls=0;const bridge=B.createManagedReadBridge({auth:f.auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl:async()=>{calls++;return response(catalog('fish'));}});
 for(const request of [
  {...input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'}),method:'POST'},
  {...input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'}),context:{...ctx,method:'POST'}},
  {...input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'}),bearer:'CALLER_CANNOT_SELECT_CREDENTIAL'},
  input(ctx,'campaigns',{acao:'campanha_salvar',brand:'fish'}),input(ctx,'campaigns',{acao:'campanha_operacao',brand:'fish',idempotency_key:'synthetic-operation-key'}),
  input(ctx,'segments',{acao:'segmentos_listar',brand:'fish',offset:'0',limit:'50'}),input(ctx,'campaign_audience',{acao:'campanha_publico_obter',brand:'fish',campaign_id:'167'}),
  input(ctx,'templates',{acao:'listar',marca:'fish'}),input(ctx,'campaigns_media',{brand:'fish',filename:'x'}),input(ctx,'campaigns',{acao:'campanha_listar',brand:'fish',k:'SYNTHETIC_BEARER'}),
  input(ctx,'campaigns',{acao:'campanha_listar',brand:'fish',unexpected:'x'}),input(ctx,'campaigns',{acao:'campanha_listar',brand:'other'}),
  {...input(ctx,'campaigns',{acao:'campanha_listar',brand:'fish'}),query:new URLSearchParams('acao=campanha_listar&brand=fish&brand=aristo')},
 ])await assert.rejects(bridge.read(request),e=>e instanceof B.ManagedReadError);
 await assert.rejects(bridge.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'}),{}),B.ManagedReadError);
 assert.equal(calls,0);
 for(const changed of [{...UPSTREAMS,campaigns:new URL('https://comunicacao-crm-campaign.tazdb8.easypanel.host/read')},{...UPSTREAMS,segments:new URL(P.REVIEWED_DYNAMIC.routes.segments)},{...UPSTREAMS,campaigns:new URL(B.DESTINATIONS.campaigns+'?k=x')}])assert.throws(()=>B.createManagedReadBridge({auth:f.auth,upstreams:changed,enabled:true}),B.ManagedReadError);
});
test('default OFF is immutable and constructor has no transport or auth work',async t=>{
 const{f,ctx}=await ready(t);let calls=0,authCalls=0;const auth={...f.auth,managedCrmReadAuthorization:()=>{authCalls++;return f.auth.managedCrmReadAuthorization(ctx);}};
 const config={auth,upstreams:UPSTREAMS,enabled:false};const bridge=B.createManagedReadBridge(config,{fetchImpl:async()=>{calls++;return response(catalog('fish'));}});config.enabled=true;
 assert.equal(authCalls,0);await assert.rejects(bridge.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'})),e=>e.code==='MANAGED_READ_DISABLED');assert.equal(calls,0);assert.equal(authCalls,0);
});
test('life revocation and credential mutation while response is pending suppress the body',async t=>{
 for(const mutate of ['revoke','credential']){
  const{f,ctx,userId}=await ready(t);const bridge=B.createManagedReadBridge({auth:f.auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl:async()=>{
   if(mutate==='revoke')f.auth.revokeUser({context:f.context,userId});else f.inspect(d=>d.prepare("UPDATE upstream_credentials SET key_digest=? WHERE user_id=? AND slot='crm-panel-read'").run('f'.repeat(64),userId));
   return response(catalog('fish'));
  }});await assert.rejects(bridge.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'})),e=>e.code==='MANAGED_READ_NOT_READY');
 }
});
test('brand is snapshotted and cross-brand, secret echo, redirects and non-UTF8 responses remain closed',async t=>{
 const{f,ctx}=await ready(t),query=new URLSearchParams({acao:'campanha_catalogo',brand:'fish'});const bridge=B.createManagedReadBridge({auth:f.auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl:async()=>{query.set('brand','aristo');return response(catalog('fish'));}});
 assert.equal((await bridge.read({...input(ctx,'campaigns',{}),query})).body.brand,'fish');
 const bad=[()=>response(catalog('aristo')),()=>response({...catalog('fish'),token:f.auth.getUpstreamCredential(ctx)}),()=>response({},302),()=>new Response(Buffer.from([0xff]),{headers:{'content-type':'application/json'}}),()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'4194305'}})];
 for(const fake of bad){const b=B.createManagedReadBridge({auth:f.auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl:async()=>fake()});await assert.rejects(b.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'})),e=>e instanceof B.ManagedReadError&&JSON.stringify(e).includes(f.auth.getUpstreamCredential(ctx))===false);}
 class ExoticQuery extends URLSearchParams{toString(){return'acao=campanha_operacao&brand=aristo&idempotency_key=ATTACK_EXTRA_ROUTE';}get(){return'aristo';}}
 const exotic=new ExoticQuery({acao:'campanha_catalogo',brand:'fish'});let observed;
 const safe=B.createManagedReadBridge({auth:f.auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl:async url=>{observed=new URL(url).searchParams;return response(catalog('fish'));}});
 assert.equal((await safe.read({...input(ctx,'campaigns',{}),query:exotic})).body.brand,'fish');assert.equal(observed.get('acao'),'campanha_catalogo');assert.equal(observed.get('brand'),'fish');assert.equal(observed.has('idempotency_key'),false);
});
test('server proposal defaults read UI OFF and requires explicit managed mode plus exact backend pins',()=>{
 const env={DASHBOARD_MODE:'operational',DASHBOARD_MANAGER_HOST:hosts.manager,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:hosts.growth,organico:hosts.organico,influs:hosts.influs}),DASHBOARD_EMAIL_DOMAINS:'["synthetic.invalid"]',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':B.DESTINATIONS['crm-read']}),DASHBOARD_UPSTREAM_HOSTS:'["comunicacao-crm-panel-read.tazdb8.easypanel.host"]'};
 assert.equal(S.settingsFromEnv(env).crmManagedReadUi,false);assert.throws(()=>S.settingsFromEnv({...env,DASHBOARD_CRM_MANAGED_READ_UI:'enabled'}));
 const candidate={...env,DASHBOARD_CRM_MANAGED_READ:'enabled',DASHBOARD_CRM_MANAGER_ISSUER_ID:crypto.randomUUID(),DASHBOARD_CRM_MANAGER_NAMESPACE_ID:crypto.randomUUID(),DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN:'synthetic'.repeat(8),DASHBOARD_CRM_MANAGED_READ_UI:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify(B.DESTINATIONS),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify(manifest)};
 assert.equal(S.settingsFromEnv(candidate).crmManagedReadUi,true);for(const changed of [{DASHBOARD_CRM_DRAFT_WRITE:'enabled'},{DASHBOARD_CRM_AUDIENCE_DRAFT:'enabled'},{DASHBOARD_CRM_MANAGED_READ_UI:'yes'},{DASHBOARD_UPSTREAMS:JSON.stringify({...B.DESTINATIONS,segments:P.REVIEWED_DYNAMIC.routes.segments})}])assert.throws(()=>S.settingsFromEnv({...candidate,...changed}));
});
function request(server,ctx,url,{method='GET',body,csrf,disconnect=false}={}){return new Promise(resolve=>{
 const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);req.method=method;req.url=url;req.headers={host:ctx.host,cookie:ctx.cookieHeader,...(body?{'content-type':'application/json',origin:'https://'+ctx.host,'x-csrf-token':csrf}:{})};req.socket={remoteAddress:'127.0.0.1'};
 const res=new EventEmitter();res.headers={};res.setHeader=(k,v)=>{res.headers[k]=v;};res.getHeader=k=>res.headers[k];res.end=bytes=>{res.writableEnded=true;resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};res.destroy=()=>{res.destroyed=true;resolve({status:500,body:{error:'TEST_DESTROYED'}});};server.emit('request',req,res);if(disconnect)queueMicrotask(()=>{res.destroyed=true;res.emit('close');resolve({status:499,body:{error:'TEST_DISCONNECTED'}});});
});}
test('full server listener invoked in-process uses managed bridge and existing global admission without opening a socket',async t=>{
 const{f,ctx}=await ready(t),x=transport(f.auth,ctx);let kicks=0;
 const settings={...f.config,mode:'operational',upstreamProfile:'production',upstreams:UPSTREAMS,allowedUpstreamHosts:['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host'],dynamicRouteManifest:manifest,crmManagedReadUi:true,publicDir:__dirname};
 const server=S.createServer(settings,{auth:f.auth,managedCrmRuntime:{kick:async()=>{kicks++;},close:async()=>{}},fetchImpl:x.fetchImpl});assert.equal(server.listening,false);
 const ok=await request(server,ctx,'/api/campaigns?acao=campanha_catalogo&brand=fish');assert.equal(ok.status,200);assert.equal(ok.body.brand,'fish');
 const denied=await request(server,ctx,'/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=synthetic-operation-key');assert.equal(denied.status,403);assert.equal(x.calls.length,1);assert.equal(kicks,0);assert.equal(server.listening,false);
});
test('reviewed source establishes read capability and early return; audience GET refresh writes and absent template pins stay blocked',()=>{
 const root=ROOT,pins={"n8n/growth/campaign-provider.sql":"a293e6a971795126bf8b0e98e087c31199319726ea95d1e354bada0f2bfe396d","n8n/growth/campaign-service.js":"1858178696d8537a23a2a49df20df45b786548efb3d266c4c6d8d21725a5d629","services/crm-campaign/transport.cjs":"c1f88a8174da867864d21931d85c3d5132ebcc97fb5255625a660a849599c2dd","services/crm-campaign/media.cjs":"ca341115f736c0dae0b0dc7fd1645c583e2ee6bf7eb3c700a90d0859fab21a4f"};
 for(const name of ['n8n/growth/campaign-provider.sql','n8n/growth/campaign-service.js','services/crm-campaign/transport.cjs','services/crm-campaign/media.cjs'])assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex'),pins[name]);
 const provider=fs.readFileSync(path.join(root,'n8n/growth/campaign-provider.sql'),'utf8'),early=provider.slice(provider.indexOf("ELSIF a='catalog'"),provider.indexOf('SELECT * INTO op'));
 assert.match(early,/a='get'/);assert.match(early,/a='list'/);assert.doesNotMatch(early,/\b(UPDATE|INSERT|DELETE)\b/);
 assert.equal(P.REVIEWED_DYNAMIC.routes.templates,undefined);assert.equal(P.REVIEWED_DYNAMIC.routes.journey_graph,undefined);
 const audience=fs.readFileSync(path.join(root,'n8n/growth/segment-audience-store.cjs'),'utf8'),refresh=fs.readFileSync(path.join(root,'n8n/growth/segment-runtime-access.sql'),'utf8');assert.match(audience,/if\(refreshCatalog\).*await refreshCatalog/);assert.match(refresh,/UPDATE crm_audience_v2\.config SET checked_at=/);
 assert.equal(Object.hasOwn(B.ACTIONS,'segments'),false);assert.equal(Object.hasOwn(B.ACTIONS,'templates'),false);assert.equal(Object.hasOwn(B.ACTIONS,'journey_graph'),false);
});
test('absolute request deadline bounds both a missing fetch ACK and a body that never completes',async t=>{
 const{f,ctx}=await ready(t);const original=globalThis.setTimeout,clear=globalThis.clearTimeout;
 let canceled=0;
 try{
  globalThis.setTimeout=(callback,delay)=>{assert.equal(delay,25000);queueMicrotask(callback);return{syntheticDeadline:true};};globalThis.clearTimeout=()=>{};
  for(const fetchImpl of [()=>new Promise(()=>{}),async()=>({status:200,headers:{get:name=>name==='content-type'?'application/json':null},body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>{canceled++;},releaseLock:()=>{}})}})]){
   const bridge=B.createManagedReadBridge({auth:f.auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl});await assert.rejects(bridge.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'})),e=>e.code==='MANAGED_READ_UPSTREAM_UNAVAILABLE');
  }
  assert.ok(canceled>=1);
 }finally{globalThis.setTimeout=original;globalThis.clearTimeout=clear;}
});
test('synchronous DI rejects Promise auth, header or reader returns; rejected cleanup is observed without exposing its message',async t=>{
 const{f,ctx}=await ready(t);const sentinel='SYNTHETIC_PRIVATE_REJECTION_SENTINEL';
 const auth={...f.auth,managedCrmReadAuthorization:()=>Promise.reject(Error(sentinel))};let called=0;
 const denied=B.createManagedReadBridge({auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl:async()=>{called++;}});await assert.rejects(denied.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'})),e=>e.code==='MANAGED_READ_NOT_READY');assert.equal(called,0);
 for(const where of ['header','reader','release']){
  const r=response(catalog('fish'));
  if(where==='header')r.headers.get=()=>Promise.reject(Error(sentinel));
  if(where==='reader')r.body.getReader=()=>Promise.reject(Error(sentinel));
  if(where==='release'){const get=r.body.getReader.bind(r.body);r.body.getReader=()=>{const reader=get();reader.releaseLock=()=>Promise.reject(Error(sentinel));return reader;};}
  const b=B.createManagedReadBridge({auth:f.auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl:async()=>r});
  if(where==='release')assert.equal((await b.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'}))).status,200);
  else await assert.rejects(b.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'})),e=>e instanceof B.ManagedReadError&&!JSON.stringify(e).includes(sentinel));
 }
 await new Promise(resolve=>setImmediate(resolve));
});
function serverSettings(f,extra={}){return{...f.config,mode:'operational',upstreamProfile:'production',upstreams:{...UPSTREAMS,...Object.fromEntries(Object.entries(B.PASSTHROUGH_DESTINATIONS).map(([k,v])=>[k,new URL(v)]))},allowedUpstreamHosts:['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host'],dynamicRouteManifest:manifest,crmManagedReadUi:true,publicDir:__dirname,...extra};}
test('master retains its own existing campaign/read/organic/influs credentials and baseline flows without calling the manager bridge',async t=>{
 const{f}=await ready(t),admin=f.master.user.id;
 const keys={'growth-campaign-read':'synthetic-master-campaign-reader','organico-read':'synthetic-master-organic-reader','influs-read':'synthetic-master-influ-reader'};
 for(const[slot,bearer]of Object.entries(keys))f.auth.setUpstreamCredential({context:f.context,userId:admin,slot,bearer});
 const before=f.inspect(d=>d.prepare('SELECT * FROM upstream_credentials WHERE user_id=? ORDER BY slot').all(admin));let bridgeCalls=0;const calls=[];
 const auth={...f.auth,managedCrmReadAuthorization:ctx=>{bridgeCalls++;return f.auth.managedCrmReadAuthorization(ctx);}};
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);calls.push({path:u.pathname,method:options.method});assert.equal(options.redirect,'manual');assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Origin,undefined);
  if(u.origin+u.pathname===B.DESTINATIONS['crm-read']){assert.equal(options.headers.Authorization,'Bearer '+f.masterKey);return response({_painel:'growth',synthetic:true});}
  if(u.origin+u.pathname===B.DESTINATIONS.campaigns){assert.equal(options.headers.Authorization,'Bearer '+keys['growth-campaign-read']);return response(catalog(u.searchParams.get('brand')));}
  if(u.origin+u.pathname===B.PASSTHROUGH_DESTINATIONS.cx){assert.equal(options.headers.Authorization,'Bearer '+keys['organico-read']);return response({_painel:'organico',synthetic:true});}
  assert.equal(u.origin+u.pathname,B.PASSTHROUGH_DESTINATIONS.influ);assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Bearer '+keys['influs-read']);assert.deepEqual(JSON.parse(options.body),{acao:'listar',ini:'2026-10-01',fim:'2026-10-03',marca:'fish'});return response({synthetic:true,items:[]});
 };
 const server=S.createServer(serverSettings(f),{auth,managedCrmRuntime:{kick:async()=>{},close:async()=>{}},fetchImpl});const ctx={host:hosts.manager,method:'GET',cookieHeader:f.context.cookieHeader};
 for(const url of ['/api/crm-read?action=cache_growth&painel=growth','/api/campaigns?acao=campanha_catalogo&brand=fish','/api/cx?painel=organico'])assert.equal((await request(server,ctx,url)).status,200);
 assert.equal((await request(server,ctx,'/api/influ',{method:'POST',body:{acao:'listar',ini:'2026-10-01',fim:'2026-10-03',marca:'fish'},csrf:f.master.csrf})).status,200);
 assert.equal(calls.length,4);assert.equal(bridgeCalls,0);assert.equal(server.listening,false);assert.deepEqual(f.inspect(d=>d.prepare('SELECT * FROM upstream_credentials WHERE user_id=? ORDER BY slot').all(admin)),before);
 assert.equal(f.auth.managedCrmJournal.status(admin),null);
});
test('master missing a route-specific credential remains a documented gap; neither manager bearer nor crm-panel-read is adopted, and reviewed CREATE guards default closed',async t=>{
 const{f}=await ready(t),admin=f.master.user.id,before=f.baseline();let bridgeCalls=0,calls=0;
 const auth={...f.auth,managedCrmReadAuthorization:ctx=>{bridgeCalls++;return f.auth.managedCrmReadAuthorization(ctx);}};
 const server=S.createServer(serverSettings(f),{auth,managedCrmRuntime:{kick:async()=>{},close:async()=>{}},fetchImpl:async()=>{calls++;return response({});}}),ctx={host:hosts.manager,method:'GET',cookieHeader:f.context.cookieHeader};
 for(const url of ['/api/campaigns?acao=campanha_catalogo&brand=fish','/api/cx?painel=organico']){const denied=await request(server,ctx,url);assert.equal(denied.status,503);assert.equal(denied.body.error,'INDIVIDUAL_CREDENTIAL_MISSING');}
 assert.equal(bridgeCalls,0);assert.equal(calls,0);assert.deepEqual(f.baseline(),before);assert.equal(f.auth.managedCrmJournal.status(admin),null);
 // Pin the reviewed independent CREATE gate; dedicated HTTP/UI regressions
 // cover OFF denial and ON requiring a ready, individual FULL writer.
 for(const[name,start,end,expected]of [["auth.cjs"," function campaignCreateFor(transport){"," async function setSandboxCredential(","26e41ffe5f17ce61f5b1e0068e488c41fdf66e0a27ed398b987d630b495a2e16"],["server.cjs","      if(url.pathname==='/auth/campaign-create'){","      if(url.pathname==='/auth/campaign-delivery'","6fd078fea0f9d9b63034481abb86019fd17c96abe234e1121d4ac917e408750d"]]){
  const proposed=fs.readFileSync(path.join(ROOT,'services/dashboard-operational',name),'utf8'),begin=proposed.indexOf(start),finish=proposed.indexOf(end,begin);assert.ok(begin>=0&&finish>begin);assert.equal(crypto.createHash('sha256').update(proposed.slice(begin,finish)).digest('hex'),expected);
 }
 assert.equal(B.PASSTHROUGH_DESTINATIONS.cx,P.FIXED_DESTINATIONS.cx);assert.equal(B.PASSTHROUGH_DESTINATIONS.influ,P.FIXED_DESTINATIONS.influ);
 assert.equal(Object.hasOwn(B.ACTIONS,'cx'),false);assert.equal(Object.hasOwn(B.ACTIONS,'influ'),false);
});
test('upstream 401/403/404 statuses return only typed unavailable errors and never expose remote bodies or retry',async t=>{
 const{f,ctx}=await ready(t);let calls=0;
 for(const status of [401,403,404]){let bodyReads=0;const bridge=B.createManagedReadBridge({auth:f.auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl:async()=>{calls++;return{status,headers:{get:()=>assert.fail('Denied status must not read headers')},body:{getReader:()=>{bodyReads++;assert.fail('Denied status must not read body');}}};}});
  await assert.rejects(bridge.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'})),e=>e instanceof B.ManagedReadError&&e.status===502&&e.code==='MANAGED_READ_UPSTREAM_UNAVAILABLE'&&!JSON.stringify(e).includes(f.auth.getUpstreamCredential(ctx)));assert.equal(bodyReads,0);
 }assert.equal(calls,3);
});
test('lifecycle revoked after headers while body is streaming prevents delivery; session and area refusals dispatch no request',async t=>{
 const{f,ctx,userId}=await ready(t);let reads=0,calls=0;const bytes=Buffer.from(JSON.stringify(catalog('fish')));
 const bridge=B.createManagedReadBridge({auth:f.auth,upstreams:UPSTREAMS,enabled:true},{fetchImpl:async()=>{calls++;return{status:200,headers:{get:name=>name==='content-type'?'application/json':null},body:{getReader:()=>({read:async()=>{if(reads++===0){f.auth.revokeUser({context:f.context,userId});return{done:false,value:bytes};}return{done:true};},cancel:()=>{},releaseLock:()=>{}})}};}});
 await assert.rejects(bridge.read(input(ctx,'campaigns',{acao:'campanha_catalogo',brand:'fish'})),e=>e.code==='MANAGED_READ_NOT_READY');assert.equal(calls,1);
 const server=S.createServer(serverSettings(f),{auth:f.auth,managedCrmRuntime:{kick:async()=>{},close:async()=>{}},fetchImpl:async()=>{calls++;assert.fail('Session and lifecycle refusal must precede upstream');}});
 assert.equal((await request(server,{host:hosts.growth,cookieHeader:''},'/api/campaigns?acao=campanha_catalogo&brand=fish')).status,401);
 assert.equal((await request(server,ctx,'/api/campaigns?acao=campanha_catalogo&brand=fish')).status,401);
 const unrelated=await fixture(false);t.after(()=>unrelated.close());const i=unrelated.invite('organic@synthetic.invalid','organico');await unrelated.accept(i);const login=await unrelated.auth.login({email:'organic@synthetic.invalid',password:'synthetic-manager-password-2026',host:hosts.organico,origin:'https://'+hosts.organico});
 const restricted=S.createServer({...serverSettings(unrelated),crmManagedReadUi:false},{auth:unrelated.auth,fetchImpl:async()=>{calls++;assert.fail('Cross-area must precede upstream');}});
 assert.equal((await request(restricted,{host:hosts.organico,cookieHeader:login.cookie.split(';')[0]},'/api/campaigns?acao=campanha_catalogo&brand=fish')).status,403);assert.equal(calls,1);
});
test('deadline HTTP failures retain the four-person lease until actual fetch/body settle, including disconnected clients',async t=>{
 const{f,ctx}=await ready(t),original=globalThis.setTimeout,clear=globalThis.clearTimeout;
 try{
  globalThis.setTimeout=(fn,delay)=>{assert.equal(delay,25000);queueMicrotask(fn);return{synthetic:true};};globalThis.clearTimeout=()=>{};
  for(const mode of ['fetch','body','disconnect']){
   let calls=0,active=0;const completions=[];const fetchImpl=async()=>{calls++;active++;
    if(mode!=='body')return new Promise(resolve=>completions.push(()=>{active--;resolve(response(catalog('fish')));}));
    return{status:200,headers:{get:n=>n==='content-type'?'application/json':null},body:{getReader:()=>({read:()=>new Promise(resolve=>completions.push(()=>{active--;resolve({done:true});})),cancel:()=>{},releaseLock:()=>{}})}};
   };
   const server=S.createServer(serverSettings(f),{auth:f.auth,managedCrmRuntime:{kick:async()=>{},close:async()=>{}},fetchImpl});
   for(let i=0;i<4;i++)assert.equal((await request(server,ctx,'/api/campaigns?acao=campanha_catalogo&brand=fish',{disconnect:mode==='disconnect'})).status,mode==='disconnect'?499:502);
   await new Promise(resolve=>setImmediate(resolve));assert.equal(active,4);assert.equal(calls,4);
   assert.equal((await request(server,ctx,'/api/campaigns?acao=campanha_catalogo&brand=fish')).status,429);assert.equal(calls,4);
   completions.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(active,3);
   assert.equal((await request(server,ctx,'/api/campaigns?acao=campanha_catalogo&brand=fish')).status,502);assert.equal(calls,5);assert.equal(active,4);
   for(const complete of completions.splice(0))complete();await new Promise(resolve=>setImmediate(resolve));assert.equal(active,0);
  }
 }finally{globalThis.setTimeout=original;globalThis.clearTimeout=clear;}
});
test('pending timed-out manager reads retain the same global16 limit for every route and release only on work settlement',async t=>{
 const{f,ctx}=await ready(t),contexts=[ctx];
 for(let i=1;i<4;i++){const email='manager'+i+'@synthetic.invalid',inv=f.invite(email);await f.accept(inv);const login=await f.login(email),op=f.queued(login.user.id),client=f.client(),prepared=await f.prepare(client,op);await f.commit(client,op,prepared.prepared);contexts.push(f.reader(login));}
 const original=globalThis.setTimeout,clear=globalThis.clearTimeout,completions=[];let calls=0;
 try{
  globalThis.setTimeout=(fn,delay)=>{assert.equal(delay,25000);queueMicrotask(fn);return{synthetic:true};};globalThis.clearTimeout=()=>{};
  const server=S.createServer(serverSettings(f),{auth:f.auth,managedCrmRuntime:{kick:async()=>{},close:async()=>{}},fetchImpl:async(url,options)=>{calls++;if(options.headers.Authorization==='Bearer '+f.masterKey)return response({_painel:'growth',synthetic:true});return new Promise(resolve=>completions.push(()=>resolve(response(catalog('fish')))));}});
  for(const context of contexts)for(let i=0;i<4;i++)assert.equal((await request(server,context,'/api/campaigns?acao=campanha_catalogo&brand=fish')).status,502);
  assert.equal(calls,16);
  const master={host:hosts.manager,cookieHeader:f.context.cookieHeader};assert.equal((await request(server,master,'/api/crm-read?action=cache_growth&painel=growth')).status,429);assert.equal(calls,16);
  for(const complete of completions.splice(0))complete();await new Promise(resolve=>setImmediate(resolve));assert.equal((await request(server,master,'/api/crm-read?action=cache_growth&painel=growth')).status,200);assert.equal(calls,17);
 }finally{globalThis.setTimeout=original;globalThis.clearTimeout=clear;}
});
