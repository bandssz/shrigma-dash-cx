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
test('opt-in CRM draft journal preserves uncertainty across login and isolates users, brand and revocation',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-draft-journal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const bootstrap=crypto.randomBytes(32).toString('base64url');
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),managerHost:HOSTS.manager,areaHosts:{growth:HOSTS.growth,organico:HOSTS.organico,influs:HOSTS.influs},allowedEmailDomains:['example.test'],bootstrapAdminEmail:'admin@example.test',bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32).toString('hex')});t.after(()=>auth.close());
 const endpoint=REVIEWED_DYNAMIC.routes.campaigns,host=new URL(endpoint).hostname;
 let posts=0,receiptState='outcome_unknown',receiptVariant='normal',failNextPost=false;
 const saved={id:734,status:'draft',sent:0,started_at:null,send_at:null,definition};
 const fetchImpl=async(url,options)=>{
  if(options.method==='POST'){
   posts++;if(posts===1||failNextPost){failNextPost=false;throw Error('response lost');}
   return new Response(JSON.stringify({campaign:saved}),{status:201,headers:{'Content-Type':'application/json'}});
  }
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
 const adminLogin=await post(HOSTS.manager,'/auth/login',{email:'admin@example.test',password:adminPassword});
 const admin={cookie:adminLogin.headers['set-cookie'][0].split(';')[0],csrf:adminLogin.json.csrf};
 async function manager(email,{credential=true}={}){
  const invite=await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email,areas:['growth'],permissions:{growth:{read:true,edit:true}}},admin);assert.equal(invite.status,201);
  const token=new URLSearchParams(new URL(invite.json.inviteUrl).hash.slice(1)).get('invite'),password='Local Manager Password 2026!';
  assert.equal((await post(HOSTS.growth,'/auth/invite/accept',{token,password})).status,200);
  if(credential)assert.equal((await post(HOSTS.manager,'/auth/users',{action:'credential',userId:invite.json.userId,slot:'growth-campaign',bearer:'individual-'+email.split('@')[0]+'-writer-2026'},admin)).status,200);
  const login=await post(HOSTS.growth,'/auth/login',{email,password});assert.equal(login.status,200);
  return {email,password,userId:invite.json.userId,cookie:login.headers['set-cookie'][0].split(';')[0],csrf:login.json.csrf};
 }
 const one=await manager('one@example.test',{credential:false}),two=await manager('two@example.test');
 const operation=bodyKey=>({acao:'campanha_salvar',brand:'fish',definition,idempotency_key:bodyKey});
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:one.cookie})).json.operation,null);
 assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyA),{cookie:one.cookie})).status,403);
 assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyA),one)).status,503);
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:one.cookie})).json.operation,null);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'credential',userId:one.userId,slot:'growth-campaign',bearer:'individual-one-writer-2026'},admin)).status,200);
 assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyA),one)).status,502);
 assert.equal(posts,1);
 const journal=await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:one.cookie});
 assert.equal(journal.json.operation.operationKey,keyA);assert.equal(journal.json.operation.phase,'uncertain');
 assert.equal(JSON.stringify(journal.json).includes('Proof subject'),false);
 const blockedRotation=await post(HOSTS.manager,'/auth/users',{action:'credential',userId:one.userId,slot:'growth-campaign',bearer:'individual-one-replacement-2026'},admin);
 assert.equal(blockedRotation.status,409);assert.equal(blockedRotation.json.error,'DRAFT_RECONCILIATION_REQUIRED');
 assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyB),one)).status,409);assert.equal(posts,1);
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=aristo',{cookie:one.cookie})).json.operation,null);
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:two.cookie})).json.operation,null);
 assert.equal((await call(port,HOSTS.growth,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyA}`,{cookie:two.cookie,csrf:two.csrf})).status,404);
 assert.equal((await post(HOSTS.growth,'/auth/logout',{},one)).status,200);
 const again=await post(HOSTS.growth,'/auth/login',{email:one.email,password:one.password});
 one.cookie=again.headers['set-cookie'][0].split(';')[0];one.csrf=again.json.csrf;
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:one.cookie})).json.operation.operationKey,keyA);
 let receipt=await call(port,HOSTS.growth,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyA}`,{cookie:one.cookie,csrf:one.csrf});
 assert.equal(receipt.status,200);assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:one.cookie})).json.operation.phase,'uncertain');
 receiptState='succeeded';receipt=await call(port,HOSTS.growth,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyA}`,{cookie:one.cookie,csrf:one.csrf});
 assert.equal(receipt.status,200);assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:one.cookie})).json.operation.phase,'succeeded');
 receiptState='outcome_unknown';
 assert.equal((await call(port,HOSTS.growth,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyA}`,{cookie:one.cookie,csrf:one.csrf})).status,200);
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:one.cookie})).json.operation.phase,'succeeded');
 assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyB),one)).status,201);assert.equal(posts,2);
 failNextPost=true;
 assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyC),one)).status,502);
 receiptState='rejected';receiptVariant='malformed';
 assert.equal((await call(port,HOSTS.growth,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyC}`,{cookie:one.cookie,csrf:one.csrf})).status,200);
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:one.cookie})).json.operation.phase,'uncertain');
 assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyD),one)).status,409);
 receiptVariant='valid';
 assert.equal((await call(port,HOSTS.growth,`/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=${keyC}`,{cookie:one.cookie,csrf:one.csrf})).status,200);
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:one.cookie})).json.operation.phase,'rejected');
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'credential',userId:one.userId,slot:'growth-campaign',bearer:'individual-one-replacement-2026'},admin)).status,200);

 failNextPost=true;
 assert.equal((await post(HOSTS.growth,'/api/campaigns',operation(keyD),two)).status,502);
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:two.cookie})).json.operation.phase,'uncertain');
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'grant',userId:two.userId,permissions:{growth:{read:true,edit:false}}},admin)).status,200);
 const blockedRegrant=await post(HOSTS.manager,'/auth/users',{action:'grant',userId:two.userId,permissions:{growth:{read:true,edit:true}}},admin);
 assert.equal(blockedRegrant.status,409);assert.equal(blockedRegrant.json.error,'DRAFT_RECONCILIATION_REQUIRED');
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'revoke',userId:two.userId},admin)).status,200);
 const blockedReinvite=await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:two.email,areas:['growth'],permissions:{growth:{read:true,edit:true}}},admin);
 assert.equal(blockedReinvite.status,409);assert.equal(blockedReinvite.json.error,'DRAFT_RECONCILIATION_REQUIRED');
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'invite',role:'manager',email:two.email,areas:['growth'],permissions:{growth:{read:true,edit:false}}},admin)).status,201);
 assert.equal((await post(HOSTS.manager,'/auth/users',{action:'revoke',userId:one.userId},admin)).status,200);
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:one.cookie})).status,401);
 assert.equal((await call(port,HOSTS.growth,'/auth/campaign-draft?brand=fish',{cookie:two.cookie})).status,401);
});
