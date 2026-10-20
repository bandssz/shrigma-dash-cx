'use strict';
// This capability stays inside one authenticated HTTP execution. It is never
// accepted from the command, included in a receipt, or saved in another journal.
const {createHash}=require('node:crypto');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const DESTINATION='https://gerencial.shrigma.com.br/internal/crm-campaign-editorial-admission';
const unavailable=()=>Object.assign(Error('Conferência editorial indisponível. Consulte a mesma tentativa.'),{code:'EDITORIAL_ADMISSION_UNAVAILABLE',status:503});
function createAdmission({key,actor,fetchImpl=globalThis.fetch,interrupted=()=>false,timeoutMs=5000}={}){
 const memo=new Map();
 async function query(input){
  if(interrupted())throw unavailable();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const r=await fetchImpl(DESTINATION,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(input),redirect:'manual',signal:controller.signal});
   if(r.status!==200||!r.body||Number(r.headers.get('content-length'))>96*1024)throw unavailable();
   let size=0;const chunks=[];for await(const chunk of r.body){size+=chunk.length;if(size>96*1024)throw unavailable();chunks.push(chunk);}
   const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!b||Object.getPrototypeOf(b)!==Object.prototype||Object.keys(b).sort().join(',')!=='brand,commandSha256,diagnostics,mode,operationKey,schema'||b.schema!=='crm-editorial-admission-v1'||b.brand!==input.brand||b.operationKey!==input.operationKey||b.commandSha256!==input.commandSha256||!['gateway','legacy','deny'].includes(b.mode)||!Array.isArray(b.diagnostics)||interrupted())throw unavailable();
   if(b.mode==='deny')throw Object.assign(Error('Revise os bloqueios indicados nas linhas da peça.'),{code:'EDITORIAL_CONTENT_BLOCKED',status:422});
   return b.mode;
  }catch(e){if(e?.code==='EDITORIAL_CONTENT_BLOCKED')throw e;throw unavailable();}
  finally{clearTimeout(timer);controller.abort();}
 }
 return async(_auth,command,current)=>{
  if(!/^bff-[a-f0-9]{64}$/.test(command?.idempotency_key||''))return'legacy';
  if(!['campanha_salvar','campanha_validar','campanha_agendar'].includes(command.acao))throw unavailable();
  const input={schema:'crm-editorial-admission-request-v1',brand:command.brand,operationKey:command.idempotency_key,commandSha256:hash(command),sourceActor:actor,...(current?{current:{id:current.id,version:current.version,definition:current.definition}}:{})};
  const identity=hash(input);if(!memo.has(identity))memo.set(identity,query(input));return memo.get(identity);
 };
}
module.exports={createAdmission,DESTINATION,hash};
