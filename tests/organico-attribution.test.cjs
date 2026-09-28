const test=require('node:test'),assert=require('node:assert/strict');
const OA=require('../organico-attribution.js');
const row=(o={})=>({marca:'aristo',dia:'2026-09-19',model:'last_click',classification:'editorial',detail_level:'utm',rule_version:'organico-utm-20260927-v2',
 rede:'instagram',superficie:'story',utm_source:'instagram_social',utm_medium:'story',utm_campaign:'20260919_teste',utm_content:'',utm_term:'',
 pedidos:2,receita_liquida:'300.50',...o});
const quality=(marca='aristo',o={})=>({marca,dia:'2026-09-19',pedidos_lidos:11,pagos_elegiveis:10,jornada_pendente:1,jornada_parcial:0,
 ultima_sessao_conhecida:9,ultima_sessao_desconhecida:1,origem_nao_direta_desconhecida:2,...o});
const fixture=(o={})=>({organico_attribution:{schema_version:1,rule_version:'organico-utm-20260927-v2',default_model:'last_click',window_days:30,
 source_system:'shopify',currency:'BRL',utm_raw_available:false,assistance_available:false,
 daily:[row(),row({classification:'bio',superficie:'bio',receita_liquida:100}),row({classification:'automacao_dm',utm_medium:'dm',receita_liquida:200}),
  row({classification:'midia_paga',utm_source:'facebook',utm_medium:'paid',receita_liquida:90}),
  row({classification:'crm',utm_source:'listmonk',utm_medium:'campanha',receita_liquida:70}),row({classification:'nao_classificado',utm_source:'',utm_medium:'',receita_liquida:50}),
  row({model:'last_non_direct',pedidos:4,receita_liquida:600}),row({marca:'fish',pedidos:1,receita_liquida:80}),row({dia:'2026-09-18',receita_liquida:999})],
 quality:[quality(),quality('fish'),quality('olivas')],
 coverage:['aristo','fish','olivas'].map(marca=>({marca,dia:'2026-09-19',checked_at:'2026-09-19T18:12:00Z'})),...o}});
const group=(v,k)=>v.groups.find(g=>g.key===k);

test('modelo estrito é padrão; mantém cada classe e marca separada sem somar comparação',()=>{
 const api=fixture(),before=JSON.stringify(api),v=OA.select(api,'aristo','2026-09-19','2026-09-19');
 assert.equal(v.model,'last_click');assert.equal(v.rows.length,6);
 assert.equal(group(v,'editorial').pedidos,2);assert.equal(group(v,'editorial').receita,300.5);
 assert.equal(group(v,'bio').receita,100);assert.equal(group(v,'automacao_dm').receita,200);
 assert.equal(group(v,'legado_ambiguo'),undefined,'balde legado não existe mais');assert.equal(group(v,'midia_paga').receita,90);
 assert.equal(group(v,'crm').receita,70);assert.equal(group(v,'nao_classificado').receita,50);
 const comparison=OA.select(api,'aristo','2026-09-19','2026-09-19','last_non_direct');
 assert.equal(group(comparison,'editorial').receita,600);assert.equal(comparison.coverage[0].unknown,2);
 assert.equal(v.coverage[0].unknown,1);assert.equal(JSON.stringify(api),before);
});

test('filtros existentes aceitam nomes de marca e período de compra',()=>{
 const api=fixture();
 assert.equal(group(OA.select(api,'aristocrata','2026-09-19','2026-09-19'),'editorial').receita,300.5);
 assert.equal(group(OA.select(api,'fishermans','2026-09-19','2026-09-19'),'editorial').receita,80);
 assert.equal(group(OA.select(api,'todas','2026-09-19','2026-09-19'),'editorial').receita,380.5);
 assert.equal(OA.select(api,'marca-inexistente','2026-09-19','2026-09-19').reason,'filter');
 assert.equal(OA.select(api,'aristo','2026-09-31','2026-10-01').reason,'filter');
 assert.equal(OA.select(api,'aristo','2026-09-20','2026-09-19').reason,'filter');
});

test('ausência de payload ou contrato de outra origem não vira zero nem reutiliza o legado',()=>{
 for(const api of [{}, {cx_organico_receita:[{receita_ultimo:999}]},fixture({window_days:7}),fixture({source_system:'tiktok_shop'}),fixture({currency:'USD'}),fixture({schema_version:2})]){
  const v=OA.select(api,'aristo','2026-09-19','2026-09-19');assert.equal(v.available,false);
  assert.match(OA.markup(v),/indisponível/);assert.doesNotMatch(OA.markup(v),/R\$/);
 }
});

test('zero exige cobertura completa; cobertura parcial mantém soma existente rotulada parcial',()=>{
 const empty=fixture({daily:[]}),full=OA.select(empty,'aristo','2026-09-19','2026-09-19');
 assert.equal(group(full,'editorial').receita,0);
 const gap=OA.select(empty,'aristo','2026-09-18','2026-09-19');
 assert.equal(gap.complete,false);assert.equal(gap.coverage[0].covered,1);assert.equal(gap.coverage[0].expected,2);
 assert.equal(group(gap,'editorial').receita,null);assert.match(OA.markup(gap),/Cobertura parcial/);
 const partial=OA.select(fixture({coverage:[]}), 'aristo','2026-09-19','2026-09-19');
 assert.equal(group(partial,'editorial').receita,300.5);assert.equal(partial.complete,false);
});

test('cobertura usa dias únicos, horário válido e frescor separado por marca',()=>{
 const api=fixture({coverage:[
  {marca:'aristo',dia:'2026-09-18',checked_at:'2026-09-18T10:00:00Z'},
  {marca:'aristo',dia:'2026-09-18',checked_at:'2026-09-19T10:00:00Z'},
  {marca:'aristo',dia:'2026-09-19',checked_at:'2026-09-19T18:12:00Z'},
  {marca:'fish',dia:'2026-09-19',checked_at:'invalido'},
 ]});
 const v=OA.select(api,'aristo','2026-09-18','2026-09-19');
 assert.equal(v.complete,true);assert.equal(v.coverage[0].covered,2);
 assert.equal(v.coverage[0].oldest,'2026-09-19T10:00:00Z');assert.equal(v.coverage[0].latest,'2026-09-19T18:12:00Z');
 const fish=OA.select(api,'fish','2026-09-19','2026-09-19');assert.equal(fish.coverage[0].covered,0);
});

test('receita nula ou inválida não vira soma parcial nem zero; qualidade ausente segue desconhecida',()=>{
 for(const missing of [null,undefined,'','erro',false]){
  const v=OA.select(fixture({daily:[row(),row({receita_liquida:missing})],quality:[quality('aristo',{ultima_sessao_desconhecida:missing})]}),'aristo','2026-09-19','2026-09-19');
  assert.equal(group(v,'editorial').receita,null);assert.equal(v.coverage[0].unknown,null);assert.equal(v.malformed,true);
  assert.match(OA.markup(v),/valor ou classificação inválida/);
 }
 const measuredZero=OA.select(fixture({daily:[row({receita_liquida:0,pedidos:0})]}),'aristo','2026-09-19','2026-09-19');
 assert.equal(group(measuredZero,'editorial').receita,0);assert.equal(measuredZero.malformed,false);
});

test('classificação inesperada fica explícita e não é rebatizada como orgânico',()=>{
 const v=OA.select(fixture({daily:[row({classification:'novo-grupo-desconhecido'})]}),'aristo','2026-09-19','2026-09-19');
 assert.equal(v.malformed,true);assert.equal(group(v,'editorial').receita,null);
 assert.match(OA.markup(v),/Classificação inválida/);
});

test('interface escapa dados externos e expõe limites, regra, reembolso e origem desconhecida',()=>{
 const html=OA.markup(OA.select(fixture({daily:[row({utm_campaign:'<img src=x onerror=alert(1)>',utm_content:'<script>bad</script>'})]}),'aristo','2026-09-19','2026-09-19'));
 assert(!html.includes('<img src=x'));assert(!html.includes('<script>bad'));
 assert.match(html,/&lt;img/);assert.match(html,/organico-utm-20260927-v2/);
 for(const evidence of ['30 dias','líquido de reembolsos','não se somam','não comprova','Assistências de Orgânico ainda não','já normalizadas','peça permanece desconhecida','Origem desconhecida'])assert(html.includes(evidence),evidence);
 assert.match(html,/aria-pressed="true"/);assert(!/taxa de conversão/i.test(html));
});

test('troca de modelo mantém o foco e altera a leitura sem chamada externa',()=>{
 const el={innerHTML:'',buttons:[],focused:null,
  querySelectorAll(){this.buttons=['last_click','last_non_direct'].map(model=>({dataset:{orgModel:model}}));return this.buttons;},
  querySelector(s){return {focus:()=>{this.focused=s;}};}};
 OA.render(el,fixture(),'aristo','2026-09-19','2026-09-19');
 assert.match(el.innerHTML,/Último clique estrito/);
 el.buttons[1].onclick();assert.match(el.innerHTML,/<strong>Último clique não direto/);
 assert.equal(el.focused,'[data-org-model="last_non_direct"]');
 el.buttons[0].onclick();assert.match(el.innerHTML,/<strong>Último clique estrito/);
});

test('resumos diários dos outros canais preservam totais nos dados, ficam fora da tela e não fingem UTMs no detalhe',()=>{
 const v=OA.select(fixture({daily:[row(),row({classification:'crm',detail_level:'channel_summary',rule_reason:'resumo_diario_canal',utm_source:null,utm_medium:null,utm_campaign:null,pedidos:12,receita_liquida:1000})]}),'aristo','2026-09-19','2026-09-19');
 assert.equal(group(v,'crm').pedidos,12);assert.equal(group(v,'crm').receita,1000);
 assert.equal(v.rows.length,2);assert.equal(v.detailRows.length,1);
 const html=OA.markup(v),detail=html.split('Conferir UTMs e regra de classificação')[1];
 assert.doesNotMatch(html,/data-org-group="crm"/);
 assert.doesNotMatch(detail,/source: não informado/);assert.doesNotMatch(detail,/resumo_diario_canal/);
});

test('regra v2: padrão antigo aparece como bio/story com etiqueta; balde legado vira classificação inválida',()=>{
 const api=fixture({daily:[row({classification:'bio',superficie:'bio',utm_source:'ig',utm_medium:'social',utm_content:'link_in_bio',rule_reason:'bio_link_automatico_instagram'}),
  row({rule_reason:'story_padrao_antigo',utm_source:'instagram',utm_medium:'social',utm_content:'story'})]});
 const v=OA.select(api,'aristo','2026-09-19','2026-09-19'),html=OA.markup(v);
 assert.match(html,/Link da bio · UTM automática do Instagram/);assert.match(html,/Story · link no padrão antigo/);
 assert.ok(!/Social legado/.test(html));assert.equal(v.malformed,false);
 const velho=OA.select(fixture({daily:[row({classification:'legado_ambiguo'})]}),'aristo','2026-09-19','2026-09-19');
 assert.equal(velho.malformed,true,'payload antigo não é somado em silêncio');
});

test('painel do orgânico mostra só orgânico: mídia paga, CRM e sem classificação não aparecem',()=>{
 const v=OA.select(fixture(),'aristo','2026-09-19','2026-09-19'),html=OA.markup(v);
 for(const k of ['editorial','bio','automacao_dm'])assert.match(html,new RegExp(`data-org-group="${k}"`));
 for(const k of ['midia_paga','crm','nao_classificado'])assert.ok(!html.includes(`data-org-group="${k}"`),k);
 assert.ok(!/Mídia paga|Outros canais/.test(html));
});

test('Venda por iniciativa: campanha sem data (links novos) ou utm_term (padrão antigo), somando datas; valor inválido fica indisponível',()=>{
 const OA=require('../organico-attribution.js');
 const L=OA.porIniciativa([
  {marca:'aristo',superficie:'story',utm_campaign:'20260915_semana_do_cliente',pedidos:3,receita_liquida:'100.50'},
  {marca:'aristo',superficie:'story',utm_campaign:'20260920_semana_do_cliente',pedidos:1,receita_liquida:20},
  {marca:'fish',superficie:'bio',utm_campaign:'venda',utm_term:'amazonica8x',pedidos:2,receita_liquida:50},
  {marca:'fishermans',superficie:'bio',utm_campaign:'venda',utm_term:'amazonica8x',pedidos:1,receita_liquida:5},
  {marca:'aristo',superficie:'bio',utm_campaign:'',utm_content:'link_in_bio',pedidos:1,receita_liquida:7},
  {marca:'aristo',superficie:'dm',utm_campaign:'x',pedidos:'dois',receita_liquida:10}]);
 const semana=L.find(x=>x.slug==='semana_do_cliente');assert.deepEqual([semana.nome,semana.pedidos,semana.receita,semana.links],['semana do cliente',4,120.5,2]);
 const amaz=L.find(x=>x.slug==='amazonica8x');assert.deepEqual([amaz.marca,amaz.pedidos,amaz.receita],['fish',3,55],'alias de marca soma na mesma linha');
 assert.equal(L.find(x=>x.slug==='link_in_bio').nome,'link in bio');
 const inval=L.find(x=>x.slug==='x');assert.equal(inval.pedidos,null);assert.equal(inval.receita,null);
 assert.equal(L[0].slug,'semana_do_cliente','ordena por receita');
});
