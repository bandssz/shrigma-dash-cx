'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),G=require('../growth-data'),GABJ=require('../growth-ab-journal'),GABServer=require('../growth-ab-server'),ABProtocol=require('../n8n/growth/ab-registry.cjs'),crypto=require('node:crypto');
function locks(){let held=false;return {async request(name,opts,fn){if(held)return fn(null);held=true;try{return await fn({name});}finally{held=false;}}};}
const campaign=(extra={})=>({marca:'fish',canal:'email',tipo:'enviada',campanha_id:1,entregues:100,abriram:40,clicaram:10,truncado:false,enviado_em:'2026-09-01T12:00:00Z',...extra});
const experiment=(extra={})=>({teste_id:'synthetic-ab',marca:'fish',canal:'email',metrica_primaria:'ctr',nome:'Comparação sintética',hipotese:'Hipótese registrada',variavel:'assunto',efeito_minimo:1,status:'rodando',registry_version:0,...extra});
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
 assert.equal(result.relativeDifference,650);
 assert.equal(G.compara(result.arms[0].metric,result.arms[1].metric).status,'conclusivo'); // old presentation would declare a winner
 const duplicate=arms().map(b=>({...b,campanha_id:1}));assert.equal(G.analisaTeste(api,experiment(),duplicate).difference,null);
});
test('relative A/B difference remains unavailable when arm A is zero',()=>{
 const api=payload();api.crm_campanha[0].clicaram=0;const result=G.analisaTeste(api,experiment(),arms());
 assert.equal(result.difference,15);assert.equal(result.relativeDifference,null);
});
test('three registered arms keep their own metrics and do not silently reuse armB',()=>{
 const api=payload();api.crm_campanha.push(campaign({campanha_id:3,entregues:10000,clicaram:4000}));
 const result=G.analisaTeste(api,experiment(),[...arms(),{braco:'c',campanha_id:3}]);assert.deepEqual(result.arms.map(a=>a.metric.x),[200,1500,4000]);assert.equal(result.difference,null);assert.equal(result.canDeclareWinner,false);
});

function serverFixture(api){return {records:new Map((api.crm_teste||[]).map(t=>[t.teste_id,{teste:structuredClone(t),bracos:structuredClone((api.crm_teste_braco||[]).filter(b=>b.teste_id===t.teste_id))}])),operations:new Map()};}
function boot(api,opts={}){
 const html=fs.readFileSync(path.join(__dirname,'../growth.html'),'utf8'),{document,window}=parseHTML(html),calls=[],reads=[],remote=opts.remote||serverFixture(api);
 // Browser option.value falls back to text; browser selects default to the first option.
 for(const option of document.querySelectorAll('option'))if(!option.hasAttribute('value'))option.setAttribute('value',option.textContent);
 for(const select of document.querySelectorAll('select'))if(select.value===undefined&&select.options.length)select.options[0].selected=true;
 const source=html.slice(html.indexOf('function renderTestes(){'),html.indexOf('\nfunction render(){',html.indexOf('function renderTestes(){')));
 const registration=html.slice(html.indexOf('async function salvarTeste(){'),html.indexOf('// Marca, periodo e aba persistem',html.indexOf('async function salvarTeste(){')));
 const stored=opts.storage||new Map(opts.noWriteKey?[]:[['shrigma_ab_key','dummy-synthetic']]);
 const response=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>structuredClone(body)});
 async function fetchFixture(url,init){
  assert.ok(init&&['GET','POST'].includes(init.method),'request must declare its method');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
  const u=new URL(url),q=Object.fromEntries(u.searchParams),body=init.method==='POST'?JSON.parse(init.body):null,key=body?.k||init.headers['X-AB-Write-Key'];
  const actor=crypto.createHash('sha256').update(key||'').digest('hex');
  if(init.method==='GET'){
   reads.push({query:q,headers:structuredClone(init.headers)});assert.equal(u.searchParams.has('k'),false,'write key must stay out of query URLs');
   if(opts.getError===q.acao)throw Error('synthetic read unavailable');
   if(q.acao==='capacidades')return response(200,opts.capabilities??{contract:'ab_registry_v1',write:true,operation:true,record:true,causal_engine:false});
   if(q.acao==='registro')return response(200,{contract:'ab_registry_record_v1',teste_id:q.teste_id,record:opts.recordMissing?null:remote.records.get(q.teste_id)??null});
   assert.equal(q.acao,'operacao','GET is receipt/read-only allowlist');
   const found=remote.operations.get(q.operation_id),visible=found&&found.actor_sha256===actor&&found.action===q.operacao&&found.teste_id===q.teste_id;
   if(visible&&opts.lookupError)throw Error('synthetic receipt read unavailable');
   const op=visible&&!opts.lookupMissing?structuredClone(found):{operation_id:q.operation_id,actor_sha256:actor,action:q.operacao,teste_id:q.teste_id,state:'missing',request_payload:null,response:null,created_at:null,finished_at:null};
   if(visible&&opts.lookupTransform)opts.lookupTransform(op);
   return response(200,{contract:'ab_registry_operation_v1',operation:op});
  }
  calls.push(body);const p=ABProtocol.request(body,actor),current=remote.records.get(p.teste_id),request=p.request_payload;
  let record,code='recorded',status=200;
  if(p.action==='criar'&&current){record=current;code='record_exists';status=409;}
  else if(p.action==='encerrar'&&(!current||current.teste.registry_version!==request.expected_version||current.teste.status!=='rodando')){record=current??null;code=!current?'record_missing':current.teste.registry_version!==request.expected_version?'version_conflict':'record_not_running';status=409;}
  else if(p.action==='criar')record={teste:{...request.teste,status:'rodando',registry_version:1,vencedor:null},bracos:request.bracos.map(b=>({...b,teste_id:p.teste_id}))};
  else record={teste:{...current.teste,...request.teste,registry_version:request.expected_version+1},bracos:structuredClone(current.bracos)};
  const receipt={status,body:{contract:'ab_registry_v1',ok:status===200,code,operation_id:p.operation_id,teste_id:p.teste_id,version:record?.teste.registry_version??null,record,gravado_em:new Date().toISOString()}};
  if(opts.commit!==false){if(status===200)remote.records.set(p.teste_id,record);remote.operations.set(p.operation_id,{operation_id:p.operation_id,actor_sha256:actor,action:p.action,teste_id:p.teste_id,state:'completed',request_payload:request,response:receipt,created_at:new Date().toISOString(),finished_at:new Date().toISOString()});}
  if(opts.networkError)throw Error('synthetic network loss after possible commit');
  if(opts.invalidJson)return {status:200,ok:true,json:async()=>{throw Error('empty body');}};
  return response(status,opts.receipt??receipt.body);
 }
 const context=vm.createContext({API:api,GABJ:{...GABJ,create:o=>GABJ.create({...o,uuid:()=>crypto.randomUUID()})},GABServer:{...GABServer,create:o=>GABServer.create({...o,fetch:fetchFixture})},URL,AbortSignal,navigator:{locks:opts.locks||locks()},AB_JOURNAL:null,AB_RECONCILIACAO:null,AB_BLOQUEADO:false,AB_WRITE_EPOCH:0,AB_PROVA_LEITURA:{startedAt:Date.now(),completedAt:Date.now()},AB_PENDENTES:new Map(),AB_CHAVE_SESSAO:'',AB_LEITURA:0,MARCA:'todas',CANAL:'todos',G,document,window,$:s=>document.querySelector(s),esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),nf:v=>String(v),AB_API_URL:'https://synthetic.invalid/ab',localStorage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},carregar:async()=>{if(opts.readback){context.API=opts.readback;vm.runInContext('AB_LEITURA++;AB_PROVA_LEITURA={startedAt:Date.now(),completedAt:Date.now()};renderTestes();',context);}},prompt:()=>{throw Error('unexpected prompt');},confirm:()=>{throw Error('unexpected override');},fetch:fetchFixture});
 vm.runInContext(source+'\n'+registration+'\nrenderTestes();',context);return {document,window,calls,reads,remote,stored,run:s=>vm.runInContext(s,context)};
}
test('UI reports descriptive snapshots, no winner suggestion, and closes only a manual inconclusive record',async()=>{
 const x=boot(payload()),text=x.document.querySelector('#area-testes').textContent;
 assert.match(text,/Diferença observada B − A/);assert.match(text,/\+13,00 p\.p\./);assert.match(text,/\+650,0% em relação à taxa de A/);
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
test('closing stays uncertain for empty, false or stale POST receipt when the durable GET is missing',async()=>{
 for(const opts of [{invalidJson:true,lookupMissing:true},{receipt:{ok:false,gravado_em:new Date().toISOString()},lookupMissing:true},{receipt:{ok:true,gravado_em:'2000-01-01T00:00:00Z'},lookupMissing:true}]){
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

test('registration preserves values while the durable receipt is missing and closes only after exact GET confirmation',async()=>{
 for(const opts of [{invalidJson:true,lookupMissing:true},{receipt:{ok:false,gravado_em:new Date().toISOString()},lookupMissing:true},{receipt:{ok:true,gravado_em:'2000-01-01T00:00:00Z'},lookupMissing:true},{}]){
  const x=boot(payload(),opts),form=x.document.querySelector('#form-teste');form.hidden=false;
  for(const [id,value] of Object.entries({'f-id':'new-synthetic-ab','f-nome':'Registro sintético','f-hip':'Hipótese','f-efeito':'1','f-da':'A','f-db':'B'}))x.document.getElementById(id).value=value;
  await x.run('salvarTeste()');const msg=x.document.getElementById('f-msg').textContent;
  assert.equal(x.calls.length,1,msg+' '+JSON.stringify(Object.fromEntries(['f-marca','f-canal','f-var','f-met'].map(id=>[id,x.document.getElementById(id).value]))));assert.equal(x.calls[0].acao,'criar');assert.equal(x.calls[0].teste.teste_id,'new-synthetic-ab');
  if(Object.keys(opts).length){assert.match(msg,/sem confirmação/);assert.equal(form.hidden,false);assert.equal(x.document.getElementById('f-id').value,'new-synthetic-ab');}
  else{assert.doesNotThrow(()=>ABProtocol.request(x.calls[0],'a'.repeat(64)),JSON.stringify(x.calls[0]));assert.match(msg,/confirmados pelo recibo/);assert.equal(form.hidden,true);assert.equal(JSON.parse(x.stored.get(GABJ.SLOT)).operations[0].phase,'confirmed');assert.ok(x.reads.some(r=>r.query.acao==='operacao'));}
 }
});


test('unknown server operation remains blocked even when a fresh registry snapshot coincides',async()=>{
 for(const opts of [{invalidJson:true,lookupMissing:true},{networkError:true,lookupMissing:true}]){
  const x=boot(payload(),opts);x.document.querySelector('.e-conc').value='Conclusão sintética.';await x.run('encerrarTeste("synthetic-ab")');
  assert.equal(x.document.querySelector('.e-salvar').disabled,true);x.run('renderTestes()');assert.equal(x.document.querySelector('.e-salvar').disabled,true);
  x.document.querySelector('.e-conc').value='Conclusão sintética.';await x.run('encerrarTeste("synthetic-ab")');assert.equal(x.calls.length,1);
  x.run('API.crm_teste[0]={...API.crm_teste[0],status:"inconclusivo",vencedor:null,conclusao:"Conclusão sintética."};renderTestes()');
  assert.equal(x.run('AB_PENDENTES.size'),1,'old snapshot cannot clear an uncertain operation');
  await x.run('AB_LEITURA++;AB_PROVA_LEITURA={startedAt:Date.now(),completedAt:Date.now()};reconciliaTestesAB()');assert.equal(x.run('AB_PENDENTES.size'),1);assert.equal(x.calls.length,1);assert.match(x.document.querySelector('#ab-status').textContent,/recibo exato|aguardando/);
 }
});
test('A/B explicit password field works without prompt and missing key never submits',async()=>{
 const x=boot(payload(),{noWriteKey:true}),input=x.document.querySelector('#ab-chave');input.focus=()=>{};
 x.document.querySelector('.e-conc').value='Conclusão sintética.';await x.run('encerrarTeste("synthetic-ab")');assert.equal(x.calls.length,0);assert.match(x.document.querySelector('.e-msg').textContent,/Informe a chave/);
 input.value='synthetic-inline-write';await x.run('encerrarTeste("synthetic-ab")');assert.equal(x.calls.length,1);assert.equal(x.calls[0].k,'synthetic-inline-write');assert.equal(input.value,'');assert.equal(input.getAttribute('type'),'password');
 assert.equal(x.run('JSON.stringify([...AB_PENDENTES.values()]).includes("synthetic-inline-write")'),false,'pending journal never retains the key');
});
test('UI reload and another tab preserve an uncertain creation even when the key or test ID changes',async()=>{
 const storage=new Map([['shrigma_ab_key','synthetic-first-key']]),sharedLocks=locks();
 const fill=(x,id)=>{for(const [key,value] of Object.entries({'f-id':id,'f-nome':'Cadastro sintético','f-hip':'Hipótese','f-efeito':'1','f-da':'A','f-db':'B'}))x.document.getElementById(key).value=value;};
 const first=boot(payload(),{storage,locks:sharedLocks,networkError:true,lookupMissing:true});fill(first,'synthetic-pending');await first.run('salvarTeste()');assert.equal(first.calls.length,1,first.document.querySelector('#f-msg').textContent);
 storage.set('shrigma_ab_key','synthetic-different-key');
 for(const id of ['synthetic-pending','synthetic-new-id']){
   const reload=boot(payload(),{storage,locks:sharedLocks});fill(reload,id);await reload.run('salvarTeste()');
   assert.equal(reload.calls.length,0);assert.equal(reload.document.getElementById('f-salvar').disabled,true);
   assert.match(reload.document.getElementById('ab-status').textContent,/recibo exato|aguardando|não corresponde à identidade/);
 }
 const journal=storage.get(GABJ.SLOT);assert.doesNotMatch(journal,/synthetic-first-key|synthetic-different-key/);assert.equal(JSON.parse(journal).operations.length,1);
});
test('exact durable receipt after reload confirms without POST replay; matching rows alone never do',async()=>{
 const storage=new Map([['shrigma_ab_key','synthetic-key']]),sharedLocks=locks(),first=boot(payload(),{storage,locks:sharedLocks,networkError:true,lookupMissing:true});
 first.document.querySelector('.e-conc').value='Observação sintética persistida.';await first.run('encerrarTeste("synthetic-ab")');assert.equal(first.calls.length,1);
 const readback=payload();readback.crm_teste[0]={...readback.crm_teste[0],status:'inconclusivo',vencedor:null,conclusao:'Observação sintética persistida.',registry_version:1};
 const missing=boot(readback,{storage,locks:sharedLocks,remote:first.remote,lookupMissing:true});await missing.run('reconciliaTestesAB()');assert.equal(missing.calls.length,0);assert.equal(missing.run('AB_PENDENTES.size'),1);
 const reload=boot(readback,{storage,locks:sharedLocks,remote:first.remote});await reload.run('reconciliaTestesAB()');
 assert.equal(reload.calls.length,0);assert.equal(reload.run('AB_PENDENTES.size'),0);assert.equal(JSON.parse(storage.get(GABJ.SLOT)).operations[0].phase,'confirmed');assert.ok(reload.reads.every(r=>r.query.acao==='operacao'));
 assert.match(reload.document.getElementById('ab-status').textContent,/Recibo exato.*conferido no servidor/);
});
test('legacy unknown without a server receipt stays frozen after reload despite identical closed rows',async()=>{
 const storage=new Map([['shrigma_ab_key','synthetic-key']]),expected={acao:'encerrar',teste:{teste_id:'synthetic-ab',status:'inconclusivo',vencedor:null,conclusao:'Legacy synthetic note'}};
 storage.set(GABJ.SLOT,JSON.stringify({version:1,revision:1,operations:[{id:crypto.randomUUID(),endpoint:'https://synthetic.invalid/ab',phase:'uncertain',startedAt:Date.now()-1000,expected}]}));
 const api=payload();api.crm_teste[0]={...api.crm_teste[0],...expected.teste};const x=boot(api,{storage});await x.run('reconciliaTestesAB()');
 assert.equal(x.calls.length,0);assert.equal(x.reads.length,0);assert.equal(x.run('AB_PENDENTES.size'),1);assert.equal(JSON.parse(storage.get(GABJ.SLOT)).operations[0].phase,'uncertain');assert.match(x.document.querySelector('#ab-status').textContent,/anterior ao contrato.*coincidência/);
});
test('missing or unavailable server record blocks close before any reservation or mutation',async()=>{
 for(const opts of [{recordMissing:true},{getError:'registro'},{getError:'operacao'}]){
  const x=boot(payload(),opts);x.document.querySelector('.e-conc').value='Synthetic note';await x.run('encerrarTeste("synthetic-ab")');assert.equal(x.calls.length,0);assert.equal(x.stored.has(GABJ.SLOT),false);assert.match(x.document.querySelector('.e-msg').textContent,/não foi lida|sem confirmação|não confirmado/);
 }
});
test('wrong actor, operation, frozen payload or version in a completed GET never releases the UI journal',async()=>{
 for(const lookupTransform of [op=>op.actor_sha256='b'.repeat(64),op=>op.response.body.operation_id=crypto.randomUUID(),op=>op.request_payload.teste.conclusao='different frozen note',op=>op.response.body.version++]){
  const x=boot(payload(),{lookupTransform});x.document.querySelector('.e-conc').value='Frozen synthetic note';await x.run('encerrarTeste("synthetic-ab")');
  assert.equal(x.calls.length,1);assert.equal(x.run('AB_PENDENTES.size'),1);assert.equal(JSON.parse(x.stored.get(GABJ.SLOT)).operations[0].phase,'uncertain');assert.equal(x.document.querySelector('.e-salvar').disabled,true);
  await x.run('encerrarTeste("synthetic-ab")');assert.equal(x.calls.length,1,'identity failure cannot cause a second POST');
 }
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
