'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{parseHTML}=require('linkedom');
const G=require('../n8n/growth/journey-graph-contract.js'),Editor=require('../growth-journey-graph-editor.js');
const {fixture:runtimeFixture,T,id}=require('./fixtures/journey-graph-runtime.cjs');
const fixture=(_,brand)=>runtimeFixture({async connect(){throw Error('UI must never access storage');}},brand);
function boot(extra={},brand='fish'){
 const f=fixture({},brand),{document,window}=parseHTML('<html><body><main id="editor"></main></body></html>'),root=document.querySelector('#editor');
 const options={root,brand,catalog:f.catalog,simulationNow:T,...extra};const editor=Editor.mount(options);
 const el=s=>{const e=root.querySelector(s);assert.ok(e,'missing '+s);return e;};
 function change(s,value,event='change'){const e=el(s);if(e.type==='checkbox')e.checked=!!value;else if(e.tagName==='SELECT'){for(const o of e.querySelectorAll('option'))o.removeAttribute('selected');const target=[...e.options].find(o=>o.value===String(value));assert.ok(target,'missing option '+value);target.setAttribute('selected','');}else e.value=String(value);e.dispatchEvent(new window.Event(event,{bubbles:true}));return e;}
 function click(s){el(s).dispatchEvent(new window.Event('click',{bubbles:true}));}
 return {f,root,document,window,editor,el,change,click};
}
const add=(x,type)=>x.click('[data-action="add"][data-type="'+type+'"]');
const connect=(x,from,port,to)=>x.change('[data-node="'+from+'"][data-connection="'+port+'"]',to);
function built(brand='fish'){
 const x=boot({},brand);add(x,'wait');add(x,'condition');add(x,'message');add(x,'exit');
 connect(x,'entry','next','step1');connect(x,'step1','next','step2');connect(x,'step2','yes','step4');connect(x,'step2','no','step3');connect(x,'step3','next','end');
 x.change('[data-node="step4"][data-field="reason"]','purchased');x.change('[data-node="step2"][data-expr="value"][data-path="0"]','true');
 return x;
}
test('both brands construct a complete cart graph through visible controls, not JSON; publication stays OFF',()=>{
 for(const brand of ['fish','aristo']){const x=built(brand);assert.equal(x.editor.validate().ok,true);const graph=x.editor.getDefinition();assert.deepEqual(Object.keys(graph).sort(),['brand','edges','name','nodes','version']);assert.equal(graph.brand,brand);assert.equal(graph.nodes.length,6);assert.equal(graph.edges.find(e=>e.from==='step2'&&e.port==='yes').to,'step4');
  assert.equal(Editor.ENABLED,false);assert.equal(x.editor.enabled,false);assert.equal(x.editor.contextStatus().dirty,true);assert.equal(x.editor.contextStatus().publicationAvailable,false);assert.equal(x.root.querySelector('textarea'),null);
  x.click('[data-action="review"]');const review=x.editor.prepareReview();assert.equal(review.ok,true);assert.equal(review.authorizes_publish,false);assert.equal(review.authorizes_send,false);assert.equal(review.server,null);assert.match(x.root.textContent,/Nada publicado/);assert.match(x.root.textContent,/Descadastro e bloqueios não podem ser desativados/);
  const publish=[...x.root.querySelectorAll('button')].find(b=>b.textContent==='Publicar indisponível');assert.equal(publish.disabled,true);assert.equal(x.root.querySelector('[data-optout]'),null);
 }
});
test('incomplete connections, equal branches, cycles and orphans cannot prepare a publication review',()=>{
 const x=built();connect(x,'step2','no','');assert.equal(x.editor.prepareReview().ok,false);assert.equal(x.el('[data-action="review"]').disabled,true);assert.match(x.root.textContent,/Resolva todos os caminhos/);
 connect(x,'step2','no','step4');assert.equal(x.editor.validate().errors[0].code,'GRAPH_BRANCH');connect(x,'step2','no','step3');connect(x,'step3','next','step1');assert.equal(x.editor.validate().errors[0].code,'GRAPH_CYCLE');
 connect(x,'step3','next','end');add(x,'exit');assert.equal(x.editor.validate().errors[0].code,'GRAPH_ORPHAN');
});
test('groups AND/OR and typed operands are editable; arbitrary comparisons are never offered',()=>{
 const x=built(),base='[data-node="step2"]';x.click(base+'[data-action="expr-add"][data-path=""]');
 x.change(base+'[data-expr="field"][data-path="1"]','first_name');const ops=x.el(base+'[data-expr="op"][data-path="1"]');assert.deepEqual([...ops.options].map(o=>o.value),['eq','ne']);
 x.change(base+'[data-expr="value"][data-path="1"]','Pessoa fictícia','input');x.click(base+'[data-action="expr-group"][data-path=""]');
 x.change(base+'[data-expr="group"][data-path=""]','any');const expr=x.editor.getDefinition().nodes.find(n=>n.id==='step2').expression;
 assert.equal(expr.any.length,3);assert.equal(expr.any[1].value,'Pessoa fictícia');assert.ok(expr.any[2].any);assert.equal(x.editor.validate().ok,true);
 x.click(base+'[data-action="expr-remove"][data-path="2.0"]');assert.match(x.root.textContent,/Mantenha ao menos uma condição/);assert.equal(x.editor.getDefinition().nodes.find(n=>n.id==='step2').expression.any[2].any.length,1);
 x.click(base+'[data-action="expr-remove"][data-path="2"]');assert.equal(x.editor.getDefinition().nodes.find(n=>n.id==='step2').expression.any.length,2);
});
test('editing number and UTC timestamp conditions preserves types and rejects empty values',()=>{
 const f=fixture({});for(const field of [{key:'order.total',type:'number',available:true,max_age_seconds:3600},{key:'last.purchase',type:'timestamp',available:true,max_age_seconds:3600}]){f.catalog.fields.push(field);f.catalog.triggers[0].fields.push(field.key);}
 const x=boot({catalog:f.catalog,definition:f.graph}),base='[data-node="condition"]';
 x.change(base+'[data-expr="field"]','order.total');x.change(base+'[data-expr="op"]','gte');x.change(base+'[data-expr="value"]','120.50','input');assert.deepEqual(x.editor.getDefinition().nodes[2].expression,{field:'order.total',op:'gte',value:120.5});
 x.change(base+'[data-expr="value"]','','input');assert.equal(x.editor.validate().ok,false);assert.equal(x.editor.getDefinition().nodes[2].expression.value,null);
 x.change(base+'[data-expr="field"]','last.purchase');x.change(base+'[data-expr="value"]','2026-09-24T13:10:00','input');assert.equal(x.editor.getDefinition().nodes[2].expression.value,'2026-09-24T13:10:00.000Z');assert.equal(x.editor.validate().ok,true);
});
test('wait edits use explicit units and keep the focused input; local edits invalidate an earlier review',()=>{
 const x=built();x.click('[data-action="review"]');assert.ok(x.root.querySelector('.jge-review'));
 x.change('[data-node="step1"][data-field="wait-unit"]','1');const input=x.change('[data-node="step1"][data-field="wait-amount"]','90','input');
 assert.equal(x.editor.getDefinition().nodes.find(n=>n.id==='step1').seconds,90);assert.equal(x.el('[data-node="step1"][data-field="wait-amount"]'),input);assert.equal(x.root.querySelector('.jge-review'),null);
 x.change('[data-node="step1"][data-field="wait-amount"]','0','input');assert.equal(x.editor.validate().ok,false);
 const name=x.change('[data-name]','Rascunho ainda local','input');assert.equal(x.el('[data-name]'),name);assert.equal(x.editor.getDefinition().name,'Rascunho ainda local');
});
test('unknown, Yes and No simulations use the exact contract, with hypothetical acceptance and zero sends',()=>{
 for(const brand of ['fish','aristo']){const x=built(brand);x.click('[data-action="simulate"]');let result=x.editor.getSimulation();assert.equal(result.reason,'wait_data');assert.match(x.root.textContent,/caminho Não não escolhido/);assert.equal(result.trace.some(t=>t.kind==='message_intent'),false);
  x.change('[data-scenario-known="purchase.confirmed"]',true);x.change('[data-scenario-value="purchase.confirmed"]','false');x.change('[data-scenario-known="first_name"]',true);x.change('[data-scenario-value="first_name"]','Pessoa fictícia','input');x.click('[data-action="simulate"]');result=x.editor.getSimulation();
  const facts={'purchase.confirmed':{value:false,observed_at:T,complete:true},first_name:{value:'Pessoa fictícia',observed_at:T,complete:true}};
  assert.deepEqual(result,G.simulate(x.editor.getDefinition(),{catalog:x.f.catalog,now:T,facts}));assert.equal(result.sends,0);assert.equal(result.persistence_writes,0);assert.equal(result.trace.filter(t=>t.kind==='message_intent').length,1);assert.match(x.root.textContent,/aceite apenas hipotético/);
  x.change('[data-scenario-value="purchase.confirmed"]','true');assert.equal(x.editor.getSimulation(),null);x.click('[data-action="simulate"]');assert.equal(x.editor.getSimulation().trace.some(t=>t.kind==='message_intent'),false);assert.equal(x.editor.getSimulation().state.node_id,'step4');
 }
});
test('server identity and versions stay separate and immutable; unavailable or cross-brand catalog blocks editing',()=>{
 const f=fixture({}),server={journey_id:id(500),brand:'fish',version:7,revision:3,published_revision:2,paused:true},before=JSON.stringify({server,catalog:f.catalog,definition:f.graph});
 const x=boot({server,catalog:f.catalog,definition:f.graph});x.change('[data-name]','Nova revisão local','input');const p=x.editor.prepareReview();assert.deepEqual(p.server,server);assert.equal(p.definition.journey_id,undefined);assert.equal(p.definition.revision,undefined);assert.equal(p.definition.enabled,undefined);
 p.server.version=99;p.definition.name='Mutated copy';assert.equal(x.editor.getServerIdentity().version,7);assert.equal(x.editor.getDefinition().name,'Nova revisão local');assert.equal(JSON.stringify({server,catalog:f.catalog,definition:f.graph}),before);
 for(const catalog of [null,fixture({},'aristo').catalog]){const missing=boot({catalog});assert.equal(missing.editor.prepareReview().ok,false);assert.match(missing.root.textContent,/Catálogo indisponível/);assert.equal(missing.el('[data-action="add"][data-type="wait"]').disabled,true);assert.equal(missing.el('[data-name]').disabled,true);}
 assert.throws(()=>boot({server:{...server,brand:'aristo'}}),/GRAPH_EDITOR_SERVER/);assert.throws(()=>boot({definition:fixture({},'aristo').graph}),/GRAPH_EDITOR_DOCUMENT/);
});
test('removal needs explicit HTML confirmation, preserves cancel and never silently reconnects branches',()=>{
 const x=built(),before=x.editor.getDefinition();x.click('[data-action="remove"][data-node="step3"]');assert.ok(x.root.querySelector('[role="alertdialog"]'));assert.ok(x.root.querySelector('[inert]'));assert.equal(x.editor.contextStatus().pendingConfirmation,true);
 x.change('[data-name]','Must not change','input');assert.deepEqual(x.editor.getDefinition(),before);x.click('[data-action="cancel-remove"]');assert.deepEqual(x.editor.getDefinition(),before);
 x.click('[data-action="remove"][data-node="step3"]');x.click('[data-action="confirm-remove"]');assert.equal(x.editor.getDefinition().nodes.some(n=>n.id==='step3'),false);assert.equal(x.editor.getDefinition().edges.some(e=>e.from==='step3'||e.to==='step3'),false);assert.equal(x.editor.validate().ok,false);assert.equal(x.editor.getDefinition().edges.find(e=>e.from==='step2'&&e.port==='yes').to,'step4');
});
test('read-only mode cannot mutate but can simulate; labels are escaped and candidate remains unmounted',()=>{
 const f=fixture({}),x=boot({definition:f.graph,readOnly:true,labels:{'cart.email':'<img src=x onerror=alert(1)>'}}),before=x.editor.getDefinition();
 assert.equal(x.root.querySelector('img'),null);assert.match(x.root.textContent,/<img src=x/);assert.equal(x.el('[data-name]').disabled,true);x.change('[data-name]','Cannot change','input');add(x,'exit');assert.deepEqual(x.editor.getDefinition(),before);x.click('[data-action="simulate"]');assert.equal(x.editor.getSimulation().sends,0);
 const manifest=fs.readFileSync(require.resolve('../tools/panel-build/manifest.json'),'utf8');assert.doesNotMatch(manifest,/growth-journey-graph-editor/);
 x.editor.destroy();assert.equal(x.root.innerHTML,'');assert.equal(x.root.classList.contains('jge-editor'),false);
});
test('bounded node count and expression depth/leaf count cannot grow through repeated controls',()=>{
 const x=built();for(let i=0;i<40;i++)add(x,'exit');assert.equal(x.editor.getDefinition().nodes.length,32);assert.equal(x.el('[data-action="add"][data-type="exit"]').disabled,true);
 const y=built();for(let i=0;i<25;i++)y.click('[data-node="step2"][data-action="expr-add"][data-path=""]');assert.equal(y.editor.getDefinition().nodes.find(n=>n.id==='step2').expression.all.length,16);assert.match(y.root.textContent,/até 16 condições/);
});
test('unavailable or non-email releases are not selectable; malformed server structure fails before rendering',()=>{
 const f=fixture({});f.catalog.messages.push({key:'cart.wa',brand:'fish',channel:'whatsapp',available:true,release:'synthetic-wa',required_fields:[]},{key:'cart.retired',brand:'fish',channel:'email',available:false,release:'retired',required_fields:[]});
 const x=boot({catalog:f.catalog,definition:f.graph});assert.deepEqual([...x.el('[data-field="binding"]').options].map(o=>o.value),['','cart.email']);
 const wa=JSON.parse(JSON.stringify(f.graph));wa.nodes.find(n=>n.type==='message').binding='cart.wa';const blocked=boot({catalog:f.catalog,definition:wa});assert.equal(blocked.editor.prepareReview().ok,false);assert.match(blocked.root.textContent,/modelo de e-mail disponível/);
 const broken=JSON.parse(JSON.stringify(f.graph));delete broken.nodes[2].expression;assert.throws(()=>boot({definition:broken}),/GRAPH_EDITOR_DOCUMENT/);
 const missing=boot({catalog:null,definition:broken});assert.equal(missing.editor.prepareReview().ok,false);assert.match(missing.root.textContent,/Catálogo indisponível/);
});
test('candidate stylesheet parses, remains scoped and includes compact-screen layout without hiding workflow content',()=>{
 const css=fs.readFileSync(require.resolve('../growth-journey-graph-editor.css'),'utf8'),{document}=parseHTML('<style>'+css+'</style>'),rules=document.querySelector('style').sheet.cssRules;
 function scoped(list){for(const rule of list){if(rule.cssRules)scoped(rule.cssRules);else {let depth=0,parts=[''];for(const c of rule.selectorText){if(c==='(')depth++;if(c===')')depth--;if(c===','&&depth===0)parts.push('');else parts[parts.length-1]+=c;}assert.ok(parts.every(s=>s.trim().startsWith('.jge-')),'global selector: '+rule.selectorText);}}}
 scoped(rules);assert.ok(rules.length>20);assert.match(css,/@media\(max-width:760px\)/);assert.doesNotMatch(css,/display\s*:\s*none|visibility\s*:\s*hidden/);
});
