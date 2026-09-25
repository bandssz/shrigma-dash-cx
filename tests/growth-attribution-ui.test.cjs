'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const day='2026-09-15';
function fixture(){return {crm_attribution:{schema_version:2,generated_at:day+'T14:00:00Z',coverage:[{brand:'fish',day,checked_at:day+'T13:00:00Z'}],quality:[{marca:'fish',dia:day,pedidos_lidos:4,pagos_elegiveis:3,pagos_com_ultima_sessao:2,pagos_sem_ultima_sessao:1,jornada_pendente:1,jornada_parcial:1}],daily:[],campaigns:[{marca:'fish',emissor:'fish',canal:'email',campanha_id:1,nome:'Campanha sintética',familia:'fixture',segmentos:['Recorrentes'],status:'finished',enviados:3,enviado_em:day+'T12:00:00Z',utms:[]}],dispatch_evidence:{schema_version:1,checked_at:day+'T13:30:00Z',daily:[]}}};}
function boot(api=fixture(),{brand='fish',channel='email'}={}){
 const {document,window}=parseHTML('<html><body><section id="attribution-status"></section><section id="attribution-campaigns"></section></body></html>');
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};Object.defineProperty(document,'activeElement',{get:()=>focused||document.body});
 const downloads=[],context=vm.createContext({document,window,Date,Intl,__downloads:downloads});
 for(const file of ['growth-table.js','growth-ui.js','growth-utm.js','growth-attribution.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context,{filename:file});
 context.input=api;vm.runInContext(`GT.baixar=(name,text)=>__downloads.push({name,text});globalThis.render=()=>GA.render({api:input,marca:${JSON.stringify(brand)},ini:'2026-09-14',fim:'${day}',canal:${JSON.stringify(channel)},GUI,onModel:()=>{}});`,context);context.render();
 return {document,window,api,downloads,render:context.render,q:s=>document.querySelector(s)};
}
test('empty campaign search has a safe clear action that restores results and focus without changing the recorte',()=>{
 const x=boot(),before=JSON.stringify(x.api),summary=x.q('.ga-summary').textContent,input=x.q('#attribution-search');
 assert.equal(x.document.querySelectorAll('.ga-campaign').length,1);
 input.value='<img src=x onerror=fixture>';input.dispatchEvent(new x.window.Event('input'));
 assert.equal(x.document.querySelectorAll('.ga-campaign').length,0);assert.match(x.q('#attribution-list').textContent,/Nenhuma campanha ou segmento contém/);
 assert.equal(!!x.q('#attribution-list img'),false);assert.equal(x.q('#attribution-count').textContent,'0 iniciativas');
 x.q('#attribution-clear').click();assert.equal(input.value,'');assert.equal(x.document.activeElement.id,'attribution-search');
 assert.equal(x.document.querySelectorAll('.ga-campaign').length,1);assert.equal(x.q('.ga-summary').textContent,summary);assert.equal(JSON.stringify(x.api),before);
 x.render();assert.equal(x.q('#attribution-search').value,'');assert.equal(x.document.querySelectorAll('.ga-campaign').length,1);
});
test('a genuinely empty recorte explains which filters to check without claiming a search result or an action to open',()=>{
 const api=fixture();api.crm_attribution.campaigns=[];const x=boot(api);
 assert.match(x.q('#attribution-list').textContent,/Confira a marca, o canal e o período/);assert.equal(!!x.q('#attribution-clear'),false);
 assert.equal(x.q('#attribution-count').textContent,'0 iniciativas');
});
test('compact attribution keeps partial coverage and all source clocks visible, with methodology in a persistent detail',()=>{
 const x=boot(),bar=x.q('#attribution-status'),detail=bar.querySelector('details'),visible=bar.cloneNode(true);
 visible.querySelectorAll('details').forEach(el=>el.replaceWith(el.querySelector('summary').cloneNode(true)));
 assert.match(visible.textContent,/Cobertura parcial/);assert.match(visible.textContent,/Total parcial: dias sem conciliação/);
 assert.match(visible.textContent,/1 pedido\(s\) com jornada pendente/);assert.match(visible.textContent,/assistências podem estar incompletas/);
 for(const clock of ['15/09/2026, 10:00','15/09/2026, 11:00','15/09/2026, 10:30'])assert.ok(visible.textContent.includes(clock));
 assert.match(visible.textContent,/Horários de Brasília/);assert.match(visible.textContent,/Rastreamento · 1 pedido\(s\) sem última sessão/);
 assert.doesNotMatch(visible.textContent,/PIX copiado/);assert.match(detail.textContent,/não comprova clique nem venda adicional/);assert.match(detail.textContent,/Cobertura de leitura não garante rastreamento completo/);
 detail.open=true;x.render();assert.equal(x.q('#attribution-status details').open,true);
 x.api.crm_attribution.quality=[];x.render();assert.match(x.q('#attribution-status summary').textContent,/última sessão não informada/);
});
test('attribution exports distinguish brands and channel while preserving the filtered CSV content',()=>{
 const api=fixture();api.crm_attribution.coverage.push({brand:'aristo',day,checked_at:day+'T13:00:00Z'});api.crm_attribution.campaigns.push({...api.crm_attribution.campaigns[0],marca:'aristo',emissor:'aristo',campanha_id:2,familia:'aristo-fixture',nome:'Campanha Aristo exclusiva'});
 const fish=boot(api),aristo=boot(api,{brand:'aristo'}),before=JSON.stringify(api);
 fish.q('#attribution-export').click();aristo.q('#attribution-export').click();
 assert.equal(fish.downloads[0].name,'growth-campanhas-fishermans-e-mail-2026-09-14_2026-09-15.csv');assert.equal(aristo.downloads[0].name,'growth-campanhas-o-aristocrata-e-mail-2026-09-14_2026-09-15.csv');
 assert.match(fish.downloads[0].text,/fixture;fish;/);assert.doesNotMatch(fish.downloads[0].text,/aristo fixture;aristo/);assert.match(aristo.downloads[0].text,/aristo fixture;aristo;/);assert.doesNotMatch(aristo.downloads[0].text,/fixture;fish/);
 assert.equal(JSON.stringify(api),before);assert.equal(fish.downloads[0].text.split('\r\n')[0],aristo.downloads[0].text.split('\r\n')[0]);
 const wa=boot(api,{channel:'whatsapp'});wa.q('#attribution-export').click();assert.match(wa.downloads[0].name,/-fishermans-whatsapp-/);
});

test('campaign history displays all recorded UTM tuples in the selected brand without inferring source or altering results',()=>{
 const api=fixture(),fish=api.crm_attribution.campaigns[0];
 fish.utms=[{source:'fish-source-a',medium:'campanha',campaign:'fish-recorded',content:'hero',term:'dispatch-a'},{source:'fish-source-b',medium:'email',campaign:'fish-recorded',content:'footer',term:'dispatch-b'}];
 api.crm_attribution.coverage.push({brand:'aristo',day,checked_at:day+'T13:00:00Z'});
 api.crm_attribution.campaigns.push({...fish,marca:'aristo',emissor:'aristo',campanha_id:2,familia:'aristo-fixture',nome:'Aristo fixture',utms:[{source:'aristo-recorded',medium:'campanha',campaign:'aristo-only',content:'<script>unsafe</script>',term:''}]});
 const before=JSON.stringify(api.crm_attribution),x=boot(api),y=boot(api,{brand:'aristo'}),fx=x.q('.ga-campaign .crm-utm'),ar=y.q('.ga-campaign .crm-utm');
 assert.ok(fx);assert.match(fx.textContent,/UTMs registradas/);for(const value of ['fish-source-a','fish-source-b','fish-recorded','hero','footer','dispatch-a','dispatch-b'])assert.ok(fx.textContent.includes(value),value);
 assert.doesNotMatch(fx.textContent,/aristo-recorded/);assert.match(ar.textContent,/aristo-recorded/);assert.doesNotMatch(ar.textContent,/fish-source/);assert.ok(ar.textContent.includes('<script>unsafe</script>'));assert.equal(ar.querySelector('script'),null);
 assert.match(fx.textContent,/Links e histórico de cliques/);assert.match(fx.textContent,/15\/09\/2026, 11:00/);assert.equal(JSON.stringify(api.crm_attribution),before);
});
test('missing campaign history UTMs remain explicitly unavailable instead of assuming the campaign source policy',()=>{
 for(const utms of [null,[]]){const api=fixture();api.crm_attribution.campaigns[0].utms=utms;const x=boot(api),el=x.q('.ga-campaign .crm-utm');assert.ok(el);assert.match(el.textContent,/UTMs não disponíveis nesta consulta/);assert.doesNotMatch(el.textContent,/listmonk|utm_source=listmonk/);}
});

test('campaign tracking presentation leaves other brands outside this Growth change',()=>{
 const api=fixture();api.crm_attribution.coverage[0].brand='olivas';Object.assign(api.crm_attribution.campaigns[0],{marca:'olivas',emissor:'olivas',utms:[{source:'other',campaign:'existing'}]});const x=boot(api,{brand:'olivas'});assert.ok(x.q('.ga-campaign'));assert.equal(x.q('.ga-campaign .crm-utm'),null);
});
