'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const Browser=require('../growth-journey-graph-api.js'),UI=require('../growth-journey-graph-ui.js'),Editor=require('../growth-journey-graph-editor.js');
const {fixture}=require('./fixtures/journey-graph-runtime.cjs');
const copy=x=>JSON.parse(JSON.stringify(x)),tick=()=>new Promise(resolve=>setImmediate(resolve));
const id=n=>'94000000-0000-4000-8000-'+String(n).padStart(12,'0'),hash=n=>String(n).repeat(64);
const activationId=id(2),journeyId=id(1),epochId=id(3),authorization='synthetic-manager-key';
function transport({dropActivation=false,commitActivation=true}={}){
 const calls=[],reviews=new Map(),receipts=new Map(),response=(contract,status,body)=>({status,json:async()=>({contract,authorizes_publish:false,authorizes_activate:false,authorizes_enrollment:false,authorizes_send:false,...body})});
 async function fetch(url,options){
  const target=new URL(url),p=options.method==='POST'?JSON.parse(options.body):Object.fromEntries(target.searchParams);calls.push({method:options.method,path:target.pathname,p:copy(p)});
  if(target.pathname==='/draft'){
   const f=fixture({async connect(){throw Error('unused');}},p.brand),server={journey_id:journeyId,brand:p.brand,version:2,revision:2,published_revision:2,paused:true};
   if(p.action==='catalog')return response(Browser.CONTRACT,200,{catalog:f.catalog,labels:{triggers:{'cart.abandoned':'Carrinho abandonado'},fields:{},messages:{'cart.email':'Mensagem'}}});
   if(p.action==='list')return response(Browser.CONTRACT,200,{journeys:[{...server,name:f.graph.name}],next_cursor:null});
  }
  if(p.action==='activation_review'){
   const review={contract:'journey_graph_cart_activation_review_v1',state:'ready',request_id:p.request_id,brand:p.brand,journey_id:p.journey_id,version:p.expected_version,published_revision:p.published_revision,publication_hash:p.publication_hash,review_hash:hash(2),checked_at:new Date().toISOString(),expires_at:new Date(Date.now()+30000).toISOString(),blockers:[],authorizes_activate:false,authorizes_enrollment:false,authorizes_send:false};
   reviews.set(p.request_id,review);return response(Browser.LIFECYCLE,200,{state:'ready',actor:'panel:manager',request_id:p.request_id,request_payload:p,review});
  }
  if(p.action==='activation_operation'){
   if(receipts.has(p.request_id))return response(Browser.LIFECYCLE,200,{state:'succeeded',actor:'panel:manager',request_id:p.request_id,receipt:receipts.get(p.request_id)});
   if(reviews.has(p.request_id))return response(Browser.LIFECYCLE,200,{state:'reviewed',actor:'panel:manager',request_id:p.request_id,review:reviews.get(p.request_id)});
   return response(Browser.LIFECYCLE,202,{state:'unconfirmed',actor:'panel:manager',request_id:p.request_id,automatic_retry:false});
  }
  if(p.action==='activate'){
   assert.equal(p.request_id,activationId);assert.equal(p.admission_review_hash,reviews.get(p.request_id).review_hash);
   if(commitActivation)receipts.set(p.request_id,{contract:'journey_graph_cart_activation_v1',state:'active',request_id:p.request_id,brand:p.brand,journey_id:p.journey_id,base_version:p.expected_version,version:p.expected_version+1,published_revision:p.published_revision,publication_hash:p.publication_hash,review_hash:p.admission_review_hash,epoch_id:epochId,authorizes_activate:false,authorizes_enrollment:false,authorizes_send:false});
   if(dropActivation)throw Error('synthetic lost acknowledgement');
   return response(Browser.LIFECYCLE,200,{state:'succeeded',actor:'panel:manager',request_id:p.request_id,request_payload:p,receipt:receipts.get(p.request_id)});
  }
  throw Error('unexpected request '+target.pathname+' '+p.action);
 }
 return {calls,fetch,reviews,receipts};
}
function clientFixture(options={}){
 const wire=transport(options),values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},locks={request:async(_n,_o,fn)=>fn({})},crypto={randomUUID:()=>activationId};
 const client=Browser.create({endpoint:'https://example.test/draft',lifecycleEndpoint:'https://example.test/lifecycle',key:authorization,fetch:wire.fetch,storage,locks,crypto});return {...wire,client,storage,locks,crypto,values};
}
test('activation uses the reviewed request id and a lost acknowledgement reconciles by GET without another POST',async()=>{
 const f=clientFixture({dropActivation:true}),review=await f.client.reviewActivation({brand:'fish',journey_id:journeyId,expected_version:2,request_id:activationId,published_revision:2,publication_hash:hash(1)});
 const result=await f.client.activateReviewed({action:'activate',brand:'fish',request_id:review.request_id,journey_id:journeyId,expected_version:2,published_revision:2,publication_hash:hash(1),admission_review_hash:review.review.review_hash,confirm:'ativar'});
 assert.equal(result.receipt.epoch_id,epochId);assert.equal(result.request_payload.request_id,review.request_id);assert.equal(f.calls.filter(x=>x.method==='POST'&&x.p.action==='activate').length,1);assert.equal(f.calls.filter(x=>x.method==='GET'&&x.p.action==='activation_operation').length,2);
 await f.client.acknowledge(activationId);assert.equal(f.client.inspect().pending,null);
});
test('an activation with no terminal receipt remains fenced and recovery never repeats POST',async()=>{
 const f=clientFixture({dropActivation:true,commitActivation:false}),review=await f.client.reviewActivation({brand:'fish',journey_id:journeyId,expected_version:2,request_id:activationId,published_revision:2,publication_hash:hash(1)});
 await assert.rejects(f.client.activateReviewed({action:'activate',brand:'fish',request_id:activationId,journey_id:journeyId,expected_version:2,published_revision:2,publication_hash:hash(1),admission_review_hash:review.review.review_hash,confirm:'ativar'}),{code:'GRAPH_UNKNOWN'});
 await assert.rejects(f.client.recover(activationId,{resume:true}),{code:'GRAPH_UNKNOWN'});assert.equal(f.calls.filter(x=>x.method==='POST'&&x.p.action==='activate').length,1);assert.equal(f.client.inspect().pending.payload.request_id,activationId);
});
test('the panel review and activation controls keep the same identity and persist the active receipt',async()=>{
 const f=clientFixture(),runtime=fixture({async connect(){throw Error('unused');}},'fish'),store=new Map(),server={journey_id:journeyId,brand:'fish',version:2,revision:2,published_revision:2,paused:true};
 store.set('fish',{definition:copy(runtime.graph),server,base:copy(runtime.graph),publication_catalog:copy(runtime.catalog),lifecycle_publication:{journey_id:journeyId,publication_hash:hash(1)}});
 const {document,window}=parseHTML('<html><body><button id="control-tab-graph"></button><section id="control-graph"></section></body></html>'),state={read:(_k,b)=>copy(store.get(b)||null),save:(_k,b,v)=>store.set(b,copy(v))},api={capabilities:{journeys:{graph_drafts:Browser.CONTRACT,graph_lifecycle:{contract:Browser.LIFECYCLE,prepare:true,publish_paused:true,activate:true,brands:['fish','aristo']}},endpoints:{journey_graph:'https://example.test/draft',journey_graph_lifecycle:'https://example.test/lifecycle'}}};
 const oldCrypto=globalThis.crypto;Object.defineProperty(globalThis,'crypto',{value:{...oldCrypto,randomUUID:()=>activationId},configurable:true});
 try{
  const ui=UI.create({document,Editor,state,key:()=>authorization,clientFactory:()=>f.client}),el=s=>{const x=document.querySelector(s);assert.ok(x,'missing '+s+' '+document.body.textContent);return x;},settle=async()=>{for(let i=0;i<50;i++){await tick();if(!ui.contextStatus().blocked||document.querySelector('[role=alertdialog]'))return;}throw Error('panel busy');},click=async action=>{const x=el('[data-graph="'+action+'"]');assert.equal(x.disabled,false);x.dispatchEvent(new window.Event('click',{bubbles:true}));await settle();};
  await ui.sync({api,marca:'fish',section:'regua',tab:'graph'});await click('activation-review');assert.equal(store.get('fish').activation_review.request_id,activationId);assert.ok(el('[data-graph="activate"]'));
  await click('activate');await click('accept');assert.equal(store.get('fish').server.paused,false);assert.equal(store.get('fish').activation_receipt.request_id,activationId);assert.match(document.body.textContent,/Fluxo CART ativo/);assert.equal(f.calls.filter(x=>x.method==='POST'&&x.p.action==='activate').length,1);
 }finally{Object.defineProperty(globalThis,'crypto',{value:oldCrypto,configurable:true});}
});
