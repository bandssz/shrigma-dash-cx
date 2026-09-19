/* Synthetic source contracts. No network, customer records or production amounts. */
const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../dados.js'),M=require('../cx-metricas.js');
const snapshot=(o={})=>({marca:'aristocrata',dia:'2026-09-18',novos:10,fechados:10,ia_perguntas:10,csat_cobertura:40,kai_deflexao:50,coletas_ok:1,coletas_total:1,...o});
test('CX missing CSAT coverage and Kai deflection remain null in daily aggregation',()=>{
 for(const value of [null,undefined,'','   ','invalid',NaN,Infinity,false]){
  const x=D.agregaDias([snapshot({csat_cobertura:value,kai_deflexao:value})]);assert.equal(x.csat_cobertura,null);assert.equal(x.kai_deflexao,null);
 }
 const zero=D.agregaDias([snapshot({csat_cobertura:0,kai_deflexao:'0'})]);assert.equal(zero.csat_cobertura,0);assert.equal(zero.kai_deflexao,0);
});
test('CX keeps the existing weights and excludes absent values rather than adding ratios',()=>{
 const x=D.agregaDias([snapshot({fechados:1,ia_perguntas:1,csat_cobertura:'20',kai_deflexao:'10'}),snapshot({fechados:3,ia_perguntas:9,csat_cobertura:'80',kai_deflexao:'90'}),snapshot({fechados:100,ia_perguntas:100,csat_cobertura:null,kai_deflexao:null})]);
 assert.equal(x.csat_cobertura,65);assert.equal(x.kai_deflexao,82);assert.equal(x.aprox,true);
});
test('CX exact windows preserve missing values and still override daily approximations',()=>{
 for(const value of [null,undefined,'','invalid',0,'42']){
  const dados={snapshot_1d:[snapshot()],janelas:[snapshot({janela:'7d',csat_cobertura:value,kai_deflexao:value})]};
  const x=D.agregaRange(dados,'aristocrata','2026-09-12','2026-09-18','2026-09-19');
  const expected=value===0?0:value==='42'?42:null;assert.equal(x.csat_cobertura,expected);assert.equal(x.kai_deflexao,expected);assert.equal(x.aprox,false);assert.equal(x.dias,7);
 }
});
const row=(o={})=>({marca:'aristocrata',mes:'2026-08-01',valor_concedido:100,receita:1000,dias_receita:31,dias:31,pedidos:20,casos:2,...o});
const filter=(o={})=>({marcas:['aristocrata','fishermans'],mesIni:'2026-08-01',mesFim:'2026-08-01',...o});
test('CX concession cannot present a complete percentage when a selected brand-month is absent',()=>{
 const x=M.concessaoAgg([row()],filter());assert.equal(x.receitaFaltando,true);assert.equal(x.pct,null);assert.equal(x.receita,1000);assert.equal(x.valorConcedido,100);
 const single=M.concessaoAgg([row()],filter({marcas:['aristocrata']}));assert.equal(single.receitaFaltando,false);assert.equal(single.pct,10);
});
test('CX concession uses aggregate numerator over aggregate revenue, never the sum of brand percentages',()=>{
 const rows=[row(),row({marca:'fishermans',receita:9000,valor_concedido:1800})],x=M.concessaoAgg(rows,filter());
 assert.equal(x.receitaFaltando,false);assert.equal(x.receita,10000);assert.equal(x.valorConcedido,1900);assert.equal(x.pct,19);assert.equal(x.casos,4);assert.equal(x.pedidos,40);
});
test('CX concession checks every requested month, including a completely missing interior month and year rollover',()=>{
 const rows=[row({mes:'2026-07-01'}),row({mes:'2026-09-01',dias:19,dias_receita:19})];
 const x=M.concessaoAgg(rows,filter({marcas:['aristocrata'],mesIni:'2026-07-01',mesFim:'2026-09-01'}));assert.equal(x.receitaFaltando,true);assert.equal(x.pct,null);
 const complete=M.concessaoAgg([row({mes:'2025-12-01'}),row({mes:'2026-01-01'})],filter({marcas:['aristocrata'],mesIni:'2025-12-01',mesFim:'2026-01-01'}));assert.equal(complete.receitaFaltando,false);assert.equal(complete.pct,10);
});
test('CX concession preserves source calendar for the current month and distinguishes measured zero from absence',()=>{
 const f=filter({marcas:['aristocrata'],mesIni:'2026-09-01',mesFim:'2026-09-01'}),r=row({mes:'2026-09-01',dias:19,dias_receita:19,valor_concedido:0});
 const x=M.concessaoAgg([r],f);assert.equal(x.receitaFaltando,false);assert.equal(x.pct,0);
 const zero=M.concessaoAgg([{...r,receita:0}],f);assert.equal(zero.receitaFaltando,false);assert.equal(zero.pct,null,'zero denominator is not a zero rate');
 const absent=M.concessaoAgg([],f);assert.equal(absent.receitaFaltando,true);assert.equal(absent.pct,null);
});
test('CX concession never releases a percentage from invalid revenue or missing/invalid coverage',()=>{
 const f=filter({marcas:['aristocrata']});
 for(const change of [{receita:null},{receita:undefined},{receita:''},{receita:'invalid'},{receita:Infinity},{dias:null},{dias:0},{dias_receita:null},{dias_receita:30},{dias_receita:32},{dias_receita:31.5}]){
  const x=M.concessaoAgg([row(change)],f);assert.equal(x.receitaFaltando,true,JSON.stringify(change));assert.equal(x.pct,null);
 }
 const valid=M.concessaoAgg([row({receita:'1000',dias:'31',dias_receita:'31'})],f);assert.equal(valid.receitaFaltando,false);assert.equal(valid.pct,10);
});
