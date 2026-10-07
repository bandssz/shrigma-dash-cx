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
async function fixture(t,{write=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'master-audience-isolated-')),dbPath=path.join(dir,'identity.sqlite'),key='isolated-central-master-'+crypto.randomBytes(12).toString('hex');
 const env={DASHBOARD_CRM_JOURNEY_CONFIGURED_READ:'enabled',DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:email,DASHBOARD_BOOTSTRAP_SHA256:sha('isolated-bootstrap'),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_WRITE:write?'enabled':'disabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:dbPath,DASHBOARD_PUBLIC_DIR:dir};
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
const definition=name=>Contract.normalize({schema_version:Contract.VERSION,brand:'fish',name,rule:{op:'in_list',list_id:1}});
function originalStore(f){
 const actor='panel:'+f.key,actorHash=sha(JSON.stringify(actor)),operations=new Map(),history=[],bindings=[{campaign:42,segmentId:id}];
 let record={id,brand:'fish',name:'Original fixture',definition:definition('Original fixture'),version:1,archived:false,created_at:'2026-10-07T21:00:00Z',updated_at:'2026-10-07T21:00:00Z',updated_by:'panel:other-historical-operator',semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:true}},postCount=0,afterPost=null,scopeHook=null,receiptHook=null,throwAfterCommit=false,sourceDraft=true;
 f.override((u,o)=>{
  const action=u.searchParams.get('acao'),brand=u.searchParams.get('brand');
  if(action==='segmento_contexto_v2'){scopeHook?.();return originalResponse({scope:{schema:'crm-audience-writer-scope-v2',brand,actor_sha256:actorHash}},u);}
  if(action==='segmento_operacao_v2'){const op=operations.get(u.searchParams.get('idempotency_key'));if(!op)return new Response(JSON.stringify({error:'SEGMENT_OPERATION_NOT_FOUND'}),{status:404});return originalResponse({operation:receiptHook?receiptHook(structuredClone(op)):op},u);}
  if(o.method==='POST'){
   postCount++;const body=JSON.parse(o.body),action=body.acao;history.push(structuredClone(record));
   if(action==='segmento_criar')record={...record,id:crypto.randomUUID(),version:1,archived:false,definition:Contract.normalize(body.definition),updated_by:actor};
   else record={...record,version:body.expected_version+1,archived:action==='segmento_arquivar',...(action==='segmento_salvar'?{definition:Contract.normalize(body.definition)}:{}),updated_by:actor};
   record.name=record.definition.name;record.updated_at='2026-10-07T22:00:00Z';
   const receipt={status:action==='segmento_criar'?201:200,body:{segment:structuredClone(record),transport_supported:false}};
   operations.set(body.idempotency_key,{schema:'crm-audience-operation-v2',idempotency_key:body.idempotency_key,brand:body.brand,action,actor_sha256:actorHash,payload_sha256:P.audiencePayloadHash(body),receipt});afterPost?.();
   if(throwAfterCommit)throw Error('isolated lost ACK');return originalResponse(receipt.body,u);
  }
  if(action==='segmento_obter')return originalResponse({segment:record},u);
  const b=catalog(brand);b.segments=[record];b.capabilities.draft=sourceDraft;b.limit=Number(u.searchParams.get('limit')||50);b.offset=Number(u.searchParams.get('offset')||0);return originalResponse(b,u);
 });
 return {operations,history,bindings,get record(){return record;},get postCount(){return postCount;},set scopeHook(fn){scopeHook=fn;},set receiptHook(fn){receiptHook=fn;},set afterPost(fn){afterPost=fn;},set throwAfterCommit(v){throwAfterCommit=v;},set sourceDraft(v){sourceDraft=v;}};
}
const result=r=>r.value.result.structuredContent;
const saveArgs=(version=1,name='Updated fixture')=>({id,expected_version:version,definition:definition(name),expected_catalog_hash:'a'.repeat(64),idempotency_key:crypto.randomUUID()});
test('original Master updates, verifies the receipt and rereads the persisted version through the same dispatcher',async t=>{
 const f=await fixture(t),s=originalStore(f),args=saveArgs(),saved=result(await f.rpc('fish','crm_audience_save',args));
 a.equal(saved.status,200,JSON.stringify(saved));a.equal(saved.body.segment.version,2);a.equal(saved.body.segment.name,'Updated fixture');a.match(saved.body.segment.updated_by,/^panel:sha256:[a-f0-9]{64}$/);a.equal(JSON.stringify(saved).includes(f.key),false);
 const read=result(await f.rpc('fish','crm_audience_get',{id}));a.equal(read.status,200);a.deepEqual(read.body.segment,saved.body.segment);a.equal(s.postCount,1);a.equal(f.auth.audienceDraft(f.ctx,'fish').phase,'succeeded');
 a.deepEqual(f.calls.filter(x=>x.url.includes('/segments')).map(x=>[x.method,new URL(x.url).searchParams.get('acao')]),[['GET','segmento_contexto_v2'],['POST',null],['GET','segmento_operacao_v2'],['GET','segmento_obter']]);
});
test('original Master creates an audience only with a verified version-one receipt',async t=>{
 const f=await fixture(t),s=originalStore(f),saved=result(await f.rpc('fish','crm_audience_save',{definition:definition('Created fixture'),expected_catalog_hash:'a'.repeat(64),idempotency_key:crypto.randomUUID()}));
 a.equal(saved.status,201,JSON.stringify(saved));a.equal(saved.body.segment.version,1);a.notEqual(saved.body.segment.id,id);a.equal(s.postCount,1);a.equal(f.auth.audienceDraft(f.ctx,'fish').phase,'succeeded');
});
test('archive keeps the original record, history and campaign binding; no delete or send endpoint exists',async t=>{
 const f=await fixture(t),s=originalStore(f),archived=result(await f.rpc('fish','crm_audience_archive',{id,expected_version:1,idempotency_key:crypto.randomUUID()}));
 a.equal(archived.status,200);a.equal(archived.body.segment.archived,true);a.equal(archived.body.segment.version,2);a.deepEqual(s.record.definition,definition('Original fixture'));a.equal(s.history[0].archived,false);a.equal(s.bindings[0].segmentId,id);a.equal(s.postCount,1);a.equal(f.calls.some(x=>x.method==='DELETE'||/send|submit|transport/.test(x.url)),false);
 const read=result(await f.rpc('fish','crm_audience_get',{id}));a.equal(read.status,200);a.equal(read.body.segment.archived,true);
});
test('native brand, audience argument pairing and payload fields are checked before any upstream work',async t=>{
 const f=await fixture(t);originalStore(f);
 for(const [brand,name,args,code]of [['aristo','crm_audience_catalog',{},'BRAND_DENIED'],['fish','crm_audience_save',{...saveArgs(),actor:'fabricated'},'NATIVE_ARGUMENTS_INVALID'],['fish','crm_audience_save',{id,definition:definition('Pair missing'),expected_catalog_hash:'a'.repeat(64),idempotency_key:crypto.randomUUID()},'NATIVE_ARGUMENTS_INVALID'],['fish','crm_audience_catalog',{limit:101},'NATIVE_ARGUMENTS_INVALID']])a.equal(result(await f.rpc(brand,name,args)).error,code);
 a.equal(f.calls.length,0);
});
test('native read-only grant cannot use audience mutations',async t=>{
 const f=await fixture(t);originalStore(f);
 const m=require(path.join(runtime,'crm-native-mcp.cjs')).createNativeMcp({auth:f.auth,managerHost:host,invoke:async()=>{throw Error('must not invoke');}}),read=f.auth.nativeConnections.issue({context:f.ctx,brands:['fish'],scopes:['crm.read'],expiresDays:1});
 await a.rejects(()=>m.call('crm_audience_archive',{brand:'fish',id,expected_version:1,idempotency_key:crypto.randomUUID()},read.token),e=>e.status===403);a.equal(f.calls.length,0);
});
test('changing the original Master binding during scope lookup prevents journal reservation and POST',async t=>{
 const f=await fixture(t),s=originalStore(f);s.scopeHook=()=>{const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE campaign_writer_attestation_v1 SET expires_at=1 WHERE user_id=?').run(f.user.id);db.close();};
 const r=result(await f.rpc('fish','crm_audience_save',saveArgs()));a.equal(r.status,403);a.equal(s.postCount,0);a.equal(f.auth.audienceDraft(f.ctx,'fish'),null);
});
test('lost ACK is reconciled with the original receipt and never a second POST or replacement operation',async t=>{
 const f=await fixture(t),s=originalStore(f),args=saveArgs();s.throwAfterCommit=true;
 const lost=result(await f.rpc('fish','crm_audience_save',args));a.equal(lost.status,502);a.equal(f.auth.audienceDraft(f.ctx,'fish').phase,'uncertain');a.equal(s.postCount,1);
 const duplicate=result(await f.rpc('fish','crm_audience_save',args)),replacement=result(await f.rpc('fish','crm_audience_save',saveArgs()));a.equal(duplicate.status,409);a.equal(replacement.status,409);a.equal(s.postCount,1);
 const recovered=result(await f.rpc('fish','crm_audience_operation',{idempotency_key:args.idempotency_key}));a.equal(recovered.status,200);a.equal(recovered.body.segment.version,2);a.equal(f.auth.audienceDraft(f.ctx,'fish').phase,'succeeded');a.equal(s.postCount,1);
});
test('receipt brand and payload hashes must match the original journal before exposing a result',async t=>{
 for(const field of ['brand','payload_sha256','actor_sha256']){
  const f=await fixture(t),s=originalStore(f);s.receiptHook=op=>({...op,[field]:field==='brand'?'aristo':'b'.repeat(64)});
  const r=result(await f.rpc('fish','crm_audience_save',saveArgs()));a.equal(r.status,502);a.equal(r.body.error,'UPSTREAM_RECEIPT_UNCONFIRMED');a.equal(JSON.stringify(r).includes('Original fixture'),false);a.equal(f.auth.audienceDraft(f.ctx,'fish').phase,'uncertain');a.equal(s.postCount,1);
 }
});
test('revocation during original POST suppresses the result and preserves the single unresolved operation',async t=>{
 const f=await fixture(t),s=originalStore(f);s.afterPost=()=>f.auth.nativeConnections.revoke({context:f.ctx,connectionId:f.issued.connection.id});
 const r=result(await f.rpc('fish','crm_audience_save',saveArgs()));a.equal(r.error,'NATIVE_AUTH_REQUIRED');a.equal(s.postCount,1);a.equal(JSON.stringify(r).includes('segment'),false);
});
test('read projection hashes every historical operator and grants draft only with an original current catalog',async t=>{
 const f=await fixture(t),s=originalStore(f);let r=result(await f.rpc('fish','crm_audience_catalog'));a.equal(r.status,200);a.equal(r.body.capabilities.draft,true);a.match(r.body.segments[0].updated_by,/^panel:sha256:/);a.equal(JSON.stringify(r).includes('other-historical-operator'),false);
 s.sourceDraft=false;r=result(await f.rpc('fish','crm_audience_catalog'));a.equal(r.body.capabilities.draft,false);a.equal(r.body.capabilities.count,false);a.equal(r.body.capabilities.send,false);
});
test('public scope cannot inspect actor authority; native scope projects only verified admission and UI contract',async t=>{
 const f=await fixture(t);originalStore(f);const publicScope=await f.browser('GET','/api/segments?acao=segmento_contexto_v2&brand=fish');a.equal(publicScope.status,403);a.equal(f.calls.length,0);
 const r=result(await f.rpc());a.equal(r.status,200);a.equal(r.body.audienceWriteAdmission.status,200);a.equal(r.body.audienceWriteAdmission.body.originalScopeAuthenticated,true);a.equal(r.body.audienceUiSource.brandsRecognized,true,JSON.stringify(r));a.equal(r.body.audienceUiSource.contractRecognized,true);a.equal(r.body.audienceUiSource.sameOriginEndpoint,true);a.equal(r.body.audienceUiSource.save,true);a.equal(JSON.stringify(r).includes(f.key),false);a.equal(JSON.stringify(r).includes('actor_sha256'),false);
});
test('write stays explicitly closed when disabled and cannot be projected without the immutable original READ admission',async t=>{
 const f=await fixture(t,{write:false});originalStore(f);const r=result(await f.rpc('fish','crm_audience_save',saveArgs()));a.equal(r.status,403);a.equal(f.calls.length,0);a.equal(f.auth.audienceDraftReady(f.ctx),false);
 a.throws(()=>settingsFromEnv({...f.env,DASHBOARD_CRM_MASTER_AUDIENCE_READ:'disabled',DASHBOARD_CRM_MASTER_AUDIENCE_WRITE:'enabled'}));
});
