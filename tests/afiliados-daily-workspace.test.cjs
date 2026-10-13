'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{parseHTML}=require('linkedom'),TTS=require('../influs-tts.js');
const source=fs.readFileSync(require.resolve('../influs-tts.js'),'utf8'),NOW=Date.parse('2026-10-13T03:00:00Z');
function dom(data,fn){
 const {document}=parseHTML('<main id="tts-area"></main>'),area=document.getElementById('tts-area'),select=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(select,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||''},set(v){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===String(v))}});
 const scope={TTS,DADOS:data,PRODUCT_FRONT:{id:'afiliados'},document,Date:class extends Date{static now(){return NOW}},marcaAtual:()=> 'fish',$:s=>document.querySelector(s),
  nf:x=>x==null?'—':String(x),rf:x=>x==null?'—':'R$ '+x,pf:x=>x==null?'—':Math.round(x)+'%',esc:x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),tag:x=>String(x),
  produtoCelTTS:x=>'<span>'+String(x.product_title||'Sample')+'</span>',prazo:x=>x==null?'sem prazo':String(x),iniciais:()=> 'SY',MARCA_N:{fish:'Fish'},produtoTTS:()=>null,
  carregarProdutosTTS(){},travaAmostrasTTS(){},armar(){throw Error('No decisions in read-only UI test')},acaoTTS(){throw Error('No source writes')},carregarTTS(){throw Error('No source reads from local filter')},dobra:rows=>rows.join(''),ligarDobras(){}};
 const begin=source.indexOf('  function '+fn+'() {'),end=source.indexOf(fn==='renderCriadores'?'\n  function renderColabs()':'\n  // Produtos (foto',begin);assert(begin>0&&end>begin);vm.runInNewContext(source.slice(begin,end)+'\n'+fn+'();',scope);return {area,document,q:s=>document.querySelector(s)};
}
const creator=(name,gmv,extra={})=>({marca:'fish',username:name,nickname:name,gmv,pedidos:1,comissao:2,...extra});
test('creator search folds accents; numeric strings sort as values and absent data remains last',()=>{
 const rows=[creator('Ágata','9'),creator('Beta','100'),creator('Unknown',null)];assert.deepEqual(TTS.selecionaCriadores(rows).map(x=>x.username),['Beta','Ágata','Unknown']);assert.deepEqual(TTS.selecionaCriadores(rows,{direcao:'asc'}).map(x=>x.username),['Ágata','Beta','Unknown']);assert.equal(TTS.selecionaCriadores(rows,{busca:'agata'}).length,1);assert.equal(TTS.selecionaCriadores(rows,{busca:'@agata'}).length,1);assert.equal(rows[0].username,'Ágata');
});
test('creator controls search and sort the real rendered rows without changing GMV denominator',()=>{
 const f=dom({kpis:[{marca:'fish',gmv:400}],criadores:[creator('alpha',100,{pedidos:2}),creator('beta',50,{pedidos:5})]},'renderCriadores');assert.match(f.area.innerHTML,/>25%</);f.q('#tts-criador-ordem').value='pedidos';f.q('#tts-criador-ordem').onchange();assert.match(f.q('#tts-criador-rows tr').textContent,/beta/);
 f.q('#tts-criador-busca').value='alpha';f.q('#tts-criador-busca').oninput();assert.equal(f.q('#tts-criador-rows').children.length,1);assert.match(f.q('#tts-criador-rows').innerHTML,/>25%</);assert.match(f.q('#tts-criador-conta').textContent,/1 de 2/);f.q('#tts-criador-busca').value='missing';f.q('#tts-criador-busca').oninput();assert.equal(f.q('#tts-criador-vazio').hidden,false);
});
test('invalid creator handles are escaped text and cannot become a profile link',()=>{
 const f=dom({kpis:[{marca:'fish',gmv:100}],criadores:[creator('bad"><script>payload</script>',100)]},'renderCriadores');assert.equal(f.q('#tts-criador-rows a'),null);assert.equal(f.q('#tts-criador-rows script'),null);
});
test('deadline bands use exact time around zero and 24h and keep invalid deadline unknown',()=>{
 const at=offset=>new Date(NOW+offset).toISOString();for(const [offset,band]of [[-1,'vencido'],[0,'vencido'],[1,'24h'],[86400000,'24h'],[86400001,'depois']])assert.equal(TTS.faixaPrazo(at(offset),NOW),band);for(const x of [null,'','invalid'])assert.equal(TTS.faixaPrazo(x,NOW),'desconhecido');
});
test('deadline control filters decision and dispatch separately, preserving their totals',()=>{
 const sample=(id,h)=>({marca:'fish',username:id,nickname:id,product_title:'Sample',application_id:id,approve_expira_em:h===null?null:new Date(NOW+h*3600000).toISOString()});
 const f=dom({fila:[sample('old',-1),sample('soon',23),sample('later',25),sample('unknown',null)],envio:[{...sample('dispatch',23),envio_expira_em:new Date(NOW+23*3600000).toISOString()}],regra:[]},'renderFila');
 for(const [band,count,dispatch]of [['vencido',1,0],['24h',1,1],['depois',1,0],['desconhecido',1,0],['',4,1]]){f.q('#tts-amostra-prazo').value=band;f.q('#tts-amostra-prazo').onchange();assert.equal([...f.document.querySelectorAll('.tts-fila .tts-item')].filter(x=>!x.hidden).length,count);assert.equal([...f.document.querySelectorAll('.tts-envio .tts-item')].filter(x=>!x.hidden).length,dispatch);assert.match(f.q('#tts-envio-conta').textContent,new RegExp('^'+dispatch+' de 1'));}
});
test('dispatch-only queue still supports deadlines without a synthetic decision request',()=>{
 const f=dom({fila:[],envio:[{marca:'fish',username:'dispatch',product_title:'Sample',envio_expira_em:new Date(NOW+2*3600000).toISOString()}],regra:[]},'renderFila');f.q('#tts-amostra-prazo').value='vencido';f.q('#tts-amostra-prazo').onchange();assert.equal(f.q('.tts-envio .tts-item').hidden,true);assert.equal(f.q('.tts-fila'),null);
});
test('expired samples never show zero hours and absent own-brand GMV never becomes zero',()=>{
 assert.equal(TTS.horasAteAfiliados(new Date(NOW-1).toISOString(),NOW),-1);assert.equal(TTS.horasAteAfiliados(new Date(NOW).toISOString(),NOW),-1);assert.equal(TTS.horasAteAfiliados('invalid',NOW),null);
 const x={marca:'fish',username:'synthetic',nickname:'Synthetic',application_id:'1',product_title:'Sample',approve_expira_em:new Date(NOW-60000).toISOString(),pedidos_90d:3,gmv_90d_marca:null};
 const f=dom({fila:[x],envio:[],regra:[]},'renderFila');assert.match(f.area.textContent,/3 ped\. · GMV indisponível/);assert.equal(f.q('.tts-item').dataset.prazo,'vencido');assert.equal(f.q('.tts-item-prazo').textContent,'-1');
});
