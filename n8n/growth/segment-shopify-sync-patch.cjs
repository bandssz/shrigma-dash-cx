'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Evidence=require('./segment-shopify-bulk-evidence.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const clone=value=>structuredClone(value);
const CUSTOMER_QUERY=fs.readFileSync(path.join(__dirname,'segment-shopify-customer-bulk.graphql'),'utf8');
const STATE_QUERY=fs.readFileSync(path.join(__dirname,'segment-shopify-bulk-state.graphql'),'utf8');
const CUSTOMER_QUERY_SHA256=sha(CUSTOMER_QUERY);
const STATE_QUERY_SHA256=sha(STATE_QUERY);
if(CUSTOMER_QUERY_SHA256!=='1ca989e8c1e9f00478e3e069f70a8fe3f0a20d1fb730022cdb766bf738a65b48'||STATE_QUERY_SHA256!=='4ae57c914bc65e5490f96307ea1f1f8286b55f023e71df501b75c7a3d854d546')throw Error('SHOPIFY_SYNC_GRAPHQL_SOURCE_DRIFT');
const PINS={
 fish:{id:'kcEo4Vb8rqDm4QZs',version:'de97c5f6-4783-4766-93f7-9c6031adafd8',legacy:{'Calcula Estado':'1855b015e88032f3da22219f933239dd2c85e92fdfaae64b3864fb8b5892c924','Upsert Attribs (Postgres)':'e77942141ee097d7fc24f661410eb0f4ae2be447b43d2046922e887d2bab6468','Auto-Reconciliação (Postgres)':'cc42f133192410e9af2a15e7d6496af3ba0bf3184c6ec908638bb6038d859dc9','Insere Faltantes (Postgres)':'d90e81025c591f1d1859b42bfdfc6b0c7c672d99f7f0b5e1db16b220987541c5'}},
 aristo:{id:'aL487KiTVcxFOdOF',version:'00f5d39a-7c1e-4ecf-b228-e0098702cb54',legacy:{'Calcula Estado':'e633d096507c2761d55bba3f0529ee22b561b6c8a736b987857f78be2641c5e5','Upsert Attribs (Postgres)':'e77942141ee097d7fc24f661410eb0f4ae2be447b43d2046922e887d2bab6468','Auto-Reconciliação (Postgres)':'cc42f133192410e9af2a15e7d6496af3ba0bf3184c6ec908638bb6038d859dc9','Insere Faltantes (Postgres)':'d90e81025c591f1d1859b42bfdfc6b0c7c672d99f7f0b5e1db16b220987541c5'}}
};
const FIXTURE_PINS={
 fish:{id:'fixture-shopify-fish',version:'fixture-v1-fish',legacy:{'Calcula Estado':'830bfcff10b98a3a0274ad4b175410de5329afef291353bc92ba5e2192c861c7','Upsert Attribs (Postgres)':'f660e5d2de8723f48044147d281b0108e7edd5a4e30061e3272ef628b84ff552','Auto-Reconciliação (Postgres)':'292d5926fc98cdd9717ae187668e2fb63c36b19145473bed8f9d6acf3a19332a','Insere Faltantes (Postgres)':'683e72a8b9185ab99c71764bd43d931cb338de8023a8d4202223ca8d8ec28f9f'}},
 aristo:{id:'fixture-shopify-aristo',version:'fixture-v1-aristo',legacy:{'Calcula Estado':'d8ced2e356f0bcb6ee37083b7eddabed258d3d4ffb395fd11aec5ee6962608f4','Upsert Attribs (Postgres)':'f660e5d2de8723f48044147d281b0108e7edd5a4e30061e3272ef628b84ff552','Auto-Reconciliação (Postgres)':'292d5926fc98cdd9717ae187668e2fb63c36b19145473bed8f9d6acf3a19332a','Insere Faltantes (Postgres)':'683e72a8b9185ab99c71764bd43d931cb338de8023a8d4202223ca8d8ec28f9f'}}
};
const OLD_CUSTOMER_START_SHA256='19f7645a89ba773d2cc0806a3de05abb4b10ba4ddcca0e41b38b3fb5c1bf2cee';
const OLD_CUSTOMER_POLL_SHA256='62ed0a76bfdfc1236f5963bce849adce485b82c86401d846365f99c6a6dd8fcd';
const NAMES={empty:'CRM Shopify · Bulk vazio?',legacy:'CRM Shopify · Tem lote legado?',evidence:'CRM Shopify · Evidência Customer',ingest:'CRM Shopify · Ingestão Customer'};
const edge=node=>({node,type:'main',index:0});
const onlyNode=(workflow,name,type)=>{const found=workflow.nodes.filter(n=>n.name===name);if(found.length!==1||type&&found[0].type!==type)throw Error('SHOPIFY_SYNC_NODE_DRIFT');return found[0];};
const exactEdges=(workflow,name,expected)=>{const actual=workflow.connections[name]?.main;if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('SHOPIFY_SYNC_GRAPH_DRIFT');};
const startBody=()=>`={{ ${JSON.stringify({query:'mutation CrmAudienceRunCustomerBulk($query: String!) { bulkOperationRunQuery(query: $query) { bulkOperation { id status } userErrors { field message } } }',variables:{query:CUSTOMER_QUERY}})} }}`;
const pollBody=()=>`={{ ({ query: ${JSON.stringify(STATE_QUERY)}, variables: { operation: $('Bulk Clientes — Start').item.json.data.bulkOperationRunQuery.bulkOperation.id } }) }}`;
function evidenceCode({brand,shop,revision}){
 return `const buildCustomerEvidence=${Evidence.buildCustomerEvidenceSource};
const poll=$('Poll C').first().json,node=poll?.data?.node;
const empty=String(node?.rootObjectCount)==='0'&&String(node?.objectCount)==='0'&&node?.url===null;
const jsonl=empty?'':$('Download Clientes').first().json.data;
const evidence=buildCustomerEvidence({brand:${JSON.stringify(brand)},shop:${JSON.stringify(shop)},operation:poll,jsonl,observedAt:new Date().toISOString(),querySha256:${JSON.stringify(CUSTOMER_QUERY_SHA256)},workflowId:String($workflow.id),workflowVersion:${JSON.stringify(revision)}});
const {customers,...meta}=evidence,chunks=[];
if(customers.length===0)chunks.push([]);else for(let i=0;i<customers.length;i+=5000)chunks.push(customers.slice(i,i+5000));
return chunks.map((customers,chunk_index)=>({json:{meta,chunk_index,customers}}));`;
}
function patchWorkflow(workflow,{brand,shop,revision,expectedVersionId}={}){
 if(!workflow||!Array.isArray(workflow.nodes)||!workflow.connections||!PINS[brand])throw Error('SHOPIFY_SYNC_INPUT_INVALID');const pin=workflow.id===FIXTURE_PINS[brand].id?FIXTURE_PINS[brand]:PINS[brand];
 const reservedIds=['crm-shopify-bulk-empty-'+brand,'crm-shopify-legacy-output-'+brand,'crm-shopify-evidence-'+brand,'crm-shopify-ingest-'+brand];
 if(workflow.nodes.length!==17||Object.values(NAMES).some(name=>workflow.nodes.some(n=>n.name===name))||reservedIds.some(id=>workflow.nodes.some(n=>n.id===id)))throw Error('SHOPIFY_SYNC_PATCH_COLLISION');
 if(workflow.id!==pin.id||workflow.versionId!==pin.version||expectedVersionId!==pin.version)throw Error('SHOPIFY_SYNC_VERSION_DRIFT');
 if(typeof shop!=='string'||!/^[a-z0-9][a-z0-9-]{0,62}(?:\.myshopify\.com)?$/.test(shop)||typeof revision!=='string'||!/^[A-Za-z0-9._:-]{1,80}$/.test(revision))throw Error('SHOPIFY_SYNC_CONFIG_INVALID');
 const start=onlyNode(workflow,'Bulk Clientes — Start','n8n-nodes-base.httpRequest'),poll=onlyNode(workflow,'Poll C','n8n-nodes-base.httpRequest'),ready=onlyNode(workflow,'C pronto?','n8n-nodes-base.if');
 const calculate=onlyNode(workflow,'Calcula Estado','n8n-nodes-base.code'),insert=onlyNode(workflow,'Insere Faltantes (Postgres)','n8n-nodes-base.postgres');
 for(const [name,digest] of Object.entries(pin.legacy)){const n=onlyNode(workflow,name),source=n.type==='n8n-nodes-base.code'?n.parameters?.jsCode:n.parameters?.query;if(typeof source!=='string'||sha(source)!==digest)throw Error('SHOPIFY_SYNC_LEGACY_PIN_DRIFT');}
 if(sha(start.parameters?.jsonBody||'')!==OLD_CUSTOMER_START_SHA256||sha(poll.parameters?.jsonBody||'')!==OLD_CUSTOMER_POLL_SHA256)throw Error('SHOPIFY_SYNC_QUERY_PIN_DRIFT');
 for(const n of [start,poll])if(typeof n.parameters.url!=='string'||n.parameters.url.split('/2025-01/').length!==2)throw Error('SHOPIFY_SYNC_API_VERSION_DRIFT');
 exactEdges(workflow,'C pronto?',[[edge('Download Clientes')],[edge('Espera C')]]);exactEdges(workflow,'Calcula Estado',[[edge('Insere Faltantes (Postgres)'),edge('Upsert Attribs (Postgres)')]]);if(workflow.connections['Insere Faltantes (Postgres)'])throw Error('SHOPIFY_SYNC_GRAPH_DRIFT');
 const out=clone(workflow),get=name=>onlyNode(out,name);get('Bulk Clientes — Start').parameters.jsonBody=startBody();get('Poll C').parameters.jsonBody=pollBody();
 for(const name of ['Bulk Clientes — Start','Poll C'])get(name).parameters.url=get(name).parameters.url.replace('/2025-01/','/2026-07/');get('Calcula Estado').alwaysOutputData=true;
 const baseIf=ready,basePosition=calculate.position||[0,0],emptyNode={...clone(baseIf),id:'crm-shopify-bulk-empty-'+brand,name:NAMES.empty,position:[(ready.position?.[0]||0)+220,ready.position?.[1]||0],parameters:{conditions:{options:{caseSensitive:true,typeValidation:'strict',version:2},conditions:[{id:'crm-shopify-empty',leftValue:"={{ $json.data?.node?.status === 'COMPLETED' && String($json.data?.node?.rootObjectCount) === '0' && String($json.data?.node?.objectCount) === '0' && $json.data?.node?.url === null && $json.data?.node?.partialDataUrl === null && $json.data?.node?.errorCode === null }}",rightValue:true,operator:{type:'boolean',operation:'true','singleValue':true}}],combinator:'and'},options:{}}};
 const legacyNode={...clone(baseIf),id:'crm-shopify-legacy-output-'+brand,name:NAMES.legacy,position:[basePosition[0]+220,basePosition[1]],parameters:{conditions:{options:{caseSensitive:true,typeValidation:'strict',version:2},conditions:[{id:'crm-shopify-legacy',leftValue:"={{ typeof $json.brand === 'string' && typeof $json.batch === 'string' && $json.batch.length > 0 }}",rightValue:true,operator:{type:'boolean',operation:'true','singleValue':true}}],combinator:'and'},options:{}}};
 const codeNode={id:'crm-shopify-evidence-'+brand,name:NAMES.evidence,type:'n8n-nodes-base.code',typeVersion:calculate.typeVersion,position:[basePosition[0]+680,basePosition[1]+260],parameters:{mode:'runOnceForAllItems',jsCode:evidenceCode({brand,shop,revision})}};
 const pg=insert.credentials?.postgres;if(Object.keys(insert.credentials||{}).length!==1||!pg||Object.keys(pg).sort().join(',')!=='id,name'||typeof pg.id!=='string'||!pg.id||typeof pg.name!=='string'||!pg.name)throw Error('SHOPIFY_SYNC_POSTGRES_CREDENTIAL_DRIFT');
 const ingestNode={id:'crm-shopify-ingest-'+brand,name:NAMES.ingest,type:'n8n-nodes-base.postgres',typeVersion:insert.typeVersion,position:[basePosition[0]+900,basePosition[1]+260],credentials:{postgres:{id:pg.id,name:pg.name}},retryOnFail:false,parameters:{operation:'executeQuery',query:'SELECT crm_audience_v2.shopify_ingest_chunk($1::jsonb,$2::integer,$3::jsonb) AS result',options:{queryBatching:'independently',queryReplacement:'={{ [JSON.stringify($json.meta), $json.chunk_index, JSON.stringify($json.customers)] }}'}}};
 out.nodes.push(emptyNode,legacyNode,codeNode,ingestNode);
 out.connections['C pronto?']={main:[[edge(NAMES.empty)],[edge('Espera C')]]};out.connections[NAMES.empty]={main:[[edge(NAMES.evidence)],[edge('Download Clientes')]]};
 out.connections['Calcula Estado']={main:[[edge(NAMES.legacy)]]};out.connections[NAMES.legacy]={main:[[edge('Insere Faltantes (Postgres)'),edge('Upsert Attribs (Postgres)')],[edge(NAMES.evidence)]]};
 out.connections['Insere Faltantes (Postgres)']={main:[[edge(NAMES.evidence)]]};out.connections[NAMES.evidence]={main:[[edge(NAMES.ingest)]]};
 return {workflow:out,changes:{brand,customer_query_sha256:CUSTOMER_QUERY_SHA256,nodesAdded:Object.values(NAMES),legacyCodeChanged:false,legacyPostgresChanged:false,ordersChanged:false}};
}
module.exports={patchWorkflow,evidenceCode,PINS,NAMES,CUSTOMER_QUERY_SHA256,STATE_QUERY_SHA256};
