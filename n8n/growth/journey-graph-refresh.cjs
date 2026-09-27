'use strict';
// Server-only, read-only checkout refresh. No customer material is persisted.
const VERSION = 'journey_material_evidence_v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const QUERY = `query GraphCartRefresh($id: ID!) {
  shop { myshopifyDomain }
  node(id: $id) { ... on AbandonedCheckout {
    id createdAt updatedAt completedAt abandonedCheckoutUrl
    customer { id email firstName emailMarketingConsent { marketingState } }
    totalPriceSet { shopMoney { amount currencyCode } }
    lineItems(first: 100) {
      nodes { id title quantity variantTitle image { url } originalUnitPriceSet { shopMoney { amount currencyCode } } }
      pageInfo { hasNextPage }
    }
  } }
}`;
const IDENTITY_SQL = `SELECT e.subject_id::text,e.revision,e.cart_hash,
  to_char(e.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
  s.email,s.attribs->$1->>'cart_id' AS cart_id
 FROM crm_graph_candidate.source_event_v1 e JOIN public.subscribers s
 ON s.id=e.subscriber_id AND s.uuid=e.subject_id
 WHERE e.brand=$1 AND e.id=$2::uuid AND e.subject_id=$3::uuid
 AND crm_graph_candidate.source_time_v1(s.attribs->$1->>'cart_abandoned_at')=e.ref
 AND encode(sha256(convert_to(s.attribs->$1->>'cart_id','UTF8')),'hex')=e.cart_hash`;
const fail = () => { throw Object.assign(Error('GRAPH_MATERIAL_UNCONFIRMED'), {code:'GRAPH_MATERIAL_UNCONFIRMED'}); };
const iso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const time = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s)) ? Date.parse(s) : NaN;
const email = s => typeof s === 'string' && s.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s) ? s.toLowerCase() : null;
function money(v) {
  if (v?.currencyCode !== 'BRL' || typeof v.amount !== 'string' || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(v.amount)) fail();
  const n = Number(v.amount); if (!Number.isFinite(n) || n > 1e9) fail(); return n;
}
function https(v) {
  if (typeof v !== 'string' || v.length > 2048) fail();
  try { const u = new URL(v); if (u.protocol !== 'https:' || u.username || u.password) fail(); return v; } catch { fail(); }
}
function createIdentityResolver({query}={}) {
  if(typeof query!=='function')fail();
  return async ({source_ref,subject_id,brand,occurred_at,query:read=query,signal}={})=>{
    if(!['fish','aristo'].includes(brand)||!UUID.test(source_ref||'')||!UUID.test(subject_id||'')||!iso(occurred_at)||typeof read!=='function'||signal?.aborted)fail();
    const rows=(await read(IDENTITY_SQL,[brand,source_ref,subject_id]))?.rows;
    if(signal?.aborted||!Array.isArray(rows)||rows.length!==1)fail();const r=rows[0];
    if(r.subject_id!==subject_id||r.occurred_at!==occurred_at||!/^gid:\/\/shopify\/AbandonedCheckout\/[1-9]\d*$/.test(r.cart_id||'')||!email(r.email)||!/^[a-f0-9]{64}$/.test(r.revision||''))fail();
    return {version:'journey_shopify_identity_v1',source_ref,subject_id,brand,occurred_at,checkout_id:r.cart_id,email:r.email,source_revision:r.revision};
  };
}
function createMaterialProvider({query, graphql, stores, clock=()=>new Date().toISOString()}={}) {
  if (typeof query !== 'function' || typeof graphql !== 'function' || typeof clock !== 'function') fail();
  // Domain bindings come from reviewed server configuration, never an editor body.
  if (!stores || !['fish','aristo'].every(b => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(stores[b] || '')) || stores.fish === stores.aristo) fail();
  const domains = {fish:stores.fish,aristo:stores.aristo};
  return async function materialFor({source_ref,subject_id,brand,occurred_at,now,query:read=query,signal}={}) {
    if (!Object.hasOwn(domains,brand) || !UUID.test(source_ref || '') || !UUID.test(subject_id || '') || !iso(occurred_at) || !iso(now) || typeof read !== 'function') fail();
    const started = clock();
    if (!iso(started) || Date.parse(started) < Date.parse(now) || Date.parse(started)-Date.parse(now)>5000 || Date.parse(occurred_at)>Date.parse(now)) fail();
    const rows = (await read(IDENTITY_SQL,[brand,source_ref,subject_id]))?.rows;
    if (!Array.isArray(rows) || rows.length!==1) fail();
    const native = rows[0];
    if (native.subject_id!==subject_id || native.occurred_at!==occurred_at || !/^gid:\/\/shopify\/AbandonedCheckout\/[1-9]\d*$/.test(native.cart_id || '') || !email(native.email)) fail();
    let response;
    try { response = await graphql({brand,query:QUERY,variables:{id:native.cart_id},signal}); } catch { fail(); }
    const finished = clock();
    if (!iso(finished) || Date.parse(finished)<Date.parse(started) || Date.parse(finished)-Date.parse(now)>5000 || response?.errors?.length || response?.extensions?.search?.some(x=>x.warnings?.length)) fail();
    const data = response?.data, cart = data?.node;
    if (data?.shop?.myshopifyDomain !== domains[brand] || cart?.id !== native.cart_id || time(cart.createdAt)!==Date.parse(occurred_at) || !Number.isFinite(time(cart.updatedAt)) || time(cart.updatedAt)<time(cart.createdAt) || time(cart.updatedAt)>Date.parse(finished)) fail();
    if (!/^gid:\/\/shopify\/Customer\/[1-9]\d*$/.test(cart.customer?.id || '') || email(cart.customer.email)!==email(native.email)) fail();
    // Re-read after network I/O: changed identity/cart must not receive this proof.
    const again = (await read(IDENTITY_SQL,[brand,source_ref,subject_id]))?.rows;
    if (!Array.isArray(again) || again.length!==1 || ['subject_id','revision','cart_hash','occurred_at','email','cart_id'].some(k=>again[0][k]!==native[k])) fail();
    const base = {version:VERSION,source_ref,subject_id,brand,source_revision:native.revision,observed_at:now,complete:true};
    if (cart.completedAt !== null) {
      if (!Number.isFinite(time(cart.completedAt)) || time(cart.completedAt)<time(cart.createdAt) || time(cart.completedAt)>Date.parse(finished)) fail();
      return {...base,purchase_positive:true,consent_allowed:false,material:null};
    }
    // A null completedAt never establishes absence of other purchases.
    if (cart.customer.emailMarketingConsent?.marketingState !== 'SUBSCRIBED') return {...base,purchase_positive:false,consent_allowed:false,material:null};
    const items = cart.lineItems;
    if (items?.pageInfo?.hasNextPage!==false || !Array.isArray(items.nodes) || items.nodes.length<1 || items.nodes.length>100) fail();
    const seen = new Set();
    const materialItems = items.nodes.map(i=>{
      // Line-item IDs are opaque and can be parameterized Shopify GIDs. They
      // are only used to detect duplicate items, never as a query or SQL input.
      if (typeof i?.id!=='string' || !/^gid:\/\/shopify\/AbandonedCheckoutLineItem\/[^\s\u0000-\u001f]{1,470}$/.test(i.id) || seen.has(i.id) || typeof i.title!=='string' || !i.title || i.title.length>2048 || !Number.isSafeInteger(i.quantity) || i.quantity<1 || i.quantity>10000 || !(i.variantTitle===null || typeof i.variantTitle==='string')) fail();
      seen.add(i.id);
      // Shopify defines null variantTitle as no distinct variant, not missing data.
      return {titulo:i.title,qtd:i.quantity,variante:i.variantTitle===null?'':i.variantTitle,preco:money(i.originalUnitPriceSet?.shopMoney),imagem:i.image===null?null:https(i.image?.url)};
    });
    const material = {'contact.first_name':cart.customer.firstName,'cart.checkout_url':https(cart.abandonedCheckoutUrl),'cart.items':materialItems,'cart.total':money(cart.totalPriceSet?.shopMoney)};
    if (JSON.stringify(material).length>24000) fail();
    return {...base,purchase_positive:false,consent_allowed:true,material};
  };
}
module.exports = {VERSION,QUERY,IDENTITY_SQL,createMaterialProvider,createIdentityResolver};
