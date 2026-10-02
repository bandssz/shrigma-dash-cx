'use strict';
// Conferência, agenda e fuso no painel. DOM sintético (linkedom), sem rede.
// Rodar com QA_TZ=UTC e QA_TZ=America/Sao_Paulo: o resultado não pode depender do fuso da máquina.
const audienceFixture=require('./campaign-audience-fixture.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto,createHash}=require('node:crypto');
const createLocks=require('./campaign-lock-fixture.cjs'),{parseHTML}=require('linkedom'),C=require('../campaign-contract');
global.CampaignContract=C;const Editor=require('../growth-campaign-editor');
const root=path.resolve(__dirname,'..'),END='https://campaign.example.test/operations';
const api={capabilities:{campaigns:{contract_version:C.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:'listmonk-6.1-regular-v1'},endpoints:{campaigns:END}}};
const definition=(brand='fish')=>{const domain=brand==='fish'?'fishermans.com.br':'oaristocrata.com';return {schema_version:C.VERSION,brand,channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Campanha de exemplo',subject:'Assunto',from_email:`Marca <contato@${domain}>`,reply_to:'contato@'+domain,list_ids:[125,126],template_id:1,html:`https://${domain}/products/kit {{ UnsubscribeURL }}`,text:`https://${domain}/products/kit {{ UnsubscribeURL }}`,tags:[],send_at:'2030-09-20T15:00:00Z'};};
const catalog=brand=>({brand,current:true,lists:[{id:125,name:'Clientes recorrentes',brand,available:true},{id:126,name:'Compradores do kit',brand,available:true}],templates:[{id:1,name:'Modelo principal',type:'campaign',available:true,version:'t1'}],initiatives:[]});
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert.fail('UI did not reach expected state');};

function boot({brand='fish',store=new Map(),local=null,history=[],audiencePatch={},failCatalog=()=>false}={}){
 const {document,window}=parseHTML('<section id="campaign-composer"></section>');
 const proto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 if(!store.has('shrigma_growth_editor_v1:campaign:'+brand))store.set('shrigma_growth_editor_v1:campaign:'+brand,JSON.stringify({version:1,area:'campaign',brand,value:local||Editor.fromDefinition(definition(brand))}));
 store.set('write-slot','synthetic-write-secret');store.set('read-slot','synthetic-read-secret');
 const calls=[];let current=null,review=null,next=100;
 const clock=Date.now(),context=vm.createContext({document,window,console,Date,Intl,URL,URLSearchParams,AbortSignal,TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,navigator:{locks:createLocks()},
  shrigmaChave:()=>store.get('read-slot'),localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},GTA:{CHAVE_ESCRITA:'write-slot',CHAVE_LEITURA:'read-slot'},GMP:{openEmail(){}},__api:api,
  fetch:async(url,init)=>{
   const req=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);calls.push(req);let body;
   if(req.acao==='campanha_catalogo'&&failCatalog(calls.filter(c=>c.acao==='campanha_catalogo').length))return {status:503,json:async()=>({error:'READ_UNAVAILABLE'})};
   if(req.acao==='campanha_catalogo')body=catalog(brand);
   else if(req.acao==='campanha_listar')body={campaigns:[...history,...(current?[current]:[])]};
   else if(req.acao==='campanha_obter')body={campaign:history.find(c=>c.id===Number(req.id))||current};
   else if(req.acao==='campanha_salvar'){const d=C.normalize(req.definition);current={id:current?.id||next++,version:'v'+calls.length,status:'draft',sent:0,started_at:null,send_at:d.send_at,definition:d};body={campaign:current};}
   else if(req.acao==='campanha_validar'){review=audienceFixture(current,Date.now(),audiencePatch);body={campaign:current,validation:{policy:C.VERSION,version:current.version,ok:true,audience:review}};}
   else if(req.acao==='campanha_agendar'){current={...current,status:'scheduled',version:current.version+'-s'};body={campaign:current,audience:{...review,rechecked_at:review.checked_at}};}
   else throw Error('unexpected '+req.acao);
   return {status:200,json:async()=>structuredClone(body)};
  }});
 for(const file of ['n8n/growth/campaign-tracking.js','campaign-contract.js','growth-brand-state.js','growth-campaign-api.js','growth-utm.js','growth-campaign-editor.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
 vm.runInContext('GCE.mount({marca:'+JSON.stringify(brand)+',api:__api})',context);
 const dialog=require('./campaign-dialog-fixture.cjs')(document,window);
 return {document,window,calls,store,clock,confirmations:dialog.messages,accept:dialog.accept,cancel:dialog.cancel,q:s=>document.querySelector(s),current:()=>current};
}
const input=(x,name,value)=>{x.q(`[name=${name}]`).value=value;x.q(`[name=${name}]`).dispatchEvent(new x.window.Event('input',{bubbles:true}));};
async function reviewed(x){x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);x.q('[data-ce-validate]').click();await until(()=>/pessoas? pode/.test(x.q('[data-ce-audience]').textContent));}

test('data digitada em Brasília vira o instante certo perto da meia-noite, independente do fuso da máquina',async()=>{
 for(const [typed,instant,shown] of [['2030-09-19T23:30','2030-09-20T02:30:00.000Z','19/09/2030'],['2030-12-31T23:59','2031-01-01T02:59:00.000Z','31/12/2030'],['2031-01-01T00:00','2031-01-01T03:00:00.000Z','01/01/2031']]){
  const x=boot();input(x,'send_at',typed);await reviewed(x);
  assert.equal(x.calls.find(c=>c.acao==='campanha_salvar').definition.send_at,instant);
  const hour=typed.slice(11,16);
  assert.match(x.q('[data-ce-server-state]').textContent,new RegExp(shown.replaceAll('/','\\/')+',? '+hour+' · Brasília'));
  x.q('[data-ce-schedule]').click();assert.match(x.confirmations.at(-1),new RegExp('para '+shown.replaceAll('/','\\/')+',? '+hour+' · Brasília'));
  x.accept();await until(()=>/Agendada/.test(x.q('[data-ce-server-state]').textContent));
  // Reabrir após reinício mostra a mesma hora local de Brasília no campo datetime-local.
  const y=boot({store:x.store});assert.equal(y.q('[name=send_at]').value,typed+':00');
 }
});

test('a confirmação de agendamento mostra as listas conferidas mesmo sem o catálogo aberto na tela',async()=>{
 for(const brand of ['fish','aristo']){
  const x=boot({brand});await reviewed(x);
  assert.equal(x.q('[data-ce-catalog]').innerHTML,'','o catálogo não foi aberto: as listas não aparecem em nenhum outro lugar');
  assert.match(x.q('[data-ce-audience]').textContent,/Clientes recorrentes.*Compradores do kit/);
  x.q('[data-ce-schedule]').click();const prompt=x.confirmations.at(-1);
  assert.match(prompt,brand==='fish'?/Fishermans/:/O Aristocrata/);assert.match(prompt,/Clientes recorrentes/);assert.match(prompt,/Compradores do kit/);assert.match(prompt,/2 pessoas podem receber/);
  x.cancel();assert.equal(x.calls.some(c=>c.acao==='campanha_agendar'),false);
 }
});

test('uma campanha antiga fora do contrato não impede carregar catálogo e histórico da marca, e o histórico avisa que ela ficou de fora',async()=>{
 for(const brand of ['fish','aristo']){
  const legacy={id:90,version:'legacy',status:'finished',sent:12,started_at:'2026-01-01T12:00:00.000Z',send_at:'2026-01-01T12:00:00.000Z',definition:{...definition(brand),name:'Envio antigo',html:'<p>sem descadastro</p>',text:'sem descadastro'}};
  const x=boot({brand,history:[legacy]});x.q('[data-ce-save]').click();await until(()=>!x.q('[data-ce-validate]').disabled);
  x.q('[data-ce-refresh]').click();await until(()=>x.q('[data-ce-list]'));
  assert.match(x.q('[data-ce-catalog]').textContent,/Clientes recorrentes/);assert.match(x.q('[data-ce-campaigns]').textContent,/Campanha de exemplo/);assert.doesNotMatch(x.q('[data-ce-campaigns]').textContent,/Envio antigo/);
  // A campanha fora do contrato não some em silêncio: o histórico informa quantas ficaram de fora.
  assert.match(x.q('[data-ce-campaigns-hidden]')?.textContent||'',/^1 campanha antiga desta marca está fora do contrato atual/);
  assert.doesNotMatch(x.q('[data-ce-status]').textContent,/não foi confirmada/);
 }
});

test('zero confirmado aparece como zero e bloqueia; contagem desconhecida nunca aparece como zero nem libera agenda',async()=>{
 const zero=boot({audiencePatch:{eligible_count:0,unique_members_count:0}});await reviewed(zero);
 assert.match(zero.q('[data-ce-audience]').textContent,/0 pessoas podem receber agora/);assert.match(zero.q('[data-ce-audience]').textContent,/Não há destinatários elegíveis agora/);assert.equal(zero.q('[data-ce-schedule]').disabled,true);
 const unknown=boot({audiencePatch:{eligible_count:null}});unknown.q('[data-ce-save]').click();await until(()=>!unknown.q('[data-ce-validate]').disabled);unknown.q('[data-ce-validate]').click();
 await until(()=>/Resultado pendente ou incerto/.test(unknown.q('[data-ce-server-state]').textContent));
 assert.doesNotMatch(unknown.q('[data-ce-audience]').textContent,/\b0 pessoas/);assert.equal(unknown.q('[data-ce-schedule]').disabled,true);
 unknown.q('[data-ce-schedule]').click();assert.equal(unknown.confirmations.length,0);assert.equal(unknown.calls.some(c=>c.acao==='campanha_agendar'),false);
});

test('reabrir do histórico com falha no catálogo não vincula o conteúdo local a outra campanha',async()=>{
 for(const brand of ['fish','aristo']){
  const other={id:102,version:'v-102',status:'draft',sent:0,started_at:null,send_at:'2030-09-21T15:00:00.000Z',definition:{...C.normalize(definition(brand)),name:'Campanha salva 102',subject:'Assunto 102',send_at:'2030-09-21T15:00:00.000Z'}};
  const x=boot({brand,history:[other],failCatalog:n=>n===2});
  x.q('[data-ce-refresh]').click();await until(()=>x.q('[data-ce-open="102"]'));
  input(x,'subject','Rascunho local não salvo');
  x.q('[data-ce-open="102"]').click();x.accept();await until(()=>x.calls.filter(c=>c.acao==='campanha_catalogo').length===2&&!x.q('[data-ce-refresh]').disabled);
  const journal=JSON.parse(x.store.get('shrigma_campaign_operation_v1:'+brand)||'null');
  // Se o diário passou para 102, o formulário precisa ter o conteúdo de 102; nunca o rascunho local.
  if(journal?.campaign?.id===102)assert.equal(x.q('[name=subject]').value,'Assunto 102');
  else assert.match(x.q('[data-ce-status]').textContent,/não confirmado|Consulte|catálogo/i);
  x.q('[data-ce-save]').click();await new Promise(r=>setTimeout(r,30));
  const saved=x.calls.filter(c=>c.acao==='campanha_salvar');
  assert.ok(!saved.some(c=>c.id===102&&c.definition.subject==='Rascunho local não salvo'),'conteúdo local gravado sobre a campanha 102');
 }
});

// ---- Público salvo (caminho regular, gate OFF em produção): somente leitura sintética.
function audienceUI({prepare}){
 const UI=require('../growth-campaign-audience-ui.js'),{document,window}=parseHTML('<div id="a"></div>'),element=document.getElementById('a');
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));
 dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 const version='a'.repeat(32),bindingHash='e'.repeat(64),store=new Map(),calls=[];
 const binding={campaign_current:true,semantic_context:{current:true},binding_hash:bindingHash,binding_version:1,campaign_version:version,audience_revision:1};
 const Client={SLOT:'claude-binding:',fingerprint:async k=>createHash('sha256').update(k).digest('hex'),caps:a=>({read:true,inspect:true,validate:true,brands:['fish','aristo'],endpoint:a?.capabilities?.endpoints?.campaign_audience||null}),
  create:()=>{let s={binding:null,campaign_version:null};return {pending:()=>false,snapshot:()=>s,update(){},canWrite:()=>true,canRelease:()=>false,read:async()=>{s={binding,campaign_version:version};}};}};
 const SegmentClient={caps:()=>({read:true,contract_version:'crm-audience-v2',brands:['fish','aristo'],endpoint:'https://audience.test/api'}),create:()=>({update(){}}),contractFor:()=>({FIELDS:{}})};
 const payload={capabilities:{endpoints:{campaign_audience:'https://binding.test/api',segments:'https://audience.test/api'},campaign_audience:{contract_version:'crm-audience-campaign-binding-v1',brands:['fish','aristo'],read:true,validate:true,regular:{contract_version:'crm-audience-regular-admission-v1',prepare:true,schedule:true,operation:true}},segments:{}}};
 const fetch=async(url,init)=>{const p=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);calls.push(p);const r=prepare(p);return {status:r.status,text:async()=>JSON.stringify(r.body)};};
 const ui=UI.create({element,key:()=> 'synthetic-manager-key',storage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},fetch,locks:createLocks(),identity:Client.fingerprint,Client,SegmentClient});
 ui.sync({api:payload,brand:'fish',campaign:{id:100,version,status:'draft',sent:0,started_at:null,definition:{name:'Campanha salva'}},localCampaignId:null,clean:true,blocked:false});
 return {ui,element,calls,version,bindingHash,q:s=>element.querySelector(s)};
}
const regularReview=(x,patch={})=>{const now=Date.now();return {contract:'crm-audience-regular-admission-v1',review_id:'00000000-0000-4000-8000-0000000000aa',brand:'fish',campaign_id:100,campaign_version:x.version,binding_version:1,binding_hash:x.bindingHash,material_hash:'f'.repeat(64),eligible_count:3,send_at:'2030-09-20T02:30:00.000Z',checked_at:new Date(now).toISOString(),expires_at:new Date(now+50000).toISOString(),requires_confirmation:true,...patch};};

test('público salvo: conferência e confirmação mostram a data de envio em Brasília, não no fuso do navegador',async()=>{
 let x;x=audienceUI({prepare:()=>({status:200,body:{review:regularReview(x)}})});
 assert.equal(await x.ui.confirmBindingRead(),true);await x.ui.validate();
 const text=x.q('[data-ca-regular-review]').textContent;
 assert.match(text,/3 pessoas elegíveis/);assert.match(text,/19\/09\/2030,? 23:30 · Brasília/);assert.doesNotMatch(text,/20\/09\/2030/);assert.match(text,/Confirme antes de \d\d:\d\d:\d\d \(Brasília\)/);
 const scheduling=x.ui.schedule();const prompt=x.q('[data-ca-confirm-text]').textContent;
 assert.match(prompt,/19\/09\/2030,? 23:30 · Brasília/);assert.doesNotMatch(prompt,/20\/09\/2030/);
 x.q('[data-ca-no]').click();await scheduling;assert.equal(x.calls.some(c=>c.acao==='campanha_publico_agendar'),false);
});

test('público salvo: fonte indisponível informa quantidade desconhecida, diferente de zero confirmado',async()=>{
 for(const [status,error,expected] of [[503,'REGULAR_ADMISSION_SOURCE_UNAVAILABLE',/quantidade (está )?desconhecida/i],[409,'REGULAR_ADMISSION_EMPTY',/Nenhuma pessoa está elegível/]]){
  const x=audienceUI({prepare:()=>({status,body:{error}})});await x.ui.confirmBindingRead();await x.ui.validate();
  const message=x.q('[data-ca-status]').textContent;assert.match(message,expected);assert.doesNotMatch(message,/Preserve a tentativa/);
  assert.equal(x.q('[data-ca-regular-review]'),null);assert.equal(x.ui.contextStatus().canSchedule,false);
 }
});
