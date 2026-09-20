/* Shared pure validation for the descriptive A/B registry; no credentials or I/O. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GABProtocol=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
function createProtocol(){
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 const text=(v,max,empty=false)=>typeof v==='string'&&v.length<=max&&(empty||!!v.trim());
 const id=v=>text(v,256)&&v===v.trim();
 const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
 const actor=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 function request(b,principal){
  if(!object(b)||!actor(principal)||!uuid(b.operation_id)||!['criar','encerrar'].includes(b.acao)||!Number.isSafeInteger(b.expected_version)||b.expected_version<0||b.expected_version>999999999999999||!id(b.teste?.teste_id))throw Error('AB_INVALID_REQUEST');
  const t=b.teste,arms=b.bracos;
  if(b.acao==='criar'){
   if(b.expected_version!==0||!exact(t,['teste_id','marca','canal','nome','hipotese','variavel','metrica_primaria','efeito_minimo'])||!['aristo','fish','olivas'].includes(t.marca)||!['email','whatsapp'].includes(t.canal)
    ||!['nome','hipotese','variavel','metrica_primaria'].every(k=>text(t[k],4000))||t.efeito_minimo!==null&&!(typeof t.efeito_minimo==='number'&&Number.isFinite(t.efeito_minimo)&&t.efeito_minimo>=0&&t.efeito_minimo<=1000000)
    ||!Array.isArray(arms)||arms.length<2||arms.length>20)throw Error('AB_INVALID_CREATE');
   for(const a of arms)if(!exact(a,['braco','campanha_id','utm_term','descricao'])||!text(a.braco,64)||!text(a.utm_term,256,true)||a.descricao!==null&&!text(a.descricao,4000,true)||a.campanha_id!==null&&!(Number.isInteger(a.campanha_id)&&a.campanha_id>0&&a.campanha_id<=2147483647))throw Error('AB_INVALID_ARM');
   if(new Set(arms.map(a=>a.braco)).size!==arms.length)throw Error('AB_DUPLICATE_ARM');
  }else if(!exact(t,['teste_id','status','vencedor','conclusao'])||t.status!=='inconclusivo'||t.vencedor!==null||!text(t.conclusao,8000,true)||arms!==null)throw Error('AB_INVALID_CLOSE');
  const p={actor_sha256:principal,operation_id:b.operation_id,action:b.acao,teste_id:t.teste_id,request_payload:{acao:b.acao,expected_version:b.expected_version,teste:t,bracos:arms}};
  if(JSON.stringify(p).length>65536)throw Error('AB_REQUEST_TOO_LARGE');
  return JSON.parse(JSON.stringify(p)); // Key/header/extra caller identity never enter SQL.
 }
 function read(q,principal){
  if(!object(q)||!actor(principal))throw Error('AB_INVALID_QUERY');
  if(q.acao==='capacidades')return {mode:'capabilities',payload:{actor_sha256:principal}};
  if(!id(q.teste_id))throw Error('AB_INVALID_QUERY');
  if(q.acao==='registro')return {mode:'record',payload:{actor_sha256:principal,teste_id:q.teste_id}};
  if(q.acao!=='operacao'||!uuid(q.operation_id)||!['criar','encerrar'].includes(q.operacao))throw Error('AB_INVALID_QUERY');
  return {mode:'operation',payload:{actor_sha256:principal,operation_id:q.operation_id,action:q.operacao,teste_id:q.teste_id}};
 }
 const query=(mode,payload)=>({sql:'SELECT public.crm_ab_registry_v1($1::text,$2::jsonb) AS result',parameters:[mode,JSON.stringify(payload)]});
 function response(value){
  if(!object(value)||!Number.isInteger(value.status)||value.status<200||value.status>599||!object(value.body))return {status:503,body:{ok:false,code:'receipt_unavailable'}};
  return value;
 }
 return {request,read,query,response};
}
 return {createProtocol,...createProtocol()};
});
