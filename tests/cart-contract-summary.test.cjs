'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const S=require((process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'))+'/server.cjs');
const row=()=>({marca:'fish',dia:'2026-10-12',carrinhos:2,valor_em_jogo:100,com_consent:1,voltaram_72h:1,receita_voltaram:50,recuperados:null,receita_recuperada:null});
test('cart diagnostics count each missing/null/type without returning values or another brand',()=>{
 const a=row();delete a.valor_em_jogo;a.com_consent=null;a.voltaram_72h={email:'private@synthetic.invalid'};
 const b={...row(),marca:'aristo',recuperados:1,receita_recuperada:30},d=S.cartContractSummary({crm_carrinho:[a,b]},'fish');
 assert.equal(d.rowsObserved,1);assert.deepEqual(d.fields.valor_em_jogo,{absent:1,null:0,invalidType:0});assert.equal(d.fields.com_consent.null,1);assert.equal(d.fields.voltaram_72h.invalidType,1);assert.deepEqual(d.recoveryPair,{bothNull:1,bothNumeric:0,mixed:0});assert(!JSON.stringify(d).includes('private@'));assert(!JSON.stringify(d).includes('2026-10-12'));assert(!JSON.stringify(d).includes('aristo'));
});
test('missing or malformed cart does not manufacture empty counts; a real empty array is measured',()=>{
 assert.deepEqual(S.cartContractSummary({},'fish'),{status:'missing'});assert.deepEqual(S.cartContractSummary({crm_carrinho:null},'fish'),{status:'invalid'});assert.equal(S.cartContractSummary({crm_carrinho:[]},'fish').rowsObserved,0);
 const unscoped=row();delete unscoped.marca;assert.deepEqual(S.cartContractSummary({crm_carrinho:[unscoped]},'fish'),{status:'unscoped'});
});
test('mixed recovery nullability remains explicit, not an inferred recovery or zero',()=>{
 const r=row();r.receita_recuperada=0;const d=S.cartContractSummary({crm_carrinho:[r]},'fish');assert.equal(d.recoveryPair.mixed,1);assert.equal(d.fields.recuperados.null,1);
 const out=S.projectBrandCache({crm_diario:[{marca:'fish',dia:r.dia,enviados:1}],crm_carrinho:[r]},'fish','growth','https://gerencial.synthetic.invalid');assert(!Object.hasOwn(out,'crm_carrinho'));assert.deepEqual(out.read_issues,[{section:'crm_carrinho',reason:'recovery_pair_mismatch',field:'recuperados'}]);
});
test('an observed null return revenue retains all known cart metrics and the source null',()=>{
 const r=row();r.receita_voltaram=null;r.customer_email='private@synthetic.invalid';const out=S.projectBrandCache({crm_carrinho:[r]},'fish','growth','https://gerencial.synthetic.invalid');assert.equal(out.crm_carrinho.length,1);assert.equal(out.crm_carrinho[0].carrinhos,2);assert.equal(out.crm_carrinho[0].receita_voltaram,null);assert(!Object.hasOwn(out,'read_issues'));assert(!JSON.stringify(out).includes('private@'));
});
const G=require('../growth-data.js'),day='2026-10-12',cart=(extra={})=>({...row(),...extra});
test('cart aggregate never sums unknown return revenue as zero or a partial complete total',()=>{
 const out=G.carrinho({crm_carrinho:[cart({receita_voltaram:null}),cart({dia:'2026-10-11',carrinhos:3,valor_em_jogo:200,voltaram_72h:2,receita_voltaram:75})]},'fish','2026-10-01',day);assert.equal(out.carrinhos,5);assert.equal(out.voltaram,3);assert.equal(out.valor,300);assert.equal(out.receitaVoltaram,null);assert.equal(out.receitaVoltaramDiasIndisponiveis,1);
});
test('legitimate zero revenue remains zero and unknown days outside the window do not affect the result',()=>{
 const api={crm_carrinho:[cart({receita_voltaram:0}),cart({dia:'2026-09-01',receita_voltaram:null})]},out=G.carrinho(api,'fish',day,day);assert.equal(out.receitaVoltaram,0);assert.equal(out.receitaVoltaramDiasIndisponiveis,0);assert.equal(out.carrinhos,2);
});
test('brand selection excludes unknown revenue from another brand; consolidated totals stay honest',()=>{
 const api={crm_carrinho:[cart(),cart({marca:'aristo',receita_voltaram:null})]};assert.equal(G.carrinho(api,'fish',day,day).receitaVoltaram,50);assert.equal(G.carrinho(api,'todas',day,day).receitaVoltaram,null);
});
function renderCart(api){
 const fs=require('node:fs'),vm=require('node:vm'),html=fs.readFileSync(path.resolve(__dirname,'../growth.html'),'utf8'),start=html.indexOf('  if(automationHistory){\n  const car=G.carrinho'),end=html.indexOf('\n  if(resultsOverview){',start);assert(start>0&&end>start);const elements=new Map(),ctx={API:api,G,MARCA:'fish',ini:day,fim:day,automationHistory:true,Date,rf:v=>'R$'+String(v),nf:String,cor:()=> 'blue',$:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);}};vm.runInNewContext(html.slice(start,end),ctx);return elements.get('#area-carrinho').innerHTML;
}
test('actual cart UI marks missing return revenue and lost amount unavailable while rendering known counts',()=>{
 const html=renderCart({crm_carrinho:[cart({receita_voltaram:null})]});assert.match(html,/<b>Indisponível<\/b>/);assert.match(html,/receita de retorno indisponível/);assert.match(html,/2 carrinhos · R\$100 em jogo/);assert.match(html,/não foram calculados/);assert(!html.includes('R$0 voltou'));assert(!html.includes('<b>R$100</b>'));
});
test('actual cart UI still displays a fully measured zero and its valid unrecovered amount',()=>{
 const html=renderCart({crm_carrinho:[cart({receita_voltaram:0})]});assert.match(html,/<b>R\$100<\/b>/);assert.match(html,/R\$0 voltou/);assert(!html.includes('receita de retorno indisponível'));
});
test('malformed or absent return revenue still refuses instead of accepting an arbitrary source payload',()=>{
 for(const value of [undefined,{unsafe:true},'not a number']){
  const r=cart({receita_voltaram:value});if(value===undefined)delete r.receita_voltaram;
  const out=S.projectBrandCache({crm_diario:[{marca:'fish',dia:day,enviados:1}],crm_carrinho:[r]},'fish','growth','https://gerencial.synthetic.invalid');assert(!Object.hasOwn(out,'crm_carrinho'));assert.equal(out.read_issues[0].section,'crm_carrinho');
 }
});
