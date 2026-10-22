'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createServer}=require('../services/dashboard-operational/server.cjs');
const {DYNAMIC_MANIFEST_SCHEMA,REVIEWED_DYNAMIC,audiencePayloadHash}=require('../services/dashboard-operational/proxy.cjs');
const AudienceHash=require('../n8n/growth/segment-audience-review.cjs');
const {request}=require('../n8n/growth/segment-audience-store.cjs');

const hosts={manager:'manager.synthetic.invalid',growth:'crm.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
const backend=REVIEWED_DYNAMIC.routes.segments,writer='individual-audience-writer-synthetic',actorSha256=crypto.createHash('sha256').update('panel:synthetic-audience-writer').digest('hex');
const catalogHash='a'.repeat(64),segmentId='423e4567-e89b-42d3-a456-426614174000';
const definition=brand=>({schema_version:'crm-audience-v2',brand,name:'Synthetic audience',rule:{op:'in_list',list_id:101}});
const makeBody=(action,brand,key,version)=>action==='segmento_criar'?{acao:action,brand,definition:definition(brand),expected_catalog_hash:catalogHash,idempotency_key:key}:
 action==='segmento_salvar'?{acao:action,brand,id:segmentId,expected_version:version,definition:definition(brand),expected_catalog_hash:catalogHash,idempotency_key:key}:
 {acao:action,brand,id:segmentId,expected_version:version,idempotency_key:key};
const cookie=response=>response.headers['set-cookie'][0].split(';')[0];
function call(port,host,pathname,{method='GET',body,cookie:session,csrf,origin='https://'+host}={}){
 return new Promise((resolve,reject)=>{
  const headers={Host:host};if(origin!==null)headers.Origin=origin;
  if(body!==undefined)headers['Content-Type']='application/json';if(session)headers.Cookie=session;if(csrf)headers['X-CSRF-Token']=csrf;
  const req=http.request({host:'127.0.0.1',port,path:pathname,method,headers},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
    let json;try{json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
    resolve({status:res.statusCode,headers:res.headers,json});
   });
  });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
}
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
async function harness(t,brand='fish'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-audience-bff-'));
 const bootstrap=crypto.randomBytes(32).toString('base64url');
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32).toString('hex')});
 const records=new Map(),state={postCalls:0,lookupCalls:0,scopeCalls:0,next:{}};
 const fetchImpl=async(url,options)=>{
  assert.equal(url.origin,new URL(backend).origin);assert.equal(url.pathname,new URL(backend).pathname);
  assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer '+writer);
  assert.equal(Object.hasOwn(options.headers,'Origin'),false);assert.equal(Object.hasOwn(options.headers,'Cookie'),false);
  if(options.method==='GET'){
   const action=url.searchParams.get('acao'),brand=url.searchParams.get('brand');
   if(action==='segmento_contexto_v2'){
    state.scopeCalls++;assert.equal(url.searchParams.size,2);
    return reply(200,{scope:{schema:'crm-audience-writer-scope-v2',brand,actor_sha256:actorSha256}});
   }
   assert.equal(action,'segmento_operacao_v2');state.lookupCalls++;
   const key=url.searchParams.get('idempotency_key'),record=records.get(key);
   if(!record||record.hiddenReceipt)return reply(404,{error:'SEGMENT_OPERATION_UNCONFIRMED'});
   const envelope={schema:'crm-audience-operation-v2',idempotency_key:key,brand:record.payload.brand,action:record.payload.acao,actor_sha256:actorSha256,payload_sha256:AudienceHash.digest(request(record.payload)),receipt:JSON.parse(JSON.stringify(record.response))};
   if(record.tamper==='action')envelope.action='segmento_salvar';
   if(record.tamper==='payload')envelope.payload_sha256='f'.repeat(64);
   if(record.tamper==='actor')envelope.actor_sha256='e'.repeat(64);
   if(record.tamper==='id')envelope.receipt.body.segment.id='523e4567-e89b-42d3-a456-426614174000';
   if(record.tamper==='version')envelope.receipt.body.segment.version=999;
   if(record.tamper==='definition'){
    envelope.receipt.body.segment.name='Different audience';
    envelope.receipt.body.segment.definition={...definition(record.payload.brand),name:'Different audience'};
   }
   return reply(200,{operation:envelope});
  }
  assert.equal(options.method,'POST');assert.equal(url.search,'');state.postCalls++;
  const payload=JSON.parse(options.body);assert.equal(Object.hasOwn(payload,'k'),false);
  assert.equal(audiencePayloadHash(payload),AudienceHash.digest(request(payload)));
  assert.equal(records.has(payload.idempotency_key),false,'the BFF must never resend a write');
  const behavior={...state.next};state.next={};
  const version=payload.acao==='segmento_criar'?1:payload.expected_version+1;
  const response=behavior.rejection?{status:409,body:{error:'SEGMENT_CATALOG_CHANGED'}}:{status:payload.acao==='segmento_criar'?201:200,body:{segment:{id:segmentId,brand:payload.brand,name:'Synthetic audience',definition:definition(payload.brand),version,archived:payload.acao==='segmento_arquivar'},transport_supported:false}};
  records.set(payload.idempotency_key,{payload,response,hiddenReceipt:!!behavior.hiddenReceipt,tamper:behavior.tamper||null});
  if(behavior.lostAck)throw Error('synthetic ACK loss after commit');
  return reply(response.status,response.body);
 };
 const config={mode:'operational',managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},upstreams:{segments:new URL(backend)},allowedUpstreamHosts:[new URL(backend).hostname],dynamicRouteManifest:{schema:DYNAMIC_MANIFEST_SCHEMA,sourceRevision:REVIEWED_DYNAMIC.sourceRevision,routes:{segments:backend}},publicDir:dir};
 const off=createServer({...config,crmAudienceDraft:false},{auth,fetchImpl}),on=createServer({...config,crmAudienceDraft:true},{auth,fetchImpl});
 await Promise.all([new Promise(resolve=>off.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>on.listen(0,'127.0.0.1',resolve))]);
 t.after(async()=>{await Promise.all([new Promise(resolve=>off.close(resolve)),new Promise(resolve=>on.close(resolve))]);auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 const port=on.address().port,offPort=off.address().port;
 const post=(p,host,pathname,body,options={})=>call(p,host,pathname,{...options,method:'POST',body});
 const adminPassword='Synthetic Admin Password 2026!';
 assert.equal((await post(port,hosts.manager,'/auth/bootstrap/complete',{email:'admin@synthetic.invalid',token:bootstrap,password:adminPassword})).status,200);
 const adminLogin=await post(port,hosts.manager,'/auth/login',{email:'admin@synthetic.invalid',password:adminPassword});
 assert.equal(adminLogin.status,200);const admin={cookie:cookie(adminLogin),csrf:adminLogin.json.csrf};
 const email='crm-'+brand+'@synthetic.invalid';
 const invite=await post(port,hosts.manager,'/auth/users',{action:'invite',role:'manager',email,brand,areas:['growth'],permissions:{growth:{read:true,edit:true}}},admin);
 assert.equal(invite.status,201);
 const userId=invite.json.userId,token=new URLSearchParams(new URL(invite.json.inviteUrl).hash.slice(1)).get('invite');
 const managerPassword='Synthetic Manager Password 2026!';
 assert.equal((await post(port,hosts.growth,'/auth/invite/accept',{token,password:managerPassword})).status,200);
 assert.equal((await post(port,hosts.manager,'/auth/users',{action:'credential',userId,slot:'growth-audience',bearer:writer},admin)).status,200);
 const login=async()=>{
  const response=await post(port,hosts.growth,'/auth/login',{email,password:managerPassword});
  assert.equal(response.status,200);return {cookie:cookie(response),csrf:response.json.csrf};
 };
 const inspect=fn=>{const db=new DatabaseSync(path.join(dir,'identity.sqlite'));try{return fn(db);}finally{db.close();}};
 return {port,offPort,post,call,admin,userId,login,manager:await login(),records,state,inspect};
}

test('audience writer remains OFF by default and permits only verified create, save and archive receipts',async t=>{
 const h=await harness(t),key=crypto.randomUUID(),create=makeBody('segmento_criar','fish',key);
 assert.equal((await h.post(h.offPort,hosts.growth,'/api/segments',create,h.manager)).status,403);
 assert.equal((await h.call(h.offPort,hosts.growth,`/api/segments?acao=segmento_operacao&brand=fish&idempotency_key=${key}`,h.manager)).status,403);
 assert.equal((await h.post(h.port,hosts.growth,'/api/segments',create,{cookie:h.manager.cookie})).status,403);
 assert.equal((await h.post(h.port,hosts.growth,'/api/segments',create,{...h.manager,origin:'https://evil.invalid'})).status,403);
 assert.equal((await h.post(h.port,hosts.influs,'/api/segments',create,h.manager)).status,401);
 assert.equal((await h.post(h.port,hosts.growth,'/api/segments',{...create,acao:'segmento_contar'},h.manager)).status,403);
 assert.equal((await h.post(h.port,hosts.growth,'/api/campaign_audience',{acao:'campanha_publico_vincular',brand:'fish'},h.manager)).status,403);
 assert.equal((await h.call(h.port,hosts.growth,'/api/segments?acao=segmento_contexto_v2&brand=fish',h.manager)).status,403);
 assert.equal(h.state.scopeCalls,0);assert.equal(h.state.postCalls,0);
 const saved=await h.post(h.port,hosts.growth,'/api/segments',create,h.manager);
 assert.equal(saved.status,201);assert.equal(saved.json.segment.version,1);assert.equal(h.state.postCalls,1);
 assert.equal((await h.post(h.port,hosts.growth,'/api/segments',create,h.manager)).status,409);
 const saveKey=crypto.randomUUID(),save=makeBody('segmento_salvar','fish',saveKey,1);
 assert.equal((await h.post(h.port,hosts.growth,'/api/segments',save,h.manager)).status,200);
 const archiveKey=crypto.randomUUID(),archive=makeBody('segmento_arquivar','fish',archiveKey,2);
 const archived=await h.post(h.port,hosts.growth,'/api/segments',archive,h.manager);
 assert.equal(archived.status,200);assert.equal(archived.json.segment.archived,true);
 assert.equal(h.state.postCalls,3);
});

test('lost acknowledgement stays uncertain through relogin and reconciles by GET without a second write',async t=>{
 const h=await harness(t),key=crypto.randomUUID(),body=makeBody('segmento_criar','fish',key),receipt=`/api/segments?acao=segmento_operacao&brand=fish&idempotency_key=${key}`;
 h.state.next={lostAck:true};
 const first=await h.post(h.port,hosts.growth,'/api/segments',body,h.manager);
 assert.equal(first.status,502);assert.equal(first.json.error,'UPSTREAM_UNAVAILABLE');assert.equal(h.state.postCalls,1);
 const next=makeBody('segmento_criar','fish',crypto.randomUUID());
 assert.equal((await h.post(h.port,hosts.growth,'/api/segments',next,h.manager)).status,409);
 const manager=await h.login();
 assert.equal((await h.call(h.port,hosts.growth,receipt,{cookie:manager.cookie})).status,403);
 assert.equal((await h.call(h.port,hosts.growth,receipt,{...manager,origin:'https://evil.invalid'})).status,403);
 const recovered=await h.call(h.port,hosts.growth,receipt,manager);
 assert.equal(recovered.status,201);assert.equal(recovered.json.segment.id,segmentId);
 assert.equal(h.state.postCalls,1);assert.equal(h.state.lookupCalls,1);
 const journal=await h.call(h.port,hosts.growth,'/auth/audience-draft?brand=fish',manager);
 assert.equal(journal.status,200);assert.equal(journal.json.operation.phase,'succeeded');
 assert.equal((await h.call(h.port,hosts.growth,'/auth/audience-draft?brand=fish',{cookie:manager.cookie})).status,403);
});

test('absent or contradictory receipts never clear uncertainty; a durable rejection can clear it',async t=>{
 const h=await harness(t),fishKey=crypto.randomUUID(),fish=makeBody('segmento_criar','fish',fishKey);
 h.state.next={hiddenReceipt:true};
 const missing=await h.post(h.port,hosts.growth,'/api/segments',fish,h.manager);
 assert.equal(missing.status,502);assert.equal(missing.json.error,'UPSTREAM_RECEIPT_UNCONFIRMED');
 assert.equal((await h.call(h.port,hosts.growth,`/api/segments?acao=segmento_operacao&brand=fish&idempotency_key=${fishKey}`,h.manager)).status,404);
 assert.equal((await h.post(h.port,hosts.growth,'/api/segments',makeBody('segmento_criar','fish',crypto.randomUUID()),h.manager)).status,409);
 const a=await harness(t,'aristo');assert.notEqual(a.userId,h.userId);
 const foreign=makeBody('segmento_criar','aristo',crypto.randomUUID()),beforeCalls={post:h.state.postCalls,lookup:h.state.lookupCalls,scope:h.state.scopeCalls},beforeJournal=h.inspect(db=>db.prepare('SELECT * FROM audience_draft_operations ORDER BY user_id,brand').all());
 assert.equal((await h.post(h.port,hosts.growth,'/api/segments',foreign,h.manager)).status,403);
 assert.equal((await h.call(h.port,hosts.growth,`/api/segments?acao=segmento_operacao&brand=aristo&idempotency_key=${foreign.idempotency_key}`,h.manager)).status,403);
 assert.equal((await h.call(h.port,hosts.growth,'/auth/audience-draft?brand=aristo',h.manager)).status,403);
 assert.deepEqual({post:h.state.postCalls,lookup:h.state.lookupCalls,scope:h.state.scopeCalls},beforeCalls);assert.deepEqual(h.inspect(db=>db.prepare('SELECT * FROM audience_draft_operations ORDER BY user_id,brand').all()),beforeJournal);assert.equal(h.inspect(db=>db.prepare("SELECT count(*) n FROM audience_draft_operations WHERE user_id=? AND brand='aristo'").get(h.userId)).n,0);
 const aristoKey=crypto.randomUUID(),aristo=makeBody('segmento_criar','aristo',aristoKey);
 a.state.next={tamper:'action'};
 const contradictory=await a.post(a.port,hosts.growth,'/api/segments',aristo,a.manager);
 assert.equal(contradictory.status,502);assert.equal(contradictory.json.error,'UPSTREAM_RECEIPT_UNCONFIRMED');
 a.records.get(aristoKey).tamper='payload';
 assert.equal((await a.call(a.port,hosts.growth,`/api/segments?acao=segmento_operacao&brand=aristo&idempotency_key=${aristoKey}`,a.manager)).status,502);
 a.records.get(aristoKey).tamper='actor';
 assert.equal((await a.call(a.port,hosts.growth,`/api/segments?acao=segmento_operacao&brand=aristo&idempotency_key=${aristoKey}`,a.manager)).status,502);
 a.records.get(aristoKey).tamper='definition';
 assert.equal((await a.call(a.port,hosts.growth,`/api/segments?acao=segmento_operacao&brand=aristo&idempotency_key=${aristoKey}`,a.manager)).status,502);
 assert.equal((await a.post(a.port,hosts.growth,'/api/segments',makeBody('segmento_criar','aristo',crypto.randomUUID()),a.manager)).status,409);
 a.records.get(aristoKey).tamper=null;
 assert.equal((await a.call(a.port,hosts.growth,`/api/segments?acao=segmento_operacao&brand=aristo&idempotency_key=${aristoKey}`,a.manager)).status,201);
 const saveKey=crypto.randomUUID();a.state.next={tamper:'id'};
 assert.equal((await a.post(a.port,hosts.growth,'/api/segments',makeBody('segmento_salvar','aristo',saveKey,1),a.manager)).status,502);
 a.records.get(saveKey).tamper='version';
 assert.equal((await a.call(a.port,hosts.growth,`/api/segments?acao=segmento_operacao&brand=aristo&idempotency_key=${saveKey}`,a.manager)).status,502);
 assert.equal((await a.post(a.port,hosts.growth,'/api/segments',makeBody('segmento_salvar','aristo',crypto.randomUUID(),1),a.manager)).status,409);
 a.records.get(saveKey).tamper=null;
 assert.equal((await a.call(a.port,hosts.growth,`/api/segments?acao=segmento_operacao&brand=aristo&idempotency_key=${saveKey}`,a.manager)).status,200);
 const rejectionKey=crypto.randomUUID();a.state.next={rejection:true};
 const rejected=await a.post(a.port,hosts.growth,'/api/segments',makeBody('segmento_criar','aristo',rejectionKey),a.manager);
 assert.equal(rejected.status,409);assert.equal(rejected.json.error,'SEGMENT_CATALOG_CHANGED');
 assert.equal((await a.call(a.port,hosts.growth,'/auth/audience-draft?brand=aristo',a.manager)).json.operation.phase,'rejected');
 assert.equal(h.state.postCalls+a.state.postCalls,4,'no write was replayed during receipt recovery');assert.equal(h.state.postCalls,1);assert.equal(a.state.postCalls,3);
});
