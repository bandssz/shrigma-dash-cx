'use strict';
// Private writer callback bound to the ORIGINAL gateway journal. No session,
// caller-provided approval, new journal or grant is created here.
const crypto=require('node:crypto');
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&Object.getPrototypeOf(x)===Object.prototype?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const refuse=()=>{throw Object.assign(Error('EDITORIAL_AUTHORITY_REFUSED'),{code:'EDITORIAL_AUTHORITY_REFUSED',status:403});};
function request(value){
 const keys=['schema','brand','operationKey','commandSha256','sourceActor'],hasCurrent=Object.hasOwn(value||{},'current');
 if(!exact(value,[...keys,...(hasCurrent?['current']:[])])||value.schema!=='crm-editorial-admission-request-v1'||!['aristo','fish'].includes(value.brand)||!/^bff-[a-f0-9]{64}$/.test(value.operationKey||'')||!/^[a-f0-9]{64}$/.test(value.commandSha256||'')||!/^panel:[a-z0-9-]{8,128}$/.test(value.sourceActor||''))refuse();
 if(hasCurrent&&(!exact(value.current,['id','version','definition'])||!Number.isSafeInteger(value.current.id)||value.current.id<1||!/^[a-f0-9]{32}$/i.test(value.current.version||'')||!value.current.definition||value.current.definition.brand!==value.brand))refuse();
 if(Buffer.byteLength(JSON.stringify(value))>2*1024*1024)refuse();return value;
}
function journalCommand({row,kind,decrypt},input){
 const q=request(input);if(!row||row.phase!=='uncertain'||row.brand!==q.brand||row.remote_key!==q.operationKey)refuse();let command;
 try{
  if(kind==='create'){
   const original=JSON.parse(decrypt(row.input_ciphertext)),definition=JSON.parse(decrypt(row.normalized_ciphertext)),catalog=JSON.parse(decrypt(row.catalog_ciphertext));
   if(hash(original)!==row.payload_sha256||original.acao!=='campanha_criar'||original.brand!==row.brand||original.idempotency_key!==row.client_key||definition.brand!==row.brand||definition.send_at!==null||hash(definition)!==row.normalized_sha256||hash(catalog)!==row.catalog_sha256||Object.hasOwn(q,'current'))refuse();
   command={acao:'campanha_salvar',brand:row.brand,definition,idempotency_key:row.remote_key};
  }else if(kind==='delivery'){
   if(!['salvar','validar','agendar'].includes(row.action))refuse();
   let definition;if(row.action==='salvar')definition=JSON.parse(decrypt(row.definition_ciphertext));
   const original={acao:'campanha_'+row.action,brand:row.brand,id:row.campaign_id,expected_version:row.expected_version,idempotency_key:row.client_key,...(row.action==='salvar'?{definition}:{}),...(row.action==='agendar'?{confirm:'agendar',audience_review_id:row.audience_review_id}:{})};
   if(hash(original)!==row.payload_sha256)refuse();
   command={...original,idempotency_key:row.remote_key};
   if(row.action==='salvar'){if(Object.hasOwn(q,'current'))refuse();}
   else if(!q.current||q.current.id!==row.campaign_id||q.current.version!==row.expected_version)refuse();
  }else refuse();
  if(hash(command)!==q.commandSha256)refuse();
  const definition=command.definition||q.current?.definition;
  if(!definition||definition.brand!==q.brand)refuse();
  return{command,definition};
 }catch{refuse();}
}
function result(input,mode,diagnostics=[]){const q=request(input);if(!['gateway','legacy','deny'].includes(mode))refuse();return{schema:'crm-editorial-admission-v1',brand:q.brand,operationKey:q.operationKey,commandSha256:q.commandSha256,mode,diagnostics};}
module.exports={request,journalCommand,result,hash};
