'use strict';
// Private technical custody. This new journal only INSERTs; existing operation
// receipts and uncertainty fences remain authoritative and are never rewritten.
const crypto=require('node:crypto');
const MAX=2*1024*1024,BRANDS=['fish','aristo'],KINDS=['campaign','model','journey'];
const fail=()=>{throw Object.assign(Error('TEST_DIAGNOSTIC_UNAVAILABLE'),{code:'TEST_DIAGNOSTIC_UNAVAILABLE',status:503});};
function create({db,encrypt,decrypt,now=Date.now}={}){
 if(!db?.prepare||[encrypt,decrypt,now].some(f=>typeof f!=='function'))fail();
 db.exec(`CREATE TABLE IF NOT EXISTS crm_private_test_diagnostic_v1(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL,
 kind TEXT NOT NULL,action TEXT NOT NULL,phase TEXT NOT NULL,operation_key TEXT,
 http_status INTEGER,native_status INTEGER,body_available INTEGER NOT NULL,
 truncated INTEGER NOT NULL,capture_complete INTEGER NOT NULL,captured_bytes INTEGER NOT NULL,content_sha256 TEXT NOT NULL,
 encrypted_detail TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS crm_private_test_diagnostic_owner_v1 ON crm_private_test_diagnostic_v1(user_id,brand,created_at);`);
 const valid=(u,b)=>typeof u==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(u)&&BRANDS.includes(b);
 function scrub(value,secrets){
  let raw=String(value);for(const s of secrets.filter(v=>typeof v==='string'&&v.length>=4).sort((a,b)=>b.length-a.length))for(const v of [s,encodeURIComponent(s)])raw=raw.split(v).join('[PRIVATE_CREDENTIAL]');
  raw=raw.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_~.-]+/gi,'[PRIVATE_AUTH]');
  if(raw.includes('@'))raw=raw.replace(/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi,'[PRIVATE_EMAIL]');
  return raw.replace(/https?:\/\/[^\s<>"']+/gi,'[PRIVATE_URL]');
 }
 function safeBody(body,secrets){
  let raw=Buffer.isBuffer(body)?body.toString('utf8'):typeof body==='string'?body:JSON.stringify(body??null),truncated=Buffer.byteLength(raw)>MAX;
  if(truncated)raw=Buffer.from(raw).subarray(0,MAX).toString('utf8');
  const forensic=scrub(raw,secrets);
  try{raw=JSON.stringify(JSON.parse(raw),function(k,v){if(/^(?:authorization|cookie|set-cookie|password|secret|token|api_?key|access_token|refresh_token|preview_token|recipient|subscribers?|subscriber_emails|request_payload|payload|html|body_html|body|binding|source_hash|claim_token)$/i.test(k))return '[PRIVATE_FIELD]';return typeof v==='string'?scrub(v,secrets):v;});}catch{raw='[PRIVATE_UNPARSED_RESPONSE: encrypted custody only]';}
  return {raw,forensic,truncated};
 }
 function record({userId,brand,kind,action,phase,operationKey=null,httpStatus=null,nativeStatus=null,body=null,error=null,secrets=[],bodyAvailable=true,captureComplete=true}={}){
  if(!valid(userId,brand)||!KINDS.includes(kind)||typeof action!=='string'||!/^[A-Za-z0-9_.:-]{1,90}$/.test(action)||!['before_send','response','exception','source_receipt'].includes(phase)||operationKey!==null&&(typeof operationKey!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(operationKey))||[httpStatus,nativeStatus].some(x=>x!==null&&(!Number.isInteger(x)||x<100||x>599))||!Array.isArray(secrets)||typeof bodyAvailable!=='boolean')fail();
  const id=crypto.randomUUID(),captured=safeBody(body,secrets),technicalError=error?{name:scrub(error.name||'Error',secrets),code:scrub(error.code||'',secrets),message:scrub(error.message||String(error),secrets),stack:scrub(error.stack||'',secrets),cause:error.cause?{name:scrub(error.cause.name||'',secrets),code:scrub(error.cause.code||'',secrets),message:scrub(error.cause.message||String(error.cause),secrets)}:null}:null;
  if(typeof captureComplete!=='boolean')fail();
  if(technicalError){const redact=v=>typeof v==='string'&&/\b(?:authorization|password|secret|token|api_?key|preview_token|claim_token)\s*["']?\s*[:=]/i.test(v)?'[PRIVATE_ERROR_CONTEXT]':v;for(const key of ['name','code','message','stack'])technicalError[key]=redact(technicalError[key]);if(technicalError.cause)for(const key of ['name','code','message'])technicalError.cause[key]=redact(technicalError.cause[key]);}
  const detail=JSON.stringify({schema:'crm-private-test-error-v1',id,userId,brand,body:captured.raw,forensic:captured.forensic,error:technicalError,captureComplete:captureComplete&&!captured.truncated&&bodyAvailable}),encrypted=encrypt(detail),hash=crypto.createHash('sha256').update(detail).digest('hex'),created=now();
  if(typeof encrypted!=='string'||encrypted===detail||decrypt(encrypted)!==detail||!Number.isSafeInteger(created)||created<0)fail();
  try{db.prepare('INSERT INTO crm_private_test_diagnostic_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,brand,kind,action,phase,operationKey,httpStatus,nativeStatus,Number(bodyAvailable),Number(captured.truncated),Number(captureComplete&&!captured.truncated&&bodyAvailable),Buffer.byteLength(captured.forensic),hash,encrypted,created);}catch{fail();}
  return id;
 }
 function list({userId,brand}){if(!valid(userId,brand))fail();return db.prepare('SELECT id,kind,action,phase,operation_key,http_status,native_status,body_available,truncated,capture_complete,captured_bytes,content_sha256,created_at FROM crm_private_test_diagnostic_v1 WHERE user_id=? AND brand=? ORDER BY created_at DESC,rowid DESC LIMIT 50').all(userId,brand).map(r=>({...r,body_available:!!r.body_available,truncated:!!r.truncated,capture_complete:!!r.capture_complete}));}
 function detail({userId,brand,id}){if(!valid(userId,brand)||typeof id!=='string')fail();const row=db.prepare('SELECT encrypted_detail,content_sha256 FROM crm_private_test_diagnostic_v1 WHERE id=? AND user_id=? AND brand=?').get(id,userId,brand);if(!row)return null;let raw,p;try{raw=decrypt(row.encrypted_detail);p=JSON.parse(raw);}catch{fail();}if(p.id!==id||p.userId!==userId||p.brand!==brand||crypto.createHash('sha256').update(raw).digest('hex')!==row.content_sha256)fail();const type=p.error?.name;return {schema:p.schema,id:p.id,body:'[PRIVATE_TECHNICAL_CONTENT: encrypted custody]',error:type?{name:['Error','TypeError','SyntaxError','AbortError','DOMException'].includes(type)?type:'Error'}:null,captureComplete:p.captureComplete};}
 return Object.freeze({record,list,detail});
}
module.exports={create,MAX};
