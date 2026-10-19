'use strict';
// campanha_operacao_abandonar (DESLIGADO por padrão: CRM_CAMPAIGN_ABANDON_ENABLED).
// Uma única chamada SQL parametrizada; a lápide, o lock e a cerca ficam no banco
// (n8n/growth/campaign-pending-recovery.sql). Repetir é seguro: mesma chave, mesma lápide.
const ABANDON_SQL='SELECT public.shrigma_crm_campaign_abandon_v1($1::text,$2::jsonb) AS result';
const ACTION='campanha_operacao_abandonar',POLICY='crm-campaign-abandon-v1';
const FIELDS=['k','acao','brand','idempotency_key','operation_action','confirm'];
const problem=(status,error,message)=>Object.assign(Error(message),{status,body:{error,message}});
const ERRORS={
 CRM_CAMPAIGN_GATEWAY_UNAUTHORIZED:[401,'UNAUTHORIZED','Autenticação necessária.'],
 CRM_CAMPAIGN_GATEWAY_FORBIDDEN:[403,'CAPABILITY_MISSING','Esta chave não permite esta operação.'],
 ABANDON_INPUT:[422,'REQUEST_INVALID','Solicitação inválida.'],
 ABANDON_DISABLED:[503,'ABANDON_DISABLED','O encerramento de tentativas ainda não está disponível.'],
 ABANDON_ACTION_UNSUPPORTED:[422,'ABANDON_ACTION_UNSUPPORTED','Só tentativas de agendar ou cancelar podem ser encerradas aqui. Criação de rascunho segue pela conciliação da operação.'],
 ABANDON_IDENTITY_MISMATCH:[409,'ABANDON_IDENTITY_MISMATCH','A tentativa não pertence a esta chave, marca ou ação. Nada foi alterado.'],
 ABANDON_LEASE_ACTIVE:[409,'ABANDON_LEASE_ACTIVE','A tentativa ainda está no prazo e pode concluir. Consulte de novo depois do prazo; nada foi alterado.'],
 ABANDON_LEASE_UNKNOWN:[409,'ABANDON_LEASE_UNKNOWN','Esta tentativa é anterior ao prazo controlado e não pode ser encerrada pelo painel. Peça a conciliação da operação.']
};
function parseAbandon(req,url,body){
 if(req.method!=='POST')throw problem(405,'METHOD_INVALID','Método incompatível com a ação.');
 if([...url.searchParams].length)throw problem(422,'REQUEST_INVALID','Solicitação inválida.');
 if(req.rawHeaders.filter((_,i)=>i%2===0).filter(h=>h.toLowerCase()==='authorization').length>1)throw problem(401,'UNAUTHORIZED','Autenticação necessária.');
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!FIELDS.includes(k))||FIELDS.some(k=>!Object.hasOwn(body,k)))throw problem(422,'REQUEST_FIELD_INVALID','Campo não permitido.');
 if(body.acao!==ACTION)throw problem(400,'ACTION_INVALID','Ação desconhecida.');
 if(typeof body.k!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(body.k))throw problem(401,'UNAUTHORIZED','Autenticação necessária.');
 if(!['fish','aristo'].includes(body.brand)||typeof body.idempotency_key!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(body.idempotency_key))throw problem(422,'REQUEST_INVALID','Solicitação inválida.');
 if(!['agendar','cancelar'].includes(body.operation_action))throw problem(422,'ABANDON_ACTION_UNSUPPORTED',ERRORS.ABANDON_ACTION_UNSUPPORTED[2]);
 if(body.confirm!=='abandonar')throw problem(422,'CONFIRM_REQUIRED','Confirme o encerramento desta tentativa sem efeito.');
 const {k,...command}=body;return {key:k,command};
}
function createAbandonExecutor({pool}){
 return async({key,command,interrupted=()=>false})=>{
  if(interrupted())return {status:503,body:{error:'READ_UNAVAILABLE',message:'Consulta não concluída. Repita o encerramento com a mesma chave; ele é idempotente.'}};
  let rows;
  try{rows=(await pool.query(ABANDON_SQL,[key,JSON.stringify(command)]))?.rows;}
  catch(e){
   if(e?.code==='P0001'&&Object.hasOwn(ERRORS,e.message)){const [status,error,message]=ERRORS[e.message];return {status,body:{error,message}};}
   if(['55P03','40P01','40001'].includes(e?.code))return {status:409,body:{error:'OPERATION_BUSY',message:'A tentativa está sendo concluída agora. Consulte a operação; nada foi alterado por este pedido.'}};
   return {status:503,body:{error:'ABANDON_UNCONFIRMED',message:'Encerramento não confirmado. Consulte a operação ou repita com a mesma chave; repetir não cria efeito.'}};
  }
  const r=rows?.length===1?rows[0].result:null,op=r?.operation;
  if(r?.policy!==POLICY||typeof r.abandoned!=='boolean'||!op||op.operation_key!==command.idempotency_key||op.brand!==command.brand)
   return {status:503,body:{error:'ABANDON_UNCONFIRMED',message:'Encerramento não confirmado. Consulte a operação ou repita com a mesma chave; repetir não cria efeito.'}};
  return {status:200,body:{policy:POLICY,abandoned:r.abandoned,created:r.created===true,operation:op}};
 };
}
module.exports={ABANDON_SQL,ACTION,POLICY,parseAbandon,createAbandonExecutor};
