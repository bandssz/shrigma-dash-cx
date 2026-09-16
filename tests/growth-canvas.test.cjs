const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../growth-canvas.js');
test('NPS reminder displays the actual timing origin and executable schedule note',()=>{
 const f=require('../n8n/growth/engagement-flow-definitions.json').find(f=>f.key==='aristo:nps-d3');
 f.available_steps=f.steps;const g=C.graph(f,{steps:f.steps});
 const wait=g.nodes.find(n=>n.type==='wait');
 assert.equal(wait.subtitle,'Desde a pesquisa inicial');assert.equal(wait.title,'3 dias');
 assert.equal(g.edges.find(e=>e.to==='step:email:nps-d3').from,wait.id);
 assert.match(f.steps[0].help_text,/19h de Brasília/);
});
const steps=[{key:'wa-a',name:'A',channel:'whatsapp',variant:'a',wait_min:30},{key:'wa-b',name:'B',channel:'whatsapp',variant:'b',wait_min:30},{key:'mail',name:'E-mail',channel:'email',wait_min:30}];
const f={key:'fish:cart',trigger:'Checkout abandonado',available_steps:steps},d={steps};
test('canvas derives actual parallel routes rather than a false A then B sequence',()=>{
 const g=C.graph(f,d);assert.equal(g.nodes.filter(n=>n.type==='wait').length,1);assert.equal(g.nodes.filter(n=>n.type==='branch').length,1);
 assert.ok(!g.edges.some(e=>e.from==='step:wa-a'&&e.to==='step:wa-b'));
 const branch=g.nodes.find(n=>n.type==='branch');assert.equal(g.edges.filter(e=>e.from===branch.id).length,2);
 assert.equal(g.edges.find(e=>e.to==='step:mail').from,g.nodes.find(n=>n.type==='wait').id);
});
test('zoom preserves the world point under the cursor and clamps only scale',()=>{
 const v={x:-400,y:900,z:.7},p=C.worldPoint(v,331,222),next=C.zoomAt(v,1.4,331,222);
 assert.deepEqual(C.worldPoint(next,331,222),p);assert.equal(C.zoomAt(v,50,0,0).z,2);assert.equal(C.zoomAt(v,.001,0,0).z,.15);
});
test('drag layout survives serialization and never changes cadence or routing',()=>{
 const draft=JSON.parse(JSON.stringify(d)),before=JSON.stringify(draft.steps);C.storePosition(draft,{id:'step:wa-a',x:-900,y:1600});
 const loaded=JSON.parse(JSON.stringify(draft)),g=C.graph(f,loaded);assert.equal(g.nodes.find(n=>n.id==='step:wa-a').x,-900);assert.equal(JSON.stringify(loaded.steps),before);
 assert.deepEqual(g.edges,C.graph(f,d).edges);
});
test('node and edge labels escape server supplied text',()=>{
 const html=C.nodeHtml({id:'"><img src=x>',type:'email',title:'<script>bad</script>',subtitle:'<img>',x:0,y:0});assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;script&gt;'));
});
test('unified NPS includes previous surveys, actual response decision and no repeat loop',()=>{
 const flows=require('../n8n/growth/engagement-flow-definitions.json');const steps=flows.filter(f=>f.brand==='fish'&&f.key.includes(':nps-')).flatMap(f=>f.steps);
 const f={journey_kind:'nps',available_steps:steps},g=C.graph(f,{steps});
 assert.ok(g.edges.some(e=>e.from==='prior'&&e.to==='confirmed'));
 assert.ok(g.edges.some(e=>e.from==='confirmed'&&e.to==='unconfirmed'&&e.label==='Não'));
 assert.ok(g.edges.some(e=>e.from==='answered'&&e.to==='responded'&&e.label==='Sim'));
 assert.equal(g.edges.filter(e=>e.to==='step:email:nps-d3').length,1);
 assert.ok(!g.edges.some(e=>e.from==='done'));
 const off=C.graph(f,{steps:[steps[1]]});assert.ok(!off.nodes.some(n=>n.id==='step:email:nps-d0'));assert.ok(off.nodes.some(n=>n.id==='prior'));
});
test('order events are independent and payment channels stay parallel',()=>{
 const steps=[{key:'mail-new',channel:'email',wait_min:0,entry_key:'received',entry_label:'Recebido'},{key:'mail-paid',channel:'email',wait_min:0,entry_key:'paid',entry_label:'Pago'},{key:'wa-paid',channel:'whatsapp',wait_min:0,entry_key:'paid',entry_label:'Pago'}];
 const g=C.graph({journey_kind:'order',available_steps:steps},{steps});
 assert.equal(g.nodes.filter(n=>n.type==='trigger').length,2);
 assert.equal(g.edges.find(e=>e.to==='step:mail-paid').from,'entry:paid');assert.equal(g.edges.find(e=>e.to==='step:wa-paid').from,'entry:paid');
 assert.ok(!g.edges.some(e=>e.from==='entry:received'&&e.to==='entry:paid'));
});
test('cart guards preserve offsets, channel parallelism, A/B and saved geometry',()=>{
 const steps=[{key:'ea',channel:'email',flow:'carrinho',wait_min:30},{key:'wa',channel:'whatsapp',flow:'carrinho',wait_min:30,variant:'a'},{key:'wb',channel:'whatsapp',flow:'carrinho',wait_min:30,variant:'b'},{key:'later',channel:'email',flow:'carrinho',wait_min:60}];
 const f={available_steps:steps},draft={steps,layout:{version:1,nodes:{'step:ea':{x:1500,y:-200}}}},before=structuredClone(draft),g=C.graph(f,draft);
 assert.deepEqual(draft,before);assert.equal(g.nodes.find(n=>n.id==='step:ea').x,1500);
 assert.equal(g.nodes.filter(n=>n.id.startsWith('eligible:')).length,2);assert.ok(g.edges.some(e=>e.from==='trigger'&&e.to==='wait:later'));
 const variant=g.nodes.find(n=>n.title==='Distribuir variante A/B');assert.equal(g.edges.filter(e=>e.from===variant.id).length,2);
 assert.ok(!g.edges.some(e=>e.from==='step:wa'&&e.to==='step:wb'));
 assert.deepEqual(C.graph(f,JSON.parse(JSON.stringify(draft))),g);
});
