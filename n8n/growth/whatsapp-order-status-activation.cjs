'use strict';
// Preparation only: no database, network or workflow execution. Inputs containing
// operational copy and workflow exports, and this module's output, remain private.
const {createHash}=require('node:crypto');
const I=require('./whatsapp-order-status-integration.cjs');
const M=require('./whatsapp-order-status-proposal.cjs');
const RUNTIMES=Object.freeze({'caller:aristo':'54waQbYEjCHDLwgA','caller:fish':'EfSf4rTJb3krbBV2',motor:'xobYQ1VfScmUHVeV'});
const QUERY='SELECT public.shrigma_wa_order_status_activate_v1($1::text,$2::jsonb) AS result';
const clone=structuredClone;
function ensure(ok,message){if(!ok)throw Error(message);}
function stable(v){return JSON.stringify(sort(v));}
function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
function digest(v){return createHash('sha256').update(stable(v)).digest('hex');}
function code(workflow,name){const ns=workflow.nodes.filter(n=>n.name===name);ensure(ns.length===1&&typeof ns[0].parameters?.jsCode==='string','Expected code node missing');return ns[0].parameters.jsCode;}
function extractContracts(source,marker){
 ensure(source.startsWith('// '+marker+'\n'),'Order integration marker missing');
 const match=source.match(/^\/\/[^\n]+\nconst ORDER_STATUS_CONTRACTS=([^\n]+);\n/);
 ensure(match,'Exact contract declaration required');return JSON.parse(match[1]);
}
function runtimeReceipt(role,expected,readback,checkedAt=new Date().toISOString()){
 ensure(RUNTIMES[role]&&expected?.id===RUNTIMES[role]&&readback?.id===RUNTIMES[role],'Runtime identity changed');
 ensure(readback.active===true&&/^[0-9a-f-]{36}$/.test(readback.versionId)&&readback.activeVersionId===readback.versionId,'Active version unproven');
 const projection=w=>({nodes:w.nodes,connections:w.connections,settings:w.settings});
 ensure(stable(projection(expected))===stable(projection(readback)),'Runtime readback differs');
 const active=readback.activeVersion;
 ensure(active?.versionId===readback.versionId&&active.workflowId===readback.id&&stable(active.nodes)===stable(expected.nodes)&&stable(active.connections)===stable(expected.connections),'Active code readback differs');
 let contracts;
 if(role==='motor'){
  contracts=extractContracts(code(readback,'Aplica fluxo publicado'),I.MOTOR_MARKER);
  ensure(stable(contracts)===stable(extractContracts(code(readback,'Valida template UTILITY'),I.GUARD_MARKER)),'Motor guards use different contracts');
  ensure(code(readback,'Interpreta resposta').includes('WA_UNCERTAIN_RESERVATION_V1'),'Reservation guard missing');
 }else ensure(code(readback,'Monta componentes').startsWith('// '+I.CALLER_MARKER+'\n'),'Caller source patch missing');
 const result={role,workflow_id:readback.id,active:true,readback_exact:true,version_id:readback.versionId,active_version_id:readback.activeVersionId,expected_code_sha256:digest(projection(expected)),code_sha256:digest(projection(readback)),checked_at:checkedAt};
 if(contracts)result.contracts=contracts;
 return result;
}
function buildActivationRequest({operationKey,proposals,catalog,flows,runtimeReceipts,catalogCheckedAt,now=Date.now()}){
 ensure(/^[A-Za-z0-9_.:-]{8,128}$/.test(operationKey||''),'Persistent operation key required');
 const fresh=t=>Number.isFinite(Date.parse(t))&&Date.parse(t)<=now+30000&&Date.parse(t)>=now-15*60000;
 ensure(fresh(catalogCheckedAt),'Current successful catalog read required');
 const contracts=I.buildContracts(proposals,catalog,flows),plan=I.planStageSwitch(flows,contracts);
 ensure(contracts.length===6&&plan.updates.length===4,'All six stages and four flows required');
 ensure(Array.isArray(runtimeReceipts)&&runtimeReceipts.length===3&&new Set(runtimeReceipts.map(r=>r.role)).size===3,'Three independent active readbacks required');
 for(const r of runtimeReceipts){
  ensure(r.workflow_id===RUNTIMES[r.role]&&r.active===true&&r.readback_exact===true&&r.version_id===r.active_version_id&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.version_id||'')&&/^[0-9a-f]{64}$/.test(r.code_sha256||'')&&r.code_sha256===r.expected_code_sha256&&fresh(r.checked_at),'Current exact runtime readback required');
  if(r.role==='motor')ensure(stable(r.contracts)===stable(contracts),'Active motor contract differs');
 }
 const ids=new Set(contracts.flatMap(c=>[c.source_template_id,c.target.id]));
 const approved=catalog.filter(t=>ids.has(String(t.id))).map(t=>({brand:t.brand,id:String(t.id),name:t.name,status:t.status,language:t.language,category:t.category,components:M.reviewedComponents(t.components)}));
 ensure(approved.length===12&&new Set(approved.map(t=>t.id)).size===12,'Exact source and target catalog required');
 return {idempotency_key:operationKey,catalog_checked_at:catalogCheckedAt,catalog:approved,contracts,updates:plan.updates,runtime:clone(runtimeReceipts)};
}
module.exports={RUNTIMES,QUERY,runtimeReceipt,buildActivationRequest};
