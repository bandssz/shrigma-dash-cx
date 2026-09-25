'use strict';
// Pure candidate builder: no network, database connection, or activation.
const {createHash}=require('node:crypto');
const NODE='Monta SQL elegíveis', MARKER='GROWTH_WA_CART_HOLDOUT_V1';
const WORKFLOWS={APG7xy5uY4YzU6vA:'aristo','4YidT1MdzugL4wWB':'fish'};
const sha256=code=>createHash('sha256').update(code).digest('hex');
const START='SELECT id, email, first_name, cart_url, cart_items, cart_id, cart_phone, cart_at, toque,\n';
const END=') unique_cart\nWHERE cart_rank = 1\nORDER BY id\nLIMIT 500;';
function replaceOnce(text,before,after){
 if(text.split(before).length!==2)throw Error('HOLDOUT_QUERY_SOURCE_DRIFT');
 return text.replace(before,()=>after);
}
function patchCode(code,brand){
 if(typeof code!=='string'||code.includes(MARKER)||!Object.values(WORKFLOWS).includes(brand))throw Error('HOLDOUT_CODE_INVALID_OR_ALREADY_PATCHED');
 // Keep base, guards, timing, optout, deduplication and variant expression intact.
 let next=replaceOnce(code,')\n'+START,'),\nranked AS (\n'+START);
 next=replaceOnce(next,END,`) unique_cart\nWHERE cart_rank = 1\n),\nholdout_decisions AS MATERIALIZED (\n  -- ${MARKER}: all eligible rows, both arms, before the send cap.\n  SELECT public.growth_wa_cart_holdout_gate_v1('${brand}',coalesce(jsonb_agg(jsonb_build_object(\n    'subscriber_id',id,'cart_ref',coalesce(substring(cart_id from '[0-9]+$'),cart_id),\n    'cart_at',cart_at,'phone',cart_phone,\n    'piece',CASE toque WHEN 't1' THEN 'carrinho-30min' ELSE 'carrinho-24h' END\n  )),'[]'::jsonb)) AS decisions\n  FROM ranked\n)\nSELECT r.* FROM ranked r CROSS JOIN holdout_decisions h\nWHERE (h.decisions->(r.id::text||'|'||coalesce(substring(r.cart_id from '[0-9]+$'),r.cart_id)||'|'||\n  CASE r.toque WHEN 't1' THEN 'carrinho-30min' ELSE 'carrinho-24h' END)->>'send')::boolean\nORDER BY r.id\nLIMIT 500;`);
 return next;
}
function patchWorkflow(fresh,{versionId,codeSha256}={}){
 if(!fresh||!WORKFLOWS[fresh.id]||fresh.active!==true||!versionId||fresh.versionId!==versionId||fresh.activeVersionId!==versionId)throw Error('HOLDOUT_VERSION_DRIFT');
 const active=fresh.activeVersion;
 if(!active||active.versionId!==versionId||JSON.stringify(active.nodes)!==JSON.stringify(fresh.nodes)||JSON.stringify(active.connections)!==JSON.stringify(fresh.connections))throw Error('HOLDOUT_ACTIVE_CONTENT_UNPROVEN');
 const out=structuredClone(fresh),nodes=out.nodes.filter(n=>n.name===NODE);
 if(nodes.length!==1||nodes[0].type!=='n8n-nodes-base.code'||!/^[0-9a-f]{64}$/.test(codeSha256||'')||sha256(nodes[0].parameters?.jsCode)!==codeSha256)throw Error('HOLDOUT_NODE_SOURCE_DRIFT');
 nodes[0].parameters.jsCode=patchCode(nodes[0].parameters.jsCode,WORKFLOWS[fresh.id]);
 return {workflow:out,proof:{marker:MARKER,workflowId:fresh.id,versionId,node:NODE,beforeSha256:codeSha256,afterSha256:sha256(nodes[0].parameters.jsCode),holdoutBps:500,candidateOnly:true,productionWrites:0}};
}
module.exports={NODE,MARKER,WORKFLOWS,START,END,sha256,patchCode,patchWorkflow};
