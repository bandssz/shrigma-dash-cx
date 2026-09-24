const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../influs.html'),'utf8');
const start=html.indexOf('const G = {'),end=html.indexOf('\n};',start)+3;
const c=(codigo,tipo,influ=null,marca='aristo')=>({marca,codigo,tipo,influ}),r=(codigo,receita,marca='aristo')=>({marca,codigo,receita});
function ctx(extra){const x=vm.createContext({Intl,Date,Number,...extra});vm.runInContext(html.slice(start,end)+'globalThis.G=G;',x);return x;}
test('store campaign coupon stays out of tracked revenue and is reported as ownerless',()=>{
 const {G}=ctx();
 const p={cupons:[c('CREATOR10','influ','ana'),c('100IMPOSTO','campanha'),c('TODO','pendente'),c('SEMDONO','influ','')],
   receita_cupom:[r('CREATOR10',1000),r('100IMPOSTO',61556),r('TODO',20),r('SEMDONO',5),r('FISHX',70,'fish')]};
 const a=G.receitaCupomDono(p,'aristo');
 assert.equal(a.comDono,1000);assert.equal(a.semDono,61581);
 assert.equal(JSON.stringify(a.semDonoCupons.map(x=>x[0])),JSON.stringify(['100IMPOSTO','TODO','SEMDONO']));
 assert.equal(G.receitaCupomDono(p,'todas').semDono,61651);
});
test('invalid amounts are ignored, not turned into zero-owner revenue',()=>{
 const {G}=ctx();
 const a=G.receitaCupomDono({cupons:[c('A','influ','x')],receita_cupom:[r('A',null),r('A',''),r('A','abc'),r('A','10.5'),null]},'aristo');
 assert.equal(a.comDono,10.5);assert.equal(a.semDono,0);
});
test('KPI card shows owned revenue and an ownerless tag with the coupons in the title',()=>{
 const targets=new Map();
 const x=vm.createContext({Intl,Date,Number,INFLU:{roi:[{marca:'aristo',receita:900,custo_lancado:10,modelo:'comissao'}],cupons:[c('CREATOR10','influ','ana'),c('100IMPOSTO','campanha')],receita_cupom:[r('CREATOR10',1000),r('100IMPOSTO',61556)],receita_sku:[]},MARCA:'aristo',PER:{ini:'2026-08-25',fim:'2026-09-24'},rf:v=>'R$'+Number(v).toFixed(2),nf:String,roiTxt2f:String,$:id=>{if(!targets.has(id))targets.set(id,{innerHTML:''});return targets.get(id);}});
 vm.runInContext(html.slice(start,end)+html.slice(html.indexOf('function renderKPIs(){'),html.indexOf('\nconst roiTxt=',html.indexOf('function renderKPIs(){')))+'renderKPIs();',x);
 const out=targets.get('#area-kpis').innerHTML;
 assert.match(out,/Receita rastreada <span class="tag alerta" title="[^"]*100IMPOSTO R\$61556\.00[^"]*">\+ R\$61556\.00 sem dono<\/span>/);
 assert.match(out,/<div class="kpi-val tabn">R\$1000\.00<\/div>/);
 assert.doesNotMatch(out,/R\$62556\.00/);
});
test('no tag when every coupon has an owner',()=>{
 const targets=new Map();
 const x=vm.createContext({Intl,Date,Number,INFLU:{roi:[],cupons:[c('A','influ','ana')],receita_cupom:[r('A',50)],receita_sku:[]},MARCA:'aristo',PER:{ini:'a',fim:'b'},rf:v=>'R$'+v,nf:String,roiTxt2f:String,$:id=>{if(!targets.has(id))targets.set(id,{innerHTML:''});return targets.get(id);}});
 vm.runInContext(html.slice(start,end)+html.slice(html.indexOf('function renderKPIs(){'),html.indexOf('\nconst roiTxt=',html.indexOf('function renderKPIs(){')))+'renderKPIs();',x);
 assert.doesNotMatch(targets.get('#area-kpis').innerHTML,/sem dono/);
});
