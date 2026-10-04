'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {fixture,hosts}=require('./helpers/crm-managed-read-auth-fixture.cjs');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs');
const B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs');
const A=require('../services/dashboard-operational/crm-audience-read-bridge.cjs');
const T=require('../services/dashboard-operational/crm-template-read-bridge.cjs');
const policy=require('../services/dashboard-operational/artifact-policy.cjs');
const manifest={schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns,campaigns_media:B.DESTINATIONS.campaigns_media}};
const audienceHost=new URL(A.DESTINATIONS['audience-read']).hostname;
function env(extra={}){return{DASHBOARD_MODE:'operational',DASHBOARD_MANAGER_HOST:hosts.manager,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:hosts.growth,organico:hosts.organico,influs:hosts.influs}),DASHBOARD_EMAIL_DOMAINS:'["synthetic.invalid"]',DASHBOARD_UPSTREAMS:JSON.stringify(B.DESTINATIONS),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host',audienceHost]),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify(manifest),DASHBOARD_CRM_MANAGED_READ:'enabled',DASHBOARD_CRM_MANAGED_READ_UI:'enabled',DASHBOARD_CRM_MANAGER_ISSUER_ID:crypto.randomUUID(),DASHBOARD_CRM_MANAGER_NAMESPACE_ID:crypto.randomUUID(),DASHBOARD_CRM_MANAGER_PROVISIONER_TOKEN:'synthetic'.repeat(8),...extra};}
function settings(f,extra={}){return{...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,upstreams:Object.fromEntries(Object.entries(B.DESTINATIONS).map(([k,v])=>[k,new URL(v)])),allowedUpstreamHosts:['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host',audienceHost],dynamicRouteManifest:manifest,publicDir:__dirname,...extra};}
async function ready(t,brand='fish'){const f=await fixture();t.after(()=>f.close());const email=brand+'-manager@synthetic.invalid',i=f.invite(email,'growth',brand);await f.accept(i);const login=await f.login(email),ctx=f.reader(login),op=f.queued(login.user.id),client=f.client(),prepared=await f.prepare(client,op);await f.commit(client,op,prepared.prepared);return{f,ctx,login};}
function server(f,fetchImpl,extra={}){return S.createServer(settings(f,extra),{auth:f.auth,fetchImpl,managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});}
function request(app,ctx,url,{method='GET',body,csrf,authorization}={}){return new Promise(resolve=>{const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);req.method=method;req.url=url;req.headers={host:ctx.host,cookie:ctx.cookieHeader,...(authorization?{authorization}:{}),...(body?{'content-type':'application/json',origin:'https://'+ctx.host,'x-csrf-token':csrf}:{})};req.socket={remoteAddress:'127.0.0.1'};const res=new EventEmitter();res.headers={};res.setHeader=(k,v)=>{res.headers[k]=v;};res.getHeader=k=>res.headers[k];res.end=bytes=>{res.writableEnded=true;res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};res.destroy=()=>{res.destroyed=true;resolve({status:500,body:{error:'TEST_DESTROYED'}});};app.emit('request',req,res);});}
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});
const fresh={contract:'crm-audience-read-freshness-v1',catalog_refreshed_at:'2026-10-03T11:59:00.000Z',catalog_expires_at:'2026-10-03T12:03:00.000Z',catalog_age_seconds:60,read_at:'2026-10-03T12:00:00.000Z',current:true,stale:false,coverage:'unconfirmed',schedule_proof:false};
const flags={selector_ready:false,execution_blocked:true,authorizes_selection:false,authorizes_send:false};
const lists=brand=>({brand,base_list_id:brand==='fish'?17:16,lists:[{id:brand==='fish'?17:16,brand,name:'Synthetic base',available:true}],freshness:fresh});
const context=(brand,id)=>({contract:'crm-audience-campaign-read-context-v1',brand,campaign_id:id,campaign_version:'a'.repeat(32),status:'draft',list_ids:[brand==='fish'?17:16],lists:[{id:brand==='fish'?17:16,name:'Synthetic base',available:true,in_brand:true}],list_only:true,binding_state:'none',binding:null,freshness:fresh,schedule_proof:false,...flags});

test('parity flags default OFF; each listener needs managed read, writes OFF and its explicit fixed host',()=>{
 const e=env(),off=S.settingsFromEnv(e);assert.equal(off.crmManagedAudienceRead,false);assert.equal(off.crmManagedTemplateRead,false);
 assert.equal(S.settingsFromEnv({...e,DASHBOARD_CRM_MANAGED_AUDIENCE_READ:'enabled'}).crmManagedAudienceRead,true);
 for(const delta of [{DASHBOARD_CRM_MANAGED_AUDIENCE_READ:'true'},{DASHBOARD_CRM_MANAGED_AUDIENCE_READ:'enabled',DASHBOARD_CRM_MANAGED_READ_UI:'disabled'},{DASHBOARD_CRM_MANAGED_AUDIENCE_READ:'enabled',DASHBOARD_CRM_DRAFT_WRITE:'enabled'},{DASHBOARD_CRM_MANAGED_AUDIENCE_READ:'enabled',DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host'])}])assert.throws(()=>S.settingsFromEnv({...e,...delta}));
 assert.throws(()=>S.settingsFromEnv({...e,DASHBOARD_CRM_MANAGED_TEMPLATE_READ:'enabled'}),/Managed template read host not admitted/);
 assert.equal(S.settingsFromEnv({...e,DASHBOARD_CRM_MANAGED_TEMPLATE_READ:'enabled',DASHBOARD_UPSTREAM_HOSTS:JSON.stringify([...JSON.parse(e.DASHBOARD_UPSTREAM_HOSTS),new URL(T.DESTINATIONS['template-read']).hostname])}).crmManagedTemplateRead,true);
});

test('audience GET uses the individual principal and canonical query for both brands; legacy slots and browser bearer are ignored',async t=>{
 const calls=[];
 for(const [brand,id] of [['fish',167],['aristo',168]]){
  const {f,ctx}=await ready(t,brand);const app=server(f,async(url,init)=>{const u=new URL(url);assert.equal(u.origin+u.pathname,A.DESTINATIONS['audience-read']);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,'Bearer '+f.auth.getUpstreamCredential(ctx));assert.equal(init.headers['Accept-Encoding'],'identity');assert.equal(init.headers.Cookie,undefined);assert.equal(init.headers.Origin,undefined);assert.equal(init.body,undefined);calls.push(u.href);return response(u.searchParams.get('acao')==='publicos_listas'?lists(u.searchParams.get('brand')):context(u.searchParams.get('brand'),Number(u.searchParams.get('campaign_id'))));},{crmManagedAudienceRead:true});
  assert.equal((await request(app,ctx,`/api/segments?brand=${brand}&acao=publicos_listas`,{authorization:'Bearer synthetic-browser-key'})).status,200);const r=await request(app,ctx,`/api/campaign_audience?campaign_id=${id}&brand=${brand}&acao=campanha_publico_contexto`);assert.equal(r.status,200);assert.equal(r.body.list_only,true);assert.equal(r.body.schedule_proof,false);assert.equal(r.body.authorizes_send,false);
  const before=calls.length,other=brand==='fish'?'aristo':'fish';assert.equal((await request(app,ctx,'/api/segments?acao=publicos_listas&brand='+other)).status,403);assert.equal(calls.length,before);assert.equal(app.listening,false);
 }
 assert.equal(calls.length,4);assert.equal(calls[0],A.DESTINATIONS['audience-read']+'?acao=publicos_listas&brand=fish');assert.equal(calls[1],A.DESTINATIONS['audience-read']+'?acao=campanha_publico_contexto&brand=fish&campaign_id=167');
});

test('OFF and invalid/write/receipt audience requests make no new backend request; template remains unavailable',async t=>{
 const {f,ctx,login}=await ready(t);let calls=0;const fetchImpl=async()=>{calls++;assert.fail('request must be refused before upstream');};
 const off=server(f,fetchImpl);assert.equal((await request(off,ctx,'/api/segments?acao=publicos_listas&brand=fish')).status,403);
 const on=server(f,fetchImpl,{crmManagedAudienceRead:true});
 for(const url of ['/api/segments?acao=publicos_listas&brand=olivas','/api/segments?acao=publicos_listas&brand=fish&brand=aristo','/api/segments?acao=publicos_listas&brand=fish&k=synthetic-browser-key','/api/segments?acao=segmento_operacao&brand=fish&idempotency_key=synthetic-operation-key','/api/campaign_audience?acao=campanha_publico_operacao&brand=fish&idempotency_key=synthetic-operation-key','/api/templates?acao=listar&marca=fish'])assert.ok([403,503].includes((await request(on,ctx,url)).status));
 assert.equal((await request(on,ctx,'/api/segments',{method:'POST',body:{acao:'segmento_criar',brand:'fish'},csrf:login.csrf})).status,403);assert.equal(calls,0);
 assert.throws(()=>server(f,fetchImpl,{crmManagedTemplateRead:true}),/Managed template read host not admitted/);
});

test('capabilities expose audience reads only to the ready manager, all writes false and template contract absent',async t=>{
 const {f,ctx}=await ready(t),source={crm_diario:[],crm_campanha:[],crm_fluxo:[],crm_conversao:[],crm_attribution:{schema_version:2,daily:[],quality:[],coverage:[]},capabilities:{endpoints:{read:B.DESTINATIONS['crm-read']},segments:{read:true,save:true,count:true,operation:true},campaign_audience:{read:true,inspect:true,operation:true,validate:true,bind:true,release:true},templates:{read_content:true,list_history:true,read_contract:'crm-template-read-v1'}}};
 const app=server(f,async()=>response(source),{crmManagedAudienceRead:true});
 const r=await request(app,ctx,'/api/crm-read?action=cache_growth&painel=growth');assert.equal(r.status,200);assert.equal(r.body.capabilities.endpoints.segments,'https://'+ctx.host+'/api/segments');assert.equal(r.body.capabilities.endpoints.campaign_audience,'https://'+ctx.host+'/api/campaign_audience');assert.deepEqual(r.body.capabilities.segments,{read:true,save:false,count:false,operation:false});assert.deepEqual(r.body.capabilities.campaign_audience,{read:true,inspect:false,operation:false,validate:false,bind:false,release:false});assert.equal(Object.hasOwn(r.body.capabilities.templates,'read_contract'),false);
 const master={host:hosts.manager,cookieHeader:f.context.cookieHeader};const own=await request(app,master,'/api/crm-read?action=cache_growth&painel=growth');assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.capabilities.endpoints.segments,undefined);assert.equal(own.body.capabilities.endpoints.campaign_audience,undefined);
 const off=await request(server(f,async()=>response(source)),ctx,'/api/crm-read?action=cache_growth&painel=growth');assert.equal(off.body.capabilities.endpoints.segments,undefined);assert.equal(Object.hasOwn(off.body.capabilities.templates,'read_contract'),false);
});

test('new read bridge shares the four-request lease; deadline cannot release a still-running fetch',async t=>{
 const {f,ctx}=await ready(t),oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;let calls=0;const finish=[];
 const app=server(f,()=>{calls++;return new Promise(resolve=>finish.push(()=>resolve(response(lists('fish')))));},{crmManagedAudienceRead:true});
 try{globalThis.setTimeout=(fn,delay)=>{assert.equal(delay,25000);queueMicrotask(fn);return{synthetic:true};};globalThis.clearTimeout=()=>{};
  for(let i=0;i<4;i++)assert.equal((await request(app,ctx,'/api/segments?acao=publicos_listas&brand=fish')).status,502);
  assert.equal((await request(app,ctx,'/api/segments?acao=publicos_listas&brand=fish')).status,429);assert.equal(calls,4);
  finish.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal((await request(app,ctx,'/api/segments?acao=publicos_listas&brand=fish')).status,502);assert.equal(calls,5);
 }finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;for(const done of finish)done();await new Promise(resolve=>setImmediate(resolve));}
});

test('existing managed media bridge applies strict validator, marks legacy and rejects foreign thumbnails before returning data',async t=>{
 const {f,ctx}=await ready(t),id='11111111-1111-4111-8111-111111111111',filename='crm-fish-'+id+'-'+'a'.repeat(64)+'.png';
 const item={id:1,filename,url:'https://email.shrigma.com.br/uploads/'+filename,thumb_url:'https://email.shrigma.com.br/uploads/thumb_'+filename,content_type:'image/png',width:10,height:10,created_at:'2026-10-03T00:00:00Z'};
 const body={contract:'crm-media-v1',brand:'fish',items:[item,{...item,id:2,filename:'legacy.png',url:'https://email.shrigma.com.br/uploads/legacy.png',thumb_url:null}],total:2,page:1,per_page:24,next_page:null};let sent;
 const upstreams=Object.fromEntries(Object.entries(B.DESTINATIONS).map(([k,v])=>[k,new URL(v)]));
 const read=value=>B.createManagedReadBridge({auth:f.auth,upstreams,enabled:true},{fetchImpl:async(url,init)=>{sent=String(url);assert.equal(init.method,'GET');return response(value);}}).read({context:ctx,route:'campaigns_media',method:'GET',query:new URLSearchParams({brand:'fish'}),origin:'https://'+ctx.host});
 const out=await read(body);assert.deepEqual(out.body.items.map(v=>[v.id,v.legacy]),[[1,false],[2,true]]);assert.equal(sent,B.DESTINATIONS.campaigns_media+'?brand=fish&page=1&per_page=24');
 await assert.rejects(read({...body,items:[{...item,thumb_url:item.thumb_url.replace('crm-fish-','crm-aristo-')}]}),{status:502,code:'MANAGED_READ_RESPONSE_DENIED'});
 await assert.rejects(read({contract:'crm-media-v1',brand:'fish',items:[]}),{status:502,code:'MANAGED_READ_RESPONSE_DENIED'});
});

test('complete bridge pack and both prior families are admitted; partial bridge family is refused without raising transport limit',()=>{
 const entry=p=>({path:p,encoding:policy.isText(p)?'utf8':'base64',content:policy.isText(p)?'SYNTHETIC':Buffer.from([0,1]).toString('base64')});
 for(const family of [policy.FILES,policy.PRE_PARITY_FILES,policy.LEGACY_FILES])assert.equal(policy.validateFiles(family.map(entry)).files,family.length);
 const partial=policy.PRE_PARITY_FILES.map(entry).concat(entry('runtime/crm-audience-read-bridge.cjs'));assert.throws(()=>policy.validateFiles(partial),/ARTIFACT_FILES_INVALID/);assert.equal(policy.MAX_PACK_BYTES,950000);assert.deepEqual(policy.READ_BRIDGE_RUNTIME_FILES,['crm-audience-read-bridge.cjs','crm-media-read-validator.cjs','crm-template-read-bridge.cjs']);
});
