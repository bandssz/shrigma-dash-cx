/* Synthetic reconciliation contract: financial lenses stay separate. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const TTS=require('../influs-tts.js');
const row=(o={})=>({marca:'aristo',dia:'2026-09-19',gmv:100,gmv_afiliado:40,gmv_proprio:60,pedidos:2,visitantes:10,
 gmv_saldo_nao_afiliado:60,gmv_ajuste_origem:0,gmv_ajuste_origem_absoluto:0,origem_estado:'saldo_calculado',
 origem_modelo:'analytics_total_menos_pedidos_afiliados',origem_dias_divergentes:0,origem_dias_indisponiveis:0,...o});
const canal=(rows,marca='aristo')=>TTS.canal({canal:rows,canal_total:rows},marca,'2026-09-19');
function ui(rows,marca='aristo'){
 const code=fs.readFileSync(path.join(__dirname,'../influs-tts.js'),'utf8'),a=code.indexOf('  const moedaOrigem ='),b=code.indexOf('  // Linhas além',a);
 assert(a>=0&&b>a);const context=vm.createContext({TTS,DADOS:{canal:rows,canal_total:rows,janela:{ini:'2026-09-19',fim:'2026-09-19'}},marcaAtual:()=>marca,
  nf:v=>v==null?'—':String(v),rf:v=>v==null?'—':String(v),pctOu:v=>v==null?'—':String(v)+'%',
  esc:v=>String(v??'').replace(/[<>&"']/g,x=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[x]))});
 vm.runInContext(code.slice(a,b),context);return {summary:context.resumoOrigemCanal(canal(rows,marca)),cards:context.cardsCanal()};
}
test('TikTok origin uses the explicit calculated balance and preserves all original metrics',()=>{
 const r=row(),p={canal:[r],canal_total:[r]},before=JSON.stringify(p),c=TTS.canal(p,'aristo');
 assert.equal(c.gmv,100);assert.equal(c.afiliado,40);assert.equal(c.proprio,60);assert.equal(c.origem.saldo,60);assert.equal(c.origem.estado,'saldo_calculado');assert.equal(JSON.stringify(p),before);
 const h=ui([r]);assert.match(h.cards,/Saldo não afiliado · calculado/);assert.match(h.cards,/não é venda própria atribuída/);assert.doesNotMatch(h.cards,/60 próprio/);assert.match(h.summary,/Próprio anterior/);
});
test('TikTok origin never substitutes historical own sales for an unavailable balance',()=>{
 const r=row({gmv:100,gmv_afiliado:110,gmv_proprio:7,gmv_saldo_nao_afiliado:null,gmv_ajuste_origem:-17,gmv_ajuste_origem_absoluto:17,origem_estado:'divergente',origem_dias_divergentes:1});
 const c=canal([r]);assert.equal(c.gmv,100);assert.equal(c.afiliado,110);assert.equal(c.pctAfiliado,110);assert.equal(c.proprio,7);assert.equal(c.origem.saldo,null);assert.equal(c.origem.ajuste,-17);
 const h=ui([r]);assert.match(h.cards,/indisponível · conferir conciliação/);assert.match(h.summary,/Fontes divergentes/);assert.match(h.summary,/-R\$\s*17,00/);assert.match(h.summary,/não receita, reembolso ou crédito atribuído/);
});
test('TikTok opposite daily differences do not cancel the divergence indicator',()=>{
 const a=row({gmv_saldo_nao_afiliado:null,gmv_ajuste_origem:10,gmv_ajuste_origem_absoluto:10,origem_estado:'divergente',origem_dias_divergentes:1});
 const b=row({...a,marca:'fish',gmv_ajuste_origem:-10});const c=canal([a,b],'todas');
 assert.equal(c.origem.saldo,null);assert.equal(c.origem.estado,'divergente');assert.equal(c.origem.ajuste,0);assert.equal(c.origem.ajusteAbsoluto,20);assert.equal(c.origem.diasDivergentes,2);
});
test('TikTok unknown component keeps whole-period adjustments unknown while retaining known daily audit rows',()=>{
 const unknown=row({marca:'fish',gmv_saldo_nao_afiliado:null,gmv_ajuste_origem:null,gmv_ajuste_origem_absoluto:null,origem_estado:'indisponivel',origem_dias_indisponiveis:1});
 const c=canal([row(),unknown],'todas');assert.equal(c.origem.saldo,null);assert.equal(c.origem.ajuste,null);assert.equal(c.origem.ajusteAbsoluto,null);assert.equal(c.origemLinhas.length,2);
 assert.match(ui([row(),unknown],'todas').summary,/indisponível/);
});
test('TikTok divergence has precedence while missing-day count and unavailable adjustment stay explicit',()=>{
 const r=row({gmv_saldo_nao_afiliado:null,gmv_ajuste_origem:null,gmv_ajuste_origem_absoluto:null,origem_estado:'divergente',origem_dias_divergentes:1,origem_dias_indisponiveis:1});
 const x=canal([r]).origem;assert.equal(x.estado,'divergente');assert.equal(x.saldo,null);assert.equal(x.ajuste,null);assert.equal(x.diasIndisponiveis,1);
});
test('TikTok missing contract or selected brand does not compute an improvised balance',()=>{
 for(const r of [row({origem_modelo:undefined}),row({origem_modelo:'different-model'}),row({origem_estado:undefined})]){
  const c=canal([r]);assert.equal(c.origem.contrato,false);assert.equal(c.origem.saldo,null);assert.match(ui([r]).summary,/ainda não confirma o contrato/);
 }
 assert.equal(canal([row()],'todas').origem.contrato,false);
});
test('TikTok measured zero remains zero and daily labels are escaped',()=>{
 const r=row({gmv:0,gmv_afiliado:0,gmv_proprio:0,gmv_saldo_nao_afiliado:0});assert.equal(canal([r]).origem.saldo,0);assert.match(ui([r]).cards,/R\$\s*0,00/);
 const code=fs.readFileSync(path.join(__dirname,'../influs-tts.js'),'utf8'),a=code.indexOf('  const moedaOrigem ='),b=code.indexOf('  function cardsCanal()',a),ctx=vm.createContext({nf:String,esc:v=>String(v).replace(/</g,'&lt;').replace(/>/g,'&gt;')});vm.runInContext(code.slice(a,b),ctx);
 const c=canal([row()]);c.origemLinhas=[row({marca:'<img src=x>'})];const html=ctx.resumoOrigemCanal(c);assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img src=x>/);
});
