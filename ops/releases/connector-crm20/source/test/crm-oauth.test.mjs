import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Store} from '../src/store.mjs';
import {buildApp} from '../src/server.mjs';
import {CLAUDE_CALLBACK,SCOPE} from '../src/auth.mjs';

const issuer='https://crm-oauth.synthetic.invalid',clientId='crm-synthetic-client';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
class Jar {
 constructor(){this.cookies=new Map();}
 save(rows=[]){for(const row of rows){const [pair,...attrs]=row.split(';'),index=pair.indexOf('='),name=pair.slice(0,index),value=pair.slice(index+1);const p=attrs.find(a=>a.trim().toLowerCase().startsWith('path='))?.trim().slice(5)||'/';this.cookies.set(name+'|'+p,{name,value,path:p});}}
 header(p){return [...this.cookies.values()].filter(c=>p===c.path||p.startsWith(c.path.endsWith('/')?c.path:c.path+'/')).map(c=>c.name+'='+c.value).join('; ');}
}
test('CRM OAuth, MCP, revoked session, same-browser reconnection and identity refusal',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-oauth-'));
 const store=new Store(path.join(dir,'state.db'),crypto.randomBytes(32),{initialize:true,environment:'test'});
 const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 let server,port,crmVersion=0,crmRevoked=false,wrongIdentity=false,nativeListmonkCalls=0;
 const calls=[],secrets=[];
 const login='editor-qa-aristo@shrigma.com.br';
 const user=store.addUser({id:'oauth-crm-qa',login,brand:'aristo',passwordHash:'CRM_LOGIN',credential:{},crm:true,apiUserId:null});
 const sessionResponse=()=>({authenticated:true,user:{id:wrongIdentity?'another-person':'crm-qa',email:wrongIdentity?'another@shrigma.com.br':login,brands:['aristo'],permissions:{growth:{read:true,edit:true}}},csrf:'synthetic-csrf-'+crmVersion});
 const crmFetch=async(raw,options={})=>{
  const url=new URL(raw);assert.equal(url.origin,'https://crm.shrigma.com.br');calls.push({path:url.pathname,method:options.method||'GET',cookie:options.headers?.Cookie});
  if(url.pathname==='/auth/login'){
   assert.equal(options.headers.Origin,url.origin);assert.deepEqual(JSON.parse(options.body),{email:login,password:'synthetic-CRM-password'});crmVersion++;crmRevoked=false;
   const cookie='__Host-shrigma_sid=synthetic-session-'+crmVersion;secrets.push(cookie,'synthetic-csrf-'+crmVersion);
   return Response.json({authenticated:true},{headers:{'set-cookie':cookie+'; Secure; HttpOnly; Path=/'}});
  }
  if(crmRevoked)return Response.json({error:'AUTH_REQUIRED'},{status:401});
  assert.equal(options.headers.Cookie,'__Host-shrigma_sid=synthetic-session-'+crmVersion);
  if(url.pathname==='/auth/session')return Response.json(sessionResponse());
  assert.equal(options.headers['X-Shrigma-View-Brand'],'aristo');
  if(url.pathname==='/api/campaigns'){
   if(options.method==='POST'){assert.equal(options.headers['X-CSRF-Token'],'synthetic-csrf-'+crmVersion);assert.equal(JSON.parse(options.body).acao,'campanha_criar');return Response.json({campaign:{id:50001,status:'draft',send_at:null,sent:0}},{status:201});}
   return Response.json({campaigns:[],brand:'aristo'});
  }
  throw Error('UNEXPECTED_CRM_REQUEST');
 };
 const built=buildApp({store,config:{origin:issuer,clientId,environment:'test',upstream:'http://127.0.0.1:9'},secret:{adminSha:sha('synthetic-owner'),jwks:{keys:[{...privateKey.export({format:'jwk'}),kid:'synthetic',use:'sig',alg:'RS256'}]},cookieKeys:[crypto.randomBytes(32).toString('hex')]},crmFetch,clientFor:()=>{nativeListmonkCalls++;throw Error('CRM_MUST_NOT_CALL_LISTMONK_CONNECTOR');}});
 async function request(target,{method='GET',form,jar,bearer,jsonBody}={}){
  const url=new URL(target,issuer);assert.equal(url.origin,issuer);
  const body=form?new URLSearchParams(form).toString():jsonBody?JSON.stringify(jsonBody):null;
  const headers={Host:url.host,'X-Forwarded-Proto':'https',Accept:'application/json, text/event-stream'};
  if(jar?.header(url.pathname))headers.Cookie=jar.header(url.pathname);
  if(bearer)headers.Authorization='Bearer '+bearer;
  if(body){if(url.pathname.startsWith('/interaction/')||url.pathname==='/mcp')headers.Origin=issuer;headers['Content-Type']=form?'application/x-www-form-urlencoded':'application/json';headers['Content-Length']=Buffer.byteLength(body);}
  return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:url.pathname+url.search,method,headers},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>{jar?.save(res.headers['set-cookie']);resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(parts).toString()});});});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('LOCAL_TIMEOUT')));if(body)req.write(body);req.end();});
 }
 async function authorize(jar,{expectRefusal=false}={}){
  const verifier=crypto.randomBytes(32).toString('base64url');
  let target='/auth?'+new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:CLAUDE_CALLBACK,scope:'openid offline_access '+SCOPE,resource:issuer+'/mcp',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state:'synthetic'}),logins=0;
  for(let i=0;i<15;i++){
   const r=await request(target,{jar});
   if(r.status>=300&&r.status<400){const next=new URL(r.headers.location,target.startsWith('/')?issuer+target:target);if(next.origin===new URL(CLAUDE_CALLBACK).origin){assert(!expectRefusal);assert.equal(next.origin+next.pathname,CLAUDE_CALLBACK);assert.equal(logins,1,'CRM connection requires its own native login');const t=await request('/token',{method:'POST',form:{grant_type:'authorization_code',client_id:clientId,code:next.searchParams.get('code'),code_verifier:verifier,redirect_uri:CLAUDE_CALLBACK,resource:issuer+'/mcp'}});assert.equal(t.status,200,t.text);return JSON.parse(t.text);}assert.equal(next.origin,issuer);target=next.href;continue;}
   assert.equal(r.status,200);const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(r.text)?.[1];assert(csrf);
   const isLogin=r.text.includes('name="login"');if(isLogin)logins++;
   const post=await request(target,{method:'POST',form:isLogin?{csrf,login,password:'synthetic-CRM-password'}:{csrf},jar});
   if(expectRefusal){assert(isLogin);assert.equal(post.status,401);assert.equal(logins,1);return null;}
   assert(post.status>=300&&post.status<400);target=new URL(post.headers.location,target.startsWith('/')?issuer+target:target).href;
  }
  throw Error('AUTHORIZATION_LOOP');
 }
 const rpc=async(tokens,method,params={})=>{const r=await request('/mcp',{method:'POST',bearer:tokens.access_token,jsonBody:{jsonrpc:'2.0',id:1,method,params}});assert.equal(r.status,200);return JSON.parse(/^data: (.*)$/m.exec(r.text)?.[1]??r.text);};
 try{
  server=built.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));port=server.address().port;
  const jar=new Jar(),tokens=await authorize(jar);
  assert.equal(store.credentials(user.id).crm.userId,'crm-qa');assert(!JSON.stringify(store.credentials(user.id)).includes('synthetic-CRM-password'));
  const tools=await rpc(tokens,'tools/list');assert.equal(tools.result.tools.length,15);assert(tools.result.tools.every(t=>t.name.startsWith('crm_')));
  const created=await rpc(tokens,'tools/call',{name:'crm_campaign_create',arguments:{brand:'aristo',definition:{brand:'aristo',name:'[QA] synthetic chat'}}});assert.equal(created.result.structuredContent.campaign.id,50001);
  const beforeCross=calls.length,cross=await rpc(tokens,'tools/call',{name:'crm_campaign_list',arguments:{brand:'fish'}});assert.equal(cross.result.structuredContent.error,'BRAND_FORBIDDEN');assert.equal(calls.length,beforeCross);
  crmRevoked=true;const beforeExpired=calls.length;
  const refused=await rpc(tokens,'tools/call',{name:'crm_campaign_create',arguments:{brand:'aristo',definition:{}}});assert.equal(refused.result.structuredContent.error,'CRM_RECONNECT_REQUIRED');assert.equal(calls.length,beforeExpired+1,'no retry');
  const renewed=await authorize(jar);assert.equal(crmVersion,2);const current=await rpc(renewed,'tools/call',{name:'crm_status',arguments:{}});assert.equal(current.result.structuredContent.user.id,'crm-qa');
  const oldCredential=store.db.prepare('SELECT credential FROM analysts WHERE id=?').get(user.id).credential;
  wrongIdentity=true;await authorize(jar,{expectRefusal:true});assert.equal(store.db.prepare('SELECT credential FROM analysts WHERE id=?').get(user.id).credential,oldCredential);
  for(const table of ['campaigns','operations','locks','test_claims','phases'])assert.equal(store.db.prepare('SELECT count(*) n FROM '+table).get().n,0,table+' remains unchanged');
  assert.equal(nativeListmonkCalls,0);const audit=JSON.stringify(store.db.prepare('SELECT * FROM audit').all());assert(!audit.includes('synthetic-CRM-password'));for(const value of secrets)assert(!audit.includes(value));
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await built.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
