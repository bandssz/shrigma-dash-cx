'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const OA=require('../organico-attribution.js'),OS=require('../organico-stories.js');
const row=(o={})=>({marca:'aristo',dia:'2026-09-19',model:'last_click',classification:'editorial',detail_level:'utm',rede:'instagram',superficie:'story',utm_source:'instagram_social',utm_medium:'story',utm_campaign:'iniciativa_sem_data',utm_content:'',utm_term:'',piece_status:'nao_identificada',pedidos:2,receita_liquida:'180.50',...o});
const quality=marca=>({marca,dia:'2026-09-19',pagos_elegiveis:20,ultima_sessao_desconhecida:2,origem_nao_direta_desconhecida:3});
const fixture=(changes={})=>({cx_story:[{marca:'aristocrata',story_id:'fixture-one',publicado_em:'2026-09-19T15:00:00Z',link_clicks:0},{marca:'aristocrata',story_id:'fixture-two',publicado_em:'2026-09-19T15:00:00Z',link_clicks:null}],organico_attribution:{schema_version:1,window_days:30,source_system:'shopify',currency:'BRL',piece_identity_available:false,rule_version:'organico-utm-20260919-v1',daily:[row()],quality:['aristo','fish','olivas'].map(quality),coverage:['aristo','fish','olivas'].map(marca=>({marca,dia:'2026-09-19',checked_at:'2026-09-19T18:00:00Z'})),...changes}});
const select=(p,marca='aristo',model='last_click',ini='2026-09-19')=>OS.select(p,marca,ini,'2026-09-19',model);
test('Stories uses the same exclusive order/model selection as Venda, never DM/bio/paid/coupon/TikTok or legacy',()=>{
 const p=fixture({daily:[row(),row({classification:'bio',superficie:'bio',pedidos:50,receita_liquida:1000}),row({classification:'automacao_dm',superficie:'story',pedidos:50,receita_liquida:1000}),row({classification:'midia_paga',superficie:'story',pedidos:50,receita_liquida:1000}),row({classification:'legado_ambiguo',superficie:'story',pedidos:50,receita_liquida:1000}),row({classification:'editorial',superficie:'reels',pedidos:50,receita_liquida:1000}),row({model:'last_non_direct',pedidos:3,receita_liquida:250})]});
 p.cx_organico_receita=[{superficie_utm:'story',receita_ultimo:9999}];p.tiktok={gmv:9999};const before=JSON.stringify(p);
 const strict=select(p),compare=select(p,'aristo','last_non_direct');assert.equal(strict.storyOrders,2);assert.equal(strict.storyRevenue,180.5);assert.equal(compare.storyOrders,3);assert.equal(compare.storyRevenue,250);
 const source=OA.select(p,'aristo','2026-09-19','2026-09-19').rows.filter(r=>r.classification==='editorial'&&r.superficie==='story');assert.deepEqual(strict.storyRows,source);assert.equal(JSON.stringify(p),before);
});
test('same campaign on different brands remains separate, full tuple prevents accidental link merging',()=>{
 const v=select(fixture({daily:[row(),row({marca:'fish',pedidos:1,receita_liquida:30}),row({utm_content:'second',pedidos:1,receita_liquida:20}),row({dia:'2026-09-18',pedidos:1,receita_liquida:10})]}),'todas','last_click','2026-09-18');
 assert.equal(v.storyGroups.length,3);assert.equal(v.storyOrders,5);assert.equal(v.storyRevenue,240.5);
 const aristo=v.storyGroups.find(g=>g.marca==='aristo'&&!g.utm.utm_content);assert.equal(aristo.pedidos,3);assert.equal(aristo.first,'2026-09-18');assert.equal(aristo.last,'2026-09-19');
 assert.equal(select(fixture({daily:[row({marca:'fish'})]}),'fishermans').storyOrders,2);
});
test('campaign names are preserved with or without dates and cannot identify story or URL',()=>{
 const p=fixture({daily:[row({utm_campaign:'20260919_iniciativa'}),row({utm_campaign:'iniciativa_sem_data',story_id:'unverified-field'})]});
 p.cx_story[0].utm_campaign='20260919_iniciativa';
 const v=select(p),html=OS.markup(v);assert.deepEqual(v.storyGroups.map(g=>g.utm.utm_campaign),['20260919_iniciativa','iniciativa_sem_data']);
 assert.match(html,/Peça não identificada/);assert.match(html,/Não deduzimos o story pela data/);assert.match(html,/UTM não comprova URL única/);assert.doesNotMatch(html,/unverified-field|fixture-one/);
});
test('zeros require complete financial coverage while absent contract and malformed values stay unavailable',()=>{
 assert.equal(select(fixture({daily:[]})).storyOrders,0);assert.equal(select(fixture({daily:[],coverage:[]})).storyOrders,null);
 for(const value of [null,undefined,'','invalid',false]){const v=select(fixture({daily:[row(),row({receita_liquida:value})]}));assert.equal(v.storyRevenue,null);assert.match(OS.markup(v),/indisponível/);}
 const zero=select(fixture({daily:[row({pedidos:0,receita_liquida:0})]}));assert.equal(zero.storyRevenue,0);assert.match(OS.markup(zero),/R\$\s*0,00/);
 for(const p of [{cx_organico_receita:[{receita_ultimo:999}]},fixture({source_system:'tiktok_shop'}),fixture({window_days:7})]){const v=select(p);assert.equal(v.available,false);assert.doesNotMatch(OS.markup(v),/R\$/);}
 const unknown=select(fixture({daily:[row({superficie:null})]}));assert.equal(unknown.storyOrders,null);assert.equal(unknown.unknownSurface,true);
});
test('partial values and unknown origins remain explicit; no attribution or rate is inferred from Instagram clicks',()=>{
 const p=fixture({coverage:[]}),v=select(p);assert.equal(v.storyRevenue,180.5);assert.equal(v.complete,false);assert.equal(v.storiesCollected,2);assert.equal(v.storiesWithClicks,1);
 const html=OS.markup(v);for(const text of ['Cobertura parcial','Origem desconhecida','data da publicação','não calculamos taxa de compra','sem distribuição por story','cupom','TikTok Shop'])assert(html.includes(text),text);
 p.cx_story=undefined;assert.equal(select(p).storiesCollected,null);assert.equal(select(p).storiesWithClicks,null);
});
test('Instagram coverage uses publication date in Brasília and does not restrict the purchase population',()=>{
 const p=fixture();p.cx_story=[{marca:'aristo',publicado_em:'2026-09-20T01:00:00Z',link_clicks:0},{marca:'aristo',publicado_em:'2026-09-19T01:00:00Z',link_clicks:1},{marca:'fish',publicado_em:'2026-09-19T14:00:00Z',link_clicks:2}];
 const v=select(p);assert.equal(v.storiesCollected,1);assert.equal(v.storiesWithClicks,1);assert.equal(v.storyOrders,2);
});
test('missing campaign is shown as coverage gap and hostile UTM text remains escaped',()=>{
 const v=select(fixture({daily:[row({utm_campaign:null}),row({utm_campaign:'<img src=x onerror=alert(1)>',utm_term:'<script>bad</script>'})]}));
 assert.equal(v.storyGroups.length,2);assert.equal(v.combosWithCampaign,1);const html=OS.markup(v);assert.match(html,/Campanha não informada/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<script>/);
});
test('real page wiring synchronizes model between Stories and Venda and keeps focus without fetching',()=>{
 const {parseHTML}=require('linkedom'),{document,window}=parseHTML('<html><body><div id="organico-attribution"></div><div id="stories-conversions"></div></body></html>');let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};
 const p=fixture({daily:[row(),row({model:'last_non_direct',pedidos:8,receita_liquida:800})]});
 const context=vm.createContext({OA,OS,API:p,MARCA:'aristo',PER:{ini:'2026-09-19',fim:'2026-09-19'},$:s=>document.querySelector(s),fetch:()=>{throw Error('no fetch allowed');}});
 const html=fs.readFileSync(require.resolve('../organico.html'),'utf8');const start=html.indexOf('function pintaAtribuicaoOrganico(){'),end=html.indexOf('/* ---------- grade:',start);assert(start>=0&&end>start);
 OA.setModel('last_click');vm.runInContext(html.slice(start,end),context);vm.runInContext('pintaAtribuicaoOrganico()',context);
 document.querySelector('[data-story-model="last_non_direct"]').click();assert.equal(OA.getModel(),'last_non_direct');assert.match(document.querySelector('#organico-attribution').textContent,/Último clique não direto/);assert.equal(document.querySelector('[data-story-total="orders"]').textContent,'8');assert.equal(focused.dataset.storyModel,'last_non_direct');
 document.querySelector('[data-org-model="last_click"]').click();assert.equal(document.querySelector('[data-story-total="orders"]').textContent,'2');assert.equal(focused.dataset.orgModel,'last_click');assert.equal(document.querySelector('[data-story-model="last_click"]').getAttribute('aria-pressed'),'true');
 assert.match(html,/<section class="sec" id="sec-stories">\s*<div class="painel" id="stories-conversions">/);
});

test('story medium with link_in_bio content keeps the source classification and exposes the conflicting publication signal',()=>{
 const p=fixture({daily:[row({utm_content:'link_in_bio',pedidos:4,receita_liquida:240.50}),row({model:'last_non_direct',utm_content:'link_in_bio',pedidos:7,receita_liquida:420}),row({classification:'bio',superficie:'bio',utm_medium:'linktree',utm_content:'link_in_bio',pedidos:10,receita_liquida:900})]});
 const before=JSON.stringify(p),v=select(p),text=OS.markup(v);
 assert.equal(v.storyOrders,4);assert.equal(v.storyRevenue,240.50);assert.equal(v.storyGroups.length,1);assert.match(text,/Sinal conflitante:/);assert.match(text,/medium=story e content=link_in_bio/);assert.match(text,/regra vigente usa source\/medium/);assert.match(text,/local real de publicação continua não comprovado/);assert.match(text,/categorias de automação DM, Bio\/Linktree/);
 assert.equal(select(p,'aristo','last_non_direct').storyOrders,7);assert.equal(JSON.stringify(p),before);
 assert.doesNotMatch(OS.markup(select(fixture())),/Sinal conflitante:/);
});

/* Ponte por dia: só o que a Meta mede por peça é por peça; o resto continua da campanha. */
const storyRow=(o={})=>({marca:'aristocrata',story_id:'s'+Math.random(),publicado_em:'2026-09-19T15:00:00Z',link_clicks:0,...o});
test('a story only counts as carrying a link when the Meta click count is above zero',()=>{
 const p=fixture({daily:[row()]});
 p.cx_story=[storyRow({link_clicks:null}),storyRow({link_clicks:0}),storyRow({link_clicks:12}),storyRow({link_clicks:5})];
 const v=select(p);
 assert.equal(v.storiesCollected,4,'todas as coletadas continuam contadas');
 assert.equal(v.storiesWithClicks,3,'campo preenchido inclui os zeros');
 assert.equal(v.storiesWithLink,2,'só clique acima de zero prova o link');
 assert.equal(v.storyClicks,17);
 assert.match(OS.markup(v),/2 carregaram link \(17 toques\)/);
});
test('the day bridge lines up publication day with the dated campaign without crediting a story',()=>{
 const p=fixture({daily:[row({utm_campaign:'20260919_semana',pedidos:4,receita_liquida:400})]});
 p.cx_story=[storyRow({link_clicks:30}),storyRow({link_clicks:0})];
 const v=select(p),linha=v.bridge.find(l=>l.dia==='2026-09-19');
 assert.equal(linha.stories,2);assert.equal(linha.comLink,1);assert.equal(linha.cliques,30);
 assert.equal(linha.pedidos,4);assert.equal(linha.receita,400);
 assert.equal(linha.excedente,null,'4 pedidos cabem em 30 toques');
 assert.deepEqual(linha.campanhas,['20260919_semana']);
 assert.match(OS.markup(v),/Dia a dia · peça, toque e campanha/);
 assert.match(OS.markup(v),/dentro dos toques/);
});
test('more orders than measured taps is shown as proof of another surface, never split across stories',()=>{
 const p=fixture({daily:[row({utm_campaign:'20260919_semana',pedidos:285,receita_liquida:41785.47})]});
 p.cx_story=[storyRow({story_id:'id-que-nao-pode-vazar',link_clicks:166})];
 const v=select(p),linha=v.bridge[0];
 assert.equal(linha.excedente,119,'285 pedidos contra 166 toques');
 assert.equal(Object.hasOwn(linha,'story_id'),false,'a linha do dia nunca carrega identidade de peça');
 const html=OS.markup(v);
 assert.match(html,/\+119 além dos toques/);
 assert.match(html,/circulou fora dos stories/);
 assert.doesNotMatch(html,/id-que-nao-pode-vazar/,'nenhum story_id vira crédito na tela');
});
test('a dated campaign with orders and no linked story that day is flagged, not attributed',()=>{
 const p=fixture({daily:[row({utm_campaign:'20260919_semana',pedidos:7,receita_liquida:700})]});
 p.cx_story=[storyRow({link_clicks:0}),storyRow({link_clicks:null})];
 const v=select(p),linha=v.bridge[0];
 assert.equal(linha.comLink,0);assert.equal(linha.semStoryComLink,true);assert.equal(linha.excedente,null);
 assert.match(OS.markup(v),/campanha sem story com link/);
});
test('a campaign with no date prefix never invents a day, and days outside the range stay out',()=>{
 const p=fixture({daily:[row({utm_campaign:'iniciativa_sem_data',pedidos:9,receita_liquida:900})]});
 p.cx_story=[storyRow({link_clicks:4})];
 const v=select(p);
 assert.equal(v.bridge.length,1);
 assert.equal(v.bridge[0].pedidos,null,'sem data no nome, a campanha não entra em nenhum dia');
 assert.deepEqual(v.bridge[0].campanhas,[]);
 const fora=select(fixture({daily:[row({utm_campaign:'20260101_antiga',pedidos:5,receita_liquida:500})]}));
 assert.ok(fora.bridge.every(l=>l.dia>='2026-09-19'),'dia fora do recorte não vira linha');
});
test('the bridge is absent, not empty, when the story source is missing',()=>{
 const p=fixture({daily:[row()]});delete p.cx_story;
 assert.equal(select(p).bridge,null);
 assert.equal(OS.markup(select(p)).includes('Dia a dia'),false);
});
