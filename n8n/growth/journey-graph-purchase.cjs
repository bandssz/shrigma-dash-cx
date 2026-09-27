/* Server-only Shopify observation. No enrollment, writes, search by email, or
 * negative purchase fact. Transport, credentials, identity and clock are trusted
 * dependencies; none may be supplied by the editor or an HTTP request body. */
'use strict';
const {createHash}=require('node:crypto');
const VERSION='journey_purchase_observation_v1',API_VERSION='2026-07';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const gid=(value,type)=>typeof value==='string'&&new RegExp('^gid://shopify/'+type+'/[1-9][0-9]{0,24}$').test(value);
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const stamp=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return null;const canonical=value.includes('.')?value.replace(/\.(\d{1,3})Z$/,(_,n)=>'.'+n.padEnd(3,'0')+'Z'):value.replace(/Z$/,'.000Z');return iso(canonical)?canonical:null;};
const fail=code=>Object.assign(new Error(code),{code});
const email=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)?value.toLowerCase():null;
const clone=value=>JSON.parse(JSON.stringify(value));
const IDENTITY_QUERY=`query JourneyPurchaseIdentity($checkout: ID!) {
  shop { id myshopifyDomain }
  currentAppInstallation { accessScopes { handle } }
  node(id: $checkout) {
    ... on AbandonedCheckout {
      id createdAt completedAt
      customer { id defaultEmailAddress { emailAddress } }
    }
  }
}`;
const ORDERS_QUERY=`query JourneyCustomerOrders($customer: ID!, $first: Int!, $after: String) {
  shop { id myshopifyDomain }
  customer(id: $customer) {
    id defaultEmailAddress { emailAddress }
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      nodes { id createdAt customer { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function createPurchaseProvider({resolveIdentity,request,shops,clock=()=>new Date().toISOString(),timeoutMs=4000,pageSize=100,maxPages=5}={}){
 if(typeof resolveIdentity!=='function'||typeof request!=='function'||typeof clock!=='function'||!shops||typeof shops!=='object'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>4500||!Number.isInteger(pageSize)||pageSize<1||pageSize>100||!Number.isInteger(maxPages)||maxPages<1||maxPages>10)throw fail('GRAPH_PURCHASE_CONFIG');
 const stores={};
 for(const brand of ['fish','aristo'])if(shops[brand]){
  const s=shops[brand];if(!gid(s.id,'Shop')||typeof s.myshopifyDomain!=='string'||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s.myshopifyDomain))throw fail('GRAPH_PURCHASE_CONFIG');
  stores[brand]=Object.freeze({id:s.id,myshopifyDomain:s.myshopifyDomain});
 }
 if(!Object.keys(stores).length)throw fail('GRAPH_PURCHASE_CONFIG');
 return async function purchaseFor(input){
  if(!input||!UUID.test(input.source_ref||'')||!UUID.test(input.subject_id||'')||!stores[input.brand]||!iso(input.occurred_at)||!iso(input.now)||Date.parse(input.occurred_at)>Date.parse(input.now)||typeof input.query!=='function'||input.signal!==undefined&&!(input.signal instanceof AbortSignal))throw fail('GRAPH_PURCHASE_IDENTITY');
  const {source_ref,subject_id,brand,occurred_at,now,query}=input,store=stores[brand];
  const controller=new AbortController();let timer,lastClock=Date.parse(now),finished=false,abortCode='GRAPH_PURCHASE_ABORTED',onAbort;
  const abortOuter=()=>controller.abort();
  if(input.signal?.aborted)controller.abort();else input.signal?.addEventListener('abort',abortOuter,{once:true});
  const coverage={requested_from:occurred_at,decision_at:now,scan_started_at:null,scan_finished_at:null,pages:0,orders:0,access_window_days:null,access_window_covers_request:false,exhausted:false};
  const observe=()=>{const value=clock();if(!iso(value)||Date.parse(value)<lastClock||Date.parse(value)-Date.parse(now)>5000)throw fail('GRAPH_PURCHASE_CLOCK');lastClock=Date.parse(value);return value;};
  const result=(code,basis='unknown',extra={})=>({version:VERSION,source_ref,subject_id,brand,purchased:null,complete:false,basis,code,observed_at:coverage.scan_finished_at,query_complete:false,coverage:clone(coverage),...extra});
  const checkShop=data=>{if(data?.shop?.id!==store.id||data.shop.myshopifyDomain!==store.myshopifyDomain)throw fail('GRAPH_PURCHASE_SHOP');};
  const checkCustomer=(customer,expectedId,expectedEmail)=>{if(!customer||!gid(customer.id,'Customer')||(expectedId&&customer.id!==expectedId)||email(customer.defaultEmailAddress?.emailAddress)!==expectedEmail)throw fail('GRAPH_PURCHASE_CUSTOMER');return customer.id;};
  const ask=async(document,variables)=>{
   if(controller.signal.aborted)throw fail('GRAPH_PURCHASE_TIMEOUT');
   // A production transport must cap response bytes before parsing and use only
   // this fixed shop/API version with its server-selected n8n credential.
   const response=await request({brand,shop:store.myshopifyDomain,apiVersion:API_VERSION,document,variables,signal:controller.signal,maxResponseBytes:262144});
   if(controller.signal.aborted||finished)throw fail('GRAPH_PURCHASE_TIMEOUT');
   coverage.scan_finished_at=observe();
   if(response?.status!==200||!response.body||typeof response.body!=='object'||Array.isArray(response.body))throw fail('GRAPH_PURCHASE_HTTP');
   const body=response.body;
   if(Buffer.byteLength(JSON.stringify(body),'utf8')>262144)throw fail('GRAPH_PURCHASE_RESPONSE_LIMIT');
   if(body.errors!==undefined&&(!Array.isArray(body.errors)||body.errors.length))throw fail('GRAPH_PURCHASE_GRAPHQL');
   if(!body.data||typeof body.data!=='object')throw fail('GRAPH_PURCHASE_RESPONSE');
   checkShop(body.data);return body.data;
  };
  const positive=(basis,at,orderId)=>result('GRAPH_PURCHASE_CONFIRMED',basis,{purchased:true,complete:true,purchase_at:at,...(orderId?{order_ref_hash:createHash('sha256').update(store.id+'\n'+orderId).digest('hex')}:{})});
  const readIdentity=async()=>{
   if(controller.signal.aborted||finished)throw fail(abortCode);
   const identity=await resolveIdentity({source_ref,subject_id,brand,occurred_at,now,query,signal:controller.signal});
   if(controller.signal.aborted||finished)throw fail(abortCode);
   if(identity?.version!=='journey_shopify_identity_v1'||identity.source_ref!==source_ref||identity.subject_id!==subject_id||identity.brand!==brand||identity.occurred_at!==occurred_at||!gid(identity.checkout_id,'AbandonedCheckout')||!email(identity.email))throw fail('GRAPH_PURCHASE_IDENTITY');
   return {checkout_id:identity.checkout_id,email:email(identity.email)};
  };
  let initialIdentity;
  const run=async()=>{
   coverage.scan_started_at=observe();
   const identity=initialIdentity=await readIdentity();
   const expectedEmail=email(identity.email),first=await ask(IDENTITY_QUERY,{checkout:identity.checkout_id});
   const checkout=first.node;
   if(checkout?.id!==identity.checkout_id||stamp(checkout.createdAt)!==occurred_at)throw fail('GRAPH_PURCHASE_CHECKOUT');
   const customerId=checkCustomer(checkout.customer,null,expectedEmail);
   const handles=first.currentAppInstallation?.accessScopes;
   if(!Array.isArray(handles)||handles.some(x=>typeof x?.handle!=='string'))throw fail('GRAPH_PURCHASE_SCOPES');
   const scopes=new Set(handles.map(x=>x.handle));
   if(!scopes.has('read_orders')&&!scopes.has('write_orders'))throw fail('GRAPH_PURCHASE_SCOPES');
   coverage.access_window_days=scopes.has('read_all_orders')?null:60;
   // One-day margin avoids claiming a boundary at Shopify's rolling 60 days.
   coverage.access_window_covers_request=scopes.has('read_all_orders')||Date.parse(occurred_at)>Date.parse(coverage.scan_finished_at)-59*86400000;
   if(checkout.completedAt!==null){const at=stamp(checkout.completedAt);if(!at||Date.parse(at)<Date.parse(occurred_at)||Date.parse(at)>lastClock)throw fail('GRAPH_PURCHASE_CHECKOUT');return positive('checkout_completed',at);}
   if(!scopes.has('read_customers')&&!scopes.has('write_customers'))throw fail('GRAPH_PURCHASE_SCOPES');
   let after=null,previousTime=Infinity;const cursors=new Set(),ids=new Set();
   for(let page=0;page<maxPages;page++){
    const data=await ask(ORDERS_QUERY,{customer:customerId,first:pageSize,after});
    checkCustomer(data.customer,customerId,expectedEmail);
    const connection=data.customer.orders,info=connection?.pageInfo,nodes=connection?.nodes;
    if(!Array.isArray(nodes)||nodes.length>pageSize||typeof info?.hasNextPage!=='boolean'||!(info.endCursor===null||typeof info.endCursor==='string'&&info.endCursor.length>0&&info.endCursor.length<=2048)||info.hasNextPage&&(!nodes.length||!info.endCursor))throw fail('GRAPH_PURCHASE_PAGE');
    coverage.pages++;coverage.orders+=nodes.length;
    let found=null;
    for(const order of nodes){
     const at=stamp(order?.createdAt),time=Date.parse(at);
     if(!gid(order?.id,'Order')||ids.has(order.id)||!at||time>lastClock||time>previousTime||order.customer?.id!==customerId)throw fail('GRAPH_PURCHASE_ORDER');
     ids.add(order.id);previousTime=time;
     if(time>=Date.parse(occurred_at)&&!found)found={at,id:order.id};
    }
    if(found)return positive('customer_order',found.at,found.id);
    coverage.exhausted=!info.hasNextPage;
    if(!info.hasNextPage){
     if(!coverage.access_window_covers_request)return result('GRAPH_PURCHASE_HISTORY_UNAVAILABLE');
     // Exhaustion of an observed connection is not a causal high-water mark.
     // It also cannot exclude a purchase using another/unassociated customer.
     return result('GRAPH_PURCHASE_ABSENCE_NOT_AUTHORITATIVE','absence_observed',{query_complete:true});
    }
    if(cursors.has(info.endCursor))throw fail('GRAPH_PURCHASE_CURSOR');
    cursors.add(info.endCursor);after=info.endCursor;
   }
   return result('GRAPH_PURCHASE_PAGE_LIMIT');
  };
  try{
   const abort=new Promise((_,reject)=>{onAbort=()=>reject(fail(abortCode));if(controller.signal.aborted)onAbort();else controller.signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>{abortCode='GRAPH_PURCHASE_TIMEOUT';controller.abort();},timeoutMs);});
   return await Promise.race([(async()=>{const r=await run();if(r.complete||r.query_complete){const identity=await readIdentity();observe();if(identity.checkout_id!==initialIdentity.checkout_id||identity.email!==initialIdentity.email)throw fail('GRAPH_PURCHASE_IDENTITY_CHANGED');}return r;})(),abort]);
  }catch(e){return result(/^GRAPH_PURCHASE_[A-Z_]+$/.test(e?.code||'')?e.code:'GRAPH_PURCHASE_UNCONFIRMED');}
  finally{finished=true;clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);input.signal?.removeEventListener('abort',abortOuter);controller.abort();}
 };
}
module.exports={VERSION,API_VERSION,ENABLED:false,IDENTITY_QUERY,ORDERS_QUERY,createPurchaseProvider};
