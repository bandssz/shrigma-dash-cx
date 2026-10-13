'use strict';
// Ordinary account management in the existing SQLite database. Front/brand
// selections are local application permissions, never upstream credentials.
const crypto=require('node:crypto');
const FRONTS=Object.freeze(['growth','organico','influs','afiliados']);
const BRANDS=Object.freeze(['fish','aristo','olivas']);
const AREA={growth:'growth',organico:'organico',influs:'influs',afiliados:'influs'};
function fail(code,status=400){throw Object.assign(Error(code),{code,status});}
function selection(value,allowed,code){
 if(!Array.isArray(value)||!value.length||value.length>allowed.length||new Set(value).size!==value.length||value.some(v=>!allowed.includes(v)))fail(code);
 return allowed.filter(v=>value.includes(v));
}
function writes(value,fronts){
 if(value===undefined||value===null)return [];
 if(!Array.isArray(value)||value.length>fronts.length||new Set(value).size!==value.length||value.some(v=>!fronts.includes(v)))fail('WRITE_FRONTS_INVALID');
 return FRONTS.filter(v=>value.includes(v));
}
function profile(row){
 if(!row||row.simple_fronts_json===null||row.simple_fronts_json===undefined)return null;
 try{
  const fronts=selection(JSON.parse(row.simple_fronts_json),FRONTS,'SIMPLE_PROFILE_INVALID');
  const brands=selection(JSON.parse(row.simple_brands_json),BRANDS,'SIMPLE_PROFILE_INVALID');
  if(JSON.stringify(fronts)!==row.simple_fronts_json||JSON.stringify(brands)!==row.simple_brands_json||row.role!=='manager'||typeof row.job_title!=='string'||!row.job_title.trim()||row.job_title.length>100)throw Error();
  const writeFronts=writes(row.simple_write_fronts_json===undefined||row.simple_write_fronts_json===null?[]:JSON.parse(row.simple_write_fronts_json),fronts);
  if(row.simple_write_fronts_json!==undefined&&row.simple_write_fronts_json!==null&&JSON.stringify(writeFronts)!==row.simple_write_fronts_json)throw Error();
  return {jobTitle:row.job_title,fronts,brands,writeFronts};
 }catch{fail('SIMPLE_PROFILE_INVALID',403);}
}
function createSimpleAccounts({db,authorizeAdmin,authorizeUser,normalizeEmail,hashPassword,verifyPassword,now=Date.now}={}){
 if(!db||![authorizeAdmin,authorizeUser,normalizeEmail,hashPassword,verifyPassword,now].every(v=>typeof v==='function'))fail('SIMPLE_ACCOUNT_CONFIG',500);
 const columns=db.prepare('PRAGMA table_info(users)').all();
 for(const [name,type]of [['job_title','TEXT'],['simple_fronts_json','TEXT'],['simple_brands_json','TEXT'],['simple_write_fronts_json','TEXT']])if(!columns.some(c=>c.name===name))db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
 // Metadata only: one durable attempt and its original person/brand/candidate.
 // Names, notes, contacts and source credentials are never copied here.
 db.exec(`CREATE TABLE IF NOT EXISTS simple_affiliate_edits_v1(request_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),candidate_id TEXT NOT NULL,expected_version INTEGER NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','uncertain','confirmed','rejected','not_sent')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS simple_affiliate_edits_pending_v1 ON simple_affiliate_edits_v1(brand,candidate_id) WHERE state IN ('reserved','uncertain');`);
 // Test drafts only. Reuses the login database; never enrolls or sends.
 db.exec(`CREATE TABLE IF NOT EXISTS simple_journey_lab_v1(user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),revision INTEGER NOT NULL CHECK(revision>0),payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,brand));`);
 const find=id=>db.prepare('SELECT * FROM users WHERE id=?').get(id);
 const stamp=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('CLOCK_INVALID',500);return t;};
 const snapshot=row=>JSON.stringify([row?.id,row?.role,row?.state,row?.password_hash,row?.updated_at,row?.job_title,row?.simple_fronts_json,row?.simple_brands_json,row?.simple_write_fronts_json]);
 function view(row){const p=profile(row);return {id:row.id,email:row.email,jobTitle:p?.jobTitle||'administrador',fronts:p?.fronts||FRONTS,brands:p?.brands||BRANDS,writeFronts:p?.writeFronts||FRONTS,active:row.state==='active',administrator:row.role==='superadmin'};}
 function transaction(work){if(db.isTransaction)fail('SIMPLE_ACCOUNT_TRANSACTION',409);db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}}
 function target(id){const row=find(id);if(!row||row.role!=='manager'||!profile(row))fail('SIMPLE_USER_NOT_FOUND',404);return row;}
 function scopes(input){const jobTitle=typeof input.jobTitle==='string'?input.jobTitle.trim():'';if(!jobTitle||jobTitle.length>100||/[\x00-\x1f\x7f]/.test(jobTitle))fail('JOB_TITLE_INVALID');const fronts=selection(input.fronts,FRONTS,'FRONTS_INVALID');return {jobTitle,fronts,brands:selection(input.brands,BRANDS,'BRANDS_INVALID'),writeFronts:writes(input.writeFronts,fronts)};}
 function grants(id,fronts,writeFronts=[]){db.prepare('DELETE FROM grants WHERE user_id=?').run(id);for(const area of [...new Set(fronts.map(f=>AREA[f]))])db.prepare('INSERT INTO grants(user_id,area,can_read,can_edit) VALUES(?,?,1,?)').run(id,area,writeFronts.some(f=>AREA[f]===area)?1:0);}
 async function create({context,email,password,jobTitle,fronts,brands,writeFronts}){
  const admin=authorizeAdmin(context),address=normalizeEmail(email),p=scopes({jobTitle,fronts,brands,writeFronts});
  if(db.prepare('SELECT 1 FROM users WHERE email=?').get(address))fail('EMAIL_EXISTS',409);
  const passwordHash=await hashPassword(password);
  const id=crypto.randomUUID(),t=stamp();
  return transaction(()=>{
   if(authorizeAdmin(context).id!==admin.id)fail('ADMIN_CHANGED',409);
   if(db.prepare('SELECT 1 FROM users WHERE email=?').get(address))fail('EMAIL_EXISTS',409);
   db.prepare("INSERT INTO users(id,email,role,state,password_hash,created_at,updated_at,job_title,simple_fronts_json,simple_brands_json,simple_write_fronts_json) VALUES(?,?,'manager','active',?,?,?,?,?,?,?)").run(id,address,passwordHash,t,t,p.jobTitle,JSON.stringify(p.fronts),JSON.stringify(p.brands),JSON.stringify(p.writeFronts));
   grants(id,p.fronts,p.writeFronts);return {ok:true,user:view(find(id))};
  });
 }
 async function resetPassword({context,userId,password}){
  const admin=authorizeAdmin(context),before=target(userId),expected=snapshot(before),passwordHash=await hashPassword(password);
  return transaction(()=>{
   if(authorizeAdmin(context).id!==admin.id||snapshot(target(userId))!==expected)fail('USER_CHANGED',409);
   db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash,stamp(),userId);
   db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);return {ok:true};
  });
 }
 async function changePassword({context,currentPassword,password}){
  const user=authorizeUser(context),before=find(user.id),expected=snapshot(before);
  if(!before||before.state!=='active'||!await verifyPassword(currentPassword,before.password_hash))fail('PASSWORD_CURRENT_INVALID',403);
  const passwordHash=await hashPassword(password,{legacyCompatible:before.password_hash.startsWith('scrypt$')});
  return transaction(()=>{
   if(authorizeUser(context).id!==user.id||snapshot(find(user.id))!==expected)fail('USER_CHANGED',409);
   db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash,stamp(),user.id);
   db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);return {ok:true,signInAgain:true};
  });
 }
 function update({context,userId,jobTitle,fronts,brands,active,writeFronts}){
  authorizeAdmin(context);const before=target(userId),p=scopes({jobTitle,fronts,brands,writeFronts:writeFronts===undefined?profile(before).writeFronts.filter(f=>fronts?.includes(f)):writeFronts});if(typeof active!=='boolean')fail('ACTIVE_INVALID');
  return transaction(()=>{
   target(userId);authorizeAdmin(context);
   db.prepare('UPDATE users SET job_title=?,simple_fronts_json=?,simple_brands_json=?,simple_write_fronts_json=?,state=?,updated_at=? WHERE id=?').run(p.jobTitle,JSON.stringify(p.fronts),JSON.stringify(p.brands),JSON.stringify(p.writeFronts),active?'active':'disabled',stamp(),userId);
   grants(userId,p.fronts,p.writeFronts);db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);return {ok:true,user:view(find(userId))};
  });
 }
 function list({context}){authorizeUser({...context,admin:true});return db.prepare("SELECT * FROM users WHERE role='superadmin' OR simple_fronts_json IS NOT NULL ORDER BY email").all().map(view);}
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
 function pendingAffiliateEdits({context,brand}){
  const user=authorizeUser({...context,area:'influs',productFront:'afiliados',brand,edit:false});
  return db.prepare("SELECT request_id,candidate_id,expected_version,state FROM simple_affiliate_edits_v1 WHERE user_id=? AND brand=? AND state IN ('reserved','uncertain') ORDER BY created_at DESC").all(user.id,brand);
 }
 function affiliateEdit({context,requestId,brand,candidateId}){
  const user=authorizeUser({...context,area:'influs',productFront:'afiliados',brand,edit:false});
  if(typeof requestId!=='string'||typeof candidateId!=='string'||!UUID.test(requestId)||!UUID.test(candidateId))fail('AFFILIATE_ARGUMENTS_INVALID');
  const row=db.prepare('SELECT * FROM simple_affiliate_edits_v1 WHERE request_id=? AND user_id=? AND brand=? AND candidate_id=?').get(requestId,user.id,brand,candidateId);if(!row)fail('AFFILIATE_OPERATION_NOT_FOUND',404);return {...row};
 }
 function reserveAffiliateEdit({context,requestId,brand,candidateId,expectedVersion,binding}){
  const user=authorizeUser({...context,area:'influs',productFront:'afiliados',brand,edit:true});
  if(typeof requestId!=='string'||typeof candidateId!=='string'||typeof binding!=='string'||!UUID.test(requestId)||!UUID.test(candidateId)||!['fish','aristo'].includes(brand)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||expectedVersion>99999999||!/^[a-f0-9]{64}$/.test(binding))fail('AFFILIATE_ARGUMENTS_INVALID');
  return transaction(()=>{
   authorizeUser({...context,area:'influs',productFront:'afiliados',brand,edit:true});
   if(db.prepare('SELECT 1 FROM simple_affiliate_edits_v1 WHERE request_id=?').get(requestId))fail('AFFILIATE_OPERATION_ALREADY_ATTEMPTED',409);
   if(db.prepare("SELECT 1 FROM simple_affiliate_edits_v1 WHERE brand=? AND candidate_id=? AND state IN ('reserved','uncertain')").get(brand,candidateId))fail('AFFILIATE_OPERATION_UNCERTAIN',409);
   const t=stamp();db.prepare("INSERT INTO simple_affiliate_edits_v1 VALUES(?,?,?,?,?,?,'reserved',?,?)").run(requestId,user.id,brand,candidateId,expectedVersion,binding,t,t);
   return affiliateEdit({context,requestId,brand,candidateId});
  });
 }
 function finishAffiliateEdit(row,state){
  if(!row||!['uncertain','confirmed','rejected','not_sent'].includes(state))fail('AFFILIATE_OPERATION_INVALID');
  const r=db.prepare("UPDATE simple_affiliate_edits_v1 SET state=?,updated_at=? WHERE request_id=? AND user_id=? AND binding=? AND state IN ('reserved','uncertain')").run(state,stamp(),row.request_id,row.user_id,row.binding);
  if(r.changes!==1){
   const current=db.prepare('SELECT state FROM simple_affiliate_edits_v1 WHERE request_id=? AND user_id=? AND binding=?').get(row.request_id,row.user_id,row.binding);
   if(current?.state===state||current?.state==='confirmed'&&state==='uncertain')return current.state;
   fail('AFFILIATE_OPERATION_CHANGED',409);
  }
  return state;
 }
 function labOwner(context,brand,write=false){
  if(!['fish','aristo'].includes(brand))fail('LAB_BRAND_INVALID');
  // Local test edits require CSRF and delegated WRITE, without borrowing the
  // legacy campaign writer or granting any remote mutation.
  const user=authorizeUser({...context,area:'growth',productFront:'growth',brand,edit:false});
  if(write&&user.role!=='superadmin'&&!user.productWriteFronts?.includes('growth'))fail('PRODUCT_WRITE_DENIED',403);
  return user;
 }
 function labRead({context,brand}){
  const user=labOwner(context,brand),row=db.prepare('SELECT * FROM simple_journey_lab_v1 WHERE user_id=? AND brand=?').get(user.id,brand);
  const engine=require('./public/crm-preview/journey-engine.js'),store=engine.readStore(row?.payload_json??null);
  if(store.drafts.some(d=>d.brand!==brand)||store.runs.some(r=>r.draft.brand!==brand))fail('LAB_STORAGE_INVALID',503);
  return {persistence:'server',userId:user.id,brand,revision:row?.revision||0,store,savedAt:row?new Date(row.updated_at).toISOString():null,executes:false};
 }
 function labSave({context,brand,expected_revision,store}){
  const user=labOwner(context,brand,true);
  if(!Number.isSafeInteger(expected_revision)||expected_revision<0||expected_revision>=2147483647)fail('LAB_REVISION_INVALID');
  const serialized=JSON.stringify(store),checked=require('./public/crm-preview/journey-engine.js').readStore(serialized);
  if(checked.drafts.some(d=>d.brand!==brand)||checked.runs.some(r=>r.draft.brand!==brand))fail('LAB_BRAND_INVALID');
  return transaction(()=>{
   if(labOwner(context,brand,true).id!==user.id)fail('LAB_ACCESS_CHANGED',403);
   const row=db.prepare('SELECT revision FROM simple_journey_lab_v1 WHERE user_id=? AND brand=?').get(user.id,brand);
   if((row?.revision||0)!==expected_revision)fail('LAB_VERSION_CHANGED',409);
   const t=stamp();db.prepare('INSERT INTO simple_journey_lab_v1(user_id,brand,revision,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,brand) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json,updated_at=excluded.updated_at').run(user.id,brand,expected_revision+1,serialized,t,t);
   return labRead({context,brand});
  });
 }
 return Object.freeze({create,resetPassword,changePassword,update,list,profile:id=>profile(find(id)),affiliateEdit,pendingAffiliateEdits,reserveAffiliateEdit,finishAffiliateEdit,labRead,labSave});
}
module.exports={createSimpleAccounts,profile,FRONTS,BRANDS};
