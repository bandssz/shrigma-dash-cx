'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {DYNAMIC_MANIFEST_SCHEMA,REVIEWED_DYNAMIC}=require('../services/dashboard-operational/proxy.cjs');

const hosts={manager:'manager.synthetic.invalid',growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
const backend=REVIEWED_DYNAMIC.routes.campaigns;
const key='campaign-save-key-0000001';
const definition=(brand='fish')=>({schema_version:'crm-campaign-v1',brand,channel:'email',initiative:{key:'draft-proof',name:'Draft proof'},utm_campaign:'draft-proof',name:'Draft proof',subject:'Draft proof',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[3],template_id:1,html:'<a href="https://fishermans.com.br/products/proof">Proof</a> {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/proof\n{{ UnsubscribeURL }}',tags:[],send_at:null});
function call(port,host,pathname,{method='GET',body,cookie,csrf,origin='https://'+host}={}){
 return new Promise((resolve,reject)=>{
  const headers={Host:host,Origin:origin};if(body!==undefined)headers['Content-Type']='application/json';
  if(cookie)headers.Cookie=cookie;if(csrf)headers['X-CSRF-Token']=csrf;
  const req=http.request({host:'127.0.0.1',port,path:pathname,method,headers},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
    const raw=Buffer.concat(chunks).toString('utf8');let json;try{json=JSON.parse(raw);}catch{}
    resolve({status:res.statusCode,headers:res.headers,json});
   });
  });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
}
const cookie=response=>response.headers['set-cookie'][0].split(';')[0];
test('CRM legacy draft gate blocks single-brand managers and preserves master idempotent unscheduled drafts and receipts',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-campaign-write-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const bootstrap=crypto.randomBytes(32).toString('base64url');
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32).toString('hex')});
 t.after(()=>auth.close());
 const operations=new Map(),campaigns=new Map();let effects=0,upstreamCalls=0,nextId=101;
 const fetchImpl=async(url,options)=>{
  upstreamCalls++;
  assert.equal(url.origin,new URL(backend).origin);
  assert.equal(url.pathname,new URL(backend).pathname);
  assert.equal(Object.hasOwn(options.headers,'Origin'),false);
  assert.equal(options.redirect,'manual');
  const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  if(options.method==='GET'){
   assert.equal(options.headers.Authorization,'Bearer master-own-campaign-writer');
   assert.equal(url.searchParams.get('acao'),'campanha_operacao');
   const operation=operations.get(url.searchParams.get('idempotency_key'));
   return operation?reply(200,{operation:{operation_key:url.searchParams.get('idempotency_key'),action:'salvar',brand:operation.body.brand,state:operation.response.status<300?'succeeded':'rejected',providerId:operation.response.body.campaign?.id??null,response:operation.response}}):reply(404,{error:'OPERATION_NOT_FOUND'});
  }
  assert.equal(options.method,'POST');
  assert.equal(url.search,'');
  assert.equal(Object.hasOwn(options.headers,'Authorization'),false);
  const body=JSON.parse(options.body);assert.equal(body.k,'master-own-campaign-writer');
  assert.equal(body.acao,'campanha_salvar');assert.equal(body.definition.send_at,null);
  const prior=operations.get(body.idempotency_key),payload=JSON.stringify({...body,k:undefined});
  if(prior)return prior.payload===payload?reply(prior.response.status,prior.response.body):reply(409,{error:'IDEMPOTENCY_CONFLICT'});
  let response;
  if(body.id){
   const current=campaigns.get(body.id);
   if(!current||body.expected_version!==current.version)response={status:409,body:{error:'VERSION_CONFLICT'}};
   else{
    effects++;const updated={...current,version:'b'.repeat(32),definition:body.definition};campaigns.set(body.id,updated);
    response={status:200,body:{campaign:updated,operation_id:'fake-update'}};
   }
  }else{
   effects++;const saved={id:nextId++,version:'a'.repeat(32),status:'draft',sent:0,started_at:null,send_at:null,definition:body.definition};campaigns.set(saved.id,saved);
   response={status:201,body:{campaign:saved,operation_id:'fake-create'}};
  }
  operations.set(body.idempotency_key,{body,payload,response});return reply(response.status,response.body);
 };
 const config={mode:'operational',managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},upstreams:{campaigns:new URL(backend)},allowedUpstreamHosts:[new URL(backend).hostname],dynamicRouteManifest:{schema:DYNAMIC_MANIFEST_SCHEMA,sourceRevision:REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:backend}},publicDir:dir};
 const off=createServer({...config,crmDraftWrite:false},{auth,fetchImpl}),on=createServer({...config,crmDraftWrite:true},{auth,fetchImpl});
 await Promise.all([new Promise(resolve=>off.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>on.listen(0,'127.0.0.1',resolve))]);
 t.after(()=>Promise.all([new Promise(resolve=>off.close(resolve)),new Promise(resolve=>on.close(resolve))]));
 const offPort=off.address().port,port=on.address().port;
 const post=(p,h,pathname,body,options={})=>call(p,h,pathname,{...options,method:'POST',body});
 const adminPassword='Synthetic Admin Password 2026!';
 assert.equal((await post(port,hosts.manager,'/auth/bootstrap/complete',{email:'admin@synthetic.invalid',token:bootstrap,password:adminPassword})).status,200);
 let adminLogin=await post(port,hosts.manager,'/auth/login',{email:'admin@synthetic.invalid',password:adminPassword});
 assert.equal(adminLogin.status,200);let admin={cookie:cookie(adminLogin),csrf:adminLogin.json.csrf};
 const invited=await post(port,hosts.manager,'/auth/users',{action:'invite',role:'manager',email:'crm@synthetic.invalid',brand:'fish',areas:['growth'],permissions:{growth:{read:true,edit:false}}},admin);
 assert.equal(invited.status,201);const userId=invited.json.userId,inviteToken=new URLSearchParams(new URL(invited.json.inviteUrl).hash.slice(1)).get('invite');
 const managerPassword='Synthetic Manager Password 2026!';
 assert.equal((await post(port,hosts.growth,'/auth/invite/accept',{token:inviteToken,password:managerPassword})).status,200);
 let login=await post(port,hosts.growth,'/auth/login',{email:'crm@synthetic.invalid',password:managerPassword});
 assert.equal(login.status,200);let manager={cookie:cookie(login),csrf:login.json.csrf};
 const create={acao:'campanha_salvar',brand:'fish',definition:definition(),idempotency_key:key};
 assert.equal((await post(port,hosts.growth,'/api/campaigns',create,manager)).status,403);
 assert.equal((await post(offPort,hosts.manager,'/auth/users',{action:'grant',userId,permissions:{growth:{read:true,edit:true}}},admin)).status,403);
 assert.equal((await post(port,hosts.manager,'/auth/users',{action:'grant',userId,permissions:{growth:{read:true,edit:true}}},admin)).status,200);
 login=await post(port,hosts.growth,'/auth/login',{email:'crm@synthetic.invalid',password:managerPassword});manager={cookie:cookie(login),csrf:login.json.csrf};
 assert.equal((await post(port,hosts.growth,'/api/campaigns',create,manager)).status,503);
 assert.equal((await post(offPort,hosts.manager,'/auth/users',{action:'credential',userId,slot:'growth-campaign',bearer:'individual-campaign-writer'},admin)).status,403);
 assert.equal((await post(port,hosts.manager,'/auth/users',{action:'credential',userId,slot:'growth-campaign',bearer:'individual-campaign-writer'},admin)).status,200);
 assert.equal((await post(port,hosts.manager,'/auth/users',{action:'credential',userId,slot:'growth-audience',bearer:'other-individual-writer'},admin)).status,403);
 assert.equal((await post(offPort,hosts.growth,'/api/campaigns',create,manager)).status,403);
 assert.equal((await post(port,hosts.growth,'/api/campaigns',create,{cookie:manager.cookie})).status,403);
 assert.equal((await post(port,hosts.growth,'/api/campaigns',create,{...manager,origin:'https://evil.invalid'})).status,403);
 assert.equal((await post(port,hosts.growth,'/api/campaigns',{...create,k:'browser-real-key'},manager)).status,403);
 assert.equal((await post(port,hosts.growth,'/api/campaigns',{...create,acao:'campanha_agendar'},manager)).status,403);
 assert.equal((await post(port,hosts.growth,'/api/campaigns_media',{brand:'fish'},manager)).status,403);
 assert.equal(upstreamCalls,0);
 // The production template provider has no per-brand ownership contract.
 // Even an explicitly granted manager with an individual credential must stop
 // before journal reservation and transport; this is not a WRITE sandbox.
 for(const request of [create,{...create,k:'ui-'+'a'.repeat(32)}]){
  const denied=await post(port,hosts.growth,'/api/campaigns',request,manager);
  assert.equal(denied.status,503);assert.equal(denied.json.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');
 }
 assert.equal((await call(port,hosts.growth,'/auth/campaign-draft?brand=fish',{cookie:manager.cookie})).json.operation,null);
 assert.equal(upstreamCalls,0);assert.equal(effects,0);
 // Preserve the legacy gateway's positive transport/journal proofs with the
 // real bootstrapped master, its own grants and its own credential. No manager
 // is converted to master, and no HTTP ownership gate is bypassed.
 const adminId=adminLogin.json.user.id;
 assert.equal(adminLogin.json.user.role,'superadmin');assert.equal(adminLogin.json.user.brandAccess,'all');
 assert.notEqual(adminId,userId);
 assert.equal((await post(port,hosts.manager,'/auth/users',{action:'grant',userId:adminId,permissions:{growth:{read:true,edit:true},organico:{read:true,edit:false},influs:{read:true,edit:false}}},admin)).status,200);
 adminLogin=await post(port,hosts.manager,'/auth/login',{email:'admin@synthetic.invalid',password:adminPassword});assert.equal(adminLogin.status,200);admin={cookie:cookie(adminLogin),csrf:adminLogin.json.csrf};
 assert.equal((await post(port,hosts.manager,'/auth/users',{action:'credential',userId:adminId,slot:'growth-campaign',bearer:'master-own-campaign-writer'},admin)).status,200);
 const saved=await post(port,hosts.manager,'/api/campaigns',{...create,k:'ui-'+'a'.repeat(32)},admin);
 assert.equal(saved.status,201);assert.equal(saved.json.campaign.status,'draft');assert.equal(saved.json.campaign.send_at,null);assert.equal(effects,1);
 const replay=await post(port,hosts.manager,'/api/campaigns',create,admin);
 assert.equal(replay.status,409);assert.equal(replay.json.error,'OPERATION_PENDING');assert.equal(effects,1);
 assert.equal((await post(port,hosts.manager,'/api/campaigns',{...create,definition:{...definition(),subject:'Changed'}},admin)).status,409);
 assert.equal(effects,1);
 const receipt='/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key='+key;
 assert.equal((await call(port,hosts.manager,receipt,{cookie:admin.cookie})).status,403);
 assert.equal((await call(offPort,hosts.manager,receipt,admin)).status,403);
 assert.equal((await call(port,hosts.manager,receipt,admin)).json.operation.state,'succeeded');
 assert.equal((await call(port,hosts.influs,receipt,admin)).status,401);
 const edit={...create,id:saved.json.campaign.id,expected_version:saved.json.campaign.version,idempotency_key:'campaign-edit-key-000001'};
 assert.equal((await post(port,hosts.manager,'/api/campaigns',edit,admin)).status,200);assert.equal(effects,2);
 assert.equal((await post(port,hosts.manager,'/api/campaigns',{...edit,idempotency_key:'campaign-stale-key-00001'},admin)).status,409);assert.equal(effects,2);
 const masterJournalBefore=(await call(port,hosts.manager,'/auth/campaign-draft?brand=fish',{cookie:admin.cookie})).json.operation;assert.equal(masterJournalBefore.operationKey,'campaign-stale-key-00001');assert.equal(masterJournalBefore.phase,'uncertain');
 assert.equal((await post(port,hosts.manager,'/auth/users',{action:'revoke',userId},admin)).status,200);
 const before=upstreamCalls;
 assert.equal((await post(port,hosts.growth,'/api/campaigns',{...create,idempotency_key:'campaign-after-revoke-001'},manager)).status,401);
 assert.equal((await call(port,hosts.growth,receipt,manager)).status,401);
 assert.equal(upstreamCalls,before);
 assert.equal(effects,2);
 assert.deepEqual((await call(port,hosts.manager,'/auth/campaign-draft?brand=fish',{cookie:admin.cookie})).json.operation,masterJournalBefore);
});
