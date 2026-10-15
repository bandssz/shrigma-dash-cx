'use strict';
// Real HTTP cookie/CSRF/SQLite with a synthetic original TTS service only.
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs'),{settingsFromEnv,createServer}=require(runtime+'/server.cjs'),P=require(runtime+'/proxy.cjs'),M=require('../influs-tts-manual.js');
const HOST='gerencial.shrigma.com.br',EMAIL='felipebandeira@oaristocrata.com',PASS='Synthetic-Test-Password-2026!',sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function response(body,url,status=200){const r=new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:String(url)});return r;}
async function fixture(t,{write=true,fronts=['afiliados'],brands=['aristo','fish'],holder=true,policy=true,hooks={}}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'simple-tts-')),dbPath=path.join(dir,'identity.sqlite'),key='synthetic-tts-write-2026',calls=[],ops=new Map();
 const env={DASHBOARD_MODE:'operational',DASHBOARD_SIMPLE_READ_LOGIN:'enabled',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:HOST,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:JSON.stringify(['oaristocrata.com','shrigma.com.br','fishermans.com.br']),DASHBOARD_ADMIN_EMAIL:EMAIL,DASHBOARD_BOOTSTRAP_SHA256:sha('synthetic-bootstrap'),DASHBOARD_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('hex'),DASHBOARD_UPSTREAMS:JSON.stringify({'tts-action':P.FIXED_DESTINATIONS['tts-action']}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify(['n8n-n8n.tazdb8.easypanel.host']),DASHBOARD_SERVICE_READ_AFILIADOS_KEY:'synthetic-tts-read-2026',DASHBOARD_DB_PATH:dbPath,DASHBOARD_PUBLIC_DIR:dir};
 const settings=settingsFromEnv(env),auth=createAuth(settings);
 await auth.completeBootstrap({email:EMAIL,token:'synthetic-bootstrap',password:PASS,host:HOST,origin:'https://'+HOST});
 let admin=await auth.login({email:EMAIL,password:PASS,host:HOST,origin:'https://'+HOST}),ctx={host:HOST,origin:'https://'+HOST,method:'POST',cookieHeader:admin.cookie.split(';')[0],csrf:admin.csrf};
 auth.setGrants({context:ctx,userId:auth.session(ctx).user.id,permissions:{growth:{read:true,edit:false},organico:{read:true,edit:false},influs:{read:true,edit:true}}});
 admin=await auth.login({email:EMAIL,password:PASS,host:HOST,origin:'https://'+HOST});ctx={host:HOST,origin:'https://'+HOST,method:'POST',cookieHeader:admin.cookie.split(';')[0],csrf:admin.csrf};
 if(holder)auth.setUpstreamCredential({context:ctx,userId:auth.session(ctx).user.id,slot:'tts-write',bearer:key});
 const user=await auth.simpleAccounts.create({context:ctx,email:'synthetic-affiliate@oaristocrata.com',password:PASS,jobTitle:'analista',fronts,brands,writeFronts:write?fronts:[]}),login=await auth.login({email:user.user.email,password:PASS,host:HOST,origin:'https://'+HOST});
 const fetchImpl=async(url,o)=>{
  const u=new URL(url),body=o.method==='POST'?JSON.parse(o.body):null,action=body?.acao||u.searchParams.get('acao');calls.push({action,method:o.method,body});a.equal(o.headers.Cookie,undefined);a.equal(o.headers.Origin,undefined);
  if(body)a.equal(body.k,key);else a.equal(o.headers['X-TTS-Write-Key'],hooks.currentKey||key);
  if(action==='capacidades'){await hooks.cap?.();return response({contract:'tts_manual_runtime_v1',operation:true,write:hooks.closed!==true,cutover_verified:true,admission_verified:true},u);}
  if(action==='operacao'){
   const operation_id=u.searchParams.get('operation_id'),stored=ops.get(operation_id);let operation=stored?structuredClone(stored):{operation_id,actor_sha256:await M.actorHash(hooks.currentKey||key,crypto.webcrypto),marca:u.searchParams.get('marca'),application_id:u.searchParams.get('application_id'),state:'missing',request_payload:null,response:null};await hooks.receipt?.(operation);return response({contract:'tts_manual_operation_v1',operation},u);
  }
  if(action==='revisar'){
   const payload=M.normalize(body);a.equal(payload.autor,user.user.id);const db=new DatabaseSync(dbPath);try{a.equal(db.prepare('SELECT state FROM simple_tts_attempts_v1 WHERE operation_id=?').get(body.operation_id).state,'reserved');}finally{db.close();}
   const state=hooks.blocked?'blocked':'accepted',decision=payload.resultado==='APPROVE'?'manual_aprovada':'manual_rejeitada';ops.set(body.operation_id,{operation_id:body.operation_id,actor_sha256:await M.actorHash(key,crypto.webcrypto),marca:payload.marca,application_id:payload.application_id,state,request_payload:payload,response:{status:state==='accepted'?200:409,body:state==='accepted'?{operation_id:body.operation_id,ok:true,linhas:[{application_id:payload.application_id,decisao:decision,status:'PENDING_SHIPMENT',private_customer:'synthetic-person@invalid.test'}]}:{operation_id:body.operation_id,ok:false,private_error:'synthetic private provider error'}}});await hooks.afterPost?.();if(hooks.lost)throw Error('synthetic ACK lost');return response({ok:true},u);
  }
  throw Error('Synthetic action outside original contract');
 };
 const server=createServer(settings,{auth,fetchImpl,...(policy?{ttsBusinessAllowed:()=>true}:{})});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=(url,{body,who=login,csrf=true}={})=>new Promise((resolve,reject)=>{const bytes=body?Buffer.from(JSON.stringify(body)):null,headers={Host:HOST,Origin:'https://'+HOST,Cookie:who.cookie.split(';')[0],...(csrf?{'X-CSRF-Token':who.csrf}:{}),...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})};const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method:body?'POST':'GET',headers},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end(bytes);});
 const update=args=>auth.simpleAccounts.update({context:ctx,userId:user.user.id,jobTitle:'analista',fronts,brands,writeFronts:write?fronts:[],active:true,...args});
 return {request,auth,ctx,user,login,key,ops,calls,hooks,update,dbPath,posts:()=>calls.filter(c=>c.method==='POST').length};
}
const command=(brand='aristo',result='APPROVE')=>({action:'review',request_id:crypto.randomUUID(),brand,application_id:'10000000000000001',resultado:result,motivo_rejeicao:result==='APPROVE'?null:'OTHER',observacao:'Synthetic internal trial only'});
const query=q=>'/api/tts-manual?'+new URLSearchParams({action:'operation',request_id:q.request_id,brand:q.brand,application_id:q.application_id});
test('both brands use the original UUID/receipt, actual author and private key; reload needs no second POST',async t=>{
 for(const brand of ['aristo','fish']){const f=await fixture(t),q=command(brand,brand==='fish'?'REJECT':'APPROVE'),r=await f.request('/api/tts-manual',{body:q});a.equal(r.status,200,JSON.stringify(r.body));a.equal(r.body.state,'accepted');a.equal(f.posts(),1);a(!JSON.stringify(r).includes(f.key));a(!JSON.stringify(r).includes('private_customer'));a.equal((await f.request(query(q))).body.state,'accepted');a.equal((await f.request('/api/tts-manual',{body:q})).body.state,'accepted');a.equal(f.posts(),1);
 const db=new DatabaseSync(f.dbPath);try{const row=db.prepare('SELECT * FROM simple_tts_attempts_v1').get();a.equal(row.user_id,f.user.user.id);a.equal(row.request_payload,undefined);a.equal(row.observacao,undefined);a.notEqual(row.operation_id,q.request_id);}finally{db.close();}}
});
test('no commercial policy, READ account, wrong front/brand or missing key cannot POST',async t=>{
 for(const opts of [{policy:false},{write:false},{fronts:['influs']},{brands:['fish']},{holder:false}]){const f=await fixture(t,opts),r=await f.request('/api/tts-manual',{body:command()});a(r.status>=400,JSON.stringify(r.body));a.equal(f.posts(),0);}
 const f=await fixture(t,{policy:false}),r=await f.request('/api/tts-manual?action=capabilities&brand=aristo');a.equal(r.body.decision,false);a.equal(r.body.reason,'TTS_PROGRAM_APPROVAL_REQUIRED');
});
test('unknown outcome retains resource across people and tabs; same attempt only consults GET',async t=>{
 const f=await fixture(t,{hooks:{lost:true,receipt:o=>{if(o.state==='accepted')o.state='outcome_unknown',o.response={status:502,body:{operation_id:o.operation_id,ok:false}};}}}),q=command(),r=await f.request('/api/tts-manual',{body:q});a.equal(r.status,202);a.equal(r.body.state,'unknown');a.equal(f.posts(),1);
 a.equal((await f.request('/api/tts-manual',{body:q})).status,202);a.equal(f.posts(),1);a.equal((await f.request('/api/tts-manual',{body:{...q,request_id:crypto.randomUUID()}})).status,409);a.equal(f.posts(),1);
 const other=await f.auth.simpleAccounts.create({context:f.ctx,email:'synthetic-other@oaristocrata.com',password:PASS,jobTitle:'analista',fronts:['afiliados'],brands:['aristo'],writeFronts:['afiliados']}),who=await f.auth.login({email:other.user.email,password:PASS,host:HOST,origin:'https://'+HOST});a.equal((await f.request(query(q),{who})).status,404);a.equal((await f.request('/api/tts-manual',{body:{...q,request_id:crypto.randomUUID()},who})).status,409);a.equal(f.posts(),1);
});
test('concurrent submissions reserve before side effect and perform one POST',async t=>{
 const f=await fixture(t);let count=0,release;const barrier=new Promise(resolve=>release=resolve);f.hooks.cap=()=>{if(++count===2)release();return barrier;};const q=command(),r=await Promise.all([f.request('/api/tts-manual',{body:q}),f.request('/api/tts-manual',{body:q})]);a.deepEqual(r.map(x=>x.status).sort(),[200,409]);a.equal(f.posts(),1);
});
test('forged author, invalid reason, missing CSRF and closed source stop before reservation',async t=>{
 const f=await fixture(t);a.equal((await f.request('/api/tts-manual',{body:{...command(),autor:'forged'}})).status,400);a.equal((await f.request('/api/tts-manual',{body:{...command('aristo','REJECT'),motivo_rejeicao:null}})).status,400);a.equal((await f.request('/api/tts-manual',{body:command(),csrf:false})).status,403);f.hooks.closed=true;a.equal((await f.request('/api/tts-manual',{body:command()})).status,403);a.equal(f.posts(),0);
});
test('revocation between capabilities and original POST is rechecked',async t=>{
 const f=await fixture(t);f.hooks.cap=()=>f.update({active:false});a.equal((await f.request('/api/tts-manual',{body:command()})).status,401);a.equal(f.posts(),0);
});
test('receipt mismatch and missing after POST are uncertain, never accepted or retried',async t=>{
 for(const mutate of [o=>{o.actor_sha256='e'.repeat(64);},o=>{o.request_payload.autor='forged';},o=>{o.state='missing';o.request_payload=o.response=null;}]){const f=await fixture(t,{hooks:{receipt:o=>{if(o.state==='accepted')mutate(o);}}}),q=command(),r=await f.request('/api/tts-manual',{body:q});a.equal(r.body.state,'unknown');a.equal(f.posts(),1);a.equal((await f.request(query(q))).body.state,'unknown');a.equal(f.posts(),1);}
});
test('original blocked receipt and key rotation preserve attempt without new source POST',async t=>{
 const f=await fixture(t,{hooks:{blocked:true}}),q=command(),r=await f.request('/api/tts-manual',{body:q});a.equal(r.body.state,'blocked');a(!JSON.stringify(r).includes('private_error'));a.equal(f.posts(),1);a.equal((await f.request('/api/tts-manual',{body:{...q,observacao:'Changed'}})).status,409);
 f.auth.setUpstreamCredential({context:f.ctx,userId:f.auth.session(f.ctx).user.id,slot:'tts-write',bearer:'synthetic-rotated-tts-write'});a.equal((await f.request(query(q))).status,403);a.equal(f.posts(),1);
});
test('revocation during receipt hash prevents disclosure and journal confirmation',async t=>{
 const f=await fixture(t),q=command(),subtle=crypto.webcrypto.subtle,original=subtle.digest;let armed=false;
 subtle.digest=async function(...args){const result=await original.apply(this,args);if(armed){armed=false;f.update({active:false});}return result;};t.after(()=>{subtle.digest=original;});
 f.hooks.receipt=o=>{if(o.state==='accepted')armed=true;};const r=await f.request('/api/tts-manual',{body:q});a.equal(r.status,401);a.equal(f.posts(),1);const db=new DatabaseSync(f.dbPath);try{a.equal(db.prepare('SELECT state FROM simple_tts_attempts_v1').get().state,'reserved');}finally{db.close();}
});
test('divergent receipt after terminal acceptance preserves the confirmed journal',async t=>{
 const f=await fixture(t),q=command(),r=await f.request('/api/tts-manual',{body:q});a.equal(r.body.state,'accepted');f.hooks.receipt=o=>{o.actor_sha256='e'.repeat(64);};a.equal((await f.request(query(q))).status,502);a.equal(f.posts(),1);const db=new DatabaseSync(f.dbPath);try{a.equal(db.prepare('SELECT state FROM simple_tts_attempts_v1').get().state,'accepted');}finally{db.close();}
});
test('pending recovery is not hidden by more recent terminal receipts',async t=>{
 const f=await fixture(t,{hooks:{receipt:o=>{if(o.state==='accepted'){o.state='outcome_unknown';o.response={status:502,body:{operation_id:o.operation_id,ok:false}};}}}}),q=command();a.equal((await f.request('/api/tts-manual',{body:q})).body.state,'unknown');
 const db=new DatabaseSync(f.dbPath);try{const prior=db.prepare('SELECT * FROM simple_tts_attempts_v1').get(),insert=db.prepare("INSERT INTO simple_tts_attempts_v1 VALUES(?,?,?,?,?,?,?,?,?,'accepted',?,?)");for(let n=0;n<105;n++)insert.run(crypto.randomUUID(),crypto.randomUUID(),prior.user_id,prior.brand,String(20000000+n),prior.binding,prior.actor_sha256,prior.request_sha256,prior.result,prior.created_at+1000+n,prior.updated_at+1000+n);}finally{db.close();}
 const r=await f.request('/api/tts-manual?action=attempts&brand=aristo');a.equal(r.status,200);a.equal(r.body.attempts.length,101);a(r.body.attempts.some(row=>row.request_id===q.request_id&&row.state==='unknown'));a.equal(f.posts(),1);
});
