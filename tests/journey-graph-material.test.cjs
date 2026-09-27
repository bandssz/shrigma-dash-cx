'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const G=require('../n8n/growth/journey-graph-contract.js'),R=require('../n8n/growth/journey-graph-release.cjs');
const {createGraphRuntime}=require('../n8n/growth/journey-graph-runtime.cjs');
const {id}=require('./journey-graph-source-fixture.cjs'),{fixture,planning}=require('./journey-graph-material-fixture.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
const count=async(x,table)=>(await x.query('SELECT count(*)::int n FROM crm_graph_candidate.'+table)).rows[0].n;

test('release descriptor separates structured material from conditional fields and exposes no content or values',async t=>{
 const x=await fixture(t),f=await x.prepare();assert.equal(G.validateGraph(f.graph,{catalog:f.catalog}).ok,true);assert.equal(f.catalog.fields.some(v=>v.key==='cart.items'),false);assert.equal(f.catalog.messages[0].material.fields.find(v=>v.key==='cart.items').type,'cart_items');assert.deepEqual(f.catalog.messages[0].required_fields,['contact.email_allowed','purchase.confirmed']);
 const serialized=JSON.stringify(f.catalog);for(const privateValue of [f.release.material.native.body,f.release.material.native.subject,f.release.material.envelope.from_email])assert.equal(serialized.includes(privateValue),false);
 assert.throws(()=>R.bindCatalog(planning({...f.s,brand:'aristo'}),[f.release]),/CATALOG_CHANGED/);assert.throws(()=>R.bindCatalog({...planning(f.s),messages:[]},[f.release]),/CATALOG_CHANGED/);
 const stale=planning(f.s);stale.messages[0].release='snapshot_'+'0'.repeat(48);assert.throws(()=>R.bindCatalog(stale,[f.release]),/CATALOG_CHANGED/);
 const forged=copy(f.catalog);forged.messages[0].material.fields.find(v=>v.key==='cart.items').type='string_set';assert.equal(G.validateGraph(f.graph,{catalog:forged}).ok,false);
 const erased=copy(f.catalog);erased.messages[0].required_fields=[];assert.equal(G.validateGraph(f.graph,{catalog:erased}).ok,false);
});

test('pure simulation gates real item arrays, required keys, timestamps and consent/purchase independently of graph branches',async t=>{
 const x=await fixture(t),f=await x.prepare(),p=await x.read(f.source_ref,'fish',x.sourceAdapter),now=p.observed_at;
 const simulate=facts=>G.simulate(f.graph,{catalog:f.catalog,now,facts});assert.equal(simulate(p.facts).reason,'exit');assert.equal(simulate(p.facts).sends,0);
 for(const mutate of [v=>delete v['cart.items'],v=>v['cart.items'].value=['not an item'],v=>delete v['cart.items'].value[0].image,v=>v['cart.items'].value[0].quantity='2',v=>v['cart.items'].observed_at=new Date(Date.parse(now)-300001).toISOString(),v=>v['cart.checkout_url'].observed_at=new Date(Date.parse(now)+1).toISOString(),v=>delete v['purchase.confirmed'],v=>v['purchase.confirmed'].complete=false,v=>v['purchase.confirmed'].value=true,v=>v['contact.email_allowed'].value=false]){const facts=copy(p.facts);mutate(facts);const s=simulate(facts);assert.equal(s.reason,'blocked');assert.equal(s.trace.some(r=>r.kind==='message_intent'),false);}
 const conditional=copy(f.graph);conditional.nodes.splice(1,0,{id:'condition',type:'condition',expression:{field:'cart.items',op:'contains',value:'x'},on_unknown:{max_wait_seconds:60,retry_seconds:10}});assert.equal(G.validateGraph(conditional,{catalog:f.catalog}).ok,false,'material objects never become condition string sets');
});

test('both brands run trusted source→immutable release→graph→dry intent with no native changes or dispatch',async t=>{
 const x=await fixture(t),before=(await x.query('SELECT * FROM templates ORDER BY id')).rows;assert.equal((await x.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
 for(const brand of ['fish','aristo']){const f=await x.prepare(brand),e=await f.atMessage(),request=f.request({entry_id:e.entry_id,expected_version:e.version}),r=await f.api.step(request);assert.equal(r.kind,'message_intent');assert.equal(r.authorizes_send,false);assert.deepEqual(await f.api.step(request),r);
  const row=(await x.query('SELECT * FROM crm_graph_candidate.intent WHERE entry_id=$1',[e.entry_id])).rows[0];assert.equal(row.release,'release_'+f.release.id);assert.equal(row.brand,brand);assert.equal(row.authorizes_send,false);
  const stored=JSON.stringify((await x.query('SELECT response FROM crm_graph_candidate.operation')).rows)+JSON.stringify(row);assert.equal(stored.includes(id(1)),false);assert.equal(stored.includes('Synthetic'),false);assert.equal(stored.includes('/cart/synthetic'),false);
 }
 assert.equal(await count(x,'intent'),2);assert.equal((await x.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);assert.deepEqual((await x.query('SELECT * FROM templates ORDER BY id')).rows,before);
});

test('missing purchase coverage cannot create intent even when the graph has no purchase condition',async t=>{
 const x=await fixture(t),f=await x.prepare(),e=await f.atMessage(),api=createGraphRuntime({...f.settings,readSource:x.api.readSource});const r=await api.step(f.request({entry_id:e.entry_id,expected_version:e.version}));assert.equal(r.kind,'blocked');assert.equal(r.reason,'message_data_unavailable');assert.equal(await count(x,'intent'),0);
});

test('publication validates the pinned store descriptor; existing entry keeps immutable material after native change',async t=>{
 const x=await fixture(t),f=await x.prepare();f.catalog.messages[0].material.material_sha256='0'.repeat(64);const j=await f.api.create(f.request({definition:f.graph}));await assert.rejects(f.api.publish(f.request({journey_id:j.journey_id,expected_version:j.version,confirm:'publicar'})),/GRAPH_RELEASE_BINDING_CHANGED/);
 f.catalog.messages[0].material.material_sha256=f.release.material_sha256;const e=await f.atMessage();await x.query('UPDATE templates SET subject=$1 WHERE id=60',['Changed synthetic subject']);f.catalog.messages[0].release='release_'+id(999);const r=await f.api.step(f.request({entry_id:e.entry_id,expected_version:e.version}));assert.equal(r.kind,'message_intent');assert.equal((await x.provider.read('fish',f.release.id)).material.native.subject,'Seu carrinho');
});

test('materialization failure rolls back state and receipt before any intent; current optout also stops safely',async t=>{
 const x=await fixture(t),f=await x.prepare(),e=await f.atMessage(),request=f.request({entry_id:e.entry_id,expected_version:e.version});
 const bad=createGraphRuntime({...f.settings,readSource:async args=>{const p=await x.sourceAdapter.readSource(args);p.facts['cart.checkout_url'].value='https://oaristocrata.com/cart/synthetic';return p;}});
 await assert.rejects(bad.step(request),/GRAPH_RELEASE_CHECKOUT_INVALID/);assert.equal(await count(x,'intent'),0);assert.equal((await x.query('SELECT version FROM crm_graph_candidate.entry WHERE id=$1',[e.entry_id])).rows[0].version,e.version);assert.equal((await x.query('SELECT count(*)::int n FROM crm_graph_candidate.operation WHERE request_id=$1',[request.request_id])).rows[0].n,0);
 await x.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=17");const stopped=await f.api.step(request);assert.equal(stopped.kind,'stopped');assert.equal(stopped.reason,'consent_withdrawn');assert.equal(await count(x,'intent'),0);
});


test('observed release runs for both brands, blocks independent of conditions, and pins policy to existing entries',async t=>{
 const x=await fixture(t);
 for(const brand of ['fish','aristo']){
  const f=await x.prepare(brand,true),e=await f.atMessage(),p=await f.settings.readSource({query:x.query,source_ref:f.source_ref,brand,trigger:'cart.abandoned',now:new Date().toISOString()});
  assert.equal(f.release.material.version,R.OBSERVED_VERSION);assert.equal(G.validateGraph(f.graph,{catalog:f.catalog}).ok,true);
  const simulate=facts=>G.simulate(f.graph,{catalog:f.catalog,now:p.observed_at,facts});assert.equal(simulate(p.facts).reason,'exit');
  for(const mutate of [v=>delete v['purchase.observed_for_cart'],v=>v['purchase.observed_for_cart'].value=true,v=>v['purchase.observed_for_cart'].complete=false,v=>v['purchase.observed_for_cart'].observed_at=new Date(Date.parse(p.observed_at)-5001).toISOString(),v=>v['purchase.confirmed']={value:true,complete:true,observed_at:p.observed_at},v=>v['contact.email_allowed'].value=false]){const facts=copy(p.facts);mutate(facts);assert.equal(simulate(facts).reason,'blocked');assert.throws(()=>R.materialize(f.release.material,{...p,facts},{now:p.observed_at}),/UNCONFIRMED/);}
  for(const mutate of [v=>delete v.messages[0].material.purchase_policy,v=>v.messages[0].material.purchase_policy.max_age_seconds=300,v=>v.messages[0].required_fields=['contact.email_allowed'],v=>v.fields.find(f=>f.key==='purchase.observed_for_cart').max_age_seconds=300]){const cat=copy(f.catalog);mutate(cat);assert.equal(G.validateGraph(f.graph,{catalog:cat}).ok,false);}
  // Changing the current catalog to another policy cannot reinterpret an enrolled revision.
  const legacy=await x.prepare(brand);f.catalog.messages[0]=legacy.catalog.messages[0];
  const r=await f.api.step(f.request({entry_id:e.entry_id,expected_version:e.version}));assert.equal(r.kind,'message_intent');assert.equal(r.authorizes_send,false);
  assert.equal((await x.query('SELECT release FROM crm_graph_candidate.intent WHERE entry_id=$1',[e.entry_id])).rows[0].release,'release_'+f.release.id);
  const onlyObserved=copy(p.facts);delete onlyObserved['purchase.confirmed'];assert.equal(G.simulate(legacy.graph,{catalog:legacy.catalog,now:p.observed_at,facts:onlyObserved}).reason,'blocked');
 }
 assert.equal((await x.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
});
