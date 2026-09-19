/* Pure patch generator. The caller supplies a fresh private export and version.
   Preserves every other node, setting and credential reference. No runtime I/O. */
'use strict';
const OLD="|| jsonb_build_object('last_order_at', $4::text)";
const NEXT="|| jsonb_build_object('last_order_at', CASE\n                             WHEN (CASE WHEN s.attribs->$2->>'last_order_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (s.attribs->$2->>'last_order_at')::timestamptz END) >= $4::timestamptz\n                             THEN s.attribs->$2->>'last_order_at' ELSE $4::text END)";
function patchOrderResolution(workflow,{expectedVersion}={}){
 if(!workflow||typeof expectedVersion!=='string'||!expectedVersion||workflow.versionId!==expectedVersion)throw Error('Fresh workflow version required');
 const result=JSON.parse(JSON.stringify(workflow)),node=result.nodes?.find(n=>n.name==='Resolve carrinho (PG)'&&n.type==='n8n-nodes-base.postgres');
 if(!node||typeof node.parameters?.query!=='string')throw Error('Order resolution node unavailable');
 let q=node.parameters.query;
 if(q.includes('CART_ORDER_MONOTONIC_V1')){
  if(!q.includes(NEXT))throw Error('Order resolution patch drift');return result;
 }
 if(q.split(OLD).length!==2||q.split('FROM alvo a\n  WHERE s.id = a.id').length!==2)throw Error('Order resolution SQL drift');
 // The UPDATE locks the subscriber row; compute the old timestamp from that
 // row in the assignment expression, not from a stale materialized CTE snapshot.
 q=q.replace(OLD,NEXT);q='-- CART_ORDER_MONOTONIC_V1: older order events cannot regress the purchase marker.\n'+q;
 node.parameters.query=q;return result;
}
module.exports={patchOrderResolution};
