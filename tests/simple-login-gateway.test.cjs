'use strict';
// Real local HTTP + SQLite, synthetic sources only. No production contact.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const {createAuth}=require(runtime+'/auth.cjs'),{createServer}=require(runtime+'/server.cjs'),{FIXED_DESTINATIONS}=require(runtime+'/proxy.cjs');
const HOST='gerencial.synthetic.invalid',PASS='synthetic-password-2026',STAMP='2026-10-12T15:00:00-03:00';
async function fixture(t,{fronts=['growth','organico','influs','afiliados'],brands=['fish','aristo','olivas'],missing=false,revoke=false,unscoped=false,leak=false,leakJourney=false,ownPartners=false,writeFronts=[],writer=false,uncertainWrite=false,badWriteReceipt=false,hooks={}}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'simple-gateway-')),boot='synthetic-bootstrap-token',areaHosts={growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'influs.synthetic.invalid'};
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),managerHost:HOST,areaHosts,allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(boot).digest('hex'),encryptionKey:Buffer.alloc(32,8),simpleReadMode:true});
 await auth.completeBootstrap({email:'admin@synthetic.invalid',token:boot,password:PASS,host:HOST,origin:'https://'+HOST});
 const admin=await auth.login({email:'admin@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST});
 const adminContext={host:HOST,origin:'https://'+HOST,method:'POST',cookieHeader:admin.cookie.split(';')[0],csrf:admin.csrf};
 const created=await auth.simpleAccounts.create({context:adminContext,email:'analista@synthetic.invalid',password:PASS,jobTitle:'analista',fronts,brands,writeFronts});
 const analyst=await auth.login({email:created.user.email,password:PASS,host:HOST,origin:'https://'+HOST});
 const keys={growth:'synthetic-service-crm-key',organico:'synthetic-service-organico-key',influs:'synthetic-service-influs-key',afiliados:'synthetic-service-afiliados-key'};
 if(missing)delete keys.organico;
 const upstreams=Object.fromEntries(['crm-read','cx','cache','influ','tts'].map(k=>[k,new URL(FIXED_DESTINATIONS[k])]));let reads=0;
 const writerKey='synthetic-private-affiliate-write-key',receipts=new Map();let writes=0;const candidate={marca:'fish',id:'10000000-0000-4000-8000-000000000001',name:'Synthetic affiliate',handle:'@synthetic',source:'manual',source_reference:'synthetic-reference',state:'novo',note:'synthetic note preserved',version:1};
 const fetchImpl=async(url,options)=>{
  reads++;assert(!options.headers.Cookie);assert(!options.headers.Origin);const target=new URL(url),journeys=target.href.startsWith('https://n8n.shrigma.com.br/webhook/crm-modelos-20261014-14a1976f59cd'),front=journeys||target.href.startsWith(FIXED_DESTINATIONS['crm-read'])?'growth':target.href.startsWith(FIXED_DESTINATIONS.influ)?'influs':target.href.startsWith(FIXED_DESTINATIONS.tts)?'afiliados':'organico';
  const command=JSON.parse(options.body||'{}');
  if(front==='influs'&&['piloto_salvar','piloto_operacao'].includes(command.acao)){
   assert.equal(command.k,writerKey);assert(!Object.hasOwn(command,'autor'));assert(!options.headers.Authorization);
   if(command.acao==='piloto_operacao')return new Response(JSON.stringify({ok:true,state:receipts.has(command.request_id)?'confirmed':'not_found',receipt:receipts.get(command.request_id)||null}),{headers:{'content-type':'application/json'}});
   writes++;assert.equal(command.kind,'candidato');assert.equal(command.data.note,candidate.note);assert.equal(command.data.source_reference,candidate.source_reference);
   if(command.expected_version!==candidate.version)return new Response(JSON.stringify({erro:'Cadastro mudou. Atualize antes de salvar.'}),{headers:{'content-type':'application/json'}});
   Object.assign(candidate,command.data,{version:candidate.version+1});const receipt={ok:true,kind:'candidato',id:candidate.id,version:candidate.version,request_id:command.request_id};receipts.set(command.request_id,receipt);
   await hooks.afterCommit?.();
   if(uncertainWrite)throw Error('synthetic transport uncertain after commit');
   return new Response(JSON.stringify(badWriteReceipt?{...receipt,id:crypto.randomUUID()}:receipt),{headers:{'content-type':'application/json'}});
  }
  const own=front==='influs'&&command.pilot===true;assert.equal(options.headers.Authorization,'Bearer '+keys[own?'afiliados':front]);
  if(revoke)auth.simpleAccounts.update({context:adminContext,userId:created.user.id,jobTitle:'analista',fronts,brands,active:false});
  let data;
  if(journeys&&target.searchParams.get('acao')==='listar')data={consultado_em:STAMP,templates:[{id:'1',key:'fish:email:1',brand:'fish',channel:'email',status:'APPROVED',name:'Template sintético',draft_id:null,updated_at:STAMP,components:{subject:'Assunto',body_html:'<p>Conteúdo sintético</p>'}}]};
  else if(journeys)data={checked_at:STAMP,flows:[{key:'fish:synthetic',brand:'fish',name:'Jornada sintética',trigger:'synthetic',version:1,enabled:false,runtime_ready:false,published:null,published_version:null,journey_kind:null,available_steps:[]}]};
  else if(front==='growth')data={crm_diario:[{marca:'fish',dia:'2026-10-12',enviados:12},{marca:'aristo',dia:'2026-10-12',enviados:24}],crm_credencial:[{api_key:'synthetic-private'}]};
  else if(front==='organico')data={_escopo:'organico',_cache_gerado_em:STAMP,cx_post:[{marca:'fish',post_id:'fish-post',publicado_em:STAMP,ultima_coleta:STAMP,formato:'reel',impulsionado:false,alcance:12},{marca:'aristo',post_id:'aristo-post',publicado_em:STAMP,ultima_coleta:STAMP,formato:'reel',impulsionado:false,alcance:99}],cx_story:[],cx_organico_receita:[]};
  else if(front==='influs')data={janela:{ini:JSON.parse(options.body).ini,fim:JSON.parse(options.body).fim},influs:[],roi:[],cupons:[],custos:[],receita_cupom:[],termos:[]};
  else data={janela:{ini:JSON.parse(options.body).ini,fim:JSON.parse(options.body).fim},gerado_em:STAMP,kpis:[{marca:'fish',pedidos:2,gmv:100},{marca:'aristo',pedidos:4,gmv:200}]};
  if(ownPartners&&front==='influs')data.pilot={schema:'creator_pilot_v1',since:data.janela.ini,until:data.janela.fim,programs:[{marca:'fish',rate:0.05,state:'piloto_interno'}],candidates:[{...candidate}],links:[{marca:'fish',candidate_id:'10000000-0000-4000-8000-000000000001',ref:'fixture-ref',state:'ativo',url:'https://fishermans.com.br/?ref=fixture-ref'}],partner_orders:[]};
  if(unscoped)delete data.cx_post[0].marca;if(leak)data.secret=keys[front];if(leakJourney&&journeys)data.flows[0].name=keys.afiliados;
  await hooks.afterRead?.();
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 };
 const settings={mode:'operational',simpleReadMode:true,simpleReadSources:keys,...(writer?{simpleAffiliateWriteKey:writerKey}:{}),managerHost:HOST,areaHosts,allowedEmailDomains:['synthetic.invalid'],upstreamProfile:'production',upstreams,allowedUpstreamHosts:[...new Set(Object.values(upstreams).map(u=>u.hostname))],publicDir:dir,port:0,host:'127.0.0.1'};
 const server=createServer(settings,{auth,fetchImpl});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=(url,{method='GET',body,asAdmin=false,csrf=true,brand,cookie}={})=>new Promise((resolve,reject)=>{
  const login=asAdmin?admin:analyst,bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
  const headers={Host:HOST,Origin:'https://'+HOST,Cookie:cookie||login.cookie.split(';')[0],...(csrf?{'X-CSRF-Token':login.csrf}:{}),...(brand?{'X-Shrigma-View-Brand':brand}:{}),...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})};
  const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers},res=>{let out='';res.on('data',b=>out+=b);res.on('end',()=>resolve({status:res.statusCode,body:res.headers['content-type']?.startsWith('application/json')?JSON.parse(out):out,cookie:res.headers['set-cookie']}));});req.on('error',reject);req.end(bytes);
 });
 return {request,reads:()=>reads,keys,analyst,created,auth,adminContext,fetchImpl,upstreams,writes:()=>writes,candidate,receipts,writerKey};
}
test('ordinary session exposes four product fronts without individual credentials or writer features',async t=>{
 const f=await fixture(t),r=await f.request('/auth/session');assert.equal(r.status,200);assert.equal(r.body.features.simpleLogin,true);assert.deepEqual(r.body.user.productFronts,['growth','organico','influs','afiliados']);assert.equal(r.body.features.campaignSubmitWrite,false);assert.equal(f.reads(),0);
});
test('piece import uses the real cookie route, delegated WRITE and CSRF without a source request',async t=>{
 const f=await fixture(t,{fronts:['growth'],brands:['fish'],writeFronts:['growth']}),Input=require(runtime+'/model-piece-input.cjs');
 const body={acao:'rascunho',idempotency_key:crypto.randomUUID(),rascunho:Input.prepare({name:'Peça local',subject:'Conteúdo pronto',format:'html',content:'<p>Uma peça da marca</p><a href="{{ .UnsubscribeURL }}">Sair</a>'},'fish')};
 const cap=await f.request('/api/model-pieces?acao=modelos_capacidade&marca=fish');assert.equal(cap.status,200);assert.equal(cap.body.draft,true);
 assert.equal((await f.request('/api/model-pieces',{method:'POST',body,csrf:false})).status,403);
 assert.equal((await f.request('/api/model-pieces?acao=rascunho',{method:'POST',body})).status,405);
 const saved=await f.request('/api/model-pieces',{method:'POST',body});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.operation.state,'completed');const id=saved.body.operation.response.body.draft_id;
 const reopened=await f.request('/api/model-pieces?'+new URLSearchParams({acao:'rascunho_obter',marca:'fish',draft_id:id}));assert.equal(reopened.status,200);assert.equal(reopened.body.drafts[0].rascunho.corpo,body.rascunho.corpo);
 assert.equal((await f.request('/api/model-pieces?'+new URLSearchParams({acao:'rascunho_obter',marca:'aristo',draft_id:id}))).status,403);
 assert.equal(f.reads(),0);assert.equal(f.writes(),0);
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
 const fish=result.sources.find(x=>x.front==='afiliados'&&x.brand==='fish').affiliate90d,aristo=result.sources.find(x=>x.front==='afiliados'&&x.brand==='aristo').affiliate90d;
 assert.deepEqual(fish.window,{ini:'2026-07-15',fim:'2026-10-12'});assert.deepEqual(fish.metrics,{gmv:100,pedidos:2,criadores:null,comissao:null});assert.equal(aristo.metrics.gmv,200);assert.equal(fish.readOnly,true);
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

test('original attribution dimension keeps SQL nulls and positions for each admitted grain',()=>{
 const project=require(runtime+'/server.cjs').projectBrandCache,sizes={total:1,channel:1,family:1,family_channel:2,campaign:1,campaign_channel:2,flow_piece:3,piece:6};
 for(const [grain,size]of Object.entries(sizes)){
  const nullable={campaign:[0],campaign_channel:[0],flow_piece:[1,2],piece:[1,2,3,4,5]}[grain]||[],dimension=Array.from({length:size},(_,i)=>nullable.includes(i)?null:'synthetic');const body={crm_attribution:{daily:[{brand:'fish',grain,dimension,dia:'2026-10-12',pedidos:1,receita:12}]}};
  const out=project(body,'fish','growth','https://'+HOST);assert.deepEqual(out.crm_attribution.daily[0].dimension,dimension);
  for(let i=0;i<size;i++)if(!nullable.includes(i)){const invalid=[...dimension];invalid[i]=null;assert.throws(()=>project({crm_attribution:{daily:[{brand:'fish',grain,dimension:invalid}]}},'fish','growth','https://'+HOST),e=>e.projectionIssue?.field==='dimension');}
  assert.throws(()=>project({crm_attribution:{daily:[{brand:'fish',grain,dimension:[...dimension,'extra']}] }},'fish','growth','https://'+HOST),e=>e.projectionIssue?.field==='dimension');
 }
 assert.throws(()=>project({crm_diario:[{brand:'fish',enviados:{private:'value'}}]},'fish','growth','https://'+HOST),e=>e.code==='BRAND_RESPONSE_UNSCOPED');
 assert.throws(()=>project({crm_campanha:[{brand:'fish',segmentos:[null]}]},'fish','growth','https://'+HOST),e=>e.code==='BRAND_RESPONSE_UNSCOPED');
});
test('projection failure native summary reveals only the closed section, field and reason',async t=>{
 const f=await fixture(t),reader=require(runtime+'/simple-dashboard-read.cjs').createReader({auth:f.auth,upstreams:f.upstreams,keys:f.keys,fetchImpl:async()=>new Response(JSON.stringify({crm_diario:[{brand:'fish',enviados:{email:'private@synthetic.invalid'}}]}),{headers:{'content-type':'application/json'}}),projectGrowth:require(runtime+'/server.cjs').projectBrandCache});
 const result=await reader.summary(f.adminContext,['fish'],'https://'+HOST);const crm=result.sources.find(x=>x.front==='growth');
 assert.equal(crm.status,502);assert.deepEqual(crm.diagnostic,{section:'crm_diario',reason:'field_type_invalid',field:'enviados'});assert.equal(crm.counts,null);assert(!JSON.stringify(result).includes('private@'));assert.deepEqual(Object.keys(crm.diagnostic).sort(),['field','reason','section']);assert(!Object.hasOwn(crm,'rows'));assert(!Object.hasOwn(crm,'payload'));
});

test('published shared CRM collectors are metadata and never become a fabricated brand',()=>{
 const S=require(runtime+'/server.cjs'),row={fonte:'listmonk_snapshot',rotulo:'unsafe-label',tipo:'coleta',status:'ok',coletado_em:STAMP,cadencia_seg:1800,receita:999,email:'private@synthetic.invalid'};
 const out=S.projectBrandCache({crm_diario:[{marca:'fish',dia:'2026-10-12',enviados:12},{marca:'aristo',dia:'2026-10-12',enviados:24}],crm_fontes:[row]},'fish','growth','https://'+HOST);
 assert.equal(out.crm_diario.length,1);assert.equal(out.crm_fontes.length,1);assert.equal(out.crm_fontes[0].escopo,'compartilhado');assert.match(out.crm_fontes[0].rotulo,/coletor compartilhado/);for(const k of ['marca','brand','receita','email'])assert(!Object.hasOwn(out.crm_fontes[0],k));assert(!JSON.stringify(out).includes('unsafe-label'));assert(!JSON.stringify(out).includes('private@'));
 assert.throws(()=>S.projectBrandCache({crm_fontes:[row]},'fish','growth','https://'+HOST),e=>e.code==='BRAND_READ_CONTRACT_NOT_READY');
 assert.throws(()=>S.projectBrandCache({crm_diario:[],crm_fontes:[{...row,fonte:'unreviewed'}]},'fish','growth','https://'+HOST));
});


test('optional cart failure keeps genuine core and marks cart unavailable rather than empty',()=>{
 const S=require(runtime+'/server.cjs'),row={marca:'fish',dia:'2026-10-12',carrinhos:3};
 const out=S.projectBrandCache({crm_diario:[{marca:'fish',dia:'2026-10-12',enviados:12}],crm_carrinho:[row]},'fish','growth','https://'+HOST);
 assert.equal(out.crm_diario[0].enviados,12);assert(!Object.hasOwn(out,'crm_carrinho'));assert.deepEqual(out.read_issues,[{section:'crm_carrinho',reason:'field_absent',field:'valor_em_jogo'}]);
 assert.throws(()=>S.projectBrandCache({crm_carrinho:[row]},'fish','growth','https://'+HOST),e=>e.code==='BRAND_READ_CONTRACT_NOT_READY');
 const html=fs.readFileSync(path.resolve(__dirname,'../growth.html'),'utf8');assert.match(html,/Array\.isArray\(API\.crm_carrinho\).*Dados de carrinho indisponíveis/);
});
test('native summary exposes optional issue codes and aggregate core counts only',async t=>{
 const f=await fixture(t),source={crm_diario:[{marca:'fish',dia:'2026-10-12',enviados:12}],crm_carrinho:[{marca:'fish',dia:'2026-10-12',carrinhos:3,customer_email:'private@synthetic.invalid'}]},reader=require(runtime+'/simple-dashboard-read.cjs').createReader({auth:f.auth,upstreams:f.upstreams,keys:f.keys,fetchImpl:async()=>new Response(JSON.stringify(source),{headers:{'content-type':'application/json'}}),projectGrowth:require(runtime+'/server.cjs').projectBrandCache});
 const result=await reader.summary(f.adminContext,['fish'],'https://'+HOST),crm=result.sources.find(x=>x.front==='growth');assert.equal(crm.status,200);assert.equal(crm.counts.crm_diario,1);assert(!Object.hasOwn(crm.counts,'read_issues'));assert(!Object.hasOwn(crm.counts,'crm_carrinho'));assert.deepEqual(crm.sourceIssues,[{section:'crm_carrinho',reason:'field_absent',field:'valor_em_jogo'}]);assert(!JSON.stringify(result).includes('private@'));assert(!Object.hasOwn(crm,'rows'));
});


test('store partners use only Afiliados permission and its private READ key; no Influencer delegation needed',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],ownPartners:true}),body={brand:'fish',ini:'2026-10-01',fim:'2026-10-12'};
 const r=await f.request('/api/affiliate-own-read',{method:'POST',body});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.candidates.length,1);assert.equal(r.body.candidates[0].name,'Synthetic affiliate');assert.equal(r.body.readOnly,true);assert(!Object.hasOwn(r.body,'roi'));
 assert.equal((await f.request('/api/affiliate-own-read',{method:'POST',body:{...body,brand:'aristo'}})).status,403);
 assert.equal((await f.request('/api/affiliate-own-read',{method:'POST',body,csrf:false})).status,403);
 assert.equal((await f.request('/api/affiliate-own-read',{method:'POST',body:{...body,action:'approve'}})).status,403);
 assert.equal((await f.request('/api/affiliate-own-read')).status,405);assert.equal(f.reads(),1);
});
test('Influs permission alone cannot read store affiliates',async t=>{const f=await fixture(t,{fronts:['influs'],brands:['fish'],ownPartners:true});assert.equal((await f.request('/api/affiliate-own-read',{method:'POST',body:{brand:'fish',ini:'2026-10-01',fim:'2026-10-12'}})).status,403);assert.equal(f.reads(),0);});
test('native confirmation counts real simple accounts and store affiliates without publishing identities',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],ownPartners:true}),reader=require(runtime+'/simple-dashboard-read.cjs').createReader({auth:f.auth,upstreams:f.upstreams,keys:f.keys,fetchImpl:f.fetchImpl,projectGrowth:require(runtime+'/server.cjs').projectBrandCache});
 const result=await reader.summary(f.adminContext,['fish','aristo'],'https://'+HOST),fish=result.sources.find(x=>x.front==='afiliados'&&x.brand==='fish'),aristo=result.sources.find(x=>x.front==='afiliados'&&x.brand==='aristo');
 assert.equal(result.sources.length,8);assert(result.sources.every(x=>x.status===200));assert.equal(fish.ownAffiliates.status,200);assert.deepEqual(fish.ownAffiliates.counts,{programs:1,candidates:1,links:1,partner_orders:0});assert.equal(fish.ownAffiliates.source,'crm_partner_pilot_original');
 assert(aristo.ownAffiliates.status>=400);assert.equal(aristo.ownAffiliates.counts,null);assert.equal(result.accountSummary.activeManagers,1);assert.deepEqual(result.accountSummary.byFront,{growth:0,organico:0,influs:0,afiliados:1});
 const text=JSON.stringify(result);for(const value of ['analista@','Synthetic affiliate','fixture-ref',f.created.user.id,...Object.values(f.keys)])assert(!text.includes(value));
});
test('simple Afiliados edit saves and rereads the same candidate, preserving fields and authorship metadata',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true}),body={action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()};
 const result=await f.request('/api/affiliate-own-edit',{method:'POST',body});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.readBackConfirmed,true);assert.equal(result.body.version,2);assert.equal(f.writes(),1);
 const read=await f.request('/api/affiliate-own-read',{method:'POST',body:{brand:'fish',ini:'2026-10-01',fim:'2026-10-12'}});assert.equal(read.body.candidates[0].state,'em_analise');assert.equal(read.body.candidates[0].version,2);assert.equal(read.body.editAvailable,true);assert.deepEqual(read.body.pendingEdits,[]);assert.equal(f.candidate.note,'synthetic note preserved');assert.equal(f.candidate.source_reference,'synthetic-reference');
 assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body})).status,409);assert.equal(f.writes(),1);assert(!JSON.stringify(result.body).includes('synthetic-private'));
});
test('READ permission, foreign brand, arbitrary fields and missing CSRF never reach Afiliados WRITE',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writer:true,ownPartners:true}),body={action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()};
 assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body})).status,403);
 assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body:{...body,brand:'aristo'}})).status,403);
 assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body:{...body,autor:'forged'}})).status,400);
 assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body,csrf:false})).status,403);assert.equal(f.writes(),0);assert.equal(f.reads(),0);
});
test('uncertain Afiliados result persists across reload, blocks a new POST and consults the same original receipt',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true,uncertainWrite:true}),body={action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()};
 const result=await f.request('/api/affiliate-own-edit',{method:'POST',body});assert.equal(result.status,202);assert.equal(result.body.state,'uncertain');assert.equal(f.writes(),1);
 const read=await f.request('/api/affiliate-own-read',{method:'POST',body:{brand:'fish',ini:'2026-10-01',fim:'2026-10-12'}});assert.equal(read.body.pendingEdits.length,1);assert.equal(read.body.pendingEdits[0].request_id,body.request_id);assert(!Object.hasOwn(read.body.pendingEdits[0],'binding'));assert(!Object.hasOwn(read.body.pendingEdits[0],'user_id'));
 assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body:{...body,request_id:crypto.randomUUID()}})).status,409);assert.equal(f.writes(),1);
 const confirmed=await f.request('/api/affiliate-own-operation?'+new URLSearchParams({brand:'fish',candidate_id:body.candidate_id,request_id:body.request_id}));assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));assert.equal(confirmed.body.state,'confirmed');assert.equal(confirmed.body.version,2);assert.equal(f.writes(),1);
});
test('different front cannot edit Afiliados even when sharing the Influs area',async t=>{
 const f=await fixture(t,{fronts:['influs','afiliados'],brands:['fish'],writeFronts:['influs'],writer:true,ownPartners:true});
 const r=await f.request('/api/affiliate-own-edit',{method:'POST',body:{action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()}});assert.equal(r.status,403);assert.equal(f.reads(),0);
});
test('an unlinked writer keeps legitimate own READ available and never performs a mutation',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],ownPartners:true});
 const read=await f.request('/api/affiliate-own-read',{method:'POST',body:{brand:'fish',ini:'2026-10-01',fim:'2026-10-12'}});assert.equal(read.status,200);assert.equal(read.body.editAvailable,false);
 const r=await f.request('/api/affiliate-own-edit',{method:'POST',body:{action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()}});assert.equal(r.status,503);assert.equal(f.writes(),0);
});
test('Afiliados permission revoked during the source read prevents the mutation',async t=>{
 const hooks={},f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true,hooks});
 hooks.afterRead=()=>{delete hooks.afterRead;f.auth.simpleAccounts.update({context:f.adminContext,userId:f.created.user.id,jobTitle:'analista',fronts:['afiliados'],writeFronts:[],brands:['fish'],active:true});};
 const r=await f.request('/api/affiliate-own-edit',{method:'POST',body:{action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()}});assert.equal(r.status,401);assert.equal(f.writes(),0);assert.equal(f.candidate.state,'novo');
});
test('revocation after source commit preserves its receipt without returning the revoked payload',async t=>{
 const hooks={},f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true,hooks}),request_id=crypto.randomUUID();
 hooks.afterCommit=()=>f.auth.simpleAccounts.update({context:f.adminContext,userId:f.created.user.id,jobTitle:'analista',fronts:['afiliados'],writeFronts:[],brands:['fish'],active:true});
 const r=await f.request('/api/affiliate-own-edit',{method:'POST',body:{action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id}});assert.equal(r.status,401);assert.equal(f.writes(),1);assert(!Object.hasOwn(r.body,'version'));
 const login=await f.auth.login({email:f.created.user.email,password:PASS,host:HOST,origin:'https://'+HOST});
 const read=await f.request('/api/affiliate-own-operation?'+new URLSearchParams({brand:'fish',candidate_id:f.candidate.id,request_id}),{cookie:login.cookie.split(';')[0]});assert.equal(read.status,200);assert.equal(read.body.state,'confirmed');assert.equal(f.writes(),1);
});
test('a receipt with a different candidate is uncertain and never authorizes another POST',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true,badWriteReceipt:true}),body={action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()};
 const r=await f.request('/api/affiliate-own-edit',{method:'POST',body});assert.equal(r.status,202);assert.equal(r.body.state,'uncertain');
 assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body:{...body,request_id:crypto.randomUUID()}})).status,409);assert.equal(f.writes(),1);
});
test('not_found from the original operation does not clear an uncertain attempt',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true,uncertainWrite:true}),body={action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()};
 await f.request('/api/affiliate-own-edit',{method:'POST',body});f.receipts.delete(body.request_id);
 const lookup=await f.request('/api/affiliate-own-operation?'+new URLSearchParams({brand:'fish',candidate_id:body.candidate_id,request_id:body.request_id}));assert.equal(lookup.status,202);assert.equal(lookup.body.originalReceiptFound,false);
 assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body:{...body,request_id:crypto.randomUUID()}})).status,409);assert.equal(f.writes(),1);
});
test('two concurrent receipt reads confirm the same attempt without writing twice',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true,uncertainWrite:true}),body={action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()};
 await f.request('/api/affiliate-own-edit',{method:'POST',body});const url='/api/affiliate-own-operation?'+new URLSearchParams({brand:'fish',candidate_id:body.candidate_id,request_id:body.request_id});
 const results=await Promise.all([f.request(url),f.request(url)]);for(const r of results){assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.state,'confirmed');}assert.equal(f.writes(),1);
});
test('READ permission retained after WRITE revocation can consult its own pending original receipt',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true,uncertainWrite:true}),body={action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()};await f.request('/api/affiliate-own-edit',{method:'POST',body});
 f.auth.simpleAccounts.update({context:f.adminContext,userId:f.created.user.id,jobTitle:'analista',fronts:['afiliados'],writeFronts:[],brands:['fish'],active:true});const login=await f.auth.login({email:f.created.user.email,password:PASS,host:HOST,origin:'https://'+HOST}),cookie=login.cookie.split(';')[0];
 const r=await f.request('/api/affiliate-own-operation?'+new URLSearchParams({brand:'fish',candidate_id:body.candidate_id,request_id:body.request_id}),{cookie});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.state,'confirmed');assert.equal(f.writes(),1);
});
test('changing the writer binding preserves uncertainty instead of rebuilding a consumed attempt',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true,uncertainWrite:true}),body={action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()};await f.request('/api/affiliate-own-edit',{method:'POST',body});
 const {createAffiliateEditor}=require(runtime+'/simple-dashboard-read.cjs'),editor=createAffiliateEditor({auth:f.auth,upstreams:f.upstreams,readKey:f.keys.afiliados,writeKey:'synthetic-rotated-private-key',otherReadKeys:Object.values(f.keys),fetchImpl:f.fetchImpl}),context={host:HOST,origin:'https://'+HOST,method:'GET',cookieHeader:f.analyst.cookie.split(';')[0]},query={brand:'fish',candidate_id:body.candidate_id,request_id:body.request_id};
 await assert.rejects(editor.operation(context,query),e=>e.code==='AFFILIATE_WRITE_BINDING_CHANGED');assert.equal(f.writes(),1);assert.equal(f.auth.simpleAccounts.affiliateEdit({context,requestId:body.request_id,brand:'fish',candidateId:body.candidate_id}).state,'uncertain');
});
test('WRITE accepts only the exact first action, IDs and version; stale and changed candidates are not sent',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true}),body={action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()};
 for(const delta of [{action:'approve'},{candidate_id:[f.candidate.id]},{request_id:'not-uuid'},{expected_version:'1'},{brand:'olivas'}])assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body:{...body,...delta}})).status,400);
 assert.equal((await f.request('/api/affiliate-own-edit?extra=1',{method:'POST',body})).status,405);assert.equal((await f.request('/api/affiliate-own-edit')).status,405);
 assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body:{...body,expected_version:2}})).status,409);f.candidate.state='pausado';
 assert.equal((await f.request('/api/affiliate-own-edit',{method:'POST',body:{...body,request_id:crypto.randomUUID()}})).status,409);assert.equal(f.writes(),0);
});
test('administrator can save and reopen separate WRITE fronts through HTTP',async t=>{
 const f=await fixture(t);const create={action:'create',email:'writer@synthetic.invalid',password:PASS,jobTitle:'analista de Afiliados',fronts:['influs','afiliados'],writeFronts:['afiliados'],brands:['fish']};
 const r=await f.request('/auth/simple/users',{method:'POST',body:create,asAdmin:true});assert.equal(r.status,201,JSON.stringify(r.body));assert.deepEqual(r.body.user.writeFronts,['afiliados']);
 const list=await f.request('/auth/simple/users',{asAdmin:true});assert.equal(list.status,200);assert.deepEqual(list.body.users.find(x=>x.id===r.body.user.id).writeFronts,['afiliados']);
 const updated=await f.request('/auth/simple/users',{method:'POST',asAdmin:true,body:{action:'update',userId:r.body.user.id,jobTitle:'analista de Afiliados',fronts:['afiliados'],writeFronts:[],brands:['fish'],active:true}});assert.equal(updated.status,200);assert.deepEqual(updated.body.user.writeFronts,[]);
});
test('a receipt confirmed while POST is finishing cannot regress to uncertain after a late timeout',async t=>{
 for(const uncertainWrite of [false,true]){
  const hooks={},f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true,uncertainWrite,hooks}),body={action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()};
  hooks.afterCommit=async()=>{const r=await f.request('/api/affiliate-own-operation?'+new URLSearchParams({brand:'fish',candidate_id:body.candidate_id,request_id:body.request_id}));assert.equal(r.status,200);assert.equal(r.body.state,'confirmed');};
  const r=await f.request('/api/affiliate-own-edit',{method:'POST',body});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.state,'confirmed');assert.equal(f.writes(),1);
  const read=await f.request('/api/affiliate-own-read',{method:'POST',body:{brand:'fish',ini:'2026-10-01',fim:'2026-10-12'}});assert.deepEqual(read.body.pendingEdits,[]);
 }
});
test('legacy names that the original SQL would normalize refuse before a state-only edit',async t=>{
 const f=await fixture(t,{fronts:['afiliados'],brands:['fish'],writeFronts:['afiliados'],writer:true,ownPartners:true});f.candidate.name=' Synthetic affiliate ';
 const r=await f.request('/api/affiliate-own-edit',{method:'POST',body:{action:'review',brand:'fish',candidate_id:f.candidate.id,expected_version:1,request_id:crypto.randomUUID()}});assert.equal(r.status,503);assert.equal(f.writes(),0);assert.equal(f.candidate.name,' Synthetic affiliate ');assert.equal(f.candidate.state,'novo');
});
