'use strict';
// Composition for a trusted worker only. No route, schedule, credential or send.
const {createSourceAdapter}=require('./journey-graph-source.cjs');
const {createMaterialProvider,createIdentityResolver}=require('./journey-graph-refresh.cjs');
const {createPurchaseProvider,API_VERSION}=require('./journey-graph-purchase.cjs');
function createShopifySource({query,request,shops,clock,collectorWorkflowIds}={}){
 if(typeof request!=='function'||!shops||!shops.fish||!shops.aristo)throw Error('GRAPH_SHOPIFY_CONFIG');
 const bindings=JSON.parse(JSON.stringify(shops));
 const purchaseFor=createPurchaseProvider({resolveIdentity:createIdentityResolver({query}),request,shops:bindings,clock});
 const materialFor=createMaterialProvider({query,clock,stores:{fish:bindings.fish.myshopifyDomain,aristo:bindings.aristo.myshopifyDomain},graphql:async({brand,query:document,variables,signal})=>{
  const r=await request({brand,shop:bindings[brand].myshopifyDomain,apiVersion:API_VERSION,document,variables,signal,maxResponseBytes:262144});
  if(r?.status!==200||!r.body||Buffer.byteLength(JSON.stringify(r.body),'utf8')>262144)throw Error('GRAPH_MATERIAL_UNCONFIRMED');return r.body;
 }});
 return createSourceAdapter({query,purchaseFor,materialFor,collectorWorkflowIds});
}
module.exports={ENABLED:false,createShopifySource};
