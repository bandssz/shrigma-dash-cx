'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),G=require('../growth-data');
const campaign=(extra={})=>({marca:'fish',canal:'email',tipo:'enviada',campanha_id:1,entregues:100,abriram:40,clicaram:10,truncado:false,enviado_em:'2026-09-01T12:00:00Z',...extra});
const experiment=(extra={})=>({teste_id:'synthetic-ab',marca:'fish',canal:'email',metrica_primaria:'ctr',nome:'Comparação sintética',hipotese:'Hipótese registrada',variavel:'assunto',efeito_minimo:1,status:'rodando',...extra});
const arms=()=>[{teste_id:'synthetic-ab',braco:'a',campanha_id:1,utm_term:'a'},{teste_id:'synthetic-ab',braco:'b',campanha_id:2,utm_term:'b'}];
const payload=()=>({crm_campanha:[campaign({entregues:10000,clicaram:200}),campaign({campanha_id:2,entregues:10000,clicaram:1500})],crm_teste:[experiment()],crm_teste_braco:arms()});

test('conversion refuses cross-campaign UTM orders as a cohort denominator instead of fabricating zero or over100%',()=>{
 const api={crm_campanha:[campaign()],crm_conversao:[
  {marca:'fish',canal:'email',utm_campaign:'another',utm_term:'a',dia:'2026-06-01',pedidos_ultimo:110},
  {marca:'fish',canal:'whatsapp',utm_term:'a',dia:'2026-09-19',pedidos_ultimo:30}]};
 const t=experiment({metrica_primaria:'conversao'});assert.equal(G.metricaDoBraco(api,t,arms()[0]),null);assert.match(G.avaliaBraco(api,t,arms()[0]).reason,/grupo alocado/);
 assert.equal(G.metricaDoBraco({...api,crm_conversao:[]},t,arms()[0]),null);
});
test('arm metrics bind brand, channel and campaign identity and reject ambiguous snapshots',()=>{
 const api={crm_campanha:[campaign({canal:'whatsapp',clicaram:90}),campaign({marca:'aristo',clicaram:80}),campaign()]};
 assert.deepEqual(G.metricaDoBraco(api,experiment(),arms()[0]),{n:100,x:10,rot:'CTR'});
 assert.equal(G.metricaDoBraco({...api,crm_campanha:[campaign(),campaign()]},experiment(),arms()[0]),null);
 assert.equal(G.metricaDoBraco(api,experiment(),{campanha_id:null}),null);
});
test('missing, fractional, boolean, negative, truncated or incompatible bases never become valid rates',()=>{
 for(const patch of [{clicaram:null},{clicaram:''},{clicaram:false},{clicaram:-1},{clicaram:1.2},{clicaram:101},{entregues:0},{entregues:null},{truncado:true},{tipo:'agendada'}])assert.equal(G.metricaDoBraco({crm_campanha:[campaign(patch)]},experiment(),arms()[0]),null,JSON.stringify(patch));
 assert.deepEqual(G.metricaDoBraco({crm_campanha:[campaign({clicaram:0,entregues:'100'})]},experiment(),arms()[0]),{n:100,x:0,rot:'CTR'});
 assert.equal(G.metricaDoBraco({crm_campanha:[campaign({abriram:4,clicaram:5})]},experiment({metrica_primaria:'ctor'}),arms()[0]),null);
 assert.equal(G.compara({n:100,x:110},{n:100,x:50}).status,'dados_invalidos');
});
test('a large descriptive difference cannot manufacture a winner, mature window or assignment',()=>{
 const api=payload(),result=G.analisaTeste(api,experiment(),arms());assert.equal(result.status,'descritivo');assert.equal(result.canDeclareWinner,false);assert.equal(result.causal,false);assert.equal(result.difference,13);
 assert.equal(G.compara(result.arms[0].metric,result.arms[1].metric).status,'conclusivo'); // old presentation would declare a winner
 const duplicate=arms().map(b=>({...b,campanha_id:1}));assert.equal(G.analisaTeste(api,experiment(),duplicate).difference,null);
});
test('three registered arms keep their own metrics and do not silently reuse armB',()=>{
 const api=payload();api.crm_campanha.push(campaign({campanha_id:3,entregues:10000,clicaram:4000}));
 const result=G.analisaTeste(api,experiment(),[...arms(),{braco:'c',campanha_id:3}]);assert.deepEqual(result.arms.map(a=>a.metric.x),[200,1500,4000]);assert.equal(result.difference,null);assert.equal(result.canDeclareWinner,false);
});

function boot(api,opts={}){
 const html=fs.readFileSync(path.join(__dirname,'../growth.html'),'utf8'),{document,window}=parseHTML(html),calls=[];
 const source=html.slice(html.indexOf('function renderTestes(){'),html.indexOf('\nfunction render(){',html.indexOf('function renderTestes(){')));
 const registration=html.slice(html.indexOf('async function salvarTeste(){'),html.indexOf('// Marca, periodo e aba persistem',html.indexOf('async function salvarTeste(){')));
 const context=vm.createContext({API:api,AB_PENDENTES:new Map(),AB_CHAVE_SESSAO:'',AB_LEITURA:0,MARCA:'todas',CANAL:'todos',G,document,window,$:s=>document.querySelector(s),esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),nf:v=>String(v),AB_API_URL:'https://synthetic.invalid/ab',localStorage:{getItem:()=>opts.noWriteKey?null:'dummy-synthetic',setItem:()=>{},removeItem:()=>{}},carregar:async()=>{if(opts.readback){context.API=opts.readback;vm.runInContext('AB_LEITURA++;renderTestes();',context);}},prompt:()=>{throw Error('unexpected prompt');},confirm:()=>{throw Error('unexpected override');},fetch:async(url,init)=>{calls.push(JSON.parse(init.body));if(opts.networkError)throw Error('synthetic network loss');return {status:200,ok:true,json:async()=>{if(opts.invalidJson)throw Error('empty body');return opts.receipt??{ok:true,gravado_em:new Date().toISOString()};}};}});
 vm.runInContext(source+'\n'+registration+'\nrenderTestes();',context);return {document,window,calls,run:s=>vm.runInContext(s,context)};
}
test('UI reports descriptive snapshots, no winner suggestion, and closes only a manual inconclusive record',async()=>{
 const x=boot(payload()),text=x.document.querySelector('#area-testes').textContent;
 assert.match(text,/Comparação descritiva, sem vencedor automático/);assert.match(text,/dados acumulados/);assert.match(text,/não muda com o filtro de período/);assert.doesNotMatch(text,/Braço [AB] venceu|p=|Conclusivo\./);
 assert.equal(x.document.querySelector('.e-venc'),null);assert.equal(x.calls.length,0);
 x.document.querySelector('.btn-encerrar').click();x.document.querySelector('.e-conc').value='Observação operacional, sem conclusão causal.';await x.run('encerrarTeste("synthetic-ab")');
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].teste.status,'inconclusivo');assert.equal(x.calls[0].teste.vencedor,null);
});
test('UI labels historical winner as an unvalidated annotation and explains missing conversion',()=>{
 const api=payload();api.crm_teste=[experiment({status:'conclusivo',vencedor:'a',metrica_primaria:'conversao'})];
 const x=boot(api),text=x.document.querySelector('#area-testes').textContent;assert.match(text,/Vencedor anotado no registro anterior: A/);assert.match(text,/não foi revalidada/);assert.match(text,/Conversão indisponível/);assert.equal(x.document.querySelector('.btn-encerrar'),null);
});
test('UI has a distinct card for each arm and escapes descriptions',()=>{
 const api=payload();api.crm_campanha.push(campaign({campanha_id:3,entregues:10000,clicaram:4000}));api.crm_teste_braco.push({teste_id:'synthetic-ab',braco:'c',campanha_id:3,descricao:'<img src=x onerror=alert(1)>'});
 const x=boot(api),cards=[...x.document.querySelectorAll('.braco')];assert.deepEqual(cards.map(c=>c.querySelector('.m').textContent),['2.00%','15.00%','40.00%']);assert.equal(x.document.querySelector('#area-testes img'),null);
});


test('legacy receipt requires explicit acknowledgment and a contemporary timestamp, with bounded clock skew',()=>{
 const start=Date.parse('2026-09-19T20:00:00Z'),end=start+20000;
 for(const value of [null,{},[],{ok:false,gravado_em:new Date(start).toISOString()},{ok:true},{ok:true,gravado_em:'invalid'},{ok:true,gravado_em:'2026-09-18T20:00:00Z'},{ok:true,gravado_em:'2026-09-20T20:00:00Z'}])assert.equal(G.reciboTesteValido(value,start,end),false);
 assert.equal(G.reciboTesteValido({ok:true,gravado_em:new Date(start-30000).toISOString()},start,end),true);
 assert.equal(G.reciboTesteValido({ok:true,gravado_em:new Date(start-120000).toISOString()},start,end),false,'two-minute clock mismatch stays uncertain');
 assert.equal(G.reciboTesteValido({ok:true,gravado_em:new Date(end).toISOString()},start,end),true);
});
test('closing a record never reports success or retries for empty, false or stale HTTP200 receipts',async()=>{
 for(const opts of [{invalidJson:true},{receipt:{ok:false,gravado_em:new Date().toISOString()}},{receipt:{ok:true,gravado_em:'2000-01-01T00:00:00Z'}}]){
  const x=boot(payload(),opts);x.document.querySelector('.btn-encerrar').click();x.document.querySelector('.e-conc').value='Observação sintética.';
  await x.run('encerrarTeste("synthetic-ab")');const msg=x.document.querySelector('.e-msg').textContent;
  assert.match(msg,/sem confirmação/);assert.doesNotMatch(msg,/Encerrado|aceito/);assert.equal(x.calls.length,1,'no automatic mutation retry');
 }
});
test('all A/B input fields have associated labels and closing feedback is announced',()=>{
 const {document}=parseHTML(fs.readFileSync(path.join(__dirname,'../growth.html'),'utf8'));
 for(const input of document.querySelectorAll('#form-teste input,#form-teste select,#form-teste textarea')){
  assert.ok(input.getAttribute('aria-label')||document.querySelector('label[for="'+input.id+'"]'),input.id+' needs an explicit accessible label');
 }
 const x=boot(payload());assert.equal(x.document.querySelector('.e-conc').getAttribute('aria-label'),'Conclusão do registro');assert.equal(x.document.querySelector('.e-msg').getAttribute('role'),'status');
});

test('registration keeps the form and its values for empty, false and stale receipts; accepted receipt requests a refresh',async()=>{
 for(const opts of [{invalidJson:true},{receipt:{ok:false,gravado_em:new Date().toISOString()}},{receipt:{ok:true,gravado_em:'2000-01-01T00:00:00Z'}},{}]){
  const x=boot(payload(),opts),form=x.document.querySelector('#form-teste');form.hidden=false;
  for(const [id,value] of Object.entries({'f-id':'new-synthetic-ab','f-nome':'Registro sintético','f-hip':'Hipótese','f-efeito':'1','f-da':'A','f-db':'B'}))x.document.getElementById(id).value=value;
  await x.run('salvarTeste()');const msg=x.document.getElementById('f-msg').textContent;
  assert.equal(x.calls.length,1);assert.equal(x.calls[0].acao,'criar');assert.equal(x.calls[0].teste.teste_id,'new-synthetic-ab');
  if(Object.keys(opts).length){assert.match(msg,/sem confirmação/);assert.equal(form.hidden,false);assert.equal(x.document.getElementById('f-id').value,'new-synthetic-ab');}
  else{assert.match(msg,/aceita pelo cadastro/);assert.equal(form.hidden,false);assert.equal(x.document.getElementById('f-salvar').disabled,true);}
 }
});


test('unknown A/B mutation stays blocked across render and only a fresh matching readback releases it',async()=>{
 for(const opts of [{invalidJson:true},{networkError:true}]){
  const x=boot(payload(),opts);x.document.querySelector('.e-conc').value='Conclusão sintética.';await x.run('encerrarTeste("synthetic-ab")');
  assert.equal(x.document.querySelector('.e-salvar').disabled,true);x.run('renderTestes()');assert.equal(x.document.querySelector('.e-salvar').disabled,true);
  x.document.querySelector('.e-conc').value='Conclusão sintética.';await x.run('encerrarTeste("synthetic-ab")');assert.equal(x.calls.length,1);
  x.run('API.crm_teste[0]={...API.crm_teste[0],status:"inconclusivo",vencedor:null,conclusao:"Conclusão sintética."};renderTestes()');
  assert.equal(x.run('AB_PENDENTES.size'),1,'old snapshot cannot clear an uncertain operation');
  x.run('AB_LEITURA++;renderTestes()');assert.equal(x.run('AB_PENDENTES.size'),0);assert.match(x.document.querySelector('#ab-status').textContent,/conferido nos dados atuais/);
 }
});
test('A/B explicit password field works without prompt and missing key never submits',async()=>{
 const x=boot(payload(),{noWriteKey:true}),input=x.document.querySelector('#ab-chave');input.focus=()=>{};
 x.document.querySelector('.e-conc').value='Conclusão sintética.';await x.run('encerrarTeste("synthetic-ab")');assert.equal(x.calls.length,0);assert.match(x.document.querySelector('.e-msg').textContent,/Informe a chave/);
 input.value='synthetic-inline-write';await x.run('encerrarTeste("synthetic-ab")');assert.equal(x.calls.length,1);assert.equal(x.calls[0].k,'synthetic-inline-write');assert.equal(input.value,'');assert.equal(input.getAttribute('type'),'password');
 assert.equal(x.run('JSON.stringify([...AB_PENDENTES.values()]).includes("synthetic-inline-write")'),false,'pending journal never retains the key');
});
test('A/B readback binds ID, status, fields and all arms; response alone cannot prove identity',()=>{
 const t=experiment(),bs=arms().map(b=>({...b,descricao:''})),request={acao:'criar',teste:t,bracos:bs},api={crm_teste:[t],crm_teste_braco:bs};
 assert.equal(G.registroTesteConfere(api,request),true);
 assert.equal(G.registroTesteConfere({...api,crm_teste:[{...t,teste_id:'another'}]},request),false);
 assert.equal(G.registroTesteConfere({...api,crm_teste:[{...t,status:'inconclusivo'}]},request),false);
 assert.equal(G.registroTesteConfere({...api,crm_teste_braco:[bs[0]]},request),false);
 assert.equal(G.registroTesteConfere({...api,crm_teste_braco:[bs[0],{...bs[1],campanha_id:99}]},request),false);
 assert.equal(G.registroTesteConfere({...api,crm_teste:[{...t,hipotese:'modified'}]},request),false);
 const close={acao:'encerrar',teste:{teste_id:t.teste_id,status:'inconclusivo',vencedor:null,conclusao:'Observação'}};
 assert.equal(G.registroTesteConfere(api,close),false);assert.equal(G.registroTesteConfere({crm_teste:[{...t,...close.teste}]},close),true);
 assert.equal(G.registroTesteConfere({crm_teste:[{...t,...close.teste,vencedor:'a'}]},close),false);
});
