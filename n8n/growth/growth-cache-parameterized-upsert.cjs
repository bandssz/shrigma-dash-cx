'use strict';

const {createHash}=require('node:crypto');

const WORKFLOW_ID='DN7wu3c8UZJ1GX8v';
const VERSION_ID='ebbfeecd-3024-496d-9bc4-0faf3e4a43f8';
const SOURCE='API de leitura (painel=growth)';
const REMOVED='Monta upsert';
const SINK='Grava dash_payload_cache';
const CLOCK='Marca o relógio';
const NODE_IDS={
 source:'dae16037-b6f1-401d-b6ec-f839760e7f10',
 removed:'134f569c-ef48-47b3-b57f-0031d030f25d',
 sink:'c0cdc4cc-c04c-44ea-89dd-1603cb1196da',
};
const PINS={
 nodes:'cdd941fb0bd717c1c4fddfbd7450540041ac92bf936833d8fa5f403fe4bdd811',
 connections:'55970ff22e44630123c7544c05322da0a88fc3faae051d2d8b1a8b4a34e2fd80',
};

const SQL=`INSERT INTO dash_payload_cache (painel, payload, gerado_em, bytes, origem_ms)
VALUES ('growth', $1::jsonb, now(), $2, $3)
ON CONFLICT (painel) DO UPDATE SET
 payload = EXCLUDED.payload,
 gerado_em = now(),
 bytes = EXCLUDED.bytes,
 origem_ms = EXCLUDED.origem_ms`;

// Keep serialization inside the parameter expression. The payload remains a bound
// value and never becomes part of SQL or the output of an intermediate Code node.
const QUERY_REPLACEMENT=`={{ (() => {
 const p = ($json && $json.body !== undefined) ? $json.body : $json;
 if (!p || typeof p !== 'object' || Array.isArray(p) || !p.gerado_em) throw new Error('CACHE_PAYLOAD_INVALID');
 const t = JSON.stringify(p);
 const n = Date.now();
 const started = Number($('${CLOCK}').first().json.ms || n);
 return [t, t.length, Math.max(0, Math.round(n - started))];
})() }}`;

function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
function hash(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function clone(value){return structuredClone(value);}
function fail(code){throw Error(`GROWTH_CACHE_${code}_DRIFT`);}

function payloadFrom(input){return input&&input.body!==undefined?input.body:input;}
function prepareCacheParameters(input,startedMs,nowMs=Date.now()){
 const payload=payloadFrom(input);
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||!payload.gerado_em)throw Error('CACHE_PAYLOAD_INVALID');
 const text=JSON.stringify(payload);
 const origin=Math.max(0,Math.round(nowMs-Number(startedMs||nowMs)));
 return {parameters:[text,text.length,origin],diagnostics:{bytes_utf16:text.length,blocos:Object.keys(payload).length}};
}

function legacySqlForMeasurement(text,originMs){
 const literal=text.includes('$crmjson$')?`'${text.replace(/'/g,"''")}'`:`$crmjson$${text}$crmjson$`;
 return `INSERT INTO dash_payload_cache (painel, payload, gerado_em, bytes, origem_ms) VALUES ('growth', ${literal}::jsonb, now(), ${text.length}, ${originMs})\n  ON CONFLICT (painel) DO UPDATE SET payload = EXCLUDED.payload, gerado_em = now(), bytes = EXCLUDED.bytes, origem_ms = EXCLUDED.origem_ms`;
}
function measureRunDataRepresentation(input,startedMs,nowMs=Date.now()){
 const prepared=prepareCacheParameters(input,startedMs,nowMs),text=prepared.parameters[0],origin=prepared.parameters[2];
 const payload=payloadFrom(input),legacySql=legacySqlForMeasurement(text,origin);
 const legacyOutput=[{json:{sql:legacySql,bytes:text.length,blocos:Object.keys(payload).length}}];
 return {
  input_json_utf8:Buffer.byteLength(JSON.stringify(input)),
  removed_code_output_json_utf8:Buffer.byteLength(JSON.stringify(legacyOutput)),
  candidate_intermediate_output_json_utf8:0,
  ...prepared.diagnostics,
 };
}

function validateLayer(nodes,connections,label){
 if(!Array.isArray(nodes)||nodes.length!==6||hash(nodes)!==PINS.nodes)fail(`${label}_NODES`);
 if(!connections||hash(connections)!==PINS.connections)fail(`${label}_CONNECTIONS`);
 const byId=id=>nodes.filter(n=>n.id===id);
 const source=byId(NODE_IDS.source),removed=byId(NODE_IDS.removed),sink=byId(NODE_IDS.sink);
 if(source.length!==1||removed.length!==1||sink.length!==1||source[0].name!==SOURCE||removed[0].name!==REMOVED||sink[0].name!==SINK)fail(`${label}_IDENTITY`);
}
function transformGrowthCacheLayer(layer){
 if(!layer||!Array.isArray(layer.nodes)||layer.nodes.length!==6||!layer.connections)fail('LAYER_SHAPE');
 const one=(id,name,type,version)=>{const found=layer.nodes.filter(n=>n.id===id&&n.name===name&&n.type===type&&n.typeVersion===version);if(found.length!==1)fail('LAYER_IDENTITY');return found[0];};
 one(NODE_IDS.source,SOURCE,'n8n-nodes-base.httpRequest',4.2);
 const removed=one(NODE_IDS.removed,REMOVED,'n8n-nodes-base.code',2);
 const oldSink=one(NODE_IDS.sink,SINK,'n8n-nodes-base.postgres',2.5);
 if(typeof removed.parameters?.jsCode!=='string'||Object.keys(removed.parameters).length!==1)fail('LAYER_CODE');
 if(oldSink.parameters?.operation!=='executeQuery'||oldSink.parameters?.query!=='={{ $json.sql }}'||Object.keys(oldSink.parameters?.options||{}).length!==0)fail('LAYER_SINK');
 const incoming=[];for(const [from,channels] of Object.entries(layer.connections))for(const groups of Object.values(channels||{}))for(const group of groups||[])for(const edge of group||[])if(edge.node===REMOVED)incoming.push({from,edge});
 if(incoming.length!==1||incoming[0].from!==SOURCE||JSON.stringify(layer.connections[SOURCE])!==JSON.stringify({main:[[{node:REMOVED,type:'main',index:0}]]})||JSON.stringify(layer.connections[REMOVED])!==JSON.stringify({main:[[{node:SINK,type:'main',index:0}]]}))fail('LAYER_WIRING');
 const copy=clone(layer),nodes=copy.nodes.filter(n=>n.id!==NODE_IDS.removed);
 const sink=nodes.find(n=>n.id===NODE_IDS.sink);
 sink.parameters={operation:'executeQuery',query:SQL,options:{queryReplacement:QUERY_REPLACEMENT}};
 const connections=copy.connections;
 connections[SOURCE]={main:[[{node:SINK,type:'main',index:0}]]};
 delete connections[REMOVED];
 return {...copy,nodes,connections};
}

function patchGrowthCacheWorkflow(fresh){
 if(!fresh||fresh.id!==WORKFLOW_ID||fresh.active!==true||fresh.versionId!==VERSION_ID||fresh.activeVersionId!==VERSION_ID)fail('WORKFLOW');
 validateLayer(fresh.nodes,fresh.connections,'DRAFT');
 if(!fresh.activeVersion||fresh.activeVersion.versionId!==VERSION_ID||fresh.activeVersion.workflowId!==WORKFLOW_ID)fail('ACTIVE_VERSION');
 validateLayer(fresh.activeVersion.nodes,fresh.activeVersion.connections,'ACTIVE');
 const before={nodes:hash(fresh.nodes),connections:hash(fresh.connections),active_nodes:hash(fresh.activeVersion.nodes),active_connections:hash(fresh.activeVersion.connections)};
 const workflow=clone(fresh),draft=transformGrowthCacheLayer({nodes:workflow.nodes,connections:workflow.connections}),active=transformGrowthCacheLayer({nodes:workflow.activeVersion.nodes,connections:workflow.activeVersion.connections});
 workflow.nodes=draft.nodes;workflow.connections=draft.connections;workflow.activeVersion.nodes=active.nodes;workflow.activeVersion.connections=active.connections;
 const after={nodes:hash(workflow.nodes),connections:hash(workflow.connections),active_nodes:hash(workflow.activeVersion.nodes),active_connections:hash(workflow.activeVersion.connections)};
 const mutation={workflow_id:WORKFLOW_ID,version_id:VERSION_ID,removed_node_id:NODE_IDS.removed,source_node_id:NODE_IDS.source,sink_node_id:NODE_IDS.sink,sql_sha256:hash(SQL),query_replacement_sha256:hash(QUERY_REPLACEMENT)};
 return {workflow,receipt:{before,after,mutation,mutation_sha256:hash(mutation),columns:['painel','payload','gerado_em','bytes','origem_ms'],clock:'postgres_now',diagnostic_only:['blocos']}};
}

module.exports={WORKFLOW_ID,VERSION_ID,SOURCE,REMOVED,SINK,CLOCK,NODE_IDS,PINS,SQL,QUERY_REPLACEMENT,canonical,hash,payloadFrom,prepareCacheParameters,measureRunDataRepresentation,transformGrowthCacheLayer,patchGrowthCacheWorkflow};
