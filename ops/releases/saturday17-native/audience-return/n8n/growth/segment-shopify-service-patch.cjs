'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Product=require('./segment-shopify-product-sync-patch.cjs');
const CUSTOMER_QUERY=fs.readFileSync(path.join(__dirname,'segment-shopify-customer-bulk.graphql'),'utf8');
const START_MUTATION='mutation CrmAudienceRunCustomerBulk($query: String!) { bulkOperationRunQuery(query: $query) { bulkOperation { id status } userErrors { field message } } }';
const startBody=()=>JSON.stringify({query:START_MUTATION,variables:{query:CUSTOMER_QUERY}});
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const CONNECTIONS_SHA256='43b4eb4a3548f25c995cb5f3ea8086065ce5e6a83c7c708f172c053bceacdeb8';
const PINS={
 fish:{id:'kcEo4Vb8rqDm4QZs',version:'7fa911a2-7486-4884-9648-d82fe942a9c0',schedule:'e6997e835764123758d8fdf1f6489068fbc6bea07c807e7fb26b5afa6ed3019c'},
 aristo:{id:'aL487KiTVcxFOdOF',version:'4acf3de4-9f13-4bc2-b7ba-71e19f3f9e1f',schedule:'1966ec8b0f2f7bbf4ef9d7e98472c5f657e086e6e474e042c8bc3453b4b2be6d'}
};
const only=(w,n)=>{const x=w.nodes.filter(v=>v.name===n);if(x.length!==1)throw Error('SHOPIFY_SERVICE_NODE_DRIFT');return x[0];};
const commandCode=brand=>`const day=new Date().toISOString().slice(0,10);return [{json:{brand:${JSON.stringify(brand)},idempotency_key:'shopify-products:${brand}:'+day,scheduled_for:day+'T00:00:00.000Z'}}];`;
const pendingCode=(brand,stage)=>`return [{json:{status:'collector_pending',brand:${JSON.stringify(brand)},stage:${JSON.stringify(stage)},products_collected:false,database_written:false,delegated:false}}];`;
function validateSource(workflow,{brand,expectedVersionId,production=false}={}){
 if(!workflow||!Array.isArray(workflow.nodes)||!workflow.connections||!['fish','aristo'].includes(brand))throw Error('SHOPIFY_SERVICE_INPUT');
 const pin=PINS[brand];if(workflow.versionId!==expectedVersionId||(production&&(workflow.id!==pin.id||expectedVersionId!==pin.version)))throw Error('SHOPIFY_SERVICE_VERSION_DRIFT');
 if(workflow.nodes.length!==21||digest(only(workflow,'Todo dia 03h').parameters)!==(production?pin.schedule:digest(only(workflow,'Todo dia 03h').parameters)))throw Error('SHOPIFY_SERVICE_SCHEDULE_DRIFT');
 if(digest(workflow.connections)!==CONNECTIONS_SHA256)throw Error('SHOPIFY_SERVICE_CONNECTION_DRIFT');
 const start=only(workflow,'Bulk Clientes — Start'),evidence=only(workflow,Product.CRM.evidence),ingest=only(workflow,Product.CRM.ingest);
 const product=fs.readFileSync(path.join(__dirname,'segment-shopify-customer-products-bulk.graphql'),'utf8');
 if(start.parameters.jsonBody!==JSON.stringify({query:START_MUTATION,variables:{query:product}})||evidence.type!=='n8n-nodes-base.code'||ingest.type!=='n8n-nodes-base.postgres'||ingest.parameters.query!=='SELECT crm_audience_v2.shopify_ingest_product_chunk($1::jsonb,$2::integer,$3::jsonb) AS result')throw Error('SHOPIFY_SERVICE_SOURCE_DRIFT');
 return {start,evidence,ingest};
}
function applyServiceLayer(workflow,{brand,serviceUrl,credential}={}){
 if(!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{2,5})?\/?$/.test(serviceUrl||'')||!credential||Object.keys(credential).sort().join(',')!=='id,name'||!credential.id||!credential.name)throw Error('SHOPIFY_SERVICE_CONFIG');
 const out=structuredClone(workflow);only(out,'Bulk Clientes — Start').parameters.jsonBody=startBody();
 const code=only(out,Product.CRM.evidence);code.parameters={mode:'runOnceForAllItems',jsCode:commandCode(brand)};delete code.credentials;delete code.retryOnFail;delete code.alwaysOutputData;
 const request=only(out,Product.CRM.ingest);request.type='n8n-nodes-base.httpRequest';request.typeVersion=4.3;request.parameters={method:'POST',url:serviceUrl.replace(/\/$/,'')+'/v1/run',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{timeout:5000,redirect:{redirect:{followRedirects:false}}}};request.credentials={httpHeaderAuth:structuredClone(credential)};request.retryOnFail=false;delete request.alwaysOutputData;
 return {workflow:out,changes:{brand,restored_customer_query:true,delegated_product_sync:true,schedule_changed:false,connections_changed:false}};
}
function transformServiceLayer(workflow,{brand,serviceUrl,credential,expectedVersionId,production=false}={}){
 validateSource(workflow,{brand,expectedVersionId,production});
 return applyServiceLayer(workflow,{brand,serviceUrl,credential});
}
function patchShopifyServiceWorkflow(workflow,options={}){const brand=options.brand,pin=PINS[brand];if(!pin)throw Error('SHOPIFY_SERVICE_INPUT');return transformServiceLayer(workflow,{...options,expectedVersionId:pin.version,production:true});}
function transformPendingLayer(workflow,{brand,expectedVersionId,production=false}={}){
 validateSource(workflow,{brand,expectedVersionId,production});
 const out=structuredClone(workflow);only(out,'Bulk Clientes — Start').parameters.jsonBody=startBody();
 for(const [name,stage] of [[Product.CRM.evidence,'evidence'],[Product.CRM.ingest,'ingest']]){
  const node=only(out,name);node.type='n8n-nodes-base.code';node.typeVersion=2;node.parameters={mode:'runOnceForAllItems',jsCode:pendingCode(brand,stage)};
  delete node.credentials;delete node.retryOnFail;delete node.alwaysOutputData;
 }
 return {workflow:out,changes:{brand,restored_customer_query:true,collector_pending:true,product_sync_disabled:true,schedule_changed:false,connections_changed:false}};
}
function patchShopifyServicePendingWorkflow(workflow,options={}){const brand=options.brand,pin=PINS[brand];if(!pin)throw Error('SHOPIFY_SERVICE_INPUT');return transformPendingLayer(workflow,{...options,expectedVersionId:pin.version,production:true});}
function validatePendingProduction(workflow,{brand,expectedVersionId}={}){
 if(!workflow||!Array.isArray(workflow.nodes)||!workflow.connections||!['fish','aristo'].includes(brand))throw Error('SHOPIFY_SERVICE_INPUT');
 const pin=PINS[brand];
 if(!expectedVersionId||workflow.versionId!==expectedVersionId||workflow.id!==pin.id)throw Error('SHOPIFY_SERVICE_VERSION_DRIFT');
 if(workflow.nodes.length!==21||digest(only(workflow,'Todo dia 03h').parameters)!==pin.schedule)throw Error('SHOPIFY_SERVICE_SCHEDULE_DRIFT');
 if(digest(workflow.connections)!==CONNECTIONS_SHA256)throw Error('SHOPIFY_SERVICE_CONNECTION_DRIFT');
 if(only(workflow,'Bulk Clientes — Start').parameters.jsonBody!==startBody())throw Error('SHOPIFY_SERVICE_SOURCE_DRIFT');
 for(const [name,stage] of [[Product.CRM.evidence,'evidence'],[Product.CRM.ingest,'ingest']]){
  const node=only(workflow,name),parameters={mode:'runOnceForAllItems',jsCode:pendingCode(brand,stage)};
  if(node.type!=='n8n-nodes-base.code'||node.typeVersion!==2||digest(node.parameters)!==digest(parameters)||Object.prototype.hasOwnProperty.call(node,'credentials')||Object.prototype.hasOwnProperty.call(node,'retryOnFail')||Object.prototype.hasOwnProperty.call(node,'alwaysOutputData'))throw Error('SHOPIFY_SERVICE_SOURCE_DRIFT');
 }
}
function patchShopifyServicePendingToActiveWorkflow(workflow,options={}){
 validatePendingProduction(workflow,options);
 return applyServiceLayer(workflow,options);
}
module.exports={patchShopifyServiceWorkflow,patchShopifyServicePendingWorkflow,patchShopifyServicePendingToActiveWorkflow,transformServiceLayer,transformPendingLayer,PINS,CONNECTIONS_SHA256,commandCode,pendingCode,startBody};
