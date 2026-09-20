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
