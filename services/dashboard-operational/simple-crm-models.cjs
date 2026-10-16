'use strict';
// Cookie-authorized model CRUD. The actual person remains the journal author;
// the privately attested source key is a transport credential, never a UI key.
const crypto=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const REF=/^d_[A-Za-z0-9_-]{1,96}$/;
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const plain=x=>!!x&&Object.getPrototypeOf(x)===Object.prototype;
const canonical=x=>JSON.stringify(x,(_k,v)=>plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
function create({db,binding,remoteKey,fetchImpl=globalThis.fetch,destination,recordDiagnostic}={}){
 if(!db?.prepare||typeof binding!=='function'||typeof remoteKey!=='function'||typeof fetchImpl!=='function'||destination!=='https://n8n.shrigma.com.br/webhook/crm-modelos-20261014-14a1976f59cd')fail('MODELS_CONFIG_REFUSED',503);
 db.exec(`CREATE TABLE IF NOT EXISTS crm_simple_models_operation_v1(
 user_id TEXT NOT NULL,brand TEXT NOT NULL CHECK(brand IN('fish','aristo')),attempt_key TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN('rascunho','validar','submeter')),request_json TEXT NOT NULL,request_sha256 TEXT NOT NULL,
 source_key TEXT NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,brand,attempt_key));`);
 const rowFor=(a,brand,key)=>db.prepare('SELECT * FROM crm_simple_models_operation_v1 WHERE user_id=? AND brand=? AND attempt_key=?').get(a.author.id,brand,key);
 const masked=(body,a)=>{if(typeof a.sourceActor!=='string'||!a.sourceActor.startsWith('panel:'))fail('MODELS_SOURCE_ACTOR_REFUSED',503);const copy=JSON.parse(JSON.stringify(body));function visit(v){if(!v||typeof v!=='object')return;for(const [k,x]of Object.entries(v)){if(['who','actor','changed_by'].includes(k)&&x===a.sourceActor)v[k]='crm-user:'+a.author.id;else visit(x);}}visit(copy);const raw=JSON.stringify(copy).toLowerCase();if(raw.includes(a.credential.toLowerCase())||raw.includes(a.sourceActor.toLowerCase()))fail('MODELS_RESPONSE_REFUSED',502);return copy;};
 async function call(context,brand,method,input,write){
  const before=await binding(context,{brand,write});
  const target=new URL(destination);if(method==='GET')for(const [k,v]of Object.entries(input))target.searchParams.set(k,String(v));
  if(['email_teste_capacidades_v2','email_teste_operacao_v2','email_teste_previa_v2','email_teste_v2'].includes(input.acao))target.searchParams.set('marca',brand);
  const needsDiagnostic=/^email_teste_/.test(input.acao)||method==='POST'&&['rascunho','validar','submeter'].includes(input.acao),diagnostic=fields=>needsDiagnostic&&recordDiagnostic?.({userId:before.author.id,brand,kind:'model',action:input.acao,operationKey:input.idempotency_key||null,secrets:[before.credential],...fields});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),method==='POST'?60000:20000);let response,readComplete=false;const chunks=[];
  try{
   if(input.acao==='email_teste_v2')diagnostic({phase:'before_send',bodyAvailable:false});
   response=await fetchImpl(target.href,{method,redirect:'error',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',Authorization:'Bearer '+before.credential,...(input.acao==='operacao'?{'X-Template-Key':before.credential}:{}),...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(input)}:{})});
   if(response.redirected||response.url&&response.url!==target.href)fail('MODELS_SOURCE_REFUSED',502);
   const reader=response.body.getReader();let bytes=0;
   try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8*1024*1024)fail('MODELS_RESPONSE_REFUSED',502);chunks.push(Buffer.from(part.value));}}finally{reader.releaseLock();}
   readComplete=true;if(!/^application\/json/i.test(response.headers.get('content-type')||''))fail('MODELS_SOURCE_REFUSED',502);
   const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
   diagnostic({phase:'response',httpStatus:response.status,body:Buffer.concat(chunks),bodyAvailable:body?.operation?.state!=='outcome_unknown'});
   const after=await binding(context,{brand,write});if(before.binding!==after.binding||before.snapshot!==after.snapshot||before.sourceActor!==after.sourceActor)fail('MODELS_ACCESS_CHANGED',403);
   return {status:response.status,body:masked(body,before),authority:before};
  }catch(e){try{diagnostic({phase:'exception',httpStatus:response?.status||null,body:Buffer.concat(chunks),error:e,bodyAvailable:chunks.length>0,captureComplete:readComplete});}catch{}if(e.code==='TEST_DIAGNOSTIC_UNAVAILABLE'||/^MODELS_[A-Z_]+$/.test(e.code||''))throw e;fail('MODELS_SOURCE_UNCONFIRMED',503);}finally{clearTimeout(timer);controller.abort();}
 }
 function draftEnvelope(raw,brand){
  if(!plain(raw)||raw.contract!=='crm-model-drafts-v1'||raw.brand!==brand||!Array.isArray(raw.drafts)||raw.drafts.length>20)fail('MODELS_RESPONSE_REFUSED',502);
  for(const d of raw.drafts)if(!plain(d)||!REF.test(d.draft_id)||d.brand!==brand||d.channel!=='email'||!Number.isSafeInteger(d.version)||d.version<1||!plain(d.rascunho)||d.rascunho.marca!==brand||d.rascunho.canal!=='email')fail('MODELS_RESPONSE_REFUSED',502);
  return raw;
 }
 async function getDraft(context,brand,id){const r=await call(context,brand,'GET',{acao:'rascunho_obter',marca:brand,draft_id:id},false);if(r.status!==200)fail('MODELS_SOURCE_REFUSED',503);const d=draftEnvelope(r.body,brand).drafts;if(d.length!==1||d[0].draft_id!==id)fail('MODEL_NOT_FOUND',404);return d[0];}
 async function operation(context,brand,key,action){
  if(!UUID.test(key)||!['rascunho','validar','submeter'].includes(action))fail('MODELS_INPUT',400);
  const a=await binding(context,{brand,write:true}),row=rowFor(a,brand,key),remote=row?.source_key||remoteKey({userId:a.author.id,brand,key,action});
  if(row&&row.action!==action)fail('MODELS_OPERATION_CHANGED',409);
  if(row&&['confirmed','rejected'].includes(row.state)&&row.result_json)return {status:200,body:JSON.parse(row.result_json)};
  if(row&&row.binding!==a.binding)fail('MODELS_OPERATION_CHANGED',409);
  if(row?.state==='not_sent')return {status:200,body:{contract:'template_operation_v1',operation:{idempotency_key:key,acao:action,actor:'crm-user:'+a.author.id,request_payload:JSON.parse(row.request_json),request_sha256:row.request_sha256,hash_schema:'json-stable-sha256-v1',state:'completed',response:JSON.parse(row.result_json),claim_id:null}}};
  const result=await call(context,brand,'GET',{acao:'operacao',marca:brand,idempotency_key:remote,operacao:action},true),op=result.body?.operation;
  if(result.status!==200||result.body?.contract!=='template_operation_v1'||!plain(op)||op.idempotency_key!==remote||op.acao!==action||op.actor!=='crm-user:'+a.author.id||op.hash_schema!=='json-stable-sha256-v1')fail('MODELS_RECEIPT_REFUSED',502);
  if(row&&op.state==='completed'){
   if(op.request_sha256!==row.request_sha256||canonical(op.request_payload)!==row.request_json)fail('MODELS_RECEIPT_REFUSED',502);
   const p=op.request_payload,r=op.response,d=r?.body;if(!Number.isInteger(r?.status)||r.status<200||r.status>599||!plain(d))fail('MODELS_RECEIPT_REFUSED',502);
   if(r.status<300){if(action==='rascunho'&&(d.estado!=='rascunho'||!REF.test(d.draft_id)||d.version!==(p.draft_id?p.expected_version+1:1)||p.draft_id&&d.draft_id!==p.draft_id)||action==='validar'&&(d.estado!=='validado'||d.draft_id!==p.draft_id||d.version!==p.expected_version||!Array.isArray(d.erros)||d.erros.length)||action==='submeter'&&(!(d.estado==='submetido'||d.estado==='publicado'&&d.provider_status==='APPROVED')||d.draft_id!==p.draft_id||d.version!==undefined&&d.version!==p.expected_version||!UUID.test(op.claim_id)||d.operation_id!==op.claim_id||d.submission_id!=='s_'+op.claim_id.replace(/-/g,'')||d.provider!=='listmonk'))fail('MODELS_RECEIPT_REFUSED',502);}
   op.idempotency_key=key;
   db.prepare('UPDATE crm_simple_models_operation_v1 SET state=?,result_json=?,updated_at=? WHERE user_id=? AND brand=? AND attempt_key=?').run(r.status<300?'confirmed':'rejected',JSON.stringify(result.body),new Date().toISOString(),a.author.id,brand,key);
  }
  if(row&&op.state==='missing')op.state='outcome_unknown';
  op.idempotency_key=key;return {status:200,body:result.body};
 }
 async function write(context,brand,body){
  if(!plain(body)||!['rascunho','validar','submeter'].includes(body.acao)||!UUID.test(body.idempotency_key)||Object.keys(body).some(k=>!['acao','rascunho','draft_id','expected_version','confirm','idempotency_key'].includes(k)))fail('MODELS_INPUT',400);
  const a=await binding(context,{brand,write:true}),key=body.idempotency_key,existing=rowFor(a,brand,key),payload={acao:body.acao,rascunho:body.rascunho??null,draft_id:body.draft_id??null,expected_version:body.expected_version??null,confirm:body.confirm??null};
  if(body.acao==='rascunho'&&(!plain(body.rascunho)||body.rascunho.marca!==brand||body.rascunho.canal!=='email'))fail('MODELS_BRAND_REFUSED',403);
  if(existing){if(existing.action!==body.acao||existing.request_json!==canonical(payload)||existing.binding!==a.binding)fail('MODELS_OPERATION_CHANGED',409);return operation(context,brand,key,body.acao);}
  if(Buffer.byteLength(canonical(payload))>300000)fail('MODELS_INPUT',413);
  const pending=db.prepare("SELECT 1 FROM crm_simple_models_operation_v1 WHERE user_id=? AND brand=? AND state IN('preparing','pending') AND ((? IS NOT NULL AND json_extract(request_json,'$.draft_id')=?) OR (? IS NULL AND json_extract(request_json,'$.rascunho.nome')=?))").get(a.author.id,brand,body.draft_id||null,body.draft_id||null,body.draft_id||null,body.rascunho?.nome||null);
  const remote=remoteKey({userId:a.author.id,brand,key,action:body.acao}),time=new Date().toISOString();
  db.prepare('INSERT INTO crm_simple_models_operation_v1(user_id,brand,attempt_key,action,request_json,request_sha256,source_key,binding,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(a.author.id,brand,key,body.acao,canonical(payload),hash(payload),remote,a.binding,'preparing',time,time);
  let sourceMayHaveWritten=false;
  try{
   if(pending)fail('MODEL_RESULT_PENDING',409);
   if(body.acao!=='rascunho'||body.draft_id!==undefined){if(!REF.test(body.draft_id)||!Number.isSafeInteger(body.expected_version)||body.expected_version<1)fail('MODELS_INPUT',400);const d=await getDraft(context,brand,body.draft_id);if(d.version!==body.expected_version)fail('MODEL_VERSION_CONFLICT',409);}
   if(body.acao==='submeter'&&body.confirm!=='submeter')fail('MODELS_INPUT',400);
   const preflight=await call(context,brand,'GET',{acao:'operacao',marca:brand,idempotency_key:remote,operacao:body.acao},true);
   const po=preflight.body?.operation;if(preflight.status!==200||preflight.body?.contract!=='template_operation_v1'||po?.idempotency_key!==remote||po?.acao!==body.acao||po?.actor!=='crm-user:'+a.author.id||po?.hash_schema!=='json-stable-sha256-v1')fail('MODELS_RECEIPT_REFUSED',502);
   if(po.state!=='missing'){sourceMayHaveWritten=true;return operation(context,brand,key,body.acao);}
   if(po.request_payload!==null||po.request_sha256!==null||po.response!==null)fail('MODELS_RECEIPT_REFUSED',502);
   db.prepare('UPDATE crm_simple_models_operation_v1 SET state=?,updated_at=? WHERE user_id=? AND brand=? AND attempt_key=?').run('pending',new Date().toISOString(),a.author.id,brand,key);
   // Exactly one source POST per reserved attempt. Lost responses are GET-only.
   sourceMayHaveWritten=true;await call(context,brand,'POST',{...body,idempotency_key:remote},true);
  }catch(e){if(!sourceMayHaveWritten){const response={status:Number.isInteger(e.status)&&e.status>=400&&e.status<=599?e.status:503,body:{erro:/^[A-Z_]+$/.test(e.code||'')?e.code:'MODELS_PRECHECK_FAILED',nothing_changed:true,who:'crm-user:'+a.author.id}};db.prepare('UPDATE crm_simple_models_operation_v1 SET state=?,result_json=?,updated_at=? WHERE user_id=? AND brand=? AND attempt_key=?').run('not_sent',JSON.stringify(response),new Date().toISOString(),a.author.id,brand,key);}}
  return operation(context,brand,key,body.acao);
 }
 async function read(context,brand,query){
  const action=query.get('acao');
  if(action==='operacao')return operation(context,brand,query.get('idempotency_key'),query.get('operacao'));
  if(['rascunhos_listar','rascunho_obter'].includes(action)){const result=await call(context,brand,'GET',{acao:action,marca:brand,...(action==='rascunho_obter'?{draft_id:query.get('draft_id')}:{offset:query.get('offset')||'0'})},false);if(result.status===200)draftEnvelope(result.body,brand);return {status:result.status,body:result.body};}
  if(action==='email_capacidades'){const r=await call(context,brand,'GET',{acao:action},false);return {status:r.status,body:r.body};}
  if(action==='historico'){
   const id=query.get('draft_id');if(!REF.test(id))fail('MODELS_INPUT',400);await getDraft(context,brand,id);
   const r=await call(context,brand,'GET',{acao:action,marca:brand,draft_id:id},false);if(r.status!==200||!Array.isArray(r.body.events)||r.body.events.length>200)fail('MODELS_RESPONSE_REFUSED',502);
   return {status:200,body:{contract:'crm-template-history-read-v1',brand,draft_id:id,events:r.body.events,truncated:r.body.events.length===200,read_at:new Date().toISOString()}};
  }
  if(action==='submissao'){
   const id=query.get('submission_id');if(!/^s_[a-f0-9]{32}$/.test(id||''))fail('MODELS_INPUT',400);
   const r=await call(context,brand,'GET',{acao:action,marca:brand,submission_id:id},false);if(r.status!==200)return {status:r.status,body:r.body};
   const d=await getDraft(context,brand,r.body.draft_id);if(r.body.provider!=='listmonk')fail('MODELS_RESPONSE_REFUSED',502);
   return {status:200,body:{contract:'crm-template-submission-read-v1',brand,submission_id:id,draft_id:d.draft_id,draft_version:null,provider:'listmonk',estado:r.body.estado,provider_status:r.body.provider_status||null,rejected_reason:r.body.rejected_reason||null,checked_at:r.body.checked_at||null,read_at:new Date().toISOString(),provider_polled:false}};
  }
  fail('MODELS_READ_SCOPE_REFUSED',403);
 }
 async function preview(context,brand,body){if(!plain(body)||body.acao!=='email_previa'||!plain(body.rascunho)||body.rascunho.marca!==brand||body.rascunho.canal!=='email'||Object.keys(body).sort().join(',')!=='acao,rascunho')fail('MODELS_INPUT',400);const r=await call(context,brand,'POST',body,false);return {status:r.status,body:r.body};}
 const tests=require('./simple-crm-model-tests.cjs').create({db,binding,remoteKey,getDraft,call});
 return Object.freeze({write,read,preview,getDraft,tests,async capability(context,brand){let sourceRead=false;try{const r=await call(context,brand,'GET',{acao:'email_capacidades'},false);sourceRead=r.status===200&&r.body?.contract==='crm_email_native_preview_v1';}catch{}let writable=false;try{await binding(context,{brand,write:true});writable=true;}catch{}let internalTest=false,testRecovery=false,recipient=null,userId=null;if(writable)try{const who=await tests.identity(context,brand);recipient=who.recipient;userId=who.userId;testRecovery=true;try{const t=await tests.capabilities(context,brand);internalTest=t.body.enabled===true;}catch{}}catch{}return {brand,read:sourceRead,draft:writable&&sourceRead,validate:writable&&sourceRead,submit:writable&&sourceRead,send:false,internalTest,testRecovery,recipient,userId};}});
}
module.exports={create,canonical,hash};
