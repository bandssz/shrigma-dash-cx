'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {VERSION,OBSERVATION_POLICY,ENABLED,IDENTITY_QUERY,ORDERS_QUERY,createPurchaseProvider}=require('../n8n/growth/journey-graph-purchase.cjs');
const now='2026-09-27T12:00:00.000Z',occurred='2026-09-27T11:00:00.000Z';
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const gid=(type,n)=>'gid://shopify/'+type+'/'+n;
const shops={fish:{id:gid('Shop',1),myshopifyDomain:'synthetic-fish.myshopify.com'},aristo:{id:gid('Shop',2),myshopifyDomain:'synthetic-aristo.myshopify.com'}};
const copy=x=>JSON.parse(JSON.stringify(x));
function setup(options={}){
 const brand=options.brand||'fish',calls=[],query=async()=>({rows:[]});
 const input={brand,source_ref:uuid(1),subject_id:uuid(2),occurred_at:occurred,now,query};
 const identity={version:'journey_shopify_identity_v1',source_ref:uuid(1),subject_id:uuid(2),brand,occurred_at:occurred,checkout_id:gid('AbandonedCheckout',3),email:'synthetic@example.invalid'};
 const customer={id:gid('Customer',4),defaultEmailAddress:{emailAddress:identity.email}};
 const first={shop:shops[brand],currentAppInstallation:{accessScopes:['read_orders','read_customers'].map(handle=>({handle}))},node:{id:identity.checkout_id,createdAt:occurred,completedAt:null,customer}};
 const page=(nodes=[],hasNextPage=false,endCursor=null)=>({shop:shops[brand],customer:{...copy(customer),orders:{nodes,pageInfo:{hasNextPage,endCursor}}}});
 const order=(n,at=occurred)=>({id:gid('Order',n),createdAt:at,customer:{id:customer.id}});
 const responses=[first,page()];
 let time=now,resolverCalls=0;
 const config={shops,clock:()=>time,resolveIdentity:async args=>{resolverCalls++;assert.equal(args.query,query);assert.equal(args.subject_id,input.subject_id);assert.ok(args.signal instanceof AbortSignal);return copy(identity);},request:async req=>{calls.push(req);const body=responses.shift();if(body instanceof Error)throw body;return {status:200,body:{data:copy(body)}};},...options};
 const provider=createPurchaseProvider(config);
 return {input,identity,customer,first,page,order,responses,calls,provider,config,setTime:v=>{time=v;},resolverCalls:()=>resolverCalls};
}

test('both brands use exact checkout and customer queries; exhausted absence never becomes No',async()=>{
 assert.equal(ENABLED,false);
 for(const brand of ['fish','aristo']){
  const x=setup({brand}),r=await x.provider(x.input);
  assert.equal(r.version,VERSION);assert.equal(r.complete,false);assert.equal(r.purchased,null);assert.equal(r.query_complete,true);assert.equal(r.basis,'absence_observed');assert.equal(r.code,'GRAPH_PURCHASE_ABSENCE_NOT_AUTHORITATIVE');assert.equal(r.coverage.exhausted,true);assert.equal(r.coverage.pages,1);
  assert.equal(x.calls[0].document,IDENTITY_QUERY);assert.deepEqual(x.calls[0].variables,{checkout:x.identity.checkout_id});assert.equal(x.calls[1].document,ORDERS_QUERY);assert.deepEqual(x.calls[1].variables,{customer:x.customer.id,first:100,after:null});assert.equal(x.calls[1].shop,shops[brand].myshopifyDomain);assert.equal(x.calls[1].apiVersion,'2026-07');assert.ok(!JSON.stringify(r).includes('synthetic@example'));assert.equal(r.covered_through,undefined);assert.equal(r.order_id,undefined);
 }
});
test('exact completed checkout proves existence, without a false history-coverage claim',async()=>{
 const x=setup();x.first.node.completedAt='2026-09-27T11:30:00Z';const r=await x.provider(x.input);
 assert.equal(r.purchased,true);assert.equal(r.complete,true);assert.equal(r.basis,'checkout_completed');assert.equal(r.purchase_at,'2026-09-27T11:30:00.000Z');assert.equal(r.query_complete,false);assert.equal(r.coverage.pages,0);assert.equal(x.calls.length,1);assert.equal(r.covered_through,undefined);
});
test('associated order proves purchase and exposes only a shop-scoped digest',async()=>{
 const x=setup();x.responses[1]=x.page([x.order(5)]);const r=await x.provider(x.input);
 assert.equal(r.purchased,true);assert.equal(r.complete,true);assert.equal(r.basis,'customer_order');assert.match(r.order_ref_hash,/^[a-f0-9]{64}$/);assert.equal(r.purchase_at,occurred);assert.ok(!JSON.stringify(r).includes('gid://'));
});
test('pagination preserves cursors; only exhaustion completes the observed query',async()=>{
 const x=setup({pageSize:1,maxPages:3});x.responses[1]=x.page([x.order(5,'2026-09-27T10:00:00Z')],true,'older');x.responses.push(x.page([x.order(6,'2026-09-27T09:00:00Z')],false,'last'));const r=await x.provider(x.input);
 assert.equal(r.query_complete,true);assert.equal(r.coverage.exhausted,true);assert.equal(x.calls.length,3);assert.equal(r.purchased,null);assert.equal(x.calls[2].variables.after,'older');assert.equal(r.coverage.orders,2);
 // To traverse multiple pages without finding a purchase, keep the request
 // older than the API's 60-day access window: such exhaustion stays unknown.
 const y=setup({pageSize:1,maxPages:3});y.input.occurred_at=y.identity.occurred_at='2026-06-01T11:00:00.000Z';y.first.node.createdAt=y.input.occurred_at;y.responses[1]=y.page([],false);
 const h=await y.provider(y.input);assert.equal(h.code,'GRAPH_PURCHASE_HISTORY_UNAVAILABLE');assert.equal(h.query_complete,false);
});
test('pagination caps and repeated cursors keep incomplete enumeration unknown',async()=>{
 const x=setup({maxPages:1});x.responses[1]=x.page([x.order(5,'2026-09-27T10:00:00Z')],true,'more');let r=await x.provider(x.input);assert.equal(r.code,'GRAPH_PURCHASE_PAGE_LIMIT');assert.equal(r.query_complete,false);assert.equal(r.coverage.exhausted,false);
 const y=setup();y.responses[1]=y.page([y.order(5,'2026-09-27T10:00:00Z')],true,'same');y.responses.push(y.page([y.order(6,'2026-09-27T09:00:00Z')],true,'same'));r=await y.provider(y.input);assert.equal(r.code,'GRAPH_PURCHASE_CURSOR');assert.equal(r.purchased,null);assert.equal(y.calls.length,3);
});
test('orders newer than the decision clock are accepted only if actually observed by trusted clock',async()=>{
 const x=setup();x.setTime('2026-09-27T12:00:01.000Z');x.responses[1]=x.page([x.order(6,'2026-09-27T12:00:00.500Z')]);assert.equal((await x.provider(x.input)).purchased,true);
 const y=setup();y.responses[1]=y.page([y.order(6,'2026-09-27T12:00:00.500Z')]);assert.equal((await y.provider(y.input)).code,'GRAPH_PURCHASE_ORDER');
});
test('resolver cannot replace source, native subject, brand, checkout time, or email association',async()=>{
 for(const mutate of [x=>{x.identity.subject_id=uuid(9);},x=>{x.identity.source_ref=uuid(9);},x=>{x.identity.brand='aristo';},x=>{x.identity.occurred_at=now;},x=>{x.first.node.createdAt=now;},x=>{x.first.node.customer.defaultEmailAddress.emailAddress='other@example.invalid';}]){
  const x=setup();mutate(x);const r=await x.provider(x.input);assert.equal(r.purchased,null);assert.equal(r.complete,false);assert.equal(r.query_complete,false);assert.ok(x.calls.length<=1);
 }
});
test('credential/shop mixup and customer changes between pages cannot establish a purchase',async()=>{
 for(const change of [x=>{x.responses[1].shop=shops.aristo;},x=>{x.responses[1].customer.id=gid('Customer',9);},x=>{x.responses[1].customer.defaultEmailAddress.emailAddress='changed@example.invalid';},x=>{x.responses[1].customer.orders.nodes[0].customer.id=gid('Customer',9);}]){
  const x=setup();x.responses[1]=x.page([x.order(5)]);change(x);const r=await x.provider(x.input);assert.equal(r.purchased,null);assert.equal(r.complete,false);
 }
});
test('partial GraphQL, HTTP, thrown transport errors, redaction and missing scopes remain unknown',async()=>{
 for(const request of [async()=>({status:429,body:{secret:'must-not-leak'}}),async()=>({status:200,body:{data:{},errors:[{message:'must-not-leak'}]}}),async()=>{throw Error('must-not-leak');}]){
  const x=setup({request}),r=await x.provider(x.input);assert.equal(r.complete,false);assert.equal(r.purchased,null);assert.ok(!JSON.stringify(r).includes('must-not-leak'));
 }
 const x=setup();x.first.currentAppInstallation.accessScopes=[{handle:'read_orders'}];assert.equal((await x.provider(x.input)).code,'GRAPH_PURCHASE_SCOPES');
});
test('UTF-8 response budget is bytes, not characters; invalid calendar timestamps stay unknown',async()=>{
 const x=setup({request:async()=>({status:200,body:{data:{unused:'é'.repeat(140000)}}})});assert.equal((await x.provider(x.input)).code,'GRAPH_PURCHASE_RESPONSE_LIMIT');
 const y=setup();y.first.node.completedAt='2026-02-31T12:00:00Z';assert.equal((await y.provider(y.input)).code,'GRAPH_PURCHASE_CHECKOUT');
});
test('malformed pages, mismatched order ownership, duplicate IDs and unsorted dates fail closed',async()=>{
 for(const nodes of [null,[{id:gid('Order',5),createdAt:occurred,customer:null}],[]]){
  const x=setup();x.responses[1]=x.page(nodes,true,null);const r=await x.provider(x.input);assert.equal(r.purchased,null);assert.equal(r.query_complete,false);
 }
 for(const nodes of [[5,5].map(n=>({id:gid('Order',n),createdAt:occurred,customer:{id:gid('Customer',4)}})),[5,6].map((n,i)=>({id:gid('Order',n),createdAt:i?now:occurred,customer:{id:gid('Customer',4)}}))]){
  const x=setup();x.responses[1]=x.page(nodes);assert.equal((await x.provider(x.input)).code,'GRAPH_PURCHASE_ORDER');
 }
});
test('all-orders scope changes accessibility metadata but still cannot prove absence at now',async()=>{
 const x=setup();x.input.occurred_at=x.identity.occurred_at='2026-01-01T00:00:00.000Z';x.first.node.createdAt=x.input.occurred_at;x.first.currentAppInstallation.accessScopes.push({handle:'read_all_orders'});
 const r=await x.provider(x.input);assert.equal(r.query_complete,true);assert.equal(r.coverage.access_window_days,null);assert.equal(r.coverage.access_window_covers_request,true);assert.equal(r.purchased,null);
});
test('timeouts abort in-flight transport once and sanitize late completion; no retry',async()=>{
 let seenSignal,resolveRequest;const x=setup({timeoutMs:15,request:async req=>{seenSignal=req.signal;return new Promise(resolve=>{resolveRequest=resolve;});}});
 const r=await x.provider(x.input);assert.equal(r.code,'GRAPH_PURCHASE_TIMEOUT');assert.equal(seenSignal.aborted,true);assert.equal(r.complete,false);const before=copy(r);resolveRequest({status:200,body:{data:x.first}});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(r,before);
});
test('timeout also bounds identity SQL resolver, and errors never carry identity data',async()=>{
 const x=setup({timeoutMs:10,resolveIdentity:()=>new Promise(()=>{})});const r=await x.provider(x.input);assert.equal(r.code,'GRAPH_PURCHASE_TIMEOUT');assert.equal(x.calls.length,0);assert.equal(r.observed_at,null);
});
test('trusted clock cannot go backwards or exceed source decision budget',async()=>{
 for(const at of ['2026-09-27T11:59:59.999Z','2026-09-27T12:00:05.001Z','bad']){const x=setup();x.setTime(at);assert.equal((await x.provider(x.input)).code,'GRAPH_PURCHASE_CLOCK');assert.equal(x.calls.length,0);}
});
test('outer cancellation aborts network and pre-aborted input performs no SQL or request',async()=>{
 const controller=new AbortController();let signal,entered;const started=new Promise(r=>{entered=r;});
 const x=setup({request:async req=>{signal=req.signal;entered();return new Promise(()=>{});}});const pending=x.provider({...x.input,signal:controller.signal});await started;controller.abort();const r=await pending;assert.equal(r.code,'GRAPH_PURCHASE_ABORTED');assert.equal(signal.aborted,true);
 const y=setup();const before=await y.provider({...y.input,signal:controller.signal});assert.equal(before.code,'GRAPH_PURCHASE_ABORTED');assert.equal(y.resolverCalls(),0);assert.equal(y.calls.length,0);
});
test('identity is re-resolved after network before any positive or observed absence',async()=>{
 for(const positive of [true,false])for(const field of ['email','checkout_id']){
  const x=setup();if(positive)x.first.node.completedAt=occurred;const original=x.config.request;let reads=0;
  const provider=createPurchaseProvider({...x.config,resolveIdentity:async()=>{reads++;return copy(x.identity);},request:async req=>{const r=await original(req);if(req.document===ORDERS_QUERY||positive)x.identity[field]=field==='email'?'changed@example.invalid':gid('AbandonedCheckout',999);return r;}});
  const r=await provider(x.input);assert.equal(r.code,'GRAPH_PURCHASE_IDENTITY_CHANGED');assert.equal(r.purchased,null);assert.equal(r.complete,false);assert.equal(r.query_complete,false);assert.equal(reads,2);
 }
});
test('configuration is copied and server routing cannot be replaced through input',async()=>{
 const x=setup();const r=await x.provider({...x.input,shop:'attacker.invalid',customer:gid('Customer',999),email:'attacker@example.invalid'});assert.equal(r.purchased,null);assert.equal(x.calls[0].shop,shops.fish.myshopifyDomain);assert.equal(x.calls[1].variables.customer,x.customer.id);
 assert.throws(()=>createPurchaseProvider({...x.config,shops:{fish:{id:gid('Shop',1),myshopifyDomain:'https://attacker.invalid'}}}),/CONFIG/);
 await assert.rejects(x.provider({...x.input,brand:'olivas'}),/IDENTITY/);
});

function observational(options={}){
 const x=setup({observationPolicy:OBSERVATION_POLICY,...options});x.responses.push(copy(x.first),x.page());return x;
}
test('explicit observational policy binds exhaustive rechecked absence to the native cart, without changing authoritative fields',async()=>{
 const hashes=[];
 for(const brand of ['fish','aristo']){
  const x=observational({brand}),r=await x.provider(x.input),o=r.observation;
  assert.deepEqual(x.calls.map(c=>c.document),[IDENTITY_QUERY,ORDERS_QUERY,IDENTITY_QUERY,ORDERS_QUERY]);
  assert.deepEqual(x.calls.filter(c=>c.document===ORDERS_QUERY).map(c=>c.variables.after),[null,null]);
  assert.equal(r.purchased,null);assert.equal(r.complete,false);assert.equal(r.query_complete,true);assert.equal(r.covered_through,undefined);
  assert.deepEqual({...o,shop_ref_hash:null,customer_ref_hash:null,checkout_ref_hash:null},{policy:OBSERVATION_POLICY,found:false,brand,source_ref:x.input.source_ref,subject_id:x.input.subject_id,occurred_at:occurred,check_at:now,shop_ref_hash:null,customer_ref_hash:null,checkout_ref_hash:null,enumerated:true,checkout_rechecked:true,head_rechecked:true});
  for(const key of ['shop_ref_hash','customer_ref_hash','checkout_ref_hash'])assert.match(o[key],/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(r).includes('gid://'));assert.ok(!JSON.stringify(r).includes('synthetic@example'));hashes.push(o.customer_ref_hash);assert.equal(x.resolverCalls(),2);
 }
 assert.notEqual(...hashes);
});
test('policy is server opt-in; a caller field cannot enable it and unsupported policy fails',async()=>{
 const x=setup(),r=await x.provider({...x.input,observationPolicy:OBSERVATION_POLICY});assert.equal(r.observation,undefined);assert.equal(x.calls.length,2);
 assert.throws(()=>createPurchaseProvider({...x.config,observationPolicy:'unapproved'}),/CONFIG/);
});
test('exhaustive multi-page history is rechecked at the head before found:false',async()=>{
 const x=observational({pageSize:1});const head=x.page([x.order(5,'2026-09-27T10:00:00Z')],true,'next');
 x.responses.splice(1,3,head,x.page([x.order(6,'2026-09-27T09:00:00Z')],false,'last'),copy(x.first),copy(head));
 const r=await x.provider(x.input);assert.equal(r.observation.found,false);assert.equal(r.coverage.exhausted,true);assert.equal(r.coverage.pages,3);assert.equal(x.calls.length,5);assert.deepEqual(x.calls.filter(c=>c.document===ORDERS_QUERY).map(c=>c.variables.after),[null,'next',null]);
});
test('purchase appearing between pages is caught on the final head and dominates prior absence',async()=>{
 const x=observational({pageSize:1});x.responses.splice(1,3,x.page([x.order(5,'2026-09-27T10:00:00Z')],true,'next'),x.page([x.order(6,'2026-09-27T09:00:00Z')]),copy(x.first),x.page([x.order(7,'2026-09-27T11:30:00Z')],true,'new'));
 const r=await x.provider(x.input);assert.equal(r.observation.found,true);assert.equal(r.purchased,true);assert.equal(r.observation.checkout_rechecked,true);assert.equal(r.observation.head_rechecked,true);assert.equal(r.purchase_at,'2026-09-27T11:30:00.000Z');
});
test('a newly visible order on a later page is positive even when insertion changes cross-page ordering',async()=>{
 const x=observational({pageSize:1});x.responses.splice(1,3,x.page([x.order(5,'2026-09-27T10:00:00Z')],true,'next'),x.page([x.order(7,'2026-09-27T11:30:00Z')]));
 const r=await x.provider(x.input);assert.equal(r.purchased,true);assert.equal(r.observation.found,true);assert.equal(x.calls.length,3);assert.equal(r.observation.enumerated,false);
});
test('checkout completed during enumeration dominates, without pretending orders were rechecked',async()=>{
 const x=observational();x.responses[2].node.completedAt='2026-09-27T11:30:00Z';const r=await x.provider(x.input);
 assert.equal(r.purchased,true);assert.equal(r.basis,'checkout_completed');assert.equal(r.observation.found,true);assert.equal(r.observation.checkout_rechecked,true);assert.equal(r.observation.head_rechecked,false);assert.equal(x.calls.length,3);
});
test('final checkout, scope, customer and head failures cannot emit found:false',async()=>{
 for(const change of [
  x=>{x.responses[2].node=null;},
  x=>{x.responses[2].node.customer.id=gid('Customer',99);},
  x=>{x.responses[2].node.customer.defaultEmailAddress.emailAddress='changed@example.invalid';},
  x=>{x.responses[2].node.createdAt=now;},
  x=>{x.responses[2].currentAppInstallation.accessScopes=[{handle:'read_orders'}];},
  x=>{x.responses[3].shop=shops.aristo;},
  x=>{x.responses[3].customer.orders.pageInfo.hasNextPage=true;},
  x=>{x.responses[3]=Error('private provider failure');}
 ]){const x=observational();change(x);const r=await x.provider(x.input);assert.equal(r.observation,undefined);assert.equal(r.purchased,null);assert.equal(r.complete,false);assert.equal(r.query_complete,false);}
});
test('head history changing without a positive order stays unknown rather than recycling the old enumeration',async()=>{
 const x=observational();x.responses[3]=x.page([x.order(8,'2026-09-27T09:00:00Z')]);const r=await x.provider(x.input);assert.equal(r.code,'GRAPH_PURCHASE_HEAD_CHANGED');assert.equal(r.observation,undefined);
});
test('window, page limit and partial proofs cannot emit an observed negative',async()=>{
 const x=observational();x.input.occurred_at=x.identity.occurred_at='2026-06-01T11:00:00.000Z';x.first.node.createdAt=x.input.occurred_at;let r=await x.provider(x.input);assert.equal(r.code,'GRAPH_PURCHASE_HISTORY_UNAVAILABLE');assert.equal(r.observation,undefined);assert.equal(x.calls.length,2);
 const y=observational({maxPages:1});y.responses[1]=y.page([y.order(5,'2026-09-27T10:00:00Z')],true,'more');r=await y.provider(y.input);assert.equal(r.code,'GRAPH_PURCHASE_PAGE_LIMIT');assert.equal(r.observation,undefined);
 const z=observational();z.input.occurred_at=z.identity.occurred_at='2026-06-01T11:00:00.000Z';z.first.node.createdAt=z.input.occurred_at;z.first.currentAppInstallation.accessScopes.push({handle:'read_all_orders'});z.responses[2]=copy(z.first);z.responses[2].currentAppInstallation.accessScopes.pop();r=await z.provider(z.input);assert.equal(r.code,'GRAPH_PURCHASE_HISTORY_UNAVAILABLE');assert.equal(r.observation,undefined);assert.equal(z.calls.length,3);
});
test('observational final native identity check rejects changes after the last Shopify response',async()=>{
 const x=observational(),base=x.config.request;let n=0;
 const provider=createPurchaseProvider({...x.config,request:async req=>{const r=await base(req);if(++n===4)x.identity.checkout_id=gid('AbandonedCheckout',999);return r;}});
 const r=await provider(x.input);assert.equal(r.code,'GRAPH_PURCHASE_IDENTITY_CHANGED');assert.equal(r.observation,undefined);assert.equal(r.purchased,null);
});
test('the same total timeout and external abort include final observational rechecks',async()=>{
 for(const outer of [false,true]){
  const x=observational({timeoutMs:20}),base=x.config.request,controller=new AbortController();let n=0,lastSignal,entered;const started=new Promise(r=>{entered=r;});
  const provider=createPurchaseProvider({...x.config,request:async req=>{if(++n===4){lastSignal=req.signal;entered();return new Promise(()=>{});}return base(req);}});
  const pending=provider({...x.input,signal:controller.signal});await started;if(outer)controller.abort();const r=await pending;assert.equal(r.code,outer?'GRAPH_PURCHASE_ABORTED':'GRAPH_PURCHASE_TIMEOUT');assert.equal(r.observation,undefined);assert.equal(lastSignal.aborted,true);assert.equal(n,4);
 }
});
test('successful individual reads do not renew the total observational deadline',async()=>{
 const x=observational({timeoutMs:20}),base=x.config.request;let calls=0;
 const provider=createPurchaseProvider({...x.config,request:async req=>{calls++;await new Promise(resolve=>setTimeout(resolve,8));return base(req);}});
 const r=await provider(x.input);assert.equal(r.code,'GRAPH_PURCHASE_TIMEOUT');assert.equal(r.observation,undefined);assert.ok(calls<4);
});
