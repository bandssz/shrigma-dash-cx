'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const P=require('../n8n/growth/segment-shopify-sync-patch.cjs');
const Fixture=require('./fixtures/segment-shopify-sync.cjs');
const PRIVATE=path.resolve(__dirname,'../../../runtime/growth-audit-20260924/inventory-private.json');
const source=brand=>Fixture.workflow(brand);
const by=(w,name)=>w.nodes.find(n=>n.name===name),edge=node=>({node,type:'main',index:0});
const config=brand=>({brand,shop:'synthetic-'+brand,revision:'shopify-customer-bulk-v1',expectedVersionId:'fixture-v1-'+brand});

for(const brand of ['fish','aristo'])test(brand+': patch preserves legacy writes/orders and adds only the strict Customer evidence branch',()=>{
 const original=source(brand),before=structuredClone(original),result=P.patchWorkflow(original,config(brand)),w=result.workflow;
 assert.deepEqual(original,before);assert.equal(w.nodes.length,21);assert.equal(result.changes.customer_query_sha256,P.CUSTOMER_QUERY_SHA256);
 for(const name of ['Insere Faltantes (Postgres)','Upsert Attribs (Postgres)','Auto-Reconciliação (Postgres)'])assert.deepEqual(by(w,name),by(before,name));
 assert.equal(by(w,'Calcula Estado').parameters.jsCode,by(before,'Calcula Estado').parameters.jsCode);assert.equal(by(w,'Calcula Estado').alwaysOutputData,true);
 for(const name of ['Bulk Pedidos — Start','Espera P','Poll P','P pronto?','Download Pedidos']){assert.deepEqual(by(w,name),by(before,name));assert.deepEqual(w.connections[name],before.connections[name]);}
 for(const name of ['Bulk Clientes — Start','Poll C']){const a=by(before,name),b=by(w,name);assert.equal(b.parameters.url.includes('/2026-07/graphql.json'),true);assert.equal(b.parameters.url.includes('/2025-01/'),false);const reverted=structuredClone(b);reverted.parameters.url=a.parameters.url;reverted.parameters.jsonBody=a.parameters.jsonBody;assert.deepEqual(reverted,a);}
 assert.deepEqual(w.connections['C pronto?'],{main:[[edge(P.NAMES.empty)],[edge('Espera C')]]});assert.deepEqual(w.connections[P.NAMES.empty],{main:[[edge(P.NAMES.evidence)],[edge('Download Clientes')]]});
 assert.deepEqual(w.connections['Calcula Estado'],{main:[[edge(P.NAMES.legacy)]]});assert.deepEqual(w.connections[P.NAMES.legacy],{main:[[edge('Insere Faltantes (Postgres)'),edge('Upsert Attribs (Postgres)')],[edge(P.NAMES.evidence)]]});assert.deepEqual(w.connections['Insere Faltantes (Postgres)'],{main:[[edge(P.NAMES.evidence)]]});
 const ingest=by(w,P.NAMES.ingest),insert=by(before,'Insere Faltantes (Postgres)');assert.deepEqual(ingest.credentials,insert.credentials);assert.equal(ingest.parameters.query,'SELECT crm_audience_v2.shopify_ingest_chunk($1::jsonb,$2::integer,$3::jsonb) AS result');assert.equal(ingest.parameters.options.queryBatching,'independently');
});

test('reviewed versions, node sources, customer queries and graph anchors are pinned; collisions are refused',()=>{
 for(const mutate of [w=>w.versionId='other',w=>w.nodes.find(n=>n.name==='Calcula Estado').parameters.jsCode+=' ',w=>w.nodes.find(n=>n.name==='Bulk Clientes — Start').parameters.jsonBody+=' ',w=>w.connections['Calcula Estado'].main[0].pop()]){
  const w=source('fish');mutate(w);assert.throws(()=>P.patchWorkflow(w,config('fish')),/SHOPIFY_SYNC_(VERSION|LEGACY_PIN|QUERY_PIN|GRAPH)_DRIFT/);
 }
 const once=P.patchWorkflow(source('fish'),config('fish')).workflow;assert.throws(()=>P.patchWorkflow(once,config('fish')),/SHOPIFY_SYNC_PATCH_COLLISION/);
});

test('Bulk Start uses static JSON and round-trips multiline GraphQL without expression delimiters',()=>{
 const body=by(P.patchWorkflow(source('fish'),config('fish')).workflow,'Bulk Clientes — Start').parameters.jsonBody;
 const expected=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-shopify-customer-bulk.graphql'),'utf8'),parsed=JSON.parse(body);
 assert.equal(body.startsWith('={{'),false);assert.equal(body.includes('\n'),false);assert.equal(body.includes('\\n'),true);
 assert.equal(parsed.query,'mutation CrmAudienceRunCustomerBulk($query: String!) { bulkOperationRunQuery(query: $query) { bulkOperation { id status } userErrors { field message } } }');
 assert.deepEqual(parsed.variables,{query:expected});assert.equal(parsed.variables.query.endsWith('}\n'),true);
});

if(fs.existsSync(PRIVATE))test('optional local snapshots still satisfy the production pins without exposing their contents',()=>{
 const inventory=JSON.parse(fs.readFileSync(PRIVATE,'utf8'));
 for(const brand of ['fish','aristo']){const workflow=structuredClone(inventory.find(w=>w?.id===P.PINS[brand].id));assert.ok(workflow);const result=P.patchWorkflow(workflow,{...config(brand),expectedVersionId:P.PINS[brand].version});assert.equal(result.workflow.nodes.length,21);}
});

const customer=id=>({id:`gid://shopify/Customer/${id}`,email:`user${id}@example.com`,defaultEmailAddress:{emailAddress:`user${id}@example.com`},firstName:'Synthetic',numberOfOrders:String(id%3),amountSpent:{amount:id%3?'10.50':'0.00',currencyCode:'BRL'},lastOrder:id%3?{createdAt:'2026-08-01T00:00:00Z'}:null,createdAt:'2025-01-01T00:00:00Z',updatedAt:'2026-09-29T03:00:00.123456Z'});
const bulk=(rows,url=true)=>{const jsonl=rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':'');return {jsonl,operation:{data:{shop:{id:'gid://shopify/Shop/11',myshopifyDomain:'synthetic-fish.myshopify.com',currencyCode:'BRL',ianaTimezone:'America/Sao_Paulo'},currentAppInstallation:{accessScopes:[{handle:'read_customers'}]},node:{id:'gid://shopify/BulkOperation/91',status:'COMPLETED',errorCode:null,objectCount:String(rows.length),rootObjectCount:String(rows.length),createdAt:'2026-09-29T03:00:00Z',completedAt:'2026-09-29T03:01:00Z',fileSize:String(Buffer.byteLength(jsonl)),url:url?'https://storage.example.invalid/result':null,partialDataUrl:null}},extensions:{cost:{actualQueryCost:4}}}};};
function runCode(code,fixture){let downloadReads=0;const lookup=name=>({first:()=>{if(name==='Poll C')return {json:fixture.operation};if(name==='Download Clientes'){downloadReads++;return {json:{data:fixture.jsonl}};}throw Error('unexpected node');}});const FixedDate=class extends Date{constructor(...args){super(...(args.length?args:['2026-09-29T03:01:01Z']));}};const rows=new vm.Script('(function(){'+code+'})()').runInNewContext({$:lookup,$workflow:{id:'fixture-shopify-fish'},Date:FixedDate,BigInt,Uint8Array,Set,Map,JSON,String,Object,Array,Number,Error});return {rows:JSON.parse(JSON.stringify(rows)),downloadReads};}

test('serialized n8n Code emits 5,000-record chunks and metadata without customers',()=>{
 const code=by(P.patchWorkflow(source('fish'),config('fish')).workflow,P.NAMES.evidence).parameters.jsCode,fixture=bulk(Array.from({length:5001},(_,i)=>customer(i+1))),ran=runCode(code,fixture);
 assert.equal(ran.downloadReads,1);assert.equal(ran.rows.length,2);assert.equal(ran.rows[0].json.chunk_index,0);assert.equal(ran.rows[0].json.customers.length,5000);assert.equal(ran.rows[1].json.chunk_index,1);assert.equal(ran.rows[1].json.customers.length,1);assert.equal('customers' in ran.rows[0].json.meta,false);assert.equal(ran.rows[0].json.meta.counts.customers,5001);assert.equal(ran.rows[0].json.meta.workflow_version,'shopify-customer-bulk-v1');
});

test('proven empty Bulk emits one empty chunk and never reads the absent Download node',()=>{
 const code=by(P.patchWorkflow(source('fish'),config('fish')).workflow,P.NAMES.evidence).parameters.jsCode,ran=runCode(code,bulk([],false));
 assert.equal(ran.downloadReads,0);assert.equal(ran.rows.length,1);assert.equal(ran.rows[0].json.chunk_index,0);assert.deepEqual(ran.rows[0].json.customers,[]);assert.equal(ran.rows[0].json.meta.counts.customers,0);
});
