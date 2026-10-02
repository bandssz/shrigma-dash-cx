'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createSandbox}=require('../services/crm-audience-sandbox/factory.cjs');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {SANDBOX_DESTINATIONS,SANDBOX_HOST}=require('../services/dashboard-operational/proxy.cjs');
const hosts={manager:'manager.synthetic.invalid',growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
const metadata={'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'};
function call(port,host,url,{method='GET',body,cookie,csrf}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:url,method,headers:{Host:host,...(method==='POST'?{Origin:'https://'+host}:metadata),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
  });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
}
const session=r=>({cookie:r.headers['set-cookie'][0].split(';')[0],csrf:r.body.csrf,uiKey:r.body.uiKey});

test('real disposable CRM and portal verify create/save/archive, scoped reads and lost ACK recovery without replay',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-crm-component-')),dataDir=path.join(dir,'crm');fs.mkdirSync(dataDir,{mode:0o700});
 const owner='editor@synthetic.invalid',keys={reader:crypto.randomBytes(32).toString('hex'),writer:crypto.randomBytes(32).toString('hex')},revision='a'.repeat(40);
 const bootstrap=crypto.randomBytes(32).toString('base64url'),password='Synthetic component password 2026!';
 const authConfig={dbPath:path.join(dir,'identity.sqlite'),managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32)};
 const auth=createAuth(authConfig);let sandbox,portal;
 try{
  sandbox=await createSandbox({root:dataDir,owner,revision,credentials:keys});await new Promise(resolve=>sandbox.server.listen(0,'127.0.0.1',resolve));
  const upstreamBase='http://127.0.0.1:'+sandbox.server.address().port,state={writes:0,lostAck:false,urls:[]};
  const fetchImpl=async(raw,options)=>{
   const url=new URL(raw);assert.equal(url.hostname,SANDBOX_HOST);assert.ok(['/identity','/dashboard','/segments'].includes(url.pathname));assert.equal(options.redirect,'manual');assert.equal(options.headers.Origin,undefined);assert.equal(options.headers.Cookie,undefined);
   state.urls.push(url.pathname);if(url.pathname==='/dashboard'){assert.equal(url.search,'?painel=growth');assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer '+keys.reader);}if(options.method==='POST')state.writes++;
   const result=await fetch(upstreamBase+url.pathname+url.search,options);
   if(state.lostAck&&options.method==='POST'){state.lostAck=false;await result.arrayBuffer();throw Error('simulated lost ACK after actual local database commit');}
   return result;
  };
  portal=createServer({...authConfig,mode:'operational',upstreamProfile:'crm-sandbox',upstreams:SANDBOX_DESTINATIONS,allowedUpstreamHosts:[SANDBOX_HOST],dynamicRouteManifest:null,crmAudienceDraft:true,crmDraftWrite:false},{auth,fetchImpl});await new Promise(resolve=>portal.listen(0,'127.0.0.1',resolve));
  const port=portal.address().port,post=(host,url,body,ctx={})=>call(port,host,url,{...ctx,method:'POST',body}),get=(url,ctx)=>call(port,hosts.growth,url,ctx);
  assert.equal((await post(hosts.manager,'/auth/bootstrap/complete',{email:authConfig.bootstrapAdminEmail,token:bootstrap,password})).status,200);
  const admin=session(await post(hosts.manager,'/auth/login',{email:authConfig.bootstrapAdminEmail,password}));
  const invite=await post(hosts.manager,'/auth/users',{action:'invite',role:'manager',email:owner,areas:['growth'],permissions:{growth:{read:true,edit:true}}},admin);assert.equal(invite.status,201);
  const token=new URLSearchParams(new URL(invite.body.inviteUrl).hash.slice(1)).get('invite');assert.equal((await post(hosts.growth,'/auth/invite/accept',{token,password})).status,200);
  const login=async()=>session(await post(hosts.growth,'/auth/login',{email:owner,password}));let editor=await login();
  assert.equal((await get('/auth/session',editor)).body.features.audienceDraft,false);
  for(const [slot,bearer]of [['growth-read',keys.reader],['growth-audience-read',keys.reader],['growth-audience',keys.writer]])assert.equal((await post(hosts.manager,'/auth/users',{action:'credential',userId:invite.body.userId,slot,bearer},admin)).status,200);
  assert.equal((await get('/auth/session',editor)).body.features.audienceDraft,true);
  const dashboard=await get('/api/cx?painel=growth',editor);assert.equal(dashboard.status,200);assert.equal(dashboard.body.synthetic,true);assert.equal(dashboard.body.capabilities.segments.save,true);assert.equal(dashboard.body.capabilities.segments.count,false);assert.equal(dashboard.body.capabilities.write,false);
  const crmCache=await get('/api/crm-read?action=cache_growth&painel=growth',editor);assert.equal(crmCache.status,200);assert.equal(crmCache.body._escopo,'growth');assert.ok(Array.isArray(crmCache.body.crm_campanha));assert.ok(Array.isArray(crmCache.body.crm_fluxo));assert.ok(Array.isArray(crmCache.body.crm_conversao));assert.ok(Math.abs(Date.now()-Date.parse(crmCache.body._cache_gerado_em))<60000);assert.equal(crmCache.body.capabilities.segments.save,true);
  const callsBeforeDenied=state.urls.length;
  for(const denied of ['/api/crm-read?action=cache_growth&painel=organico','/api/crm-read?action=cache_growth&painel=growth&url=https%3A%2F%2Fproduction.test','/api/crm-read?action=live_growth&painel=growth'])assert.equal((await get(denied,editor)).status,403);
  assert.equal(state.urls.length,callsBeforeDenied,'invalid CRM cache requests never reach any upstream');
  const list=await get('/api/segments?acao=segmentos_listar&brand=fish&offset=0&limit=50',editor);assert.equal(list.status,200);assert.equal(list.body.catalog.current,true);assert.equal(list.body.capabilities.draft,true,'browser catalogue reflects the separately attested writer grant');assert.equal(list.body.capabilities.count,false);assert.equal(list.body.capabilities.send,false);
  const catalogHash=list.body.catalog.catalog_hash,definition={schema_version:'crm-audience-v2',brand:'fish',name:'Synthetic component audience',rule:{op:'in_list',list_id:17}};
  const create=(key,name=definition.name)=>({acao:'segmento_criar',brand:'fish',definition:{...definition,name},expected_catalog_hash:catalogHash,idempotency_key:key});
  const created=await post(hosts.growth,'/api/segments',create(crypto.randomUUID()),editor);assert.equal(created.status,201);assert.equal(created.body.segment.version,1);assert.equal(created.body.transport_supported,false);
  const saved=await post(hosts.growth,'/api/segments',{acao:'segmento_salvar',brand:'fish',id:created.body.segment.id,expected_version:1,definition:{...definition,name:'Synthetic edited audience'},expected_catalog_hash:catalogHash,idempotency_key:crypto.randomUUID()},editor);assert.equal(saved.status,200);assert.equal(saved.body.segment.version,2);
  const archived=await post(hosts.growth,'/api/segments',{acao:'segmento_arquivar',brand:'fish',id:created.body.segment.id,expected_version:2,idempotency_key:crypto.randomUUID()},editor);assert.equal(archived.status,200);assert.equal(archived.body.segment.version,3);assert.equal(archived.body.segment.archived,true);
  assert.equal(state.writes,3);
  const key=crypto.randomUUID();state.lostAck=true;
  const lost=await post(hosts.growth,'/api/segments',create(key,'Synthetic lost ACK'),editor);assert.equal(lost.status,502);assert.equal(state.writes,4);
  assert.equal((await get('/auth/audience-draft?brand=fish',editor)).body.operation.phase,'uncertain');
  const again=await login();assert.equal(again.uiKey,editor.uiKey);assert.notEqual(again.cookie,editor.cookie);assert.notEqual(again.csrf,editor.csrf);editor=again;
  assert.equal((await post(hosts.growth,'/api/segments',create(crypto.randomUUID()),editor)).status,409);assert.equal(state.writes,4);
  const recovered=await get('/api/segments?acao=segmento_operacao&brand=fish&idempotency_key='+key,editor);assert.equal(recovered.status,201);assert.equal(recovered.body.segment.name,'Synthetic lost ACK');assert.equal(state.writes,4);
  assert.equal((await get('/auth/audience-draft?brand=fish',editor)).body.operation.phase,'succeeded');
  assert.equal((await get('/api/segments?acao=segmentos_listar&brand=aristo&offset=0&limit=50',editor)).body.segments.length,0);
  const total=await get('/api/segments?acao=segmentos_listar&brand=fish&offset=0&limit=50',editor);assert.equal(total.body.segments.length,2);assert.equal(total.body.segments.filter(segment=>segment.archived).length,1);assert.equal(total.body.segments.find(segment=>!segment.archived).name,'Synthetic lost ACK');
  const other=await post(hosts.manager,'/auth/users',{action:'invite',role:'manager',email:'other@synthetic.invalid',areas:['growth'],permissions:{growth:{read:true,edit:true}}},admin);assert.equal(other.status,201);
  const otherToken=new URLSearchParams(new URL(other.body.inviteUrl).hash.slice(1)).get('invite');await post(hosts.growth,'/auth/invite/accept',{token:otherToken,password});
  assert.equal((await post(hosts.manager,'/auth/users',{action:'credential',userId:other.body.userId,slot:'growth-audience',bearer:keys.writer},admin)).status,403,'backend owner must match the invited person');
  assert.equal((await post(hosts.growth,'/api/segments',{acao:'segmento_contar',brand:'fish'},editor)).status,403);
  assert.equal((await post(hosts.growth,'/api/campaigns',{acao:'campanha_agendar',brand:'fish'},editor)).status,403);
  await post(hosts.manager,'/auth/users',{action:'revoke',userId:invite.body.userId},admin);
  assert.equal((await get('/auth/session',editor)).body.authenticated,false);assert.equal(state.writes,4);
  assert.ok(state.urls.every(url=>['/identity','/dashboard','/segments'].includes(url)));
 }finally{if(portal)await new Promise(resolve=>portal.close(resolve));if(sandbox)await sandbox.close();auth.close();fs.rmSync(dir,{recursive:true,force:true});}
});
