const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
// CAC por cliente novo no KPI de Influs: investimento ÷ clientes com 1º pedido pelo cupom; sem índice fica à parte.
const html=fs.readFileSync(path.join(__dirname,'../influs.html'),'utf8');
const start=html.indexOf('const G = {'),end=html.indexOf('\n};',start)+3;
const kpis=html.slice(html.indexOf('function renderKPIs(){'),html.indexOf('\nconst roiTxt=',html.indexOf('function renderKPIs(){')));
function render(INFLU,MARCA='todas'){
 const targets=new Map();
 const x=vm.createContext({Intl,Date,Number,INFLU,MARCA,PER:{ini:'2026-09-01',fim:'2026-09-30'},rf:v=>'R$'+(+v).toFixed(2),nf:String,roiTxt2f:String,
  $:id=>{if(!targets.has(id))targets.set(id,{innerHTML:''});return targets.get(id);}});
 vm.runInContext(html.slice(start,end)+kpis+'renderKPIs();',x);return targets.get('#area-kpis').innerHTML;
}
const base=()=>({roi:[{marca:'aristo',influ:'ana',receita:1000,comissao:50,custo_lancado:450,investimento:500,modelo:'hibrido'},{marca:'fish',influ:'pedro',receita:300,comissao:15,custo_lancado:85,investimento:100,modelo:'hibrido'}],
 cupons:[],receita_cupom:[],receita_sku:[]});
test('CAC = investimento ÷ clientes novos dos creators do filtro',()=>{
 const p={...base(),clientes:[{marca:'aristo',influ:'ana',pedidos:10,novos:4,recorrentes:6,sem_indice:0},{marca:'fish',influ:'pedro',pedidos:5,novos:1,recorrentes:4,sem_indice:0}]};
 const todas=render(p);assert.match(todas,/CAC por cliente novo/);assert.match(todas,/R\$120\.00/,'600 ÷ 5');assert.match(todas,/5 clientes novos · 33% dos pedidos/);
 assert.match(render(p,'aristo'),/R\$125\.00/,'500 ÷ 4 só com a marca');
});
test('pedido sem índice ganha etiqueta e não entra como novo',()=>{
 const p={...base(),clientes:[{marca:'aristo',influ:'ana',pedidos:10,novos:4,recorrentes:4,sem_indice:2}]};
 const out=render(p,'aristo');assert.match(out,/2 sem índice<\/span>/);assert.match(out,/R\$125\.00/);
});
test('leitura sem o bloco clientes ou sem cliente novo mostra —, nunca zero',()=>{
 assert.match(render(base()),/a leitura ainda não traz clientes novos/);
 const out=render({...base(),clientes:[{marca:'aristo',influ:'ana',pedidos:3,novos:0,recorrentes:3,sem_indice:0}]},'aristo');
 assert.match(out,/nenhum 1º pedido pelo cupom no período/);assert.doesNotMatch(out,/R\$0\.00<\/div>\s*<div class="kpi-sub">nenhum/);
});
