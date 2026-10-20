// Independent synthetic OAuth experiment. Only loopback HTTP; no Listmonk or real keys.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {buildApp} from '../src/server.mjs';
import {Store} from '../src/store.mjs';
import {createIdentityProvider,mountInteractions,hashPassword,SCOPE,CLAUDE_CALLBACK} from '../src/auth.mjs';

const issuer='https://mcp-auth.synthetic.invalid',clientId='claude-fixed-synthetic';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-independent-oauth-'));
fs.chmodSync(tmp,0o700);
const checks=[],cookieShapes=new Map(),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...privateKey.export({format:'jwk'}),kid:'synthetic-key',use:'sig',alg:'RS256'};
let store,server;
class Jar{
 constructor(){this.items=new Map();}
 save(headers){for(const row of headers??[]){const [first,...attrs]=row.split(';'),i=first.indexOf('='),name=first.slice(0,i),value=first.slice(i+1);const d={name,value,path:'/',secure:false,httpOnly:false,sameSite:null};let drop=false;for(const a0 of attrs){const a=a0.trim(),j=a.indexOf('='),k=(j<0?a:a.slice(0,j)).toLowerCase(),v=j<0?'':a.slice(j+1);if(k==='path')d.path=v;if(k==='secure')d.secure=true;if(k==='httponly')d.httpOnly=true;if(k==='samesite')d.sameSite=v.toLowerCase();if(k==='max-age'&&Number(v)<=0)drop=true;if(k==='expires'&&Date.parse(v)<=Date.now())drop=true;}const key=name+'|'+d.path;if(drop)this.items.delete(key);else this.items.set(key,d);cookieShapes.set(name+'|'+d.path.replace(/\/[A-Za-z0-9_-]{24,}/g,'/<interaction>'),{name,path:d.path.replace(/\/[A-Za-z0-9_-]{24,}/g,'/<interaction>'),secure:d.secure,httpOnly:d.httpOnly,sameSite:d.sameSite});}}
 header(urlpath){const p=new URL(urlpath,issuer).pathname;return[...this.items.values()].filter(c=>p===c.path||p.startsWith(c.path.endsWith('/')?c.path:c.path+'/')).sort((a,b)=>b.path.length-a.path.length).map(c=>c.name+'='+c.value).join('; ');}
}
let port;
async function request(target,{method='GET',form=null,jar=null,origin=null,jsonBody=null,bearer=null}={}){
 const u=new URL(target,issuer);assert.equal(u.origin,issuer,'NETWORK_TARGET_MUST_BE_SYNTHETIC_ISSUER');
 const body=jsonBody!==null?JSON.stringify(jsonBody):form===null?null:new URLSearchParams(form).toString();
 const headers={Host:u.host,'X-Forwarded-Proto':'https'};if(jar?.header(u.pathname))headers.Cookie=jar.header(u.pathname);if(origin!==null)headers.Origin=origin;if(body!==null){headers['Content-Type']=jsonBody!==null?'application/json':'application/x-www-form-urlencoded';headers['Content-Length']=Buffer.byteLength(body);}
 if(bearer){headers.Authorization='Bearer '+bearer;}headers.Accept='application/json, text/event-stream';return await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:u.pathname+u.search,method,headers,timeout:5000},res=>{const parts=[];let n=0;res.on('data',b=>{n+=b.length;if(n>131072){req.destroy();return reject(Error('LOCAL_RESPONSE_LIMIT'));}parts.push(b);});res.on('end',()=>{jar?.save(res.headers['set-cookie']);resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(parts).toString('utf8')});});});req.on('error',()=>reject(Error('LOCAL_HTTP_FAILED')));req.on('timeout',()=>req.destroy());if(body!==null)req.write(body);req.end();});
}
const json=r=>JSON.parse(r.text);
const oauthRefused=r=>r.status>=400||(r.status>=300&&r.status<400&&new URL(r.headers.location,issuer).origin+new URL(r.headers.location,issuer).pathname===CLAUDE_CALLBACK&&new URL(r.headers.location,issuer).searchParams.has('error'));
function authUrl(verifier,changes={}){const q=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:CLAUDE_CALLBACK,scope:'openid offline_access '+SCOPE,resource:issuer+'/mcp',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state:'synthetic-state',...changes});for(const[k,v]of Object.entries(changes))if(v===null)q.delete(k);return issuer+'/auth?'+q;}
async function loginCode({negativeForms=false}={}){
 const verifier=crypto.randomBytes(32).toString('base64url'),jar=new Jar();let target=authUrl(verifier),r;let loginSeen=0,consentSeen=0;
 for(let step=0;step<14;step++){
  r=await request(target,{jar});
  if(r.status>=300&&r.status<400){const next=new URL(r.headers.location,target);if(next.origin===new URL(CLAUDE_CALLBACK).origin){check('hosted-callback-exact-and-state',next.origin+next.pathname===CLAUDE_CALLBACK&&next.searchParams.get('state')==='synthetic-state'&&!next.searchParams.has('error'));const code=next.searchParams.get('code');assert.ok(code,'CALLBACK_CODE_REQUIRED');check('single-login-single-consent-no-loop',loginSeen===1&&consentSeen===1);return{code,verifier,jar};}assert.equal(next.origin,issuer,'NO_EXTERNAL_REDIRECT_FOLLOWED');target=next.href;continue;}
  assert.equal(r.status,200,'INTERACTION_PAGE_200');const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(r.text)?.[1];assert.ok(csrf,'CSRF_FORM_REQUIRED');
  const isLogin=r.text.includes('name="login"');if(isLogin)loginSeen++;else consentSeen++;
  check(isLogin?'login-page-security-headers':'consent-page-security-headers',r.headers['cache-control']==='no-store'&&r.headers['content-security-policy'].includes("frame-ancestors 'none'"));
  check(isLogin?'login-form-keeps-same-origin-referrer-policy':'consent-form-keeps-same-origin-referrer-policy',r.headers['referrer-policy']==='same-origin');
  check(isLogin?'login-form-allows-only-fixed-claude-callback':'consent-form-allows-only-fixed-claude-callback',r.headers['content-security-policy']==="default-src 'none'; form-action 'self' "+CLAUDE_CALLBACK+"; frame-ancestors 'none'; base-uri 'none'");
  const form=isLogin?{csrf,login:'alice@synthetic.invalid',password:'synthetic-test-password-only'}:{csrf};
  if(negativeForms){
   const opaque=await request(target,{method:'POST',form,jar,origin:'null'});check(isLogin?'login-literal-null-origin-refused':'consent-literal-null-origin-refused',opaque.status===403&&json(opaque).error?.message==='Invalid Origin header: null');
   if(!isLogin){const foreign=await request(target,{method:'POST',form,jar,origin:'https://attacker.synthetic.invalid'});check('consent-foreign-origin-refused',foreign.status===403);}
  }
  if(negativeForms&&isLogin){
   const noCookie=await request(target);check('interaction-cookie-required',noCookie.status>=400);
   const cross=await request(target,{method:'POST',form,jar,origin:'https://attacker.synthetic.invalid'});check('cross-origin-post-refused',cross.status>=400);
   const bad=await request(target,{method:'POST',form:{...form,csrf:'wrong'},jar,origin:issuer});check('wrong-csrf-refused',bad.status>=400);
  }
  const savedTarget=target,posted=await request(target,{method:'POST',form,jar,origin:issuer});assert.ok(posted.status>=300&&posted.status<400,'FORM_POST_RESUMES');
  if(negativeForms&&isLogin){const replay=await request(savedTarget,{method:'POST',form,jar,origin:issuer});check('form-csrf-single-use',replay.status>=400);}
  target=new URL(posted.headers.location,target).href;
 }
 throw Error('AUTH_REDIRECT_LIMIT');
}
async function exchange(flow,changes={}){return request('/token',{method:'POST',form:{grant_type:'authorization_code',client_id:clientId,code:flow.code,code_verifier:flow.verifier,redirect_uri:CLAUDE_CALLBACK,resource:issuer+'/mcp',...changes}});}
try{
 check('node24-runtime',process.version.startsWith('v24.'));
 const oidc=JSON.parse(fs.readFileSync(new URL('../node_modules/oidc-provider/package.json',import.meta.url),'utf8'));check('oidc-provider-exact-9.12.2',oidc.version==='9.12.2');
 store=new Store(path.join(tmp,'auth.db'),crypto.randomBytes(32),{initialize:true,environment:'test'});
 const user=store.addUser({id:'synthetic-alice',login:'alice@synthetic.invalid',brand:'fish',passwordHash:await hashPassword('synthetic-test-password-only'),credential:{username:'synthetic-api',token:'not-a-production-token'},apiUserId:50001,listIds:[50002],templateIds:[50003],fromEmails:[],replyToEmails:[],testRecipients:{}});
 const identity=buildApp({store,config:{origin:issuer,clientId,environment:'test',upstream:'http://127.0.0.1:9'},secret:{adminSha:sha('fictitious-owner-token'),jwks:{keys:[jwk]},cookieKeys:[crypto.randomBytes(32).toString('hex')]},clientFor:()=>({verify:async()=>true,get:async()=>({id:50002,name:'Lista fictícia',subscriber_count:7,status:'active'})})});
 const {provider,verifyAccessToken,app}=identity;
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));port=server.address().port;
 const discovery=json(await request('/.well-known/openid-configuration'));check('discovery-issuer-endpoints-s256-fixed-client',discovery.issuer===issuer&&discovery.authorization_endpoint===issuer+'/auth'&&discovery.token_endpoint===issuer+'/token'&&discovery.code_challenge_methods_supported.join('|')==='S256'&&discovery.registration_endpoint===undefined&&discovery.introspection_endpoint===undefined&&discovery.revocation_endpoint===issuer+'/token/revocation');
 const missing=await request(authUrl('a'.repeat(43),{code_challenge:null,code_challenge_method:null}));check('pkce-required',oauthRefused(missing));
 const target=await request(authUrl('b'.repeat(43),{resource:'https://other.synthetic.invalid/mcp'}));check('wrong-resource-refused-before-login',oauthRefused(target));
 const client=await request(authUrl('c'.repeat(43),{client_id:'unregistered-client'}));check('unregistered-client-refused',client.status>=400);
 const redirect=await request(authUrl('d'.repeat(43),{redirect_uri:'https://attacker.synthetic.invalid/callback'}));check('wrong-callback-refused',redirect.status>=400);
 const flow=await loginCode({negativeForms:true});
 const accepted=await exchange(flow);assert.equal(accepted.status,200,'CODE_EXCHANGE_STATUS');const tokens=json(accepted);if(!(typeof tokens.access_token==='string'&&!tokens.access_token.includes('.')&&typeof tokens.refresh_token==='string'&&tokens.token_type==='Bearer'&&tokens.expires_in===900))console.log(JSON.stringify({diagnostic:'synthetic-token-response-shape-only',keys:Object.keys(tokens),tokenType:tokens.token_type,expiresIn:tokens.expires_in,hasOpaque:typeof tokens.access_token==='string'&&!tokens.access_token.includes('.'),hasRefresh:typeof tokens.refresh_token==='string'}));check('code-exchange-opaque-access-plus-refresh',typeof tokens.access_token==='string'&&!tokens.access_token.includes('.')&&typeof tokens.refresh_token==='string'&&tokens.token_type==='Bearer'&&tokens.expires_in===900);
 const caller=await verifyAccessToken(tokens.access_token);check('local-verifier-audience-client-user',caller.extra.actor===user.id&&caller.clientId===clientId&&caller.resource.href===issuer+'/mcp'&&caller.scopes.includes(SCOPE));
 const unauth=await request('/mcp',{method:'POST',jsonBody:{jsonrpc:'2.0',id:1,method:'tools/list',params:{}}});check('mcp-bearer-required-with-resource-metadata',unauth.status===401&&unauth.headers['www-authenticate'].includes('/.well-known/oauth-protected-resource/mcp'));
 const meta=json(await request('/.well-known/oauth-protected-resource/mcp'));check('resource-metadata-exact-audience',meta.resource===issuer+'/mcp'&&meta.authorization_servers.join('|')===issuer);
 const rpc=async(method,params={},id=1)=>request('/mcp',{method:'POST',bearer:tokens.access_token,jsonBody:{jsonrpc:'2.0',id,method,params}});
 const evil=await request('/mcp',{method:'POST',origin:'https://attacker.synthetic.invalid',bearer:tokens.access_token,jsonBody:{jsonrpc:'2.0',id:1,method:'tools/list',params:{}}});check('mcp-invalid-origin-refused',evil.status===403);
 const opaque=await request('/mcp',{method:'POST',origin:'null',bearer:tokens.access_token,jsonBody:{jsonrpc:'2.0',id:1,method:'tools/list',params:{}}});check('mcp-literal-null-origin-remains-refused',opaque.status===403&&json(opaque).error?.message==='Invalid Origin header: null');
 const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-client',version:'0.1'}});check('mcp-legacy-streamable-initialize',initialized.status===200&&initialized.text.includes('shrigma-listmonk'));
 const toolResponse=await rpc('tools/list');const parsedTool=JSON.parse(/^data: (.*)$/m.exec(toolResponse.text)?.[1]??toolResponse.text);check('mcp-exact-ten-closed-tools',toolResponse.status===200&&parsedTool.result.tools.length===10&&parsedTool.result.tools.every(t=>t.name.startsWith('listmonk_')));
 const called=await rpc('tools/call',{name:'listmonk_lists_get',arguments:{brand:'fish'}});check('mcp-authInfo-to-individual-service',called.status===200&&called.text.includes('Lista fictícia'));
 const cross=await rpc('tools/call',{name:'listmonk_lists_get',arguments:{brand:'aristo'}});check('mcp-brand-refusal-not-upstream',cross.status===200&&cross.text.includes('BRAND_FORBIDDEN'));
 const unknown=await rpc('tools/call',{name:'listmonk_subscriber_delete',arguments:{id:1}});check('mcp-unknown-tool-refused',unknown.text.includes('error')||unknown.text.includes('isError'));
 const refreshed=await request('/token',{method:'POST',form:{grant_type:'refresh_token',client_id:clientId,refresh_token:tokens.refresh_token,resource:issuer+'/mcp'}});assert.equal(refreshed.status,200,'REFRESH_STATUS');const next=json(refreshed);check('refresh-rotated',typeof next.refresh_token==='string'&&next.refresh_token!==tokens.refresh_token&&typeof next.access_token==='string');await verifyAccessToken(next.access_token);
 const old=await request('/token',{method:'POST',form:{grant_type:'refresh_token',client_id:clientId,refresh_token:tokens.refresh_token,resource:issuer+'/mcp'}});check('old-refresh-reuse-invalid-grant',old.status===400&&json(old).error==='invalid_grant');
 let refused=false;try{await verifyAccessToken(next.access_token);}catch{refused=true;}check('refresh-reuse-invalidates-new-access-family',refused);
 const flow2=await loginCode();const t2=json(await exchange(flow2));await verifyAccessToken(t2.access_token);
 const token=await provider.AccessToken.find(t2.access_token),row=store.db.prepare("SELECT payload FROM oauth WHERE model='AccessToken' AND id=?").get(token.jti),payload=JSON.parse(row.payload);
 store.db.prepare("UPDATE oauth SET payload=? WHERE model='AccessToken' AND id=?").run(JSON.stringify({...payload,aud:'https://other.synthetic.invalid/mcp'}),token.jti);refused=false;try{await verifyAccessToken(t2.access_token);}catch{refused=true;}check('wrong-token-audience-refused',refused);
 store.db.prepare("UPDATE oauth SET payload=? WHERE model='AccessToken' AND id=?").run(JSON.stringify({...payload,clientId:'other-client'}),token.jti);refused=false;try{await verifyAccessToken(t2.access_token);}catch{refused=true;}check('wrong-token-client-refused',refused);
 store.db.prepare("UPDATE oauth SET payload=? WHERE model='AccessToken' AND id=?").run(JSON.stringify(payload),token.jti);await verifyAccessToken(t2.access_token);
 store.revoke(user.id);refused=false;try{await verifyAccessToken(t2.access_token);}catch{refused=true;}check('disabled-user-access-refused-immediately',refused);
 const disabled=await request('/token',{method:'POST',form:{grant_type:'refresh_token',client_id:clientId,refresh_token:t2.refresh_token,resource:issuer+'/mcp'}});check('disabled-user-refresh-invalid-grant',disabled.status===400&&json(disabled).error==='invalid_grant');
 check('auth-cookies-signed-secure-httponly',cookieShapes.has('_interaction|/interaction/<interaction>')&&[...cookieShapes.values()].filter(c=>!c.name.endsWith('.sig')).every(c=>c.secure&&c.httpOnly));
 console.log(JSON.stringify({schema:'local-independent-oauth-e2e-v1',node:process.version,oidcProvider:oidc.version,passed:checks.length,checks,cookies:[...cookieShapes.values()],externalHTTPCalls:0,listmonkCalls:0,productionCalls:0,credentialsSyntheticOnly:true,sourceFilesChanged:0}));
}catch(error){console.log(JSON.stringify({schema:'local-independent-oauth-e2e-v1',status:'failed',passed:checks.length,checks,errorClass:error?.name??'Error',assertion:typeof error.message==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(error.message)?error.message:'LOCAL_FLOW_ASSERTION_OR_EXCEPTION',externalHTTPCalls:0,productionCalls:0}));process.exitCode=1;}
finally{if(server)await new Promise(resolve=>server.close(resolve));store?.close();fs.rmSync(tmp,{recursive:true,force:true});}
