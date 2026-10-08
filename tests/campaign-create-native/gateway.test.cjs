'use strict';
// Isolated source/runtime fixtures only. No production identity or network.
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.CAMPAIGN_CREATE_TEST_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createAuth}=require(path.join(runtime,'auth.cjs'));
const {createServer,settingsFromEnv,environmentForOriginalMasterAudienceRead,environmentForOriginalMasterCampaignCreate}=require(path.join(runtime,'server.cjs'));
const {ENDPOINT}=require(path.join(runtime,'crm-native-mcp.cjs'));
const P=require(path.join(runtime,'proxy.cjs'));
const host='gerencial.shrigma.com.br',origin='https://'+host,email='felipebandeira@oaristocrata.com',sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function originalResponse(value,url){const r=new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r;}
function catalog(brand){return {segments:[],limit:50,offset:0,catalog:{brand,current:true,currency:'BRL',timezone:'America/Sao_Paulo',shop_id:'gid://shopify/Shop/42',fields:[],products:[],origins:[],lists:[{id:1,brand,name:'ISOLATED fixture',available:true}],coverage:'unconfirmed',checked_at:'2026-10-07T22:00:00Z',catalog_hash:'a'.repeat(64)},capabilities:{draft:true,count:true,send:false}};}
async function fixture(t,{write=true,create=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'master-audience-isolated-')),dbPath=path.join(dir,'identity.sqlite'),key='isolated-central-master-'+crypto.randomBytes(12).toString('hex');
 const env={DASHBOARD_CRM_JOURNEY_CONFIGURED_READ:'enabled',DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:email,DASHBOARD_BOOTSTRAP_SHA256:sha('isolated-bootstrap'),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_CORPORATE_CREATE:create?'enabled':'disabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_WRITE:write?'enabled':'disabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:dbPath,DASHBOARD_PUBLIC_DIR:dir};
 const projected=environmentForOriginalMasterCampaignCreate(env,{...env,DASHBOARD_CRM_CORPORATE_CREATE:'disabled'});
 const settings=settingsFromEnv(projected),auth=createAuth({...settings,crmNativeEnabled:true});
 t.after(()=>{auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 await auth.completeBootstrap({email,token:'isolated-bootstrap',password:'Isolated-Test-Password-2026!',host,origin});
 const login=await auth.login({email,password:'Isolated-Test-Password-2026!',host,origin}),ctx={cookieHeader:login.cookie.split(';')[0],host,origin,method:'POST',csrf:login.csrf},user=auth.session(ctx).user;
 auth.setUpstreamCredential({context:ctx,userId:user.id,slot:'growth-read',bearer:key});
 await auth.activateOwnMasterCampaignWriter({context:ctx,fetchImpl:async(url,opts)=>{a.equal(opts.headers.Authorization,'Bearer '+key);return originalResponse({schema:'shrigma_access_identity_v1',role:'master',panel:'todos',owner:email,allowedPanels:['cx','growth','organico','influs'],permissions:{growth:{who:'panel:isolated-principal-2026',label:email,caps:['read_content','draft','validate','submit']},influs:null}},url);}});
 await auth.setCrmPanelReadCredential({context:ctx,userId:user.id,slot:'crm-panel-read',bearer:key,fetchImpl:async(url)=>originalResponse({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:email,allowedPanels:['growth'],permissions:{growth:{who:'panel:isolated-reader',label:email,caps:['read_content','list_history','submission']},influs:null}},url)});
 const issued=auth.nativeConnections.issue({context:ctx,brands:['fish'],scopes:['crm.read','crm.draft'],expiresDays:1}),native=auth.nativeConnections.context(issued.token);
 let override=null;const calls=[];
 const server=createServer(settings,{auth,fetchImpl:async(url,options)=>{
  const u=new URL(url);calls.push({url:u.href,method:options.method});a.equal(options.headers.Origin,undefined);a.equal(options.headers.Cookie,undefined);if(options.method==='POST')a.equal(JSON.parse(options.body).k,key);else a.equal(options.headers.Authorization,'Bearer '+key);
  if(override)return override(u,options);
  if(u.pathname==='/segments'){if(override)return override(u,options);return originalResponse(catalog(u.searchParams.get('brand')),u);}
  if(u.searchParams.get('acao')==='campanha_catalogo')return originalResponse({brand:u.searchParams.get('brand'),lists:[],templates:[],capabilities:{}},u);
  return originalResponse({_painel:'todos',_escopo:'growth',capabilities:{},data:{}},u);
 }});
 t.after(()=>server.close());
 const rpc=async(brand='fish',name='crm_campaign_catalog',args={})=>{
  const {Readable,Writable}=require('node:stream'),req=Readable.from([Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{brand,...args}}}))]);req.method='POST';req.url=ENDPOINT;req.headers={host,origin,authorization:'Bearer '+issued.token,'content-type':'application/json',accept:'application/json, text/event-stream'};req.socket={remoteAddress:'isolated-native-test'};
  const chunks=[],res=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});res.statusCode=200;res.setHeader=()=>{};res.getHeader=()=>undefined;const done=new Promise(resolve=>res.once('finish',resolve));server.emit('request',req,res);await done;return {status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString())};
 };
 const browser=async(method,p,body)=>{
  const {Readable,Writable}=require('node:stream'),req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=p;req.headers={host,origin,cookie:ctx.cookieHeader,'x-csrf-token':ctx.csrf,...(body?{'content-type':'application/json'}:{})};req.socket={remoteAddress:'isolated-browser-test'};
  const chunks=[],res=new Writable({write(c,e,cb){chunks.push(Buffer.from(c));cb();}});res.statusCode=200;res.setHeader=()=>{};res.getHeader=()=>undefined;const done=new Promise(resolve=>res.once('finish',resolve));server.emit('request',req,res);await done;return {status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())};
 };
 return {env,settings,auth,ctx,key,user,issued,calls,rpc,browser,override:fn=>{override=fn;},dbPath};
}

const C=require(path.join(runtime,'campaign-write-contract.js')),T=require(path.join(runtime,'campaign-write-tracking.js'));
const result=r=>r.value.result.structuredContent;
function definition(){return {schema_version:C.VERSION,brand:'fish',channel:'email',initiative:{key:'isolated-fixture',name:'Isolated source fixture'},utm_campaign:'isolated-fixture',name:'Isolated unscheduled draft',subject:'Source fixture',from_email:'source@fishermans.com.br',reply_to:'source@fishermans.com.br',list_ids:[1],template_id:1,html:'<a href="https://fishermans.com.br/products/source-fixture">Fixture</a><a href="{{ UnsubscribeURL }}">Sair</a>',text:'https://fishermans.com.br/products/source-fixture {{ UnsubscribeURL }}',tags:[],send_at:null};}
function originalCampaign(f,{lost=false}={}){
 const catalog={brand:'fish',current:true,lists:[{id:1,brand:'fish',name:'ISOLATED list',available:true}],templates:[{id:1,brand:'fish',name:'ISOLATED template',type:'campaign',available:true,version:'a'.repeat(32)}],initiatives:[]};
 const operations=new Map(),calls=[];let saved=null,posts=0;
 f.override((u,o)=>{
  const body=o.method==='POST'?JSON.parse(o.body):null,action=body?.acao||u.searchParams.get('acao');calls.push({method:o.method,action});
  if(action==='campanha_catalogo')return originalResponse(catalog,u);
  if(action==='campanha_salvar'){
   posts++;a.equal(body.id,undefined);a.equal(body.definition.send_at,null);
   const id=701,at=new Date().toISOString(),operationId=crypto.randomUUID(),prepared=C.prepare(body.definition,{catalog,tracking:T,trackingId:id});
   saved={id,version:'b'.repeat(32),status:'draft',sent:0,started_at:null,send_at:null,definition:prepared.definition};
   const receipt={status:201,body:{campaign:saved,tracking:prepared.tracking,operation_id:operationId}};
   operations.set(body.idempotency_key,{id:operationId,operation_key:body.idempotency_key,brand:'fish',action:'salvar',state:'succeeded',providerId:id,response:receipt,created_at:at,updated_at:at});
   if(lost)throw Error('Isolated lost POST ACK after commit');
   return originalResponse(receipt.body,u);
  }
  if(action==='campanha_operacao'){const op=operations.get(u.searchParams.get('idempotency_key'));return op?originalResponse({operation:op},u):originalResponse({error:'OPERATION_NOT_FOUND'},u);}
  if(action==='campanha_obter'){a.equal(Number(u.searchParams.get('id')),saved.id);return originalResponse({campaign:saved},u);}
  throw Error('Unexpected source fixture action');
 });
 return {calls,operations,get saved(){return saved;},get posts(){return posts;}};
}
test('Root wiring admits native create through original Master dispatcher, persisted journal and exact original receipt',async t=>{
 const f=await fixture(t),s=originalCampaign(f),idempotency_key='root-native-create-positive';
 const created=result(await f.rpc('fish','crm_campaign_create',{definition:definition(),idempotency_key}));
 a.equal(created.status,200,JSON.stringify(created));a.equal(created.body.state,'succeeded');a.equal(created.body.campaign.id,701);a.equal(s.posts,1);a.equal(s.saved.sent,0);a.equal(s.saved.send_at,null);
 const db=new DatabaseSync(f.dbPath),row=db.prepare('SELECT * FROM crm_campaign_create_v1 WHERE user_id=? AND client_key=?').get(f.user.id,idempotency_key);a.equal(row.phase,'succeeded');a.equal(row.campaign_id,701);a.notEqual(row.remote_key,idempotency_key);db.close();
 const read=result(await f.rpc('fish','crm_campaign_create_operation',{idempotency_key}));a.equal(read.body.state,'succeeded');a.deepEqual(read.body.campaign,created.body.campaign);a.equal(s.posts,1);a.equal(JSON.stringify(read).includes(f.key),false);
 a.deepEqual(s.calls.map(x=>[x.method,x.action]),[['GET','campanha_catalogo'],['POST','campanha_salvar'],['GET','campanha_operacao'],['GET','campanha_obter'],['GET','campanha_operacao'],['GET','campanha_obter']]);
});
test('lost original create ACK leaves one pending intention; native GET resolves it without another POST',async t=>{
 const f=await fixture(t),s=originalCampaign(f,{lost:true}),idempotency_key='root-native-create-lost-ack',args={definition:definition(),idempotency_key};
 const lost=result(await f.rpc('fish','crm_campaign_create',args));a.equal(lost.status,202,JSON.stringify(lost));a.equal(lost.body.state,'pending');a.equal(s.posts,1);
 const replacement=result(await f.rpc('fish','crm_campaign_create',{...args,idempotency_key:'root-native-create-replacement'}));a.equal(replacement.status,409);a.equal(s.posts,1);
 const read=result(await f.rpc('fish','crm_campaign_create_operation',{idempotency_key}));a.equal(read.status,200,JSON.stringify(read));a.equal(read.body.state,'succeeded');a.equal(s.posts,1);
});
test('Root flag disabled refuses creation while same-intent GET remains routed to the original journal',async t=>{
 const f=await fixture(t,{create:false}),s=originalCampaign(f),idempotency_key='root-native-create-disabled';
 const off=result(await f.rpc('fish','crm_campaign_create',{definition:definition(),idempotency_key}));a.equal(off.status>=400,true,JSON.stringify(off));a.equal(s.posts,0);
 const read=result(await f.rpc('fish','crm_campaign_create_operation',{idempotency_key}));a.equal(read.status,404,JSON.stringify(read));a.equal(s.calls.length,0);
});
test('original gateway refuses cross-brand and scheduled definitions before any original campaign mutation',async t=>{
 const f=await fixture(t),s=originalCampaign(f);
 for(const d of [{...definition(),brand:'aristo'},{...definition(),send_at:'2026-11-01T12:00:00Z'}]){
  const r=result(await f.rpc('fish','crm_campaign_create',{definition:d,idempotency_key:'root-native-create-invalid'}));a.equal(r.status>=400,true,JSON.stringify(r));
 }
 a.equal(s.posts,0);a.equal(s.calls.length,0);
});
test('new startup opt-in preserves current writer requirements and refuses malformed flag without changing historical verifier',async t=>{
 const f=await fixture(t),preserved={...f.env,DASHBOARD_CRM_CORPORATE_CREATE:'disabled'};
 for(const requested of [{},{DASHBOARD_CRM_CORPORATE_CREATE:'disabled'}])a.equal(environmentForOriginalMasterCampaignCreate(requested,preserved),preserved);
 a.throws(()=>environmentForOriginalMasterCampaignCreate({DASHBOARD_CRM_CORPORATE_CREATE:'true'},preserved));
 a.throws(()=>environmentForOriginalMasterCampaignCreate({DASHBOARD_CRM_CORPORATE_CREATE:'enabled'},{...preserved,DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'disabled'}));
 a.equal(preserved.DASHBOARD_CRM_CORPORATE_CREATE,'disabled');a.equal(f.calls.length,0);
});
