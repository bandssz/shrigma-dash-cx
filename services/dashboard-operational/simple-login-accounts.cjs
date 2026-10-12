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
function profile(row){
 if(!row||row.simple_fronts_json===null||row.simple_fronts_json===undefined)return null;
 try{
  const fronts=selection(JSON.parse(row.simple_fronts_json),FRONTS,'SIMPLE_PROFILE_INVALID');
  const brands=selection(JSON.parse(row.simple_brands_json),BRANDS,'SIMPLE_PROFILE_INVALID');
  if(JSON.stringify(fronts)!==row.simple_fronts_json||JSON.stringify(brands)!==row.simple_brands_json||row.role!=='manager'||typeof row.job_title!=='string'||!row.job_title.trim()||row.job_title.length>100)throw Error();
  return {jobTitle:row.job_title,fronts,brands};
 }catch{fail('SIMPLE_PROFILE_INVALID',403);}
}
function createSimpleAccounts({db,authorizeAdmin,authorizeUser,normalizeEmail,hashPassword,verifyPassword,now=Date.now}={}){
 if(!db||![authorizeAdmin,authorizeUser,normalizeEmail,hashPassword,verifyPassword,now].every(v=>typeof v==='function'))fail('SIMPLE_ACCOUNT_CONFIG',500);
 const columns=db.prepare('PRAGMA table_info(users)').all();
 for(const [name,type]of [['job_title','TEXT'],['simple_fronts_json','TEXT'],['simple_brands_json','TEXT']])if(!columns.some(c=>c.name===name))db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
 const find=id=>db.prepare('SELECT * FROM users WHERE id=?').get(id);
 const stamp=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('CLOCK_INVALID',500);return t;};
 const snapshot=row=>JSON.stringify([row?.id,row?.role,row?.state,row?.password_hash,row?.updated_at,row?.job_title,row?.simple_fronts_json,row?.simple_brands_json]);
 function view(row){const p=profile(row);return {id:row.id,email:row.email,jobTitle:p?.jobTitle||'administrador',fronts:p?.fronts||FRONTS,brands:p?.brands||BRANDS,active:row.state==='active',administrator:row.role==='superadmin'};}
 function transaction(work){if(db.isTransaction)fail('SIMPLE_ACCOUNT_TRANSACTION',409);db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}}
 function target(id){const row=find(id);if(!row||row.role!=='manager'||!profile(row))fail('SIMPLE_USER_NOT_FOUND',404);return row;}
 function scopes(input){const jobTitle=typeof input.jobTitle==='string'?input.jobTitle.trim():'';if(!jobTitle||jobTitle.length>100||/[\x00-\x1f\x7f]/.test(jobTitle))fail('JOB_TITLE_INVALID');return {jobTitle,fronts:selection(input.fronts,FRONTS,'FRONTS_INVALID'),brands:selection(input.brands,BRANDS,'BRANDS_INVALID')};}
 function grants(id,fronts){db.prepare('DELETE FROM grants WHERE user_id=?').run(id);for(const area of [...new Set(fronts.map(f=>AREA[f]))])db.prepare('INSERT INTO grants(user_id,area,can_read,can_edit) VALUES(?,?,1,0)').run(id,area);}
 async function create({context,email,password,jobTitle,fronts,brands}){
  const admin=authorizeAdmin(context),address=normalizeEmail(email),p=scopes({jobTitle,fronts,brands});
  if(db.prepare('SELECT 1 FROM users WHERE email=?').get(address))fail('EMAIL_EXISTS',409);
  const passwordHash=await hashPassword(password);
  const id=crypto.randomUUID(),t=stamp();
  return transaction(()=>{
   if(authorizeAdmin(context).id!==admin.id)fail('ADMIN_CHANGED',409);
   if(db.prepare('SELECT 1 FROM users WHERE email=?').get(address))fail('EMAIL_EXISTS',409);
   db.prepare("INSERT INTO users(id,email,role,state,password_hash,created_at,updated_at,job_title,simple_fronts_json,simple_brands_json) VALUES(?,?,'manager','active',?,?,?,?,?,?)").run(id,address,passwordHash,t,t,p.jobTitle,JSON.stringify(p.fronts),JSON.stringify(p.brands));
   grants(id,p.fronts);return {ok:true,user:view(find(id))};
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
 function update({context,userId,jobTitle,fronts,brands,active}){
  authorizeAdmin(context);const p=scopes({jobTitle,fronts,brands});if(typeof active!=='boolean')fail('ACTIVE_INVALID');
  return transaction(()=>{
   target(userId);authorizeAdmin(context);
   db.prepare('UPDATE users SET job_title=?,simple_fronts_json=?,simple_brands_json=?,state=?,updated_at=? WHERE id=?').run(p.jobTitle,JSON.stringify(p.fronts),JSON.stringify(p.brands),active?'active':'disabled',stamp(),userId);
   grants(userId,p.fronts);db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);return {ok:true,user:view(find(userId))};
  });
 }
 function list({context}){authorizeUser({...context,admin:true});return db.prepare("SELECT * FROM users WHERE role='superadmin' OR simple_fronts_json IS NOT NULL ORDER BY email").all().map(view);}
 return Object.freeze({create,resetPassword,changePassword,update,list,profile:id=>profile(find(id))});
}
module.exports={createSimpleAccounts,profile,FRONTS,BRANDS};
