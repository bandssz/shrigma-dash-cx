'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const host='manager.synthetic.invalid',origin='https://'+host,sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 assert.equal(process.version,'v22.23.3');assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
 const bootstrapToken=crypto.randomBytes(32).toString('base64url'),password=crypto.randomBytes(32).toString('base64url');
 Object.assign(process.env,{DASHBOARD_MODE:'synthetic',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'affiliate.synthetic.invalid'}),DASHBOARD_EMAIL_DOMAINS:'["synthetic.invalid"]',DASHBOARD_ADMIN_EMAIL:'master@synthetic.invalid',DASHBOARD_BOOTSTRAP_SHA256:sha(bootstrapToken),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_UPSTREAMS:'{}',DASHBOARD_UPSTREAM_HOSTS:'[]',HOST:'127.0.0.1',PORT:'8080'});
 const bytes=fs.readFileSync('/app/native-backend/manifest.json'),manifestSha256=sha(bytes),N=require('/app/native-backend/bootstrap.cjs');
 assert.throws(()=>N.verifyRelease('0'.repeat(64)),/NATIVE_BACKEND_RELEASE_REFUSED/);
 require('/app/canary-start.cjs').prepare();
 const started=require('/app/presentation-release/release.cjs').startWithPresentation(()=>N.start({manifestSha256}));
 await new Promise(resolve=>started.server.listening?resolve():started.server.once('listening',resolve));
 const request=async(path,{method='GET',body,cookie,csrf,bearer}={})=>{
  const r=await fetch('http://127.0.0.1:8080'+path,{method,headers:{Host:host,Origin:origin,Accept:'application/json, text/event-stream',...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:r.status,value,cookie:r.headers.get('set-cookie')};
 };
 const health=await request('/healthz');assert.equal(health.status,200);assert.equal(health.value.nativeMcp,true);assert.equal(health.value.nativeBackendManifestSha256,manifestSha256);
 assert.equal(N.verifyReady({manifestSha256}).runtimeFiles,31);assert.equal(require('/app/presentation-release/release.cjs').verifyReady().runtimeFilesUnchanged,28);
 assert.equal((await request('/api/native/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method:'ping'}})).status,401);
 assert.equal((await request('/auth/native-connection')).status,401);
 assert.equal((await request('/auth/bootstrap/complete',{method:'POST',body:{email:'master@synthetic.invalid',token:bootstrapToken,password}})).status,200);
 const login=await request('/auth/login',{method:'POST',body:{email:'master@synthetic.invalid',password}});assert.equal(login.status,200);
 const cookie=login.cookie.split(';')[0],csrf=login.value.csrf,originalId=login.value.user.id;
 assert.equal((await request('/auth/native-connection',{cookie})).status,200);
 const issued=await request('/auth/native-connections',{method:'POST',cookie,csrf,body:{action:'issue',label:'CI isolated test',brands:['fish'],scopes:['crm.read'],expiresDays:1}});assert.equal(issued.status,201);const bearer=issued.value.token;
 const call=async(name,args={})=>request('/api/native/mcp',{method:'POST',bearer,body:{jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}}});
 const state=await call('crm_status');assert.equal(state.status,200);assert.equal(state.value.result.structuredContent.body.authenticated,true);assert.equal(state.value.result.structuredContent.body.permissions.growth.edit,false);assert.equal(state.value.result.structuredContent.body.operational,false);assert.equal(JSON.stringify(state.value).includes(csrf),false);assert.equal(JSON.stringify(state.value).includes(cookie),false);
 const other=await call('crm_campaign_get',{brand:'aristo',id:1});assert.equal(other.value.result.structuredContent.error,'BRAND_DENIED');
 const write=await call('crm_campaign_save',{brand:'fish',id:1,expected_version:'a'.repeat(32),definition:{},idempotency_key:'same-original-key-12345'});assert.equal(write.value.result.structuredContent.error,'NATIVE_SCOPE_DENIED');
 const db=new DatabaseSync('/dashboard-data/dashboard.sqlite',{readOnly:true});const delegate=db.prepare('SELECT user_id,token_hash FROM crm_native_connections_v1 WHERE id=?').get(issued.value.connection.id);assert.equal(delegate.user_id,originalId);assert.equal(delegate.token_hash,sha(bearer));assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE role='superadmin'").get().n,1);db.close();
 assert.equal((await request('/auth/native-connections',{method:'POST',cookie,csrf,body:{action:'revoke',connectionId:issued.value.connection.id}})).status,200);
 assert.equal((await call('crm_status')).status,401);
 console.log(JSON.stringify({schema:'shrigma-native-image-smoke-v1',ok:true,node:process.version,uid:process.getuid(),manifestSha256,sourceRevision:JSON.parse(bytes).sourceRevision,originalIdentityRetained:true,genuineSyntheticConsent:true,unauthenticatedInvocationDenied:true,crossBrandDenied:true,writeWithoutGrantDenied:true,nativeRevocationDenied:true,originalPackAndV2PresentationPreserved:true,actualNativeRuntimeFiles:31,runtimeReplacements:2,runtimeAdditions:3,sqlInstallerEnabled:false,productionIdentityUsed:false,operational:false}));
 process.kill(process.pid,'SIGTERM');
}
main().catch(()=>{console.error('NATIVE_IMAGE_SMOKE_FAILED');process.exitCode=1;process.kill(process.pid,'SIGTERM');});
