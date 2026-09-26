'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
function boot(){
 const {document}=parseHTML('<html><body><div id="fontes"></div><div id="crm-channel-status" data-crm-manager-only hidden></div><div id="fluxo-saude"></div><div id="area-kpis"></div><div id="channel-cards"></div><div id="wa-coverage"></div></body></html>');
 const ctx=vm.createContext({document,Date,Intl});vm.runInContext(fs.readFileSync(require.resolve('../growth-ui.js'),'utf8')+'\nthis.GUI=GUI;',ctx);
 return {GUI:ctx.GUI,ctx,document,q:s=>document.querySelector(s),view(role='manager',selector='body'){const copy=document.querySelector(selector).cloneNode(true);copy.querySelectorAll(role==='manager'?'[data-crm-owner-only]':'[data-crm-manager-only]').forEach(n=>n.remove());return copy;}};
}
const sources=()=>({crm_fontes:[
 {fonte:'shopify_conversao',rotulo:'Shopify API crm_conversao',tipo:'coleta',coletado_em:'2026-09-26T12:00:00Z',status:'ok'},
 {fonte:'listmonk_snapshot',rotulo:'Listmonk coletor',tipo:'coleta',coletado_em:'2026-09-26T11:00:00Z',status:'atrasado'},
 {fonte:'wa_status_meta',rotulo:'Meta push',tipo:'evento',coletado_em:'2026-09-26T10:00:00Z',status:'evento'},
 {fonte:'inventario_operacao',rotulo:'inventário workflows',tipo:'coleta',coletado_em:'2026-09-26T09:00:00Z',status:'ok'},
 {fonte:'wa_saude',rotulo:'API Meta',tipo:'coleta',coletado_em:'2026-09-26T08:00:00Z',status:'erro',erro:'HTTP500 workflow secret-fixture'},
 {fonte:'wa_fluxo_saude',rotulo:'QA collector',tipo:'coleta',coletado_em:'2026-09-26T07:00:00Z',status:'unknown'},null
]});
test('manager sources preserve distinct clocks and failures without showing implementation names; owner diagnostics stay collapsed',()=>{
 const x=boot(),api=sources(),before=JSON.stringify(api),items=x.GUI.sources({api,consulta:{em:'2026-09-26T13:00:00Z',falhou:true}}),view=x.view();
 assert.deepEqual([...view.querySelectorAll('.crm-source-group > strong')].map(e=>e.textContent),['Vendas','E-mail','WhatsApp','Automações']);
 for(const clock of ['09:00','08:00','07:00','06:00','05:00','04:00'])assert.ok(view.textContent.includes(clock),clock);
 assert.match(view.textContent,/Atualização atrasada/);assert.match(view.textContent,/Último sucesso:/);assert.match(view.textContent,/Atualização não confirmada/);assert.match(view.textContent,/Última confirmação:/);
 assert.match(view.textContent,/Não foi possível atualizar o painel/);assert.match(view.textContent,/peça uma revisão/);assert.match(view.textContent,/Parte das informações/);
 assert.doesNotMatch(view.textContent,/API|push|coletor|crm_|Meta|inventário|QA|workflow|secret-fixture|Listmonk/i);
 const owner=x.q('#fontes [data-crm-owner-only]');assert.equal(owner.hasAttribute('open'),false);assert.match(owner.textContent,/Inventário/);assert.match(owner.innerHTML,/secret-fixture/);assert.equal(items.length,8);assert.equal(JSON.stringify(api),before);
});
test('fallback source clocks and missing data remain visible without inventing a new cadence',()=>{
 const x=boot(),api={crm_conversao:[{coletado_em:'2026-09-26T12:00:00Z'}],crm_diario:[{coletado_em:'2026-09-26T11:00:00Z'}],crm_campanha:[],crm_operacao:{generated_at:'2026-09-26T12:59:00Z'}};
 x.GUI.sources({api,now:Date.parse('2026-09-26T13:00:00Z')},{wa:{coverage:{present:true},ultimo_status_em:'2026-09-26T10:00:00Z'}});
 for(const clock of ['09:00','08:00','07:00','09:59'])assert.ok(x.view().textContent.includes(clock));
 x.GUI.sources({api:{crm_fontes:[{fonte:'shopify_conversao',tipo:'coleta',status:'ok',coletado_em:null}]}});const view=x.view();assert.match(view.textContent,/Horário não disponível/);assert.match(view.textContent,/Atualização não confirmada/);assert.doesNotMatch(view.textContent,/Dados atualizados até/);
});
test('healthy source clocks keep explanations in accessible titles instead of repeating healthy paragraphs',()=>{
 const x=boot(),api=sources();api.crm_fontes=api.crm_fontes.filter(Boolean).map(r=>({...r,status:r.tipo==='evento'?'evento':'ok'}));
 const before=JSON.stringify(api);x.GUI.sources({api});const view=x.view('manager','#fontes');
 assert.equal(view.querySelectorAll('.crm-source-status').length,4);assert.equal(view.querySelectorAll('.crm-source-status p').length,0);
 assert.equal(view.querySelectorAll('.crm-source-status span[tabindex="0"][title]').length,4);
 assert.match(view.querySelector('[data-estado="evento"] span').getAttribute('title'),/Intervalos sem novas confirmações não comprovam falha/);
 assert.doesNotMatch(view.textContent,/Dados atualizados até o horário indicado/);assert.equal(JSON.stringify(api),before);
 api.crm_fontes[0].status='erro';x.GUI.sources({api});assert.match(x.view('manager','#fontes').querySelector('[data-estado="ruim"] p').textContent,/Atualização falhou.*Atualize o painel/);
});
const channelNow=Date.parse('2026-09-26T13:00:00Z');
const account=extra=>({brand:'fish',nome:'Fish · transacional (Mensagem Automática)',estado:'ok',verificado_em:'2026-09-26T12:00:00Z',...extra});
test('account alert survives healthy collection and flow checks without exposing infrastructure or touching totals',()=>{
 const x=boot(),api={...sources(),wa_saude:[account({estado:'alerta',motivo:'private payment code 131042 <script>unsafe</script>',waba_id:'private-account-id',alerta_desde:'2026-09-26T11:00:00Z'})],wa_fluxo_saude:[{chave:'aceite:fish',brand:'fish',estado:'ok'}]};
 api.crm_fontes=api.crm_fontes.filter(Boolean).map(r=>({...r,status:'ok'}));const before=JSON.stringify(api);
 x.GUI.sources({api});x.GUI.flowHealth({api,marca:'fish'});const notices=x.GUI.channelHealth({api,marca:'fish',canal:'email',now:channelNow}),root=x.q('#crm-channel-status');
 assert.equal(notices.length,1);assert.equal(notices[0].state,'alerta');assert.equal(root.hidden,false);assert.match(root.textContent,/Fishermans.*WhatsApp transacional.*Há um alerta/s);
 assert.match(root.textContent,/não comprova interrupção de todos/);assert.match(root.textContent,/26\/09\/2026, 09:00 BRT/);assert.match(root.textContent,/26\/09\/2026, 08:00 BRT/);assert.match(root.textContent,/antes de repetir mensagens/);
 assert.doesNotMatch(root.innerHTML,/private|131042|unsafe|<script>|Mensagem Automática|waba_id/);assert.equal(x.q('#fluxo-saude [data-crm-manager-only]').textContent,'');assert.equal(JSON.stringify(api),before);
});
test('channel health excludes only explicit CX accounts, scopes both CRM brands and leaves healthy accounts quiet',()=>{
 const x=boot(),api={wa_saude:[account({nome:'Fish · SAC (Gleap)',estado:'alerta'}),account(),account({brand:'aristo',nome:'Aristo · SAC (Gleap)',estado:'alerta'}),account({brand:'aristo',nome:'Aristo · transacional (Mensagem Automática)'}),account({brand:'cx',estado:'alerta'}),account({brand:'olivas',estado:'alerta'})]};
 for(const marca of ['fish','aristo','todas','todos']){assert.equal(x.GUI.channelHealth({api,marca,now:channelNow}).length,0);assert.equal(x.q('#crm-channel-status').hidden,true);assert.equal(x.q('#crm-channel-status').innerHTML,'');}
 api.wa_saude[1].estado='alerta';api.wa_saude[3].estado='alerta';assert.equal(x.GUI.channelHealth({api,marca:'todas',now:channelNow}).length,2);
 for(const marca of ['fish','aristo'])assert.equal(x.GUI.channelHealth({api,marca,now:channelNow}).length,1);
 assert.equal(x.GUI.channelHealth({api,marca:'olivas',now:channelNow}).length,0);assert.equal(x.q('#crm-channel-status').hidden,true);
 const unknown={wa_saude:[account({nome:'unrecognized account <img src=x>',estado:'degraded'})]};const out=x.GUI.channelHealth({api:unknown,marca:'fish',now:channelNow});assert.equal(out[0].state,'desconhecido');assert.match(x.q('#crm-channel-status').textContent,/Conta da marca/);assert.doesNotMatch(x.q('#crm-channel-status').innerHTML,/transacional|unrecognized|<img/);
});
test('account freshness preserves a two-hour boundary and does not turn stale or invalid checks into a current outage',()=>{
 const x=boot();
 for(const [verificado_em,estado,state] of [['2026-09-26T11:00:00Z','ok',null],['2026-09-26T10:59:59.999Z','ok','desatualizado'],['2026-09-26T10:00:00Z','alerta','desatualizado'],[null,'alerta','desconhecido'],['invalid','ok','desconhecido'],['2026-09-26T13:05:00Z','ok',null],['2026-09-26T13:05:00.001Z','alerta','desconhecido']]){
  const result=x.GUI.channelHealth({api:{wa_saude:[account({verificado_em,estado})]},marca:'fish',now:channelNow});assert.equal(result[0]?.state||null,state);
  const text=x.q('#crm-channel-status').textContent;if(state)assert.match(text,/Atualize o painel/);if(state==='desatualizado')assert.match(text,/mais de 2 horas/);if(state!=='alerta')assert.doesNotMatch(text,/Há um alerta nesta conta/);
 }
 for(const api of [{},{wa_saude:[]},{wa_saude:[null,account({nome:'Fish · SAC (Gleap)',estado:'alerta'})]}]){const out=x.GUI.channelHealth({api,marca:'fish',now:channelNow});assert.equal(out.length,1);assert.equal(out[0].state,'desconhecido');assert.match(x.q('#crm-channel-status').textContent,/ausência de verificação não confirma funcionamento/);}
});
test('manager health retains operational alerts, unknown states, time and safe action without repeated healthy services or test-only alerts',()=>{
 const x=boot(),api={wa_fluxo_saude:[
  {chave:'aceite:fish',brand:'fish',nome:'API Meta workflow secret-id',estado:'alerta',motivo:'crm_wa SQL bad <script>oops</script>',n_aceites:40,verificado_em:'2026-09-26T12:00:00Z',alerta_desde:'2026-09-26T11:00:00Z'},
  {chave:'gatilho:fish:pedido-pago',brand:'fish',nome:'coletor saudável',estado:'ok',verificado_em:'2026-09-26T12:00:00Z'},
  {chave:'unknown:fish',brand:'fish',nome:'Inventário QA',estado:null,verificado_em:null},
  {chave:'qa:aceite:fish',brand:'fish',nome:'QA',estado:'alerta',motivo:'test only'},
  {chave:'aceite:aristo',brand:'aristo',nome:'Aristo private',estado:'alerta'},{chave:'aceite:cx',brand:'cx',nome:'Outside CRM',estado:'alerta'},null
 ]},before=JSON.stringify(api),alerts=x.GUI.flowHealth({api,marca:'fish'}),view=x.view('manager','#fluxo-saude');
 assert.equal(alerts.length,2);assert.equal(view.querySelectorAll('.crm-health-notice').length,3);assert.match(view.textContent,/40 envios aceitos/);assert.match(view.textContent,/26\/09\/2026, 09:00 BRT/);assert.match(view.textContent,/26\/09\/2026, 08:00 BRT/);
 assert.match(view.textContent,/Não foi possível confirmar/);assert.match(view.textContent,/trate como histórico/);assert.match(view.textContent,/antes de repetir uma mensagem/);assert.match(view.textContent,/Parte das verificações/);
 assert.doesNotMatch(view.textContent,/API|Meta|workflow|secret-id|crm_|SQL|QA|test only|saudável|Aristo private/i);assert.equal(view.querySelectorAll('button').length,0);
 const owner=x.q('#fluxo-saude [data-crm-owner-only]');assert.equal(owner.hasAttribute('open'),false);assert.match(owner.textContent,/secret-id/);assert.match(owner.textContent,/test only/);assert.equal(owner.querySelector('script'),null);assert.equal(JSON.stringify(api),before);
 x.GUI.flowHealth({api,marca:'todas'});assert.doesNotMatch(x.view('manager','#fluxo-saude').textContent,/Outside CRM|aceite:cx/);
});
test('absent health and an empty brand selection do not become a healthy claim',()=>{
 const x=boot();x.GUI.flowHealth({api:{}});assert.match(x.view().textContent,/Verificação das automações indisponível/);
 x.GUI.flowHealth({api:{wa_fluxo_saude:[{chave:'aceite:aristo',brand:'aristo',estado:'ok'}]},marca:'fish'});assert.match(x.view().textContent,/Sem verificação para este recorte/);
 x.GUI.flowHealth({api:{wa_fluxo_saude:[{chave:'aceite:fish',brand:'fish',estado:'ok'}]},marca:'fish'});assert.equal(x.view('manager','#fluxo-saude').textContent,'');
});
test('overview keeps the same figures and coverage caveats while naming business channels instead of providers',()=>{
 const x=boot(),summary={enviados:142,receita:42,pedidos:2,conv:[{canal:'whatsapp',receita:12,pedidos:1},{canal:'email',receita:30,pedidos:1}],wa:{aceitos:42,entregues:40,falhas:1,pendentes_entrega:1,lidos:5,entrega_pct:95.24,coverage:{present:true,complete:true},sem_disparo_confirmado:3,erros_sincronos:2,testes_aceitos:1},email:{enviados:100,campanhas_enviados:75,automacoes_enviados:25,ctr:10,ctor:20,abertura:50,medidasCliques:1,pecas:2,medidas:1,medidasConjuntas:1,baseCliques:75,baseAbertura:75}};
 const before=JSON.stringify(summary);x.GUI.attention=()=>{};
 const result=x.GUI.overview({api:{crm_conversao:[],_attribution_model:'last_click'},G:{anterior:()=>({ini:'2026-08-01',fim:'2026-08-02'}),delta:()=>null},GD:{summary:()=>summary},marca:'fish',canal:'whatsapp',ini:'2026-09-01',fim:'2026-09-02'});
 assert.equal(result,summary);assert.equal(x.q('.kpi-val').textContent,'142');assert.equal(x.q('.kpi-rot').textContent,'Envios aceitos');assert.equal(JSON.stringify(summary),before);
 x.GUI.overview({api:{crm_conversao:[]},G:{anterior:()=>({})},GD:{summary:()=>summary},marca:'fish',canal:'email'});
 const view=x.view();assert.match(view.textContent,/1 de 2 peças com clique medido/);assert.match(view.textContent,/consulta de entregas indisponível/);assert.match(view.textContent,/Aberturas e cliques das automações não estão medidos/);assert.match(view.textContent,/Reputação de envio/);assert.doesNotMatch(view.textContent,/Listmonk|SES|Reportana|Meta/);
 assert.match(x.view('owner','#channel-cards').textContent,/Campanhas Listmonk e automações SES/);
});
test('overview calls account health for an email recut without changing the summary or its events',()=>{
 const x=boot(),summary={enviados:2,receita:0,pedidos:0,conv:[],wa:{},email:{enviados:2}},before=JSON.stringify(summary);
 x.GUI.attention=()=>{};
 const result=x.GUI.overview({api:{crm_conversao:[],wa_saude:[account({estado:'alerta'})]},G:{anterior:()=>({})},GD:{summary:()=>summary},marca:'fish',canal:'email',now:channelNow});
 assert.equal(result,summary);assert.equal(JSON.stringify(summary),before);assert.equal(x.q('#crm-channel-status').hidden,false);assert.match(x.q('#crm-channel-status').textContent,/Há um alerta/);
});
