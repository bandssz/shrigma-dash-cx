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
async function fixture(t,{context=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'master-audience-context-isolated-')),dbPath=path.join(dir,'identity.sqlite'),key='isolated-central-master-'+crypto.randomBytes(12).toString('hex');
 const env={DASHBOARD_CRM_JOURNEY_CONFIGURED_READ:'enabled',DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:email,DASHBOARD_BOOTSTRAP_SHA256:sha('isolated-bootstrap'),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_COUNT:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_CONTEXT_REVIEW:context?'enabled':'disabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:dbPath,DASHBOARD_PUBLIC_DIR:dir};
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



const Contract=require(path.join(runtime,'segment-audience-contract.js')),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',hash='a'.repeat(64);
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const result=r=>r.value.result.structuredContent,request=()=>'/api/segments?'+new URLSearchParams({acao:'segmento_contexto_revisao',brand:'fish',id,expected_version:'2',expected_catalog_hash:hash});
function source(f,{unavailable=true,current=false}={}){
 const definition=Contract.normalize({schema_version:Contract.VERSION,brand:'fish',name:'Saved fixture context',rule:{op:'confirmed',rule:{op:'condition',field:'purchase.count',operator:'eq',value:0}}}),record={id,brand:'fish',name:definition.name,definition,version:2,archived:false,created_at:'2026-10-07T21:00:00Z',updated_at:'2026-10-07T22:00:00Z',updated_by:'panel:isolated-original',semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:false}};
 let gets=0,mutate=null,hook=null;
 f.override((u,o)=>{a.equal(o.method,'GET');gets++;hook?.(gets);const action=u.searchParams.get('acao');
 if(action==='segmento_obter')return originalResponse({segment:record},u);
 if(action==='segmentos_listar'){const c=catalog('fish');c.limit=Number(u.searchParams.get('limit'));c.offset=0;c.catalog.fields=[{key:'purchase.count',available:!unavailable,source_hash:'d'.repeat(64)}];return originalResponse(c,u);}
 a.equal(action,'segmento_contexto_revisao');const b={context_review:{schema:'crm-audience-context-review-v2',brand:'fish',id,version:2,definition_hash:sha(canonical(definition)),stored_context_hash:'b'.repeat(64),current_context_hash:current?'b'.repeat(64):'c'.repeat(64),catalog_hash:hash,checked_at:new Date().toISOString(),context_current:current,changes:current?[]:[{path:'rules[0].source_hash',before:'b'.repeat(64),after:'d'.repeat(64)}],authorizes_refresh:false,transport_supported:false,source_ready:!unavailable,unavailable_fields:unavailable?['purchase.count']:[]}};mutate?.(b);return originalResponse(b,u);
 });return {record,get gets(){return gets;},set mutate(x){mutate=x;},set hook(x){hook=x;}};
}
test('expired original field remains unavailable while factual pin differences can be read',async t=>{const f=await fixture(t),s=source(f),before=JSON.stringify(s.record),r=await f.browser('GET',request());a.equal(r.status,200,JSON.stringify(r));a.equal(r.body.context_review.source_ready,false);a.deepEqual(r.body.context_review.unavailable_fields,['purchase.count']);a.equal(r.body.context_review.authorizes_refresh,false);a.equal(r.body.context_review.changes.length,1);a.equal(JSON.stringify(s.record),before);a.equal(f.auth.audienceDraft(f.ctx,'fish'),null);});
test('equal saved/current hashes with unavailable source never admit an implicit native count',async t=>{const f=await fixture(t),s=source(f,{current:true}),r=result(await f.rpc('fish','crm_audience_get',{id}));a.equal(r.status,200,JSON.stringify(r));a.equal(r.body.contextReview.status,200);a.equal(r.body.contextReview.body.context_review.context_current,true);a.equal(r.body.contextReview.body.context_review.source_ready,false);a.deepEqual(r.body.audienceCount,{status:409,body:{error:'SEGMENT_CATALOG_CHANGED'}});a.equal(f.calls.every(x=>x.method==='GET'),true);a.equal(s.gets,6);a.equal(f.auth.audienceDraft(f.ctx,'fish'),null);});
test('gateway independently binds availability to the fresh original catalog and trusted leaves',async t=>{for(const mutate of [b=>{b.context_review.source_ready=true;b.context_review.unavailable_fields=[];},b=>b.context_review.unavailable_fields=['email.opened'],b=>b.context_review.unavailable_fields.push('purchase.count')]){const f=await fixture(t),s=source(f);s.mutate=mutate;const r=await f.browser('GET',request());a.equal(r.status,503,JSON.stringify(r));a.equal(r.body.context_review,undefined);}const f=await fixture(t);source(f,{unavailable:false});a.equal((await f.browser('GET',request())).body.context_review.source_ready,true);});
test('unavailable metadata still obeys original private binding and native brand denial',async t=>{const f=await fixture(t),s=source(f);a.equal(result(await f.rpc('aristo','crm_audience_get',{id})).error,'BRAND_DENIED');a.equal(s.gets,0);s.hook=n=>{if(n===3){const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE campaign_writer_attestation_v1 SET expires_at=1 WHERE user_id=?').run(f.user.id);db.close();}};const r=await f.browser('GET',request());a.equal(r.status,403);a.equal(r.body.context_review,undefined);a.equal(f.auth.audienceDraft(f.ctx,'fish'),null);});
