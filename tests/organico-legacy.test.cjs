'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),L=require('../organico-legacy.js');
const html=fs.readFileSync(path.join(__dirname,'../organico.html'),'utf8');
const row=(more={})=>({marca:'aristo',rede:'instagram',superficie_utm:'story',produto_utm:'Produto',utm_campaign:'venda',utm_medium:'social',pedidos_ultimo:2,receita_ultimo:'12.34',pedidos_assistido:3,...more});
function render(rows){
 const {document}=parseHTML('<html><body><span id="n-venda"></span><span id="venda-rot"></span><table id="tab-venda"><tbody></tbody></table></body></html>');
 const ctx=vm.createContext({OLegacy:L,$:s=>document.querySelector(s),nf:n=>n==null?'—':Number(n).toLocaleString('pt-BR'),esc:v=>String(v??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))});
 const start=html.indexOf('function renderVenda(linhas){'),end=html.indexOf('let ORD=',start);assert.ok(start>=0&&end>start);
 vm.runInContext(html.slice(start,end),ctx);ctx.renderVenda(rows);
 return {document,text:document.body.textContent,rows:[...document.querySelectorAll('tbody tr')],badge:document.querySelector('#n-venda').textContent,summary:document.querySelector('#venda-rot').textContent};
}

test('same UTM in two brands is separate; only documented aliases resolve to the same brand',()=>{
 const input=[row(),row({marca:'fish',receita_ultimo:20}),row({marca:'aristocrata',receita_ultimo:10}),row({marca:'fishermans',receita_ultimo:5})],before=JSON.stringify(input);
 const out=L.aggregate(input);assert.equal(out.rows.length,2);assert.deepEqual(out.total,{ped:8,rec:47.34,ass:12});
 assert.equal(out.rows.find(r=>r.marca==='aristo').rec,22.34);assert.equal(out.rows.find(r=>r.marca==='fish').rec,25);assert.equal(JSON.stringify(input),before);
 const ui=render(input);assert.equal(ui.rows.length,2);assert.match(ui.text,/Aristocrata/);assert.match(ui.text,/Fishermans/);
});
test('structured dimension keys cannot collide on delimiters or collapse absent/unknown brand into a known brand',()=>{
 const dimensions=[row({rede:'instagram|story',superficie_utm:'produto',produto_utm:'camp'}),row({rede:'instagram',superficie_utm:'story',produto_utm:'produto|camp'}),row({marca:null}),row({marca:'marca-nova'}),row()];
 assert.equal(L.aggregate(dimensions).rows.length,5);const ui=render(dimensions);assert.match(ui.text,/Marca não informada/);assert.match(ui.text,/Marca não reconhecida: marca-nova/);
});
test('zero is measured, invalid values stay unknown independently for each financial metric',()=>{
 const zero=L.aggregate([row({pedidos_ultimo:'0',receita_ultimo:'0.00',pedidos_assistido:0})]);assert.deepEqual(zero.total,{ped:0,rec:0,ass:0});
 for(const field of ['pedidos_ultimo','receita_ultimo','pedidos_assistido'])for(const value of [null,undefined,'',' ','not-a-number',false,true,[],{},NaN,Infinity,'0x10']){
  const key={pedidos_ultimo:'ped',receita_ultimo:'rec',pedidos_assistido:'ass'}[field],out=L.aggregate([row({[field]:value})]);
  assert.equal(out.rows[0][key],null);assert.equal(out.total[key],null);
  for(const other of ['ped','rec','ass'].filter(k=>k!==key))assert.notEqual(out.total[other],null);
 }
 const ui=render([row({pedidos_ultimo:0,receita_ultimo:0,pedidos_assistido:0})]);assert.match(ui.rows[0].textContent,/R\$\s*0,00/);assert.equal(ui.badge,'0');assert.doesNotMatch(ui.text,/indisponível/);
});
test('a missing component poisons only its metric in its group and grand total, without publishing a partial sum',()=>{
 const out=L.aggregate([row(),row({receita_ultimo:null}),row({marca:'fish',receita_ultimo:100})]);
 assert.equal(out.rows.find(r=>r.marca==='aristo').rec,null);assert.equal(out.rows.find(r=>r.marca==='fish').rec,100);assert.deepEqual(out.total,{ped:6,rec:null,ass:9});
 const ui=render([row(),row({receita_ultimo:null})]);assert.match(ui.summary,/Receita: indisponível/);assert.doesNotMatch(ui.text,/12,34/);
 const noCount=render([row({pedidos_ultimo:null})]);assert.equal(noCount.badge,'—');assert.match(noCount.summary,/Pedidos: indisponível/);assert.match(noCount.text,/12,34/);
});
test('counts reject negative/fractional/unsafe totals while signed monetary corrections remain observed values',()=>{
 for(const value of [-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.equal(L.aggregate([row({pedidos_ultimo:value})]).total.ped,null);
 assert.equal(L.aggregate([row({pedidos_ultimo:Number.MAX_SAFE_INTEGER}),row()]).total.ped,null);
 assert.equal(L.aggregate([row({receita_ultimo:'-2.50'}),row({receita_ultimo:'1.25'})]).total.rec,-1.25);
});
test('legacy DM and bio presentation remain unchanged, campaigns are preserved, and no piece identity is inferred',()=>{
 const out=L.aggregate([row({produto_utm:'link_in_bio'}),row({utm_medium:'dm',utm_content:'REPLIENT_EUQUERO',utm_campaign:'replient_euquero'}),row({utm_medium:'dm-automation',utm_content:'replient-eu-quero',utm_campaign:'aristocrata-quero-evergreen'})]);
 const bio=out.rows.find(r=>r.sup==='bio');assert.equal(bio.prod,null);assert.deepEqual(bio.ident,[]);
 const dm=out.rows.filter(r=>r.sup==='dm (automação)');assert.equal(dm.length,2);assert.equal(dm[0].camp,'replient_euquero');assert.deepEqual(dm[0].ident,[]);
 assert.match(render([row({utm_campaign:'20260919_story',produto_utm:'Story Produto'})]).text,/Sem vínculo comprovado/);
});
test('piece references are reported as unverified legacy information, never matched or used to divide revenue',()=>{
 const rows=[row({post_id:'fixture-post',apelido:'Peça teste'}),row({story_id:'fixture-story',apelido:'Peça teste'}),row({produto_utm:'Produto'})],out=L.aggregate(rows);
 assert.equal(out.rows.length,1);assert.equal(out.rows[0].ident.length,2);assert.equal(out.rows[0].unidentified,1);assert.equal(Math.round(out.total.rec*100),3702);
 const ui=render(rows);assert.match(ui.text,/Informado no legado; vínculo ainda não conciliado/);assert.match(ui.text,/Há também linhas sem vínculo/);assert.match(ui.text,/37,02/);
});
test('no rows is distinct from unavailable projection; neither claims no sales or creates a zero',()=>{
 assert.deepEqual(L.aggregate([]).total,{ped:null,rec:null,ass:null});assert.equal(L.aggregate(null).available,false);
 const empty=render([]),absent=render(null);assert.match(empty.text,/ausência de linhas não comprova zero vendas/);assert.match(absent.text,/não está disponível/);assert.equal(empty.badge,'');assert.equal(absent.badge,'');
 for(const ui of [empty,absent]){assert.doesNotMatch(ui.summary,/R\$|0 pedidos/);assert.equal(ui.rows[0].querySelector('td').getAttribute('colspan'),'8');}
});
test('row labels and legacy aliases stay escaped; table remains focusable and assisted incidences are explicit',()=>{
 const malicious='<img src=x onerror=alert(1)>',ui=render([row({marca:malicious,rede:malicious,produto_utm:malicious,utm_campaign:malicious,post_id:'fixture',apelido:malicious})]);
 assert.equal(ui.document.querySelector('img'),null);assert.match(ui.text,/<img/);assert.match(ui.summary,/Incidências assistidas/);
 const {document}=parseHTML(html);const region=document.querySelector('#tab-venda').parentNode;assert.equal(region.getAttribute('tabindex'),'0');assert.equal(region.getAttribute('role'),'region');
 assert.match(document.querySelector('#sec-venda').textContent,/podem contar o mesmo pedido mais de uma vez/);
 assert.match(document.querySelector('#sec-venda').textContent,/Não some as duas tabelas/);
});
