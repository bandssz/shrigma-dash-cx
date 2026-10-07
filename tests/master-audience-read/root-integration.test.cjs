'use strict';
// Isolated source/runtime fixtures only. No production identity or network.
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.MASTER_AUDIENCE_TEST_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createAuth}=require(path.join(runtime,'auth.cjs'));
const {createServer,settingsFromEnv,environmentForOriginalMasterAudienceRead}=require(path.join(runtime,'server.cjs'));
const {ENDPOINT}=require(path.join(runtime,'crm-native-mcp.cjs'));
const P=require(path.join(runtime,'proxy.cjs'));
const host='gerencial.shrigma.com.br',origin='https://'+host,email='felipebandeira@oaristocrata.com',sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function originalResponse(value,url){const r=new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r;}
function catalog(brand){return {segments:[],limit:50,offset:0,catalog:{brand,current:true,currency:'BRL',timezone:'America/Sao_Paulo',shop_id:'gid://shopify/Shop/42',fields:[],products:[],origins:[],lists:[{id:1,brand,name:'ISOLATED fixture',available:true}],coverage:'unconfirmed',checked_at:'2026-10-07T22:00:00Z',catalog_hash:'a'.repeat(64)},capabilities:{draft:true,count:true,send:false}};}
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'master-audience-isolated-')),dbPath=path.join(dir,'identity.sqlite'),key='isolated-central-master-'+crypto.randomBytes(12).toString('hex');
 const env={DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:email,DASHBOARD_BOOTSTRAP_SHA256:sha('isolated-bootstrap'),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:dbPath,DASHBOARD_PUBLIC_DIR:dir};
 const settings=settingsFromEnv(env),auth=createAuth({...settings,crmNativeEnabled:true});
 t.after(()=>{auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 await auth.completeBootstrap({email,token:'isolated-bootstrap',password:'Isolated-Test-Password-2026!',host,origin});
 const login=await auth.login({email,password:'Isolated-Test-Password-2026!',host,origin}),ctx={cookieHeader:login.cookie.split(';')[0],host,origin,method:'POST',csrf:login.csrf},user=auth.session(ctx).user;
 auth.setUpstreamCredential({context:ctx,userId:user.id,slot:'growth-read',bearer:key});
 await auth.activateOwnMasterCampaignWriter({context:ctx,fetchImpl:async(url,opts)=>{a.equal(opts.headers.Authorization,'Bearer '+key);return originalResponse({schema:'shrigma_access_identity_v1',role:'master',panel:'todos',owner:email,allowedPanels:['cx','growth','organico','influs'],permissions:{growth:{who:'panel:isolated-principal-2026',label:email,caps:['read_content','draft','validate','submit']},influs:null}},url);}});
 const issued=auth.nativeConnections.issue({context:ctx,brands:['fish'],scopes:['crm.read'],expiresDays:1}),native=auth.nativeConnections.context(issued.token);
 let override=null;const calls=[];
 const server=createServer(settings,{auth,fetchImpl:async(url,options)=>{
  const u=new URL(url);calls.push({url:u.href,method:options.method});a.equal(options.headers.Origin,undefined);a.equal(options.headers.Cookie,undefined);a.equal(options.headers.Authorization,'Bearer '+key);
  if(u.pathname==='/segments'){if(override)return override(u,options);return originalResponse(catalog(u.searchParams.get('brand')),u);}
  if(u.searchParams.get('acao')==='campanha_catalogo')return originalResponse({brand:u.searchParams.get('brand'),lists:[],templates:[],capabilities:{}},u);
  return originalResponse({_painel:'todos',_escopo:'growth',capabilities:{},data:{}},u);
 }});
 t.after(()=>server.close());
 const rpc=async(brand='fish')=>{
  const {Readable,Writable}=require('node:stream'),req=Readable.from([Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'crm_campaign_catalog',arguments:{brand}}}))]);req.method='POST';req.url=ENDPOINT;req.headers={host,origin,authorization:'Bearer '+issued.token,'content-type':'application/json',accept:'application/json, text/event-stream'};req.socket={remoteAddress:'isolated-native-test'};
  const chunks=[],res=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});res.statusCode=200;res.setHeader=()=>{};res.getHeader=()=>undefined;const done=new Promise(resolve=>res.once('finish',resolve));server.emit('request',req,res);await done;return {status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString())};
 };
 const browser=async(method,p,body)=>{
  const {Readable,Writable}=require('node:stream'),req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=p;req.headers={host,origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf,...(body?{'content-type':'application/json'}:{})};req.socket={remoteAddress:'isolated-browser-test'};
  const chunks=[],res=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});res.statusCode=200;res.setHeader=()=>{};res.getHeader=()=>undefined;const done=new Promise(resolve=>res.once('finish',resolve));server.emit('request',req,res);await done;return {status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())};
 };
 return {env,settings,auth,ctx,key,user,issued,calls,rpc,browser,override:fn=>{override=fn;},dbPath};
}
test('original Master native catalog reads the pinned service with the current original credential; returns metadata only',async t=>{
 const f=await fixture(t),r=await f.rpc();a.equal(r.status,200);const v=r.value.result.structuredContent;a.equal(v.status,200);const s=v.body.audienceSource;a.equal(s.status,200);a.equal(s.brand,'fish');a.equal(s.gatewayWrite,false);a.equal(s.originalDraftAuthorized,true);a.equal(s.originalCountAuthorized,true);a.equal(s.countReturned,0);a.equal(s.operational,false);a.equal(f.calls.filter(c=>c.url.includes('/segments')).length,1);for(const secret of [f.key,f.issued.token,f.ctx.cookieHeader,f.ctx.csrf,'ISOLATED fixture'])a.equal(JSON.stringify(r).includes(secret),false);
 const read=await f.browser('GET','/api/segments?acao=segmentos_listar&brand=aristo&offset=0&limit=50');a.equal(read.status,200);a.equal(read.body.catalog.brand,'aristo');a.deepEqual(read.body.capabilities,{draft:false,count:false,send:false});a.equal(read.body.read_admission,undefined);
 const cache=await f.browser('GET','/api/crm-read?action=cache_growth&painel=growth');a.equal(cache.status,503); // no installed crm-panel-read fixture credential
 const rewritten=P.rewriteCapabilities({capabilities:{}},f.settings.upstreams,origin,{route:'crm-read',ownMasterAudienceRead:true});a.equal(rewritten.capabilities.segments.read,true);a.equal(rewritten.capabilities.segments.save,false);a.equal(rewritten.capabilities.segments.operation,false);
});
test('native brand scope and public READ-only routes deny mutations before an upstream call',async t=>{
 const f=await fixture(t),cross=await f.rpc('aristo');a.equal(cross.value.result.structuredContent.error,'BRAND_DENIED');a.equal(f.calls.length,0);
 const denied=await f.browser('POST','/api/segments',{acao:'segmento_arquivar',brand:'fish',id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',expected_version:1,idempotency_key:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'});a.equal(denied.status,403);a.equal(denied.body.error,'EDIT_NOT_READY');a.equal(f.calls.length,0);
 const context=await f.browser('GET','/api/segments?acao=segmento_contexto_v2&brand=fish');a.equal(context.status,403);a.equal(f.calls.length,0);
});
test('revocation while original audience GET is running suppresses its catalog and all metadata',async t=>{
 const f=await fixture(t);f.override(u=>{f.auth.nativeConnections.revoke({context:f.ctx,connectionId:f.issued.connection.id});return originalResponse(catalog('fish'),u);});const r=await f.rpc();a.equal(r.value.result.structuredContent.error,'NATIVE_AUTH_REQUIRED');a.equal(JSON.stringify(r).includes('catalog_hash'),false);
});
test('expired or tampered original credential attestation denies reads without widening a slot',async t=>{
 const f=await fixture(t),db=new DatabaseSync(f.dbPath);db.prepare('UPDATE campaign_writer_attestation_v1 SET expires_at=1 WHERE user_id=?').run(f.user.id);db.close();const r=await f.browser('GET','/api/segments?acao=segmentos_listar&brand=fish&offset=0&limit=50');a.equal(r.status,403);a.equal(r.body.error,'CREDENTIAL_ATTESTATION_REQUIRED');a.equal(f.calls.length,0);a.equal(f.auth.audienceDraftReady({...f.ctx,method:'GET'}),false);
});
test('foreign source brand and echoed private original key become fixed errors without payload leakage',async t=>{
 const f=await fixture(t);for(const body of [catalog('aristo'),{...catalog('fish'),catalog:{...catalog('fish').catalog,lists:[{id:1,brand:'fish',name:f.key,available:true}]}}]){f.override(u=>originalResponse(body,u));const r=await f.browser('GET','/api/segments?acao=segmentos_listar&brand=fish&offset=0&limit=50');a.equal(r.status,502);for(const x of [f.key,'catalog_hash'])a.equal(JSON.stringify(r).includes(x),false);}
});
test('configuration refuses an audience route without separate original Master READ admission',async t=>{
 const f=await fixture(t);a.throws(()=>settingsFromEnv({...f.env,DASHBOARD_CRM_MASTER_AUDIENCE_READ:'disabled'}));a.throws(()=>settingsFromEnv({...f.env,DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_CRM_AUDIENCE_DRAFT:'enabled'}));a.throws(()=>settingsFromEnv({...f.env,DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:undefined}));
});

test('fresh READ projection follows existing-grant verification without changing its historical source or replaying operation',async t=>{
 const f=await fixture(t),routes=JSON.parse(f.env.DASHBOARD_UPSTREAMS);delete routes.segments;const manifest=JSON.parse(f.env.DASHBOARD_DYNAMIC_ROUTE_MANIFEST);delete manifest.routes.segments;
 const preserved={...f.env,DASHBOARD_UPSTREAMS:JSON.stringify(routes),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify(manifest)},before=JSON.stringify(preserved),next=environmentForOriginalMasterAudienceRead(preserved);
 a.equal(JSON.stringify(preserved),before);a.equal(JSON.parse(next.DASHBOARD_UPSTREAMS).segments,P.REVIEWED_DYNAMIC.routes.segments);a.equal(next.DASHBOARD_CRM_AUDIENCE_DRAFT,undefined);a.equal(next.DASHBOARD_ENCRYPTION_KEY,preserved.DASHBOARD_ENCRYPTION_KEY);a.equal(settingsFromEnv(next).crmAudienceDraft,false);
 a.equal(environmentForOriginalMasterAudienceRead({...preserved,DASHBOARD_CRM_MASTER_AUDIENCE_READ:'disabled'}).DASHBOARD_UPSTREAMS,preserved.DASHBOARD_UPSTREAMS);
 a.throws(()=>environmentForOriginalMasterAudienceRead({...preserved,DASHBOARD_UPSTREAMS:JSON.stringify({...routes,segments:'https://foreign.invalid/segments'})}));
});
