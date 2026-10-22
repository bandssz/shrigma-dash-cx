'use strict';
// HTTP regression for GET -> list -> nativeConsent -> POST-only adminContext.
// Runtime override keeps the same test runnable against the packaged image.
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const {Readable,Writable}=require('node:stream');
const runtime=process.env.SCHEDULER_STATE_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
const {createAuth}=require(path.join(runtime,'auth.cjs'));
const {createServer,settingsFromEnv,authOptionsFor}=require(path.join(runtime,'server.cjs'));
const P=require(path.join(runtime,'proxy.cjs'));
const host='gerencial.shrigma.com.br',origin='https://'+host,email='felipebandeira@oaristocrata.com';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-state-http-isolated-'));
 const settings=settingsFromEnv({DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:JSON.stringify(['oaristocrata.com','shrigma.com.br','fishermans.com.br']),DASHBOARD_ADMIN_EMAIL:email,DASHBOARD_BOOTSTRAP_SHA256:sha('disposable-http-bootstrap'),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:'own-master-production-v1',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_CRM_MASTER_AUDIENCE_READ:'enabled',DASHBOARD_CRM_PUBLISHED_JOURNEY_READ:'enabled',DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_NATIVE_SCHEDULER_STATE:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({'crm-read':P.FIXED_DESTINATIONS['crm-read'],campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify([...new Set([P.FIXED_DESTINATIONS['crm-read'],P.REVIEWED_DYNAMIC.routes.campaigns,P.REVIEWED_DYNAMIC.routes.segments].map(x=>new URL(x).hostname))]),DASHBOARD_DYNAMIC_ROUTE_MANIFEST:JSON.stringify({schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:P.REVIEWED_DYNAMIC.routes.campaigns,segments:P.REVIEWED_DYNAMIC.routes.segments}}),DASHBOARD_DB_PATH:path.join(dir,'identity.sqlite'),DASHBOARD_PUBLIC_DIR:dir});
 // Same public constructor option used by the original bootstrap; the vault
 // remains empty, and no DB credential or original worker grant is invented.
 const original=createAuth({...authOptionsFor(settings),crmNativeDatabaseEnabled:true});let server;
 t.after(async()=>{if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}original.close();fs.rmSync(dir,{recursive:true,force:true});});
 await original.completeBootstrap({email,token:'disposable-http-bootstrap',password:'Disposable-Http-Test-2026!',host,origin});
 const login=await original.login({email,password:'Disposable-Http-Test-2026!',host,origin}),cookie=login.cookie.split(';')[0],post={host,origin,method:'POST',cookieHeader:cookie,csrf:login.csrf};
 const issued=original.nativeConnections.issue({context:post,brands:['fish','aristo'],scopes:['crm.read'],expiresDays:1});
 const calls={list:[],authorize:[],read:0,upstream:0};
 // The observer delegates to the REAL store and records the actual HTTP
 // method; it neither fabricates POST nor bypasses browser consent/CSRF.
 const auth={...original,nativeConnections:{...original.nativeConnections,list:ctx=>{calls.list.push({method:ctx.method,csrf:ctx.csrf});return original.nativeConnections.list(ctx);}}};
 const schedulerState={enabled:true,authorize:args=>{calls.authorize.push(args);return original.nativeSchedulerStateConsent.authorize(args);},nativeReadReceipt:()=>{calls.read++;assert.fail('Browser routes must never request scheduler SQL');}};
 server=createServer(settings,{auth,schedulerState,fetchImpl:()=>{calls.upstream++;assert.fail('No external HTTP or original SQL is permitted in this fixture');}});
 // Invoke the real createServer request listener with HTTP streams, matching
 // the gateway's existing isolated fixtures. No TCP listener or network is
 // needed; every route, context construction and original auth check runs.
 async function request(route,{method='GET',body,csrf,originHeader,cookieHeader=cookie,bearer}={}){
  const headers={host,...(cookieHeader?{cookie:cookieHeader}:{}),...(csrf!==undefined?{'x-csrf-token':csrf}:{}),...(originHeader!==undefined?{origin:originHeader}:{}),...(bearer?{authorization:'Bearer '+bearer}:{}),...(body!==undefined?{'content-type':'application/json'}:{})};
  return new Promise((resolve,reject)=>{const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.url=route;req.method=method;req.headers=headers;req.socket={remoteAddress:'isolated-http-fixture'};
   const chunks=[],res=new Writable({write(c,_encoding,done){chunks.push(Buffer.from(c));done();}});res.statusCode=200;res.headers={};res.setHeader=(k,v)=>{res.headers[k.toLowerCase()]=v;};res.getHeader=k=>res.headers[k.toLowerCase()];res.once('error',reject);res.once('finish',()=>{const text=Buffer.concat(chunks).toString();let value;try{value=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,value});});server.emit('request',req,res);
  });
 }
 return {original,post,request,calls,csrf:login.csrf,cookie,issued};
}
test('GET HTML and script use real owner session but never call POST-only list or SQL',async t=>{
 const f=await fixture(t);
 // This is the original chain behind the deployed METHOD_DENIED, not a mock.
 assert.throws(()=>f.original.nativeConnections.list({...f.post,method:'GET'}),{code:'METHOD_DENIED',status:405});
 const page=await f.request('/auth/scheduler-state');assert.equal(page.status,200,page.value?.error);assert.match(page.headers['content-type'],/text\/html/);assert.match(page.text,/Autorizar leitura das travas/);assert.match(page.text,/\/auth\/scheduler-state\.js/);assert.match(page.text,/scheduler-state-data/);
 const script=await f.request('/auth/scheduler-state.js');assert.equal(script.status,200,script.value?.error);assert.match(script.headers['content-type'],/javascript/);assert.match(script.text,/\/auth\/native-connections/);assert.match(script.text,/POST/);assert.equal(f.calls.list.length,0);assert.equal(f.calls.authorize.length,0);assert.equal(f.calls.read,0);assert.equal(f.calls.upstream,0);
 for(const r of [page,script]){assert.equal(r.headers['cache-control'],'no-store');assert.match(r.headers['content-security-policy'],/frame-ancestors 'none'/);assert.ok(!r.text.includes(f.issued.token));}
});
test('connection listing preserves POST, original session, exact Origin and real CSRF',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/auth/native-connections')).status,405);
 for(const options of [{method:'POST',body:{action:'list'},originHeader:origin},{method:'POST',body:{action:'list'},originHeader:origin,csrf:'wrong-fixture-csrf'},{method:'POST',body:{action:'list'},originHeader:'https://foreign.invalid',csrf:f.csrf}]){const r=await f.request('/auth/native-connections',options);assert.equal(r.status,403);assert.equal(f.calls.list.length,0);}
 const listed=await f.request('/auth/native-connections',{method:'POST',body:{action:'list'},csrf:f.csrf,originHeader:origin});assert.equal(listed.status,200);assert.ok(listed.value.connections.some(c=>c.id===f.issued.connection.id));assert.deepEqual(f.calls.list,[{method:'POST',csrf:f.csrf}]);assert.equal(f.calls.read,0);assert.equal(f.calls.upstream,0);
});
test('separate state authorization remains explicit POST plus CSRF; list grants no new purpose',async t=>{
 const f=await fixture(t);const action={action:'authorize',connectionId:f.issued.connection.id,consent:true};
 const get=await f.request('/auth/scheduler-state-settings');assert.equal(get.status,405);assert.equal(f.calls.authorize.length,0);
 const denied=await f.request('/auth/scheduler-state-settings',{method:'POST',body:action,originHeader:origin,csrf:'wrong-fixture-csrf'});assert.equal(denied.status,403);assert.equal(f.calls.authorize.length,0);
 await f.request('/auth/native-connections',{method:'POST',body:{action:'list'},originHeader:origin,csrf:f.csrf});assert.equal(f.calls.authorize.length,0);
 const valid=await f.request('/auth/scheduler-state-settings',{method:'POST',body:action,originHeader:origin,csrf:f.csrf});
 // The disposable owner deliberately has no original CRM/PG grant. The real
 // separate CURRENT consent correctly refuses it, without fabricating one.
 assert.equal(valid.status,403);assert.notEqual(valid.value.error,'METHOD_DENIED');assert.notEqual(valid.value.error,'CSRF_DENIED');assert.equal(f.calls.authorize.length,1);assert.equal(f.calls.authorize[0].context.method,'POST');assert.equal(f.calls.authorize[0].context.csrf,f.csrf);assert.equal(f.calls.authorize[0].connectionId,f.issued.connection.id);assert.equal(f.calls.read,0);assert.equal(f.calls.upstream,0);
});
test('browser cannot read native state and a bearer cannot navigate owner HTML/JS',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/scheduler-state-receipt')).status,403);
 for(const route of ['/auth/scheduler-state','/auth/scheduler-state.js']){const r=await f.request(route,{cookieHeader:null,bearer:f.issued.token});assert.equal(r.status,401);assert.ok(!r.text.includes('scheduler-state-authorization'));}
 assert.equal(f.calls.list.length,0);assert.equal(f.calls.read,0);assert.equal(f.calls.upstream,0);
});
test('served browser JS lists by real CSRF POST and never performs state SQL or implicit authorization',async t=>{
 const f=await fixture(t),page=await f.request('/auth/scheduler-state'),script=await f.request('/auth/scheduler-state.js');assert.equal(page.status,200);assert.equal(script.status,200);
 const data=page.text.match(/<script[^>]*id="scheduler-state-data"[^>]*>([\s\S]*?)<\/script>/);assert.ok(data);const browserCalls=[],listeners={},elements={};
 function element(id){return elements[id]||(elements[id]={value:'',disabled:false,textContent:'',children:[],addEventListener:(event,fn)=>{listeners[id+':'+event]=fn;},replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);},querySelector(){return element('authorize');}});}
 element('scheduler-state-data').textContent=data[1];
 const pending=[];const document={getElementById:element,createElement:tag=>({tag,value:'',textContent:'',append(){}}),querySelector:()=>element('authorize')};
 vm.runInNewContext(script.text,{document,window:{addEventListener(){}},fetch:(route,options)=>{browserCalls.push({route,options});const p=f.request(route,{method:options.method,body:JSON.parse(options.body),csrf:options.headers['X-CSRF-Token']||options.headers['x-csrf-token'],originHeader:origin}).then(r=>({ok:r.status>=200&&r.status<300,status:r.status,json:async()=>r.value}));pending.push(p);return p;},console:{error(){},log(){}}});
 await Promise.all(pending);await new Promise(resolve=>setImmediate(resolve));assert.equal(browserCalls.length,1);assert.equal(browserCalls[0].route,'/auth/native-connections');assert.equal(browserCalls[0].options.method,'POST');assert.deepEqual(JSON.parse(browserCalls[0].options.body),{action:'list'});assert.equal(f.calls.list.length,1);assert.equal(f.calls.list[0].method,'POST');assert.equal(f.calls.list[0].csrf,f.csrf);assert.equal(f.calls.authorize.length,0);assert.equal(f.calls.read,0);assert.equal(f.calls.upstream,0);
});
