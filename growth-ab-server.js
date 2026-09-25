/* Receipt-only recovery for the versioned A/B registry. No automatic POST replay. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./growth-ab-protocol.js'):root.GABProtocol);if(typeof module==='object'&&module.exports)module.exports=api;else root.GABServer=api;})(typeof globalThis!=='undefined'?globalThis:this,function(Protocol){
 'use strict';
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
 const fail=message=>new Error(message);
 const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 function canonicalRequest(expected,version){
  const number=v=>v===null||v===''||v===undefined?null:typeof v==='number'&&Number.isFinite(v)?v:typeof v==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(v)?Number(v):NaN;
  try{
   if(!expected||!['criar','encerrar'].includes(expected.acao))throw Error();
   const t={...expected.teste};let payload;
   if(expected.acao==='criar'){
    t.efeito_minimo=number(t.efeito_minimo);
    payload={acao:'criar',expected_version:0,teste:t,bracos:expected.bracos.map(a=>({braco:a.braco,campanha_id:number(a.campanha_id),utm_term:a.utm_term,descricao:a.descricao??null}))};
   }else payload={acao:'encerrar',expected_version:version,teste:{teste_id:t.teste_id,status:t.status,vencedor:t.vencedor,conclusao:t.conclusao??''},bracos:null};
   return Protocol.request({operation_id:'00000000-0000-4000-8000-000000000000',...payload},'0'.repeat(64)).request_payload;
  }catch{throw fail('Confira os campos, os limites e a revisão do cadastro. Nenhuma gravação foi enviada.');}
 }
 function validServer(op){try{return op?.server?.contract==='ab_registry_v1'&&(op.server.access===undefined||op.server.access==='crm_operator')&&hash(op.server.actor_sha256)&&same(op.server.payload,canonicalRequest(op.expected,op.server.payload?.expected_version))&&!!Protocol.request({operation_id:op.id,...op.server.payload},op.server.actor_sha256);}catch{return false;}}
 function materializedRecordMatches(record,payload){
  const t=record?.teste;
  if(!t||!Object.entries(payload.teste).every(([k,v])=>same(t[k],v)))return false;
  if(payload.acao==='encerrar')return true;
  if(!Array.isArray(record.bracos)||record.bracos.length!==payload.bracos.length)return false;
  const arms=new Map();
  for(const arm of record.bracos){if(!arm||arm.teste_id!==payload.teste.teste_id||typeof arm.braco!=='string'||arms.has(arm.braco))return false;arms.set(arm.braco,arm);}
  return payload.bracos.every(expected=>{const actual=arms.get(expected.braco);return actual&&Object.entries(expected).every(([k,v])=>same(actual[k],v));});
 }
 function create({endpoint,key,requireAccess,fetch:request=globalThis.fetch}={}){
  let url;try{url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error();}catch{throw fail('Endereço do cadastro indisponível.');}
  if(typeof key!=='string'||!key||typeof request!=='function')throw fail('Acesso indisponível. Entre novamente no CRM para continuar.');
  if(requireAccess!==undefined&&requireAccess!=='crm_operator')throw fail('Tipo de acesso indisponível.');
  async function call(query,body){
   const target=new URL(url.href);for(const [k,v]of Object.entries(query||{}))target.searchParams.set(k,v);
   let r,data;try{r=await request(target.href,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{'X-AB-Write-Key':key},credentials:'omit',redirect:'error',cache:'no-store',signal:typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(body?90000:20000):undefined,...(body?{body:JSON.stringify({...body,k:key})}:{})});data=await r.json();}catch{throw fail('Consulta sem confirmação. Preserve a mesma tentativa; nenhum reenvio foi feito.');}
   if(!body&&(r.status===401||r.status===403))throw Object.assign(fail('Acesso recusado. Use o acesso da mesma tentativa e consulte novamente; nenhuma gravação será repetida.'),{code:'AB_AUTH_REQUIRED'});
   return {status:r.status,body:data};
  }
  const queryFor=(expected,id)=>({acao:'operacao',operation_id:id,operacao:expected.acao,teste_id:expected.teste.teste_id});
  function identity(r,expected,id,actor){const op=r?.body?.operation;if(r?.status!==200||r.body?.contract!=='ab_registry_operation_v1'||op?.operation_id!==id||op?.action!==expected.acao||op?.teste_id!==expected.teste.teste_id||!hash(op?.actor_sha256)||actor&&op.actor_sha256!==actor)throw fail('O recibo não corresponde à identidade desta tentativa. Preserve o registro.');return op;}
  return {
   async prepare(expected,id,{api}={}){
    const visible=expected?.acao==='encerrar'?api?.crm_teste?.filter(t=>t.teste_id===expected.teste?.teste_id):[];
    const payload=canonicalRequest(expected,visible?.length===1?visible[0].registry_version:undefined);
    Protocol.request({operation_id:id,...payload},'0'.repeat(64));
    const cap=await call({acao:'capacidades'});if(cap.status!==200||cap.body?.contract!=='ab_registry_v1'||cap.body.write!==true||cap.body.operation!==true||cap.body.record!==true)throw fail('O contrato seguro do cadastro está indisponível. Nenhuma gravação foi enviada.');
    if(requireAccess&&cap.body.access!==requireAccess)throw fail('O acesso do CRM ao cadastro ainda não foi confirmado. Nenhuma gravação foi enviada.');
    const op=identity(await call(queryFor(expected,id)),expected,id);if(op.state!=='missing'||op.request_payload!==null||op.response!==null)throw fail('A identidade já está reservada. Consulte a mesma operação.');
    const row=await call({acao:'registro',teste_id:expected.teste.teste_id});if(row.status!==200||row.body?.contract!=='ab_registry_record_v1'||row.body.teste_id!==expected.teste.teste_id)throw fail('Cadastro atual não confirmado. Atualize os dados.');
    let version=0;
    if(expected.acao==='criar'){if(row.body.record!==null)throw fail('Esse identificador já existe; nenhum cadastro será substituído.');}
    else{const seen=api?.crm_teste?.filter(t=>t.teste_id===expected.teste.teste_id)||[],current=row.body.record?.teste;
     if(seen.length!==1||!Number.isSafeInteger(seen[0].registry_version)||seen[0].registry_version<0||!current||current.status!=='rodando'||current.registry_version!==seen[0].registry_version)throw fail('A revisão do cadastro mudou ou ainda não foi lida. Atualize antes de encerrar.');version=current.registry_version;}
    return {contract:'ab_registry_v1',actor_sha256:op.actor_sha256,payload,...(cap.body.access==='crm_operator'?{access:'crm_operator'}:{})};
   },
   send(op){if(!validServer(op))throw fail('Tentativa durável inválida; nenhum envio foi iniciado.');return call(null,{operation_id:op.id,...op.server.payload});},
   async lookup(op){
    if(!validServer(op))throw fail('Tentativa anterior ao contrato do servidor. Preserve o registro para conciliação; não repita.');
    const found=identity(await call(queryFor(op.expected,op.id)),op.expected,op.id,op.server.actor_sha256);
    if(found.state!=='completed')return {phase:'uncertain'};
    if(!same(found.request_payload,op.server.payload)||found.response?.body?.operation_id!==op.id||found.response.body.teste_id!==op.expected.teste.teste_id||found.response.body.contract!=='ab_registry_v1')throw fail('Conteúdo ou revisão do recibo não coincide. Preserve a tentativa.');
    const {status,body}=found.response;
    if(status===200&&body.ok===true&&body.code==='recorded'&&body.version===op.server.payload.expected_version+1&&body.record?.teste?.registry_version===body.version&&body.record.teste.teste_id===op.expected.teste.teste_id&&body.record.teste.status===(op.expected.acao==='criar'?'rodando':'inconclusivo')&&body.record.teste.vencedor===null&&materializedRecordMatches(body.record,op.server.payload))return {phase:'confirmed',receipt:{operation_id:op.id,version:body.version,gravado_em:body.gravado_em}};
    if(status===409&&body.ok===false&&['record_exists','record_missing','version_conflict','record_not_running'].includes(body.code))return {phase:'rejected',rejection:{status,error:body.code}};
    throw fail('Resultado do recibo indisponível. Preserve a mesma tentativa.');
   }
  };
 }
 return {create,validServer,canonicalRequest};
});
