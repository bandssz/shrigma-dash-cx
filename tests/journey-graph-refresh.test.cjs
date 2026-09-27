'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createMaterialProvider,IDENTITY_SQL}=require('../n8n/growth/journey-graph-refresh.cjs');
const {createSourceAdapter}=require('../n8n/growth/journey-graph-source.cjs');
const {setup,id}=require('./journey-graph-source-fixture.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
const stores={fish:'synthetic-fish.myshopify.com',aristo:'synthetic-aristo.myshopify.com'};
function fixture(brand='fish') {
 const now='2026-09-26T12:00:00.000Z',ref='2026-09-26T11:00:00.000Z';
 const native={subject_id:id(1),revision:'a'.repeat(64),cart_hash:'b'.repeat(64),occurred_at:ref,email:'synthetic@example.invalid',cart_id:'gid://shopify/AbandonedCheckout/1'};
 const input={source_ref:id(2),subject_id:id(1),brand,occurred_at:ref,now};
 const data={shop:{myshopifyDomain:stores[brand]},node:{id:native.cart_id,createdAt:ref,updatedAt:ref,completedAt:null,abandonedCheckoutUrl:'https://example.invalid/checkouts/synthetic',customer:{id:'gid://shopify/Customer/2',email:native.email,firstName:'Synthetic',emailMarketingConsent:{marketingState:'SUBSCRIBED'}},totalPriceSet:{shopMoney:{amount:'12.30',currencyCode:'BRL'}},lineItems:{nodes:[{id:'gid://shopify/AbandonedCheckoutLineItem/3',title:'Synthetic',quantity:1,variantTitle:null,image:{url:'https://example.invalid/synthetic.png'},originalUnitPriceSet:{shopMoney:{amount:'12.30',currencyCode:'BRL'}}}],pageInfo:{hasNextPage:false}}}};
 let time=now,reads=0,calls=0,after=()=>{};
 const query=async(q,args)=>{assert.equal(q,IDENTITY_SQL);assert.deepEqual(args,[brand,id(2),id(1)]);reads++;return {rows:[copy(native)]};};
 const graphql=async p=>{calls++;assert.equal(p.brand,brand);assert.deepEqual(p.variables,{id:native.cart_id});after();return {data:copy(data)};};
 const provider=createMaterialProvider({query,graphql,stores,clock:()=>time});
 return {input,native,data,provider,query,graphql,setTime:v=>time=v,after:v=>after=v,counts:()=>({reads,calls})};
}
test('exact checkout refresh in both shops preserves zero, null variant semantics and conservative observation',async()=>{
 for(const brand of ['fish','aristo']){const f=fixture(brand);f.data.node.totalPriceSet.shopMoney.amount='0.00';f.data.node.lineItems.nodes[0].id='gid://shopify/AbandonedCheckoutLineItem/opaque-id?abandoned_checkout_id=1';const p=await f.provider(f.input);assert.equal(p.brand,brand);assert.equal(p.observed_at,f.input.now);assert.equal(p.material['cart.total'],0);assert.equal(p.material['cart.items'][0].variante,'');assert.equal(p.purchase_positive,false);assert.equal(p.complete,true);assert.deepEqual(f.counts(),{reads:2,calls:1});}
});
test('foreign store, changed checkout/customer identity, API errors and incomplete items never return fresh material',async()=>{
 for(const mutate of [f=>f.data.shop.myshopifyDomain=stores.aristo,f=>f.data.node.id+='2',f=>f.data.node.createdAt='2026-09-26T10:00:00Z',f=>f.data.node.customer.email='other@example.invalid',f=>f.data.node.customer=null,f=>f.data.node.lineItems.pageInfo.hasNextPage=true,f=>f.data.node.lineItems.nodes=[],f=>delete f.data.node.completedAt,f=>f.data.node.totalPriceSet.shopMoney.currencyCode='USD',f=>delete f.data.node.lineItems.nodes[0].originalUnitPriceSet,f=>f.data.node.lineItems.nodes.push(copy(f.data.node.lineItems.nodes[0])),f=>f.data.node.abandonedCheckoutUrl='http://example.invalid',f=>f.data.node.updatedAt='2027-01-01T00:00:00Z']){const f=fixture();mutate(f);await assert.rejects(f.provider(f.input),{code:'GRAPH_MATERIAL_UNCONFIRMED'});}
 const f=fixture();const p=createMaterialProvider({query:f.query,graphql:async()=>({data:f.data,errors:[{message:'partial'}]}),stores,clock:()=>f.input.now});await assert.rejects(p(f.input),{code:'GRAPH_MATERIAL_UNCONFIRMED'});
});
test('completed checkout blocks purchase; missing or denied Shopify marketing permission cannot renew material',async()=>{
 for(const state of ['UNSUBSCRIBED','PENDING',null]){const f=fixture();f.data.node.customer.emailMarketingConsent=state?{marketingState:state}:null;const p=await f.provider(f.input);assert.equal(p.consent_allowed,false);assert.equal(p.material,null);}
 const f=fixture();f.data.node.completedAt='2026-09-26T11:30:00Z';const p=await f.provider(f.input);assert.equal(p.purchase_positive,true);assert.equal(p.material,null);f.data.node.completedAt='2027-01-01T00:00:00Z';await assert.rejects(f.provider(f.input),/UNCONFIRMED/);
});
test('identity is reread after I/O; clock drift, budget expiry, email corrections and unexpected keys fail closed',async()=>{
 const f=fixture();f.after(()=>{f.native.email='changed@example.invalid';});await assert.rejects(f.provider(f.input),/UNCONFIRMED/);
 const late=fixture();late.after(()=>late.setTime('2026-09-26T12:00:05.001Z'));await assert.rejects(late.provider(late.input),/UNCONFIRMED/);
 const backward=fixture();backward.setTime('2026-09-26T11:59:59.999Z');await assert.rejects(backward.provider(backward.input),/UNCONFIRMED/);
 const typo=fixture();typo.data.node.customer.email='synthetic@gmial.com';typo.native.email='synthetic@gmail.com';await assert.rejects(typo.provider(typo.input),/UNCONFIRMED/);
 assert.throws(()=>createMaterialProvider({query:f.query,graphql:f.graphql,stores:{fish:stores.fish,aristo:stores.fish}}),/UNCONFIRMED/);
});
test('SQL integration refreshes memory only, preserves old observations, and rereads opt-out after HTTP',async t=>{
 const x=await setup();t.after(()=>x.db.close());
 for(const brand of ['fish','aristo']){
  await x.query("UPDATE subscribers SET attribs=jsonb_set(attribs,ARRAY[$1,'cart_id'],'\"gid://shopify/AbandonedCheckout/1\"')",[brand]);
  const ref=await x.capture(brand,id(brand==='fish'?111:112));
  await x.query("UPDATE crm_graph_candidate.source_observation_v1 SET observed_at=observed_at-interval '10 minutes' WHERE source_ref=$1",[ref]);
  const old=(await x.query('SELECT observed_at FROM crm_graph_candidate.source_observation_v1 WHERE source_ref=$1',[ref])).rows[0].observed_at;
  const f=fixture(brand);f.data.node.createdAt=x.ref;f.data.node.updatedAt=x.ref;
  let optout=false;
  const materialFor=createMaterialProvider({query:x.query,stores,graphql:async()=>{if(optout)await x.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE list_id=$1",[brand==='fish'?17:16]);return {data:f.data};}});
  const adapter=createSourceAdapter({query:x.query,materialFor});
  const p=await x.read(ref,brand,adapter);assert.equal(p.facts['cart.total'].value,'R$ 12,30');assert.ok(Date.parse(p.facts['cart.total'].observed_at)>Date.parse(old));assert.equal(p.facts['purchase.confirmed'],undefined);
  assert.equal(String((await x.query('SELECT observed_at FROM crm_graph_candidate.source_observation_v1 WHERE source_ref=$1',[ref])).rows[0].observed_at),String(old));
  optout=true;const changed=await x.read(ref,brand,adapter);assert.equal(changed.consent,false);assert.equal(changed.facts['contact.email_allowed'].value,false);
 }
 assert.equal((await x.query('SELECT count(*)::int n FROM crm_graph_candidate.intent')).rows[0].n,0);
});
test('provider failure is sanitized and does not fall back to stale material; one budget aborts both providers',async t=>{
 const x=await setup();t.after(()=>x.db.close());const ref=await x.capture();
 const broken=createSourceAdapter({query:x.query,materialFor:async()=>{throw Error('secret-provider-body');}});await assert.rejects(x.read(ref,'fish',broken),e=>e.code==='GRAPH_SOURCE_REFRESH_UNCONFIRMED'&&!e.message.includes('secret'));
 let aborts=0;
 const waiting=({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborts++;reject(Error('aborted'));},{once:true}));
 const timed=createSourceAdapter({query:x.query,materialFor:waiting,purchaseFor:waiting});await assert.rejects(x.read(ref,'fish',timed),{code:'GRAPH_SOURCE_REFRESH_UNCONFIRMED'});assert.equal(aborts,2);
});
test('composed Shopify source supplies fresh material and positive orders, never promotes observed absence to No',async t=>{
 const {createShopifySource}=require('../n8n/growth/journey-graph-shopify.cjs');
 const x=await setup();t.after(()=>x.db.close());
 const shops={fish:{id:'gid://shopify/Shop/1',myshopifyDomain:stores.fish},aristo:{id:'gid://shopify/Shop/2',myshopifyDomain:stores.aristo}};
 for(const brand of ['fish','aristo']){
  await x.query("UPDATE subscribers SET attribs=jsonb_set(attribs,ARRAY[$1,'cart_id'],'\"gid://shopify/AbandonedCheckout/1\"')",[brand]);const ref=await x.capture(brand,id(brand==='fish'?131:132));
  const f=fixture(brand);f.data.node.createdAt=x.ref;f.data.node.updatedAt=x.ref;
  let purchased=false,calls=0,oversized=false;
  const api=createShopifySource({query:x.query,shops,request:async r=>{
   calls++;assert.equal(r.brand,brand);assert.equal(r.shop,stores[brand]);assert.equal(r.apiVersion,'2026-07');assert.ok(r.signal instanceof AbortSignal);
   const shop=shops[brand],customer={...f.data.node.customer,defaultEmailAddress:{emailAddress:'synthetic@example.invalid'}};
   if(r.document.includes('GraphCartRefresh'))return {status:200,body:{data:f.data,...(oversized?{extra:'界'.repeat(100000)}:{})}};
   if(r.document.includes('JourneyPurchaseIdentity'))return {status:200,body:{data:{shop,currentAppInstallation:{accessScopes:[{handle:'read_orders'},{handle:'read_customers'}]},node:{...f.data.node,customer}}}};
   return {status:200,body:{data:{shop,customer:{...customer,orders:{nodes:purchased?[{id:'gid://shopify/Order/4',createdAt:x.ref,customer:{id:customer.id}}]:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}};
  }});
  const unknown=await x.read(ref,brand,api);assert.equal(unknown.consent,true);assert.equal(unknown.facts['purchase.confirmed'],undefined);assert.equal(unknown.facts['cart.total'].value,'R$ 12,30');assert.equal(calls,3);
  purchased=true;const positive=await x.read(ref,brand,api);assert.equal(positive.facts['purchase.confirmed'].value,true);assert.equal(calls,6);
  oversized=true;await assert.rejects(x.read(ref,brand,api),{code:'GRAPH_SOURCE_REFRESH_UNCONFIRMED'});
 }
 assert.equal((await x.query('SELECT count(*)::int n FROM crm_graph_candidate.intent')).rows[0].n,0);
});
