'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {REVIEWED_DYNAMIC,DYNAMIC_MANIFEST_SCHEMA}=require('../services/dashboard-operational/proxy.cjs');

const HOSTS={manager:'draft-owner.example.test',growth:'draft-crm.example.test',organico:'draft-organico.example.test',influs:'draft-influs.example.test'};
const definition={schema_version:'crm-campaign-v1',brand:'fish',channel:'email',initiative:{key:'local-proof',name:'Local proof'},utm_campaign:'local-proof',name:'Local proof',subject:'Proof subject',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:[3],template_id:1,html:'<a href="https://fishermans.com.br/products/proof">Proof</a> {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/proof\n{{ UnsubscribeURL }}',tags:[],send_at:null};
const keyA='draft-proof-key-0000000001',keyB='draft-proof-key-0000000002',keyC='draft-proof-key-0000000003',keyD='draft-proof-key-0000000004';
function call(port,host,route,{method='GET',body,cookie,csrf}={}){
 return new Promise((resolve,reject)=>{
  const headers={Host:host,Origin:'https://'+host};if(body!==undefined)headers['Content-Type']='application/json';if(cookie)headers.Cookie=cookie;if(csrf)headers['X-CSRF-Token']=csrf;
  const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers},res=>{
   const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');let json;try{json=JSON.parse(raw);}catch{}resolve({status:res.statusCode,json,headers:res.headers});});
  });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
}
test('CRM legacy master transport preserves durable unknown receipts while prepared manager journals stay isolated behind ownership gate',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-draft-journal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const bootstrap=crypto.randomBytes(32).toString('base64url');
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),managerHost:HOSTS.manager,areaHosts:{growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs},allowedEmailDomains:['example.test'],bootstrapAdminEmail:'admin@example.test',bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32).toString('hex')});t.after(()=>auth.close());
 const endpoint=REVIEWED_DYNAMIC.routes.campaigns,host=new URL(endpoint).hostname;
 let posts=0,upstreamCalls=0,receiptState='outcome_unknown',receiptVariant='normal',failNextPost=false;
 const saved={id:734,status:'draft',sent:0,started_at:null,send_at:null,definition};
 const fetchImpl=async(url,options)=>{
  upstreamCalls++;
  if(options.method==='POST'){
   assert.equal(JSON.parse(options.body).k,'master-own-writer-2026');
   posts++;if(posts===1||failNextPost){failNextPost=false;throw Error('response lost');}
   return new Response(JSON.stringify({campaign:saved}),{status:201,headers:{'Content-Type':'application/json'}});
  }
  assert.equal(options.headers.Authorization,'Bearer master-own-writer-2026');
  const operation={operation_key:url.searchParams.get('idempotency_key'),action:'salvar',brand:'fish',state:receiptState,providerId:receiptState==='succeeded'?734:null};
  if(receiptState==='succeeded')operation.response={status:201,body:{campaign:saved}};
  if(receiptState==='rejected'){
   operation.id='123e4567-e89b-42d3-a456-426614174000';
   operation.response={status:422,body:{error:'CONTENT_INVALID',...(receiptVariant==='valid'?{provider_id:null}:{})}};
  }
  const result={operation};
  return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
 };
 const server=createServer({mode:'operational',crmDraftWrite:true,managerHost:HOSTS.manager,areaHosts:{growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs},upstreams:{campaigns:new URL(endpoint)},allowedUpstreamHosts:[host],dynamicRouteManifest:{schema:DYNAMIC_MANIFEST_SCHEMA,sourceRevision:REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:endpoint}},publicDir:dir},{auth,fetchImpl});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const port=server.address().port,post=(host,route,body,access={})=>call(port,host,route,{method:'POST',body,...access});
 const adminPassword='Local Admin Password 2026!';
 assert.equal((await post(HOSTS.manager,'/auth/bootstrap/complete',{email:'admin@example.test',token:bootstrap,password:adminPassword})).status,200);
 let adminLogin=await post(HOSTS.manager,'/auth/login',{email:'admin@example.test',password:adminPassword});
 let admin={cookie:adminLogin.headers['set-cookie'][0].split(';')[0],csrf:adminLogin.json.csrf};
 async function manager(email,{credential=true}={}){
  const invite=await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email,brand:'fish',areas:['growth'],permissions:{growth:{read:true,edit:true}}},admin);assert.equal(invite.status,201);
  const token=new URLSearchParams(new URL(invite.json.inviteUrl).hash.slice(1)).get('invite'),password='Local Manager Password 2026!';
  assert.equal((await post(HOSTS.growth,'/auth/invite/accept',{token,password})).status,200);
  if(credential)assert.equal((await post(HOSTS.manager,'/auth/users',{action:'credential',userId:invite.json.userId,slot:'growth-campaign',bearer:'individual-'+email.split('@')[0]+'-writer-2026'},admin)).status,200);
  const login=await post(HOSTS.growth,'/auth/login',{email,password});assert.equal(login.status,200);
  return {email,password,userId:invite.json.userId,cookie:login.headers['set-cookie'][0].split(';')[0],csrf:login.json.csrf};
 }
 const one=await manager('one@example.test',{credential:false}),two=await manager('two@example.test');
 const operation=bodyKey=>({acao:'campanha_salvar',brand:'fish',definition,idempotency_key:bodyKey});
 const journal=(actor,host=HOSTS.growth)=>call(port,host,'/auth/campaign-draft?brand=fish',{cookie:actor.cookie});
 const ownContext=actor=>({host:HOSTS.growth,origin:'https://'+HOSTS.growth,method:'POST',cookieHeader:actor.cookie,csrf:actor.csrf});
 const deniesOwnership=async(actor,bodyKey)=>{
  const before=upstreamCalls,response=await post(HOSTS.growth,'/api/campaigns',operation(bodyKey),actor);
  assert.equal(response.status,503);assert.equal(response.json.error,'BRAND_TEMPLATE_OWNERSHIP_NOT_READY');assert.equal(upstreamCalls,before);
 };
 assert.equal((await journal(one)).json.operation,null);
 assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyA),{cookie:one.cookie})).status,403);
 await deniesOwnership(one,keyA);await deniesOwnership(two,keyA);
 assert.equal((await journal(one)).json.operation,null);assert.equal((await journal(two)).json.operation,null);assert.equal(posts,0);assert.equal(upstreamCalls,0);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'credential',userId:one.userId,slot:'growth-campaign',bearer:'individual-one-writer-2026'},admin)).status,200);
 await deniesOwnership(one,keyA);assert.equal((await journal(one)).json.operation,null);assert.equal(upstreamCalls,0);

 // Positive legacy transport is exercised by the actual bootstrapped master
 // on its own host with explicit own grants/credential. Managers remain
 // single-brand and are not promoted or placed in a WRITE sandbox.
 const masterId=adminLogin.json.user.id;
 assert.equal(adminLogin.json.user.role,'superadmin');assert.equal(adminLogin.json.user.brandAccess,'all');assert.notEqual(masterId,one.userId);assert.notEqual(masterId,two.userId);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'grant',userId:masterId,permissions:{growth:{read:true,edit:true},organico:{read:true,edit:false},influs:{read:true,edit:false}}},admin)).status,200);
 adminLogin=await post(HOSTS.manager,'/auth/login',{email:'admin@example.test',password:adminPassword});assert.equal(adminLogin.status,200);
 admin={cookie:adminLogin.headers['set-cookie'][0].split(';')[0],csrf:adminLogin.json.csrf};
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'credential',userId:masterId,slot:'growth-campaign',bearer:'master-own-writer-2026'},admin)).status,200);
 assert.equal((await post(HOSTS.manager,'/api/campaigns',operation(keyA),admin)).status,502);assert.equal(posts,1);
 const masterJournal=await journal(admin,HOSTS.manager);
 assert.equal(masterJournal.json.operation.operationKey,keyA);assert.equal(masterJournal.json.operation.phase,'uncertain');assert.equal(JSON.stringify(masterJournal.json).includes('Proof subject'),false);
 const blockedMasterRotation=await post(HOSTS.manager,'/auth/users',{action:'credential',userId:masterId,slot:'growth-campaign',bearer:'master-own-replacement-2026'},admin);
 assert.equal(blockedMasterRotation.status,409);assert.equal(blockedMasterRotation.json.error,'DRAFT_RECONCILIATION_REQUIRED');
 assert.equal((await post(HOSTS.manager,'/api/campaigns',operation(keyB),admin)).status,409);assert.equal(posts,1);

 // Prepared, in-process auth state only: model a pre-existing manager journal
 // from before ownership enforcement. These calls produce no HTTP transport
 // or provider effect and do not authorize managers to write through the BFF.
 const preparedCalls=upstreamCalls,preparedPosts=posts;
 assert.throws(()=>auth.reserveCampaignDraft({...ownContext(one),csrf:'forged'},'fish',keyD),{code:'CSRF_DENIED',status:403});
 assert.throws(()=>auth.reserveCampaignDraft(ownContext(one),'aristo',keyD),{code:'BRAND_DENIED',status:403});
 assert.equal((await journal(one)).json.operation,null);
 assert.equal(auth.reserveCampaignDraft(ownContext(one),'fish',keyD),one.userId);
 assert.equal(auth.campaignDraftOutcome(one.userId,'fish',keyD,'uncertain'),true);
 assert.equal(upstreamCalls,preparedCalls);assert.equal(posts,preparedPosts);
 const oneBefore=(await journal(one)).json.operation;assert.equal(oneBefore.operationKey,keyD);assert.equal(oneBefore.phase,'uncertain');assert.equal(JSON.stringify(oneBefore).includes('Proof subject'),false);
 assert.throws(()=>auth.reserveCampaignDraft(ownContext(one),'fish',keyB),{code:'OPERATION_PENDING',status:409});
 const blockedRotation=await post(HOSTS.manager,'/auth/users',{action:'credential',userId:one.userId,slot:'growth-campaign',bearer:'individual-one-replacement-2026'},admin);
 assert.equal(blockedRotation.status,409);assert.equal(blockedRotation.json.error,'DRAFT_RECONCILIATION_REQUIRED');
 await deniesOwnership(one,keyB);assert.deepEqual((await journal(one)).json.operation,oneBefore);
 const beforeForeign=upstreamCalls;
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=aristo',{cookie:one.cookie})).status,403);
 assert.equal((await journal(two)).json.operation,null);
 for(const actor of [one,two])assert.equal((await call(port,HOSTS.growth,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyA}`,actor)).status,404);
 assert.equal(upstreamCalls,beforeForeign);

 // Login rotates sessions but cannot discard either actor's pending journal.
 assert.equal((await post(HOSTS.growth,'/auth/logout',{},one)).status,200);
 const again=await post(HOSTS.growth,'/auth/login',{email:one.email,password:one.password});assert.equal(again.status,200);
 one.cookie=again.headers['set-cookie'][0].split(';')[0];one.csrf=again.json.csrf;
 assert.deepEqual((await journal(one)).json.operation,oneBefore);await deniesOwnership(one,keyB);
 assert.equal((await post(HOSTS.manager,'/auth/logout',{},admin)).status,200);
 adminLogin=await post(HOSTS.manager,'/auth/login',{email:'admin@example.test',password:adminPassword});assert.equal(adminLogin.status,200);
 admin={cookie:adminLogin.headers['set-cookie'][0].split(';')[0],csrf:adminLogin.json.csrf};
 assert.equal((await journal(admin,HOSTS.manager)).json.operation.operationKey,keyA);
 let receipt=await call(port,HOSTS.manager,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyA}`,admin);
 assert.equal(receipt.status,200);assert.equal((await journal(admin,HOSTS.manager)).json.operation.phase,'uncertain');
 receiptState='succeeded';receipt=await call(port,HOSTS.manager,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyA}`,admin);
 assert.equal(receipt.status,200);assert.equal((await journal(admin,HOSTS.manager)).json.operation.phase,'succeeded');
 receiptState='outcome_unknown';
 assert.equal((await call(port,HOSTS.manager,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyA}`,admin)).status,200);
 assert.equal((await journal(admin,HOSTS.manager)).json.operation.phase,'succeeded');
 assert.equal((await post(HOSTS.manager,'/api/campaigns',operation(keyB),admin)).status,201);assert.equal(posts,2);
 failNextPost=true;
 assert.equal((await post(HOSTS.manager,'/api/campaigns',operation(keyC),admin)).status,502);assert.equal(posts,3);
 receiptState='rejected';receiptVariant='malformed';
 assert.equal((await call(port,HOSTS.manager,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyC}`,admin)).status,200);
 assert.equal((await journal(admin,HOSTS.manager)).json.operation.phase,'uncertain');
 assert.equal((await post(HOSTS.manager,'/api/campaigns',operation(keyD),admin)).status,409);assert.equal(posts,3);
 receiptVariant='valid';
 assert.equal((await call(port,HOSTS.manager,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyC}`,admin)).status,200);
 assert.equal((await journal(admin,HOSTS.manager)).json.operation.phase,'rejected');
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'credential',userId:masterId,slot:'growth-campaign',bearer:'master-own-replacement-2026'},admin)).status,200);

 // Prepared manager settlement and lifecycle checks remain distinct from the
 // master HTTP receipt above; no fictional provider operation is sent.
 const lifecycleCalls=upstreamCalls,lifecyclePosts=posts;
 assert.equal(auth.campaignDraftOutcome(one.userId,'fish',keyD,'rejected',{receiptState:'rejected'}),true);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'credential',userId:one.userId,slot:'growth-campaign',bearer:'individual-one-replacement-2026'},admin)).status,200);
 assert.equal(auth.reserveCampaignDraft(ownContext(two),'fish',keyD),two.userId);
 assert.equal(auth.campaignDraftOutcome(two.userId,'fish',keyD,'uncertain'),true);
 assert.equal((await journal(two)).json.operation.phase,'uncertain');await deniesOwnership(two,keyD);
 assert.equal(upstreamCalls,lifecycleCalls);assert.equal(posts,lifecyclePosts);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'grant',userId:two.userId,permissions:{growth:{read:true,edit:false}}},admin)).status,200);
 const blockedRegrant=await post(HOSTS.manager,'/auth/users',{action:'grant',userId:two.userId,permissions:{growth:{read:true,edit:true}}},admin);
 assert.equal(blockedRegrant.status,409);assert.equal(blockedRegrant.json.error,'DRAFT_RECONCILIATION_REQUIRED');
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'revoke',userId:two.userId},admin)).status,200);
 const blockedReinvite=await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:two.email,brand:'fish',areas:['growth'],permissions:{growth:{read:true,edit:true}}},admin);
 assert.equal(blockedReinvite.status,409);assert.equal(blockedReinvite.json.error,'DRAFT_RECONCILIATION_REQUIRED');
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:two.email,brand:'fish',areas:['growth'],permissions:{growth:{read:true,edit:false}}},admin)).status,201);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'revoke',userId:one.userId},admin)).status,200);
 assert.equal((await journal(one)).status,401);assert.equal((await journal(two)).status,401);
 assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyA),one)).status,401);assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyA),two)).status,401);
 assert.equal(upstreamCalls,lifecycleCalls);assert.equal(posts,3);
 assert.equal((await journal(admin,HOSTS.manager)).json.operation.phase,'rejected');
});
