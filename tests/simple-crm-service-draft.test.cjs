'use strict';
// Real cookie/HTTP/SQLite against injected synthetic originals. No production
// account, customer, key, workflow or sending endpoint is used by these tests.
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs'),{settingsFromEnv,createServer}=require(runtime+'/server.cjs'),P=require(runtime+'/proxy.cjs'),C=require(runtime+'/campaign-write-contract.js'),T=require(runtime+'/campaign-write-tracking.js'),A=require(runtime+'/segment-audience-contract.js');
const HOST='gerencial.shrigma.com.br',EMAIL='felipebandeira@oaristocrata.com',PASS='Synthetic-Test-Password-2026!',STAMP='2026-10-14T03:00:00.000Z',sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function response(body,url,status=200){const r=new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r;}
function campaignDefinition(brand='aristo'){const domain=C.BRANDS[brand];return{schema_version:C.VERSION,brand,channel:'email',initiative:{key:'synthetic-campaign',name:'Synthetic campaign'},utm_campaign:'synthetic-campaign',name:'Synthetic unscheduled draft',subject:'[TESTE] Synthetic subject',from_email:'synthetic@'+domain,reply_to:'synthetic@'+domain,list_ids:[brand==='aristo'?7:17],template_id:1,html:'<a href="https://'+domain+'/products/synthetic">Produto</a><a href="{{ UnsubscribeURL }}">Sair</a>',text:'https://'+domain+'/products/synthetic {{ UnsubscribeURL }}',tags:[],send_at:null};}
const audienceDefinition=(brand='aristo',name='Synthetic audience')=>A.normalize({schema_version:A.VERSION,brand,name,rule:{op:'in_list',list_id:brand==='aristo'?7:17}});
async function fixture(t,{write=true,fronts=['growth'],brands=['aristo'],holder=true,hooks={}}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'simple-crm-draft-')),dbPath=path.join(dir,'identity.sqlite'),key='synthetic-original-master-2026',readKey='a'.repeat(64),calls=[],operations=new Map(),audienceOperations=new Map(),campaigns=new Map(),segments=new Map();let nextId=701;
 const env={DASHBOARD_MODE:'operational',DASHBOARD_SIMPLE_READ_LOGIN:'enabled',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:HOST,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:JSON.stringify(['oaristocrata.com','shrigma.com.br','fishermans.com.br']),DASHBOARD_ADMIN_EMAIL:EMAIL,DASHBOARD_BOOTSTRAP_SHA256:sha('synthetic-bootstrap'),DASHBOARD_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('hex'),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_WRITE:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['comunicacao-crm-panel-read.tazdb8.easypanel.host','n8n-n8n.tazdb8.easypanel.host','comunicacao-crm-audience.tazdb8.easypanel.host']),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_SERVICE_READ_CRM_KEY:'synthetic-read-crm-only',DASHBOARD_SERVICE_READ_AUDIENCE_KEY:readKey,DASHBOARD_DB_PATH:dbPath,DASHBOARD_PUBLIC_DIR:dir};
 const settings=settingsFromEnv(env),auth=createAuth(settings);
 await auth.completeBootstrap({email:EMAIL,token:'synthetic-bootstrap',password:PASS,host:HOST,origin:'https://'+HOST});
 const admin=await auth.login({email:EMAIL,password:PASS,host:HOST,origin:'https://'+HOST}),adminContext={host:HOST,origin:'https://'+HOST,method:'POST',cookieHeader:admin.cookie.split(';')[0],csrf:admin.csrf};
 const identity=url=>response({schema:'shrigma_access_identity_v1',role:'master',panel:'todos',owner:EMAIL,allowedPanels:['cx','growth','organico','influs'],permissions:{growth:{who:'panel:synthetic-principal-2026',label:EMAIL,caps:hooks.caps||['read_content','draft','validate','submit']},influs:null}},url);
 if(holder){auth.setUpstreamCredential({context:adminContext,userId:auth.session(adminContext).user.id,slot:'growth-read',bearer:key});await auth.activateOwnMasterCampaignWriter({context:adminContext,fetchImpl:async url=>identity(url)});}
 const created=await auth.simpleAccounts.create({context:adminContext,email:'synthetic-analyst@oaristocrata.com',password:PASS,jobTitle:'analista',fronts,brands,writeFronts:write?fronts:[]}),analyst=await auth.login({email:created.user.email,password:PASS,host:HOST,origin:'https://'+HOST});
 const catalog=brand=>({brand,current:true,lists:[{id:brand==='aristo'?7:17,brand,name:'Synthetic list',available:true}],templates:[{id:1,name:'Original shared layout',type:'campaign',version:'a'.repeat(32),available:true}],initiatives:[],read_at:STAMP});
 const fetchImpl=async(url,o)=>{
  const u=new URL(url),body=o.method==='POST'?JSON.parse(o.body):null,action=body?.acao||u.searchParams.get('acao')||u.searchParams.get('action');calls.push({method:o.method,action,url:u.href,body});a.equal(o.headers.Cookie,undefined);a.equal(o.headers.Origin,undefined);
  if(action==='identity'){a.equal(o.headers.Authorization,'Bearer '+key);await hooks.identity?.();return identity(u);}
  const brand=body?.brand||u.searchParams.get('brand');
  if(u.pathname==='/segments'){
   if(o.method==='GET'&&['segmentos_listar','segmento_obter','segmento_contar'].includes(action))a.equal(o.headers.Authorization,'Bearer '+readKey);else a.equal(o.headers.Authorization,'Bearer '+key);
   if(action==='segmento_contexto_v2'){await hooks.scope?.();return response({scope:{schema:'crm-audience-writer-scope-v2',brand,actor_sha256:sha(JSON.stringify('panel:'+key))}},u);}
   if(action==='segmento_operacao_v2'){const op=audienceOperations.get(u.searchParams.get('idempotency_key'));if(!op)return response({error:'SEGMENT_OPERATION_NOT_FOUND'},u,404);const copy=structuredClone(op);await hooks.audienceReceipt?.(copy);return response({operation:copy},u);}
   if(o.method==='POST'){
    a.equal(body.k,undefined);const def=A.normalize(body.definition),prior=segments.get(body.id),id=body.id||crypto.randomUUID();let receipt;
    if(body.acao==='segmento_salvar'&&body.expected_version!==prior?.version)receipt={status:409,body:{error:'SEGMENT_VERSION_CONFLICT',current_version:prior?.version||1}};
    else{const segment={id,brand,name:def.name,definition:def,version:body.acao==='segmento_criar'?1:body.expected_version+1,archived:false,created_at:STAMP,updated_at:STAMP,updated_by:'panel:'+key,semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:true}};segments.set(id,segment);receipt={status:body.acao==='segmento_criar'?201:200,body:{segment,transport_supported:false}};}
    audienceOperations.set(body.idempotency_key,{schema:'crm-audience-operation-v2',idempotency_key:body.idempotency_key,brand,action:body.acao,actor_sha256:sha(JSON.stringify('panel:'+key)),payload_sha256:P.audiencePayloadHash(body),receipt});await hooks.afterAudiencePost?.();if(hooks.lostAudience)throw Error('synthetic ACK lost');return response(receipt.body,u,receipt.status);
   }
   const cat={brand,current:true,currency:'BRL',timezone:'America/Sao_Paulo',shop_id:'gid://shopify/Shop/42',fields:[],products:[],origins:[],lists:catalog(brand).lists,coverage:'unconfirmed',checked_at:new Date().toISOString(),catalog_hash:'a'.repeat(64)};
   return response({segments:[...segments.values()].filter(s=>s.brand===brand),catalog:cat,limit:Number(u.searchParams.get('limit')||50),offset:Number(u.searchParams.get('offset')||0),capabilities:{draft:true,count:true,send:false}},u);
  }
  if(o.method==='POST')a.equal(body.k,key);else a.equal(o.headers.Authorization,'Bearer '+key);
  if(action==='campanha_catalogo'){const value=catalog(brand);await hooks.catalog?.(value);return response(value,u);}
  if(action==='campanha_listar')return response({campaigns:[...campaigns.values()].filter(c=>c.definition.brand===brand)},u);
  if(action==='campanha_obter')return response({campaign:campaigns.get(Number(u.searchParams.get('id')))},u);
  if(action==='campanha_operacao'){const op=operations.get(u.searchParams.get('idempotency_key'));return response(op?{operation:op}:{error:'OPERATION_NOT_FOUND'},u,op?200:404);}
  if(action==='campanha_salvar'){
   a.equal(body.definition.send_at,null);const id=body.id||nextId++,prepared=C.prepare(body.definition,{catalog:catalog(brand),tracking:T,trackingId:id}),at=new Date().toISOString(),operationId=crypto.randomUUID(),campaign={id,version:(body.id?'c':'b').repeat(32),status:'draft',sent:0,started_at:null,send_at:null,definition:prepared.definition};campaigns.set(id,campaign);
   const receipt={status:body.id?200:201,body:{campaign,tracking:prepared.tracking,operation_id:operationId}};operations.set(body.idempotency_key,{id:operationId,operation_key:body.idempotency_key,brand,action:'salvar',state:'succeeded',providerId:id,response:receipt,created_at:at,updated_at:at});await hooks.afterCampaignPost?.();if(hooks.lostCampaign)throw Error('synthetic ACK lost');return response(receipt.body,u,receipt.status);
  }
  if(action==='campanha_validar'){
   const campaign=campaigns.get(body.id),prepared=C.prepare(campaign.definition,{catalog:catalog(brand),tracking:T,trackingId:body.id}),now=new Date().toISOString(),opId=crypto.randomUUID(),audience={policy:'listmonk-6.1-regular-v1',brand,list_ids:campaign.definition.list_ids,eligible_count:2,unique_members_count:3,excluded_blocklisted_count:1,excluded_subscription_count:0,native_disabled_count:0,review_id:crypto.randomUUID(),campaign_id:body.id,campaign_version:body.expected_version,frozen:false,checked_at:now,expires_at:new Date(Date.parse(now)+300000).toISOString()},receipt={status:200,body:{campaign,validation:{policy:C.VERSION,version:body.expected_version,ok:true,validated_at:now,audience},tracking:prepared.tracking}};
   operations.set(body.idempotency_key,{id:opId,operation_key:body.idempotency_key,brand,action:'validar',state:'succeeded',providerId:body.id,response:receipt,created_at:now,updated_at:now});return response(receipt.body,u);
  }
  throw Error('Synthetic source action not admitted: '+action);
 };
 const server=createServer(settings,{auth,fetchImpl});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=(url,{method='GET',body,csrf=true,login=analyst}={})=>new Promise((resolve,reject)=>{const bytes=body?Buffer.from(JSON.stringify(body)):null,headers={Host:HOST,Origin:'https://'+HOST,Cookie:login.cookie.split(';')[0],...(csrf?{'X-CSRF-Token':login.csrf}:{}),...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})};const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end(bytes);});
 const dbQuery=fn=>{const db=new DatabaseSync(dbPath);try{return fn(db);}finally{db.close();}};
 return{auth,adminContext,analyst,created,request,key,calls,operations,audienceOperations,campaigns,segments,dbQuery,hooks,posts:()=>calls.filter(c=>c.method==='POST').length,update:args=>auth.simpleAccounts.update({context:adminContext,userId:created.user.id,jobTitle:'analista',fronts,brands,writeFronts:write?fronts:[],active:true,...args})};
}
const createCampaign=()=>({acao:'campanha_criar',brand:'aristo',definition:campaignDefinition(),idempotency_key:crypto.randomUUID()});
const createAudience=()=>({acao:'segmento_criar',brand:'aristo',definition:audienceDefinition(),expected_catalog_hash:'a'.repeat(64),idempotency_key:crypto.randomUUID()});
test('individual CRM WRITE creates and reloads a draft; journal author stays the real analyst and key stays private',async t=>{
 const f=await fixture(t),command=createCampaign(),result=await f.request('/api/campaigns',{method:'POST',body:command});a.equal(result.status,200,JSON.stringify(result.body));a.equal(result.body.state,'succeeded');a.equal(result.body.campaign.sent,0);a.equal(result.body.campaign.sendAt,null);a.equal(f.posts(),1);
 const row=f.dbQuery(db=>db.prepare('SELECT * FROM crm_campaign_create_v1 WHERE client_key=?').get(command.idempotency_key));a.equal(row.user_id,f.created.user.id);a.notEqual(row.remote_key,command.idempotency_key);a.notEqual(row.credential_mac,sha(f.key));
 const reopened=await f.request('/api/campaigns?acao=campanha_obter&brand=aristo&id='+result.body.campaign.id);a.equal(reopened.status,200);a.equal(reopened.body.campaign.definition.name,command.definition.name);
 a.equal(f.dbQuery(db=>db.prepare('SELECT COUNT(*) AS n FROM upstream_credentials WHERE user_id=?').get(f.created.user.id).n),0);a(!JSON.stringify(result).includes(f.key));a.equal((await f.request('/auth/session')).body.user.role,'manager');
});
test('lost campaign ACK, duplicate click and reload reconcile the same attempt without another POST',async t=>{
 const f=await fixture(t,{hooks:{lostCampaign:true}}),command=createCampaign(),first=await f.request('/api/campaigns',{method:'POST',body:command});a.equal(first.status,202,JSON.stringify(first.body));a.equal(f.posts(),1);
 const poll=await f.request('/api/campaigns?acao=campanha_operacao&kind=create&brand=aristo&idempotency_key='+command.idempotency_key);a.equal(poll.status,200,JSON.stringify(poll.body));a.equal(poll.body.state,'succeeded');
 const again=await f.request('/api/campaigns',{method:'POST',body:command});a.equal(again.status,200);a.equal(f.posts(),1);
});
test('individual account saves by version and validates the persisted draft without enabling submit',async t=>{
 const f=await fixture(t),created=await f.request('/api/campaigns',{method:'POST',body:createCampaign()});a.equal(created.status,200);
 const saved=await f.request('/api/campaigns',{method:'POST',body:{acao:'campanha_salvar',brand:'aristo',id:created.body.campaign.id,expected_version:created.body.campaign.version,definition:{...campaignDefinition(),subject:'[TESTE] Changed subject'},idempotency_key:crypto.randomUUID()}});a.equal(saved.status,200,JSON.stringify(saved.body));a.equal(saved.body.state,'succeeded');
 const validated=await f.request('/api/campaigns',{method:'POST',body:{acao:'campanha_validar',brand:'aristo',id:saved.body.campaign.id,expected_version:saved.body.campaign.version,idempotency_key:crypto.randomUUID()}});a.equal(validated.status,200,JSON.stringify(validated.body));a.equal(validated.body.validation.ok,true);a.equal(validated.body.validation.audience.eligible_count,2);a.equal(f.posts(),3);
 const capability=await f.request('/api/campaigns?acao=campanha_capacidade&brand=aristo');a.deepEqual([capability.body.draft,capability.body.validate,capability.body.send],[true,true,false]);
});
test('validation of a dated or already scheduled original stops before another source POST',async t=>{
 const f=await fixture(t),created=await f.request('/api/campaigns',{method:'POST',body:createCampaign()}),current=f.campaigns.get(created.body.campaign.id);current.send_at='2026-11-01T12:00:00.000Z';current.definition.send_at=current.send_at;
 const denied=await f.request('/api/campaigns',{method:'POST',body:{acao:'campanha_validar',brand:'aristo',id:current.id,expected_version:current.version,idempotency_key:crypto.randomUUID()}});a(denied.status>=400,JSON.stringify(denied.body));a.equal(f.posts(),1);
});
test('Público uses the original source, scoped remote key, full receipt and private journal; saving increments version',async t=>{
 const f=await fixture(t),command=createAudience(),created=await f.request('/api/segments',{method:'POST',body:command});a.equal(created.status,200,JSON.stringify(created.body));a.equal(created.body.segment.version,1);a.match(created.body.segment.updated_by,/^panel:sha256:/);a(!JSON.stringify(created).includes(f.key));
 const posted=f.calls.find(c=>c.method==='POST');a.notEqual(posted.body.idempotency_key,command.idempotency_key);a.equal(posted.body.definition.brand,'aristo');
 const saved=await f.request('/api/segments',{method:'POST',body:{...command,acao:'segmento_salvar',id:created.body.segment.id,expected_version:1,definition:audienceDefinition('aristo','Changed synthetic audience'),idempotency_key:crypto.randomUUID()}});a.equal(saved.status,200,JSON.stringify(saved.body));a.equal(saved.body.segment.version,2);a.equal(saved.body.segment.name,'Changed synthetic audience');a.equal(f.posts(),2);
});
test('audience lost ACK and same-key replay use GET receipt only; changed payload is denied',async t=>{
 const f=await fixture(t,{hooks:{lostAudience:true}}),command=createAudience(),first=await f.request('/api/segments',{method:'POST',body:command});a.equal(first.status,200,JSON.stringify(first.body));a.equal(first.body.state,'succeeded');
 a.equal((await f.request('/api/segments',{method:'POST',body:command})).status,200);a.equal(f.posts(),1);
 const changed=await f.request('/api/segments',{method:'POST',body:{...command,definition:audienceDefinition('aristo','Changed same attempt')}});a.equal(changed.status,409);a.equal(f.posts(),1);
});
test('READ account, wrong front/brand, missing source holder and missing CSRF cannot reserve or POST',async t=>{
 for(const options of [{write:false},{fronts:['afiliados']},{brands:['fish']},{holder:false}]){const f=await fixture(t,options);const r=await f.request('/api/campaigns',{method:'POST',body:createCampaign()});a(r.status>=400,JSON.stringify(r.body));a.equal(f.posts(),0);a.equal(f.dbQuery(db=>db.prepare('SELECT COUNT(*) AS n FROM crm_campaign_create_v1').get().n),0);}
 const f=await fixture(t);a.equal((await f.request('/api/segments',{method:'POST',body:createAudience(),csrf:false})).status,403);a.equal(f.posts(),0);
});
test('schedule, cancellation, audience archive and dated drafts stay outside this service profile',async t=>{
 const f=await fixture(t);for(const acao of ['campanha_agendar','campanha_cancelar'])a.equal((await f.request('/api/campaigns',{method:'POST',body:{acao,brand:'aristo',id:701,expected_version:'b'.repeat(32),idempotency_key:crypto.randomUUID(),confirm:acao.slice(9)}})).status,403);
 const dated=createCampaign();dated.definition.send_at='2026-11-01T12:00:00.000Z';a.equal((await f.request('/api/campaigns',{method:'POST',body:dated})).status,400);
 a.equal((await f.request('/api/segments',{method:'POST',body:{acao:'segmento_arquivar',brand:'aristo',id:crypto.randomUUID(),expected_version:1,idempotency_key:crypto.randomUUID()}})).status,403);a.equal(f.posts(),0);
});
test('source identity and local revocation are checked again before POST and receipt exposure',async t=>{
 const f=await fixture(t);f.hooks.caps=['read_content','draft','validate'];a.equal((await f.request('/api/campaigns',{method:'POST',body:createCampaign()})).status,503);a.equal(f.posts(),0);
 const g=await fixture(t);g.hooks.scope=()=>g.update({active:false});a.equal((await g.request('/api/segments',{method:'POST',body:createAudience()})).status,401);a.equal(g.posts(),0);
 const h=await fixture(t);h.hooks.afterAudiencePost=()=>h.update({active:false});a.equal((await h.request('/api/segments',{method:'POST',body:createAudience()})).status,401);a.equal(h.posts(),1);a.equal(h.dbQuery(db=>db.prepare('SELECT phase FROM audience_draft_operations WHERE user_id=?').get(h.created.user.id).phase),'uncertain');
});
test('foreign or malformed original receipt is uncertain and never leaks extra fields or repeats POST',async t=>{
 const f=await fixture(t,{hooks:{audienceReceipt:op=>{op.receipt.body.segment.customer_email='private@synthetic.invalid';}}}),command=createAudience(),r=await f.request('/api/segments',{method:'POST',body:command});a.equal(r.status,502,JSON.stringify(r.body));a(!JSON.stringify(r).includes('private@'));a.equal(f.posts(),1);
 a.equal((await f.request('/api/segments',{method:'POST',body:command})).status,502);a.equal(f.posts(),1);
});
test('original shared template metadata is projected; conflicting explicit template brand is refused',async t=>{
 const f=await fixture(t,{hooks:{catalog:c=>{c.private_customer='private@synthetic.invalid';c.templates[0].html='private@synthetic.invalid';}}}),r=await f.request('/api/campaigns?acao=campanha_catalogo&brand=aristo');a.equal(r.status,200,JSON.stringify(r.body));a(!JSON.stringify(r).includes('private@'));a.equal(r.body.templates[0].type,'campaign');
 f.hooks.catalog=c=>{c.templates[0].brand='fish';};a.equal((await f.request('/api/campaigns?acao=campanha_catalogo&brand=aristo')).status,502);
});
test('service descriptor cannot be cloned or substituted for an old campaign writer',()=>{
 const M=require(runtime+'/crm-manager-runtime.cjs'),original=M.ownMasterWriterDescriptor('own-master-production-v1',['oaristocrata.com','shrigma.com.br','fishermans.com.br']),service=M.serviceDraftDescriptor(original);a.equal(M.isServiceDraftDescriptor(service),true);a.equal(M.isServiceDraftDescriptor({...service}),false);a.equal(M.isCampaignWriterDescriptor(service),false);a.throws(()=>M.serviceDraftDescriptor({...original}));
});
test('two tabs racing the same audience reserve one POST; two authors never share a remote key or journal',async t=>{
 const f=await fixture(t);let scopes=0,release;const barrier=new Promise(resolve=>{release=resolve;});f.hooks.scope=()=>{if(++scopes===2)release();return barrier;};const command=createAudience(),race=await Promise.all([f.request('/api/segments',{method:'POST',body:command}),f.request('/api/segments',{method:'POST',body:command})]);a.deepEqual(race.map(r=>r.status).sort(),[200,409]);a.equal(f.posts(),1);delete f.hooks.scope;
 const other=await f.auth.simpleAccounts.create({context:f.adminContext,email:'synthetic-other@oaristocrata.com',password:PASS,jobTitle:'analista',fronts:['growth'],brands:['aristo'],writeFronts:['growth']}),login=await f.auth.login({email:other.user.email,password:PASS,host:HOST,origin:'https://'+HOST});
 const foreign=await f.request('/api/segments?acao=segmento_operacao&brand=aristo&idempotency_key='+command.idempotency_key,{login});a.equal(foreign.status,404);a.equal(f.posts(),1);
 const own=await f.request('/api/segments',{method:'POST',body:command,login});a.equal(own.status,200,JSON.stringify(own.body));const keys=f.calls.filter(c=>c.method==='POST').map(c=>c.body.idempotency_key);a.equal(keys.length,2);a.notEqual(keys[0],keys[1]);a.notEqual(own.body.segment.id,race.find(r=>r.status===200).body.segment.id);
});
test('capability reads obey the same per-author concurrency limit as mutations',async t=>{
 const f=await fixture(t);let enter=0,release,allEntered,timer;const barrier=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{allEntered=resolve;});f.hooks.identity=()=>{if(++enter===4)allEntered();return barrier;};const calls=Array.from({length:5},()=>f.request('/api/campaigns?acao=campanha_capacidade&brand=aristo'));
 try{const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Synthetic concurrency timeout')),5000);});await Promise.race([entered,deadline]);a.equal(enter,4);a.equal((await Promise.race([Promise.race(calls),deadline])).status,429);}finally{clearTimeout(timer);release();}const results=await Promise.all(calls);a.equal(results.filter(r=>r.status===429).length,1);a.equal(results.filter(r=>r.status===200).length,4);
});
