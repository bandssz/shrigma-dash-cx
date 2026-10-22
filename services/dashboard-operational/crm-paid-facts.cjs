'use strict';
// Paid purchases. Existing order PK handles repeated deliveries; no send path.
const fs=require('node:fs'),crypto=require('node:crypto');
const {verifyPaidOrder}=require('./shopify-paid-order.cjs');
const BRANDS=['aristo','fish'],SHOPS={aristo:'gwx20u-vw.myshopify.com',fish:'c0kfm1-qt.myshopify.com'};
const QA=new Set(['editor-qa-aristo@shrigma.com.br','editor-qa-fish@shrigma.com.br']);
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const canUse=user=>user?.role==='superadmin'||require('./crm-ui-features.cjs').restrictedUser(user)||QA.has(user?.email);
const ORDER_FIELDS='id test createdAt updatedAt cancelledAt displayFinancialStatus currencyCode currentTotalPriceSet { shopMoney { amount currencyCode } } customer { id } lineItems(first:10) { nodes { id title quantity product { id } variant { id } } pageInfo { hasNextPage endCursor } }';
const ORDERS_QUERY='query PaidFactsOrders($after:String,$filter:String!){ shop { myshopifyDomain } orders(first:25,after:$after,query:$filter,sortKey:CREATED_AT) { nodes { '+ORDER_FIELDS+' } pageInfo { hasNextPage endCursor } } }';
const ITEMS_QUERY='query PaidFactsItems($id:ID!,$after:String){ order(id:$id){ id lineItems(first:100,after:$after){ nodes { id title quantity product { id } variant { id } } pageInfo { hasNextPage endCursor } } } }';
const WEBHOOKS_QUERY='query PaidFactsWebhooks($after:String){ webhookSubscriptions(first:100,after:$after,topics:[ORDERS_PAID]) { nodes { id topic uri } pageInfo { hasNextPage endCursor } } }';
const WEBHOOK_CREATE='mutation PaidFactsSubscribe($input:WebhookSubscriptionInput!){ webhookSubscriptionCreate(topic:ORDERS_PAID,webhookSubscription:$input){ webhookSubscription { id topic uri } userErrors { field message } } }';
const WEBHOOK_DELETE='mutation PaidFactsUnsubscribe($id:ID!){ webhookSubscriptionDelete(id:$id){ deletedWebhookSubscriptionId userErrors { field message } } }';
// A fact-only row has no attribution observation. Its true dates live in paid_fact;
// an attribution collection already in flight must still be able to fill payload.
const PURCHASE_ADVANCES=`crm_attribution_order_v2.paid_fact IS NULL OR
 crm_attribution_order_v2.paid_fact->>'sourceUpdatedAt'<EXCLUDED.paid_fact->>'sourceUpdatedAt' OR
 (crm_attribution_order_v2.paid_fact->>'sourceUpdatedAt'=EXCLUDED.paid_fact->>'sourceUpdatedAt' AND (
 (EXCLUDED.paid_fact->>'financialStatus' IN ('cancelled','refunded','partially_refunded','voided') AND
 crm_attribution_order_v2.paid_fact->>'financialStatus' NOT IN ('cancelled','refunded','partially_refunded','voided')) OR
 (EXCLUDED.paid_fact->>'financialStatus'='paid' AND
 crm_attribution_order_v2.paid_fact->>'financialStatus' IN ('pending','authorized','partially_paid'))))`;
const ACQUISITION_MERGE=`CASE
 WHEN jsonb_typeof(crm_attribution_order_v2.paid_fact->'acquisition')='object' AND
  (crm_attribution_order_v2.paid_fact->'acquisition'->'journey'->>'complete'='true' OR jsonb_typeof(EXCLUDED.paid_fact->'acquisition') IS DISTINCT FROM 'object')
 THEN jsonb_build_object('acquisition',(crm_attribution_order_v2.paid_fact->'acquisition') ||
  CASE WHEN EXCLUDED.paid_fact->'acquisition' ? 'webhook' THEN jsonb_build_object('webhook',EXCLUDED.paid_fact->'acquisition'->'webhook') ELSE '{}'::jsonb END)
 WHEN jsonb_typeof(EXCLUDED.paid_fact->'acquisition')='object' THEN jsonb_build_object('acquisition',EXCLUDED.paid_fact->'acquisition')
 ELSE '{}'::jsonb END`;
const UPSERT=`INSERT INTO public.crm_attribution_order_v2(brand,order_id,payload,source_updated_at,checked_at,paid_fact)
 VALUES($1,$2,'{}'::jsonb,'-infinity'::timestamptz,'-infinity'::timestamptz,$3::jsonb)
 ON CONFLICT(brand,order_id) DO UPDATE SET paid_fact=
 (CASE WHEN ${PURCHASE_ADVANCES} THEN EXCLUDED.paid_fact ELSE crm_attribution_order_v2.paid_fact END) || ${ACQUISITION_MERGE}
 WHERE ${PURCHASE_ADVANCES} OR
 (crm_attribution_order_v2.paid_fact->>'sourceUpdatedAt'=EXCLUDED.paid_fact->>'sourceUpdatedAt' AND
 jsonb_typeof(EXCLUDED.paid_fact->'acquisition')='object' AND
 (crm_attribution_order_v2.paid_fact->'acquisition' IS NULL OR
 coalesce(crm_attribution_order_v2.paid_fact->'acquisition'->'webhook'->>'observedAt','')<coalesce(EXCLUDED.paid_fact->'acquisition'->'webhook'->>'observedAt','')))
 RETURNING brand,order_id,paid_fact->>'observedAt' AS observed_at`;
function configuration(file){
 if(typeof file!=='string'||!file.startsWith('/'))fail('PAID_FACTS_CONFIG_UNAVAILABLE',503);
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let raw;
 try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>4096||(st.mode&0o077))fail('PAID_FACTS_CONFIG_UNAVAILABLE',503);raw=JSON.parse(fs.readFileSync(fd));}finally{fs.closeSync(fd);}
 const shops={},brands={};for(const brand of BRANDS){const prefix='CRM_SHOPIFY_'+brand.toUpperCase()+'_',clientId=raw[prefix+'CLIENT_ID'],secret=raw[prefix+'CLIENT_SECRET'];if(typeof clientId!=='string'||typeof secret!=='string'||!clientId||!secret)fail('PAID_FACTS_CONFIG_UNAVAILABLE',503);brands[brand]={shop:SHOPS[brand],clientId,secret};shops[SHOPS[brand]]={brand,secret};}
 if(typeof raw.PGPASSWORD!=='string'||!raw.PGPASSWORD)fail('PAID_FACTS_CONFIG_UNAVAILABLE',503);
 return {shops,brands,pg:{host:'comunicacao_postgres',port:5432,database:'listmonk',user:'crm_shopify_sync',password:raw.PGPASSWORD}};
}
function fromGraphql(brand,o,observedAt,currentState=false){
 const paid=o?.cancelledAt===null&&o?.displayFinancialStatus==='PAID';
 if(!o||(!currentState&&!paid)||(paid&&o.lineItems?.pageInfo?.hasNextPage))fail('PAID_ORDER_INCOMPLETE',409);
 const decimal=o.currentTotalPriceSet?.shopMoney?.amount;
 if(typeof decimal!=='string'||!/^\d{1,12}(?:\.\d{1,2})?$/.test(decimal))fail('PAID_ORDER_INCOMPLETE',409);
 const total=decimal.includes('.')?decimal.padEnd(decimal.indexOf('.')+3,'0'):decimal+'.00';
 return {schema:'crm-shopify-paid-order-fact-v1',brand,orderId:o.id,customerId:o.customer?.id||null,createdAt:new Date(o.createdAt).toISOString(),sourceUpdatedAt:new Date(o.updatedAt).toISOString(),observedAt,currency:o.currencyCode,total,financialStatus:paid?'paid':o.cancelledAt?'cancelled':String(o.displayFinancialStatus).toLowerCase(),test:o.test,products:o.lineItems.nodes.map(p=>({itemId:p.id,productId:p.product?.id||null,variantId:p.variant?.id||null,title:p.title,quantity:p.quantity})),deliveryId:null,orderKey:brand+':'+o.id};
}
function period(days,now=Date.now()){
 if(!Number.isInteger(days)||days<1||days>365)fail('PAID_PUBLIC_DAYS_INVALID');
 return {from:new Date(now-days*86400000).toISOString(),until:new Date(now).toISOString(),days};
}
function rule(body,now){
 if(!body||!['bought_recently','not_bought_recently','bought_product'].includes(body.kind))fail('PAID_PUBLIC_RULE_INVALID');
 const p=period(body.days,now);if(body.kind==='bought_product'&&!/^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/.test(body.productId||''))fail('PAID_PUBLIC_PRODUCT_INVALID');
 return {kind:body.kind,...p,...(body.kind==='bought_product'?{productId:body.productId}:{})};
}
const audienceSql=kind=>`WITH buyers AS (SELECT DISTINCT paid_fact->>'customerId' customer_id FROM public.crm_attribution_order_v2 WHERE brand=$1 AND paid_fact->>'financialStatus'='paid' AND (paid_fact->>'createdAt')>=$2 AND (paid_fact->>'createdAt')<$3 AND ($5::boolean OR paid_fact->>'test'='false') AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(paid_fact->'products') p WHERE p->>'productId'=$4)))
 SELECT count(DISTINCT s.id)::int count FROM crm_audience_v2.shopify_identity i JOIN public.subscribers s ON s.id=i.subscriber_id AND s.uuid=i.subscriber_uuid JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id AND sl.list_id=$6 JOIN public.lists l ON l.id=sl.list_id
 WHERE i.brand=$1 AND s.status='enabled' AND sl.status<>'unsubscribed' AND (l.optin='single' OR sl.status='confirmed') AND l.status='active' AND
 ${kind==='not_bought_recently'?'(i.customer_gid IS NULL OR i.customer_gid NOT IN (SELECT customer_id FROM buyers WHERE customer_id IS NOT NULL))':'EXISTS(SELECT 1 FROM buyers b WHERE b.customer_id=i.customer_gid)'}`;
async function streamBackfill(res,work){
 res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
 const write=value=>{if(!res.destroyed&&!res.writableEnded)res.write(JSON.stringify(value)+'\n');};
 try{const result=await work(value=>write({type:'progress',...value}));write({type:'complete',...result});}
 catch(e){write({type:'error',error:/^PAID_[A-Z0-9_]+$/.test(e.code||'')?e.code:'PAID_FACTS_UPDATE_UNCONFIRMED'});}
 if(!res.destroyed)res.end();
}
function create({file,auth,store,fetchImpl=fetch,clientFactory,now=Date.now,backupDirectory}){
 const tokens=new Map();let config;
 const cfg=()=>config||=(configuration(file));
 const authorize=(context,brand,write=false,workspace=false)=>{if(!BRANDS.includes(brand))fail('PAID_FACTS_BRAND_INVALID');const user=auth.authorizeBrand({...context,area:'growth',productFront:'growth',edit:false},brand);if(!workspace&&!canUse(user))fail('RESTRICTED_AREA_REQUIRED',403);if(write&&(user.permissions?.growth?.edit!==true||user.role!=='superadmin'&&!user.productWriteFronts?.includes('growth')))fail('PRODUCT_WRITE_DENIED',403);return user;};
 const authorizeAnalysis=(context,brand)=>{const user=authorize(context,brand,false,true);if(!canUse(user)&&(user.permissions?.growth?.edit!==true||!user.productWriteFronts?.includes('growth')))fail('ANALYSIS_EDITOR_REQUIRED',403);return user;};
 const analysisAuthorize=(context,brand,write=false)=>write?authorize(context,brand,true):authorizeAnalysis(context,brand);
 async function database(work,write=false){
  let client;try{
   const settings={...cfg().pg,application_name:'shrigma-paid-facts',connectionTimeoutMillis:3000,query_timeout:20000,statement_timeout:15000};
   if(clientFactory)client=clientFactory(settings);else{const manifest=JSON.parse(fs.readFileSync('/app/native-backend/manifest.json'));const {Client}=require('./native-pg-driver.cjs').loadPGDriver(manifest.pgDriverManifestSha256);client=new Client(settings);}
   await client.connect();await client.query(write?"BEGIN; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='500ms'":"BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout='15s'");const result=await work(client);await client.query(write?'COMMIT':'ROLLBACK');return result;
  }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});if(e.code&&/^[0-9A-Z]{5}$/.test(e.code))fail('PAID_FACTS_DATABASE_UNAVAILABLE',503);throw e;}finally{if(client)await client.end().catch(()=>{});}
 }
 async function token(brand){
  const cached=tokens.get(brand);if(cached&&cached.until>now()+60000)return cached;
  const c=cfg().brands[brand],r=await fetchImpl('https://'+c.shop+'/admin/oauth/access_token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:c.clientId,client_secret:c.secret})});
  if(r.status!==200)fail('PAID_FACTS_SHOPIFY_AUTH_UNAVAILABLE',503);const v=await r.json();if(typeof v.access_token!=='string'||!Number.isFinite(v.expires_in))fail('PAID_FACTS_SHOPIFY_AUTH_UNAVAILABLE',503);
  const value={value:v.access_token,until:now()+v.expires_in*1000,scopes:String(v.scope||'').split(/[ ,]+/)};tokens.set(brand,value);return value;
 }
 async function graphql(brand,query,variables,{withCost=false}={}){
  const c=cfg().brands[brand],t=await token(brand),r=await fetchImpl('https://'+c.shop+'/admin/api/2026-10/graphql.json',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','X-Shopify-Access-Token':t.value},body:JSON.stringify({query,variables})});
  if(r.status!==200)fail('PAID_FACTS_SHOPIFY_UNAVAILABLE',503);const text=await r.text();if(text.length>4*1024*1024)fail('PAID_FACTS_SHOPIFY_RESPONSE_TOO_LARGE',503);const v=JSON.parse(text);if(v.errors?.length&&!withCost)fail('PAID_FACTS_SHOPIFY_QUERY_REFUSED',503);return withCost?v:v.data;
 }
 async function ingest(rawBody,headers){const fact=verifyPaidOrder({rawBody,headers,shops:cfg().shops,receivedAt:new Date(now()).toISOString()});const changed=await database(async c=>(await c.query(UPSERT,[fact.brand,fact.orderId,JSON.stringify(fact)])).rowCount,true);return {ok:true,brand:fact.brand,orderId:fact.orderId,stored:changed===1};}
 async function status(context,brand){authorize(context,brand);return database(async c=>{
  const r=await c.query("SELECT count(*)::int facts,max(paid_fact->>'observedAt') latest,count(*) FILTER(WHERE paid_fact->>'test'='true')::int tests FROM public.crm_attribution_order_v2 WHERE brand=$1 AND paid_fact IS NOT NULL",[brand]);
  return {brand,...r.rows[0],coverage:store.coverage(brand),publics:store.list(brand),checkedAt:new Date(now()).toISOString()};
 });}
 function publics(context,brand,workspace=false){authorize(context,brand,false,workspace);return {brand,coverage:store.coverage(brand),publics:store.list(brand),checkedAt:new Date(now()).toISOString()};}
 async function products(context,brand,workspace=false){authorize(context,brand,false,workspace);return database(async c=>(await c.query("SELECT DISTINCT p->>'productId' id,p->>'title' title FROM public.crm_attribution_order_v2 o CROSS JOIN LATERAL jsonb_array_elements(o.paid_fact->'products') p WHERE o.brand=$1 AND p->>'productId' IS NOT NULL ORDER BY title LIMIT 1000",[brand])).rows);}
 async function count(context,brand,input,workspace=false){authorize(context,brand,false,workspace);const coverage=store.coverage(brand),q=rule(input,coverage?Date.parse(coverage.until):now()),covered=coverage&&coverage.from<=q.from&&coverage.until>=q.until&&now()-Date.parse(coverage.until)<30*60000;
  if(!covered)return {brand,rule:q,confirmed:false,count:null,reason:'Atualize os pedidos para contar este período.'};
  const test=input.includeTests===true;
  const result=await database(async c=>{
   const r=await c.query(audienceSql(q.kind),[brand,q.from,q.until,q.productId||null,test,brand==='aristo'?16:17]);return r.rows[0].count;
  });return {brand,rule:q,confirmed:true,count:result,checkedAt:new Date(now()).toISOString(),coverage};
 }
 async function save(context,brand,input,workspace=false){const user=authorize(context,brand,true,workspace),q=rule(input,now());if(typeof input.name!=='string'||input.name.trim().length<3||input.name.length>120)fail('PAID_PUBLIC_NAME_INVALID');return store.save({id:input.id,brand,owner:user.id,name:input.name.trim(),rule:{kind:q.kind,days:q.days,...(q.productId?{productId:q.productId}:{})}});}
 async function backfill(context,brand,days,{onProgress=()=>{},workspace=false}={}){authorize(context,brand,true,workspace);const p=period(days,now()),t=await token(brand);if(days>60&&!t.scopes.includes('read_all_orders'))fail('PAID_FACTS_HISTORY_SCOPE_REQUIRED',403);const filter='created_at:>='+JSON.stringify(p.from)+' created_at:<'+JSON.stringify(p.until);let after=null,pages=0,read=0,buyers=new Set();authorize(context,brand,true,workspace);store.setCoverage(brand,null);onProgress({brand,...p,pages,orders:read});
  do{const data=await graphql(brand,ORDERS_QUERY,{after,filter});if(data.shop?.myshopifyDomain!==SHOPS[brand])fail('PAID_FACTS_SHOP_MISMATCH',503);const page=data.orders;if(!page||!Array.isArray(page.nodes))fail('PAID_FACTS_SHOPIFY_UNAVAILABLE',503);
   for(const order of page.nodes.filter(o=>o.displayFinancialStatus==='PAID'&&o.cancelledAt===null)){let itemPages=0;while(order.lineItems.pageInfo.hasNextPage){const cursor=order.lineItems.pageInfo.endCursor;if(!cursor||++itemPages>50)fail('PAID_ORDER_INCOMPLETE',409);const next=(await graphql(brand,ITEMS_QUERY,{id:order.id,after:cursor})).order;if(!next||next.id!==order.id)fail('PAID_ORDER_INCOMPLETE',409);order.lineItems.nodes.push(...next.lineItems.nodes);order.lineItems.pageInfo=next.lineItems.pageInfo;}}
   const observedAt=new Date(now()).toISOString(),facts=page.nodes.map(o=>fromGraphql(brand,o,observedAt,true));await database(async c=>{authorize(context,brand,true,workspace);for(const f of facts)await c.query(UPSERT,[brand,f.orderId,JSON.stringify(f)]);authorize(context,brand,true,workspace);},true);read+=page.nodes.length;for(const f of facts){if(f.financialStatus==='paid'&&!f.test&&f.customerId)buyers.add(f.customerId);}pages++;if(pages>4000)fail('PAID_FACTS_SHOPIFY_RANGE_TOO_LARGE',409);if(page.pageInfo?.hasNextPage&&!page.pageInfo.endCursor)fail('PAID_FACTS_SHOPIFY_PAGINATION_INCOMPLETE',503);after=page.pageInfo.hasNextPage?page.pageInfo.endCursor:null;onProgress({brand,...p,pages,orders:read});
  }while(after);
  const eligible=await database(async c=>(await c.query("SELECT count(DISTINCT s.id)::int count FROM crm_audience_v2.shopify_identity i JOIN public.subscribers s ON s.id=i.subscriber_id AND s.uuid=i.subscriber_uuid JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id AND sl.list_id=$2 JOIN public.lists l ON l.id=sl.list_id WHERE i.brand=$1 AND i.customer_gid=ANY($3::text[]) AND s.status='enabled' AND sl.status<>'unsubscribed' AND (l.optin='single' OR sl.status='confirmed') AND l.status='active'",[brand,brand==='aristo'?16:17,[...buyers]])).rows[0].count);
  const coverage={...p,checkedAt:new Date(now()).toISOString(),pages,orders:read,shopifyDistinctBuyers:buyers.size,shopifyEligibleBuyers:eligible};authorize(context,brand,true,workspace);store.setCoverage(brand,coverage);return {ok:true,brand,coverage};
 }
 async function subscriptions(context,brand){authorize(context,brand);const rows=[];let after=null;do{const d=await graphql(brand,WEBHOOKS_QUERY,{after}),v=d.webhookSubscriptions;rows.push(...v.nodes);after=v.pageInfo.hasNextPage?v.pageInfo.endCursor:null;if(rows.length>500)fail('PAID_FACTS_SUBSCRIPTIONS_UNAVAILABLE',503);}while(after);return rows;}
 async function subscribe(context,brand){authorize(context,brand,true);const uri='https://crm.shrigma.com.br/webhooks/shopify/orders-paid',existing=await subscriptions(context,brand),same=existing.filter(x=>x.uri===uri);if(same.length)return {brand,existing:true,subscriptions:same};const d=await graphql(brand,WEBHOOK_CREATE,{input:{uri,format:'JSON'}}),r=d.webhookSubscriptionCreate;if(r.userErrors?.length||!r.webhookSubscription)fail('PAID_FACTS_SUBSCRIPTION_REFUSED',409);return {brand,existing:false,subscription:r.webhookSubscription};}
 const origin=require('./crm-paid-acquisition-service.cjs').create({authorize:analysisAuthorize,database,graphql:(brand,q,v)=>require('./crm-paid-acquisition.cjs').pacedRead(()=>graphql(brand,q,v,{withCost:true})),now,openBackup:brand=>require('./crm-paid-acquisition-backup.cjs').open(backupDirectory,brand)});
 const acquisitionBackup=async(context,brand,input)=>{authorize(context,brand);const result=await require('./crm-paid-acquisition-backup.cjs').read(backupDirectory,brand,input.name,input.offset??0);authorize(context,brand);return result;};
 const acquisitionBackupFile=(context,brand,input)=>require('./crm-paid-acquisition-backup.cjs').file(backupDirectory,brand,input.name,()=>authorize(context,brand));
 const results=require('./crm-paid-results.cjs').create({authorize:analysisAuthorize,database,now,coverage:brand=>store.coverage(brand)});
 return {ingest,status,publics,products,count,save,backfill,subscribe,subscriptions,authorize,authorizeAnalysis,acquisitionBackup,acquisitionBackupFile,...origin,...results};
}
module.exports={create,streamBackfill,canUse,fromGraphql,period,rule,audienceSql,UPSERT,ORDERS_QUERY,ITEMS_QUERY,WEBHOOKS_QUERY,WEBHOOK_CREATE,WEBHOOK_DELETE};
