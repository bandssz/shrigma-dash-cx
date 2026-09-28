'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const day='2026-09-27';
function fixture(){
 const wa=(flow,piece,aceitos,entregues)=>({marca:'olivas',canal:'whatsapp',dia:day,flow,piece,aceitos,entregues,falhas:0,lidos:0,pendentes_entrega:aceitos-entregues,sem_disparo_confirmado:0,erros_sincronos:0});
 const email=(flow,piece,enviados)=>({marca:'olivas',canal:'email',dia:day,flow,piece,enviados});
 return {crm_campanha:[],crm_conversao:[],crm_wa_cobertura:{inicio:day,fim:day},
  crm_fluxo:[email('carrinho','carrinho-1h',12),email('transacional','pedido-pago',7),{...email('carrinho','carrinho-1h',999),marca:'fish'}],
  crm_wa_envios:[wa('carrinho','carrinho-24h',5,3),wa('transacional','pedido-pago',4,4),wa('teste-motor','teste',99,99),{...wa('carrinho','carrinho-24h',888,888),marca:'aristo'},{...wa('carrinho','fora-do-periodo',100,100),dia:'2026-09-26'}],
  crm_attribution:{schema_version:2,coverage:[{brand:'olivas',day,checked_at:day+'T23:00:00Z'}],daily:[{marca:'olivas',dia:day,model:'last_click',grain:'flow_piece',dimension:['email','olivas-carrinho','carrinho-1h'],pedidos:1,receita:100,assistidos:0,receita_assistida:0}]}};
}
function boot(api=fixture(),channel='todos'){
 const {document,window}=parseHTML('<html><body><select id="sel-flow"></select><input id="regua-busca"><button id="regua-export"></button><span id="n-regua"></span><span id="regua-rot"></span><table id="tab-regua"><thead></thead><tbody></tbody></table><p id="nota-regua"></p></body></html>');
 const proto=Object.getPrototypeOf(document.querySelector('select'));
 Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||'';},set(value){for(const o of this.options)o.toggleAttribute('selected',o.value===value);}});
 const downloads=[],context=vm.createContext({document,window,Intl,Date,api,__download:(name,text)=>downloads.push({name,text})});
 for(const file of ['growth-table.js','growth-data.js','growth-attribution.js','growth-delivery.js','growth-ui.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context,{filename:file});
 vm.runInContext(`GA.install(G);GT.baixar=__download;globalThis.rows=GUI.flows({G,GD,api,marca:'olivas',ini:'${day}',fim:'${day}',canal:${JSON.stringify(channel)},exportMeta:()=>({marca:'olivas',canal:${JSON.stringify(channel)},ini:'${day}',fim:'${day}'})});`,context);
 return {document,window,rows:context.rows,downloads,q:s=>document.querySelector(s),tableRows:()=>[...document.querySelectorAll('tbody tr')]};
}
test('Olivas shows cart and transactional sends in each channel without tests, other brands or duplicate delivery rows',()=>{
 const x=boot();assert.equal(x.rows.length,4);assert.equal(x.tableRows().length,4);
 assert.deepEqual([...x.rows].map(r=>r.enviados).sort((a,b)=>a-b),[4,5,7,12]);
 const email=boot(fixture(),'email'),wa=boot(fixture(),'whatsapp');assert.equal(email.rows.length,2);assert.equal(wa.rows.length,2);
 assert.ok(email.rows.every(r=>r.canal==='email'));assert.ok(wa.rows.every(r=>r.canal==='whatsapp'));
 assert.doesNotMatch(x.q('tbody').textContent,/teste-motor|fora-do-periodo|Fishermans|Aristocrata/);
 const cart=wa.rows.find(r=>r.flow==='carrinho');assert.equal(cart.enviados,5);assert.equal(cart.entregues,3);assert.equal(cart.pendentes_entrega,2);
 assert.match(wa.q('#nota-regua').textContent,/aceitas para envio/);
});
test('Olivas delivery-only rows show an unknown conversion and preserve the reason in the CSV',()=>{
 const x=boot(fixture(),'whatsapp');
 for(const row of x.rows){assert.equal(row.receita,null);assert.equal(row.pedidos,null);assert.equal(row.porMil,null);assert.equal(row.atribuicao_sem_vinculo,true);}
 for(const tr of x.tableRows()){assert.equal(tr.children[5].textContent,'Sem vínculo');assert.equal(tr.children[6].textContent,'—');}
 x.q('#regua-export').click();assert.equal(x.downloads.length,1);assert.match(x.downloads[0].text,/Conversão sem vínculo confirmado/);
 assert.match(x.downloads[0].text,/carrinho-24h/);assert.doesNotMatch(x.downloads[0].text,/teste-motor|fora-do-periodo/);
});
test('recorded email attribution remains visible and partial coverage stays unknown',()=>{
 const api=fixture(),x=boot(api,'email'),cart=x.rows.find(r=>r.flow==='carrinho');assert.equal(cart.pedidos,1);assert.equal(cart.receita,100);
 api.crm_attribution.coverage=[];const partial=boot(api,'email');for(const row of partial.rows){assert.equal(row.receita,null);assert.equal(row.pedidos,null);assert.equal(row.porMil,null);}
});
test('search and exports stay on Olivas and escape piece content',()=>{
 const api=fixture();api.crm_wa_envios[0].piece='<img src=x onerror=fixture>';const x=boot(api,'whatsapp');
 assert.equal(x.q('tbody img'),null);assert.ok(x.q('tbody').textContent.includes('<img src=x onerror=fixture>'));
 const input=x.q('#regua-busca');input.value='pedido-pago';input.dispatchEvent(new x.window.Event('input'));assert.equal(x.tableRows().length,1);
 x.q('#regua-export').click();assert.match(x.downloads[0].text,/pedido-pago/);assert.doesNotMatch(x.downloads[0].text,/<img|carrinho/);
});
