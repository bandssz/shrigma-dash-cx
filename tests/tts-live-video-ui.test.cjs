/* Window/grain/coverage rendering only; all fixtures are synthetic, no API. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const TTS=require('../influs-tts.js');
const source=fs.readFileSync(path.join(__dirname,'../influs-tts.js'),'utf8');
const esc=v=>String(v??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const live=(o={})=>({marca:'fish',live_id:'fixture-1',username:'fixture',origem:'proprio',dia:'2026-01-01',titulo:'Fixture live',inicio_em:'2026-01-01T10:00:00Z',fim_em:'2026-01-01T11:00:00Z',duracao_min:60,gmv:100,gmv_24h:110,pedidos:2,pedidos_criados:3,espectadores:100,cliques:10,impressoes_produto:100,novos_seguidores:2,...o});
const video=(o={})=>({marca:'fish',video_id:'fixture-video',username:'fixture',origem:'proprio',titulo:'Fixture video',retrato_em:'2026-01-19',publicado_em:'2025-12-20',gmv:80,pedidos:2,visualizacoes:1000,ctr_pct:2,gpm:80,...o});
const payload=(o={})=>({janela:{ini:'2026-01-01',fim:'2026-01-02'},canal:[],canal_total:[],lives:[live()],videos:[video()],live_produtos:[],...o});
function render(data,brand='fish'){
 const {document}=parseHTML('<html><body><div id="tts-area"></div></body></html>');
 const context=vm.createContext({document,TTS,DADOS:data,marcaAtual:()=>brand,$:s=>document.querySelector(s),esc,
  nf:v=>v==null?'—':String(v),rf:v=>v==null?'—':'R$'+Number(v),pctOu:v=>v==null?'—':String(v)+'%',
  dt:v=>v?String(v).slice(0,10):'—',dtHora:v=>String(v||'—'),tag:m=>'<span>'+esc(m)+'</span>',
  MARCA_N:{fish:'Fishermans',aristo:'Aristocrata'},resumoOrigemCanal:()=>'<div>Fixture reconciliation preserved</div>',graficoCanal:()=>'<div>Fixture daily chart</div>',dobra:rows=>rows.join(''),ligarDobras:()=>{}});
 const start=source.indexOf('  const indisponivelTTS ='),end=source.indexOf('  const dtHora =',start);
 assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),context);context.renderCanal();
 return {document,text:()=>document.querySelector('#tts-area').textContent,html:()=>document.querySelector('#tts-area').innerHTML,
  open:()=>{const row=document.querySelector('.tts-ev-linha');assert.ok(row);row.onclick();return document.querySelector('.tts-ev-det');}};
}
test('live grouping keeps numbers and exposes session cap before brand/grouping plus nonunique viewers',()=>{
 const data=payload({lives:[live(),live({live_id:'fixture-2',inicio_em:'2026-01-01T11:01:00Z',fim_em:'2026-01-01T11:30:00Z',duracao_min:29,gmv:70,espectadores:50})]});
 const before=JSON.stringify(data),event=TTS.canal(data,'fish').eventos[0];assert.equal(event.gmv,170);assert.equal(event.espectadores,150);assert.equal(event.sessoes.length,2);
 const ui=render(data);assert.match(ui.text(),/60 sessões com maior GMV entre as marcas/);assert.match(ui.text(),/antes do filtro de marca e do agrupamento/);assert.match(ui.text(),/não pessoas únicas do evento/);assert.match(ui.text(),/Um evento pode estar incompleto/);
 const row=ui.document.querySelector('.tts-ev-linha');assert.match(row.textContent,/150/);assert.match(row.textContent,/R\$170/);assert.equal(JSON.stringify(data),before);
});
test('empty brand in a globally limited response never claims no lives or no video sales',()=>{
 const data=payload({lives:Array.from({length:60},(_,i)=>live({live_id:String(i)})),videos:Array.from({length:30},(_,i)=>video({video_id:String(i)}))});
 const ui=render(data,'aristo');assert.match(ui.text(),/60 sessões recebidas no total; 0 neste filtro/);assert.match(ui.text(),/30 vídeos recebidos no total; 0 neste filtro/);
 assert.match(ui.text(),/não comprova ausência de lives ou de vendas/);assert.match(ui.text(),/não comprova zero vendas/);
 assert.doesNotMatch(ui.text(),/Nenhuma live no período|Nenhum vídeo com venda nos últimos/);
 assert.match(ui.text(),/Aristocrata: data do retrato indisponível nesta resposta/);
});
test('video snapshot remains visible without daily channel data and dates are per brand, outside sale-window filter',()=>{
 const data=payload({videos:[video(),video({marca:'aristo',video_id:'other',retrato_em:'2026-01-17',gmv:30})]});
 const ui=render(data,'todas');assert.match(ui.text(),/Dados diários do canal indisponíveis/);assert.match(ui.text(),/não segue a janela de vendas selecionada/);
 assert.match(ui.text(),/Fishermans: retrato de 2026-01-19/);assert.match(ui.text(),/Aristocrata: retrato de 2026-01-17/);
 assert.match(ui.text(),/30 vídeos com GMV positivo/);assert.match(ui.text(),/não somar aos totais diários/);assert.match(ui.text(),/GMV · 30 dias/);
 const titles=[...ui.document.querySelectorAll('th')].map(n=>n.textContent);assert.ok(titles.includes('Retrato'));
 assert.match(ui.text(),/R\$80/);assert.match(ui.text(),/R\$30/);
});
test('partial session fields are unavailable while measured zero stays zero; underlying sums unchanged',()=>{
 const unknown=payload({lives:[live({gmv:null,gmv_24h:null,pedidos:null,espectadores:null,cliques:null,novos_seguidores:null})]});
 const ui=render(unknown),row=ui.document.querySelector('.tts-ev-linha');assert.ok((row.textContent.match(/indisponível/g)||[]).length>=6);assert.doesNotMatch(row.textContent,/R\$0/);assert.doesNotMatch(row.innerHTML,/a plataforma ainda não fechou/);
 assert.equal(TTS.canal(unknown,'fish').eventos[0].gmv,0,'legacy calculation preserved; display masks absent inputs');
 const knownZero=render(payload({lives:[live({gmv:0,gmv_24h:0,pedidos:0,pedidos_criados:0,espectadores:0,cliques:0,impressoes_produto:0,novos_seguidores:0,duracao_min:0})]}));
 const zero=knownZero.document.querySelector('.tts-ev-linha');assert.doesNotMatch(zero.textContent,/indisponível/);assert.match(zero.textContent,/R\$0/);assert.match(zero.textContent,/0 min/);
});
test('product expansion explains 400 record coverage, local 12-product limit and direct GMV without masking zero',()=>{
 const products=Array.from({length:13},(_,i)=>({marca:'fish',live_id:'fixture-1',product_id:String(i),nome:'Fixture '+i,gmv_direto:i===12?0:13-i,pedidos:i===12?0:1,pedidos_criados:i===12?0:1,impressoes:100,cliques:10}));
 const ui=render(payload({live_produtos:products})),details=ui.open();assert.match(details.textContent,/exibindo 12 de 13/);assert.match(details.textContent,/400 registros de sessão\/produto/);assert.match(details.textContent,/GMV direto positivo ou pelo menos 10 cliques/);assert.match(details.textContent,/não conciliam, por si só/);assert.match(details.textContent,/GMV direto/);
 assert.equal(details.querySelectorAll('.tts-prod').length,12);
 const zeroUi=render(payload({live_produtos:[products[12]]}));assert.match(zeroUi.open().textContent,/R\$0/);
 const absentUi=render(payload({live_produtos:[{...products[12],gmv_direto:null,pedidos:null,impressoes:null}]}));const absent=absentUi.open();assert.ok((absent.textContent.match(/indisponível/g)||[]).length>=3);
});
test('missing collections and metrics are unavailable, strings remain escaped, reconciliation and filters survive',()=>{
 const data=payload({lives:undefined,live_produtos:undefined,videos:undefined});const missing=render(data);assert.match(missing.text(),/Lista de sessões indisponível/);assert.match(missing.text(),/Lista de vídeos indisponível/);
 assert.equal(TTS.coberturaLiveVideo(data,'fish').lives.recebidos,null);
 const all=payload({canal_total:[{marca:'fish',gmv:100,pedidos:1,visitantes:10}],videos:[video({titulo:'<img src=x>',gmv:null,visualizacoes:null,pedidos:null,gpm:null}),video({marca:'aristo',titulo:'Must stay outside filter'})]});
 const ui=render(all);assert.match(ui.text(),/Fixture reconciliation preserved/);assert.doesNotMatch(ui.text(),/Must stay outside filter/);assert.equal(ui.document.querySelector('img'),null);assert.match(ui.html(),/&lt;img src=x&gt;/);assert.match(ui.text(),/indisponível/);
});
