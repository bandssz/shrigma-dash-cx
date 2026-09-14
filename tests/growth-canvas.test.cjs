const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../growth-canvas.js');
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
