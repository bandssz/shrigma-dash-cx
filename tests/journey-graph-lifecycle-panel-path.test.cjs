'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const Browser=require('../growth-journey-graph-api.js'),UI=require('../growth-journey-graph-ui.js'),Editor=require('../growth-journey-graph-editor.js');
const {createLifecyclePanelAPI}=require('../n8n/growth/journey-graph-lifecycle-panel-api.cjs');
const {createLifecyclePublisher}=require('../n8n/growth/journey-graph-lifecycle-publication.cjs');
const {createDraftApi}=require('../n8n/growth/journey-graph-draft-api.cjs');
const Catalog=require('../n8n/growth/journey-graph-catalog.cjs');
const {fixture,id,authorization,read}=require('./journey-graph-lifecycle-prepare-fixture.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
async function setup(t,brand){
 const f=await fixture(t,brand);await f.db.exec(read('n8n/growth/journey-graph-lifecycle-publication.sql'));
 const publisher=createLifecyclePublisher(f.options);
 // This path exercises the real stores on the owner fixture. Dedicated-role
 // access is a separate runtime proof; no fake database role is asserted here.
 const lifecycle=createLifecyclePanelAPI({pool:f.pool,checkoutSha:f.options.checkoutSha,enabled:true,preparerFactory:()=>f.api,publisherFactory:()=>publisher});
 const draft=createDraftApi({pool:f.pool,catalogFor:Catalog.catalogFor}),values=new Map(),buffers=new Map(),calls=[];
 const server=Object.fromEntries(['journey_id','brand','version','revision','published_revision','paused'].map(k=>[k,f.original[k]]));
 buffers.set(brand,{definition:copy(f.definition),server,base:copy(f.definition)});
 let seq=800,dropPost=false,dropLookup=false,locked=false;
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const locks={async request(name,options,fn){if(locked)return fn(null);locked=true;try{return await fn({});}finally{locked=false;}}};
 const fetch=async(url,o)=>{
  const u=new URL(url),p=o.method==='POST'?JSON.parse(o.body):Object.fromEntries(u.searchParams);calls.push({endpoint:u.pathname,method:o.method,p:copy(p)});
  let result;
  if(u.pathname==='/lifecycle'){
   if(p.action==='operation'&&dropLookup){dropLookup=false;throw Error('Readback response unavailable');}
   result=await lifecycle.handle({method:o.method,request:{headers:{Authorization:o.headers.Authorization},...(o.method==='POST'?{body:p}:{query:p})}});
   if(o.method==='POST'&&p.action!=='review'&&dropPost){dropPost=false;dropLookup=true;throw Error('Committed response lost');}
  }else{
   if(p.action==='list'){p.after=null;p.limit=25;}
   result=await draft.handle({method:o.method,authorization:o.headers.Authorization,request:p});
  }
  return {status:result.status,json:async()=>result.body};
 };
 const api={capabilities:{journeys:{graph_drafts:Browser.CONTRACT,graph_lifecycle:{contract:Browser.LIFECYCLE,prepare:true,publish_paused:true,activate:false,brands:['fish','aristo']}},endpoints:{journey_graph:'https://example.test/draft',journey_graph_lifecycle:'https://example.test/lifecycle'}}};
 function mount(){
  const {document,window}=parseHTML('<html><body><button id="control-tab-graph"></button><section id="control-graph"></section></body></html>');
  const state={read:(_kind,b)=>copy(buffers.get(b)||null),save:(_kind,b,v)=>buffers.set(b,copy(v))};
  const ui=UI.create({document,Editor,API:Browser,state,key:()=>authorization.slice(7),clientFactory:options=>Browser.create({...options,storage,locks,crypto:{randomUUID:()=>id(seq++)},fetch})});
  const el=s=>{const x=document.querySelector(s);assert.ok(x,'Missing '+s+'\n'+document.body.textContent);return x;};
  async function settle(){const started=Date.now();do{await new Promise(resolve=>setImmediate(resolve));if(!ui.contextStatus().blocked||document.querySelector('[role=alertdialog]'))return;}while(Date.now()-started<10000);throw Error('UI remained busy: '+document.body.textContent);}
  const click=async s=>{const x=el('[data-graph="'+s+'"]');assert.equal(x.disabled,false,s+' disabled');x.dispatchEvent(new window.Event('click',{bubbles:true}));await settle();};
  return {ui,document,window,el,click,sync:()=>ui.sync({api,marca:brand,section:'regua',tab:'graph'})};
 }
 return {...f,mount,buffers,values,calls,api,lose:()=>dropPost=true,lifecycle};
}
for(const brand of ['fish','aristo'])test('analyst '+brand+': review → prepare → paused publication, durable recovery and read-only reopen',async t=>{
 const f=await setup(t,brand);let ui=f.mount();await ui.sync();
 await ui.click('review');assert.ok(ui.el('[data-graph="prepare"]'));
 await ui.click('prepare');await ui.click('accept');assert.ok(f.buffers.get(brand).lifecycle_prepared,ui.document.body.textContent);
 const before=copy(f.buffers.get(brand));f.lose();await ui.click('publish');await ui.click('accept');
 assert.equal(ui.ui.contextStatus().pending,true);assert.deepEqual(f.buffers.get(brand),before);
 if(brand==='fish'){const edited=copy(before);edited.definition.name='Edição mais recente preservada';f.buffers.set(brand,edited);delete f.api.capabilities.endpoints.journey_graph_lifecycle;delete f.api.capabilities.journeys.graph_lifecycle;}
 ui=f.mount();await ui.sync();await ui.click('recover');
 assert.equal(ui.ui.contextStatus().pending,false,ui.document.body.textContent);assert.equal(f.buffers.get(brand).server.published_revision,2);assert.equal(f.buffers.get(brand).server.paused,true);
 assert.equal(ui.el('[data-graph="save"]').disabled,true);assert.equal(ui.el('[data-name]').disabled,true);
 if(brand==='fish'){assert.equal(f.buffers.get(brand).local_edit.definition.name,'Edição mais recente preservada');assert.ok(ui.el('[data-graph=restore-local]'));}
 assert.match(ui.document.body.textContent,/publicada e pausada/);assert.doesNotMatch(JSON.stringify([...f.values]),/synthetic-manager-key/);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.p.action==='publish').length,1);
 if(brand==='fish'){await ui.click('restore-local');await ui.click('accept');assert.equal(f.buffers.get(brand).server,null);assert.equal(ui.el('[data-name]').value,'Edição mais recente preservada');}
 await ui.click('open');if(ui.document.querySelector('[role=alertdialog]'))await ui.click('accept');assert.equal(ui.el('[data-name]').disabled,true);assert.equal(ui.ui.contextStatus().pending,false);
 assert.deepEqual((await f.db.query('SELECT revision FROM crm_graph_candidate.revision ORDER BY revision')).rows.map(r=>r.revision),[1,2]);
 assert.equal(await f.count('entry'),0);assert.equal(await f.count('intent'),0);
 assert.equal((await f.db.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
});
test('lifecycle gate refuses mutation but allows operation lookup and rejects activation/ambiguous credentials',async t=>{
 const f=await setup(t,'fish'),off=createLifecyclePanelAPI({pool:f.pool,checkoutSha:f.options.checkoutSha});
 const request={headers:{Authorization:authorization},body:f.reviewRequest};
 assert.equal((await off.handle({method:'POST',request})).status,503);
 assert.equal((await f.lifecycle.handle({method:'GET',request:{headers:{Authorization:authorization,authorization},query:{action:'operation',brand:'fish',request_id:id(99)}}})).status,401);
 const denied=await f.lifecycle.handle({method:'POST',request:{headers:{Authorization:authorization},body:{action:'pause',brand:'fish',journey_id:f.original.journey_id,expected_version:1,published_revision:1,request_id:id(98),confirm:'pausar'}}});assert.equal(denied.status,400);
 assert.equal(await f.count('lifecycle_prepared_v1'),0);assert.equal(await f.count('lifecycle_publication_v1'),0);
});

test('a stale draft list rereads immutable publication status before adopting the editor catalog',async t=>{
 const f=await setup(t,'fish'),ui=f.mount();await ui.sync();
 const prepared=await f.prepare(f.request(await f.review())),publisher=createLifecyclePublisher(f.options);
 await publisher.publish({action:'publish',brand:'fish',journey_id:f.original.journey_id,expected_version:1,request_id:id(910),prepared_revision:2,prepared_hash:prepared.receipt.prepared_hash,confirm:'publicar'},{authorization});
 const before=f.calls.length;await ui.click('open');
 assert.ok(f.calls.slice(before).some(c=>c.endpoint==='/draft'&&c.p.action==='get'));
 assert.ok(f.calls.slice(before).some(c=>c.endpoint==='/lifecycle'&&c.p.action==='status'));
 const buffer=f.buffers.get('fish');assert.equal(buffer.server.published_revision,2);assert.match(buffer.publication_catalog.messages[0].release,/^release_/);assert.equal(ui.el('[data-name]').disabled,true);
});
test('an edit occurring during publication confirmation is rechecked before any POST',async t=>{
 const f=await setup(t,'fish'),ui=f.mount();await ui.sync();await ui.click('review');await ui.click('prepare');await ui.click('accept');await ui.click('publish');
 const input=ui.el('[data-name]');input.value='Alteração durante confirmação';input.dispatchEvent(new ui.window.Event('input',{bubbles:true}));
 await ui.click('accept');assert.equal(f.calls.filter(c=>c.p.action==='publish').length,0);assert.equal(f.buffers.get('fish').definition.name,input.value);assert.equal(f.buffers.get('fish').server.published_revision,null);assert.match(ui.document.body.textContent,/edição ou a disponibilidade mudou/);
});
