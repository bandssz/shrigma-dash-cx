/* Applies only recognized source anchors in a fresh private export. The caller
   owns fresh-version readback, permissions and deployment; this never publishes. */
'use strict';
function fresh(workflow,expectedVersion){
 if(!workflow||typeof expectedVersion!=='string'||!expectedVersion||workflow.versionId!==expectedVersion)throw Error('Fresh expected workflow version required');
 return JSON.parse(JSON.stringify(workflow));
}
function node(w,name){const ns=w.nodes?.filter(n=>n.name===name&&n.type==='n8n-nodes-base.postgres');if(ns?.length!==1||typeof ns[0].parameters?.query!=='string')throw Error('Recognized PostgreSQL node required');return ns[0];}
function patchCollector(workflow,{expectedVersion}){
 const w=fresh(workflow,expectedVersion),n=node(w,'Upsert Carrinhos (Listmonk PG)'),q=n.parameters.query;
 if(!q.includes('RETURNING id, status')||!q.includes('ON CONFLICT (email) DO UPDATE')||!q.includes("WHERE subscribers.status <> 'blocklisted'"))throw Error('Collector source drift');
 if(q.includes('AS journey_source_ids'))throw Error('Collector handoff already patched; inspect current export');
 const anchor='AS novos_na_base_geral;';if(q.split(anchor).length!==2)throw Error('Collector receipt drift');
 n.parameters.query=q.replace(anchor,"AS novos_na_base_geral,\n       COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM up),'[]'::jsonb) AS journey_source_ids;");
 return w;
}
function collectorHandoff(receipt,{brand}){
 if(brand!=='fish'||!Array.isArray(receipt)||receipt.length!==1)throw Error('Fish collector receipt required');
 const r=receipt[0],ids=r?.journey_source_ids;
 if(!Array.isArray(ids)||ids.length>200||ids.some(x=>!Number.isSafeInteger(x)||x<=0)||new Set(ids).size!==ids.length||Number(r.carrinhos_gravados)!==ids.length)throw Error('Collector identities unconfirmed');
 return {sourceIds:[...ids].sort((a,b)=>a-b),mode:'dry_run'};
}
function patchLegacySelector(workflow,{expectedVersion}){
 const w=fresh(workflow,expectedVersion),n=node(w,'Elegíveis (PG)'),q=n.parameters.query;
 if(!q.includes("THEN 't05'")||!q.includes("THEN 't1'")||!q.includes('cl.cart_at'))throw Error('Legacy selector source drift');
 if(q.includes('shrigma_journey_cart_owned_v1'))throw Error('Selector already patched; inspect current export');
 const anchor='WHERE cl.toque IS NOT NULL';if(q.split(anchor).length!==2)throw Error('Legacy selector receipt drift');
 n.parameters.query=q.replace(anchor,anchor+"\n  AND NOT ($2::text='fish' AND cl.toque='t05' AND public.shrigma_journey_cart_owned_v1(jsonb_build_object('brand',$2::text,'toque',cl.toque,'subscriber_id',cl.id,'ref',cl.cart_at)))");
 return w;
}
module.exports={patchCollector,collectorHandoff,patchLegacySelector};
