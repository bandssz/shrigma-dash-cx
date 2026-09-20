/* Durable manual decisions. Only exact authenticated GET receipts confirm an
 * operation. No retry, TTL or reset. v1 entries are never migrated by inference.
 * v2 stores bounded operator input (author/note), never access keys, creator,
 * product or provider payload. Keep new key values in page memory only. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TTSManual=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const PREFIX='shrigma_tts_manual_v2:',LEGACY_PREFIX='shrigma_tts_manual_v1:';
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
 const CLOSED='Decisões indisponíveis: o serviço mantém a operação protegida. A fila, as regras e a consulta de recibos continuam disponíveis.';
 const UNKNOWN='Resultado sem confirmação. Consulte o recibo desta mesma tentativa; não repita nem troque a decisão.';
 const fail=(code,message)=>Object.assign(new Error(message),{code});
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const stable=v=>Array.isArray(v)?v.map(stable):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 const canonical=v=>JSON.stringify(stable(v)),copy=v=>JSON.parse(JSON.stringify(v));
 function endpoint(value){try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error();return u.href;}catch{throw fail('TTS_ENDPOINT','Endereço da decisão indisponível.');}}
 function identity(input){
  const marca=input?.marca??input?.brand,id=input?.application_id;
  if(!['fish','aristo'].includes(marca)||typeof id!=='string'||!/^\d{1,80}$/.test(id))throw fail('TTS_INPUT','Identidade da amostra inválida.');
  const application_id=id.replace(/^0+(?=\d)/,'');if(application_id==='0')throw fail('TTS_INPUT','Identidade da amostra inválida.');
  return {marca,application_id};
 }
 function normalize(input){
  const id=identity(input),resultado=input.resultado,motivo_rejeicao=input.motivo_rejeicao,autor=input.autor,observacao=input.observacao;
  if(!['APPROVE','REJECT'].includes(resultado)||typeof autor!=='string'||!autor.trim()||autor!==autor.trim()||autor.length>40||typeof observacao!=='string'||observacao.length>200||resultado==='APPROVE'&&motivo_rejeicao!==null||resultado==='REJECT'&&!['NOT_MATCH','INSUFFICIENT_STOCK','OTHER'].includes(motivo_rejeicao))throw fail('TTS_INPUT','Confira a decisão, o motivo e a identificação do operador.');
  return {...id,resultado,motivo_rejeicao,observacao,autor};
 }
 async function hash(value,crypto=globalThis.crypto){
  if(!crypto?.subtle||typeof TextEncoder==='undefined')throw fail('TTS_UNAVAILABLE','A proteção criptográfica está indisponível neste navegador.');
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
 }
 const actorHash=(key,crypto)=>hash({scope:'tts-manual-v1',credential:key},crypto);
 function create({storage,locks,endpoint:address,fetch:request=globalThis.fetch,crypto=globalThis.crypto}={}){
  let url;try{url=endpoint(address);}catch{}
  const memory=new Map();
  const slot=(id,legacy=false)=>(legacy?LEGACY_PREFIX:PREFIX)+id.marca+':'+id.application_id;
  const available=()=>!!(url&&storage?.getItem&&storage?.setItem&&locks?.request&&crypto?.subtle&&crypto?.randomUUID&&typeof request==='function'&&typeof TextEncoder!=='undefined');
  const unavailable=()=>fail('TTS_WRITE_UNAVAILABLE','A decisão exige armazenamento local e proteção entre abas neste navegador. A consulta continua disponível.');
  function rawRead(key){try{const raw=storage.getItem(key);if(raw===null&&memory.has(key))throw Error();if(raw!==null)memory.set(key,raw);return raw;}catch{throw fail('TTS_JOURNAL_UNAVAILABLE','Não foi possível ler a tentativa preservada. Não repita a decisão.');}}
  function persist(key,value){const raw=JSON.stringify(value);try{storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw Error();memory.set(key,raw);}catch{throw fail('TTS_JOURNAL_UNAVAILABLE','Não foi possível preservar a tentativa. Nenhuma nova decisão será enviada.');}}
  function legacy(id){
   const raw=rawRead(slot(id,true));if(raw===null)return null;
   try{const j=JSON.parse(raw);if(j.version!==1||j.brand!==id.marca||j.application_id!==id.application_id||!['APPROVE','REJECT'].includes(j.result)||!['pending','unknown','confirmed'].includes(j.state)||typeof j.endpoint!=='string')throw Error();return j;}catch{throw fail('TTS_JOURNAL_INVALID','O registro antigo precisa de conferência. Não repita a decisão.');}
  }
  function read(id){
   const old=legacy(id),raw=rawRead(slot(id));
   if(raw===null){
    if(!old)return null;
    if(UUID.test(old.v2_operation_id||'')&&HASH.test(old.v2_actor_sha256||'')&&HASH.test(old.v2_request_sha256||''))return {version:2,...id,operation_id:old.v2_operation_id,actor_sha256:old.v2_actor_sha256,request_sha256:old.v2_request_sha256,request_payload:null,resultado:old.result,endpoint:old.endpoint,state:'pending',partial:true,attempted:false};
    return {legacy:true,state:old.state,message:'Há uma decisão anterior sem o recibo novo. Preserve o registro e peça conciliação ao integrador.'};
   }
   try{
    const j=JSON.parse(raw),allowed=['version','marca','application_id','operation_id','actor_sha256','request_sha256','request_payload','resultado','endpoint','state','attempted','receipt'];
    if(!object(j)||Object.keys(j).some(k=>!allowed.includes(k))||j.version!==2||j.marca!==id.marca||j.application_id!==id.application_id||!UUID.test(j.operation_id)||!HASH.test(j.actor_sha256)||!HASH.test(j.request_sha256)||!['pending','unknown','accepted','blocked'].includes(j.state)||typeof j.attempted!=='boolean'||endpoint(j.endpoint)!==j.endpoint||canonical(normalize(j.request_payload))!==canonical(j.request_payload)||j.resultado!==j.request_payload.resultado||j.request_payload.marca!==id.marca||j.request_payload.application_id!==id.application_id||!old||old.v2_operation_id!==j.operation_id||old.v2_request_sha256!==j.request_sha256||old.v2_actor_sha256!==j.actor_sha256)throw Error();
    return j;
   }catch{throw fail('TTS_JOURNAL_INVALID','O registro da tentativa mudou. Preserve-o para conferência; não repita a decisão.');}
  }
  // Enumerate only the two known resource slots. This keeps recovery available
  // after the provider moves an accepted sample out of the current PENDING queue.
  function list({marca='todas'}={}){
   if(!['todas','fish','aristo'].includes(marca))throw fail('TTS_INPUT','Marca inválida.');
   const ids=new Map();
   try{
    const count=storage?.length;if(!Number.isSafeInteger(count)||count<0||count>10000||typeof storage.key!=='function')throw Error();
    for(let n=0;n<count;n++){
     const name=storage.key(n),match=typeof name==='string'&&name.match(/^shrigma_tts_manual_v[12]:(fish|aristo):([1-9]\d{0,79})$/);
     if(match&&(marca==='todas'||marca===match[1]))ids.set(match[1]+':'+match[2],{marca:match[1],application_id:match[2]});
    }
   }catch{throw fail('TTS_JOURNAL_UNAVAILABLE','As tentativas locais não puderam ser listadas. Preserve o armazenamento; não repita decisões.');}
   return [...ids.values()].map(id=>{try{const op=read(id);return op?{...id,state:op.state,...(op.operation_id?{operation_id:op.operation_id}:{}),...(op.legacy?{legacy:true}:{}),...(op.partial?{partial:true}:{}),...(op.message?{message:op.message}:{})}:null;}catch(e){return {...id,state:'blocked',message:e.message};}}).filter(Boolean).sort((a,b)=>(a.marca+':'+a.application_id).localeCompare(b.marca+':'+b.application_id));
  }
  function inspect(input){try{const id=identity(input);if(!available())return {state:'blocked',message:unavailable().message};const found=read(id);return found?copy(found):null;}catch(e){return {state:'blocked',message:e.message};}}
  async function exclusive(id,work){if(!available())throw unavailable();return locks.request(slot(id,true),{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw fail('TTS_OUTCOME_UNKNOWN','Outra aba está conferindo esta amostra. Aguarde sem repetir.');return work();});}
  function keyValid(key){if(typeof key!=='string'||!key||key.length>8192)throw fail('TTS_AUTH_REQUIRED','Informe a chave de escrita da mesma tentativa.');}
  async function call(key,query,body){
   keyValid(key);const target=new URL(url);for(const[k,v]of Object.entries(query||{}))target.searchParams.set(k,v);
   let r,data;try{r=await request(target.href,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{'X-TTS-Write-Key':key},credentials:'omit',redirect:'error',cache:'no-store',signal:typeof AbortSignal!=='undefined'&&AbortSignal.timeout?AbortSignal.timeout(body?60000:20000):undefined,...(body?{body:JSON.stringify({...body,k:key})}:{})});data=await r.json();}catch{throw fail('TTS_OUTCOME_UNKNOWN',UNKNOWN);}
   if(!body&&(r.status===401||r.status===403))throw fail('TTS_AUTH_REQUIRED','A chave de escrita foi recusada. Use o acesso da mesma tentativa para consultar.');
   return {status:r.status,body:data};
  }
  async function capabilities(key){
   let r;try{r=await call(key,{acao:'capacidades'});}catch(e){if(e.code==='TTS_AUTH_REQUIRED')throw e;throw fail('TTS_CONTRACT','Disponibilidade não confirmada. Nenhuma decisão foi enviada.');}const c=r.body;
   if(r.status!==200||c?.contract!=='tts_manual_runtime_v1'||c.operation!==true||typeof c.write!=='boolean'||typeof c.cutover_verified!=='boolean'||typeof c.admission_verified!=='boolean')throw fail('TTS_CONTRACT','O contrato de decisões não foi confirmado. Nenhuma decisão foi enviada.');
   return {contract:c.contract,operation:true,write:c.write&&c.cutover_verified&&c.admission_verified,cutover_verified:c.cutover_verified,admission_verified:c.admission_verified};
  }
  const query=op=>({acao:'operacao',operation_id:op.operation_id,marca:op.marca,application_id:op.application_id});
  async function receipt(r,op){
   const e=r.body,o=e?.operation;
   if(r.status!==200||e?.contract!=='tts_manual_operation_v1'||!object(o)||!['operation_id','actor_sha256','marca','application_id'].every(k=>o[k]===op[k])||!['missing','reserved','in_flight','accepted','outcome_unknown','blocked'].includes(o.state))throw fail('TTS_RECEIPT','O recibo não corresponde à mesma operação e ao mesmo acesso.');
   if(o.state==='missing'){if(o.request_payload!==null||o.response!==null)throw fail('TTS_RECEIPT','Recibo ausente inconsistente.');return {state:'unknown',missing:true};}
   let payload;try{payload=normalize(o.request_payload);}catch{throw fail('TTS_RECEIPT','Conteúdo do recibo incompatível.');}
   if(canonical(payload)!==canonical(o.request_payload)||await hash(payload,crypto)!==op.request_sha256||payload.resultado!==op.resultado||op.request_payload&&canonical(payload)!==canonical(op.request_payload))throw fail('TTS_RECEIPT','O conteúdo do recibo difere da tentativa preservada.');
   if(['reserved','in_flight'].includes(o.state)){if(o.response!==null)throw fail('TTS_RECEIPT','Recibo pendente inconsistente.');return {state:'unknown'};}
   const b=o.response?.body,status=o.response?.status;
   if(!object(b)||b.operation_id!==op.operation_id||!Number.isInteger(status)||status<200||status>599)throw fail('TTS_RECEIPT','Resposta do recibo inválida.');
   if(o.state==='accepted'){
    const row=b.linhas?.[0],decision=payload.resultado==='APPROVE'?'manual_aprovada':'manual_rejeitada';
    if(status!==200||b.ok!==true||!Array.isArray(b.linhas)||b.linhas.length!==1||row?.application_id!==op.application_id||row.decisao!==decision||typeof row.status!=='string'||!row.status||row.status.length>80)throw fail('TTS_RECEIPT','Aceite não conciliado com a decisão.');
    return {state:'accepted',payload,receipt:{status,decision,sample_status:row.status}};
   }
   if(status<400||b.ok!==false)throw fail('TTS_RECEIPT','Recusa ou incerteza incompatível.');
   return {state:o.state==='blocked'?'blocked':'unknown',payload,receipt:{status}};
  }
  async function lookupLocked(op,key){
   if(op.legacy||!op.operation_id)throw fail('TTS_LEGACY','A tentativa antiga não possui UUID consultável. Preserve-a para conciliação.');
   if(op.endpoint!==url)throw fail('TTS_ENDPOINT','O endereço mudou. Concilie a operação original sem reenviar.');
   if(await actorHash(key,crypto)!==op.actor_sha256)throw fail('TTS_AUTH_REQUIRED','Use o mesmo acesso que iniciou esta tentativa.');
   const result=await receipt(await call(key,query(op)),op);
   if(['accepted','blocked'].includes(op.state)&&result.state!==op.state)throw fail('TTS_RECEIPT','O recibo posterior diverge do estado já confirmado. O registro anterior foi preservado.');
   if(result.state==='accepted'||result.state==='blocked'){
    const next={version:2,...identity(op),operation_id:op.operation_id,actor_sha256:op.actor_sha256,request_sha256:op.request_sha256,request_payload:op.request_payload||result.payload,resultado:op.resultado,endpoint:op.endpoint,state:result.state,attempted:op.attempted,receipt:result.receipt};
    persist(slot(op),next);return copy(next);
   }
   return {...copy(op),state:'unknown',message:UNKNOWN};
  }
  async function lookup(input,key){const id=identity(input);keyValid(key);return exclusive(id,async()=>{const op=read(id);if(!op)throw fail('TTS_NO_OPERATION','Não há tentativa registrada neste navegador.');return lookupLocked(op,key);});}
  async function run(input,key,{guard=()=>true}={}){
   const payload=normalize(input),id=identity(payload);keyValid(key);
   if(payload.autor.includes(key)||payload.observacao.includes(key))throw fail('TTS_INPUT','Não inclua a chave nos campos do operador.');
   return exclusive(id,async()=>{
    const previous=read(id);if(previous)throw fail(previous.legacy?'TTS_LEGACY':previous.state==='accepted'?'TTS_DECISION_RECORDED':'TTS_OUTCOME_UNKNOWN',previous.message||UNKNOWN);
    const cap=await capabilities(key);if(!cap.write)throw fail('TTS_WRITE_CLOSED',CLOSED);
    const op={version:2,...id,operation_id:crypto.randomUUID(),actor_sha256:await actorHash(key,crypto),request_sha256:await hash(payload,crypto),request_payload:payload,resultado:payload.resultado,endpoint:url,state:'pending',attempted:false};
    if(!UUID.test(op.operation_id))throw unavailable();
    let initial;try{initial=await receipt(await call(key,query(op)),op);}catch(e){if(e.code==='TTS_AUTH_REQUIRED')throw e;throw fail('TTS_CONTRACT','A identidade da nova tentativa não foi confirmada. Nenhuma decisão foi enviada.');}if(initial.missing!==true)throw fail('TTS_OUTCOME_UNKNOWN','A identidade já existe. Não inicie outra tentativa.');
    if(guard()!==true)throw fail('TTS_CONTEXT','A tela ou o acesso mudou. Confira novamente; nenhuma decisão foi enviada.');
    // Reserve the old slot FIRST under the same lock. A failed v2 write leaves
    // a compatible blocker plus UUID/principal/request hash for GET-only recovery.
    persist(slot(id,true),{version:1,brand:id.marca,application_id:id.application_id,result:payload.resultado,endpoint:url,state:'pending',v2_operation_id:op.operation_id,v2_actor_sha256:op.actor_sha256,v2_request_sha256:op.request_sha256});
    persist(slot(id),op);op.attempted=true;persist(slot(id),op);
    try{await call(key,null,{acao:'revisar',operation_id:op.operation_id,...payload});}catch{}
    // POST acceptance by itself never confirms. Missing/mismatch retains both slots.
    try{return await lookupLocked(op,key);}catch{try{persist(slot(id),{...op,state:'unknown'});}catch{}return {...copy(op),state:'unknown',message:UNKNOWN};}
   });
  }
  return Object.freeze({available,inspect,list,capabilities,run,lookup});
 }
 return Object.freeze({create,identity,normalize,actorHash,canonical,hash,PREFIX,LEGACY_PREFIX,CLOSED,UNKNOWN});
});
