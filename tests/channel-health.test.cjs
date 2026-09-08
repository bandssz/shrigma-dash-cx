const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require(require.resolve('linkedom',{paths:[path.resolve(__dirname,'../../growth-test-tools/node_modules')]}));
const source=fs.readFileSync(path.resolve(__dirname,'../alerta-whatsapp.js'),'utf8');
const G=require('../growth-data.js');
const now=Date.parse('2026-09-08T13:00:00Z');
const row=(name,time,state='ok')=>({nome:name,verificado_em:time,estado:state});
function boot(){
 const {document,window}=parseHTML('<html><head></head><body><header class="topo"><div class="status"></div></header></body></html>');
 class FixedDate extends Date{static now(){return now;}}
 const ctx=vm.createContext({document,window,module:{exports:{}},Date:FixedDate});
 vm.runInContext(source,ctx);
 return {document,render:window.avisoWhatsApp,assess:ctx.module.exports.avaliar};
}
test('coleta recente de uma conta não esconde outra com mais de duas horas',()=>{
 const x=boot();x.render([row('Fish','2026-09-08T12:59:00Z'),row('Aristo','2026-09-08T09:00:00Z')]);
 assert.match(x.document.querySelector('#wa-saude').textContent,/1 conta\(s\) sem confirmação/);
 assert.match(x.document.querySelector('#aviso-wa').textContent,/Aristo.*Sem verificação atual/);
 assert(!x.document.querySelector('#wa-saude').classList.contains('wa-ok'));
});
test('alerta antigo permanece visível como histórico sem declarar interrupção atual',()=>{
 const x=boot();x.render([{...row('SAC','2026-09-08T09:00:00Z','alerta'),motivo:'pagamento antigo'}]);
 const banner=x.document.querySelector('#aviso-wa');
 assert(banner.classList.contains('aviso'));assert(!banner.classList.contains('grave'));
 assert.match(banner.textContent,/último alerta: pagamento antigo/);
 assert.doesNotMatch(banner.textContent,/não chegam ao cliente|WhatsApp parado/);
});
test('alerta atual e conta antiga aparecem juntos sem um esconder o outro',()=>{
 const x=boot();x.render([row('Fish','2026-09-08T12:59:00Z','alerta'),row('Aristo','2026-09-08T09:00:00Z')]);
 const chip=x.document.querySelector('#wa-saude');
 assert(chip.classList.contains('wa-ruim'));assert.match(chip.textContent,/1 conta\(s\) em alerta.*1 sem confirmação/);
 assert.match(x.document.querySelector('#aviso-wa').textContent,/Aristo/);
});
test('data ausente, inválida ou muito futura e estado desconhecido nunca ficam verdes',()=>{
 for(const r of [row('Teste',null),row('Teste','inválido'),row('Teste','2026-09-09T12:00:00Z'),row('Teste','2026-09-08T12:59:00Z','erro')]){
  const x=boot();x.render([r]);assert(!x.document.querySelector('#wa-saude').classList.contains('wa-ok'));
 }
 const x=boot();x.render([]);assert.match(x.document.querySelector('#aviso-wa').textContent,/Nenhuma verificação/);
});
test('nomes e motivos recebidos são texto, e nova renderização remove alerta resolvido',()=>{
 const x=boot();x.render([{...row('<img src=x>','2026-09-08T12:59:00Z','alerta'),motivo:'<script>bad()</script>'}]);
 assert.equal(x.document.querySelectorAll('#aviso-wa img, #aviso-wa script').length,0);
 assert.match(x.document.querySelector('#aviso-wa').textContent,/<script>bad/);
 x.render([row('Fish','2026-09-08T12:59:00Z')]);
 assert.equal(x.document.querySelector('#aviso-wa'),null);
 assert.match(x.document.querySelector('#wa-saude').textContent,/sem alertas em 1/);
});
test('avisos de e-mail respeitam canal e não usam o recorte como reputação SES',()=>{
 const cs=[{truncado:true,campanha_id:1,enviados:50,publico:100,medido:false,medido_clique:false}];
 const totals={hardPct:2,complPct:0.1};
 assert.equal(G.alertas(cs,totals,{}, {canal:'whatsapp'}).length,0);
 const messages=G.alertas(cs,totals,{}, {canal:'email'}).map(x=>x.m).join(' ');
 assert.match(messages,/campanhas selecionadas/);assert.match(messages,/outra base de cálculo/);
 assert.doesNotMatch(messages,/suspende em 5|alerta em 2|limite da SES é/);
});
test('gerado_em antigo alerta no filtro WhatsApp sem fingir medir o coletor',()=>{
 const msgs=G.alertas([],{}, {gerado_em:'2020-01-01T00:00:00Z'}, {canal:'whatsapp'}).map(x=>x.m).join(' ');
 assert.match(msgs,/consulta gerados/);assert.doesNotMatch(msgs,/snapshot deveria|Última coleta/);
});
