/* Pure candidate patch, never deploys. Collector -> exact receipt -> downstream
 * capture adapter. No enroll/claim/transport node is added. */
'use strict';
const {randomUUID}=require('node:crypto');
const SOURCE='journey_graph_source_v1';
function graphMoney(value){if(typeof value==='string'&&!/^(0|[1-9][0-9]*)([.][0-9]+)?$/.test(value)||!['string','number'].includes(typeof value))return null;const n=Number(value);return Number.isFinite(n)&&n>=0&&n<=1e9?n:null;}
function patchNormalizer(code){if(typeof code!=='string'||code.includes('graphMoney'))throw Error('GRAPH_SOURCE_NORMALIZER_DRIFT');for(const [a,b]of [["Number(e.node.originalUnitPriceSet?.shopMoney?.amount || 0)","graphMoney(e.node.originalUnitPriceSet?.shopMoney?.amount)"],["Number(n.totalPriceSet?.shopMoney?.amount || 0)","graphMoney(n.totalPriceSet?.shopMoney?.amount)"]]){if(code.split(a).length!==2)throw Error('GRAPH_SOURCE_NORMALIZER_DRIFT');code=code.replace(a,b);}return 'const graphMoney='+graphMoney.toString()+';\n'+code;}
function patchCollector(w,{expectedVersion,brand}={}){
 if(!w||w.versionId!==expectedVersion||!expectedVersion||!['fish','aristo'].includes(brand))throw Error('GRAPH_SOURCE_WORKFLOW_VERSION');
 const c=JSON.parse(JSON.stringify(w)),nodes=c.nodes||[],up=nodes.filter(n=>n.name==='Upsert Carrinhos (Listmonk PG)'&&n.type==='n8n-nodes-base.postgres'),reconcile=nodes.filter(n=>n.name==='Reconciliação 4 Listas (PG)'&&n.type==='n8n-nodes-base.postgres'),config=nodes.filter(n=>n.name==='Config');
 const values=Object.fromEntries((config[0]?.parameters?.assignments?.assignments||[]).map(x=>[x.name,x.value]));
 if(up.length!==1||reconcile.length!==1||config.length!==1||values.brand!==brand||values.list_base!==(brand==='fish'?17:16)||values.list_carrinho!==(brand==='fish'?22:21)||!reconcile[0].parameters?.query?.includes('AS flags_sincronizados'))throw Error('GRAPH_SOURCE_WORKFLOW_BINDING');
 if(config[0].parameters.assignments.assignments.some(x=>x.name==='graph_source_started_at'))throw Error('GRAPH_SOURCE_ALREADY_PATCHED');
 config[0].parameters.assignments.assignments.push({id:randomUUID(),name:'graph_source_started_at',value:'={{ new Date().toISOString() }}',type:'string'});
 const normalizer=nodes.filter(n=>n.name==='Normalizar Carrinhos'&&n.type==='n8n-nodes-base.code');if(normalizer.length!==1)throw Error('GRAPH_SOURCE_NORMALIZER_DRIFT');normalizer[0].parameters.jsCode=patchNormalizer(normalizer[0].parameters?.jsCode);
 const q=up[0].parameters?.query||'',returning='RETURNING id, status',anchor='AS novos_na_base_geral;';
 if(q.split(returning).length!==2||q.split(anchor).length!==2||!q.includes("WHERE subscribers.status <> 'blocklisted'"))throw Error('GRAPH_SOURCE_COLLECTOR_DRIFT');
 up[0].parameters.query=q.replaceAll('jsonb_build_object($2,','jsonb_build_object($2::text,').replace(returning,'RETURNING id, status, attribs, email').replace(anchor,`AS novos_na_base_geral,
 to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS graph_persisted_at,
 coalesce((SELECT jsonb_agg(jsonb_build_object('subscriber_id',u.id,'ref',u.attribs->$2->>'cart_abandoned_at','cart_hash',encode(sha256(convert_to(u.attribs->$2->>'cart_id','UTF8')),'hex'),'material_hash',encode(sha256(convert_to(crm_graph_candidate.source_material_v1(u.attribs->$2,u.attribs->>'first_name')::text,'UTF8')),'hex')) ORDER BY u.id) FROM up u JOIN novo n ON n.email=u.email AND (u.attribs->$2) @> n.estado),'[]'::jsonb) AS graph_source_items;`);
 // The receipts are read after reconciliation, preserving its original Resumo.
 const next=c.connections?.['Reconciliação 4 Listas (PG)']?.main?.[0],fromUp=c.connections?.['Upsert Carrinhos (Listmonk PG)']?.main?.[0];
 if(!Array.isArray(next)||next.length!==1||next[0].node!=='Resumo'||!Array.isArray(fromUp)||fromUp.length!==1||fromUp[0].node!=='Reconciliação 4 Listas (PG)')throw Error('GRAPH_SOURCE_COLLECTOR_ORDER');
 const name='Graph source receipts (candidate)';if(nodes.some(n=>n.name===name))throw Error('GRAPH_SOURCE_ALREADY_PATCHED');
 const code=`const makeBatches=${makeBatches.toString()};return makeBatches($('Upsert Carrinhos (Listmonk PG)').all().map(x=>x.json),$input.all().map(x=>x.json),{brand:${JSON.stringify(brand)},executionId:String($execution.id),workflowId:String($workflow.id),observedAt:$('Config').first().json.graph_source_started_at}).map(json=>({json}));`;
 nodes.push({id:randomUUID(),name,type:'n8n-nodes-base.code',typeVersion:2,position:[0,900],parameters:{mode:'runOnceForAllItems',jsCode:code},retryOnFail:false});next.push({node:name,type:'main',index:0});
 return c;
}
function makeBatches(receipts,reconciliation,{brand,executionId,workflowId,observedAt}){
 const counts=['compradores_add','leads_removidos','leads_add','carrinho_add','carrinho_removidos','flags_sincronizados'];
 if(!['fish','aristo'].includes(brand)||!Array.isArray(reconciliation)||reconciliation.length!==1||!counts.every(k=>/^\d+$/.test(String(reconciliation[0]?.[k])))||!Array.isArray(receipts)||receipts.length<1||receipts.length>20||!/^\d{1,20}$/.test(executionId)||!/^\w{8,32}$/.test(workflowId||'')||typeof observedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)||!Number.isFinite(Date.parse(observedAt)))throw Error('GRAPH_SOURCE_RECONCILIATION');
 const all=[],seen=new Set();for(const r of receipts){if(!Array.isArray(r.graph_source_items)||r.graph_source_items.length>2000||!Number.isSafeInteger(Number(r.carrinhos_gravados))||Number(r.carrinhos_gravados)<r.graph_source_items.length||typeof r.graph_persisted_at!=='string'||!Number.isFinite(Date.parse(r.graph_persisted_at))||Date.parse(r.graph_persisted_at)<Date.parse(observedAt))throw Error('GRAPH_SOURCE_RECEIPT');for(const item of r.graph_source_items){if(!Number.isSafeInteger(item.subscriber_id)||item.subscriber_id<1||seen.has(item.subscriber_id)||!/^\d{4}-\d{2}-\d{2}T/.test(item.ref)||!/^[a-f0-9]{64}$/.test(item.cart_hash)||!/^[a-f0-9]{64}$/.test(item.material_hash))throw Error('GRAPH_SOURCE_RECEIPT');seen.add(item.subscriber_id);if(seen.size>2000)throw Error('GRAPH_SOURCE_BATCH_LIMIT');all.push({item,at:observedAt});}}
 // Timestamp precedes all Shopify requests; long jobs expire rather than renew.
 // Separate batches by observed time. captureHandoff binds a stable receipt UUID
 // to the allowlisted collector+execution+batch. No runtime entry is authorized.
 const out=[];for(const at of [...new Set(all.map(x=>x.at))]){const items=all.filter(x=>x.at===at).map(x=>x.item).sort((a,b)=>a.subscriber_id-b.subscriber_id);for(let i=0;i<items.length;i+=200)out.push({version:'journey_graph_source_v1',brand,reconciled:true,workflow_id:workflowId,execution_id:executionId,batch_index:out.length,observed_at:at,items:items.slice(i,i+200),authorizes_enrollment:false,authorizes_send:false});}return out;
}
module.exports={SOURCE,patchCollector,makeBatches,graphMoney,patchNormalizer};
