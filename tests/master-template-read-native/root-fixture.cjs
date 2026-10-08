'use strict';
// Isolated source/runtime fixtures only. No production identity or network.
const a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.MASTER_TEMPLATE_READ_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createAuth}=require(path.join(runtime,'auth.cjs'));
const {createServer,settingsFromEnv}=require(path.join(runtime,'server.cjs'));
const {ENDPOINT}=require(path.join(runtime,'crm-native-mcp.cjs'));
const P=require(path.join(runtime,'proxy.cjs'));
const host='gerencial.shrigma.com.br',origin='https://'+host,email='felipebandeira@oaristocrata.com',sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function originalResponse(value,url){const r=new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r;}
function catalog(brand){return {segments:[],limit:50,offset:0,catalog:{brand,current:true,currency:'BRL',timezone:'America/Sao_Paulo',shop_id:'gid://shopify/Shop/42',fields:[],products:[],origins:[],lists:[{id:1,brand,name:'ISOLATED fixture',available:true}],coverage:'unconfirmed',checked_at:'2026-10-07T22:00:00Z',catalog_hash:'a'.repeat(64)},capabilities:{draft:true,count:true,send:false}};}
async function fixture(t,{enabled=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'master-audience-isolated-')),dbPath=path.join(dir,'identity.sqlite'),key='isolated-central-master-'+crypto.randomBytes(12).toString('hex');
 const env={DASHBOARD_CRM_MASTER_TEMPLATE_READ:'enabled',DASHBOARD_CRM_PUBLISHED_JOURNEY_READ:'enabled',DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:email,DASHBOARD_BOOTSTRAP_SHA256:sha('isolated-bootstrap'),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:dbPath,DASHBOARD_PUBLIC_DIR:dir};
 if(!enabled)env.DASHBOARD_CRM_MASTER_TEMPLATE_READ='disabled';
 const settings=settingsFromEnv(env),auth=createAuth({...settings,crmNativeEnabled:true});
 t.after(()=>{auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 await auth.completeBootstrap({email,token:'isolated-bootstrap',password:'Isolated-Test-Password-2026!',host,origin});
 const login=await auth.login({email,password:'Isolated-Test-Password-2026!',host,origin}),ctx={cookieHeader:login.cookie.split(';')[0],host,origin,method:'POST',csrf:login.csrf},user=auth.session(ctx).user;
 auth.setUpstreamCredential({context:ctx,userId:user.id,slot:'growth-read',bearer:key});
 // Model the inherited read credential through its existing attestation API.
 // This isolated response is never sent to, or installed in, production.
 await auth.setCrmPanelReadCredential({context:ctx,userId:user.id,slot:'crm-panel-read',bearer:key,fetchImpl:async(url,opts)=>{a.equal(opts.headers.Authorization,'Bearer '+key);return originalResponse({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:email,allowedPanels:['growth'],permissions:{growth:{who:'panel:isolated-read-2026',label:email,caps:['read_content']},influs:null}},url);}});
 await auth.activateOwnMasterCampaignWriter({context:ctx,fetchImpl:async(url,opts)=>{a.equal(opts.headers.Authorization,'Bearer '+key);return originalResponse({schema:'shrigma_access_identity_v1',role:'master',panel:'todos',owner:email,allowedPanels:['cx','growth','organico','influs'],permissions:{growth:{who:'panel:isolated-principal-2026',label:email,caps:['read_content','draft','validate','submit']},influs:null}},url);}});
 const issued=auth.nativeConnections.issue({context:ctx,brands:['fish'],scopes:['crm.read'],expiresDays:1}),native=auth.nativeConnections.context(issued.token);
 let override=null;const calls=[];
 const server=createServer(settings,{auth,fetchImpl:async(url,options)=>{
  const u=new URL(url);calls.push({url:u.href,method:options.method});a.equal(options.headers.Origin,undefined);a.equal(options.headers.Cookie,undefined);a.equal(options.headers.Authorization,'Bearer '+key);
  if(u.pathname==='/webhook/crm-template-api-242c0db6ddb8'){if(override)return override(u,options);return u.searchParams.get('acao')==='listar'?originalResponse({templates:[{key:'fish:email:42',brand:'fish',channel:'email',id:'42',name:'ISOLATED synthetic email',draft_id:null,status:'APPROVED',components:{subject:'Synthetic fixture',body_html:'<p>Isolated content</p>'},updated_at:'2026-10-08T15:00:00Z'}],consultado_em:'2026-10-08T15:00:00Z'},u):originalResponse({flows:[],checked_at:'2026-10-08T15:00:00Z'},u);}
  if(u.pathname==='/segments'){if(override)return override(u,options);return originalResponse(catalog(u.searchParams.get('brand')),u);}
  if(u.searchParams.get('acao')==='campanha_catalogo')return originalResponse({brand:u.searchParams.get('brand'),lists:[],templates:[],capabilities:{}},u);
  return originalResponse({_painel:'todos',_escopo:'growth',capabilities:{},data:{}},u);
 }});
 t.after(()=>server.close());
 const rpc=async(brand='fish',name='crm_template_catalog')=>{
  const {Readable,Writable}=require('node:stream'),req=Readable.from([Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:name==='crm_status'?{}:{brand}}}))]);req.method='POST';req.url=ENDPOINT;req.headers={host,origin,authorization:'Bearer '+issued.token,'content-type':'application/json',accept:'application/json, text/event-stream'};req.socket={remoteAddress:'isolated-native-test'};
  const chunks=[],res=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});res.statusCode=200;res.setHeader=()=>{};res.getHeader=()=>undefined;const done=new Promise(resolve=>res.once('finish',resolve));server.emit('request',req,res);await done;return {status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString())};
 };
 const browser=async(method,p,body)=>{
  const {Readable,Writable}=require('node:stream'),req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=p;req.headers={host,cookie:ctx.cookieHeader,accept:'application/json',...(method==='POST'?{origin,'x-csrf-token':ctx.csrf}:{}),...(body?{'content-type':'application/json'}:{})};req.socket={remoteAddress:'isolated-browser-test'};
  const chunks=[],res=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});res.statusCode=200;res.setHeader=()=>{};res.getHeader=()=>undefined;const done=new Promise(resolve=>res.once('finish',resolve));server.emit('request',req,res);await done;return {status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())};
 };
 return {env,settings,auth,ctx,key,user,issued,calls,rpc,browser,override:fn=>{override=fn;},dbPath};
}


module.exports={fixture,originalResponse,DatabaseSync,settingsFromEnv,runtime,host,origin,email,sha};
