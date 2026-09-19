'use strict';
// Read-time guard only. It does not establish original Appmax charge payment,
// attribution or fulfillment. Reuse the existing Shopify order relationship.
function strictInstant(value) {
 if(typeof value!=='string')return null;
 const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
 if(!m)return null;
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
 if(year<1970||month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)return null;
 if(m[8]!=='Z'&&(Number(m[8].slice(1,3))>14||Number(m[8].slice(4,6))>59||(Number(m[8].slice(1,3))===14&&Number(m[8].slice(4,6))!==0)))return null;
 const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;
}
function evaluateTransactionOrder(response,request,nowMs) {
 const fail=reason=>({eligible:false,reason});
 if(!Number.isFinite(nowMs))return fail('relogio_validacao_invalido');
 if(!request||!/^\d+$/.test(String(request.order_id))||!['pedido-pago','rastreio-criado'].includes(request.piece))return fail('referencia_transacional_invalida');
 if(!response||typeof response!=='object'||response.error||(Array.isArray(response.errors)&&response.errors.length))return fail('shopify_consulta_indisponivel');
 const order=response.data?.order;
 if(!order||typeof order!=='object'||Array.isArray(order))return fail('shopify_sem_pedido');
 if(order.id!=='gid://shopify/Order/'+request.order_id)return fail('pedido_divergente');
 if(order.test!==false)return fail(order.test===true?'pedido_de_teste':'pedido_test_desconhecido');
 if(order.cancelledAt!==null)return fail(order.cancelledAt?'pedido_cancelado':'cancelamento_desconhecido');
 if(!['PENDING','AUTHORIZED','PARTIALLY_PAID','PAID','PARTIALLY_REFUNDED','REFUNDED','VOIDED','EXPIRED'].includes(order.displayFinancialStatus))return fail('estado_financeiro_desconhecido');
 if(['REFUNDED','VOIDED','EXPIRED'].includes(order.displayFinancialStatus))return fail('pedido_encerrado');
 if(request.piece==='pedido-pago'){
  if(order.displayFinancialStatus!=='PAID')return fail('pedido_nao_pago');
  if(!Array.isArray(order.transactions))return fail('transacoes_pagamento_indisponiveis');
  let proved=false;
  for(const tx of order.transactions){
   if(!tx||typeof tx!=='object'||typeof tx.kind!=='string'||typeof tx.status!=='string')return fail('transacao_pagamento_malformada');
   if(!['SALE','CAPTURE'].includes(tx.kind)||tx.status!=='SUCCESS')continue;
   if(tx.test!==false)return fail(tx.test===true?'transacao_de_teste':'transacao_test_desconhecido');
   const at=strictInstant(tx.processedAt);
   if(at===null)return fail('instante_pagamento_indisponivel');
   if(at>nowMs)return fail('instante_pagamento_futuro');
   proved=true;
  }
  if(!proved)return fail('sem_sale_ou_capture_success');
 }
 return {eligible:true,reason:null};
}
const OLD_QUERY="const GQL = 'query($id: ID!) { order(id: $id) { name displayFinancialStatus phone customer { phone } shippingAddress { phone } } }';";
const NEW_QUERY="const GQL = 'query($id: ID!) { order(id: $id) { id name displayFinancialStatus test cancelledAt transactions { kind status test processedAt } phone customer { phone } shippingAddress { phone } } }';";
const ANCHOR='  const o = (item.json.data && item.json.data.order) || null;';
const MARKER='WA_FISH_TRANSACTION_GUARD_V1';
const GLUE='\n  // '+MARKER+'; an unknown state cannot reach the sender.\n  const guard = evaluateTransactionOrder(item.json,r,Date.now());\n  if(!guard.eligible){saida.push({json:{_skip:guard.reason,brand:"fish",piece:r.piece,ref:r.order_id}});return;}';
const DEFINITIONS=strictInstant.toString()+'\n'+evaluateTransactionOrder.toString()+'\n';
function patchWorkflow(fresh,{expectedVersionId}={}){
 if(!fresh||!Array.isArray(fresh.nodes)||!expectedVersionId||fresh.versionId!==expectedVersionId)throw Error('A fresh export and matching expectedVersionId are required');
 const workflow=JSON.parse(JSON.stringify(fresh)),changes=[];
 const find=name=>{const found=workflow.nodes.filter(n=>n.name===name);if(found.length!==1||found[0].type!=='n8n-nodes-base.code')throw Error('Expected one code node: '+name);return found[0];};
 const route=find('Roteia evento → peça'),mount=find('Monta componentes');
 const routeCode=route.parameters?.jsCode,mountCode=mount.parameters?.jsCode;
 if(typeof routeCode!=='string'||typeof mountCode!=='string')throw Error('Missing node code');
 if(mountCode.includes(MARKER)){
  if(!mountCode.startsWith(DEFINITIONS)||!mountCode.includes(GLUE)||!routeCode.includes(NEW_QUERY))throw Error('Unrecognized transaction guard patch');
  return {workflow,changes};
 }
 if(routeCode.split(OLD_QUERY).length!==2||mountCode.split(ANCHOR).length!==2)throw Error('Transaction workflow changed; review fresh export');
 route.parameters.jsCode=routeCode.replace(OLD_QUERY,NEW_QUERY);
 mount.parameters.jsCode=DEFINITIONS+mountCode.replace(ANCHOR,ANCHOR+GLUE);
 changes.push({node:route.name,field:'jsCode'},{node:mount.name,field:'jsCode'});
 return {workflow,changes};
}
module.exports={strictInstant,evaluateTransactionOrder,patchWorkflow,OLD_QUERY,NEW_QUERY,ANCHOR,MARKER};
