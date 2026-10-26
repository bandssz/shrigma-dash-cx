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
const UPDATED_ORDERS_QUERY=ORDERS_QUERY.replace('sortKey:CREATED_AT','sortKey:UPDATED_AT');
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

// Counts are observed distinct people in the admitted event source, never Delivery.
function engagementCount(value,{brand,id,uuid,from,to,kind}){
 const integer=n=>Number.isSafeInteger(n)&&n>=0;
 if(!value||value.schema!=='infra-behavior-native-counts-v2'||value.kind!==kind||value.brand!==brand||value.campaignId!==id||value.campaignUuid!==uuid||value.from!==from||value.to!==to||value.validInput!==true||value.campaignMatched!==true||value.status!=='observed'||!integer(value.nativeUniqueSubscribers)||!integer(value.nativeEventRows)||value.nativeEventRows<value.nativeUniqueSubscribers||value.nullSubscriberEventRows!==0||value.nonpositiveSubscriberEventRows!==0||value.unresolvedUniqueSubscribers!==0)return null;
 return value.nativeUniqueSubscribers;
}

// Brand ownership is confirmed by the original scoped native reader, including historical shared senders.
const ENGAGEMENT_PAGE_SQL="WITH input AS MATERIALIZED (\n SELECT $1::text brand,p.id campaign_id,p.uuid::uuid campaign_uuid,p.from_text,p.native_brand_confirmed,$3::text to_text,p.from_text::timestamptz window_from,$3::timestamptz window_to\n FROM jsonb_to_recordset($2::jsonb) AS p(id integer,uuid text,from_text text,native_brand_confirmed boolean)\n), valid AS MATERIALIZED (\n SELECT * FROM input WHERE native_brand_confirmed IS TRUE AND brand IN ('aristo','fish') AND campaign_id>0 AND window_from<window_to AND window_to<=statement_timestamp()\n), campaign_scope AS MATERIALIZED (\n SELECT p.* FROM valid p JOIN public.campaigns c ON c.id=p.campaign_id AND c.uuid=p.campaign_uuid\n), events AS MATERIALIZED (\n SELECT c.campaign_id,'open'::text kind,e.subscriber_id FROM campaign_scope c JOIN public.campaign_views e ON e.campaign_id=c.campaign_id WHERE e.created_at>=c.window_from AND e.created_at<c.window_to\n UNION ALL\n SELECT c.campaign_id,'click'::text kind,e.subscriber_id FROM campaign_scope c JOIN public.link_clicks e ON e.campaign_id=c.campaign_id WHERE e.created_at>=c.window_from AND e.created_at<c.window_to\n), counted AS MATERIALIZED (\n SELECT e.campaign_id,e.kind,count(*)::int event_rows,count(DISTINCT e.subscriber_id) FILTER(WHERE e.subscriber_id>0)::int people,\n count(*) FILTER(WHERE e.subscriber_id IS NULL)::int nulls,count(*) FILTER(WHERE e.subscriber_id<=0)::int nonpositive,\n count(DISTINCT e.subscriber_id) FILTER(WHERE e.subscriber_id>0 AND s.id IS NULL)::int unresolved\n FROM events e LEFT JOIN public.subscribers s ON s.id=e.subscriber_id GROUP BY e.campaign_id,e.kind\n)\nSELECT jsonb_build_object('schema','crm-native-campaign-page-counts-v1','kind',k.kind,'brand',p.brand,'campaignId',p.campaign_id,'campaignUuid',p.campaign_uuid,\n 'from',p.from_text,'to',p.to_text,'validInput',v.campaign_id IS NOT NULL,'campaignMatched',c.campaign_id IS NOT NULL,\n 'status',CASE WHEN c.campaign_id IS NULL THEN 'campaign_scope_unconfirmed' ELSE 'observed' END,\n 'nativeUniqueSubscribers',coalesce(n.people,0),'nativeEventRows',coalesce(n.event_rows,0),'nullSubscriberEventRows',coalesce(n.nulls,0),\n 'nonpositiveSubscriberEventRows',coalesce(n.nonpositive,0),'unresolvedUniqueSubscribers',coalesce(n.unresolved,0)) behavior_counts\nFROM input p CROSS JOIN (VALUES('open'),('click')) k(kind) LEFT JOIN valid v USING(campaign_id)\nLEFT JOIN campaign_scope c USING(campaign_id) LEFT JOIN counted n ON n.campaign_id=p.campaign_id AND n.kind=k.kind";
function pageCount(v,p){
 if(v?.schema!=='crm-native-campaign-page-counts-v1'||v.brand!==p.brand||v.campaignId!==p.id||v.campaignUuid!==p.uuid||v.from!==p.from||v.to!==p.to||v.kind!==p.kind||v.validInput!==true||v.campaignMatched!==true||v.status!=='observed')return null;
 for(const key of ['nativeUniqueSubscribers','nativeEventRows','nullSubscriberEventRows','nonpositiveSubscriberEventRows','unresolvedUniqueSubscribers'])if(!Number.isSafeInteger(v[key])||v[key]<0)return null;
 if(v.nativeUniqueSubscribers>v.nativeEventRows-v.nullSubscriberEventRows-v.nonpositiveSubscriberEventRows||v.unresolvedUniqueSubscribers>v.nativeUniqueSubscribers)return null;
 return v.nativeUniqueSubscribers;
}

function create({file,auth,store,fetchImpl=fetch,clientFactory,now=Date.now,backupDirectory,queueDatabase,sourceRevision,refreshQueue,campaignReader}){
 const tokens=new Map();let config;
 const cfg=()=>config||=(configuration(file));
 const authorize=(context,brand,write=false,workspace=false)=>{if(!BRANDS.includes(brand))fail('PAID_FACTS_BRAND_INVALID');const user=auth.authorizeBrand({...context,area:'growth',productFront:'growth',edit:false},brand);if(!workspace&&!canUse(user))fail('RESTRICTED_AREA_REQUIRED',403);if(write&&(user.permissions?.growth?.edit!==true||user.role!=='superadmin'&&!user.productWriteFronts?.includes('growth')))fail('PRODUCT_WRITE_DENIED',403);return user;};
 const authorizeAnalysis=(context,brand)=>{const user=authorize(context,brand,false,true);if(!canUse(user)&&(user.permissions?.growth?.edit!==true||!user.productWriteFronts?.includes('growth')))fail('ANALYSIS_EDITOR_REQUIRED',403);return user;};
 const analysisAuthorize=(context,brand,write=false)=>write?authorize(context,brand,true):authorizeAnalysis(context,brand);
 async function database(work,write=false,repeatable=false){
  let client;try{
   const settings={...cfg().pg,application_name:'shrigma-paid-facts',connectionTimeoutMillis:3000,query_timeout:20000,statement_timeout:15000};
   if(clientFactory)client=clientFactory(settings);else{const manifest=JSON.parse(fs.readFileSync('/app/native-backend/manifest.json'));const {Client}=require('./native-pg-driver.cjs').loadPGDriver(manifest.pgDriverManifestSha256);client=new Client(settings);}
   await client.connect();await client.query(write?"BEGIN; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='500ms'":repeatable?"BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='15s'":"BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout='15s'");const result=await work(client);await client.query(write?'COMMIT':'ROLLBACK');return result;
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
 async function paidRead(brand,query,variables){try{return await require('./crm-paid-acquisition.cjs').pacedRead(()=>graphql(brand,query,variables,{withCost:true}));}catch(e){if(e.code==='PAID_ACQUISITION_SOURCE_UNAVAILABLE')fail('PAID_FACTS_SHOPIFY_QUERY_REFUSED',503);throw e;}}
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

 const sourceRefresh=refreshQueue||require('./source-refresh-queue.cjs').create({database:queueDatabase,sourceRevision,now});
 async function freshSource(context,brand,days,workspace=false,force=false){
  authorize(context,brand,true,workspace);const c=store.coverage(brand);
  if(!force&&c&&c.days>=days&&now()-Date.parse(c.until)<=60000)return c;
  await backfill(context,brand,Math.max(30,days),{workspace});return store.coverage(brand);
 }
 function savedDefinition(context,brand,id,workspace=false){
  authorize(context,brand,false,workspace);if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))fail('PAID_PUBLIC_NOT_FOUND',404);
  const p=store.list(brand).find(p=>p.id===id);if(!p)fail('PAID_PUBLIC_NOT_FOUND',404);
  const definition={kind:p.rule.kind,days:p.rule.days,...(p.rule.productId?{productId:p.rule.productId}:{})};
  return {source:'paid',id:p.id,name:p.name,revision:p.updatedAt,definition,definitionHash:crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex'),baseListId:brand==='aristo'?16:17};
 }
 async function resolveSaved(context,brand,id,{workspace=false,refresh=true,forceRefresh=false}={}){
  const binding=savedDefinition(context,brand,id,workspace);if(refresh)await freshSource(context,brand,binding.definition.days,workspace,forceRefresh);
  const coverage=store.coverage(brand),q=rule(binding.definition,coverage?Date.parse(coverage.until):now());if(!coverage||coverage.from>q.from||coverage.until<q.until||now()-Date.parse(coverage.until)>=30*60000)fail('PAID_PUBLIC_SOURCE_UNCONFIRMED',409);
  const coverageHash=crypto.createHash('sha256').update(JSON.stringify(coverage)).digest('hex'),sql=audienceSql(q.kind).replace('SELECT count(DISTINCT s.id)::int count FROM','SELECT DISTINCT s.id FROM')+' ORDER BY s.id LIMIT 100001';
  const ids=await database(async c=>(await c.query(sql,[brand,q.from,q.until,q.productId||null,false,binding.baseListId])).rows.map(r=>r.id));
  if(ids.length>100000)fail('PAID_AUDIENCE_PAGE_REQUIRED',409);
  authorize(context,brand,false,workspace);const after=savedDefinition(context,brand,id,workspace);if(binding.revision!==after.revision||binding.definitionHash!==after.definitionHash)fail('PAID_PUBLIC_VERSION_CHANGED',409);
  if(coverageHash!==crypto.createHash('sha256').update(JSON.stringify(store.coverage(brand))).digest('hex'))fail('PAID_PUBLIC_SOURCE_CHANGED',409);
  return {binding,count:ids.length,recipientIds:ids,recipientHash:crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex'),checkedAt:new Date(now()).toISOString(),coverage};
 }
 async function countSaved(context,brand,input,workspace=false){
  const r=await resolveSaved(context,brand,input.id,{workspace,forceRefresh:true});const {recipientIds,...safe}=r;return {brand,confirmed:true,...safe};
 }
 async function save(context,brand,input,workspace=false){const user=authorize(context,brand,true,workspace),q=rule(input,now());if(typeof input.name!=='string'||input.name.trim().length<3||input.name.length>120)fail('PAID_PUBLIC_NAME_INVALID');return store.save({id:input.id,brand,owner:user.id,name:input.name.trim(),rule:{kind:q.kind,days:q.days,...(q.productId?{productId:q.productId}:{})}});}
 async function backfill(context,brand,days,options={}){
  authorize(context,brand,true,options.workspace===true);period(days,now());
  return sourceRefresh.run({brand,days,authorize:()=>authorize(context,brand,true,options.workspace===true),publish:r=>store.setCoverage(brand,r.coverage),work:({window,guard})=>runBackfill(context,brand,window?.days||days,{...options,window,guard})});
 }
 async function runBackfill(context,brand,days,{onProgress=()=>{},workspace=false,window,guard=async()=>{}}={}){authorize(context,brand,true,workspace);const p=window||period(days,now()),t=await token(brand);if(days>60&&!t.scopes.includes('read_all_orders'))fail('PAID_FACTS_HISTORY_SCOPE_REQUIRED',403);const previous=store.coverage(brand),incremental=!!(previous&&previous.days>=days&&previous.from<=p.from&&Number.isFinite(Date.parse(previous.until))&&previous.until<=p.until),sinceUpdatedAt=incremental?new Date(Math.max(Date.parse(p.from),Date.parse(previous.until)-120000)).toISOString():null;const filter='created_at:>='+JSON.stringify(p.from)+' created_at:<'+JSON.stringify(p.until)+(incremental?' updated_at:>='+JSON.stringify(sinceUpdatedAt)+' updated_at:<'+JSON.stringify(p.until):'');let after=null,pages=0,read=0,buyers=new Set(),cursors=new Set();authorize(context,brand,true,workspace);await guard();store.setCoverage(brand,null);onProgress({brand,...p,pages,orders:read});
  do{const data=await paidRead(brand,incremental?UPDATED_ORDERS_QUERY:ORDERS_QUERY,{after,filter});if(data.shop?.myshopifyDomain!==SHOPS[brand])fail('PAID_FACTS_SHOP_MISMATCH',503);const page=data.orders;if(!page||!Array.isArray(page.nodes))fail('PAID_FACTS_SHOPIFY_UNAVAILABLE',503);
   for(const order of page.nodes.filter(o=>o.displayFinancialStatus==='PAID'&&o.cancelledAt===null)){let itemPages=0,itemCursors=new Set();while(order.lineItems.pageInfo.hasNextPage){const cursor=order.lineItems.pageInfo.endCursor;if(!cursor||itemCursors.has(cursor)||++itemPages>50)fail('PAID_ORDER_INCOMPLETE',409);itemCursors.add(cursor);const next=(await paidRead(brand,ITEMS_QUERY,{id:order.id,after:cursor})).order;if(!next||next.id!==order.id)fail('PAID_ORDER_INCOMPLETE',409);order.lineItems.nodes.push(...next.lineItems.nodes);order.lineItems.pageInfo=next.lineItems.pageInfo;}}
   const observedAt=new Date(now()).toISOString(),facts=page.nodes.map(o=>fromGraphql(brand,o,observedAt,true));await guard();await database(async c=>{authorize(context,brand,true,workspace);for(const f of facts)await c.query(UPSERT,[brand,f.orderId,JSON.stringify(f)]);authorize(context,brand,true,workspace);},true);read+=page.nodes.length;for(const f of facts){if(f.financialStatus==='paid'&&!f.test&&f.customerId)buyers.add(f.customerId);}pages++;if(pages>4000)fail('PAID_FACTS_SHOPIFY_RANGE_TOO_LARGE',409);if(typeof page.pageInfo?.hasNextPage!=='boolean'||page.pageInfo.hasNextPage&&(!page.pageInfo.endCursor||cursors.has(page.pageInfo.endCursor)))fail('PAID_FACTS_SHOPIFY_PAGINATION_INCOMPLETE',503);after=page.pageInfo.hasNextPage?page.pageInfo.endCursor:null;if(after)cursors.add(after);onProgress({brand,...p,pages,orders:read});
  }while(after);
  let eligible=await database(async c=>(await c.query("SELECT count(DISTINCT s.id)::int count FROM crm_audience_v2.shopify_identity i JOIN public.subscribers s ON s.id=i.subscriber_id AND s.uuid=i.subscriber_uuid JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id AND sl.list_id=$2 JOIN public.lists l ON l.id=sl.list_id WHERE i.brand=$1 AND i.customer_gid=ANY($3::text[]) AND s.status='enabled' AND sl.status<>'unsubscribed' AND (l.optin='single' OR sl.status='confirmed') AND l.status='active'",[brand,brand==='aristo'?16:17,[...buyers]])).rows[0].count);
  let sourceOrders=read,sourceBuyers=buyers.size;
  if(incremental){const stats=await database(async c=>{const totals=(await c.query("SELECT count(*)::int orders,count(DISTINCT paid_fact->>'customerId') FILTER(WHERE paid_fact->>'financialStatus'='paid' AND paid_fact->>'test'='false')::int buyers FROM public.crm_attribution_order_v2 WHERE brand=$1 AND paid_fact IS NOT NULL AND paid_fact->>'createdAt'>=$2 AND paid_fact->>'createdAt'<$3",[brand,p.from,p.until])).rows[0],matched=(await c.query(audienceSql('bought_recently'),[brand,p.from,p.until,null,false,brand==='aristo'?16:17])).rows[0];return {...totals,eligible:matched.count};});if(![stats.orders,stats.buyers,stats.eligible].every(x=>Number.isSafeInteger(x)&&x>=0))fail('PAID_FACTS_SOURCE_SUMMARY_UNCONFIRMED',503);sourceOrders=stats.orders;sourceBuyers=stats.buyers;eligible=stats.eligible;}
  const coverage={...p,checkedAt:new Date(now()).toISOString(),pages,orders:sourceOrders,shopifyDistinctBuyers:sourceBuyers,shopifyEligibleBuyers:eligible,...(incremental?{refresh:{mode:'incremental',sinceUpdatedAt,consultedOrders:read}}:{})};authorize(context,brand,true,workspace);await guard();return {ok:true,brand,coverage};
 }
 async function subscriptions(context,brand){authorize(context,brand);const rows=[];let after=null;do{const d=await graphql(brand,WEBHOOKS_QUERY,{after}),v=d.webhookSubscriptions;rows.push(...v.nodes);after=v.pageInfo.hasNextPage?v.pageInfo.endCursor:null;if(rows.length>500)fail('PAID_FACTS_SUBSCRIPTIONS_UNAVAILABLE',503);}while(after);return rows;}
 async function subscribe(context,brand){authorize(context,brand,true);const uri='https://crm.shrigma.com.br/webhooks/shopify/orders-paid',existing=await subscriptions(context,brand),same=existing.filter(x=>x.uri===uri);if(same.length)return {brand,existing:true,subscriptions:same};const d=await graphql(brand,WEBHOOK_CREATE,{input:{uri,format:'JSON'}}),r=d.webhookSubscriptionCreate;if(r.userErrors?.length||!r.webhookSubscription)fail('PAID_FACTS_SUBSCRIPTION_REFUSED',409);return {brand,existing:false,subscription:r.webhookSubscription};}
 const origin=require('./crm-paid-acquisition-service.cjs').create({authorize:analysisAuthorize,database,graphql:(brand,q,v)=>require('./crm-paid-acquisition.cjs').pacedRead(()=>graphql(brand,q,v,{withCost:true})),now,openBackup:brand=>require('./crm-paid-acquisition-backup.cjs').open(backupDirectory,brand),readBackup:(brand,name,offset)=>require('./crm-paid-acquisition-backup.cjs').read(backupDirectory,brand,name,offset)});
 const acquisitionBackup=async(context,brand,input)=>{authorize(context,brand);const result=await require('./crm-paid-acquisition-backup.cjs').read(backupDirectory,brand,input.name,input.offset??0);authorize(context,brand);return result;};
 const acquisitionBackupFile=(context,brand,input)=>require('./crm-paid-acquisition-backup.cjs').file(backupDirectory,brand,input.name,()=>authorize(context,brand));

 async function engagement(context,brand,input={}){
  authorizeAnalysis(context,brand);
  if(typeof campaignReader!=='function'||typeof input.campaigns!=='string'||!(/^[1-9][0-9]{0,8}(?:,[1-9][0-9]{0,8}){0,499}$/).test(input.campaigns))fail('ENGAGEMENT_INPUT',400);
  const ids=[...new Set(input.campaigns.split(',').map(Number))],owned=await campaignReader(context,brand,ids),asOf=new Date(now()).toISOString();authorizeAnalysis(context,brand);
  const inputs=[],mapped=new Map();for(const id of ids){const c=owned.find(c=>c.id===id),created=Date.parse(c?.created_at||c?.started_at||''),uuid=c?.uuid;
   const row={campaignId:id,openedUnique:null,clickedUnique:null,historicalCoverageProved:false,deliveryInferred:false};mapped.set(id,row);
   if(!c||c.definition?.brand!==brand||typeof uuid!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uuid)||!Number.isFinite(created)||created>=Date.parse(asOf)){row.reason='Identidade ou início nativo não confirmado.';continue;}
   row.from=new Date(created).toISOString();row.to=asOf;inputs.push({id,uuid,from_text:row.from,native_brand_confirmed:true});
  }
  if(inputs.length)await database(async client=>{const response=await client.query(ENGAGEMENT_PAGE_SQL,[brand,JSON.stringify(inputs),asOf]);for(const item of response.rows){const v=item.behavior_counts,p=inputs.find(p=>p.id===v?.campaignId),row=mapped.get(v?.campaignId);if(!p||!row||!['open','click'].includes(v.kind))continue;row[v.kind==='open'?'openedUnique':'clickedUnique']=pageCount(v,{brand,id:p.id,uuid:p.uuid,from:p.from_text,to:asOf,kind:v.kind});row.excludedAnonymousEvents=(row.excludedAnonymousEvents||0)+v.nullSubscriberEventRows+v.nonpositiveSubscriberEventRows;row.nativePositiveSubscriberIds=true;}},false,true);
  const rows=[...mapped.values()];for(const row of rows)if(row.openedUnique===null||row.clickedUnique===null)row.reason||='Contagem nativa ou identidade não confirmada.';
  authorizeAnalysis(context,brand);return {ok:true,brand,asOf,source:'native-distinct-events-v2',rows};
 }

 const results=require('./crm-paid-results.cjs').create({authorize:analysisAuthorize,authorizeComparison:analysisAuthorize,database,now,coverage:brand=>store.coverage(brand),campaignCatalog:async(context,brand)=>typeof campaignReader==='function'?campaignReader(context,brand,null,true):[]});
 async function home(context,brand,input={}){authorizeAnalysis(context,brand);const value=await results.results(context,brand,input);authorizeAnalysis(context,brand);return {...value,totals:{...value.totals,...value.reportTotals},series:value.reportSeries||value.series,qualityByMetric:value.reportQualityByMetric||value.qualityByMetric,trend30:value.trend30?{...value.trend30,series:value.trend30.reportSeries||value.trend30.series,qualityByMetric:value.trend30.reportQualityByMetric||value.trend30.qualityByMetric}:null,comparison:{...value.comparison,totals:{...value.comparison?.totals,...value.comparison?.reportTotals},series:value.comparison?.reportSeries||value.comparison?.series,qualityByMetric:value.comparison?.reportQualityByMetric||value.comparison?.qualityByMetric},revenueObservedAt:value.reportContributingObservedAt||null};}
 async function compareHome(context,brand,input={}){authorizeAnalysis(context,brand);const value=await results.compare(context,brand,input);authorizeAnalysis(context,brand);return require('./crm-paid-results.cjs').reportForHome(value);}
 return {engagement,ingest,status,publics,products,count,countSaved,resolveSaved,savedDefinition,freshSource,save,backfill,subscribe,subscriptions,authorize,authorizeAnalysis,acquisitionBackup,acquisitionBackupFile,...origin,...results,home,compareHome};
}
module.exports={ENGAGEMENT_PAGE_SQL,pageCount,engagementCount,create,streamBackfill,canUse,fromGraphql,period,rule,audienceSql,UPSERT,ORDERS_QUERY,UPDATED_ORDERS_QUERY,ITEMS_QUERY,WEBHOOKS_QUERY,WEBHOOK_CREATE,WEBHOOK_DELETE};
