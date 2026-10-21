'use strict';
// Read the original actor-owned receipt only. No claim, recovery, replay,
// status translation or manufactured native success is performed here.
const SQL=`WITH verified AS MATERIALIZED (SELECT public.shrigma_crm_campaign_auth_v1($1::text) auth)
 SELECT jsonb_build_object('auth',v.auth,'operation',
  CASE WHEN v.auth->>'actor'=$2::text AND v.auth->'caps' ? 'read_content' THEN
   (SELECT jsonb_build_object('id',o.id,'operation_key',o.operation_key,'brand',o.brand,
    'action',o.action,'state',o.state,'providerId',o.provider_id,'response',o.response,
    'created_at',o.created_at,'updated_at',o.updated_at)
    FROM public.shrigma_campaign_operation o
    WHERE o.actor=$2::text AND o.operation_key=$3::text AND o.brand=$4::text)
  ELSE NULL END) result FROM verified v`;
const fail=(status,error)=>Object.assign(Error(error),{status,body:{error,message:'Operação não confirmada.'}});
function createNativeHistory({query}){
 if(typeof query!=='function')throw Error('NATIVE_HISTORY_CONFIG');
 const supports=command=>command?.acao==='campanha_operacao';
 async function execute({key,auth,command,interrupted=()=>false}){
  if(!supports(command))return null;
  if(!auth?.actor||!Array.isArray(auth.caps)||!auth.caps.includes('read_content'))throw fail(403,'CAPABILITY_MISSING');
  if(!['aristo','fish'].includes(command.brand)||typeof command.idempotency_key!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(command.idempotency_key))throw fail(422,'REQUEST_INVALID');
  if(interrupted())throw fail(503,'READ_UNAVAILABLE');
  const rows=(await query(SQL,[key,auth.actor,command.idempotency_key,command.brand]))?.rows;
  if(rows?.length!==1||!rows[0].result)throw fail(503,'OPERATION_READ_UNCONFIRMED');
  const proof=rows[0].result;
  if(proof.auth?.actor!==auth.actor||!proof.auth.caps?.includes('read_content')||Object.hasOwn(proof.auth,'brand')&&proof.auth.brand!==command.brand||interrupted())throw fail(403,'AUTHORIZATION_CHANGED');
  if(!proof.operation||proof.operation.brand!==command.brand)throw fail(404,'OPERATION_NOT_FOUND');
  return {status:200,body:{operation:proof.operation}};
 }
 return Object.freeze({supports,execute});
}
module.exports={createNativeHistory,SQL};
