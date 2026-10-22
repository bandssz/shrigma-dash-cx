'use strict';
// Genuine auth/SQLite/gateway/MCP. Providers and contacts are synthetic only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs'),{createServer}=require(runtime+'/server.cjs'),{FIXED_DESTINATIONS}=require(runtime+'/proxy.cjs');
const host='owner.synthetic.invalid',hosts={growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'affiliate.synthetic.invalid'},email='owner@synthetic.invalid',key='synthetic-source-read-key',period={ini:'2026-10-01',fim:'2026-10-12'};
async function fixture(t,{enabled=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'affiliate-native-source-')),bootstrap=crypto.randomBytes(32).toString('base64url'),password='Synthetic-password-2026!';let server;
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),allowedEmailDomains:['synthetic.invalid'],areaHosts:hosts,managerHost:host,bootstrapAdminEmail:email,bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32).toString('hex'),dashboardAffiliateRead:enabled,crmNativeEnabled:true});
 t.after(async()=>{if(server?.listening)await new Promise(r=>server.close(r));auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 await auth.completeBootstrap({email,token:bootstrap,password,host,origin:'https://'+host});const owner=await auth.login({email,password,host,origin:'https://'+host});
 const context={method:'POST',host,origin:'https://'+host,cookieHeader:owner.cookie.split(';')[0],csrf:owner.csrf};
 const issued=auth.nativeConnections.issue({context,label:'Synthetic integrator',brands:['fish','aristo'],scopes:['crm.read'],expiresDays:1});
 const f={auth,context,owner,issued,identityReads:0,dataReads:0,events:[],onIdentity:null,onData:null,identityOwner:email};
 const fetchImpl=async(url,options)=>{
  f.events.push({url:String(url),method:options.method});assert.equal(options.headers.Cookie,undefined);
  if(String(url).includes('access=1')){f.identityReads++;if(f.onIdentity)await f.onIdentity();return new Response(JSON.stringify({schema:'shrigma_access_identity_v1',owner:f.identityOwner,role:'manager',panel:'influs',allowedPanels:['influs'],permissions:{growth:null,influs:{caps:['read_creators']}}}),{headers:{'content-type':'application/json'}});}
  assert.equal(String(url),FIXED_DESTINATIONS.tts);assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),period);assert.equal(options.redirect,'manual');f.dataReads++;if(f.onData)await f.onData();
  return new Response(JSON.stringify({gerado_em:'2026-10-12T03:15:07Z',janela:period,kpis:[{marca:'fish',gmv:'12.00',pedidos:2},{marca:'aristo',gmv:'32.00',pedidos:4}],amostras:[{marca:'fish',total:7},{marca:'aristo',total:23}],fila:[{marca:'fish',application_id:'synthetic-fish',username:'synthetic-person-fish'},{marca:'aristo',application_id:'synthetic-aristo',username:'synthetic-person-aristo'}],criadores:[],open:[{marca:'fish'},{marca:'aristo'}],target:[{marca:'fish'},{marca:'fish'}],frescor:[{marca:'fish',ultima_ok:'2026-10-12T03:15:07Z',ultima_ok_todas:true},{marca:'aristo',ultima_ok:'2026-10-12T03:15:07Z',ultima_ok_todas:true}]}),{headers:{'content-type':'application/json'}});
 };
 server=createServer({mode:'operational',upstreamProfile:'production',dashboardAffiliateRead:enabled,crmNativeEnabled:true,managerHost:host,areaHosts:hosts,allowedEmailDomains:['synthetic.invalid'],upstreams:enabled?{tts:new URL(FIXED_DESTINATIONS.tts)}:{cx:new URL(FIXED_DESTINATIONS.cx)},allowedUpstreamHosts:[new URL(FIXED_DESTINATIONS.tts).hostname],publicDir:dir},{auth,fetchImpl});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 f.request=(route,{method='GET',body,native=false,csrf=true,origin='https://'+host}={})=>new Promise((resolve,reject)=>{
  const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body)),headers={Host:host,Origin:origin};
  if(native){headers.Authorization='Bearer '+issued.token;headers.Accept='application/json, text/event-stream';}else{headers.Cookie=owner.cookie.split(';')[0];if(csrf)headers['X-CSRF-Token']=owner.csrf;}
  if(bytes){headers['content-type']='application/json';headers['content-length']=bytes.length;}
  const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method,headers},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>{let body;try{body=JSON.parse(text);}catch{body=text;}resolve({status:res.statusCode,body,headers:res.headers});});});req.on('error',reject);req.end(bytes);
 });
 f.settings=(body,options={})=>f.request('/auth/affiliate-source-settings',{method:'POST',body,...options});
 f.bind=(bearer=key)=>f.settings({action:'bind',userId:owner.user.id,bearer});
 f.status=()=>f.settings({action:'status'});
 f.authorize=async brand=>{const s=await f.status(),r=s.body.connections[0].receipts.find(r=>r.brand===brand);return f.settings({action:'authorize',connectionId:issued.connection.id,brand,optIn:true,expectedReceiptHash:r.receiptHash});};
 f.call=async(name,args={})=>{const r=await f.request('/api/native/mcp',{method:'POST',native:true,body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result.structuredContent;};
 return f;
}
test('private binding attests the exact original holder and never returns the key',async t=>{const f=await fixture(t);const r=await f.bind();assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.readLinked,true);assert.equal(f.identityReads,1);assert.equal(f.dataReads,0);assert.doesNotMatch(JSON.stringify(r.body),new RegExp(key));const s=await f.status();assert.equal(s.body.users[0].linked,true);assert.doesNotMatch(JSON.stringify(s.body),new RegExp(key));});
test('CRM identity alone cannot query; explicit browser consent unlocks only the chosen brand',async t=>{
 const f=await fixture(t);await f.bind();const before=JSON.stringify(f.auth.nativeConnections.list(f.context));
 let r=await f.call('affiliate_read',{brand:'fish',...period});assert.equal(r.status,403);assert.equal(f.dataReads,0);
 const c=await f.authorize('fish');assert.equal(c.status,200,JSON.stringify(c.body));assert.equal(JSON.stringify(f.auth.nativeConnections.list(f.context)),before);
 r=await f.call('affiliate_read',{brand:'fish',...period});assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.brand,'fish');assert.equal(r.body.kpis[0].marca,'fish');assert.equal(r.body.filaCount,1);assert.equal(r.body.openCount,1);assert.equal(r.body.targetCount,2);assert.equal(r.body.fila,undefined);assert.doesNotMatch(JSON.stringify(r),/synthetic-person|synthetic-source-read-key/);
 r=await f.call('affiliate_read',{brand:'aristo',...period});assert.equal(r.status,403);assert.equal(f.dataReads,1);
 const status=await f.call('crm_status');assert.equal(status.body.affiliateAvailability.find(r=>r.body.brand==='fish').body.consentCurrent,true);assert.equal(status.body.affiliateAvailability.find(r=>r.body.brand==='aristo').body.consentCurrent,false);assert.equal(f.dataReads,1,'status never reads business data');
});
test('rotation closes READ until a new browser receipt; stale CAS cannot renew',async t=>{
 const f=await fixture(t);await f.bind();const first=await f.authorize('fish');assert.equal(first.status,200);await f.bind('synthetic-rotated-read-key');let r=await f.call('affiliate_read',{brand:'fish',...period});assert.equal(r.status,403);assert.equal(f.dataReads,0);
 r=await f.settings({action:'authorize',connectionId:f.issued.connection.id,brand:'fish',optIn:true,expectedReceiptHash:null});assert.equal(r.status,409);r=await f.authorize('fish');assert.equal(r.status,200);assert.equal(r.body.version,2);
 r=await f.call('affiliate_read',{brand:'fish',...period});assert.equal(r.status,200);assert.equal(f.dataReads,1);
});
test('a wrong holder is refused without storage or source data',async t=>{const f=await fixture(t);f.identityOwner='other@synthetic.invalid';const r=await f.bind();assert.equal(r.status,503);assert.equal(r.body.error,'AFFILIATE_SOURCE_IDENTITY_UNCONFIRMED');const s=await f.status();assert.equal(s.body.users[0].linked,false);assert.equal(f.dataReads,0);});
test('a concurrent slot change during attestation refuses the stale bind',async t=>{const f=await fixture(t);f.onIdentity=()=>f.auth.setUpstreamCredential({context:f.context,userId:f.owner.user.id,slot:'tts-read',bearer:'synthetic-concurrent-key'});const r=await f.bind();assert.equal(r.status,409);assert.equal(r.body.error,'AFFILIATE_SOURCE_TARGET_CHANGED');assert.equal(f.auth.getUpstreamCredential({...f.context,area:'influs',edit:false,slot:'tts-read',brand:'fish'}),'synthetic-concurrent-key');});
test('revocation during the original source read suppresses payload with no retry',async t=>{const f=await fixture(t);await f.bind();await f.authorize('fish');f.onData=()=>f.auth.nativeConnections.revoke({context:f.context,connectionId:f.issued.connection.id});const r=await f.call('affiliate_read',{brand:'fish',...period});assert.equal(r.status,401);assert.equal(r.body?.kpis,undefined);assert.equal(f.dataReads,1);});
test('operator denies missing CSRF, foreign origin and delegated self-consent',async t=>{
 const f=await fixture(t);let r=await f.settings({action:'status'},{csrf:false});assert.equal(r.status,403);r=await f.settings({action:'status'},{origin:'https://foreign.synthetic.invalid'});assert.equal(r.status,403);
 r=await f.settings({action:'bind',userId:f.owner.user.id,bearer:key,brand:'fish'});assert.equal(r.status,400);assert.equal(f.identityReads,0);
 assert.throws(()=>f.auth.affiliateNativeConsent.permitRead({context:{...f.auth.nativeConnections.context(f.issued.token),method:'POST'},connectionId:f.issued.connection.id,brand:'fish',optIn:true,expectedReceiptHash:null}),{code:'AFFILIATE_NATIVE_BROWSER_CONSENT_REQUIRED'});
 r=await f.request('/auth/affiliate-source');assert.equal(r.status,200);assert.match(r.headers['content-security-policy'],/frame-ancestors 'none'/);assert.match(r.body,/type="password"/);assert.doesNotMatch(r.body,new RegExp(key));
});
test('disabled Afiliados leaves old connection scopes and the new purpose closed',async t=>{const f=await fixture(t,{enabled:false});const r=await f.call('affiliate_read',{brand:'fish',...period});assert.equal(r.error,'NATIVE_TOOL_NOT_FOUND');assert.equal(f.auth.affiliateNativeConsent,undefined);assert.equal(f.dataReads,0);assert.deepEqual(f.auth.nativeConnections.list(f.context)[0].scopes,['crm.read']);});
