'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const page=fs.readFileSync(require.resolve('../growth.html'),'utf8'),source=fs.readFileSync(require.resolve('../growth-workspace.js'),'utf8');
function setup(){
 const {document,window}=parseHTML(page),navigation=[],changes=[];let focused=null;
 window.HTMLElement.prototype.focus=function(){focused=this;};
 const forbidden=()=>assert.fail('workspace must not access storage or transport');
 const ctx=vm.createContext({document,window,console,fetch:forbidden,localStorage:{getItem:forbidden,setItem:forbidden,removeItem:forbidden},sessionStorage:{getItem:forbidden,setItem:forbidden,removeItem:forbidden}});
 vm.runInContext(source,ctx);const api=vm.runInContext('CRMWorkspace',ctx),options={navigate:value=>navigation.push(value),onChange:kind=>changes.push(kind)};
 api.init(options);
 const q=s=>document.querySelector(s),all=s=>[...document.querySelectorAll(s)],key=(node,name)=>{const e=new window.Event('keydown',{bubbles:true,cancelable:true});e.key=name;node.dispatchEvent(e);return e;};
 return {api,document,window,ctx,options,q,all,key,navigation,changes,focused:()=>focused};
}
function onlyPanel(s,kind,value){
 assert.deepEqual(s.all('[data-crm-'+kind+'-panel]').filter(n=>!n.hidden).map(n=>n.getAttribute('data-crm-'+kind+'-panel')),[value]);
 for(const b of s.all('[data-crm-'+kind+']')){const selected=b.getAttribute('data-crm-'+kind)===value;assert.equal(b.getAttribute('aria-selected'),String(selected));assert.equal(b.getAttribute('tabindex'),selected?'0':'-1');assert.equal(b.classList.contains('ativo'),selected);}
}
test('report and campaign sub-tabs independently expose exactly one panel and preserve edits in the same nodes',()=>{
 const s=setup();s.q('#campaign-composer').innerHTML='<form><input name="subject" value="Alteração não salva"><textarea>Conteúdo ainda em edição</textarea></form>';
 const form=s.q('#campaign-composer form'),input=form.querySelector('input'),textarea=form.querySelector('textarea'),ab=s.q('#form-teste'),hypothesis=s.q('#f-hip'),search=s.q('#camp-busca');assert.ok(ab);hypothesis.value='Hipótese ainda não salva';search.value='Busca preservada';
 onlyPanel(s,'report','overview');onlyPanel(s,'campaign','list');
 for(const value of ['email','conversion','overview']){s.q('[data-crm-report="'+value+'"]').click();onlyPanel(s,'report',value);onlyPanel(s,'campaign','list');}
 for(const value of ['tests','list']){s.q('[data-crm-campaign="'+value+'"]').click();onlyPanel(s,'campaign',value);onlyPanel(s,'report','overview');}
 assert.equal(s.q('#campaign-composer form'),form);assert.equal(form.querySelector('input'),input);assert.equal(form.querySelector('textarea'),textarea);assert.equal(input.value,'Alteração não salva');assert.equal(textarea.value,'Conteúdo ainda em edição');assert.equal(s.q('#form-teste'),ab);assert.equal(s.q('#f-hip'),hypothesis);assert.equal(hypothesis.value,'Hipótese ainda não salva');assert.equal(s.q('#camp-busca'),search);assert.equal(search.value,'Busca preservada');
 assert.equal(s.api.setReport('missing'),false);assert.equal(s.api.setCampaign('missing'),false);onlyPanel(s,'report','overview');onlyPanel(s,'campaign','list');
});
test('arrow, Home and End navigation stays in its tab group and unrelated keys do nothing',()=>{
 const s=setup();
 assert.equal(s.key(s.q('#crm-report-overview-tab'),'ArrowLeft').defaultPrevented,true);onlyPanel(s,'report','conversion');assert.equal(s.focused(),s.q('#crm-report-conversion-tab'));onlyPanel(s,'campaign','list');
 s.key(s.focused(),'Home');onlyPanel(s,'report','overview');s.key(s.focused(),'End');onlyPanel(s,'report','conversion');s.key(s.focused(),'ArrowRight');onlyPanel(s,'report','overview');
 s.key(s.q('#crm-campaign-list-tab'),'ArrowRight');onlyPanel(s,'campaign','tests');onlyPanel(s,'report','overview');assert.equal(s.focused(),s.q('#crm-campaign-tests-tab'));
 const before=s.changes.length;assert.equal(s.key(s.focused(),'ArrowDown').defaultPrevented,false);assert.equal(s.changes.length,before);onlyPanel(s,'campaign','tests');
});
test('brand, section and period summaries preserve independent source clocks and reopen only for a new problem',()=>{
 const s=setup(),sources=s.q('#fontes'),box=s.q('#crm-data-freshness');sources.innerHTML='<span class="crm-source-status" data-estado="ok">Vendas · 26/09, 10:02 BRT</span><span class="crm-source-status" data-estado="velho">E-mail · 25/09, 21:30 BRT · dados antigos</span><span class="crm-source-status" data-estado="desconhecido">WhatsApp · horário não informado</span>';
 const nodes=[...sources.children],before=sources.innerHTML;s.api.sync({section:'resultados',brand:'fish',period:{ini:'2026-09-20',fim:'2026-09-26'}});
 assert.equal(s.document.body.dataset.crmSection,'resultados');assert.equal(s.q('#crm-screen-title').textContent,'Resultados');assert.equal(s.q('#crm-brand-label').textContent,'Fishermans');assert.equal(s.q('#crm-period-label').textContent,'20/09/2026 — 26/09/2026');assert.equal(s.q('#secoes [aria-current="page"]').dataset.s,'resultados');assert.equal(box.open,true);assert.match(s.q('#crm-data-summary').textContent,/2 pontos de atenção/);
 box.open=false;s.api.sync({section:'templates',brand:'fish'});assert.equal(box.open,false);assert.equal(sources.innerHTML,before);assert.deepEqual([...sources.children],nodes);
 s.q('#crm-brand-picker').open=true;s.api.sync({section:'templates',brand:'aristo'});assert.equal(s.q('#crm-brand-label').textContent,'O Aristocrata');assert.equal(s.q('#crm-brand-picker').open,false);assert.equal(sources.innerHTML,before);
 sources.children[0].dataset.estado='falta';sources.children[0].textContent='Vendas · 26/09, 10:02 BRT · atualização indisponível';s.api.sync();assert.equal(box.open,true);assert.match(s.q('#crm-data-summary').textContent,/3 pontos de atenção/);assert.match(sources.textContent,/25\/09, 21:30 BRT · dados antigos/);
});
test('quick actions call the supplied router once after repeated initialization and Escape closes only its picker',()=>{
 const s=setup();s.api.init(s.options);for(const b of s.all('[data-crm-go]'))b.click();assert.deepEqual(s.navigation,['camp','regua','templates','resultados']);
 const brand=s.q('#crm-brand-picker'),period=s.q('#crm-period-picker');brand.open=true;period.open=true;s.key(period.querySelector('input'),'Escape');assert.equal(period.open,false);assert.equal(brand.open,true);assert.equal(s.focused(),period.querySelector('summary'));
 s.key(brand.querySelector('button'),'Escape');assert.equal(brand.open,false);assert.equal(s.focused(),brand.querySelector('summary'));
});
test('six operational sections own their panels; automation UTMs and campaign content remain outside owner-only',()=>{
 const s=setup();assert.deepEqual(s.all('#secoes button').map(b=>[b.dataset.s,b.childNodes[0].textContent]),[['visao','Início'],['camp','Campanhas'],['regua','Automações'],['templates','Templates'],['base','Público'],['resultados','Resultados']]);
 for(const id of ['visao','camp','regua','templates','base','resultados'])assert.equal(s.all('#sec-'+id).length,1);
 for(const id of ['campaign-composer','crm-campaign-tests','control-fluxos','control-history','control-drafts','control-templates','crm-report-overview','crm-report-email','crm-report-conversion'])assert.equal(s.q('#'+id).closest('[data-crm-owner-only]'),null);
 s.ctx.GUT=require('../growth-utm.js');vm.runInContext(fs.readFileSync(require.resolve('../growth-builder.js'),'utf8'),s.ctx);
 const html=vm.runInContext(`(()=>{const step={key:'email-30',channel:'email',template_id:'fixture-template'};const flow={key:'fixture-flow',brand:'fish',available_steps:[{...step,name:'Carrinho'}]};GB.state.templates={'fish:email':[{id:'fixture-template',brand:'fish',channel:'email',name:'Fixture',components:{body_html:'<a href="https://fixture.invalid/?utm_source=email&utm_medium=fluxo&utm_campaign=fixture&utm_content=cart">Abrir</a>'}}]};return GB.trackingHtml(step,flow,true);})()`,s.ctx);
 s.q('#control-fluxos').innerHTML=html;const utm=s.q('#control-fluxos .crm-utm');assert.ok(utm);assert.equal(utm.closest('[data-crm-owner-only]'),null);assert.match(utm.textContent,/UTMs e origem/);assert.match(utm.textContent,/email/);s.api.sync({section:'regua',brand:'fish'});assert.equal(s.q('#control-fluxos .crm-utm'),utm);
});
