'use strict';
// Real local HTTP + SQLite, synthetic sources only. No production contact.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs'),{createServer}=require(runtime+'/server.cjs'),{FIXED_DESTINATIONS}=require(runtime+'/proxy.cjs');
const HOST='gerencial.synthetic.invalid',PASS='synthetic-password-2026',STAMP='2026-10-12T15:00:00-03:00';
async function fixture(t,{fronts=['growth','organico','influs','afiliados'],brands=['fish','aristo','olivas'],missing=false,revoke=false,unscoped=false,leak=false,leakJourney=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'simple-gateway-')),boot='synthetic-bootstrap-token',areaHosts={growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'influs.synthetic.invalid'};
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),managerHost:HOST,areaHosts,allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(boot).digest('hex'),encryptionKey:Buffer.alloc(32,8),simpleReadMode:true});
 await auth.completeBootstrap({email:'admin@synthetic.invalid',token:boot,password:PASS,host:HOST,origin:'https://'+HOST});
 const admin=await auth.login({email:'admin@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST});
 const adminContext={host:HOST,origin:'https://'+HOST,method:'POST',cookieHeader:admin.cookie.split(';')[0],csrf:admin.csrf};
 const created=await auth.simpleAccounts.create({context:adminContext,email:'analista@synthetic.invalid',password:PASS,jobTitle:'analista',fronts,brands});
 const analyst=await auth.login({email:created.user.email,password:PASS,host:HOST,origin:'https://'+HOST});
 const keys={growth:'synthetic-service-crm-key',organico:'synthetic-service-organico-key',influs:'synthetic-service-influs-key',afiliados:'synthetic-service-afiliados-key'};
 if(missing)delete keys.organico;
 const upstreams=Object.fromEntries(['crm-read','cx','cache','influ','tts'].map(k=>[k,new URL(FIXED_DESTINATIONS[k])]));let reads=0;
 const fetchImpl=async(url,options)=>{
  reads++;assert(!options.headers.Cookie);assert(!options.headers.Origin);const target=new URL(url),journeys=target.href.startsWith('https://n8n.shrigma.com.br/webhook/crm-template-api-242c0db6ddb8'),front=journeys||target.href.startsWith(FIXED_DESTINATIONS['crm-read'])?'growth':target.href.startsWith(FIXED_DESTINATIONS.influ)?'influs':target.href.startsWith(FIXED_DESTINATIONS.tts)?'afiliados':'organico';
  assert.equal(options.headers.Authorization,'Bearer '+keys[front]);
  if(revoke)auth.simpleAccounts.update({context:adminContext,userId:created.user.id,jobTitle:'analista',fronts,brands,active:false});
  let data;
  if(journeys&&target.searchParams.get('acao')==='listar')data={consultado_em:STAMP,templates:[{id:'1',key:'fish:email:1',brand:'fish',channel:'email',status:'APPROVED',name:'Template sintético',draft_id:null,updated_at:STAMP,components:{subject:'Assunto',body_html:'<p>Conteúdo sintético</p>'}}]};
  else if(journeys)data={checked_at:STAMP,flows:[{key:'fish:synthetic',brand:'fish',name:'Jornada sintética',trigger:'synthetic',version:1,enabled:false,runtime_ready:false,published:null,published_version:null,journey_kind:null,available_steps:[]}]};
  else if(front==='growth')data={crm_diario:[{marca:'fish',dia:'2026-10-12',enviados:12},{marca:'aristo',dia:'2026-10-12',enviados:24}],crm_credencial:[{api_key:'synthetic-private'}]};
  else if(front==='organico')data={_escopo:'organico',_cache_gerado_em:STAMP,cx_post:[{marca:'fish',post_id:'fish-post',publicado_em:STAMP,ultima_coleta:STAMP,formato:'reel',impulsionado:false,alcance:12},{marca:'aristo',post_id:'aristo-post',publicado_em:STAMP,ultima_coleta:STAMP,formato:'reel',impulsionado:false,alcance:99}],cx_story:[],cx_organico_receita:[]};
  else if(front==='influs')data={janela:{ini:JSON.parse(options.body).ini,fim:JSON.parse(options.body).fim},influs:[],roi:[],cupons:[],custos:[],receita_cupom:[],termos:[]};
  else data={janela:{ini:JSON.parse(options.body).ini,fim:JSON.parse(options.body).fim},gerado_em:STAMP,kpis:[{marca:'fish',pedidos:2,gmv:100},{marca:'aristo',pedidos:4,gmv:200}]};
  if(unscoped)delete data.cx_post[0].marca;if(leak)data.secret=keys[front];if(leakJourney&&journeys)data.flows[0].name=keys.afiliados;
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 };
 const settings={mode:'operational',simpleReadMode:true,simpleReadSources:keys,managerHost:HOST,areaHosts,allowedEmailDomains:['synthetic.invalid'],upstreamProfile:'production',upstreams,allowedUpstreamHosts:[...new Set(Object.values(upstreams).map(u=>u.hostname))],publicDir:dir,port:0,host:'127.0.0.1'};
 const server=createServer(settings,{auth,fetchImpl});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=(url,{method='GET',body,asAdmin=false,csrf=true,brand,cookie}={})=>new Promise((resolve,reject)=>{
  const login=asAdmin?admin:analyst,bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
  const headers={Host:HOST,Origin:'https://'+HOST,Cookie:cookie||login.cookie.split(';')[0],...(csrf?{'X-CSRF-Token':login.csrf}:{}),...(brand?{'X-Shrigma-View-Brand':brand}:{}),...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})};
  const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers},res=>{let out='';res.on('data',b=>out+=b);res.on('end',()=>resolve({status:res.statusCode,body:res.headers['content-type']?.startsWith('application/json')?JSON.parse(out):out,cookie:res.headers['set-cookie']}));});req.on('error',reject);req.end(bytes);
 });
 return {request,reads:()=>reads,keys,analyst,created,auth,adminContext,fetchImpl,upstreams};
}
test('ordinary session exposes four product fronts without individual credentials or writer features',async t=>{
 const f=await fixture(t),r=await f.request('/auth/session');assert.equal(r.status,200);assert.equal(r.body.features.simpleLogin,true);assert.deepEqual(r.body.user.productFronts,['growth','organico','influs','afiliados']);assert.equal(r.body.features.campaignSubmitWrite,false);assert.equal(f.reads(),0);
});
test('same gateway serves the simple form and password controls without an old public-page dependency',async t=>{
 const f=await fixture(t),html=await f.request('/');assert.equal(html.status,200);assert.match(html.body,/id="simple-user-form"/);assert.match(html.body,/data-access-panel="todos"/);assert.match(html.body,/id="simple-password-dialog"/);assert.doesNotMatch(html.body,/__PANEL__|__LABEL__/);
 const css=await f.request('/entry.css');assert.equal(css.status,200);assert.match(css.body,/#simple-user-form/);
});
test('simple CRM users can reread published journeys without any writer or per-user source key',async t=>{
 const f=await fixture(t,{fronts:['growth'],brands:['fish']});
 const capability=await f.request('/api/templates?acao=fluxos_capacidade&marca=fish');assert.equal(capability.status,200);assert.equal(capability.body.readOnly,true);assert.equal(f.reads(),0);
 const flows=await f.request('/api/templates?acao=fluxos_listar&marca=fish');assert.equal(flows.status,200,JSON.stringify(flows.body));assert.equal(flows.body.flows[0].brand,'fish');assert.equal(f.reads(),1);
 assert.equal((await f.request('/api/templates?acao=fluxos_listar&marca=aristo')).status,403);assert.equal(f.reads(),1);
});
test('a journey field containing another service credential is never returned',async t=>{
 const f=await fixture(t,{fronts:['growth'],brands:['fish'],leakJourney:true});const r=await f.request('/api/templates?acao=fluxos_listar&marca=fish');assert.equal(r.status,502);assert(!JSON.stringify(r.body).includes(f.keys.afiliados));assert(!Object.hasOwn(r.body,'flows'));
});
test('CRM and Organic reload select only the requested brand; missing sources never become zero',async t=>{
 const f=await fixture(t);for(let i=0;i<2;i++)for(const brand of ['fish','aristo']){
  const crm=await f.request('/api/crm-read?action=cache_growth&painel=growth',{brand});assert.equal(crm.status,200,JSON.stringify(crm.body));assert.equal(crm.body.crm_diario.length,1);assert.equal(crm.body.crm_diario[0].marca,brand);assert.deepEqual(crm.body.crm_credencial,[]);
  const organic=await f.request('/api/cx?painel=organico',{brand});assert.equal(organic.status,200);assert.equal(organic.body.cx_post.length,1);assert.equal(organic.body.cx_post[0].marca,brand);assert.equal(organic.body.cx_post[0].ultima_coleta,STAMP);
 }
 const olivas=await f.request('/api/cx?painel=organico',{brand:'olivas'});assert.equal(olivas.status,503);assert.equal(olivas.body.error,'BRAND_READ_CONTRACT_NOT_READY');assert.equal(f.reads(),8);
});
test('Influs and Affiliates are independent fronts; TTS keeps the same UI contract',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish']});
 const denied=await f.request('/api/influ',{method:'POST',body:{acao:'listar',marca:'fish',ini:'2026-10-01',fim:'2026-10-12',k:f.analyst.uiKey}});assert.equal(denied.status,403);assert.equal(f.reads(),0);
 const availability=await f.request('/api/affiliate-read?brand=fish');assert.equal(availability.body.readLinked,true);
 const result=await f.request('/api/affiliate-read',{method:'POST',body:{brand:'fish',ini:'2026-10-01',fim:'2026-10-12',expected_binding:availability.body.binding}});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.kpis.length,1);assert.equal(result.body.kpis[0].gmv,100);assert.equal(f.reads(),1);
 assert.equal((await f.request('/api/affiliate-read?brand=aristo')).status,403);
});
test('Influs READ has CSRF and exact brand/period; mutations cannot reach the source',async t=>{
 const f=await fixture(t,{fronts:['influs'],brands:['fish']});const body={acao:'listar',marca:'fish',ini:'2026-10-01',fim:'2026-10-12',k:f.analyst.uiKey};
 assert.equal((await f.request('/api/influ',{method:'POST',body,csrf:false})).status,403);
 const r=await f.request('/api/influ',{method:'POST',body});assert.equal(r.status,200);assert.equal(r.body.brand,'fish');assert.deepEqual(r.body.janela,{ini:body.ini,fim:body.fim});
 const write=await f.request('/api/influ',{method:'POST',body:{acao:'piloto_operacao',request_id:crypto.randomUUID(),k:f.analyst.uiKey}});assert.equal(write.status,403);assert.equal(f.reads(),1);
});
test('service source missing, mixed row without brand, leaked key and revocation fail closed',async t=>{
 for(const config of [{missing:true},{unscoped:true},{leak:true},{revoke:true}]){
  const f=await fixture(t,config),r=await f.request('/api/cx?painel=organico',{brand:'fish'});assert(r.status>=400);assert(!Object.hasOwn(r.body,'cx_post'));assert(!JSON.stringify(r.body).includes(f.keys.organico));
 }
});
test('administrator creates, resets and disables through HTTP; analyst cannot manage accounts',async t=>{
 const f=await fixture(t);const create={action:'create',email:'new@synthetic.invalid',password:PASS,jobTitle:'gestor de CRM',fronts:['growth'],brands:['fish']};
 assert.equal((await f.request('/auth/simple/users',{method:'POST',body:create})).status,403);
 assert.equal((await f.request('/auth/simple/users',{method:'POST',body:create,asAdmin:true,csrf:false})).status,403);
 const created=await f.request('/auth/simple/users',{method:'POST',body:create,asAdmin:true});assert.equal(created.status,201,JSON.stringify(created.body));
 assert.equal((await f.request('/auth/simple/users',{method:'POST',body:{action:'reset',userId:created.body.user.id,password:PASS},asAdmin:true})).status,200);
 const update={action:'update',userId:created.body.user.id,jobTitle:create.jobTitle,fronts:create.fronts,brands:create.brands,active:false};assert.equal((await f.request('/auth/simple/users',{method:'POST',body:update,asAdmin:true})).status,200);
 const list=await f.request('/auth/users',{asAdmin:true});assert.equal(list.status,200,JSON.stringify(list.body));assert.equal(list.body.users.find(u=>u.id===created.body.user.id).active,false);assert(!JSON.stringify(list.body).includes(PASS));
 assert.equal((await f.request('/auth/users',{method:'POST',asAdmin:true,body:{action:'crm_reconcile'}})).status,403);
});

test('Master concrete brand reads do not use the null all-brands identity as a source brand',async t=>{
 const f=await fixture(t);for(const brand of ['fish','aristo']){const r=await f.request('/api/crm-read?action=cache_growth&painel=growth',{asAdmin:true,brand});assert.equal(r.status,200);assert.equal(r.body.brand,brand);assert(r.body.crm_diario.every(row=>row.marca===brand));}
 const r=await f.request('/api/influ',{asAdmin:true,method:'POST',body:{acao:'listar',ini:'2026-10-01',fim:'2026-10-12',marca:'aristo'}});assert.equal(r.status,200);assert.equal(r.body.brand,'aristo');
});
test('four-front native summary uses the same readers, scopes brands and returns only aggregate facts',async t=>{
 const f=await fixture(t),reader=require(runtime+'/simple-dashboard-read.cjs').createReader({auth:f.auth,upstreams:f.upstreams,keys:f.keys,fetchImpl:f.fetchImpl,projectGrowth:(value,brand)=>({brand,crm_diario:value.crm_diario.filter(x=>x.marca===brand)})});
 const result=await reader.summary(f.adminContext,['fish','aristo'],'https://'+HOST,Date.parse('2026-10-13T01:30:00Z'));
 assert.equal(result.sources.length,8);assert(result.sources.every(x=>x.status===200),JSON.stringify(result.sources));assert.equal(result.sources.find(x=>x.front==='growth'&&x.brand==='fish').counts.crm_diario,1);assert.equal(result.sources.find(x=>x.front==='afiliados').window.fim,'2026-10-12');
 for(const secret of Object.values(f.keys))assert(!JSON.stringify(result).includes(secret));assert(!JSON.stringify(result).includes('fish-post'));assert(!JSON.stringify(result).includes('private'));
 await assert.rejects(reader.summary({host:HOST,origin:'https://'+HOST,method:'POST',cookieHeader:f.analyst.cookie.split(';')[0],csrf:f.analyst.csrf},['fish'],'https://'+HOST),e=>e.status===403);
});
test('summary refuses sources honestly without manufacturing zero or leaking provider errors',async t=>{
 const f=await fixture(t),reader=require(runtime+'/simple-dashboard-read.cjs').createReader({auth:f.auth,upstreams:f.upstreams,keys:f.keys,fetchImpl:async()=>{throw Error('provider-private-value');},projectGrowth:x=>x});
 const result=await reader.summary(f.adminContext,['fish'],'https://'+HOST);assert(result.sources.every(x=>x.status===502&&x.error==='UPSTREAM_UNAVAILABLE'&&x.counts===null),JSON.stringify(result.sources));assert(!JSON.stringify(result).includes('provider-private-value'));
});

test('simple CRM session rereads original registered email templates with the service READ credential',async t=>{
 const f=await fixture(t,{fronts:['growth'],brands:['fish']});const r=await f.request('/api/templates?acao=listar&marca=fish&canal=email');assert.equal(r.status,200);assert.equal(r.body.templates[0].brand,'fish');assert.equal(r.body.total,1);assert.equal((await f.request('/api/templates?acao=listar&marca=aristo&canal=email')).status,403);
});
