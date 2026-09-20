const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../influs.html'),'utf8');
const start=html.indexOf('const G = {'),end=html.indexOf('\n};',start)+3,context=vm.createContext({Intl,Date});
vm.runInContext(html.slice(start,end)+'globalThis.calc=G.receitaCuponsPendentes;',context);
const c=(codigo,tipo,influ=null,marca='fish')=>({marca,codigo,tipo,influ}),r=(codigo,receita,marca='fish')=>({marca,codigo,receita});
test('coupon work queue is independent of signed-product/ROI revenue and excludes classified CRM/other coupons',()=>{
 const input={cupons:[c('KNOWN','influ','creator'),c('TODO','pendente'),c('CRM','crm'),c('INVALID','influ'),c('GIFT','cortesia')],receita_cupom:[r('KNOWN',80),r('TODO',20),r('CRM',40),r('INVALID',5),r('GIFT',30)],roi:[{marca:'fish',receita:150}]};
 assert.equal(context.calc(input,'fish').receitaConhecida,25);
 input.roi[0].receita=100000;assert.equal(context.calc(input,'fish').receitaConhecida,25);
});
test('same code belongs to its own brand; measured zero and fractional amounts remain measured',()=>{
 const p={cupons:[c('SAME','influ','owner'),c('SAME','pendente',null,'aristo'),c('ZERO','pendente')],receita_cupom:[r('SAME',80),r('SAME','0.50','aristo'),r('ZERO',0)]};
 assert.equal(context.calc(p,'fish').receitaConhecida,0);assert.equal(context.calc(p,'aristo').receitaConhecida,0.5);assert.equal(context.calc(p,'todas').receitaConhecida,0.5);
});
test('missing sources, invalid amounts, unknown catalog and duplicate identities remain unconfirmed',()=>{
 assert.equal(context.calc({cupons:[]},'fish').disponivel,false);
 const p={cupons:[c('A','pendente'),c('B','pendente'),c('B','influ','other'),c('C','pendente'),c('VALID','pendente')],receita_cupom:[r('A',20),r('A',40),r('B',40),r('MISSING',50),r('C',null),r('VALID',20),null]};
 const result=context.calc(p,'fish');assert.equal(result.receitaConhecida,20);assert.equal(result.naoConciliadas,6);
 for(const value of [null,undefined,'',true,false,NaN,Infinity]){const v=context.calc({cupons:[c('X','pendente')],receita_cupom:[r('X',value)]},'fish');assert.equal(v.naoConciliadas,1);}
});
test('real KPI rendering reports pending coupon subtotal even when ROI union exceeds all coupon revenue',()=>{
 const targets=new Map(),ctx=vm.createContext({Intl,Date,Number,INFLU:{roi:[{marca:'fish',receita:150,custo_lancado:10,modelo:'comissao'}],cupons:[c('KNOWN','influ','owner'),c('TODO','pendente')],receita_cupom:[r('KNOWN',80),r('TODO',20)],receita_sku:[]},MARCA:'fish',PER:{ini:'2026-09-01',fim:'2026-09-19'},rf:x=>'R$'+Number(x).toFixed(2),nf:String,roiTxt2f:String,$:id=>{if(!targets.has(id))targets.set(id,{innerHTML:''});return targets.get(id);}});
 vm.runInContext(html.slice(start,end)+html.slice(html.indexOf('function renderKPIs(){'),html.indexOf('\nconst roiTxt=',html.indexOf('function renderKPIs(){')))+'renderKPIs();',ctx);
 const out=targets.get('#faixa-alertas').innerHTML;assert.match(out,/R\$20\.00/);assert.match(out,/pendentes de classificação/);assert.doesNotMatch(out,/R\$-50\.00/);
 assert.match(targets.get('#area-kpis').innerHTML,/R\$150\.00/); // Existing ROI basis unchanged.
});
