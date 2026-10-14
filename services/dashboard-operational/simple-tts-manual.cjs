'use strict';
// The original TTS service owns decisions and receipts. SQLite holds only the
// authenticated person, resource, UUID, hashes and durable attempt state.
const crypto=require('node:crypto'),M=require('./influs-tts-manual.js');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
function createSimpleTTS({db,binding,transport,businessAllowed=()=>false,now=Date.now}={}){
 if(!db||![binding,transport,businessAllowed,now].every(f=>typeof f==='function'))fail('TTS_CONFIG',500);
 db.exec(`CREATE TABLE IF NOT EXISTS simple_tts_attempts_v1(operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),application_id TEXT NOT NULL,binding TEXT NOT NULL,actor_sha256 TEXT NOT NULL,request_sha256 TEXT NOT NULL,result TEXT NOT NULL CHECK(result IN ('APPROVE','REJECT')),state TEXT NOT NULL CHECK(state IN ('reserved','unknown','accepted','blocked')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,brand,request_id),UNIQUE(brand,application_id));`);
 const stamp=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('TTS_CLOCK',500);return t;};
 const dto=row=>({schema:'shrigma-tts-attempt-v1',request_id:row.request_id,brand:row.brand,application_id:row.application_id,state:row.state});
 function input(v,keys){if(!exact(v,keys)||!UUID.test(v.request_id||''))fail('TTS_INPUT');return M.identity({marca:v.brand,application_id:v.application_id});}
 function find(ctx,q){const id=input(q,['request_id','brand','application_id']),b=binding(ctx,{brand:id.marca,write:false}),row=db.prepare('SELECT * FROM simple_tts_attempts_v1 WHERE user_id=? AND brand=? AND request_id=? AND application_id=?').get(b.author.id,id.marca,q.request_id,id.application_id);if(!row)fail('TTS_OPERATION_NOT_FOUND',404);if(row.binding!==b.binding)fail('TTS_ACCESS_CHANGED',403);return {row,b};}
 async function call(ctx,b,query,body){
  const before=binding(ctx,{brand:b.brand,write:!!body});if(before.binding!==b.binding||before.author.id!==b.author.id)fail('TTS_ACCESS_CHANGED',403);
  const r=await transport({credential:b.credential,query,body});
  const after=binding(ctx,{brand:b.brand,write:!!body});if(after.binding!==b.binding||after.author.id!==b.author.id)fail('TTS_ACCESS_CHANGED',403);
  if(!r||!Number.isInteger(r.status)||!r.body||typeof r.body!=='object'||JSON.stringify(r.body).toLowerCase().includes(b.credential.toLowerCase()))fail('TTS_SOURCE_RESPONSE_DENIED',502);
  return r;
 }
 async function capabilities(ctx,{brand}){
  if(!['fish','aristo'].includes(brand))fail('TTS_INPUT');
  const b=binding(ctx,{brand,write:false}),r=await call(ctx,b,{acao:'capacidades'}),c=r.body;
  if(r.status!==200||c.contract!=='tts_manual_runtime_v1'||c.operation!==true||!['write','cutover_verified','admission_verified'].every(k=>typeof c[k]==='boolean'))fail('TTS_SOURCE_CONTRACT',502);
  let write=false;try{binding(ctx,{brand,write:true});write=true;}catch(e){if(e.status!==403)throw e;}
  const technical=c.write&&c.cutover_verified&&c.admission_verified,approved=businessAllowed({brand,authorId:b.author.id})===true;
  return {schema:'shrigma-tts-capabilities-v1',brand,read:true,decision:write&&technical&&approved,reason:!write?'READ_ONLY':!technical?'TTS_SOURCE_CLOSED':!approved?'TTS_PROGRAM_APPROVAL_REQUIRED':null};
 }
 async function pending(ctx,{brand}){
  const b=binding(ctx,{brand,write:false}),open=db.prepare("SELECT * FROM simple_tts_attempts_v1 WHERE user_id=? AND brand=? AND state IN ('reserved','unknown') ORDER BY created_at DESC LIMIT 1001").all(b.author.id,brand);
  if(open.length>1000)fail('TTS_PENDING_REVIEW_REQUIRED',503);
  const recent=db.prepare("SELECT * FROM simple_tts_attempts_v1 WHERE user_id=? AND brand=? AND state IN ('accepted','blocked') ORDER BY created_at DESC LIMIT 100").all(b.author.id,brand);
  return {schema:'shrigma-tts-attempts-v1',brand,attempts:[...open,...recent].map(dto)};
 }
 async function receipt(ctx,row,b){
  if(row.binding!==b.binding)fail('TTS_ACCESS_CHANGED',403);
  const op={operation_id:row.operation_id,actor_sha256:row.actor_sha256,marca:row.brand,application_id:row.application_id,request_sha256:row.request_sha256,resultado:row.result,request_payload:null};
  const current=()=>{const check=binding(ctx,{brand:row.brand,write:false});if(check.binding!==b.binding||check.author.id!==row.user_id)fail('TTS_ACCESS_CHANGED',403);return db.prepare('SELECT * FROM simple_tts_attempts_v1 WHERE operation_id=? AND binding=?').get(row.operation_id,row.binding);};
  let result;try{result=await M.readReceipt(await call(ctx,b,{acao:'operacao',operation_id:op.operation_id,marca:op.marca,application_id:op.application_id}),op,crypto.webcrypto);}catch(e){if([401,403].includes(e.status))throw e;row=current();if(['accepted','blocked'].includes(row.state))fail('TTS_RECEIPT',502);db.prepare("UPDATE simple_tts_attempts_v1 SET state='unknown',updated_at=? WHERE operation_id=? AND state='reserved'").run(stamp(),row.operation_id);return {...dto(row),state:'unknown'};}
  row=current();
  if(result.payload&&result.payload.autor!==row.user_id)fail('TTS_RECEIPT',502);
  if(['accepted','blocked'].includes(row.state)&&result.state!==row.state)fail('TTS_RECEIPT',502);
  const state=['accepted','blocked'].includes(result.state)?result.state:'unknown';
  db.prepare("UPDATE simple_tts_attempts_v1 SET state=?,updated_at=? WHERE operation_id=? AND binding=? AND state IN ('reserved','unknown')").run(state,stamp(),row.operation_id,row.binding);
  return {...dto(row),state,...(result.receipt?{receipt:{...result.receipt}}:{})};
 }
 async function operation(ctx,q){const {row,b}=find(ctx,q);return receipt(ctx,row,b);}
 async function review(ctx,q){
  const id=input(q,['request_id','brand','application_id','resultado','motivo_rejeicao','observacao']),b=binding(ctx,{brand:id.marca,write:true});
  let payload;try{payload=M.normalize({...q,marca:id.marca,application_id:id.application_id,autor:b.author.id});}catch{fail('TTS_INPUT');}
  if(payload.observacao.toLowerCase().includes(b.credential.toLowerCase()))fail('TTS_INPUT');
  const requestHash=await M.hash(payload,crypto.webcrypto),prior=db.prepare('SELECT * FROM simple_tts_attempts_v1 WHERE user_id=? AND brand=? AND request_id=?').get(b.author.id,id.marca,q.request_id);
  if(prior){if(prior.application_id!==id.application_id||prior.request_sha256!==requestHash||prior.binding!==b.binding)fail('TTS_ATTEMPT_CHANGED',409);return receipt(ctx,prior,b);}
  if(!(await capabilities(ctx,{brand:id.marca})).decision)fail('TTS_WRITE_CLOSED',403);
  const op={operation_id:crypto.randomUUID(),actor_sha256:await M.actorHash(b.credential,crypto.webcrypto),marca:id.marca,application_id:id.application_id,request_sha256:requestHash,resultado:payload.resultado,request_payload:payload};
  let initial;try{initial=await M.readReceipt(await call(ctx,b,{acao:'operacao',operation_id:op.operation_id,marca:op.marca,application_id:op.application_id}),op,crypto.webcrypto);}catch(e){if([401,403].includes(e.status))throw e;fail('TTS_SOURCE_CONTRACT',502);}
  if(initial.missing!==true)fail('TTS_OPERATION_EXISTS',409);
  const current=binding(ctx,{brand:id.marca,write:true});if(current.binding!==b.binding||businessAllowed({brand:id.marca,authorId:b.author.id})!==true)fail('TTS_ACCESS_CHANGED',403);
  if(db.isTransaction)fail('TTS_BUSY',409);db.exec('BEGIN IMMEDIATE');let row;
  try{
   binding(ctx,{brand:id.marca,write:true});
   if(db.prepare('SELECT 1 FROM simple_tts_attempts_v1 WHERE brand=? AND application_id=?').get(id.marca,id.application_id))fail('TTS_APPLICATION_ALREADY_ATTEMPTED',409);
   const t=stamp();db.prepare("INSERT INTO simple_tts_attempts_v1 VALUES(?,?,?,?,?,?,?,?,?,'reserved',?,?)").run(op.operation_id,q.request_id,b.author.id,id.marca,id.application_id,b.binding,op.actor_sha256,requestHash,payload.resultado,t,t);
   db.exec('COMMIT');row=db.prepare('SELECT * FROM simple_tts_attempts_v1 WHERE operation_id=?').get(op.operation_id);
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
  // Reserve before the sole original POST. An ACK or transport failure never
  // releases this resource; recovery only reads the same original UUID.
  try{await call(ctx,b,null,{acao:'revisar',operation_id:op.operation_id,...payload});}catch(e){if([401,403].includes(e.status))throw e;}
  return receipt(ctx,row,b);
 }
 return Object.freeze({capabilities,pending,review,operation});
}
module.exports={createSimpleTTS};
