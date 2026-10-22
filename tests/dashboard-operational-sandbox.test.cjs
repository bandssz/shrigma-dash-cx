'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createAuth}=require('../services/dashboard-operational/auth.cjs');
const {createServer,settingsFromEnv}=require('../services/dashboard-operational/server.cjs');
const {validateUpstreams,rewriteCapabilities,SANDBOX_HOST,SANDBOX_DESTINATIONS,FIXED_DESTINATIONS}=require('../services/dashboard-operational/proxy.cjs');
const {verifySandboxCredential}=require('../services/dashboard-operational/backend-credential-attestation.cjs');
const Contract=require('../services/dashboard-operational/segment-audience-contract.js');
const hosts={manager:'manager.sandbox.test',growth:'crm.sandbox.test',organico:'organico.sandbox.test',influs:'influs.sandbox.test'};
const owner='editor@synthetic.invalid',bearer='runtime-synthetic-test-bearer',bootstrap='private-synthetic-bootstrap';
const identity=()=>({schema:'crm-audience-sandbox-identity-v1',role:'manager',panel:'growth',owner,allowedPanels:['growth'],capabilities:['draft','read_content'],synthetic:true});
const response=body=>Response.json(body);

test('closed sandbox profile rejects production, arbitrary hosts, additional routes and real identity domains',()=>{
 const upstreams=validateUpstreams(SANDBOX_DESTINATIONS,[SANDBOX_HOST],null,'crm-sandbox');
 assert.equal(upstreams.segments.href,SANDBOX_DESTINATIONS.segments);
 assert.throws(()=>validateUpstreams(SANDBOX_DESTINATIONS,[SANDBOX_HOST]));
 for(const config of [{...SANDBOX_DESTINATIONS,cx:FIXED_DESTINATIONS.cx},{...SANDBOX_DESTINATIONS,campaigns:SANDBOX_DESTINATIONS.segments},{segments:SANDBOX_DESTINATIONS.segments},{...SANDBOX_DESTINATIONS,segments:'https://'+SANDBOX_HOST+'/segments/'}])assert.throws(()=>validateUpstreams(config,[SANDBOX_HOST],null,'crm-sandbox'));
 for(const allowed of [[SANDBOX_HOST,'production.test'],['another.test'],[]])assert.throws(()=>validateUpstreams(SANDBOX_DESTINATIONS,allowed,null,'crm-sandbox'));
 assert.throws(()=>validateUpstreams(SANDBOX_DESTINATIONS,[SANDBOX_HOST],{},'crm-sandbox'));
 const env={DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'crm-sandbox',DASHBOARD_MANAGER_HOST:hosts.manager,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:hosts.growth,organico:hosts.organico,influs:hosts.influs}),DASHBOARD_EMAIL_DOMAINS:'["synthetic.invalid"]',DASHBOARD_ADMIN_EMAIL:'admin@synthetic.invalid',DASHBOARD_UPSTREAMS:JSON.stringify(SANDBOX_DESTINATIONS),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify([SANDBOX_HOST]),DASHBOARD_CRM_AUDIENCE_DRAFT:'enabled'};
 assert.equal(settingsFromEnv(env).upstreamProfile,'crm-sandbox');
 for(const override of [{DASHBOARD_MODE:'synthetic'},{DASHBOARD_CRM_DRAFT_WRITE:'enabled'},{DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com"]'},{DASHBOARD_ADMIN_EMAIL:'admin@oaristocrata.com'},{DASHBOARD_UPSTREAM_PROFILE:'custom'}])assert.throws(()=>settingsFromEnv({...env,...override}));
});

test('sandbox credential is owner-bound and bounded at its fixed direct identity endpoint',async()=>{
 const input={slot:'growth-audience',expectedOwner:owner,bearer};let calls=0;
 const fetchImpl=async(url,options)=>{
  calls++;assert.equal(String(url),'https://'+SANDBOX_HOST+'/identity');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer '+bearer);assert.equal(options.headers.Origin,undefined);assert.equal(options.headers.Cookie,undefined);return response(identity());
 };
 assert.deepEqual(await verifySandboxCredential(input,{fetchImpl}),{ok:true,synthetic:true,ownerVerified:true});assert.equal(calls,1);
 for(const slot of ['growth-read','growth-audience-read']){
  await assert.rejects(verifySandboxCredential({...input,slot},{fetchImpl:async()=>response(identity())}));
  assert.equal((await verifySandboxCredential({...input,slot,bearer:'read-synthetic-test-bearer'},{fetchImpl:async()=>response({...identity(),capabilities:['read_content']})})).ok,true);
 }
 await assert.rejects(verifySandboxCredential(input,{fetchImpl:async()=>response({...identity(),capabilities:['read_content']})}));
 for(const bad of [{...identity(),owner:'other@synthetic.invalid'},{...identity(),synthetic:false},{...identity(),role:'master'},{...identity(),allowedPanels:['growth','influs']},{...identity(),capabilities:['draft','send']},{...identity(),extra:true}])await assert.rejects(verifySandboxCredential(input,{fetchImpl:async()=>response(bad)}));
 for(const result of [new Response(null,{status:302,headers:{location:'https://production.test'}}),new Response('x'.repeat(8193),{headers:{'Content-Type':'application/json'}}),new Response('{}',{headers:{'Content-Type':'text/html'}})])await assert.rejects(verifySandboxCredential(input,{fetchImpl:async()=>result}));
 await assert.rejects(verifySandboxCredential({...input,expectedOwner:'editor@oaristocrata.com'},{fetchImpl:async()=>{assert.fail('real identity must fail before network');}}));
});

test('capabilities permit only audience CRUD in the explicit synthetic contract',()=>{
 const upstreams=validateUpstreams(SANDBOX_DESTINATIONS,[SANDBOX_HOST],null,'crm-sandbox'),origin='https://'+hosts.growth;
 const payload={synthetic:true,capabilities:{endpoints:{segments:SANDBOX_DESTINATIONS.segments},segments:{contract_version:Contract.VERSION,brands:['fish','aristo'],read:true,save:true,operation:true,count:true,send:true},campaigns:{save:true,schedule:true},write:true}};
 const denied=rewriteCapabilities(payload,upstreams,origin);assert.equal(denied.capabilities.segments.save,false);
 const allowed=rewriteCapabilities(payload,upstreams,origin,{sandboxAudienceDraft:true}).capabilities;
 assert.equal(allowed.segments.save,true);assert.equal(allowed.segments.operation,true);assert.equal(allowed.segments.count,false);assert.equal(allowed.segments.send,false);assert.equal(allowed.campaigns.save,false);assert.equal(allowed.campaigns.schedule,false);assert.equal(allowed.write,false);
 for(const bad of [{...payload,synthetic:false},{...payload,capabilities:{...payload.capabilities,endpoints:{segments:'https://production.test/segments'}}}])assert.equal(rewriteCapabilities(bad,upstreams,origin,{sandboxAudienceDraft:true}).capabilities.segments.save,false);
 const catalogue={catalog:{brand:'fish',current:true},capabilities:{draft:false,count:false,send:false}};
 assert.equal(rewriteCapabilities(catalogue,upstreams,origin,{sandboxAudienceDraft:true,route:'segments'}).capabilities.draft,true);
 for(const options of [{sandboxAudienceDraft:false,route:'segments'},{sandboxAudienceDraft:true,route:'templates'},{}])assert.equal(rewriteCapabilities(catalogue,upstreams,origin,options).capabilities.draft,false);
 assert.equal(rewriteCapabilities({...catalogue,catalog:{brand:'fish',current:false}},upstreams,origin,{sandboxAudienceDraft:true,route:'segments'}).capabilities.draft,false);
});

function request(port,host,route,{method='GET',body,cookie,csrf,extra={}}={}){
 return new Promise((resolve,reject)=>{
  const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
  const req=http.request({host:'127.0.0.1',port,path:route,method,headers:{Host:host,...(method==='POST'?{Origin:'https://'+host}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...extra}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(bytes);
 });
}
test('HTTP session enables audience draft only for its own attested manager and closes on revocation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-sandbox-test-'));
 const config={dbPath:path.join(dir,'identity.sqlite'),managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32)};
 const auth=createAuth(config);let server;
 try{
  await auth.completeBootstrap({email:config.bootstrapAdminEmail,token:bootstrap,password:'synthetic-admin-passphrase',host:hosts.manager,origin:'https://'+hosts.manager});
  const admin=await auth.login({email:config.bootstrapAdminEmail,password:'synthetic-admin-passphrase',host:hosts.manager,origin:'https://'+hosts.manager});
  const context={cookieHeader:admin.cookie.split(';')[0],host:hosts.manager,method:'POST',origin:'https://'+hosts.manager,csrf:admin.csrf};
  const invite=auth.createInvite({context,email:owner,areas:['growth'],brand:'fish',permissions:{growth:{read:true,edit:true}}});
  await auth.acceptInvite({token:invite.token,password:'synthetic-editor-passphrase',host:hosts.growth,origin:'https://'+hosts.growth});
  const editor=await auth.login({email:owner,password:'synthetic-editor-passphrase',host:hosts.growth,origin:'https://'+hosts.growth});
  const cookie=editor.cookie.split(';')[0];
  server=createServer({...config,mode:'operational',upstreamProfile:'crm-sandbox',upstreams:SANDBOX_DESTINATIONS,allowedUpstreamHosts:[SANDBOX_HOST],dynamicRouteManifest:null,crmAudienceDraft:true,crmDraftWrite:false},{auth,fetchImpl:async(url,options)=>response(options.headers.Authorization==='Bearer read-synthetic-test-bearer'?{...identity(),capabilities:['read_content']}:identity())});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  assert.equal((await request(port,hosts.growth,'/auth/session',{cookie})).body.features.audienceDraft,false);
  const credential={action:'credential',userId:invite.userId,slot:'growth-audience',bearer};
  assert.equal((await request(port,hosts.manager,'/auth/users',{method:'POST',body:credential,cookie:context.cookieHeader,csrf:context.csrf})).status,200);
  assert.equal((await request(port,hosts.growth,'/auth/session',{cookie})).body.features.audienceDraft,false);
  for(const slot of ['growth-read','growth-audience-read'])assert.equal((await request(port,hosts.manager,'/auth/users',{method:'POST',body:{...credential,slot,bearer:'read-synthetic-test-bearer'},cookie:context.cookieHeader,csrf:context.csrf})).status,200);
  assert.equal((await request(port,hosts.growth,'/auth/session',{cookie})).body.features.audienceDraft,true);
  const metadata={'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'},receipt='/auth/audience-draft?brand=fish';
  assert.equal((await request(port,hosts.growth,receipt,{cookie,csrf:editor.csrf})).status,403);
  const ready=await request(port,hosts.growth,receipt,{cookie,csrf:editor.csrf,extra:metadata});assert.equal(ready.status,200);assert.equal(ready.body.operation,null);
  for(const invalid of [{csrf:'wrong',extra:metadata},{csrf:undefined,extra:metadata},{csrf:editor.csrf,extra:{...metadata,'Sec-Fetch-Site':'cross-site'}},{csrf:editor.csrf,extra:{...metadata,Origin:'https://foreign.test'}}])assert.equal((await request(port,hosts.growth,receipt,{cookie,...invalid})).status,403);
  assert.equal((await request(port,hosts.manager,'/auth/session',{cookie:context.cookieHeader})).body.features.audienceDraft,false);
  const blocked=await request(port,hosts.manager,'/auth/users',{method:'POST',body:{...credential,slot:'growth-campaign'},cookie:context.cookieHeader,csrf:context.csrf});assert.equal(blocked.status,403);
  // A concurrent administrator revocation during the identity call cannot
  // attach credentials after the principal has ceased to be active.
  await assert.rejects(auth.setSandboxCredential({...credential,context,fetchImpl:async()=>{auth.revokeUser({context,userId:invite.userId});return response(identity());}}));
  assert.equal((await request(port,hosts.growth,'/auth/session',{cookie})).body.authenticated,false);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));auth.close();fs.rmSync(dir,{recursive:true,force:true});}
});
