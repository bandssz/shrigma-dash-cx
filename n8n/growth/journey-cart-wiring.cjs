/* Build-time preparation only. No database/HTTP/activation call. Runtime exports
   remain private. The generated handoff ends in dry-run batches after the four
   list reconciliation; it does not enroll, claim or send. */
'use strict';
const {patchCollector}=require('./journey-cart-runtime-patch.cjs');

function collectorBatches(receipts,{brand,reconciliation,batchSize=200}={}){
 const count=v=>(Number.isSafeInteger(v)&&v>=0)||(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&Number.isSafeInteger(Number(v)));
 const keys=['compradores_add','leads_removidos','leads_add','carrinho_add','carrinho_removidos','flags_sincronizados'];
 if(brand!=='fish'||!Array.isArray(reconciliation)||reconciliation.length!==1||!keys.every(k=>count(reconciliation[0]?.[k])))throw Error('Completed Fish four-list reconciliation receipt required');
 if(!Array.isArray(receipts)||!receipts.length||!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>200)throw Error('Bounded collector receipts required');
 const all=[],seen=new Set();
 for(const r of receipts){
  const ids=r?.journey_source_ids;
  if(!Array.isArray(ids)||ids.length>2000||!count(r.carrinhos_gravados)||Number(r.carrinhos_gravados)!==ids.length||!count(r.novos_na_base_geral))throw Error('Collector source receipt unconfirmed');
  for(const id of ids){
   if(!Number.isSafeInteger(id)||id<=0||seen.has(id))throw Error('Collector source identity unconfirmed');
   seen.add(id);all.push(id);
  }
 }
 // Match the scanner's deterministic bounded ordering. Do not truncate a 2,000
 // source collector batch to the scanner's 200-source admission limit.
 all.sort((a,b)=>a-b);
 const batches=[];
 for(let offset=0;offset<all.length;offset+=batchSize)batches.push({brand:'fish',mode:'dry_run',sourceIds:all.slice(offset,offset+batchSize)});
 return {mode:'dry_run',source_count:all.length,collector_receipts:receipts.length,batches};
}

function prepareCollectorHandoff(workflow,{expectedVersion}={}){
 const w=patchCollector(workflow,{expectedVersion});
 const rec=w.nodes.filter(n=>n.name==='Reconciliação 4 Listas (PG)'&&n.type==='n8n-nodes-base.postgres');
 const config=w.nodes.filter(n=>n.name==='Config'&&n.type==='n8n-nodes-base.set');
 const name='J1 lotes após reconciliação';
 if(rec.length!==1||config.length!==1||w.nodes.some(n=>n.name===name))throw Error('Collector reconciliation wiring unavailable');
 const fields=config[0].parameters?.assignments?.assignments;
 const values=Object.fromEntries((fields||[]).map(x=>[x.name,x.value]));
 // IDs are the existing Fish contract, not new lists. No membership is changed.
 const expected={brand:'fish',list_base:17,list_compradores:3,list_leads:9,list_carrinho:22,ttl_dias:30};
 if(!Object.entries(expected).every(([k,v])=>values[k]===v))throw Error('Fish list binding drift');
 const q=rec[0].parameters?.query||'',binding=rec[0].parameters?.options?.queryReplacement||'';
 if(!q.includes('AS flags_sincronizados')||!q.includes('AS carrinho_removidos')||!q.includes('AS compradores_add')||
  !['list_base','list_compradores','list_leads','brand','list_carrinho','ttl_dias'].every(k=>binding.includes('.json.'+k)))throw Error('Four-list SQL binding drift');
 const upstream=w.connections?.['Upsert Carrinhos (Listmonk PG)']?.main?.[0];
 const next=w.connections?.['Reconciliação 4 Listas (PG)']?.main?.[0];
 if(!Array.isArray(upstream)||upstream.length!==1||upstream[0].node!=='Reconciliação 4 Listas (PG)'||
  !Array.isArray(next)||next.length!==1||next[0].node!=='Resumo')throw Error('Collector ordering drift');
 const code=`const collectorBatches = ${collectorBatches.toString()};\nconst plan=collectorBatches($('Upsert Carrinhos (Listmonk PG)').all().map(i=>i.json),{brand:$('Config').first().json.brand,reconciliation:$input.all().map(i=>i.json)});\nreturn plan.batches.map(json=>({json,pairedItem:{item:0}}));`;
 w.nodes.push({id:'journey-cart-handoff-v1',name,type:'n8n-nodes-base.code',typeVersion:2,
  position:[(rec[0].position?.[0]||0)+300,(rec[0].position?.[1]||0)+220],parameters:{mode:'runOnceForAllItems',jsCode:code},retryOnFail:false});
 // Append a separate terminal branch: the existing Resumo keeps its original
 // reconciliation input. No Execute Workflow/HTTP node is added implicitly.
 next.push({node:name,type:'main',index:0});
 return w;
}
function buildCartAdapterBundle(){
 const fs=require('node:fs'),path=require('node:path');
 const wrap=file=>`(()=>{const module={exports:{}};\n${fs.readFileSync(path.join(__dirname,file),'utf8')}\nreturn module.exports;})()`;
 // Both adapters accept injected query functions and perform no I/O themselves.
 // They can run in Code without require, but n8n still needs a trusted PG-node
 // effect/receipt bridge; this bundle is not a database connection or transport.
 return `const ShrigmaCartAdapters=(()=>{const entries=${wrap('journey-cart-provider.cjs')};const scanner=${wrap('journey-cart-scanner.cjs')};return {...entries,...scanner};})();`;
}
module.exports={collectorBatches,prepareCollectorHandoff,buildCartAdapterBundle};
