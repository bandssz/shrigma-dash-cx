'use strict';
/* Frente 3 — leitura de templates por marca pela TELA real do CRM.
   Página: growth.html + bundle publicado assets/panels/growth.js num DOM local.
   Servidor: createServer real do portal (auth SQLite descartável do fixture
   crm-managed-read-auth-fixture, gestor convidado → aceito → prepare/commit),
   com DASHBOARD_CRM_MANAGED_TEMPLATE_READ ligado. Origem crm-read: cache
   sintético. Origem template-read: store #222 (services/crm-template-read/store.cjs)
   sobre PGlite com o SQL proposto, chamado sem socket (mesma fiação do teste do
   Codex dashboard-operational-managed-template-read). proxy.cjs não é alterado.
   Nenhuma rede: http/https/net/tls/fetch globais negados. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events'),{webcrypto}=require('node:crypto');
const denied=()=>{throw Error('TEST_REAL_NETWORK_DENIED');};
for(const name of ['node:http','node:https']){const m=require(name);m.request=denied;m.get=denied;}
const net=require('node:net');net.connect=denied;net.createConnection=denied;net.Server.prototype.listen=denied;
require('node:tls').connect=denied;globalThis.fetch=denied;
const {parseHTML}=require('linkedom');
const ROOT=path.join(__dirname,'..');
const {fixture}=require('./helpers/crm-managed-read-auth-fixture.cjs');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs');
const B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs'),T=require('../services/dashboard-operational/crm-template-read-bridge.cjs');
const X=require('./claude-template-read-fixture.cjs'),Store=require('../services/crm-template-read/store.cjs');
const templateHost=new URL(T.DESTINATIONS['template-read']).hostname;
const manifest={schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns,campaigns_media:B.DESTINATIONS.campaigns_media}};
const settings=(f,extra={})=>({...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedTemplateRead:true,upstreams:Object.fromEntries(Object.entries(B.DESTINATIONS).map(([k,v])=>[k,new URL(v)])),allowedUpstreamHosts:[...new Set(Object.values(B.DESTINATIONS).map(v=>new URL(v).hostname)),templateHost],dynamicRouteManifest:manifest,publicDir:__dirname,...extra});
const NOW=Date.parse('2026-10-04T12:10:00Z');
const OPERACAO=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));

/* ---------- servidor real + store #222 sobre PGlite ---------- */
let pg;
async function database(){
 if(!pg){const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();await X.install(db);pg={db,store:null,statements:[]};
  const transaction=Store.createReadTransaction({pool:{connect:async()=>({async query(q,v){const sql=typeof q==='string'?q:q.text,args=typeof q==='string'?v:q.values;pg.statements.push(sql);const r=await db.query(sql,args||[]);if(/^BEGIN /.test(sql))await db.query('SET LOCAL ROLE crm_template_reader');return r;},release(){}})}});
  pg.transaction=transaction;pg.store=Store.createTemplateReadStore({transaction});}
 return pg;
}
test.after(async()=>{if(pg)await pg.db.close();});
const cachePayload=capabilities=>({_escopo:'growth',_painel:'growth',gerado_em:new Date(NOW).toISOString(),_cache_gerado_em:new Date(NOW).toISOString(),
 crm_diario:[],crm_campanha:[],crm_fluxo:[],crm_conversao:[],crm_operacao:OPERACAO,...(capabilities===undefined?{}:{capabilities})});
// Gestor real: convite do master, aceite, login, prepare/commit da credencial individual.
async function manager(t,brand,{commit=true,capabilities}={}){
 const f=await fixture();t.after(()=>f.close());
 const email=brand+'-manager@synthetic.invalid',i=f.invite(email,'growth',brand);await f.accept(i);const login=await f.login(email),ctx=f.reader(login);
 if(commit){const op=f.queued(login.user.id),c=f.client(),p=await f.prepare(c,op);await f.commit(c,op,p.prepared);
  const proof=f.auth.managedCrmReadAuthorization(ctx),credential=f.auth.getUpstreamCredential(ctx),{db}=await database();
  await db.query("INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,'growth',$2,$3) ON CONFLICT DO NOTHING",[proof.principalId,proof.owner,X.sha(credential)]);
  await db.query("INSERT INTO public.shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb)",[proof.principalId,JSON.stringify(T.CAPS)]);}
 const state={cache:cachePayload(capabilities),templateCalls:[],hold:null,templateFault:null};
 const fetchImpl=async(url,init)=>{const u=new URL(String(url));
  if(u.origin+u.pathname===T.DESTINATIONS['template-read']){state.templateCalls.push(u.search);
   if(state.hold){const h=state.hold;state.hold=null;await h;}
   if(state.templateFault)return state.templateFault();
   const {store}=await database(),r=await store.handle({authorization:init.headers.Authorization,pairs:[...u.searchParams]});await r.settled;
   return new Response(r.text??JSON.stringify(r.body),{status:r.status,headers:{'content-type':'application/json; charset=utf-8'}});}
  if(u.origin+u.pathname===B.DESTINATIONS['crm-read'])return new Response(JSON.stringify(state.cache),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});
  return new Response(JSON.stringify({error:'UNEXPECTED_UPSTREAM'}),{status:599});};
 const app=S.createServer(settings(f),{auth:f.auth,fetchImpl,managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});t.after(()=>app.removeAllListeners());assert.equal(app.listening,false);
 return {f,ctx,login,app,state,brand};
}
function request(app,ctx,url){return new Promise(resolve=>{
 const req=Readable.from([]);Object.assign(req,{url,method:'GET',headers:{host:ctx.host,cookie:ctx.cookieHeader},socket:{remoteAddress:'127.0.0.1'}});
 const res=new EventEmitter();res.setHeader=()=>{};res.end=bytes=>{res.writableEnded=true;res.emit('finish');resolve({status:res.statusCode,text:String(bytes)});};
 res.destroy=()=>{res.destroyed=true;resolve({status:500,text:'{"error":"TEST_DESTROYED"}'});};app.emit('request',req,res);
});}

/* ---------- página real ---------- */
const BUNDLE=fs.readFileSync(path.join(ROOT,'assets/panels/growth.js'),'utf8'),HTML=fs.readFileSync(path.join(ROOT,'growth.html'),'utf8');
async function page(m,{canal='todos'}={}){
 const {document,window}=parseHTML(HTML),requests=[];
 const selectProto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 Object.defineProperty(dialogProto,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){this.toggleAttribute('open',!!v);}});
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};window.HTMLElement.prototype.getBoundingClientRect=()=>({top:0,width:1200,height:100});
 Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
 const NativeDate=Date;class FixedDate extends NativeDate{constructor(...a){super(...(a.length?a:[NOW]));}static now(){return NOW;}}
 const store=new Map(),storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
 const realm=text=>{context.__t=text;try{return vm.runInContext('JSON.parse(__t)',context);}finally{delete context.__t;}};
 const context=vm.createContext({document,window,URL,URLSearchParams,Date:FixedDate,Intl,AbortSignal,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,
  navigator:{locks:{request:async(_n,o,fn)=>(typeof o==='function'?o:fn)({})}},console,localStorage:storage,sessionStorage:storage,
  location:{hash:`#marca=${m.brand}&sec=templates&canal=${canal}`,search:''},history:{replaceState(){}},addEventListener(){},setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,queueMicrotask,
  Image:class{},Blob:class{},prompt:()=>null,confirm:()=>false,
  // O navegador fala só com o portal: crm-read reescrito para /api/crm-read e os templates no endpoint anunciado pelo BFF.
  fetch:async(url,init={})=>{const u=new URL(url);let pathname;
   if(u.hostname==='comunicacao-crm-panel-read.tazdb8.easypanel.host')pathname='/api/crm-read'+u.search;
   else if(u.origin==='https://'+m.ctx.host&&u.pathname==='/api/templates')pathname=u.pathname+u.search;
   else{requests.push({url:String(url),blocked:true});throw new TypeError('blocked '+u.origin);}
   requests.push({url:String(url),path:pathname});if(m.state.offline&&pathname.startsWith('/api/templates'))throw new TypeError('synthetic offline');const r=await request(m.app,m.ctx,pathname);
   return {status:r.status,ok:r.status>=200&&r.status<300,json:async()=>realm(r.text)};}});
 vm.runInContext(BUNDLE,context,{filename:'published-growth.js'});
 vm.runInContext("shrigmaGuardaChave('growth','ui-portal-session-marker');",context);
 for(const script of document.querySelectorAll('script:not([src])'))vm.runInContext(script.textContent,context,{filename:'growth-inline.js'});
 const x={document,window,requests,run:c=>vm.runInContext(c,context),q:s=>document.querySelector(s),qa:s=>[...document.querySelectorAll(s)],
  text:()=>document.querySelector('#control-templates').textContent.replace(/\s+/g,' ')};
 await settled(x);x.q('#control-tab-templates').click();await settled(x);return x;
}
async function settled(x){for(let i=0;i<400;i++){if(!x.run('LOADING||!!GC.carregando'))return;await new Promise(r=>setTimeout(r,2));}assert.fail('tela não estabilizou');}
const templateCalls=x=>x.requests.filter(r=>r.path?.startsWith('/api/templates'));
async function canal(x,value){x.q(`#seg-canal [data-canal="${value}"]`).click();await settled(x);}

const PAGE_ORIGIN='https://crm.synthetic.invalid';
const library=x=>x.q('.control-brand-email');
const rowNames=x=>x.qa('#control-brand-email-table tbody tr').map(r=>r.getAttribute('data-brand-email'));
async function load(x){x.q('#control-tpl-email-load').click();await settled(x);}
const EXPECTED={fish:{keys:['email.template.1','email.template.6','email.template.8'],own:['Boas-vindas Fishermans','Layout Fishermans'],foreign:['Newsletter Aristocrata','Campanha Aristocrata','NPS Olivas','Legado sem registro','__shrigma_journey'],draft:'d_fish_1',events:3},
 aristo:{keys:['email.template.2','email.template.9'],own:['Newsletter Aristocrata','Campanha Aristocrata'],foreign:['Boas-vindas Fishermans','Layout Fishermans','Fishermans grande','NPS Olivas','Legado sem registro'],draft:'d_aristo_1'}};
const writable=x=>x.qa('input[type=file],button').filter(b=>!b.disabled&&!b.closest('[hidden]')&&/^(Publicar|Enviar|Submeter|Salvar no servidor|Agendar|Enviar imagem|Editar campanhas)/.test(b.textContent.trim()));

for(const brand of ['fish','aristo'])test(brand+': gestor pronto abre Inventário → carrega a lista da própria marca, prévia, histórico; teclado e nenhum controle de escrita',async t=>{
 const m=await manager(t,brand,{capabilities:{templates:{read_content:true,list_history:true},endpoints:{templates:'https://legacy.example.invalid/t'}}}),{db}=await database(),before=await X.snapshot(db);
 const x=await page(m),exp=EXPECTED[brand];
 assert.equal(x.run('GC.caps.leitura_marca'),true);assert.equal(x.run('GC.caps.endpoint'),PAGE_ORIGIN+'/api/templates');
 for(const flag of ['draft','validate','submit'])assert.equal(x.run(`GC.caps.pode.${flag}`),false,flag);
 // A biblioteca aparece nos dois recortes que incluem e-mail; o botão antigo da barra de WhatsApp não promete o que não cobre.
 assert.ok(library(x),'biblioteca visível em Todos os canais');assert.equal(x.q('#control-tpl-conteudo'),null);
 assert.match(library(x).textContent,new RegExp('Templates de e-mail registrados · '+(brand==='fish'?'Fishermans':'O Aristocrata')));
 assert.match(x.q('#control-brand-email-status').textContent,/Nada carregado ainda/);assert.equal(templateCalls(x).length,0,'abrir a tela não consulta');
 await canal(x,'whatsapp');assert.equal(library(x),null,'WhatsApp não é coberto pelo contrato');await canal(x,'email');assert.ok(library(x));
 await load(x);
 assert.deepEqual(templateCalls(x).map(r=>r.path),[`/api/templates?acao=listar&marca=${brand}&canal=email&offset=0&limit=20`]);
 assert.deepEqual(rowNames(x),exp.keys);
 const text=library(x).textContent;for(const name of exp.own)assert.match(text,new RegExp(name));for(const name of exp.foreign)assert.doesNotMatch(text,new RegExp(name),'nada de outra marca/sem registro: '+name);
 assert.match(x.q('#control-brand-email-status').textContent,new RegExp(`^${exp.keys.length} templates de e-mail registrados de ${brand==='fish'?'Fishermans':'O Aristocrata'} · consultado em `));
 assert.equal(x.document.activeElement,x.q('#control-tpl-email-load'),'foco volta ao botão usado');
 if(brand==='fish'){const big=x.q('[data-brand-email="email.template.6"]');assert.match(big.textContent,/Conteúdo indisponível nesta consulta .*Nada foi cortado/);assert.equal(big.querySelector('[data-tpl-preview-email]'),null);}
 // Prévia do HTML publicado (conteúdo do próprio template, sem nova consulta).
 const preview=x.q(`[data-brand-email="${exp.keys[0]}"] [data-tpl-preview-email]`);assert.ok(preview);const calls=templateCalls(x).length;preview.click();await settled(x);
 assert.equal(templateCalls(x).length,calls);assert.ok(x.q('dialog[open]'),'prévia aberta');x.q('dialog[open]').close();
 // Histórico do rascunho: marca do cabeçalho + draft_id; foco no histórico carregado.
 const h=x.q(`[data-tpl-historico-draft="${exp.draft}"]`);assert.ok(h);h.click();await settled(x);
 assert.equal(templateCalls(x).at(-1).path,`/api/templates?acao=historico&marca=${brand}&draft_id=${exp.draft}`);
 const list=x.q(`[data-hist-draft="${exp.draft}"]`);assert.ok(list);assert.equal(x.document.activeElement,list);assert.ok(list.querySelectorAll('li').length>=1);assert.doesNotMatch(list.textContent,/Nenhum evento/);
 // Somente leitura: nenhum POST, nenhuma origem fora do portal, nenhum controle de escrita habilitado; banco sem efeito.
 assert.ok(x.requests.every(r=>r.path&&!r.blocked));assert.deepEqual(writable(x).map(b=>b.textContent.trim()),[]);
 assert.deepEqual(await X.snapshot(db),before);
});

test('marca muda com a leitura em curso: a resposta atrasada é descartada; outra marca é recusada pelo servidor e nada aparece',async t=>{
 const m=await manager(t,'fish'),x=await page(m,{canal:'email'});let release;m.state.hold=new Promise(r=>release=r);
 x.q('#control-tpl-email-load').click();await new Promise(r=>setTimeout(r,20));assert.match(x.q('#control-tpl-email-load').textContent,/Carregando/);assert.equal(x.q('#control-tpl-email-load').disabled,true);
 x.q('[data-marca="todas"]').click();if(x.q('#brand-change-confirm')?.open)x.q('#brand-change-accept').click();await new Promise(r=>setTimeout(r,20));
 release();await settled(x);for(let i=0;i<20;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(x.run('MARCA'),'todas');assert.equal(x.run('GC.conteudo'),null,'resposta de fish não é aplicada em Todas');assert.equal(rowNames(x).length,0);
 assert.match(library(x).textContent,/Escolha Fishermans ou O Aristocrata .*Nada foi consultado/);assert.equal(x.q('#control-tpl-email-load'),null);
 // Volta a fish: nada da leitura abandonada reaparece; precisa carregar de novo.
 x.q('[data-marca="fish"]').click();if(x.q('#brand-change-confirm')?.open)x.q('#brand-change-accept').click();await settled(x);
 assert.equal(rowNames(x).length,0);await load(x);assert.deepEqual(rowNames(x),EXPECTED.fish.keys);
 // Conteúdo carregado de fish some ao trocar de marca (não fica rotulado como da marca nova).
 x.q('[data-marca="aristo"]').click();if(x.q('#brand-change-confirm')?.open)x.q('#brand-change-accept').click();await settled(x);
 assert.equal(rowNames(x).length,0);assert.doesNotMatch(library(x).textContent,/Boas-vindas Fishermans|consultado em/);
 // Gestor de fish pedindo aristo (a página standalone ainda mostra o botão; o portal o remove): o servidor recusa e a tela não exibe nada.
 await load(x);assert.equal(templateCalls(x).at(-1).path,'/api/templates?acao=listar&marca=aristo&canal=email&offset=0&limit=20');
 assert.equal(rowNames(x).length,0);assert.match(library(x).querySelector('[role=alert]').textContent,/Seu acesso não inclui esta leitura de templates\. Nada foi exibido/);
 assert.equal(m.state.templateCalls.filter(q=>/brand=aristo/.test(q)).length,0,'nenhum pedido de aristo chega ao listener');
});

test('vazio, indisponível, rede e acesso revogado: mensagens distintas; indisponível nunca vira "nenhum template"',async t=>{
 const m=await manager(t,'aristo'),x=await page(m,{canal:'email'});
 m.state.templateFault=()=>new Response(JSON.stringify({contract:'crm-template-read-v1',brand:'aristo',channel:'email',templates:[],offset:0,limit:20,total:0,next_offset:null,coverage:'registered_email_only',consultado_em:'2026-10-04T12:00:00Z',schedule_proof:false}),{status:200,headers:{'content-type':'application/json; charset=utf-8'}});
 await load(x);assert.match(library(x).textContent,/Nenhum template de e-mail registrado para O Aristocrata\./);assert.match(x.q('#control-brand-email-status').textContent,/^0 templates de e-mail registrados de O Aristocrata/);
 m.state.templateFault=()=>new Response(JSON.stringify({error:'TEMPLATE_READ_UNAVAILABLE'}),{status:503,headers:{'content-type':'application/json; charset=utf-8'}});
 const fresh=await page(m,{canal:'email'});await load(fresh);
 const alert=fresh.q('.control-brand-email [role=alert]');assert.match(alert.textContent,/indisponível agora\. Isso não significa que a marca não tenha templates/);
 assert.doesNotMatch(library(fresh).textContent,/Nenhum template de e-mail registrado/);assert.equal(rowNames(fresh).length,0);assert.equal(fresh.document.activeElement,fresh.q('#control-tpl-email-load'));
 // Rede: o navegador não recebe resposta.
 m.state.templateFault=null;m.state.offline=true;const net=await page(m,{canal:'email'});await load(net);
 assert.match(net.q('.control-brand-email [role=alert]').textContent,/falha de rede\)\. Nada foi alterado/);assert.equal(rowNames(net).length,0);m.state.offline=false;
 // Revogação pelo master: a sessão cai; a leitura seguinte não mostra nada e orienta a entrar de novo.
 const ok=await page(m,{canal:'email'});m.f.auth.revokeUser({context:m.f.context,userId:m.login.user.id});await load(ok);
 assert.equal(rowNames(ok).length,0);assert.match(ok.q('.control-brand-email [role=alert]').textContent,/Entre novamente para consultar|Seu acesso não inclui/);
});

test('compatibilidade lista/objeto (P2): com a leitura ligada, cache em objeto, lista, ausente ou forjado dá a mesma tela; desligada, nenhuma forma promove leitura',async t=>{
 const shapes={objeto:{templates:{read_content:true,list_history:true},endpoints:{templates:'https://legacy.example.invalid/t'}},lista:['read','list','read_content','draft','submit'],ausente:undefined,nulo:null,
  forjado:{templates:{read_content:true,list_history:true,draft:true,submit:true,submit_email:true,read_contract:'crm-template-read-v1'},endpoints:{templates:'https://global.invalid/templates'}}};
 const seen={};
 for(const [name,capabilities] of Object.entries(shapes)){
  const m=await manager(t,'fish',{capabilities}),x=await page(m,{canal:'email'});
  seen[name]=JSON.stringify(x.run('GC.caps'));assert.ok(library(x),name+': biblioteca');await load(x);assert.deepEqual(rowNames(x),EXPECTED.fish.keys,name);
 }
 assert.equal(new Set(Object.values(seen)).size,1,'a forma do cache não muda o que a tela recebe: '+JSON.stringify(seen));
 for(const [name,capabilities] of Object.entries(shapes)){
  const m=await manager(t,'fish',{capabilities});const app=S.createServer(settings(m.f,{crmManagedTemplateRead:false}),{auth:m.f.auth,fetchImpl:async(url)=>{assert.ok(!String(url).startsWith(T.DESTINATIONS['template-read']),'OFF não consulta o listener');return new Response(JSON.stringify(m.state.cache),{status:200,headers:{'content-type':'application/json'}});},managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});t.after(()=>app.removeAllListeners());
  const x=await page({...m,app},{canal:'todos'});
  assert.equal(x.run('GC.caps.leitura_marca'),false,name);assert.equal(x.run('GC.caps.pode.read_content'),false,name);assert.equal(library(x),null,name);assert.equal(x.q('#control-tpl-conteudo'),null,name);assert.equal(templateCalls(x).length,0,name);
  assert.deepEqual(writable(x).map(b=>b.textContent.trim()),[],name);
 }
});

test('gestor ainda não pronto (convite aceito, credencial não confirmada): nenhuma leitura de templates é anunciada nem feita',async t=>{
 const m=await manager(t,'fish',{commit:false,capabilities:{templates:{read_content:true,list_history:true,read_contract:'crm-template-read-v1'},endpoints:{templates:PAGE_ORIGIN+'/api/templates'}}});
 const x=await page(m,{canal:'email'});
 assert.equal(library(x),null);assert.equal(x.q('#control-tpl-conteudo'),null);assert.equal(templateCalls(x).length,0);assert.equal(m.state.templateCalls.length,0);
 const cache=x.requests.find(r=>r.path?.startsWith('/api/crm-read?action=cache_growth'));assert.ok(cache);
 t.diagnostic('não pronto: '+x.q('#atualizado-em').textContent+' · caps '+JSON.stringify(x.run('typeof GC.caps==="object"&&GC.caps?{leitura_marca:GC.caps.leitura_marca,endpoint:GC.caps.endpoint}:null')));
});

/* Achado P3 para o Codex (proxy.cjs L343–344, não alterado aqui): com só a leitura de PÚBLICOS ligada
   (DASHBOARD_CRM_MANAGED_AUDIENCE_READ), um cache cujo `capabilities` vem em lista ou ausente sai pelo retorno
   antecipado e o gestor pronto perde segments/campaign_audience; com a leitura de TEMPLATES ligada a forma não
   importa. O produtor real (cache_growth, CASE … ::json para growth/todos) devolve objeto, então hoje não há
   impacto de uso. Fica como `todo` até a correção na camada do Codex. */
test('achado P3: leitura de públicos ligada sozinha depende da forma de capabilities no cache',{todo:'proxy.cjs L343–344: isentar também managedAudienceRead no crm-read'},async t=>{
 const AudienceRead=require('../services/dashboard-operational/crm-audience-read-bridge.cjs');
 const m=await manager(t,'fish',{commit:true}),seen={};
 const app=S.createServer(settings(m.f,{crmManagedTemplateRead:false,crmManagedAudienceRead:true,allowedUpstreamHosts:[...new Set([...Object.values(B.DESTINATIONS),AudienceRead.DESTINATIONS['audience-read']].map(v=>new URL(v).hostname))]}),{auth:m.f.auth,fetchImpl:async()=>new Response(JSON.stringify(m.state.cache),{status:200,headers:{'content-type':'application/json'}}),managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});t.after(()=>app.removeAllListeners());
 for(const [name,capabilities] of [['objeto',{}],['lista',['read']],['ausente',undefined]]){
  m.state.cache=cachePayload(capabilities);const r=await request(app,m.ctx,'/api/crm-read?action=cache_growth&painel=growth');assert.equal(r.status,200);
  seen[name]=JSON.parse(r.text).capabilities?.segments?.read===true;
 }
 assert.deepEqual(seen,{objeto:true,lista:true,ausente:true});
});
