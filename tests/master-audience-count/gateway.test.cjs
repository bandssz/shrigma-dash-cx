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
async function fixture(t,{count=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'master-audience-count-isolated-')),dbPath=path.join(dir,'identity.sqlite'),key='isolated-central-master-'+crypto.randomBytes(12).toString('hex');
 const env={DASHBOARD_CRM_JOURNEY_CONFIGURED_READ:'enabled',DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:email,DASHBOARD_BOOTSTRAP_SHA256:sha('isolated-bootstrap'),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_COUNT:count?'enabled':'disabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:dbPath,DASHBOARD_PUBLIC_DIR:dir};
 const settings=settingsFromEnv(env),auth=createAuth({...settings,crmNativeEnabled:true});
 t.after(()=>{auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 await auth.completeBootstrap({email,token:'isolated-bootstrap',password:'Isolated-Test-Password-2026!',host,origin});
 const login=await auth.login({email,password:'Isolated-Test-Password-2026!',host,origin}),ctx={cookieHeader:login.cookie.split(';')[0],host,origin,method:'POST',csrf:login.csrf},user=auth.session(ctx).user;
 auth.setUpstreamCredential({context:ctx,userId:user.id,slot:'growth-read',bearer:key});
 await auth.activateOwnMasterCampaignWriter({context:ctx,fetchImpl:async(url,opts)=>{a.equal(opts.headers.Authorization,'Bearer '+key);return originalResponse({schema:'shrigma_access_identity_v1',role:'master',panel:'todos',owner:email,allowedPanels:['cx','growth','organico','influs'],permissions:{growth:{who:'panel:isolated-principal-2026',label:email,caps:['read_content','draft','validate','submit']},influs:null}},url);}});
 await auth.setCrmPanelReadCredential({context:ctx,userId:user.id,slot:'crm-panel-read',bearer:key,fetchImpl:async(url)=>originalResponse({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:email,allowedPanels:['growth'],permissions:{growth:{who:'panel:isolated-reader',label:email,caps:['read_content','list_history','submission']},influs:null}},url)});
 const issued=auth.nativeConnections.issue({context:ctx,brands:['fish'],scopes:['crm.read','crm.draft'],expiresDays:1}),native=auth.nativeConnections.context(issued.token);
 let override=null;const calls=[];
 const server=createServer(settings,{auth,fetchImpl:async(url,options)=>{
  const u=new URL(url);calls.push({url:u.href,method:options.method});a.equal(options.headers.Origin,undefined);a.equal(options.headers.Cookie,undefined);a.equal(options.headers.Authorization,'Bearer '+key);
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

const Contract=require(path.join(runtime,'segment-audience-contract.js'));
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const definition=Contract.normalize({schema_version:Contract.VERSION,brand:'fish',name:'Existing isolated count fixture',rule:{op:'in_list',list_id:1}});
const result=r=>r.value.result.structuredContent;
const countRequest=(extra={})=>({acao:'segmento_contar',brand:'fish',id,expected_version:2,expected_catalog_hash:'a'.repeat(64),...extra});
function originalCounter(f){
 const record={id,brand:'fish',name:definition.name,definition,version:2,archived:false,created_at:'2026-10-07T21:00:00Z',updated_at:'2026-10-07T22:00:00Z',updated_by:'panel:isolated-original',semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:true}};
 let posts=0,reply=null,catalogHook=null,postHook=null,sourceCount=true,current=true,catalogHash='a'.repeat(64),recordVersion=2,throwCount=false;
 const response=()=>({source_confirmed:true,eligible_count:12,checked_at:new Date().toISOString(),definition,definition_hash:sha(canonical(definition)),base_list_id:1,transport_supported:false,unknown_reason:null,segment_id:id,version:2});
 f.override((u,o)=>{
  const action=u.searchParams.get('acao'),brand=u.searchParams.get('brand');
  if(o.method==='POST'){
   const p=JSON.parse(o.body);a.equal(p.acao,'segmento_contar');a.equal(p.brand,'fish');posts++;postHook?.();if(throwCount)throw Error('isolated count ACK lost');
   const b=reply?reply(response(),p):response();return originalResponse(b,u);
  }
  if(action==='segmento_obter')return originalResponse({segment:{...record,version:recordVersion}},u);
  a.equal(action,'segmentos_listar');catalogHook?.();const c=catalog(brand);c.limit=Number(u.searchParams.get('limit'));c.offset=Number(u.searchParams.get('offset'));c.catalog.current=current;c.catalog.catalog_hash=catalogHash;c.capabilities.count=current&&sourceCount;c.capabilities.draft=current;return originalResponse(c,u);
 });
 return {record,get posts(){return posts;},set reply(v){reply=v;},set catalogHook(v){catalogHook=v;},set postHook(v){postHook=v;},set sourceCount(v){sourceCount=v;},set current(v){current=v;},set catalogHash(v){catalogHash=v;},set recordVersion(v){recordVersion=v;},set throwCount(v){throwCount=v;}};
}
test('native detail counts the saved original version once and leaves record and operation journal intact',async t=>{
 const f=await fixture(t),s=originalCounter(f),before=JSON.stringify(s.record);
 const r=result(await f.rpc('fish','crm_audience_get',{id}));a.equal(r.status,200,JSON.stringify(r));a.equal(r.body.segment.version,2);a.equal(r.body.audienceCount.status,200,JSON.stringify(r));a.equal(r.body.audienceCount.body.eligible_count,12);a.equal(r.body.audienceCount.body.transport_supported,false);a.equal(s.posts,1);a.equal(JSON.stringify(s.record),before);a.equal(f.auth.audienceDraft(f.ctx,'fish'),null);
 a.deepEqual(f.calls.filter(c=>c.url.includes('/segments')).map(c=>[c.method,new URL(c.url).searchParams.get('acao')]),[['GET','segmento_obter'],['GET','segmentos_listar'],['GET','segmento_obter'],['GET','segmentos_listar'],['POST',null],['GET','segmentos_listar']]);
 a.equal(JSON.stringify(r).includes(f.key),false);a.equal(f.calls.some(c=>/operacao|contexto|send|submit/.test(c.url)),false);
});
test('count requires the explicit runtime flag; browser GET rereads without an implicit POST',async t=>{
 const disabled=await fixture(t,{count:false}),d=originalCounter(disabled);const r=result(await disabled.rpc('fish','crm_audience_get',{id}));a.equal(r.status,200);a.equal(r.body.audienceCount,undefined);a.equal(d.posts,0);a.equal((await disabled.browser('POST','/api/segments',countRequest())).status,403);
 const f=await fixture(t),s=originalCounter(f),read=await f.browser('GET','/api/segments?'+new URLSearchParams({acao:'segmento_obter',brand:'fish',id}));a.equal(read.status,200);a.equal(read.body.audienceCount,undefined);a.equal(s.posts,0);
 a.throws(()=>settingsFromEnv({...f.env,DASHBOARD_CRM_MASTER_AUDIENCE_WRITE:'disabled',DASHBOARD_CRM_MASTER_AUDIENCE_COUNT:'enabled'}));
});
test('current original source capability and request catalog hash are mandatory before counting',async t=>{
 for(const kind of ['sourceCount','current','catalogHash']){
  const f=await fixture(t),s=originalCounter(f);s[kind]=kind==='catalogHash'?'b'.repeat(64):false;
  const r=await f.browser('POST','/api/segments',countRequest());a.equal(r.status,kind==='catalogHash'?409:503,JSON.stringify({kind,result:r}));a.equal(s.posts,0);a.equal(f.auth.audienceDraft(f.ctx,'fish'),null);
 }
 const f=await fixture(t),s=originalCounter(f);s.sourceCount=false;const r=result(await f.rpc('fish','crm_audience_get',{id}));a.equal(r.body.audienceCount.status,503);a.equal(s.posts,0);const cat=result(await f.rpc('fish','crm_audience_catalog'));a.equal(cat.body.capabilities.count,false);a.equal(cat.body.capabilities.send,false);
});
test('saved version conflict prevents count; draft count binds the complete original definition',async t=>{
 const f=await fixture(t),s=originalCounter(f);s.recordVersion=3;const conflict=await f.browser('POST','/api/segments',countRequest());a.equal(conflict.status,409);a.equal(conflict.body.current_version,3);a.equal(s.posts,0);
 s.reply=(r,p)=>({...r,definition:p.definition,definition_hash:sha(canonical(p.definition)),segment_id:null,version:null});const draft=await f.browser('POST','/api/segments',{acao:'segmento_contar',brand:'fish',definition,expected_catalog_hash:'a'.repeat(64)});a.equal(draft.status,200,JSON.stringify(draft));a.equal(draft.body.segment_id,null);a.equal(s.posts,1);a.equal(s.record.version,2);a.equal(f.auth.audienceDraft(f.ctx,'fish'),null);
});
test('unknown count stays null and confirmed zero remains a distinct original fact',async t=>{
 const f=await fixture(t),s=originalCounter(f);s.reply=r=>({...r,source_confirmed:false,eligible_count:null,unknown_reason:'list_source_unavailable'});
 let r=await f.browser('POST','/api/segments',countRequest());a.equal(r.status,200);a.equal(r.body.eligible_count,null);a.equal(r.body.source_confirmed,false);
 s.reply=r=>({...r,eligible_count:0});r=await f.browser('POST','/api/segments',countRequest());a.equal(r.status,200);a.equal(r.body.eligible_count,0);a.equal(r.body.source_confirmed,true);a.equal(s.posts,2);
});
test('changed original private Master binding suppresses upstream work or returned count',async t=>{
 for(const phase of ['catalogHook','postHook']){
  const f=await fixture(t),s=originalCounter(f);s[phase]=()=>{const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE campaign_writer_attestation_v1 SET expires_at=1 WHERE user_id=?').run(f.user.id);db.close();};
  const r=await f.browser('POST','/api/segments',countRequest());a.equal(r.status,403);a.equal(r.body.eligible_count,undefined);a.equal(s.posts,phase==='postHook'?1:0);a.equal(f.auth.audienceDraft(f.ctx,'fish'),null);
 }
});
test('native brand denial is pre-dispatch and native revocation suppresses the count response',async t=>{
 const f=await fixture(t),s=originalCounter(f);a.equal(result(await f.rpc('aristo','crm_audience_get',{id})).error,'BRAND_DENIED');a.equal(f.calls.length,0);
 s.postHook=()=>f.auth.nativeConnections.revoke({context:f.ctx,connectionId:f.issued.connection.id});const r=result(await f.rpc('fish','crm_audience_get',{id}));a.equal(r.error,'NATIVE_AUTH_REQUIRED');a.equal(s.posts,1);a.equal(JSON.stringify(r).includes('eligible_count'),false);
});
test('unconfirmed or lost count returns a fixed failure without POST retry, journal, send or secret',async t=>{
 const f=await fixture(t),s=originalCounter(f);s.reply=r=>({...r,private_key:f.key});let r=await f.browser('POST','/api/segments',countRequest());a.equal(r.status,502);a.equal(JSON.stringify(r).includes(f.key),false);a.equal(r.body.eligible_count,undefined);a.equal(s.posts,1);
 s.throwCount=true;r=await f.browser('POST','/api/segments',countRequest());a.equal(r.status,502);a.equal(s.posts,2);a.equal(f.auth.audienceDraft(f.ctx,'fish'),null);a.equal(s.record.version,2);a.equal(f.calls.some(c=>/send|operacao|submit/.test(c.url)),false);
});

test('catalog changes during original count suppress the quantity with no count retry',async t=>{
 const f=await fixture(t),s=originalCounter(f);s.postHook=()=>{s.catalogHash='b'.repeat(64);};const r=await f.browser('POST','/api/segments',countRequest());a.equal(r.status,409);a.equal(r.body.error,'SEGMENT_CATALOG_CHANGED');a.equal(r.body.eligible_count,undefined);a.equal(s.posts,1);a.equal(f.auth.audienceDraft(f.ctx,'fish'),null);
});
