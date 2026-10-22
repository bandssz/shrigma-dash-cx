'use strict';
// Internal model TEST only. Real cookie account owns the private journal;
// original V2 claims/transports keep their original, freshly attested principal.
const crypto=require('node:crypto');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,REF=/^d_[A-Za-z0-9_-]{1,96}$/,HEX=/^[a-f0-9]{64}$/;
const CONTRACT='crm_email_test_recipient_v2';
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
const plain=x=>!!x&&Object.getPrototypeOf(x)===Object.prototype;
const canonical=x=>JSON.stringify(x,(_k,v)=>plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
// Known V2 payload consists of ASCII keys/strings and a bounded integer.
const pgText=x=>plain(x)?'{'+Object.keys(x).sort((a,b)=>Buffer.byteLength(a)-Buffer.byteLength(b)||Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>JSON.stringify(k)+': '+pgText(x[k])).join(', ')+'}':Array.isArray(x)?'['+x.map(pgText).join(', ')+']':JSON.stringify(x);
const pgHash=x=>crypto.createHash('sha256').update(pgText(x)).digest('hex');
function create({db,binding,remoteKey,getDraft,call,now=Date.now}={}){
 if(!db?.prepare||[binding,remoteKey,getDraft,call,now].some(f=>typeof f!=='function'))fail('MODEL_TEST_CONFIG',503);
 db.exec(`CREATE TABLE IF NOT EXISTS crm_simple_model_preview_v2(user_id TEXT NOT NULL,brand TEXT NOT NULL,token TEXT NOT NULL,draft_id TEXT NOT NULL,version INTEGER NOT NULL,recipient TEXT NOT NULL,source_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(user_id,brand,token));
 CREATE TABLE IF NOT EXISTS crm_simple_model_test_v2(user_id TEXT NOT NULL,brand TEXT NOT NULL,client_key TEXT NOT NULL,remote_key TEXT NOT NULL UNIQUE,request_json TEXT NOT NULL,request_sha256 TEXT NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL,receipt_json TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,brand,client_key));`);
 const rowFor=(a,brand,key)=>db.prepare('SELECT * FROM crm_simple_model_test_v2 WHERE user_id=? AND brand=? AND client_key=?').get(a.author.id,brand,key);
 async function authority(context,brand){const a=await binding(context,{brand,write:true}),email=a.author.email?.toLowerCase();if(!/^[a-z0-9][a-z0-9._+\-]*@(shrigma\.com\.br|oaristocrata\.com|fishermans\.com\.br)$/.test(email||''))fail('MODEL_TEST_INTERNAL_ACCOUNT_REQUIRED');return {...a,email};}
 function identityFields(body,a){if(!plain(body)||!REF.test(body.draft_id)||!Number.isSafeInteger(body.expected_version)||body.expected_version<1||body.expected_version>999999999||body.recipient!==a.email)fail('MODEL_TEST_INTERNAL_RECIPIENT_REQUIRED');}
 async function currentDraft(context,brand,p){const d=await getDraft(context,brand,p.draft_id);if(d.version!==p.expected_version)fail('MODEL_TEST_VERSION_CHANGED',409);return d;}
 async function capabilities(context,brand){const a=await authority(context,brand),r=await call(context,brand,'GET',{acao:'email_teste_capacidades_v2'},true),c=r.body;if(r.status!==200||c?.contract!==CONTRACT||c.policy_version!==2||typeof c.enabled!=='boolean'||c.prefix!=='[TESTE] ')fail('MODEL_TEST_SOURCE_UNAVAILABLE',503);return {status:200,body:{...c,internal_only:true,recipient:a.email,user_id:a.author.id}};}
 async function preview(context,brand,body){
  const a=await authority(context,brand);if(Object.keys(body).sort().join(',')!=='acao,draft_id,expected_version,recipient'||body.acao!=='email_teste_previa_v2')fail('MODEL_TEST_INPUT',400);identityFields(body,a);await currentDraft(context,brand,body);
  const r=await call(context,brand,'POST',body,true),p=r.body;
  if(r.status!==200||p?.contract!==CONTRACT||typeof p.eligible!=='boolean')fail('MODEL_TEST_PREVIEW_UNCONFIRMED',502);
  if(p.eligible){if(p.brand!==brand||p.draft_id!==body.draft_id||p.version!==body.expected_version||p.recipient!==a.email||!HEX.test(p.preview_token||'')||!HEX.test(p.source_hash||'')||typeof p.body_html!=='string'||!p.body_html||typeof p.rendered_subject!=='string'||!p.rendered_subject.startsWith('[TESTE] ')||!Number.isFinite(Date.parse(p.expires_at))||Date.parse(p.expires_at)<=now()||Date.parse(p.expires_at)>now()+330000)fail('MODEL_TEST_PREVIEW_UNCONFIRMED',502);
   const after=await authority(context,brand);if(after.binding!==a.binding||after.snapshot!==a.snapshot||after.email!==a.email)fail('MODEL_TEST_ACCESS_CHANGED');
   db.prepare('INSERT OR REPLACE INTO crm_simple_model_preview_v2 VALUES(?,?,?,?,?,?,?,?,?)').run(a.author.id,brand,p.preview_token,body.draft_id,body.expected_version,a.email,p.source_hash,Date.parse(p.expires_at),a.binding);
  }return {status:r.status,body:p};
 }
 function project(op,a,key,payload){const fields=['state','code','request_hash_schema','draft_id','version','template_id','content_sha256','dispatch_id','http_accepted','created_at','finished_at'];return {...Object.fromEntries(fields.filter(k=>Object.hasOwn(op,k)).map(k=>[k,op[k]])),ses:op.ses,idempotency_key:key,actor:'panel:crm-user:'+a.author.id,request_payload:payload,request_sha256:payload?pgHash(payload):null};}
 function sourceReceipt(r,a,remote,payload){
  const o=r.body?.operation;if(r.status!==200||r.body?.contract!==CONTRACT||!plain(o)||o.idempotency_key!==remote||o.actor!=='crm-user:'+a.author.id)fail('MODEL_TEST_RECEIPT_UNCONFIRMED',502);
  if(o.state==='missing'){if(o.request_payload!==null||o.request_sha256!==null||o.http_accepted!==false||!plain(o.ses)||Object.keys(o.ses).length)fail('MODEL_TEST_RECEIPT_UNCONFIRMED',502);return o;}
  if(!payload||!['claimed','accepted','outcome_unknown','rejected'].includes(o.state)||canonical(o.request_payload)!==canonical(payload)||o.request_sha256!==pgHash(payload)||o.request_hash_schema!=='postgres-jsonb-text-sha256-v1'||o.draft_id!==payload.draft_id||o.version!==payload.expected_version||typeof o.http_accepted!=='boolean'||o.http_accepted!==(o.state==='accepted')||!plain(o.ses)||!Number.isFinite(Date.parse(o.created_at))||o.finished_at!==null&&(!Number.isFinite(Date.parse(o.finished_at))||Date.parse(o.finished_at)<Date.parse(o.created_at))||o.code!==null&&!(typeof o.code==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{1,80}$/.test(o.code))||Object.keys(o.ses).some(k=>!['send','delivery','bounce','complaint','reject','rendering_failure','delivery_delay'].includes(k)||!Number.isFinite(Date.parse(o.ses[k]))))fail('MODEL_TEST_RECEIPT_UNCONFIRMED',502);
  if(o.state==='rejected'){if(o.dispatch_id!==null||o.template_id!==null&&(!Number.isSafeInteger(o.template_id)||o.template_id<1)||o.content_sha256!==null&&!HEX.test(o.content_sha256||'')||o.finished_at===null)fail('MODEL_TEST_RECEIPT_UNCONFIRMED',502);}
  else if(!UUID.test(o.dispatch_id||'')||!Number.isSafeInteger(o.template_id)||o.template_id<1||!HEX.test(o.content_sha256||'')||o.state==='claimed'&&o.finished_at!==null||o.state!=='claimed'&&o.finished_at===null)fail('MODEL_TEST_RECEIPT_UNCONFIRMED',502);
  return o;
 }
 async function operation(context,brand,key){
  if(!UUID.test(key||''))fail('MODEL_TEST_INPUT',400);const a=await authority(context,brand),row=rowFor(a,brand,key),remote=row?.remote_key||remoteKey({userId:a.author.id,brand,key,action:'email_teste_v2'});
  if(row&&row.binding!==a.binding)fail('MODEL_TEST_ACCESS_CHANGED');
  if(row?.state==='not_sent')return {status:200,body:JSON.parse(row.receipt_json)};
  const local=row?JSON.parse(row.request_json):null,source=local?{...local,idempotency_key:remote}:null;
  const r=await call(context,brand,'GET',{acao:'email_teste_operacao_v2',idempotency_key:remote,marca:brand},true),o=sourceReceipt(r,a,remote,source);
  // A GET can finish after a newer GET or POST. Only reconcile synchronously
  // under the journal lock; a stale response cannot regress a terminal receipt.
  db.exec('BEGIN IMMEDIATE');try{
   const latest=rowFor(a,brand,key),saved=latest?.receipt_json?JSON.parse(latest.receipt_json):null;
   if(latest&&latest.binding!==a.binding)fail('MODEL_TEST_ACCESS_CHANGED');
   const terminal=['accepted','outcome_unknown','rejected'].includes(latest?.state);
   if(latest?.state==='not_sent'||terminal&&['missing','claimed'].includes(o.state)){db.exec('COMMIT');return {status:200,body:saved};}
   if(o.state==='missing'){db.exec('COMMIT');if(latest){const p=JSON.parse(latest.request_json);return {status:200,body:{contract:CONTRACT,operation:{...project(o,a,key,p),state:'outcome_unknown',request_hash_schema:'postgres-jsonb-text-sha256-v1',draft_id:p.draft_id,version:p.expected_version,http_accepted:false}}};}return {status:200,body:{contract:CONTRACT,operation:project(o,a,key,null)}};}
   if(!latest)fail('MODEL_TEST_ATTEMPT_NOT_REGISTERED',409);
   const projected={contract:CONTRACT,operation:project(o,a,key,JSON.parse(latest.request_json))};
   if(terminal){const {ses:oldSes,...oldCore}=saved.operation,{ses:newSes,...newCore}=projected.operation;if(canonical(oldCore)!==canonical(newCore))fail('MODEL_TEST_RECEIPT_CONFLICT',502);projected.operation.ses={...oldSes};for(const [event,at] of Object.entries(newSes))if(!oldSes[event]||Date.parse(at)>Date.parse(oldSes[event]))projected.operation.ses[event]=at;}
   db.prepare('UPDATE crm_simple_model_test_v2 SET state=?,receipt_json=? WHERE user_id=? AND brand=? AND client_key=?').run(o.state,JSON.stringify(projected),a.author.id,brand,key);db.exec('COMMIT');return {status:200,body:projected};
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
 }
 async function send(context,brand,body){
  const a=await authority(context,brand);if(!plain(body)||Object.keys(body).sort().join(',')!=='acao,confirm,draft_id,expected_version,idempotency_key,preview_token,recipient'||body.acao!=='email_teste_v2'||!UUID.test(body.idempotency_key||'')||!HEX.test(body.preview_token||'')||body.confirm!=='enviar_teste')fail('MODEL_TEST_INPUT',400);identityFields(body,a);
  const {acao,...payload}=body,key=payload.idempotency_key,prior=rowFor(a,brand,key);if(prior){if(prior.binding!==a.binding||prior.request_json!==canonical(payload))fail('MODEL_TEST_ATTEMPT_CHANGED',409);return operation(context,brand,key);}
  const remote=remoteKey({userId:a.author.id,brand,key,action:'email_teste_v2'}),source={...payload,idempotency_key:remote},at=now();
  db.prepare("INSERT INTO crm_simple_model_test_v2 VALUES(?,?,?,?,?,?,?,'preparing',NULL,?)").run(a.author.id,brand,key,remote,canonical(payload),pgHash(payload),a.binding,at);
  let mayHaveSent=false;
  try{
   const previous=db.prepare("SELECT 1 FROM crm_simple_model_test_v2 WHERE user_id=? AND brand=? AND client_key<>? AND json_extract(request_json,'$.draft_id')=? AND json_extract(request_json,'$.expected_version')=? AND json_extract(request_json,'$.recipient')=? AND (state NOT IN('not_sent','rejected') OR state='rejected' AND (receipt_json IS NULL OR COALESCE(json_type(receipt_json,'$.operation.dispatch_id'),'missing')<>'null'))").get(a.author.id,brand,key,payload.draft_id,payload.expected_version,a.email);if(previous)fail('MODEL_TEST_REVISION_ALREADY_ATTEMPTED',409);
   const seal=db.prepare('SELECT * FROM crm_simple_model_preview_v2 WHERE user_id=? AND brand=? AND token=?').get(a.author.id,brand,payload.preview_token);if(!seal||seal.binding!==a.binding||seal.draft_id!==payload.draft_id||seal.version!==payload.expected_version||seal.recipient!==a.email||seal.expires_at<=now())fail('MODEL_TEST_PREVIEW_REQUIRED',409);await currentDraft(context,brand,payload);
   const pre=await call(context,brand,'GET',{acao:'email_teste_operacao_v2',idempotency_key:remote,marca:brand},true),o=sourceReceipt(pre,a,remote,source);if(o.state!=='missing'){mayHaveSent=true;return operation(context,brand,key);}
   db.prepare("UPDATE crm_simple_model_test_v2 SET state='uncertain' WHERE user_id=? AND brand=? AND client_key=? AND state='preparing'").run(a.author.id,brand,key);
   mayHaveSent=true;await call(context,brand,'POST',{...body,idempotency_key:remote},true);
  }catch(e){if(!mayHaveSent){const negative={contract:CONTRACT,operation:{idempotency_key:key,actor:'panel:crm-user:'+a.author.id,state:'rejected',code:/^[A-Z_]+$/.test(e.code||'')?e.code:'MODEL_TEST_PRECHECK_FAILED',request_payload:payload,request_sha256:pgHash(payload),request_hash_schema:'postgres-jsonb-text-sha256-v1',draft_id:payload.draft_id,version:payload.expected_version,http_accepted:false,ses:{},nothing_changed:true,local_refusal:true}};db.prepare("UPDATE crm_simple_model_test_v2 SET state='not_sent',receipt_json=? WHERE user_id=? AND brand=? AND client_key=?").run(JSON.stringify(negative),a.author.id,brand,key);}}
  return operation(context,brand,key);
 }
 return Object.freeze({capabilities,preview,send,operation,async identity(context,brand){const a=await authority(context,brand);return {recipient:a.email,userId:a.author.id};}});
}
module.exports={create,pgText,pgHash};
