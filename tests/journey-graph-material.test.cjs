'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const G=require('../n8n/growth/journey-graph-contract.js'),R=require('../n8n/growth/journey-graph-release.cjs');
const {createGraphRuntime}=require('../n8n/growth/journey-graph-runtime.cjs'),{createSourceAdapter}=require('../n8n/growth/journey-graph-source.cjs');
const {setup,id}=require('./journey-graph-source-fixture.cjs'),{body,graph:legacyGraph}=require('./journey-graph-release-fixture.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
function definition(brand,binding){return {version:G.VERSION,brand,name:'Carrinho sintético',nodes:[{id:'start',type:'trigger',event:'cart.abandoned'},{id:'message',type:'message',binding},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'start',to:'message',port:'next'},{from:'message',to:'end',port:'next'}]};}
function planning(source){return {version:G.VERSION,brand:source.brand,triggers:[{key:'cart.abandoned',brand:source.brand,available:true,fields:['purchase.confirmed','contact.email_allowed']}],fields:['purchase.confirmed','contact.email_allowed'].map(key=>({key,type:'boolean',available:true,max_age_seconds:300})),messages:[{key:source.binding,brand:source.brand,channel:'email',available:true,release:source.source_snapshot,required_fields:[]}]};}
async function fixture(t){
 const x=await setup();t.after(()=>x.db.close());await x.db.exec('CREATE TABLE templates(id integer PRIMARY KEY,name text,type text,subject text,body text,body_source text);CREATE TABLE shrigma_template_email_registry(template_id integer,brand text);CREATE TABLE shrigma_flow_definition(key text PRIMARY KEY,brand text,runtime_ready boolean,published_version integer,published jsonb);');
 for(const brand of ['fish','aristo']){const tid=brand==='fish'?60:95;await x.query('INSERT INTO templates VALUES($1,$2,$3,$4,$5,NULL)',[tid,'Synthetic '+brand,'tx','Seu carrinho',body(brand)]);await x.query('INSERT INTO shrigma_template_email_registry VALUES($1,$2)',[tid,brand]);await x.query('INSERT INTO shrigma_flow_definition VALUES($1,$2,true,6,$3)',[brand+':carrinho',brand,legacyGraph(brand)]);
  await x.query('UPDATE subscribers SET attribs=jsonb_set(attribs,ARRAY[$1],$2::jsonb) WHERE id=1',[brand,JSON.stringify({...x.a,cart_id:'synthetic-'+brand,cart_url:'https://'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com')+'/cart/synthetic'})]);
 }
 await x.db.exec(fs.readFileSync(require.resolve('../n8n/growth/journey-graph-release.sql'),'utf8'));
 const provider=R.createReleaseProvider({query:x.query}),pool={connect:async()=>({query:x.query,release(){}})};let seq=1000;
 const sourceAdapter=createSourceAdapter({query:x.query,purchaseFor:async a=>({version:'journey_purchase_evidence_v1',source_ref:a.source_ref,subject_id:a.subject_id,brand:a.brand,complete:true,purchased:false,covered_from:a.occurred_at,covered_through:a.now,observed_at:a.now})});
 return {...x,provider,pool,sourceAdapter,async prepare(brand='fish'){
  const s=(await x.query('SELECT crm_graph_candidate.release_source_v1($1,$2) result',[brand,brand==='fish'?60:95])).rows[0].result;
  const release=await provider.prepare('panel:synthetic',{request_id:id(seq++),brand,binding:s.binding,expected_snapshot:s.source_snapshot});
  const catalog=R.bindCatalog(planning(s),[release]),graph=definition(brand,s.binding),source_ref=await x.capture(brand,id(seq++));
  const settings={pool,catalogFor:async()=>copy(catalog),readSource:sourceAdapter.readSource},api=createGraphRuntime(settings),request=p=>({request_id:id(seq++),actor:'panel:synthetic',brand,...p});
  return {s,release,catalog,graph,source_ref,settings,api,request,async atMessage(){let j=await api.create(request({definition:graph}));j=await api.publish(request({journey_id:j.journey_id,expected_version:j.version,confirm:'publicar'}));assert.equal(j.paused,true);await x.query('UPDATE crm_graph_candidate.control SET enabled=true');j=await api.pause(request({journey_id:j.journey_id,expected_version:j.version,paused:false,confirm:'retomar'}));let e=await api.enroll(request({journey_id:j.journey_id,expected_version:j.version,source_ref}));return api.step(request({entry_id:e.entry_id,expected_version:e.version}));}};
 }};
}
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
