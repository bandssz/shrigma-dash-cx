// Explicit QA proof only. OAuth/MCP run locally; every CRM action is real.
// No TEST, schedule, cancel, Listmonk credentials, or production connector edit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {buildApp} from '../src/server.mjs';
import {CLAUDE_CALLBACK,SCOPE} from '../src/auth.mjs';

assert.equal(process.argv[2],'--live-qa');
const proofFile='/proof/connector-chat-qa-complete.safe.json';assert(!fs.existsSync(proofFile),'EXISTING_PROOF_DO_NOT_REPEAT');
const bundle=JSON.parse(fs.readFileSync('/run/secrets/qa-accounts'));
const issuer='https://crm-mcp.qa.synthetic.invalid',clientId='crm-headless-qa';
const report={schema:'crm-candidate-chat-qa-v1',atUtc:new Date().toISOString(),ok:false,serial:true,actualCrm:true,localMcp:true,productionConnectorInstalled:false,oauthProvider:'isolated real oidc-provider with synthetic signing key',smtp:0,schedules:0,commercial:0,customerWrites:0,rows:[]};
class Jar {
 constructor(){this.items=new Map();}
 save(rows=[]){for(const row of rows){const [pair,...attrs]=row.split(';'),i=pair.indexOf('='),name=pair.slice(0,i),value=pair.slice(i+1),p=attrs.find(a=>a.trim().toLowerCase().startsWith('path='))?.trim().slice(5)||'/';this.items.set(name+'|'+p,{name,value,path:p});}}
 header(p){return [...this.items.values()].filter(c=>p===c.path||p.startsWith(c.path.endsWith('/')?c.path:c.path+'/')).map(c=>c.name+'='+c.value).join('; ');}
}
async function prove(brand){
 const row={brand,ok:false,phase:'initialize',crmCalls:[]};report.rows.push(row);
 const account=bundle.accounts.find(a=>a.editorPath===true&&a.email==='editor-qa-'+brand+'@shrigma.com.br');assert(account&&account.brands.includes(brand));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crm-headless-')),store=new Store(path.join(dir,'qa.db'),crypto.randomBytes(32),{initialize:true,environment:'test'});
 const user=store.addUser({login:account.email,brand,passwordHash:'CRM_LOGIN',credential:{},crm:true,apiUserId:null});
 const{privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const built=buildApp({store,config:{origin:issuer,clientId,environment:'test',upstream:'http://127.0.0.1:9'},secret:{adminSha:crypto.createHash('sha256').update('synthetic-owner').digest('hex'),jwks:{keys:[{...privateKey.export({format:'jwk'}),kid:'qa',use:'sig',alg:'RS256'}]},cookieKeys:[crypto.randomBytes(32).toString('hex')]},clientFor:()=>{throw Error('LISTMONK_CONNECTOR_MUST_NOT_RUN');},crmFetch:async(url,opts)=>{assert.equal(new URL(url).origin,'https://crm.shrigma.com.br');row.crmCalls.push({path:new URL(url).pathname,method:opts.method||'GET'});return fetch(url,opts);}});
 let server,port;
 async function request(target,{method='GET',form,jar,bearer,jsonBody}={}){
  const u=new URL(target,issuer);assert.equal(u.origin,issuer);
  const body=form?new URLSearchParams(form).toString():jsonBody?JSON.stringify(jsonBody):null,headers={Host:u.host,'X-Forwarded-Proto':'https',Accept:'application/json, text/event-stream'};
  if(jar?.header(u.pathname))headers.Cookie=jar.header(u.pathname);if(bearer)headers.Authorization='Bearer '+bearer;
  if(body){if(u.pathname.startsWith('/interaction/')||u.pathname==='/mcp')headers.Origin=issuer;headers['Content-Type']=form?'application/x-www-form-urlencoded':'application/json';headers['Content-Length']=Buffer.byteLength(body);}
  return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:u.pathname+u.search,method,headers},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>{jar?.save(res.headers['set-cookie']);resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(parts).toString()});});});req.on('error',reject);req.setTimeout(95000,()=>req.destroy(Error('LOCAL_MCP_UNCONFIRMED')));if(body)req.write(body);req.end();});
 }
 async function authorize(){
  const jar=new Jar(),verifier=crypto.randomBytes(32).toString('base64url');
  let target=issuer+'/auth?'+new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:CLAUDE_CALLBACK,scope:'openid offline_access '+SCOPE,resource:issuer+'/mcp',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state:'qa'});
  for(let n=0;n<15;n++){
   const r=await request(target,{jar});
   if(r.status>=300&&r.status<400){const next=new URL(r.headers.location,target);if(next.origin===new URL(CLAUDE_CALLBACK).origin){assert.equal(next.origin+next.pathname,CLAUDE_CALLBACK);assert(!next.searchParams.has('error'));const t=await request('/token',{method:'POST',form:{grant_type:'authorization_code',client_id:clientId,code:next.searchParams.get('code'),code_verifier:verifier,redirect_uri:CLAUDE_CALLBACK,resource:issuer+'/mcp'}});assert.equal(t.status,200);return JSON.parse(t.text);}assert.equal(next.origin,issuer);target=next.href;continue;}
   assert.equal(r.status,200);const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(r.text)?.[1];assert(csrf);
   const form=r.text.includes('name="login"')?{csrf,login:account.email,password:account.password}:{csrf};
   const p=await request(target,{method:'POST',form,jar});form.password='';assert(p.status>=300&&p.status<400,'CRM_OAUTH_LOGIN_REFUSED');target=new URL(p.headers.location,target).href;
  }
  throw Error('OAUTH_LIMIT');
 }
 try{
  server=built.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));port=server.address().port;
  row.phase='oauth-crm-login';const tokens=await authorize();
  const rpc=async(name,args)=>{row.phase=name;const r=await request('/mcp',{method:'POST',bearer:tokens.access_token,jsonBody:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});assert.equal(r.status,200);const envelope=JSON.parse(/^data: (.*)$/m.exec(r.text)?.[1]??r.text);assert(!envelope.error&&!envelope.result?.isError,'MCP_TOOL_REFUSED');const data=envelope.result.structuredContent??JSON.parse(envelope.result.content[0].text);assert(!data.error&&!data.refused,'CRM_TOOL_REFUSED');return data;};
  const status=await rpc('crm_status',{});assert.equal(status.user.email,account.email);assert(status.user.brands.includes(brand));assert(status.user.permissions.growth.edit);row.crmUserId=status.user.id;
  const credential=store.credentials(user.id).crm;
  const who=await fetch('https://crm.shrigma.com.br/auth/session',{headers:{Cookie:credential.cookie},redirect:'error',signal:AbortSignal.timeout(20000)});assert.equal(who.status,200);const ordinary=await who.json();assert.equal(ordinary.user.id,status.user.id);assert.equal(ordinary.user.role,'manager');row.ordinaryEditor=true;
  const catalog=await rpc('crm_campaign_catalog',{brand});assert(catalog.lists.some(l=>l.id===(brand==='aristo'?16:17)&&l.available));
  const audiences=await rpc('crm_audience_list',{brand,limit:1,offset:0});assert.equal(audiences.catalog.brand,brand);assert(Array.isArray(audiences.segments)&&audiences.segments.every(s=>s.brand===brand));row.audienceRead=true;
  const html='<p>Olá {{ .Subscriber.FirstName }} {{ .Subscriber.LastName }}.</p><a href="{{ .UnsubscribeURL }}">Sair</a>',key=crypto.randomUUID(),alias='qa-chat20-'+brand;
  row.modelKey=key;const saved=await rpc('crm_model_save',{brand,name:'[QA CHAT] '+brand+' '+report.atUtc,subject:'Olá {{ .Subscriber.FirstName }}',html,idempotency_key:key});assert.equal(saved.operation.state,'completed');row.modelId=saved.operation.response.body.draft_id;
  const model=await rpc('crm_model_get',{brand,id:row.modelId});assert.equal(model.drafts[0].rascunho.corpo,html);
  const receipt=await rpc('crm_model_operation',{brand,idempotency_key:key});assert.equal(receipt.operation.response.body.draft_id,row.modelId);row.modelReopened=true;
  const domain=brand==='aristo'?'oaristocrata.com':'fishermans.com.br',name='[QA CHAT] '+brand+' '+report.atUtc;
  row.campaignName=name;
  const definition={schema_version:'crm-campaign-v1',brand,channel:'email',name,subject:'Olá {{ .Subscriber.FirstName }}',from_email:'Avisos <avisos@'+domain+'>',reply_to:'contato@'+domain,list_ids:[brand==='aristo'?16:17],template_id:null,html,text:'Olá.\n\nDescadastro: {{ .UnsubscribeURL }}',tags:['qa-chat20'],initiative:{key:alias,name},utm_campaign:alias,send_at:null};
  const created=await rpc('crm_campaign_create',{brand,definition});row.campaignId=created.campaign.id;
  const reopened=await rpc('crm_campaign_get',{brand,id:row.campaignId}),c=reopened.campaign;
  assert.equal(c.id,row.campaignId);assert.equal(c.status,'draft');assert.equal(c.send_at,null);assert.equal(c.sent,0);assert(c.definition.html.includes('{{ .Subscriber.FirstName }}'));assert.deepEqual(c.definition.list_ids,definition.list_ids);row.final={status:c.status,send_at:c.send_at,sent:c.sent};row.campaignReopened=true;
  for(const table of ['campaigns','operations','locks','test_claims','phases'])assert.equal(store.db.prepare('SELECT count(*) n FROM '+table).get().n,0);row.noLocalCampaignLedger=true;row.phase='complete';row.ok=true;
 }finally{
  const session=store.credentials(user.id).crm;
  if(session?.cookie){try{const r=await fetch('https://crm.shrigma.com.br/auth/logout',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Origin:'https://crm.shrigma.com.br',Cookie:session.cookie,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:'{}'});row.qaCrmSessionLoggedOut=r.status===204||r.status===200;}catch{row.qaCrmSessionLoggedOut=false;}}
  if(server)await new Promise(resolve=>server.close(resolve));await built.close();store.close();fs.rmSync(dir,{recursive:true,force:true});
 }
}
try{for(const brand of ['aristo','fish'])await prove(brand);report.ok=true;}
catch(error){report.error={name:error.name,code:/^[A-Z_0-9]{1,80}$/.test(error.code||'')?error.code:'QA_CHAT_UNCONFIRMED',location:error.stack?.match(/crm-chat-qa\.mjs:\d+:\d+/)?.[0]??null};process.exitCode=1;}
finally{bundle.accounts.length=0;fs.writeFileSync(proofFile,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(report));}
