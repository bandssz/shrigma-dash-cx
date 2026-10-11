'use strict';
// Entirely synthetic identity and upstreams. No production, provider or customer contact.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createAuth}=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/auth.cjs');
const {createServer}=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/server.cjs');
const {FIXED_DESTINATIONS}=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||require('node:path').resolve(__dirname,'../services/dashboard-operational'))+'/proxy.cjs');
const domains=['synthetic.invalid'],masterHost='master.synthetic.invalid',areaHosts={growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'creators.synthetic.invalid'};
const date='2026-10-11T19:00:00-03:00';
async function fixture(t,area='organico',{enabled=true,missing=false,identityMismatch=false,revoke=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-read-fixture-')),bootstrap=crypto.randomBytes(32).toString('base64url'),password='Synthetic-password-2026!',email='analyst@synthetic.invalid';
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),allowedEmailDomains:domains,areaHosts,managerHost:masterHost,bootstrapAdminEmail:'owner@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(bootstrap).digest('hex'),encryptionKey:crypto.randomBytes(32).toString('hex'),dashboardIndividualRead:enabled});
 let server;
 t.after(async()=>{if(server?.listening)await new Promise(resolve=>server.close(resolve));auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 await auth.completeBootstrap({email:'owner@synthetic.invalid',token:bootstrap,password,host:masterHost,origin:'https://'+masterHost});
 const admin=await auth.login({email:'owner@synthetic.invalid',password,host:masterHost,origin:'https://'+masterHost});
 const context={method:'POST',host:masterHost,origin:'https://'+masterHost,cookieHeader:admin.cookie.split(';')[0],csrf:admin.csrf};
 const invitation=auth.createInvite({context,email,areas:[area],brand:'fish',permissions:{[area]:{read:true,edit:false}}});
 const token=invitation.token;
 await auth.acceptInvite({token,password,host:areaHosts[area],origin:'https://'+areaHosts[area]});
 const analyst=await auth.login({email,password,host:areaHosts[area],origin:'https://'+areaHosts[area]});
 const slot={growth:'crm-panel-read',organico:'organico-read',influs:'influs-read'}[area],credential='fixture-read-key-20261011';
 let dataReads=0,identityReads=0;
 const identity=()=>({schema:'shrigma_access_identity_v1',owner:identityMismatch?'other@synthetic.invalid':email,role:'manager',panel:area,allowedPanels:[area],...(area==='growth'?{permissions:{growth:{who:'panel:fixture',label:email,caps:['read_content']},influs:null}}:{})});
 const fetchImpl=async(url,options)=>{
  // Deliberately no network implementation: the only responses are these fixtures.
  if(String(url).includes('action=identity')||String(url).includes('access=1')){identityReads++;return new Response(JSON.stringify(identity()),{headers:{'content-type':'application/json'}});}
  dataReads++;assert.match(options.headers.Authorization||options.headers.authorization,/fixture-read-key/);
  if(revoke)auth.revokeUser({context,userId:invitation.userId});
  const data=area==='organico'?{_escopo:'organico',_cache_gerado_em:date,cx_post:[{marca:'fish',post_id:'fixture-1',publicado_em:date,formato:'reel',impulsionado:true,alcance:12},{marca:'aristo',post_id:'fixture-2',publicado_em:date,formato:'foto',impulsionado:false}],cx_story:[],cx_organico_receita:[]}:area==='influs'?{janela:{ini:'2026-10-01',fim:'2026-10-11'},influs:[],roi:[],cupons:[],custos:[],receita_cupom:[],termos:[]}:{crm_diario:[{marca:'fish',dia:'2026-10-11',enviados:12},{marca:'aristo',dia:'2026-10-11',enviados:98}]};
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 };
 if(!missing){
  if(area==='growth')await auth.setCrmPanelReadCredential({context,userId:invitation.userId,slot,bearer:credential,fetchImpl});
  else auth.setUpstreamCredential({context,userId:invitation.userId,slot,bearer:credential});
 }
 identityReads=0;
 const upstreams=Object.fromEntries(Object.entries(FIXED_DESTINATIONS).filter(([k])=>['crm-read','cx','cache','influ'].includes(k)).map(([k,v])=>[k,new URL(v)]));
 // crm-read is a reviewed non-dynamic destination defined separately.
 upstreams['crm-read']=new URL('https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read');
 const settings={mode:'operational',upstreamProfile:'production',dashboardIndividualRead:enabled,allowedEmailDomains:domains,managerHost:masterHost,areaHosts,upstreams,allowedUpstreamHosts:[...new Set(Object.values(upstreams).map(u=>u.hostname))],publicDir:dir,port:0,host:'127.0.0.1'};
 server=createServer(settings,{auth,fetchImpl});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const request=async(url,{method='GET',body,csrf=true}={})=>new Promise((resolve,reject)=>{
  const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  const headers={Host:areaHosts[area],Cookie:analyst.cookie.split(';')[0],Origin:'https://'+areaHosts[area]};
  if(csrf)headers['X-CSRF-Token']=analyst.csrf;
  if(bytes){headers['content-type']='application/json';headers['content-length']=bytes.length;}
  const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers},res=>{let out='';res.on('data',v=>out+=v);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(out)}));});req.on('error',reject);req.end(bytes);
 });
 return {request,auth,analyst,context,userId:invitation.userId,reads:()=>({identityReads,dataReads})};
}
test('legitimate synthetic analyst reads only own organic brand and reloads safely',async t=>{const f=await fixture(t);for(let i=0;i<2;i++){const r=await f.request('/api/cx?painel=organico');assert.equal(r.status,200);assert.equal(r.body.cx_post.length,1);assert.equal(r.body.cx_post[0].marca,'fish');assert.equal(r.body.cx_post[0].impulsionado,true);assert.doesNotMatch(JSON.stringify(r.body),/fixture-read-key|fixture-2/);}assert.deepEqual(f.reads(),{identityReads:2,dataReads:2});});
test('flag off preserves original closed organic gate',async t=>{const f=await fixture(t,'organico',{enabled:false});const r=await f.request('/api/cx?painel=organico');assert.equal(r.status,503);assert.equal(r.body.error,'BRAND_READ_CONTRACT_NOT_READY');assert.equal(f.reads().dataReads,0);});
test('missing individual credential refuses before source query',async t=>{const f=await fixture(t,'organico',{missing:true});const r=await f.request('/api/cx?painel=organico');assert.equal(r.status,503);assert.equal(r.body.error,'INDIVIDUAL_CREDENTIAL_MISSING');assert.deepEqual(f.reads(),{identityReads:0,dataReads:0});});
test('wrong backend owner refuses before data query',async t=>{const f=await fixture(t,'organico',{identityMismatch:true});const r=await f.request('/api/cx?painel=organico');assert.equal(r.status,403);assert.equal(r.body.error,'CREDENTIAL_ATTESTATION_FAILED');assert.equal(f.reads().dataReads,0);});
test('revocation while source read is pending suppresses data',async t=>{const f=await fixture(t,'organico',{revoke:true});const r=await f.request('/api/cx?painel=organico');assert.equal(r.status,401);assert.equal(Object.hasOwn(r.body,'cx_post'),false);});
test('request for another area is refused without source access',async t=>{const f=await fixture(t);const r=await f.request('/api/crm-read?action=cache_growth&painel=growth');assert.equal(r.status,403);assert.equal(f.reads().dataReads,0);});
test('creator list requires CSRF despite being a semantic read',async t=>{const f=await fixture(t,'influs');const r=await f.request('/api/influ',{method:'POST',csrf:false,body:{acao:'listar',ini:'2026-10-01',fim:'2026-10-11',pilot:false,k:f.analyst.uiKey}});assert.equal(r.status,403);assert.equal(f.reads().dataReads,0);});
test('creator list keeps exact requested window',async t=>{const f=await fixture(t,'influs');const r=await f.request('/api/influ',{method:'POST',body:{acao:'listar',ini:'2026-10-01',fim:'2026-10-11',pilot:false,k:f.analyst.uiKey}});assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.janela,{ini:'2026-10-01',fim:'2026-10-11'});assert.deepEqual(f.reads(),{identityReads:1,dataReads:1});});
test('READ pilot does not enable creator mutation',async t=>{const f=await fixture(t,'influs');const r=await f.request('/api/influ',{method:'POST',body:{acao:'piloto_operacao',request_id:crypto.randomUUID(),k:f.analyst.uiKey}});assert.equal(r.status,403);assert.equal(f.reads().dataReads,0);});
test('CRM can read without any writer/provisioner and does not claim operational acceptance',async t=>{const f=await fixture(t,'growth');const r=await f.request('/api/crm-read?action=cache_growth&painel=growth');assert.equal(r.status,200);assert.equal(r.body.crm_diario.length,1);assert.equal(r.body.crm_diario[0].enviados,12);const users=f.auth.users({context:f.context});const u=users.users?users.users.find(u=>u.id===f.userId):users.find(u=>u.id===f.userId);assert.equal(u.crmAccess.readOnly,true);assert.equal(u.crmAccess.operational,false);});
