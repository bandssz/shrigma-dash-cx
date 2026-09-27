'use strict';
// Pure, reviewed-export patch. No filesystem, network, publication or transport.
const {createHash}=require('node:crypto');
const TARGETS=Object.freeze({
 NAmTWZ7vddQ8LX1k:Object.freeze({source:'alma',upsert:'Upsert VIP (Listmonk PG)'}),
 ywJDsgBDhZOBgoxb:Object.freeze({source:'desodorante',upsert:'Upsert VIP Desodorante (Listmonk PG)'})
});
const CODE='Montar boas-vindas',PREFIX='if ($json.eligible !== true) return [];\n';
const REPLACEMENT='={{ $json.email }},{{ $json.origem }},{{ $json.corrigido }}';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const graphHash=w=>digest({nodes:w.nodes,connections:w.connections,settings:w.settings});
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function check(ok,code){if(!ok)throw Error('VIP_CONSENT_PATCH_'+code);}
function patchVipConsent(workflow,guard){
 check(workflow&&Object.hasOwn(TARGETS,workflow.id),'TARGET');
 check(typeof guard?.version==='string'&&guard.version.length>0&&workflow.active===true&&workflow.versionId===guard.version&&workflow.activeVersionId===guard.version,'VERSION');
 check(Array.isArray(workflow.nodes)&&workflow.nodes.length>0&&workflow.connections&&typeof workflow.connections==='object'&&!Array.isArray(workflow.connections)&&workflow.settings&&typeof workflow.settings==='object','BODY');
 check(hash(guard.graphHash)&&guard.graphHash===graphHash(workflow),'GRAPH_HASH');
 check(guard.nodeHashes&&typeof guard.nodeHashes==='object'&&!Array.isArray(guard.nodeHashes),'NODE_HASH');
 const names=workflow.nodes.map(n=>n?.name);check(names.every(n=>typeof n==='string'&&n.length>0)&&new Set(names).size===names.length,'NODE_IDENTITY');
 check(Object.keys(guard.nodeHashes).length===names.length&&workflow.nodes.every(n=>hash(guard.nodeHashes[n.name])&&guard.nodeHashes[n.name]===digest(n)),'NODE_HASH');
 // GET may include the separately published version; when present it must agree.
 if(workflow.activeVersion!==undefined)check(workflow.activeVersion?.versionId===guard.version&&digest(workflow.activeVersion.nodes)===digest(workflow.nodes)&&digest(workflow.activeVersion.connections)===digest(workflow.connections),'PUBLISHED_BODY');
 const target=TARGETS[workflow.id],up=workflow.nodes.find(n=>n.name===target.upsert),code=workflow.nodes.find(n=>n.name===CODE);
 check(up?.type==='n8n-nodes-base.postgres'&&typeof up.parameters?.query==='string'&&up.parameters.query.trim().length>0&&up.credentials?.postgres?.id,'SQL_NODE');
 check(up.parameters.options?.queryReplacement===REPLACEMENT,'PARAMETERS');
 check(code?.type==='n8n-nodes-base.code'&&typeof code.parameters?.jsCode==='string'&&code.parameters.jsCode.trim().length>0,'CODE_NODE');
 check(!up.parameters.query.includes('shrigma_crm_vip_subscribe_v1')&&!code.parameters.jsCode.startsWith(PREFIX),'ALREADY_PATCHED');
 const patched=JSON.parse(JSON.stringify(workflow));
 patched.nodes.find(n=>n.name===target.upsert).parameters.query=`SELECT eligible,reason FROM public.shrigma_crm_vip_subscribe_v1($1,$2,$3::boolean,'${target.source}');`;
 patched.nodes.find(n=>n.name===CODE).parameters.jsCode=PREFIX+code.parameters.jsCode;
 return patched;
}
module.exports={TARGETS,CODE,PREFIX,REPLACEMENT,digest,graphHash,patchVipConsent};
