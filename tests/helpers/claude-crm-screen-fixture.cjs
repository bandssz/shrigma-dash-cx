'use strict';
// Harness compartilhado do percurso de campanhas pela tela (extraído sem mudança de
// comportamento de tests/claude-crm-list-schedule-path.test.cjs, PR #223):
// growth.html + bundle publicado (assets/panels/growth.js) + script inline, login
// individual de gestor (identidade sintética, sem chave mestre) → editor real (GCE)
// → cliente real (GCA) → HTTP real do serviço crm-campaign (createServer/createExecutor)
// em 127.0.0.1 → gateway SQL real (crm_campaign_api) + store/provider/recovery/write-guard
// e vínculo de público reais em PGlite descartável. O único adaptador fictício é o
// "nativo" (prévia/criação Listmonk), que só registra intenções. Sem Listmonk, n8n,
// worker, navegador real, PostgreSQL real ou rede externa. Dados e chaves fictícios.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const {webcrypto,createHash}=require('node:crypto'),{parseHTML}=require('linkedom');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const F=require('../segment-campaign-binding-fixture.cjs'),BindingAPI=require('../../n8n/growth/segment-campaign-binding-api.cjs');
const {createServer,PATH}=require('../../services/crm-campaign/server.cjs'),{createExecutor,EFFECT_SQL}=require('../../services/crm-campaign/transport.cjs');
const root=path.resolve(__dirname,'../..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const KEY='synthetic-manager-key',CAPS=['read_content','draft','validate','submit'];
const endpoints={campaigns:'https://campaign.test/api',segments:'https://audience.test/api',campaign_audience:'https://binding.test/api'};
const capabilities=()=>({endpoints,
 campaigns:{contract_version:'crm-campaign-v1',brands:['fish','aristo'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:'listmonk-6.1-regular-v1'},
 segments:{contract_version:'crm-audience-v2',brands:['fish','aristo'],read:true,save:true,count:true,operation:true},
 campaign_audience:{contract_version:'crm-audience-campaign-binding-v1',brands:['fish','aristo'],read:true,inspect:true,bind:true,release:true,operation:true}});
const CAMPAIGN={fish:100,aristo:200};

// Banco descartável: fixture do vínculo (listas, públicos, campanhas 100/200 só com listas)
// + recuperação + gateway restrito do crm-campaign, exatamente os arquivos versionados.
async function backend(t,{standardize=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 const f=await F.setup(db,{countProvider:require('../../n8n/growth/segment-audience-listmonk.cjs').countAudience});
 const op=read('n8n/access/panel-operator.sql'),a=op.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_crm_operator_auth_v1'),b=op.indexOf('REVOKE ALL ON FUNCTION public.shrigma_crm_operator_auth_v1(text) FROM PUBLIC;');
 await db.exec(op.slice(a,b)+'REVOKE ALL ON FUNCTION public.shrigma_crm_operator_auth_v1(text) FROM PUBLIC;');
 await db.exec(read('n8n/growth/campaign-recovery.sql'));await db.exec(read('n8n/growth/crm-campaign-gateway-role.sql'));
 // Gestor individual fictício com as capacidades de campanha (sem chave mestre).
 await db.query("UPDATE shrigma_panel_permission_v1 SET caps=$1::jsonb WHERE principal_id='manager'",[JSON.stringify(CAPS)]);
 // Rascunhos de listas com conteúdo válido (link comercial da marca e descadastro), sem tocar gatilhos.
 for(const id of [100,200])await db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(id)]);const shop=id===100?'https://fishermans.com.br/products/linha-sintetica':'https://oaristocrata.com/products/sabonete-sintetico';
  await tx.query("UPDATE campaigns SET body=body||$2||' {{ UnsubscribeURL }}',altbody=altbody||' '||$3||' {{ UnsubscribeURL }}' WHERE id=$1",[id,'<a href="'+shop+'">Ver produto</a>',shop]);});
 // Pool do serviço: cada consulta numa transação com o papel restrito crm_campaign_api.
 const effects=[],pool={query:async(sql,params)=>{if(sql===EFFECT_SQL){const d=JSON.parse(params[2]);effects.push({kind:d.kind,action:d.action});}
  return db.transaction(async tx=>{await tx.query('SET LOCAL ROLE crm_campaign_api');return tx.query(sql,params);});}};
 // Adaptador nativo fictício: registra intenções; agenda nunca passa por aqui.
 const intents=[];const native=async effect=>{intents.push(effect.kind);if(effect.kind==='preview')return {status:200,body:'<p>prévia sintética</p>'};throw Error('UNEXPECTED_NATIVE_'+effect.kind);};
 const app=createServer({pool,native,executor:createExecutor({pool,native}),revision:'a'.repeat(40),enabled:true});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.stop());
 const bindingAPI=BindingAPI.createCampaignBindingAPI({store:f.bindingService||f.service});
 // Estado inicial: o rascunho de listas já foi salvo pelo cadastro padronizado (mesmo serviço
 // HTTP, chave do gestor fictício). Isso é preparação do fixture, não parte do percurso medido.
 const call=(method,query,body)=>new Promise((resolve,reject)=>{const bytes=body?Buffer.from(JSON.stringify({k:KEY,...body})):null,req=http.request({host:'127.0.0.1',port:app.server.address().port,path:PATH+(query||''),method,headers:bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{Authorization:'Bearer '+KEY}},res=>{const c=[];res.on('data',d=>c.push(d));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(c).toString('utf8'))}));});req.on('error',reject);if(bytes)req.write(bytes);req.end();});
 if(standardize)for(const [brand,id]of Object.entries(CAMPAIGN)){
  const current=(await call('GET',`?acao=campanha_obter&brand=${brand}&id=${id}`)).body.campaign;
  const saved=await call('POST','',{acao:'campanha_salvar',brand,id,expected_version:current.version,idempotency_key:'fixture-save-'+brand+'-000001',definition:{...current.definition,name:'Rascunho por listas '+brand,send_at:new Date(Date.now()+2*86400000).toISOString()}});
  assert.equal(saved.status,200,JSON.stringify(saved.body));
 }
 effects.length=0;intents.length=0;
 const row=async id=>(await db.query('SELECT status,sent,started_at FROM campaigns WHERE id=$1',[id])).rows[0];
 const operations=async()=>(await db.query("SELECT action,state,brand FROM shrigma_campaign_operation ORDER BY created_at")).rows;
 return {db,f,app,effects,intents,bindingAPI,row,operations,call};
}

// Página real. Rede: identidade/cache sintéticos; campanhas → HTTP real do serviço em
// loopback; públicos/vínculo → APIs reais do fixture. Qualquer outro destino falha.
async function page(be,brand,{store=new Map(),loseAck=null,beforeCampaign=null,caps=CAPS}={}){
 const html=read('growth.html'),{document,window}=parseHTML(html);
 const selectProto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));
 dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 Object.defineProperty(dialogProto,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){this.toggleAttribute('open',!!v);}});
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
 window.HTMLElement.prototype.getBoundingClientRect=()=>({top:0,width:1200,height:100});
 Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
 const calls=[],payload={_escopo:'growth',_painel:'growth',gerado_em:new Date().toISOString(),capabilities:capabilities(),
  ...Object.fromEntries(['crm_campanha','crm_fluxo','crm_conversao','crm_campanha_receita','crm_campanha_grupo','crm_diario','crm_intradia','crm_carrinho','crm_galho','crm_regra_galho','crm_teste','crm_teste_braco','crm_credencial','wa_saude'].map(k=>[k,[]])),
  crm_base:['fish','aristo'].map(marca=>({marca,dia:new Date().toISOString().slice(0,10),coletado_em:new Date().toISOString(),total:3,segmentos:{}}))};
 let context;
 const realm=v=>{context.__encoded=JSON.stringify(v);try{return vm.runInContext('JSON.parse(__encoded)',context);}finally{delete context.__encoded;}};
 const reply=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>realm(body),text:async()=>JSON.stringify(body)});
 const fetchImpl=async(url,init={})=>{
  const u=new URL(url),method=init.method||'GET';
  if(u.origin==='https://campaign.test'){
   const body=method==='POST'?JSON.parse(init.body):null,acao=body?body.acao:u.searchParams.get('acao');const entry={to:'campaign',method,acao,idempotency_key:body?.idempotency_key||u.searchParams.get('idempotency_key')};calls.push(entry);
   // Gancho de teste: outra sessão age entre o clique e a chegada do pedido ao serviço.
   if(beforeCampaign)await beforeCampaign(acao,method);
   const headers={};for(const [k,v]of Object.entries(init.headers||{}))if(/^(authorization|content-type)$/i.test(k))headers[k]=v;
   const r=await new Promise((resolve,reject)=>{const bytes=body?Buffer.from(init.body):null,req=http.request({host:'127.0.0.1',port:be.app.server.address().port,path:PATH+u.search,method,headers:bytes?{...headers,'Content-Length':bytes.length}:headers},res=>{const c=[];res.on('data',d=>c.push(d));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(c).toString('utf8')}));});req.on('error',reject);if(bytes)req.write(bytes);req.end();});
   // ACK perdido: o serviço já respondeu e gravou; o navegador não recebe a resposta.
   entry.status=r.status;
   if(loseAck&&loseAck(acao,r)){entry.lost=true;throw Error('synthetic lost ACK');}
   return reply(r.status,JSON.parse(r.text));
  }
  const request=method==='POST'?JSON.parse(init.body):Object.fromEntries(u.searchParams);
  if(u.origin==='https://audience.test'||u.origin==='https://binding.test'){
   calls.push({to:u.hostname.split('.')[0],method,acao:request.acao});
   const input={method,request:{headers:{...init.headers},[method==='POST'?'body':'query']:request}};
   const r=await (u.origin==='https://audience.test'?be.f.api:be.bindingAPI).handle(input);return reply(r.status,r.body);
  }
  if(u.searchParams.get('action')==='identity')return reply(200,{schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',allowedPanels:['growth'],permissions:{growth:{who:'panel:manager',label:'Gestor fictício',caps}}});
  if(u.searchParams.get('action')==='cache_growth'){calls.push({to:'cache',method});return reply(200,{...payload,_cache_gerado_em:new Date().toISOString()});}
  throw Error('UNEXPECTED_DESTINATION '+u.origin+u.pathname);
 };
 context=vm.createContext({document,window,URL,URLSearchParams,Date,Intl,AbortSignal,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,console,
  navigator:{locks:require('../campaign-lock-fixture.cjs')()},localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},
  location:{hash:'#marca='+brand+'&sec=camp',search:''},history:{replaceState(){}},addEventListener(){},setInterval(){return 1;},clearInterval(){},setTimeout,clearTimeout,queueMicrotask,
  Image:class{},Blob:class{},prompt:()=>null,confirm:()=>false,fetch:fetchImpl});
 const run=code=>vm.runInContext(code,context);
 vm.runInContext(read('assets/panels/growth.js'),context,{filename:'assets/panels/growth.js'});
 for(const s of document.querySelectorAll('script:not([src])'))vm.runInContext(s.textContent,context,{filename:'growth-inline.js'});
 document.querySelector('#growth-chave').value=KEY;await document.querySelector('#growth-acesso').onsubmit({preventDefault(){}});
 const x={document,window,run,calls,store,q:s=>document.querySelector(s),qa:s=>[...document.querySelectorAll(s)]};
 await until(()=>!!x.q('[data-ce-refresh]')&&!x.run('LOADING'),x,'tela de campanhas');
 return x;
}
async function until(check,x,label){for(let i=0;i<2500;i++){let ok=false;try{ok=check();}catch{}if(ok)return;await new Promise(r=>setTimeout(r,2));}
 assert.fail('Tela não estabilizou: '+label+' '+JSON.stringify({status:x?.q('[data-ce-status]')?.textContent,audience:x?.q('[data-ce-saved-audience]')?.textContent,calls:x?.calls.map(c=>c.to+':'+(c.acao||c.method))}));}
const idle=x=>!x.run('GCE.contextStatus().blocked')&&!x.run('GCE.contextStatus().pending');
const campaignPosts=(x,acao)=>x.calls.filter(c=>c.to==='campaign'&&c.method==='POST'&&(!acao||c.acao===acao));
async function reopen(x,id){
 x.q('[data-ce-refresh]').click();await until(()=>!!x.q(`[data-ce-open="${id}"]`)&&idle(x),x,'lista de campanhas');
 x.q(`[data-ce-open="${id}"]`).click();if(x.q('[data-ce-confirm]')?.open)x.q('[data-ce-confirm-yes]').click();
 await until(()=>x.calls.some(c=>c.acao==='campanha_obter')&&x.calls.some(c=>c.acao==='campanha_publico_obter')&&idle(x),x,'reabertura');
}

const state=x=>({validate:x.q('[data-ce-validate]'),schedule:x.q('[data-ce-schedule]'),consult:x.q('[data-ce-consult]'),status:x.q('[data-ce-status]').textContent,server:x.q('[data-ce-server-state]').textContent,saved:x.q('[data-ce-saved-audience]').textContent});
async function conferir(x){
 assert.equal(state(x).validate.disabled,false,'conferência liberada com vínculo nulo confirmado');assert.equal(state(x).schedule.disabled,true,'agendar exige conferência');
 state(x).validate.click();await until(()=>x.calls.some(c=>c.acao==='campanha_validar')&&idle(x),x,'conferência');
 assert.match(state(x).server,/Versão salva validada/);assert.equal(state(x).schedule.disabled,false,'conferência válida libera agendar pela tela');
}
// Agendar relê o vínculo do público antes de abrir a confirmação (assíncrono).
async function abrirConfirmacaoAgendar(x){state(x).schedule.click();await until(()=>x.q('[data-ce-confirm]').open||(!x.run('GCE.contextStatus().reading')&&/vínculo de público desta campanha mudou/.test(x.q('[data-ce-status]').textContent)),x,'confirmação de agendar');}
async function agendarPelaTela(x,brand){
 await abrirConfirmacaoAgendar(x);assert.equal(x.q('[data-ce-confirm]').open,true,'agendar sempre pede confirmação');
 const text=x.q('[data-ce-confirm-text]').textContent;assert.match(text,new RegExp('Agendar '+(brand==='fish'?'Fishermans':'O Aristocrata')));assert.match(text,/Listas: /);assert.match(text,brand==='fish'?/2 pessoas podem receber/:/1 pessoa pode receber/);
 x.q('[data-ce-confirm-yes]').click();
}

module.exports={backend,page,until,idle,reopen,campaignPosts,state,conferir,agendarPelaTela,abrirConfirmacaoAgendar,CAMPAIGN,CAPS,KEY};
