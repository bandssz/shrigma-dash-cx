'use strict';
// Real gateway/auth/SQLite and loopback HTTP; every user/source record is synthetic.
// No live provider, SQL/IAM admission, commercial action or customer contact.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs'),{createServer}=require(runtime+'/server.cjs');
const {FIXED_DESTINATIONS}=require(runtime+'/proxy.cjs'),{decision}=require(runtime+'/afiliados-read.cjs');
const host='owner.synthetic.invalid',hosts={growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'affiliate.synthetic.invalid'};
const period={ini:'2026-10-01',fim:'2026-10-12'},credential='synthetic-affiliate-read-key';
async function fixture(t,{brand='fish',enabled=true,missing=false,area='influs',onIdentity,onData,status=200,bodyChange}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'affiliate-read-')),token=crypto.randomBytes(32).toString('base64url'),password='Synthetic-password-2026!',email='analyst@synthetic.invalid';
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),allowedEmailDomains:['synthetic.invalid'],areaHosts:hosts,managerHost:host,bootstrapAdminEmail:'owner@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(token).digest('hex'),encryptionKey:crypto.randomBytes(32).toString('hex'),dashboardAffiliateRead:enabled});
 let server;
 t.after(async()=>{if(server?.listening)await new Promise(r=>server.close(r));auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 await auth.completeBootstrap({email:'owner@synthetic.invalid',token,password,host,origin:'https://'+host});
 const owner=await auth.login({email:'owner@synthetic.invalid',password,host,origin:'https://'+host});
 const context={method:'POST',host,origin:'https://'+host,cookieHeader:owner.cookie.split(';')[0],csrf:owner.csrf};
 const invite=auth.createInvite({context,email,areas:[area],brand,permissions:{[area]:{read:true,edit:false}}});
 await auth.acceptInvite({token:invite.token,password,host:hosts[area],origin:'https://'+hosts[area]});
 const analyst=await auth.login({email,password,host:hosts[area],origin:'https://'+hosts[area]});
 if(!missing&&area==='influs')auth.setUpstreamCredential({context,userId:invite.userId,slot:'tts-read',bearer:credential});
 const f={auth,context,userId:invite.userId,identityReads:0,dataReads:0,requests:[]};
 const fetchImpl=async(url,options)=>{
  f.requests.push({url:String(url),method:options.method});
  assert.equal(options.headers.Authorization,'Bearer '+credential);assert.equal(options.headers.Cookie,undefined);
  if(String(url).includes('access=1')){
   f.identityReads++;const value={schema:'shrigma_access_identity_v1',owner:email,role:'manager',panel:'influs',allowedPanels:['influs'],permissions:{growth:null,influs:{caps:['read_creators']}}};
   if(onIdentity)await onIdentity(f,value);
   return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  }
  f.dataReads++;assert.equal(String(url),FIXED_DESTINATIONS.tts);assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),period);assert.equal(options.redirect,'manual');assert(options.signal instanceof AbortSignal);
  if(onData)await onData(f);
  const payload={gerado_em:'2026-10-12T03:15:07Z',janela:period,kpis:[{marca:'fish',gmv:'12.00',pedidos:2},{marca:'aristo',gmv:'32.00',pedidos:4}],amostras:[{marca:'fish',total:7},{marca:'aristo',total:23}],fila:[{marca:'fish',application_id:'synthetic-fish',username:'synthetic-fish'},{marca:'aristo',application_id:'synthetic-aristo',username:'synthetic-aristo'}],criadores:[],frescor:[{marca:'fish',ultima_ok:'2026-10-11T03:30:00Z',ultima_ok_todas:true},{marca:'aristo',ultima_ok:'2026-10-11T03:30:00Z',ultima_ok_todas:true}]};
  if(bodyChange)bodyChange(payload);
  return new Response(JSON.stringify(status===200?payload:{error:'Synthetic provider refusal'}),{status,headers:{'content-type':'application/json'}});
 };
 const upstreams={tts:new URL(FIXED_DESTINATIONS.tts)};
 server=createServer({mode:'operational',upstreamProfile:'production',dashboardAffiliateRead:enabled,managerHost:host,areaHosts:hosts,allowedEmailDomains:['synthetic.invalid'],upstreams,allowedUpstreamHosts:[new URL(FIXED_DESTINATIONS.tts).hostname],publicDir:dir},{auth,fetchImpl});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 f.request=(url,{method='GET',body,csrf=true,origin='https://'+hosts[area],cookie=true,contentType='application/json'}={})=>new Promise((resolve,reject)=>{
  const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  const headers={Host:hosts[area],Origin:origin};if(cookie)headers.Cookie=analyst.cookie.split(';')[0];if(csrf)headers['X-CSRF-Token']=analyst.csrf;
  if(bytes){headers['content-type']=contentType;headers['content-length']=bytes.length;}
  const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers},res=>{let text='';res.on('data',v=>text+=v);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(bytes);
 });
 f.available=()=>f.request('/api/affiliate-read?brand='+brand);
 f.read=async(extra={},options={})=>{const available=await f.available();return f.request('/api/affiliate-read',{method:'POST',body:{brand,...period,expected_binding:available.body.binding,...extra},...options});};
 return f;
}
for(const brand of ['fish','aristo'])test('same real synthetic session reads and reloads only '+brand,async t=>{
 const f=await fixture(t,{brand});const available=await f.available();assert.equal(available.status,200);assert.equal(available.body.readOnly,true);assert.match(available.body.binding,/^[a-f0-9]{64}$/);assert.equal(f.dataReads,0);
 for(let i=0;i<2;i++){const r=await f.read();assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.brands,[brand]);assert.equal(r.body.fila.length,1);assert.equal(r.body.fila[0].marca,brand);assert.equal(r.body.frescor[0].ultima_ok,'2026-10-11T03:30:00Z');assert.equal(r.body._affiliate_read.binding,available.body.binding);assert.doesNotMatch(JSON.stringify(r.body),/synthetic-affiliate-read-key/);assert.equal(r.body.fila[0].application_id,'synthetic-'+brand);}
 assert.equal(f.dataReads,2);assert.equal(f.identityReads,2);
});
test('off flag leaves the new route closed and does no source work',async t=>{const f=await fixture(t,{enabled:false});const r=await f.available();assert.equal(r.status,503);assert.equal(r.body.error,'AFFILIATE_READ_NOT_ENABLED');assert.equal(f.requests.length,0);});
test('missing tts-read never inherits influs-read',async t=>{const f=await fixture(t,{missing:true});f.auth.setUpstreamCredential({context:f.context,userId:f.userId,slot:'influs-read',bearer:'synthetic-other-purpose-key'});const a=await f.available();assert.equal(a.body.readLinked,false);assert.equal(a.body.binding,null);const r=await f.read();assert.equal(r.status,400);assert.equal(f.requests.length,0);});
test('cross-brand request refuses before identity or data query',async t=>{const f=await fixture(t);const a=await f.request('/api/affiliate-read?brand=aristo');assert.equal(a.status,403);const r=await f.read({brand:'aristo'});assert.equal(r.status,403);assert.equal(f.requests.length,0);});
test('another area cannot borrow Afiliados route',async t=>{const f=await fixture(t,{area:'organico'});const a=await f.available();assert.equal(a.status,403);assert.equal(f.requests.length,0);});
test('no cookie is not an individual identity',async t=>{const f=await fixture(t);const a=await f.request('/api/affiliate-read?brand=fish',{cookie:false});assert.equal(a.status,401);assert.equal(f.requests.length,0);});
test('semantic read POST still requires actual session CSRF',async t=>{const f=await fixture(t);const r=await f.read({},{csrf:false});assert.equal(r.status,403);assert.equal(f.requests.length,0);});
test('foreign browser origin rejects before source work',async t=>{const f=await fixture(t);const r=await f.read({},{origin:'https://foreign.synthetic.invalid'});assert.equal(r.status,403);assert.equal(f.requests.length,0);});
test('JSON content type is required',async t=>{const f=await fixture(t);const r=await f.read({},{contentType:'text/plain'});assert.equal(r.status,415);assert.equal(f.requests.length,0);});
test('old binding rejects before source work after private key rotation',async t=>{const f=await fixture(t);const a=await f.available();f.auth.setUpstreamCredential({context:f.context,userId:f.userId,slot:'tts-read',bearer:'synthetic-rotated-source-key'});const r=await f.request('/api/affiliate-read',{method:'POST',body:{brand:'fish',...period,expected_binding:a.body.binding}});assert.equal(r.status,409);assert.equal(f.requests.length,0);});
test('wrong original holder refuses without fetching data',async t=>{const f=await fixture(t,{onIdentity:(_,v)=>v.owner='other@synthetic.invalid'});const r=await f.read();assert.equal(r.status,503);assert.equal(r.body.error,'AFFILIATE_SOURCE_IDENTITY_UNCONFIRMED');assert.equal(f.dataReads,0);});
test('revocation during identity check suppresses source query',async t=>{const f=await fixture(t,{onIdentity:f=>f.auth.revokeUser({context:f.context,userId:f.userId})});const r=await f.read();assert.equal(r.status,401);assert.equal(f.dataReads,0);});
test('revocation during source query suppresses every data field',async t=>{const f=await fixture(t,{onData:f=>f.auth.revokeUser({context:f.context,userId:f.userId})});const r=await f.read();assert.equal(r.status,401);assert.equal(r.body.fila,undefined);});
test('key rotation during source query suppresses every data field',async t=>{const f=await fixture(t,{onData:f=>f.auth.setUpstreamCredential({context:f.context,userId:f.userId,slot:'tts-read',bearer:'synthetic-rotated-source-key'})});const r=await f.read();assert.equal(r.status,409);assert.equal(r.body.fila,undefined);});
test('provider refusal is never successful zero',async t=>{const f=await fixture(t,{status:503});const r=await f.read();assert.equal(r.status,503);assert.equal(r.body.kpis,undefined);assert.equal(r.body.error,'AFFILIATE_SOURCE_READ_REFUSED');});
test('unscoped row rejects the full envelope rather than guessing ownership',async t=>{const f=await fixture(t,{bodyChange:v=>delete v.fila[1].marca});const r=await f.read();assert.equal(r.status,502);assert.equal(r.body.fila,undefined);assert.equal(r.body.error,'AFFILIATE_SOURCE_BRAND_UNCONFIRMED');});
test('source period is not silently relabelled',async t=>{const f=await fixture(t,{bodyChange:v=>v.janela={...period,fim:'2026-10-11'}});const r=await f.read();assert.equal(r.status,502);assert.equal(r.body.janela,undefined);});
test('source credential leak refuses before output',async t=>{const f=await fixture(t,{bodyChange:v=>v.secret=credential});const r=await f.read();assert.equal(r.status,502);assert.doesNotMatch(JSON.stringify(r.body),/synthetic-affiliate-read-key/);});
test('READ never turns on sample approval, charge, invitation or send',async t=>{const f=await fixture(t);for(const action of ['revisar','convidar','enviar','cobrar']){const r=await f.read({acao:action});assert.equal(r.status,400);}assert.equal(f.requests.length,0);});
for(const value of [null,['a'.repeat(64)],'A'.repeat(64),'a'.repeat(63),3])test('binding is an exact version string: '+typeof value,()=>assert.throws(()=>decision('POST',new URLSearchParams(),{brand:'fish',...period,expected_binding:value}),{code:'AFFILIATE_ARGUMENTS_INVALID'}));
test('duplicate query parameters do not choose a brand',()=>assert.throws(()=>decision('GET',new URLSearchParams('brand=fish&brand=aristo')),{code:'AFFILIATE_ARGUMENTS_INVALID'}));
test('native CRM purpose cannot inherit affiliate READ authority',async t=>{const f=await fixture(t);assert.throws(()=>f.auth.affiliateReadContext({nativeBearer:'synthetic-not-a-real-delegation'},{brand:'fish'}),{code:'AFFILIATE_NATIVE_PURPOSE_REQUIRED'});assert.equal(f.requests.length,0);});
