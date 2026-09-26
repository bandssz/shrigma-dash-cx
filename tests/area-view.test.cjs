'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {parseHTML}=require('linkedom');
const V=require('../area-view.js');
const MASTER={schema:'shrigma_access_identity_v1',role:'master',panel:'todos',allowedPanels:['cx','growth','organico','influs']};
const manager=p=>({schema:'shrigma_access_identity_v1',role:'manager',panel:p,allowedPanels:[p]});
const CONTROLS='<div id="area-view-controls" hidden><select id="area-view-select"><option value="manager">Gestor</option><option value="owner">Dono</option></select></div>';
function page(){const {document}=parseHTML(`<html><body data-panel="influs">${CONTROLS}<div data-area-owner-only id="dono">x</div></body></html>`);return document;}
function fakeFetch(identity,calls){return async(url,opts)=>{calls.push({url,auth:opts.headers.Authorization});return {ok:true,status:200,json:async()=>identity};};}

test('identidade: gestor só da própria área; mestre só com as quatro áreas; resto é nulo',()=>{
 assert.equal(V.identityRole(manager('influs'),'influs'),'manager');
 assert.equal(V.identityRole(manager('organico'),'influs'),null,'gestor de outra área não vira gestor daqui');
 assert.equal(V.identityRole(MASTER,'organico'),'master');
 assert.equal(V.identityRole({...MASTER,allowedPanels:['cx','growth','organico']},'influs'),null);
 assert.equal(V.identityRole({...manager('influs'),schema:'x'},'influs'),null);
 assert.equal(V.identityRole(null,'influs'),null);
});

test('gestor da área nunca vê o seletor nem o diagnóstico, mesmo mexendo no select',async()=>{
 const d=page(),calls=[];let k='chave-gestor-influs';
 const v=V.bind({document:d,panel:'influs',key:()=>k,apiUrl:'https://api.exemplo/webhook/x?k=vaza',fetchImpl:fakeFetch(manager('influs'),calls)});
 assert.equal(await v.resolve(),'manager');
 assert.equal(d.getElementById('area-view-controls').hidden,true);
 assert.equal(d.body.dataset.areaView,'manager');
 const u=new URL(calls[0].url);assert.equal(u.searchParams.get('access'),'1');assert.equal(u.searchParams.get('painel'),'influs');
 assert.equal(u.searchParams.get('k'),null,'a chave nunca vai na URL');assert.equal(calls[0].auth,'Bearer chave-gestor-influs');
 const sel=d.getElementById('area-view-select');
 for(const o of sel.querySelectorAll('option'))o.toggleAttribute('selected',o.value==='owner');sel.dispatchEvent(new d.defaultView.Event('change'));
 assert.equal(d.body.dataset.areaView,'manager');
});

test('mestre começa como gestor, alterna para o dono e volta; troca de chave reinicia como gestor',async()=>{
 const d=page(),calls=[],mudancas=[];let k='chave-mestre-felipe';
 const v=V.bind({document:d,panel:'organico',key:()=>k,apiUrl:'https://api.exemplo/webhook/x',fetchImpl:fakeFetch(MASTER,calls),onChange:x=>mudancas.push(x)});
 assert.equal(await v.resolve(),'manager','padrão é a visão do gestor, igual ao CRM');
 assert.equal(d.getElementById('area-view-controls').hidden,false);
 const sel=d.getElementById('area-view-select'),escolhe=val=>{for(const o of sel.querySelectorAll('option'))o.toggleAttribute('selected',o.value===val);sel.dispatchEvent(new d.defaultView.Event('change'));};
 escolhe('owner');assert.equal(d.body.dataset.areaView,'owner');assert.deepEqual(mudancas,['owner']);
 escolhe('manager');assert.equal(d.body.dataset.areaView,'manager');
 await v.resolve();assert.equal(calls.length,1,'identidade lida uma vez por chave');
 escolhe('owner');k='chave-outra-pessoa';await v.resolve();
 assert.equal(d.body.dataset.areaView,'manager','nova chave nunca herda a visão do dono');assert.equal(calls.length,2);
});

test('falha ou demora na identidade mantém a visão do gestor',async()=>{
 const d=page();
 const v=V.bind({document:d,panel:'influs',key:()=>'chave-qualquer-01',apiUrl:'https://api.exemplo/x',fetchImpl:async()=>{throw new Error('rede');}});
 assert.equal(await v.resolve(),'manager');assert.equal(d.getElementById('area-view-controls').hidden,true);
 const semChave=V.bind({document:page(),panel:'influs',key:()=>'',apiUrl:'https://api.exemplo/x',fetchImpl:()=>{throw new Error('não deveria ler');}});
 assert.equal(await semChave.resolve(),'manager');
});

test('CSS real: diagnóstico e alerta técnico somem na visão do gestor e aparecem para o dono',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../area-brand.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
 const {document}=parseHTML(`<html><head><style>${css}</style></head><body data-panel="influs" data-area-view="manager"><div id="d" data-area-owner-only></div><div id="aviso-cred"></div><div id="normal"></div></body></html>`);
 const rules=[...document.querySelector('style').sheet.cssRules].filter(r=>r.selectorText&&r.style?.getPropertyValue('display'));
 const display=el=>rules.filter(r=>{try{return el.matches(r.selectorText);}catch(_){return false;}}).reduce((_v,r)=>r.style.getPropertyValue('display'),'initial');
 assert.equal(display(document.getElementById('d')),'none');assert.equal(display(document.getElementById('aviso-cred')),'none');
 assert.notEqual(display(document.getElementById('normal')),'none');
 document.body.dataset.areaView='owner';
 assert.notEqual(display(document.getElementById('d')),'none');assert.notEqual(display(document.getElementById('aviso-cred')),'none');
});

test('páginas: Influs sem aba de conferência para o gestor; Diagnóstico e seletor marcados para o dono',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../influs.html'),'utf8');
 const {document}=parseHTML(html);
 assert.equal(document.querySelector('#secoes [data-s="conferencia"]'),null,'sem aba de comparação com a Shopify');
 assert.equal(document.querySelector('#faixa-conferencia'),null);
 assert(document.querySelector('#secoes [data-s="diagnostico"]').hasAttribute('data-area-owner-only'));
 assert(document.querySelector('#sec-diagnostico').hasAttribute('data-area-owner-only'));
 assert.equal(document.body.dataset.areaView,'manager');
 const org=parseHTML(fs.readFileSync(path.join(__dirname,'../organico.html'),'utf8')).document;
 assert.equal(org.body.dataset.areaView,'manager');assert(org.getElementById('area-view-controls').hidden);
 assert(org.getElementById('origem-leitura').hasAttribute('data-area-owner-only'));
});
