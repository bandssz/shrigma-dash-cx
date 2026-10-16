'use strict';
// Ready-made marketing pieces, owned by this CRM. No source API, sender,
// publication, Listmonk template, scheduling or transport is involved.
const crypto=require('node:crypto'),Input=require('./model-piece-input.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,REF=/^d_piece_[a-f0-9]{32}$/;
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const canonical=Input.canonical,hash=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
function create({db,authorize,now=Date.now}={}){
 if(!db?.prepare||typeof authorize!=='function'||typeof now!=='function')fail('PIECE_CONFIG',503);
 db.exec(`CREATE TABLE IF NOT EXISTS crm_model_piece_v1(
 draft_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN('aristo','fish')),
 attempt_key TEXT NOT NULL,request_json TEXT NOT NULL,request_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,
 UNIQUE(user_id,brand,attempt_key));`);
 function owner(context,brand,write=false){
  if(!['aristo','fish'].includes(brand)||context?.nativeBearer!==undefined||write&&context?.method!=='POST')fail('PIECE_COOKIE_CONTEXT_REQUIRED',403);
  const u=authorize({...context,area:'growth',productFront:'growth',brand,edit:false});
  if(write&&(!u.permissions?.growth?.edit||u.role!=='superadmin'&&!u.productWriteFronts?.includes('growth')))fail('PRODUCT_WRITE_DENIED',403);
  return u;
 }
 function draft(row){return {draft_id:row.draft_id,brand:row.brand,channel:'email',version:1,estado:'rascunho',storage:'crm',rascunho:JSON.parse(row.request_json).rascunho,created_at:new Date(row.created_at).toISOString()};}
 function envelope(brand,rows){return {contract:'crm-model-drafts-v1',brand,storage:'crm',drafts:rows.map(draft)};}
 function receipt(user,brand,key,row){return {contract:'template_operation_v1',storage:'crm',operation:{idempotency_key:key,acao:'rascunho',actor:'crm-user:'+user.id,request_payload:row?JSON.parse(row.request_json):null,request_sha256:row?.request_sha256||null,hash_schema:'json-stable-sha256-v1',state:row?'completed':'missing',response:row?{status:201,body:{estado:'rascunho',draft_id:row.draft_id,version:1,storage:'crm'}}:null,claim_id:null}};}
 function get(context,brand,id){owner(context,brand);if(!REF.test(id||''))fail('PIECE_INPUT');const row=db.prepare('SELECT * FROM crm_model_piece_v1 WHERE brand=? AND draft_id=?').get(brand,id);if(!row)fail('PIECE_NOT_FOUND',404);return envelope(brand,[row]);}
 function read({context,brand,query}){
  const user=owner(context,brand),action=query.get('acao');
  if(action==='modelos_capacidade'){const writable=user.permissions?.growth?.edit===true&&(user.role==='superadmin'||user.productWriteFronts?.includes('growth'));return {brand,read:true,draft:writable,storage:'crm',send:false,publish:false};}
  if(action==='rascunho_obter')return get(context,brand,query.get('draft_id'));
  if(action==='rascunhos_listar'){const offset=query.get('offset')||'0';if(!/^(?:0|[1-9][0-9]{0,4})$/.test(offset))fail('PIECE_INPUT');return envelope(brand,db.prepare('SELECT * FROM crm_model_piece_v1 WHERE brand=? ORDER BY created_at DESC,draft_id DESC LIMIT 20 OFFSET ?').all(brand,Number(offset)));}
  if(action==='operacao'){const key=query.get('idempotency_key');if(!UUID.test(key||'')||query.get('operacao')!=='rascunho')fail('PIECE_INPUT');return receipt(user,brand,key,db.prepare('SELECT * FROM crm_model_piece_v1 WHERE user_id=? AND brand=? AND attempt_key=?').get(user.id,brand,key));}
  fail('PIECE_READ_SCOPE',403);
 }
 function append({context,brand,body}){
  const user=owner(context,brand,true);
  if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).sort().join(',')!=='acao,idempotency_key,rascunho'||body.acao!=='rascunho'||!UUID.test(body.idempotency_key||''))fail('PIECE_INPUT');
  const r=body.rascunho,expected=Input.prepare({name:r?.nome,subject:r?.assunto,format:'html',content:r?.corpo},brand);
  if(canonical(expected)!==canonical(r))fail('PIECE_INPUT');
  const payload=Input.request(r),serialized=canonical(payload),digest=hash(payload);if(Buffer.byteLength(serialized)>290000)fail('PIECE_INPUT',413);
  if(db.isTransaction)fail('PIECE_TRANSACTION',409);db.exec('BEGIN IMMEDIATE');
  try{
   if(owner(context,brand,true).id!==user.id)fail('PIECE_ACCESS_CHANGED',403);
   let row=db.prepare('SELECT * FROM crm_model_piece_v1 WHERE user_id=? AND brand=? AND attempt_key=?').get(user.id,brand,body.idempotency_key);
   if(row){if(row.request_sha256!==digest||row.request_json!==serialized)fail('PIECE_ATTEMPT_CHANGED',409);}
   else{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('PIECE_CLOCK',503);const id='d_piece_'+crypto.randomUUID().replaceAll('-','');db.prepare('INSERT INTO crm_model_piece_v1 VALUES(?,?,?,?,?,?,?)').run(id,user.id,brand,body.idempotency_key,serialized,digest,t);row=db.prepare('SELECT * FROM crm_model_piece_v1 WHERE draft_id=?').get(id);}
   const result=receipt(user,brand,body.idempotency_key,row);db.exec('COMMIT');return result;
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
 }
 return Object.freeze({read,append,get});
}
module.exports={create};
