'use strict';
// Riscos da PR #216 (R1–R5): diário travado, recusas definitivas, fuso, data vazia e
// permissão de desvincular. Tudo sintético: vm/linkedom, sem rede, credencial real ou envio.
// A prova SQL de R1 está em tests/claude-campaign-absence-postgres.cjs (QA_PG=1).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto'),{parseHTML}=require('linkedom');
const audienceFixture=require('./campaign-audience-fixture.cjs'),createLocks=require('./campaign-lock-fixture.cjs');
global.CampaignContract=require('../campaign-contract');global.CampaignTracking=require('../n8n/growth/campaign-tracking');
const A=require('../growth-campaign-api'),Editor=require('../growth-campaign-editor');
const root=path.resolve(__dirname,'..');
const END='https://campaign.example.test/operations',NOW=Date.parse('2026-09-19T12:00:00Z'),OP_ID='11111111-2222-4333-8444-555555555555';
const API={capabilities:{campaigns:{contract_version:A.VERSION,brands:['aristo','fish'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:'listmonk-6.1-regular-v1'},endpoints:{campaigns:END}}};
const site=brand=>brand==='fish'?'fishermans.com.br':'oaristocrata.com';
const definition=brand=>({schema_version:A.VERSION,brand,channel:'email',initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture',name:'Nome legível',subject:'Assunto',from_email:brand==='fish'?'Fish <contato@fishermans.com.br>':'Aristo <contato@oaristocrata.com>',reply_to:'contato@'+site(brand),list_ids:[125],template_id:1,html:`https://${site(brand)}/products/kit {{ UnsubscribeURL }}`,text:`https://${site(brand)}/products/kit {{ UnsubscribeURL }}`,tags:[],send_at:'2026-09-20T15:00:00Z'});
const campaign=(brand,patch={})=>({id:100,version:'v1',status:'draft',sent:0,started_at:null,send_at:definition(brand).send_at,definition:definition(brand),...patch});
const catalog=brand=>({brand,current:true,lists:[{id:125,name:'Clientes recorrentes',brand,available:true}],templates:[{id:1,name:'Modelo principal',type:'campaign',available:true,version:'t1'}],initiatives:[]});

// Servidor sintético de campanhas: o handler decide só a resposta da escrita em teste.
function campaignServer(brand,{write,operation,current}={}){
 const data=new Map(),calls=[];let counter=0,live=campaign(brand);
 const a=audienceFixture(live,NOW);
 const options={locks:createLocks(),capabilities:A.caps(API),brand,storage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},readKey:()=>'synthetic-read-secret',writeKey:()=>'synthetic-write-secret',now:()=>NOW,uuid:()=>`fixture-operation-${String(++counter).padStart(4,'0')}`,keyFingerprint:async k=>createHash('sha256').update(k).digest('hex'),
  fetch:async(url,init)=>{
   const u=new URL(url),req=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(u.searchParams);calls.push(req);let r;
   if(req.acao==='campanha_catalogo')r={status:200,body:catalog(brand)};
   else if(req.acao==='campanha_obter')r=current?current(req,live):{status:200,body:{campaign:live}};
   else if(req.acao==='campanha_operacao')r=operation(req,calls);
   else if(write&&write[req.acao])r=await write[req.acao](req,live);
   else if(req.acao==='campanha_salvar')r={status:201,body:{campaign:live}};
   else if(req.acao==='campanha_validar')r={status:200,body:{campaign:live,validation:{policy:A.VERSION,version:live.version,ok:true,audience:a}}};
   else if(req.acao==='campanha_agendar'){live={...live,version:'v2',status:'scheduled'};r={status:200,body:{campaign:live,operation_id:OP_ID,audience:{...a,rechecked_at:a.checked_at}}};}
   else throw Error('rota inesperada '+req.acao);
   return {status:r.status,json:async()=>structuredClone(r.body)};
  }};
 return {options,calls,data,audience:a,client:A.createClient(options),reload:()=>A.createClient(options),posts:()=>calls.filter(c=>['campanha_salvar','campanha_validar','campanha_agendar','campanha_cancelar'].includes(c.acao))};
}
const lost=()=>{throw Error('resposta perdida');};
const outcomeUnknown=(action,brand)=>req=>({status:200,body:{operation:{id:OP_ID,operation_key:req.idempotency_key,brand,action,state:'outcome_unknown',providerId:100,response:{status:502,body:{error:'OUTCOME_UNKNOWN',message:'Resultado remoto incerto.',provider_id:100,operation_id:OP_ID}},created_at:'2026-09-19T12:00:00Z',updated_at:'2026-09-19T12:00:01Z'}}});
async function scheduledLost(brand,opts){
 const f=campaignServer(brand,{...opts,write:{campanha_agendar:lost,...(opts.write||{})}});
 await f.client.catalog();await f.client.save(definition(brand));await f.client.validate(definition(brand));
 await assert.rejects(()=>f.client.schedule(definition(brand),'agendar',f.audience.review_id));
 assert.equal(f.client.locked(),true);return f;
}

/* ---------------- R1 · diário travado ---------------- */
for(const brand of ['fish','aristo']){
 test(`R1: ${brand} · agendamento com recibo outcome_unknown e campanha na mesma versão libera por ação explícita, com recibo de ausência e campanha relida`,async()=>{
  const f=await scheduledLost(brand,{operation:outcomeUnknown('agendar',brand)});
  await f.client.consult();assert.equal(f.client.locked(),true,'consultar sozinho não destrava');
  assert.equal(typeof f.client.canReleaseUnapplied,'function','existe saída para a tentativa sem efeito');
  assert.equal(f.client.canReleaseUnapplied(),true);
  await assert.rejects(()=>f.client.releaseUnapplied('sim'),{code:'CONFIRM_REQUIRED'});assert.equal(f.client.locked(),true);
  const before=f.posts().length,reads=f.calls.filter(c=>c.acao==='campanha_obter').length;
  const s=await f.client.releaseUnapplied('liberar');
  assert.equal(f.client.locked(),false);assert.equal(s.operation.phase,'rejected');
  assert.deepEqual(Object.keys(s.operation.absence).sort(),['campaign_id','campaign_version','checked_at','operation_id','operation_state','policy']);
  assert.equal(s.operation.absence.operation_id,OP_ID);assert.equal(s.operation.absence.operation_state,'outcome_unknown');assert.equal(s.operation.absence.campaign_version,'v1');
  assert.equal(f.calls.filter(c=>c.acao==='campanha_obter').length,reads+1,'campanha relida do servidor antes de liberar');
  assert.equal(s.validation,null,'conferência anterior não vale para nova escrita');assert.equal(f.posts().length,before,'nenhum POST repetido');
  // O recibo persiste e sobrevive à recarga.
  const again=f.reload();assert.equal(again.locked(),false);assert.equal(again.snapshot().operation.absence.policy,'crm-campaign-absence-v1');
 });
 test(`R1: ${brand} · cancelamento com recibo outcome_unknown e campanha ainda agendada na mesma versão também libera`,async()=>{
  const sched=campaign(brand,{version:'v2',status:'scheduled'});
  const f=campaignServer(brand,{write:{campanha_cancelar:lost},operation:outcomeUnknown('cancelar',brand),current:()=>({status:200,body:{campaign:sched}})});
  await f.client.catalog();await f.client.save(definition(brand));await f.client.validate(definition(brand));await f.client.schedule(definition(brand),'agendar',f.audience.review_id);
  await assert.rejects(()=>f.client.cancel('cancelar'));await f.client.consult();assert.equal(f.client.canReleaseUnapplied(),true);
  const s=await f.client.releaseUnapplied('liberar');assert.equal(f.client.locked(),false);assert.equal(s.campaign.status,'scheduled');assert.equal(s.operation.absence.campaign_version,'v2');
 });
}
test('R1: sem prova (versão mudou, pending, 404, salvar) o diário continua travado e a mensagem diz o que fazer e a quem pedir',async()=>{
 // Versão mudou: pode ter agendado.
 let f=await scheduledLost('fish',{operation:outcomeUnknown('agendar','fish'),current:(req,live)=>({status:200,body:{campaign:{...live,version:'v9',status:'scheduled'}}})});
 await f.client.consult();await assert.rejects(()=>f.client.releaseUnapplied('liberar'),e=>e.code==='RELEASE_UNPROVEN'&&/responsável técnico do CRM/.test(e.message)&&e.message.includes(f.client.snapshot().operation.key));
 assert.equal(f.client.locked(),true);
 // pending não é final.
 f=await scheduledLost('fish',{operation:req=>({status:200,body:{operation:{id:OP_ID,operation_key:req.idempotency_key,brand:'fish',action:'agendar',state:'pending',providerId:null,response:null}}})});
 await f.client.consult();assert.equal(f.client.canReleaseUnapplied(),false);await assert.rejects(()=>f.client.releaseUnapplied('liberar'),{code:'RELEASE_UNAVAILABLE'});assert.equal(f.client.locked(),true);
 // 404: POST pode chegar atrasado.
 f=await scheduledLost('fish',{operation:()=>({status:404,body:{error:'OPERATION_NOT_FOUND',message:'Operação não encontrada.',provider_id:null,operation_id:null}})});
 await assert.rejects(()=>f.client.consult(),e=>e.code==='OPERATION_NOT_FOUND'&&/responsável técnico do CRM/.test(e.message)&&/Não repita/.test(e.message));
 assert.equal(f.client.locked(),true);assert.equal(f.client.snapshot().operation.remote_state,'missing');assert.equal(f.client.canReleaseUnapplied(),false);
 // Servidor mudou para outro estado entre consultar e liberar: pede nova consulta.
 let state='outcome_unknown';f=await scheduledLost('fish',{operation:req=>{const r=outcomeUnknown('agendar','fish')(req);r.body.operation.state=state;return r;}});
 await f.client.consult();state='succeeded';await assert.rejects(()=>f.client.releaseUnapplied('liberar'),{code:'OPERATION_CHANGED'});assert.equal(f.client.locked(),true);
 // Salvar incerto não usa esta saída (rascunho nativo pode existir).
 f=campaignServer('fish',{write:{campanha_salvar:lost},operation:outcomeUnknown('salvar','fish')});await f.client.catalog();await assert.rejects(()=>f.client.save(definition('fish')));
 await f.client.consult();assert.equal(f.client.canReleaseUnapplied(),false);assert.equal(f.client.locked(),true);
});

/* ---------------- R1 · painel: botão explícito e orientação ---------------- */
const tick=()=>new Promise(r=>setTimeout(r,2));
async function until(check,label){for(let i=0;i<400;i++){if(check())return;await tick();}assert.fail('UI não chegou a: '+label);}
for(const brand of ['fish','aristo'])test(`R1 (painel): ${brand} · "Liberar tentativa sem efeito" aparece só com prova possível, pede confirmação e relê a campanha`,async()=>{
 const server=campaignServer(brand,{operation:outcomeUnknown('agendar',brand)});
 // Diário já travado por um agendamento incerto desta marca (mesmo formato gravado pelo cliente).
 const fp=createHash('sha256').update('synthetic-write-secret').digest('hex'),key='fixture-operation-9001';
 const request={id:100,expected_version:'v1',confirm:'agendar',audience_review_id:server.audience.review_id,brand,acao:'campanha_agendar',idempotency_key:key};
 const seed=new Map([[A.JOURNAL+brand,JSON.stringify({version:1,brand,endpoint:END,campaign:campaign(brand),validation:null,operation:{phase:'uncertain',actorFingerprint:fp,key,request,created_at:new Date(NOW).toISOString(),last_error:'RESPONSE_UNCONFIRMED'}})]]);
 const ed=bootEditorWithJournal(brand,server,seed);
 assert.equal(ed.q('[data-ce-release]').hidden,true,'antes da consulta não há prova');
 ed.q('[data-ce-consult]').click();await until(()=>!ed.q('[data-ce-release]').hidden,'botão de liberar');
 assert.match(ed.q('[data-ce-server-state]').textContent,/Use Liberar tentativa sem efeito/);
 ed.q('[data-ce-release]').click();await until(()=>ed.q('[data-ce-confirm]').hasAttribute('open'),'confirmação');
 assert.match(ed.q('[data-ce-confirm-text]').textContent,/só libera se a campanha continuar na mesma versão/);
 const posts=server.posts().length;ed.q('[data-ce-confirm-yes]').click();
 await until(()=>/Tentativa liberada sem efeito/.test(ed.q('[data-ce-status]').textContent),'liberação');
 assert.equal(ed.q('[data-ce-release]').hidden,true);assert.equal(ed.q('[data-ce-save]').disabled,false);assert.equal(server.posts().length,posts);
 assert.match(ed.q('[data-ce-server-state]').textContent,/Tentativa liberada: o servidor confirmou que ela não alterou a campanha/);
});
function bootEditorWithJournal(brand,server,seed){
 const {document,window}=parseHTML('<!doctype html><html><body><div id="campaign-composer"></div></body></html>'),store=new Map(seed);
 const localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
 const context=vm.createContext({window,document,localStorage,navigator:{locks:createLocks()},console,URL,URLSearchParams,Blob:class{},setTimeout,clearTimeout,TextEncoder,Intl,AbortSignal,
  crypto:{subtle:require('node:crypto').webcrypto.subtle,randomUUID:()=>'fixture-operation-7777'},shrigmaChaveOperador:()=>'synthetic-write-secret',shrigmaChave:()=>'synthetic-read-secret',__api:API,fetch:(url,init)=>server.options.fetch(url,init)});
 context.globalThis=context;
 for(const file of ['n8n/growth/campaign-tracking.js','campaign-contract.js','growth-brand-state.js','growth-campaign-api.js','growth-utm.js','growth-campaign-editor.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
 vm.runInContext('GCE.mount({marca:'+JSON.stringify(brand)+',api:__api})',context);
 require('./campaign-dialog-fixture.cjs')(document,window);
 return {document,store,q:s=>document.querySelector(s)};
}

/* ---------------- R2 · recusas definitivas de escrita ---------------- */
const conflict=(error,provider_id=100)=>({status:409,body:{error,message:'Campanha alterada; recarregue.',provider_id,operation_id:OP_ID}});
for(const brand of ['fish','aristo']){
 test(`R2: ${brand} · 409 gravado como recusa (operation_id + provider_id da campanha) resolve sem incerteza em salvar, conferir, agendar e cancelar`,async()=>{
  for(const action of ['campanha_salvar','campanha_validar','campanha_agendar','campanha_cancelar']){
   const sched=campaign(brand,{version:'v2',status:'scheduled'});
   const f=campaignServer(brand,{write:{[action]:(action==='campanha_salvar'?(req,live)=>req.id?conflict('VERSION_CONFLICT'):{status:201,body:{campaign:live}}:()=>conflict('VERSION_CONFLICT'))},operation:()=>assert.fail('não precisa consultar')});
   await f.client.catalog();await f.client.save(definition(brand));
   let work;
   if(action==='campanha_salvar')work=()=>f.client.save({...definition(brand),subject:'Outro assunto'});
   else if(action==='campanha_validar')work=()=>f.client.validate(definition(brand));
   else{await f.client.validate(definition(brand));
    if(action==='campanha_agendar')work=()=>f.client.schedule(definition(brand),'agendar',f.audience.review_id);
    else{await f.client.schedule(definition(brand),'agendar',f.audience.review_id);void sched;work=()=>f.client.cancel('cancelar');}}
   const posts=f.posts().length;
   await assert.rejects(work,e=>e.code==='VERSION_CONFLICT'&&/Nada foi alterado/.test(e.message)&&/reabra a versão atual/.test(e.message));
   assert.equal(f.client.locked(),false,action+' não fica incerto');assert.equal(f.client.snapshot().operation.phase,'rejected');
   assert.equal(f.client.snapshot().operation.response.body.operation_id,OP_ID);assert.equal(f.posts().length,posts+1,'um único POST');
  }
 });
}
test('R2: só a recusa provada resolve; 409 sem recibo, de chave repetida, criação nova ou outro corpo continua incerto',async()=>{
 const cases=[
  ['criação nova (rascunho nativo pode existir)',{campanha_salvar:()=>({status:409,body:{error:'TEMPLATE_CHANGED',message:'x',provider_id:null,operation_id:OP_ID}})},false],
  ['sem operation_id',{campanha_validar:()=>({status:409,body:{error:'VERSION_CONFLICT',message:'x',provider_id:100,operation_id:null}})},true],
  ['chave em andamento',{campanha_validar:()=>({status:409,body:{error:'OPERATION_PENDING',message:'x',provider_id:null,operation_id:OP_ID}})},true],
  ['chave reutilizada',{campanha_validar:()=>({status:409,body:{error:'IDEMPOTENCY_CONFLICT',message:'x',provider_id:100,operation_id:OP_ID}})},true],
  ['outra campanha',{campanha_validar:()=>({status:409,body:{error:'VERSION_CONFLICT',message:'x',provider_id:101,operation_id:OP_ID}})},true],
  ['corpo com campo extra',{campanha_validar:()=>({status:409,body:{error:'VERSION_CONFLICT',message:'x',provider_id:100,operation_id:OP_ID,posted:false}})},true],
  ['502 incerto',{campanha_validar:()=>({status:502,body:{error:'OUTCOME_UNKNOWN',message:'x',provider_id:100,operation_id:OP_ID}})},true]
 ];
 for(const [label,write,saved] of cases){
  const f=campaignServer('fish',{write,operation:()=>({status:503,body:{}})});await f.client.catalog();
  if(saved){await f.client.save(definition('fish'));await assert.rejects(()=>f.client.validate(definition('fish')));}
  else await assert.rejects(()=>f.client.save(definition('fish')));
  assert.equal(f.client.locked(),true,label);assert.equal(f.client.snapshot().operation.phase,'uncertain',label);
 }
});
test('R2 (aceite): 401 e 403 sem operação continuam resolvendo como recusa, com uma única tentativa',async()=>{
 for(const r of [{status:401,body:{error:'UNAUTHORIZED',message:'Autenticação necessária.'}},{status:403,body:{error:'CAPABILITY_MISSING',message:'Esta chave não permite esta operação.',provider_id:null,operation_id:null}}]){
  const f=campaignServer('fish',{write:{campanha_salvar:()=>r},operation:()=>assert.fail('sem consulta')});await f.client.catalog();
  await assert.rejects(()=>f.client.save(definition('fish')),{code:r.body.error});assert.equal(f.client.locked(),false);assert.equal(f.posts().length,1);
 }
});

/* ---------------- R2 · público: vincular, desvincular e salvar ---------------- */
{
 const B=require('./growth-campaign-audience-fixture.cjs');
 for(const [label,response,code] of [['401 exato',{status:401,body:{error:'SEGMENT_UNAUTHORIZED'}},'SEGMENT_UNAUTHORIZED'],['403 exato',{status:403,body:{error:'SEGMENT_ACCESS_DENIED'}},'SEGMENT_ACCESS_DENIED'],['409 recusa gravada',{status:409,body:{error:'SEGMENT_BINDING_VERSION_CONFLICT'}},'SEGMENT_BINDING_VERSION_CONFLICT']]){
  test(`R2: vincular/desvincular público · ${label} resolve sem incerteza e sobrevive à recarga`,async()=>{
   for(const action of ['bind','release']){
    const f=B.fixture(),c=f.create();let s=await c.inspect(100,B.audience);
    if(action==='release'){await c.bind(s.inspection.intent);}
    f.control.patch=(r,p)=>p.acao===B.C.ACTIONS[action]?structuredClone(response):r;
    const work=action==='bind'?()=>c.bind(s.inspection.intent):()=>c.release();
    await assert.rejects(work,{code});assert.equal(c.pending(),false,action);assert.equal(c.snapshot().operation.phase,'rejected');
    const again=f.create();assert.equal(again.pending(),false,'recarga lê a recusa');assert.equal(f.calls.filter(x=>x.p.acao===B.C.ACTIONS[action]).length,1);
    assert.equal(f.calls.filter(x=>x.p.acao===B.C.ACTIONS.operation).length,0,'não precisa consultar');
   }
  });
 }
 test('R2: vincular público · 202 não confirmado, 409 desconhecido e 401 com corpo extra continuam pendentes',async()=>{
  for(const response of [{status:202,body:{error:'SEGMENT_BINDING_UNCONFIRMED',state:'unconfirmed',idempotency_key:'x',automatic_retry:false}},{status:409,body:{error:'SEGMENT_BINDING_OPERATION_MISMATCH'}},{status:401,body:{error:'SEGMENT_UNAUTHORIZED',detail:'x'}},{status:503,body:{error:'CRM_AUDIENCE_UNCONFIRMED'}}]){
   const f=B.fixture(),c=f.create(),s=await c.inspect(100,B.audience);f.control.patch=(r,p)=>p.acao===B.C.ACTIONS.bind?structuredClone(response):r;
   await assert.rejects(()=>c.bind(s.inspection.intent),{code:'SEGMENT_BINDING_OPERATION_UNCONFIRMED'});assert.equal(c.pending(),true,JSON.stringify(response));
  }
 });
 const S=require('./growth-segment-fixture.cjs');
 test('R2: salvar público · 401/403 exatos e 409 gravado resolvem sem incerteza; resposta não provada continua pendente',async()=>{
  for(const [response,code,pending] of [[{status:401,body:{error:'SEGMENT_UNAUTHORIZED'}},'SEGMENT_UNAUTHORIZED',false],[{status:403,body:{error:'SEGMENT_ACCESS_DENIED'}},'SEGMENT_ACCESS_DENIED',false],[{status:409,body:{error:'SEGMENT_VERSION_CONFLICT',current_version:4}},'SEGMENT_VERSION_CONFLICT',false],[{status:202,body:{error:'SEGMENT_SERVICE_UNAVAILABLE',state:'unconfirmed',idempotency_key:'x'}},'SEGMENT_OPERATION_UNCONFIRMED',true],[{status:403,body:{error:'SEGMENT_ACCESS_DENIED',extra:true}},'SEGMENT_OPERATION_UNCONFIRMED',true]]){
   const f=S.fixture();let posts=0;
   const fetch=async(url,init)=>{const body=init.method==='POST'?JSON.parse(init.body):null;if(body?.acao==='segmento_salvar'){posts++;const r=structuredClone(response);return {status:r.status,json:async()=>r.body};}return f.fetch(url,init);};
   const c=f.create('fish',undefined,{fetch});await c.list();const first=await c.save(S.definition());
   await assert.rejects(()=>c.save(S.definition('fish','Outro nome'),first.segment),{code});
   assert.equal(c.pending(),pending,JSON.stringify(response));assert.equal(posts,1);
   if(!pending){assert.equal(c.snapshot().operation.phase,'rejected');assert.equal(f.create().pending(),false,'recarga lê a recusa');assert.equal(f.calls.filter(x=>x.body.acao==='segmento_operacao').length,0);}
  }
 });
}

/* ---------------- R3 · deslocamento real de Brasília ---------------- */
test('R3: data digitada usa o deslocamento real de America/Sao_Paulo (hoje -03:00, idêntico ao anterior)',()=>{
 const values={brand:'fish',initiative_name:'Fixture',initiative_key:'fixture',utm_campaign:'fixture',name:'Nome',subject:'Assunto',from_email:'Fish <contato@fishermans.com.br>',reply_to:'contato@fishermans.com.br',list_ids:'125',template_id:'1',tags:'',html:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}',text:'https://fishermans.com.br/products/kit {{ UnsubscribeURL }}'};
 for(const local of ['2026-10-15T10:00','2026-12-24T23:30','2027-01-15T00:00','2027-02-20T12:15:30','2026-11-01T00:00']){
  assert.equal(Editor.brasiliaOffset(local),'-03:00',local);
  assert.deepEqual(Editor.definition({...values,send_at:local}),CampaignContract.normalize({...Editor.definition({...values,send_at:''}),send_at:local+'-03:00'}),local);
 }
 // Regra histórica de horário de verão (base de fusos do Intl): prova que o cálculo consulta o fuso.
 assert.equal(Editor.brasiliaOffset('2018-12-01T10:00'),'-02:00');assert.equal(Editor.brasiliaOffset('2018-06-01T10:00'),'-03:00');
});
test('R3: regra de horário de verão simulada no Intl muda o deslocamento sem tocar no código',()=>{
 // Intl sintético: America/Sao_Paulo em -02:00 de novembro a fevereiro, -03:00 no resto.
 const shift=ms=>{const m=new Date(ms-3*3600e3).getUTCMonth();return [10,11,0,1].includes(m)?-2:-3;};
 class DTF{constructor(locale,opts){this.opts=opts||{};}
  formatToParts(d){assert.equal(this.opts.timeZone,'America/Sao_Paulo');const w=new Date(d.getTime()+shift(d.getTime())*3600e3),p=n=>String(n).padStart(2,'0');return [['year',String(w.getUTCFullYear())],['month',p(w.getUTCMonth()+1)],['day',p(w.getUTCDate())],['hour',p(w.getUTCHours())],['minute',p(w.getUTCMinutes())],['second',p(w.getUTCSeconds())]].map(([type,value])=>({type,value}));}
  format(d){return d.toISOString();}}
 const context=vm.createContext({Intl:{DateTimeFormat:DTF,NumberFormat:Intl.NumberFormat},console});
 vm.runInContext(fs.readFileSync(path.join(root,'growth-campaign-editor.js'),'utf8'),context);
 assert.equal(vm.runInContext("GCE.brasiliaOffset('2026-12-10T10:00')",context),'-02:00');
 assert.equal(vm.runInContext("GCE.brasiliaOffset('2026-07-10T10:00')",context),'-03:00');
});

/* ---------------- R4 e R5 · público salvo ---------------- */
function regularUI({prepare,sendAt}){
 const UI=require('../growth-campaign-audience-ui.js'),{document}=parseHTML('<div id="a"></div>'),element=document.getElementById('a');
 const version='a'.repeat(32),bindingHash='e'.repeat(64),store=new Map(),calls=[];
 const binding={campaign_current:true,semantic_context:{current:true},binding_hash:bindingHash,binding_version:1,campaign_version:version,audience_revision:1};
 const Client={SLOT:'claude-binding:',fingerprint:async k=>createHash('sha256').update(k).digest('hex'),caps:a=>({read:true,inspect:true,validate:true,brands:['fish','aristo'],endpoint:a?.capabilities?.endpoints?.campaign_audience||null}),
  create:()=>{let s={binding:null,campaign_version:null};return {pending:()=>false,snapshot:()=>s,update(){},canWrite:()=>true,canRelease:()=>false,read:async()=>{s={binding,campaign_version:version};}};}};
 const SegmentClient={caps:()=>({read:true,contract_version:'crm-audience-v2',brands:['fish','aristo'],endpoint:'https://audience.test/api'}),create:()=>({update(){}}),contractFor:()=>({FIELDS:{}})};
 const payload={capabilities:{endpoints:{campaign_audience:'https://binding.test/api',segments:'https://audience.test/api'},campaign_audience:{contract_version:'crm-audience-campaign-binding-v1',brands:['fish','aristo'],read:true,validate:true,regular:{contract_version:'crm-audience-regular-admission-v1',prepare:true,schedule:true,operation:true}},segments:{}}};
 const fetch=async(url,init)=>{const p=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);calls.push(p);const r=prepare(p);return {status:r.status,text:async()=>JSON.stringify(r.body)};};
 const ui=UI.create({element,key:()=> 'synthetic-manager-key',storage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},fetch,locks:createLocks(),identity:Client.fingerprint,Client,SegmentClient});
 ui.sync({api:payload,brand:'fish',campaign:{id:100,version,status:'draft',sent:0,started_at:null,send_at:sendAt,definition:{name:'Campanha salva'}},localCampaignId:null,clean:true,blocked:false});
 return {ui,calls,q:s=>element.querySelector(s)};
}
test('R4: público salvo sem data de envio pede a data em Brasília em vez de "15 minutos"; com data próxima mantém o aviso de antecedência',async()=>{
 let x=regularUI({sendAt:null,prepare:()=>({status:409,body:{error:'REGULAR_ADMISSION_SCHEDULE_TOO_SOON'}})});
 await x.ui.confirmBindingRead();await x.ui.validate();
 assert.match(x.q('[data-ca-status]').textContent,/Preencha a data e a hora de envio \(horário de Brasília\)/);assert.doesNotMatch(x.q('[data-ca-status]').textContent,/15 minutos/);
 assert.equal(x.calls.some(c=>c.acao==='campanha_publico_agendar'),false);
 x=regularUI({sendAt:new Date(Date.now()+5*60e3).toISOString(),prepare:()=>({status:409,body:{error:'REGULAR_ADMISSION_SCHEDULE_TOO_SOON'}})});
 await x.ui.confirmBindingRead();await x.ui.validate();assert.match(x.q('[data-ca-status]').textContent,/15 minutos/);
});
{
 const B=require('./growth-campaign-audience-fixture.cjs'),UI=require('../growth-campaign-audience-ui.js'),GSC=require('../growth-segment-client.js');
 const uiApi=patch=>{const a=structuredClone(B.api);Object.assign(a.capabilities.campaign_audience,patch);a.capabilities.segments={contract_version:'crm-audience-v2',brands:['fish','aristo'],read:true,save:true,count:true,operation:true};a.capabilities.endpoints.segments='https://segments.example.test/api';return a;};
 for(const [brand,id] of [['fish',100],['aristo',200]])test(`R5: ${brand} · "Voltar a listas existentes" desabilitado só por falta de "release" explica o motivo`,async()=>{
  const f=B.fixture(),c=f.create(brand,id),s=await c.inspect(id,B.audience);await c.bind(s.inspection.intent);
  const mount=patch=>{const {document}=parseHTML('<div id="a"></div>'),element=document.getElementById('a');const ui=UI.create({element,key:()=>'synthetic-manager-key',storage:f.storage,fetch:f.fetch,locks:f.locks,Client:B.C,SegmentClient:GSC});ui.sync({api:uiApi(patch),brand,campaign:{id,version:'b'.repeat(32),status:'draft',sent:0,started_at:null,send_at:null,definition:{brand,name:'Campanha'}},clean:true,blocked:false});return {q:sel=>element.querySelector(sel)};};
  const x=mount({release:false});const button=x.q('[data-ca="release"]');
  assert.ok(button,'vínculo existente mostra o botão');assert.equal(button.disabled,true);
  assert.equal(button.getAttribute('aria-describedby'),'ca-access-note');assert.match(x.q('#ca-access-note').textContent,/não voltar às listas existentes/);
  const y=mount({});assert.equal(y.q('[data-ca="release"]').hasAttribute('aria-describedby'),false);assert.ok(!y.q('#ca-access-note'));
 });
}

/* ---------------- R2 · prova com o serviço real de vínculo (PGlite) ---------------- */
test('R2 (serviço real): 403 e 401 em vincular saem antes de gravar — sem vínculo, sem recibo — e o painel resolve sem incerteza',async t=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
 const API=require('../n8n/growth/segment-campaign-binding-api.cjs'),F=require('./segment-campaign-binding-fixture.cjs'),CF=require('./growth-campaign-audience-fixture.cjs'),C=CF.C;
 const db=new PGlite();t.after(()=>db.close());const f=await F.setup(db),api=API.createCampaignBindingAPI({store:f.service}),ui=CF.fixture(),calls=[];
 const fetch=async(url,init)=>{const p=init.method==='GET'?Object.fromEntries(new URL(url).searchParams):JSON.parse(init.body);calls.push(p);const r=await api.handle({method:init.method,request:{headers:init.headers,[init.method==='GET'?'query':'body']:p}});return {status:r.status,text:async()=>JSON.stringify(r.body)};};
 const count=async table=>(await db.query(`SELECT count(*)::int n FROM crm_audience_v2.${table}`)).rows[0].n;
 // 403: leitor confere, mas não tem "draft" para vincular.
 const a=await f.createAudience('fish','reader-fish'),reader=ui.create('fish',100,{fetch,key:()=>'synthetic-reader-key'}),s=await reader.inspect(100,{id:a.id,version:a.version});
 await assert.rejects(reader.bind(s.inspection.intent),{code:'SEGMENT_ACCESS_DENIED'});assert.equal(reader.pending(),false);assert.deepEqual(reader.snapshot().operation.receipt,{status:403,body:{error:'SEGMENT_ACCESS_DENIED'}});
 assert.equal(await count('campaign_binding'),0);assert.equal(await count('campaign_binding_request'),0,'nenhum recibo: a consulta nunca destravaria');
 // 401: a chave é revogada entre a conferência e o vínculo.
 const b=await f.createAudience('aristo','revoked-aristo'),manager=ui.create('aristo',200,{fetch}),m=await manager.inspect(200,{id:b.id,version:b.version});
 await db.exec("UPDATE crm_dash_chave SET ativo=false WHERE chave='manager'");
 await assert.rejects(manager.bind(m.inspection.intent),{code:'SEGMENT_UNAUTHORIZED'});assert.equal(manager.pending(),false);
 assert.equal(await count('campaign_binding'),0);assert.equal(await count('campaign_binding_request'),0);
 assert.equal(calls.filter(p=>p.acao===C.ACTIONS.bind).length,2);assert.equal(calls.filter(p=>p.acao===C.ACTIONS.operation).length,0);
});
