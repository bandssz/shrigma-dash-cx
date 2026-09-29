'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const V1=require('../n8n/growth/segment-shopify-sync-patch.cjs'),P=require('../n8n/growth/segment-shopify-product-sync-patch.cjs'),Fixture=require('./fixtures/segment-shopify-sync.cjs');
const by=(workflow,name)=>workflow.nodes.find(node=>node.name===name);
const shop=brand=>'synthetic-'+brand;
const customerQuery=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-shopify-customer-bulk.graphql'),'utf8');
const startMutation='mutation CrmAudienceRunCustomerBulk($query: String!) { bulkOperationRunQuery(query: $query) { bulkOperation { id status } userErrors { field message } } }';
function installed(brand){const first=V1.patchWorkflow(Fixture.workflow(brand),{brand,shop:shop(brand),revision:P.OLD_REVISION,expectedVersionId:'fixture-v1-'+brand}).workflow;first.versionId='fixture-products-'+brand;by(first,'Bulk Clientes — Start').parameters.jsonBody=`={{ ${JSON.stringify({query:startMutation,variables:{query:customerQuery}})} }}`;return first;}
const config=brand=>({brand,shop:shop(brand),revision:'crm-shopify-product-evidence-20260929-v2',expectedVersionId:'fixture-products-'+brand});

for(const brand of ['fish','aristo'])test(brand+': v2 replaces only Customer query, evidence code and ingest function',()=>{
 const before=installed(brand),input=structuredClone(before),result=P.patchProductWorkflow(input,config(brand)),after=result.workflow;
 assert.deepEqual(input,before);assert.equal(after.nodes.length,21);assert.deepEqual(after.connections,before.connections);assert.deepEqual(after.settings,before.settings);assert.deepEqual(result.changes,{brand,customer_product_query_sha256:P.PRODUCT_QUERY_SHA256,nodesAdded:[],connectionsChanged:false,ordersChanged:false,legacyChanged:false});
 const changed=[];for(let i=0;i<before.nodes.length;i++){const a=structuredClone(before.nodes[i]),b=structuredClone(after.nodes[i]);if(a.name==='Bulk Clientes — Start'){assert.notEqual(a.parameters.jsonBody,b.parameters.jsonBody);a.parameters.jsonBody=b.parameters.jsonBody;}else if(a.name===P.CRM.evidence){assert.notEqual(a.parameters.jsCode,b.parameters.jsCode);a.parameters.jsCode=b.parameters.jsCode;}else if(a.name===P.CRM.ingest){assert.notEqual(a.parameters.query,b.parameters.query);a.parameters.query=b.parameters.query;}if(JSON.stringify(a)!==JSON.stringify(b))changed.push(a.name);}
 assert.deepEqual(changed,[]);assert.match(by(after,'Bulk Clientes — Start').parameters.jsonBody,/CrmAudienceCustomerProductBulk/);assert.equal(by(after,P.CRM.ingest).parameters.query,'SELECT crm_audience_v2.shopify_ingest_product_chunk($1::jsonb,$2::integer,$3::jsonb) AS result');
 for(const name of ['Bulk Pedidos — Start','Espera P','Poll P','P pronto?','Download Pedidos','Calcula Estado','Insere Faltantes (Postgres)','Upsert Attribs (Postgres)','Auto-Reconciliação (Postgres)'])assert.deepEqual(by(after,name),by(before,name));
});

test('reviewed versions and every existing node identity and edge are fail-closed',()=>{
 for(const mutate of [
  workflow=>workflow.versionId='drift',
  workflow=>by(workflow,'Calcula Estado').id='other',
  workflow=>by(workflow,P.CRM.evidence).id='other',
  workflow=>workflow.connections[P.CRM.evidence].main[0][0].node='Calcula Estado',
  workflow=>workflow.nodes.push({...workflow.nodes[0],id:'extra',name:'extra'})
 ]){const workflow=installed('fish');mutate(workflow);assert.throws(()=>P.patchProductWorkflow(workflow,config('fish')),/SHOPIFY_PRODUCT_SYNC_(VERSION|NODE|GRAPH)_DRIFT/);}
});

test('old Customer query, status query and producer revision are pinned before replacement',()=>{
 for(const [mutate,code] of [
  [workflow=>by(workflow,'Bulk Clientes — Start').parameters.jsonBody+=' ',/QUERY_PIN_DRIFT/],
  [workflow=>by(workflow,'Poll C').parameters.jsonBody+=' ',/QUERY_PIN_DRIFT/],
  [workflow=>by(workflow,P.CRM.evidence).parameters.jsCode+=' ',/EVIDENCE_PIN_DRIFT/],
  [workflow=>by(workflow,P.CRM.ingest).parameters.query+=' ',/INGEST_PIN_DRIFT/]
 ]){const workflow=installed('aristo');mutate(workflow);assert.throws(()=>P.patchProductWorkflow(workflow,config('aristo')),code);}
});

test('product Bulk Start is static JSON and preserves escaped newlines and closing braces byte-for-byte',()=>{
 const body=by(P.patchProductWorkflow(installed('fish'),config('fish')).workflow,'Bulk Clientes — Start').parameters.jsonBody;
 const expected=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-shopify-customer-products-bulk.graphql'),'utf8'),parsed=JSON.parse(body);
 assert.equal(body.startsWith('={{'),false);assert.equal(body.includes('\n'),false);assert.equal(body.includes('\\n'),true);assert.equal(body.endsWith('}}'),true);
 assert.equal(parsed.query,startMutation);
 assert.deepEqual(parsed.variables,{query:expected});assert.equal(parsed.variables.query.endsWith('}\n'),true);
});

test('node types, options, credential reference and retry behavior cannot drift',()=>{
 for(const [mutate,code] of [
  [workflow=>by(workflow,'Bulk Clientes — Start').parameters.options={timeout:1},/QUERY_PIN_DRIFT/],
  [workflow=>by(workflow,P.CRM.evidence).retryOnFail=true,/EVIDENCE_PIN_DRIFT/],
  [workflow=>by(workflow,P.CRM.ingest).retryOnFail=true,/INGEST_PIN_DRIFT/],
  [workflow=>by(workflow,P.CRM.ingest).credentials.postgres.id='other',/INGEST_PIN_DRIFT/],
  [workflow=>by(workflow,'Poll C').typeVersion=4.4,/QUERY_PIN_DRIFT/]
 ]){const workflow=installed('fish');mutate(workflow);assert.throws(()=>P.patchProductWorkflow(workflow,config('fish')),code);}
});

const customer=id=>({id:`gid://shopify/Customer/${id}`,email:`user${id}@example.com`,defaultEmailAddress:{emailAddress:`user${id}@example.com`},firstName:'Synthetic',numberOfOrders:'1',amountSpent:{amount:'10.50',currencyCode:'BRL'},lastOrder:{createdAt:'2026-08-01T00:00:00Z'},createdAt:'2025-01-01T00:00:00Z',updatedAt:'2026-09-29T03:00:00Z'});
const order=(id,parent)=>({id:`gid://shopify/Order/${id}`,__parentId:`gid://shopify/Customer/${parent}`});
const item=(id,parent,product)=>({id:`gid://shopify/LineItem/${id}`,quantity:1,product:product===null?null:{id:`gid://shopify/Product/${product}`,title:'Product '+product},__parentId:`gid://shopify/Order/${parent}`});
function bulk(rows){const jsonl=rows.map(JSON.stringify).join('\n')+(rows.length?'\n':'');return {jsonl,operation:{data:{shop:{id:'gid://shopify/Shop/11',myshopifyDomain:'synthetic-fish.myshopify.com',currencyCode:'BRL',ianaTimezone:'America/Sao_Paulo'},currentAppInstallation:{accessScopes:['read_customers','read_orders','read_all_orders','read_products'].map(handle=>({handle}))},node:{id:'gid://shopify/BulkOperation/91',status:'COMPLETED',errorCode:null,objectCount:String(rows.length),rootObjectCount:String(rows.filter(row=>!Object.hasOwn(row,'__parentId')).length),createdAt:'2026-09-29T03:00:00Z',completedAt:'2026-09-29T03:01:00Z',fileSize:String(Buffer.byteLength(jsonl)),url:rows.length?'https://storage.example.invalid/products':null,partialDataUrl:null}}}};}
function run(code,fixture){let downloads=0;const lookup=name=>({first:()=>{if(name==='Poll C')return {json:fixture.operation};if(name==='Download Clientes'){downloads++;return {json:{data:fixture.jsonl}};}throw Error('unexpected');}}),FixedDate=class extends Date{constructor(...args){super(...(args.length?args:['2026-09-29T03:01:01Z']));}};const rows=new vm.Script('(function(){'+code+'})()').runInNewContext({$:lookup,$workflow:{id:'fixture-shopify-fish'},Date:FixedDate,BigInt,Uint8Array,Set,Map,JSON,String,Object,Array,Number,Error,RegExp});return {rows:JSON.parse(JSON.stringify(rows)),downloads};}

test('serialized v2 Code uses the raw Download, fixed 5,000 Customer chunks and tri-state history',()=>{
 const workflow=P.patchProductWorkflow(installed('fish'),config('fish')).workflow,code=by(workflow,P.CRM.evidence).parameters.jsCode,rows=[];for(let id=1;id<=5001;id++){rows.push(customer(id),order(10000+id,id),item(20000+id,10000+id,id===1?null:(id%500)+1));}
 const result=run(code,bulk(rows));assert.equal(result.downloads,1);assert.equal(result.rows.length,2);assert.equal(result.rows[0].json.customers.length,5000);assert.equal(result.rows[1].json.customers.length,1);assert.equal(result.rows[0].json.meta.version,2);assert.equal(result.rows[0].json.meta.query_sha256,P.PRODUCT_QUERY_SHA256);assert.equal(result.rows[0].json.meta.workflow_version,config('fish').revision);assert.equal(result.rows[0].json.customers[0].unresolved_product_items,1);assert.equal(result.rows[0].json.customers[0].product_history_complete,false);assert.equal(result.rows[0].json.meta.counts.product_missing,1);assert.equal(result.rows[0].json.meta.counts.product_history_incomplete,1);assert.equal(result.rows[0].json.meta.counts.object_count,String(rows.length));
});

test('proven empty v2 Bulk emits one empty chunk without reading Download',()=>{
 const code=by(P.patchProductWorkflow(installed('fish'),config('fish')).workflow,P.CRM.evidence).parameters.jsCode,result=run(code,bulk([]));assert.equal(result.downloads,0);assert.equal(result.rows.length,1);assert.deepEqual(result.rows[0].json.customers,[]);assert.equal(result.rows[0].json.meta.version,2);
});
