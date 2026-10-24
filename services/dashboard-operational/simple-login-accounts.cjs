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
// Descriptive registry: the fields and two arms reuse growth-ab-protocol's
// create contract. This table is local planning only; it has no executor.
function createAbRegistry({db,authorize,now=Date.now}){
 db.exec("CREATE TABLE IF NOT EXISTS simple_crm_ab_plans_v1(request_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN ('fish','aristo','olivas')),payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL)");
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
 const text=(v,max)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
 const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
 const view=r=>({requestId:r.request_id,brand:r.brand,plan:JSON.parse(r.payload_json),createdAt:new Date(r.created_at).toISOString(),executes:false,schedules:false});
 function owner(context,brand,write=false){
  if(!BRANDS.includes(brand)||context?.nativeBearer!==undefined||write&&context?.method!=='POST')fail('AB_COOKIE_CONTEXT_REQUIRED',403);
  const u=authorize({...context,area:'growth',productFront:'growth',brand,edit:false});
  if(write&&(!u.permissions?.growth?.edit||u.role!=='superadmin'&&!u.productWriteFronts?.includes('growth')))fail('PRODUCT_WRITE_DENIED',403);
  return u;
 }
 function validate(plan){
  if(!exact(plan,['name','hypothesis','variable','metric','minEffect','windowDays','channel','variants'])||!['name','hypothesis','variable','metric'].every(k=>text(plan[k],k==='name'?200:4000))||!['email','whatsapp'].includes(plan.channel)||!Number.isInteger(plan.windowDays)||plan.windowDays<1||plan.windowDays>365||plan.minEffect!==null&&!(typeof plan.minEffect==='number'&&Number.isFinite(plan.minEffect)&&plan.minEffect>=0&&plan.minEffect<=1000000)||!Array.isArray(plan.variants)||plan.variants.length!==2)fail('AB_PLAN_INVALID');
  for(const v of plan.variants)if(!exact(v,['label','campaignId','description'])||!text(v.label,64)||!text(v.description,4000)||v.campaignId!==null&&(!Number.isInteger(v.campaignId)||v.campaignId<1||v.campaignId>2147483647))fail('AB_PLAN_VARIANT_INVALID');
  if(plan.variants[0].label.trim()===plan.variants[1].label.trim())fail('AB_PLAN_VARIANT_DUPLICATE');
  return {name:plan.name.trim(),hypothesis:plan.hypothesis.trim(),variable:plan.variable.trim(),metric:plan.metric.trim(),minEffect:plan.minEffect,windowDays:plan.windowDays,channel:plan.channel,variants:plan.variants.map(v=>({label:v.label.trim(),campaignId:v.campaignId,description:v.description.trim()}))};
 }
 function read({context,brand,requestId}){
  const u=owner(context,brand);if(requestId!==undefined&&!uuid(requestId))fail('AB_REQUEST_INVALID');
  if(requestId!==undefined){const row=db.prepare('SELECT * FROM simple_crm_ab_plans_v1 WHERE request_id=? AND user_id=? AND brand=?').get(requestId,u.id,brand);if(!row)fail('AB_RECORD_NOT_FOUND',404);return {schema:'crm-ab-planning-v1',record:view(row),executes:false,schedules:false};}
  const rows=db.prepare('SELECT * FROM simple_crm_ab_plans_v1 WHERE user_id=? AND brand=? ORDER BY created_at DESC,request_id DESC LIMIT 101').all(u.id,brand);
  return {schema:'crm-ab-planning-v1',brand,records:rows.slice(0,100).map(view),more:rows.length>100,scope:'own',executes:false,schedules:false};
 }
 function append({context,brand,requestId,expectedUserId,plan}){
  const u=owner(context,brand,true);if(expectedUserId!==u.id)fail('AB_ACCESS_CHANGED',403);if(!uuid(requestId))fail('AB_REQUEST_INVALID');const serialized=JSON.stringify(validate(plan)),hash=crypto.createHash('sha256').update(serialized).digest('hex');
  if(db.isTransaction)fail('AB_TRANSACTION_INVALID',409);db.exec('BEGIN IMMEDIATE');
  try{if(owner(context,brand,true).id!==u.id)fail('AB_ACCESS_CHANGED',403);const old=db.prepare('SELECT * FROM simple_crm_ab_plans_v1 WHERE request_id=?').get(requestId);
   if(old){if(old.user_id!==u.id||old.brand!==brand||old.payload_sha256!==hash)fail('AB_REQUEST_CONFLICT',409);}
   else{const t=now();if(!Number.isSafeInteger(t)||t<0)fail('CLOCK_INVALID',500);db.prepare('INSERT INTO simple_crm_ab_plans_v1(request_id,user_id,brand,payload_json,payload_sha256,created_at) VALUES(?,?,?,?,?,?)').run(requestId,u.id,brand,serialized,hash,t);}
   const result=read({context,brand,requestId});db.exec('COMMIT');return result;
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
 }
 return Object.freeze({read,append});
}
function createSimpleAccounts({db,authorizeAdmin,authorizeUser,normalizeEmail,hashPassword,verifyPassword,now=Date.now,journeyTestTransport,testDiagnostics,currentUser}={}){
 if(!db||![authorizeAdmin,authorizeUser,normalizeEmail,hashPassword,verifyPassword,now,currentUser].every(v=>typeof v==='function'))fail('SIMPLE_ACCOUNT_CONFIG',500);
 const columns=db.prepare('PRAGMA table_info(users)').all();
 for(const [name,type]of [['job_title','TEXT'],['simple_fronts_json','TEXT'],['simple_brands_json','TEXT'],['simple_write_fronts_json','TEXT']])if(!columns.some(c=>c.name===name))db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
 // Metadata only: one durable attempt and its original person/brand/candidate.
 // Names, notes, contacts and source credentials are never copied here.
 db.exec(`CREATE TABLE IF NOT EXISTS simple_affiliate_edits_v1(request_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),candidate_id TEXT NOT NULL,expected_version INTEGER NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','uncertain','confirmed','rejected','not_sent')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS simple_affiliate_edits_pending_v1 ON simple_affiliate_edits_v1(brand,candidate_id) WHERE state IN ('reserved','uncertain');`);
 // Test drafts only. Reuses the login database; never enrolls or sends.
 db.exec(`CREATE TABLE IF NOT EXISTS simple_journey_lab_v1(user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),revision INTEGER NOT NULL CHECK(revision>0),payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,brand));
 CREATE TABLE IF NOT EXISTS simple_journey_lab_revision_v1(user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),revision INTEGER NOT NULL CHECK(revision>0),payload_json TEXT NOT NULL,baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,brand,revision));
 CREATE TABLE IF NOT EXISTS simple_journey_lab_models_v1(user_id TEXT NOT NULL,brand TEXT NOT NULL,revision INTEGER NOT NULL,refs_json TEXT NOT NULL,PRIMARY KEY(user_id,brand,revision),FOREIGN KEY(user_id,brand,revision) REFERENCES simple_journey_lab_revision_v1(user_id,brand,revision));
 CREATE TABLE IF NOT EXISTS simple_journey_lab_send_windows_v1(user_id TEXT NOT NULL,brand TEXT NOT NULL,revision INTEGER NOT NULL,windows_json TEXT NOT NULL,PRIMARY KEY(user_id,brand,revision),FOREIGN KEY(user_id,brand,revision) REFERENCES simple_journey_lab_revision_v1(user_id,brand,revision));`);
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
  if(write&&(user.permissions?.growth?.edit!==true||user.role!=='superadmin'&&!user.productWriteFronts?.includes('growth')))fail('PRODUCT_WRITE_DENIED',403);
  return user;
 }
 // Paid-entry QA is deliberately outside simple_journey_lab*. A previous
 // release cannot discover these definitions through getDraft or send TEST.
 if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='simple_journey_paid_qa_v1'").get()){
  const main=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main');
  if(main?.file){const fs=require('node:fs'),path=require('node:path'),dir=path.join(path.dirname(main.file),'paid-qa-backups');fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.lstatSync(dir).isSymbolicLink()||!fs.lstatSync(dir).isDirectory())fail('PAID_QA_BACKUP_REQUIRED',503);const file=path.join(dir,'before-paid-qa-'+crypto.randomUUID()+'.sqlite');db.exec("VACUUM INTO '"+file.replaceAll("'","''")+"'");fs.chmodSync(file,0o600);if(fs.statSync(file).size<1)fail('PAID_QA_BACKUP_REQUIRED',503);}
  db.exec("CREATE TABLE simple_journey_paid_qa_v1(user_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN ('aristo','fish')),revision INTEGER NOT NULL CHECK(revision>0),qa_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,brand,revision))");
 }
 const paidEngine=require('./public/crm-preview/journey-engine.js');
 const paidEmpty=()=>({schema:'shrigma-paid-journey-qa-v1',definitions:[],rounds:[],lastMutationId:null});
 const paidKeys=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
 function paidOwner(context,brand,write=false){
  if(context?.nativeBearer!==undefined||write&&context?.method!=='POST')fail('PAID_QA_COOKIE_REQUIRED',403);
  const u=labOwner(context,brand,write);
  if(!require('./crm-ui-features.cjs').restrictedUser(u)&&!/^editor-qa-(?:aristo|fish)@shrigma\.com\.br$/i.test(u.email||''))fail('PAID_QA_RESTRICTED',403);
  return u;
 }
 function entryOwner(context,brand,write=false){
  if(context?.nativeBearer!==undefined||write&&context?.method!=='POST')fail('ENTRY_QA_COOKIE_REQUIRED',403);
  const user=labOwner(context,brand,write);
  if(user.permissions?.growth?.edit!==true||user.role!=='superadmin'&&!user.productWriteFronts?.includes('growth'))fail('PRODUCT_WRITE_DENIED',403);
  return user;
 }
 function paidHead(userId,brand){
  const row=db.prepare('SELECT revision,qa_json FROM simple_journey_paid_qa_v1 WHERE user_id=? AND brand=? ORDER BY revision DESC LIMIT 1').get(userId,brand),qa=row?JSON.parse(row.qa_json):paidEmpty();
  if(!paidKeys(qa,'schema,definitions,rounds,lastMutationId')||qa.schema!=='shrigma-paid-journey-qa-v1'||!Array.isArray(qa.definitions)||qa.definitions.length>20||!Array.isArray(qa.rounds)||qa.rounds.length>20||JSON.stringify(qa).length>500000)fail('PAID_QA_STORAGE_INVALID',503);
  const defs=new Set(),rounds=new Set();for(const d of qa.definitions){paidEngine.validateDraft(d);if(d.brand!==brand||d.trigger!=='order_paid'||defs.has(d.id))fail('PAID_QA_STORAGE_INVALID',503);defs.add(d.id);}
  for(const r of qa.rounds){if(!paidKeys(r,'id,person,entryOrderId,run,receipts,decisions,policy,mode,realSends')||r.mode!=='synthetic'||r.realSends!==0||r.run?.draft?.brand!==brand||r.run?.draft?.trigger!=='order_paid'||!defs.has(r.run?.draft?.id)||rounds.has(r.id)||!Array.isArray(r.decisions)||r.decisions.length>200||JSON.stringify(r.policy)!==JSON.stringify(paidEngine.PAID_POLICY)||typeof r.person!=='string'||!Array.isArray(r.receipts)||r.receipts.length>100||!r.person.startsWith('synthetic:'+userId+':'))fail('PAID_QA_STORAGE_INVALID',503);paidEngine.validateRun(r.run);rounds.add(r.id);}
  return {revision:row?.revision||0,qa};
 }
 function paidReceipt(userId,brand,mutationId){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(mutationId||''))fail('PAID_QA_ARGUMENTS');const row=db.prepare("SELECT revision FROM simple_journey_paid_qa_v1 WHERE user_id=? AND brand=? AND json_extract(qa_json,'$.lastMutationId')=? ORDER BY revision DESC LIMIT 1").get(userId,brand,mutationId);return {mutationId,confirmed:!!row,revision:row?.revision||null};}
 function paidQaRead({context,brand,mutationId}){const u=paidOwner(context,brand),head=paidHead(u.id,brand);return {persistence:'server',userId:u.id,brand,...head,...(mutationId?{mutationReceipt:paidReceipt(u.id,brand,mutationId)}:{}),policy:paidEngine.PAID_POLICY,executes:false,sends:0};}
 function paidQaMutate({context,brand,expected_revision,mutationId,action,...args}){
  const user=paidOwner(context,brand,true);if(!Number.isSafeInteger(expected_revision)||expected_revision<0||expected_revision>=2147483647||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(mutationId||''))fail('PAID_QA_ARGUMENTS');
  const keys={create:'name,waitMinutes',update:'draftId,name,waitMinutes',start:'draftId,personId',advance:'roundId,minutes,payment,mailEvidence,afterEntry',resolve:'originalMutationId'};if(!keys[action]||!paidKeys(args,keys[action]))fail('PAID_QA_ARGUMENTS');
  return transaction(()=>{
   if(paidOwner(context,brand,true).id!==user.id)fail('PAID_QA_ACCESS_CHANGED',403);
   const head=paidHead(user.id,brand);if(head.revision!==expected_revision)fail('PAID_QA_VERSION_CHANGED',409);if(paidReceipt(user.id,brand,mutationId).confirmed)fail('PAID_QA_MUTATION_REUSED',409);const q=head.qa;
   if(action==='resolve'){
    if(paidReceipt(user.id,brand,args.originalMutationId).confirmed)return paidQaRead({context,brand,mutationId:args.originalMutationId});
   }else if(action==='create'||action==='update'){
    if(typeof args.name!=='string'||!args.name.trim()||args.name.length>100||/[\x00-\x1f\x7f]/.test(args.name)||!Array.isArray(args.waitMinutes)||!args.waitMinutes.length||args.waitMinutes.length>5||args.waitMinutes.some((v,i)=>!Number.isSafeInteger(v)||v<0||v>43200||i>0&&v<args.waitMinutes[i-1]))fail('PAID_QA_DEFINITION_INVALID');
    const old=action==='update'?q.definitions.find(d=>d.id===args.draftId):null;if(action==='update'&&!old)fail('PAID_QA_NOT_FOUND',404);if(!old&&q.definitions.length>=20)fail('PAID_QA_LIMIT',409);
    const d=old?JSON.parse(JSON.stringify(old)):paidEngine.createDraft({brand,id:crypto.randomUUID()});d.trigger='order_paid';d.name=args.name.trim();d.audience='Pessoa sintética · pedido pago';d.steps=args.waitMinutes.map((waitMinutes,i)=>({id:'step-'+(i+1),channel:'email',waitMinutes,enabled:true,templateName:'Mensagem QA '+(i+1),subject:'[TESTE] Pedido pago · '+(i+1),text:'[TESTE] Ensaio sintético sem transporte.'}));const saved=old?paidEngine.saveDraft(old,d):paidEngine.validateDraft(d);q.definitions=old?q.definitions.map(x=>x.id===old.id?saved:x):[...q.definitions,saved];
   }else{
    const all=[...['aristo','fish'].flatMap(b=>paidHead(user.id,b).qa.rounds),...entryQa.capRounds(user.id)],globalNow=Math.max(stamp(),...all.map(r=>r.run.now));
    if(action==='start'){
     if(q.rounds.length>=20)fail('PAID_QA_LIMIT',409);const d=q.definitions.find(d=>d.id===args.draftId);if(!d)fail('PAID_QA_NOT_FOUND',404);if(!/^[a-z0-9_-]{1,40}$/.test(args.personId||''))fail('PAID_QA_PERSON_INVALID');
     const id=crypto.randomUUID(),run=paidEngine.newRun(d,{eventId:'synthetic:'+id,startedAt:globalNow});q.rounds.push({id,person:'synthetic:'+user.id+':'+args.personId,entryOrderId:'synthetic-order:'+id,run,receipts:[],decisions:[],policy:{...paidEngine.PAID_POLICY},mode:'synthetic',realSends:0});
    }else{
     const r=q.rounds.find(r=>r.id===args.roundId);if(!r)fail('PAID_QA_NOT_FOUND',404);if(![0,1,60,1440].includes(args.minutes)||!['paid','pending','unknown','refunded'].includes(args.payment)||!['empty','campaign','journey','ses','unknown','incomplete','stale'].includes(args.mailEvidence)||!['none','purchase','optout','unknown'].includes(args.afterEntry)||r.decisions.length>190||r.run.trace.length>190)fail('PAID_QA_SCENARIO_INVALID');
     const at=Math.max(globalNow,r.run.now+args.minutes*60000);if(['campaign','journey','ses'].includes(args.mailEvidence)){const id='synthetic-message:'+r.id+':'+args.mailEvidence+':'+paidEngine.paidDay(at);if(!r.receipts.some(x=>x.id===id)){if(r.receipts.length>=100)fail('PAID_QA_LIMIT',409);r.receipts.push({id,person:r.person,at,kind:args.mailEvidence});}}const receipts=[...all.filter(x=>x.person===r.person).flatMap(x=>x.receipts),...r.receipts].filter(x=>paidEngine.paidDay(x.at)===paidEngine.paidDay(at)),evidence={mode:'synthetic',brand,person:r.person,entryOrderId:r.entryOrderId,payment:{state:args.payment,orderId:r.entryOrderId,occurredAt:r.run.startedAt},observedAt:args.mailEvidence==='stale'?at-300001:at,coverage:{day:paidEngine.paidDay(at),complete:!['unknown','incomplete'].includes(args.mailEvidence),campaigns:true,journeys:true,ses:true,brands:['aristo','fish']},receipts,afterEntryPurchase:args.afterEntry==='unknown'?null:paidEngine.fact(args.afterEntry==='purchase',at),emailAllowed:paidEngine.fact(args.afterEntry!=='optout',at)};
     const result=paidEngine.advancePaid(r.run,{now:at,evidence,rounds:all});r.run=result.run;r.decisions.push(...result.decisions.map(d=>({...d,at,payment:args.payment,mailEvidence:args.mailEvidence,afterEntry:args.afterEntry})));
    }
   }
   q.lastMutationId=mutationId;const serialized=JSON.stringify(q);if(serialized.length>500000)fail('PAID_QA_LIMIT',409);db.prepare('INSERT INTO simple_journey_paid_qa_v1(user_id,brand,revision,qa_json,created_at) VALUES(?,?,?,?,?)').run(user.id,brand,expected_revision+1,serialized,stamp());return paidQaRead({context,brand,...(action==='resolve'?{mutationId:args.originalMutationId}:{})});
  });
 }
 const entryQa=require('./journey-entry-qa.cjs').create({db,authorize:entryOwner,transaction,now:stamp,paidRounds:userId=>['aristo','fish'].flatMap(b=>paidHead(userId,b).qa.rounds)});
 // Existing v1 is an immutable baseline; new saves append a whole revision.
 // A later rollback writer changing that baseline is detected, never merged.
 function labHead(userId,brand){
  const baseline=db.prepare('SELECT * FROM simple_journey_lab_v1 WHERE user_id=? AND brand=?').get(userId,brand),baselineHash=crypto.createHash('sha256').update(JSON.stringify(baseline||null)).digest('hex');
  const revision=db.prepare('SELECT * FROM simple_journey_lab_revision_v1 WHERE user_id=? AND brand=? ORDER BY revision DESC LIMIT 1').get(userId,brand);
  if(revision&&(revision.baseline_sha256!==baselineHash||baseline&&baseline.revision>=revision.revision))fail('LAB_BASELINE_CHANGED',409);
  return {row:revision||baseline,baselineHash};
 }
 // Model references accompany a saved revision without changing the historical
 // draft/run format. Previous releases can still read every saved draft.
 function labModelRefs(context,brand,store,refs,checkPieces=false){
  if(!Array.isArray(refs)||refs.length>100)fail('LAB_MODELS_INVALID');const seen=new Set();
  const result=refs.map(ref=>{
   if(!ref||Object.getPrototypeOf(ref)!==Object.prototype||Object.keys(ref).sort().join(',')!=='draftId,pieceId,stepId,version'||typeof ref.draftId!=='string'||typeof ref.stepId!=='string'||!/^d_piece_[a-f0-9]{32}$/.test(ref.pieceId||'')||ref.version!==1)fail('LAB_MODELS_INVALID');
   const draft=store.drafts.find(d=>d.id===ref.draftId),key=JSON.stringify([ref.draftId,ref.stepId]);if(!draft?.steps.some(s=>s.id===ref.stepId)||seen.has(key))fail('LAB_MODELS_INVALID');seen.add(key);
   if(checkPieces)modelPieces.internalTestSnapshot(context,brand,ref.pieceId,ref.version);
   return {draftId:ref.draftId,stepId:ref.stepId,pieceId:ref.pieceId,version:ref.version};
  });return result.sort((a,b)=>a.draftId<b.draftId?-1:a.draftId>b.draftId?1:a.stepId<b.stepId?-1:a.stepId>b.stepId?1:0);
 }
 function labWindows(store,windows){
  if(!Array.isArray(windows)||windows.length>20)fail('LAB_WINDOWS_INVALID');const seen=new Set();
  return windows.map(row=>{if(!row||Object.getPrototypeOf(row)!==Object.prototype||Object.keys(row).sort().join(',')!=='draftId,window'||typeof row.draftId!=='string'||!store.drafts.some(d=>d.id===row.draftId)||seen.has(row.draftId))fail('LAB_WINDOWS_INVALID');seen.add(row.draftId);return {draftId:row.draftId,window:require('./journey-send-window.cjs').normalize(row.window)};}).sort((a,b)=>a.draftId<b.draftId?-1:a.draftId>b.draftId?1:0);
 }
 function labRead({context,brand}){
  const user=labOwner(context,brand),row=labHead(user.id,brand).row;
  const engine=require('./public/crm-preview/journey-engine.js'),store=engine.readStore(row?.payload_json??null);
  if(store.drafts.some(d=>d.brand!==brand)||store.runs.some(r=>r.draft.brand!==brand))fail('LAB_STORAGE_INVALID',503);
  const savedRefs=row&&db.prepare('SELECT refs_json FROM simple_journey_lab_models_v1 WHERE user_id=? AND brand=? AND revision=?').get(user.id,brand,row.revision);
  const modelRefs=labModelRefs(context,brand,store,savedRefs?JSON.parse(savedRefs.refs_json):[]);
  const savedWindows=row&&db.prepare('SELECT windows_json FROM simple_journey_lab_send_windows_v1 WHERE user_id=? AND brand=? AND revision=?').get(user.id,brand,row.revision),sendWindows=labWindows(store,savedWindows?JSON.parse(savedWindows.windows_json):[]);
  return {persistence:'server',userId:user.id,brand,revision:row?.revision||0,store,modelRefs,sendWindows,savedAt:row?new Date(row.updated_at).toISOString():null,executes:false};
 }
 function labSave({context,brand,expected_revision,store,modelRefs=[],sendWindows=[]}){
  const user=labOwner(context,brand,true);
  if(!Number.isSafeInteger(expected_revision)||expected_revision<0||expected_revision>=2147483647)fail('LAB_REVISION_INVALID');
  const serialized=JSON.stringify(store),checked=require('./public/crm-preview/journey-engine.js').readStore(serialized);
  if(checked.drafts.some(d=>d.brand!==brand)||checked.runs.some(r=>r.draft.brand!==brand))fail('LAB_BRAND_INVALID');
  return transaction(()=>{
   if(labOwner(context,brand,true).id!==user.id)fail('LAB_ACCESS_CHANGED',403);
   const head=labHead(user.id,brand),row=head.row;
   if((row?.revision||0)!==expected_revision)fail('LAB_VERSION_CHANGED',409);
   const refs=labModelRefs(context,brand,checked,modelRefs,true),windows=labWindows(checked,sendWindows);
   const t=stamp();db.prepare('INSERT INTO simple_journey_lab_revision_v1(user_id,brand,revision,payload_json,baseline_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(user.id,brand,expected_revision+1,serialized,head.baselineHash,t,t);
   db.prepare('INSERT INTO simple_journey_lab_models_v1(user_id,brand,revision,refs_json) VALUES(?,?,?,?)').run(user.id,brand,expected_revision+1,JSON.stringify(refs));
   db.prepare('INSERT INTO simple_journey_lab_send_windows_v1(user_id,brand,revision,windows_json) VALUES(?,?,?,?)').run(user.id,brand,expected_revision+1,JSON.stringify(windows));
   return labRead({context,brand});
  });
 }
 const modelPieces=require('./simple-crm-model-pieces.cjs').create({db,authorize:authorizeUser,now});
 const internalBinding=journeyTestTransport||require('./journey-internal-test-binding.cjs').createBindingReader();
 const internalSend=journeyTestTransport?.send||require('./journey-internal-test-transport.cjs').createTransport({privateApi:internalBinding.privateApi,recordDiagnostic:testDiagnostics?.record});
 const htmlBinding=journeyTestTransport?.html||(typeof internalBinding.privateApi==='function'?require('./journey-internal-html-binding.cjs').createHtmlBindingReader({baseBinding:internalBinding}):null);
 const htmlSend=journeyTestTransport?.html?.send||(htmlBinding?require('./journey-internal-test-transport.cjs').createHtmlTransport({privateApi:htmlBinding.privateApi,recordDiagnostic:testDiagnostics?.record}):undefined);
 const journeyTest=require('./journey-internal-test-runtime.cjs').createRunner({db,now,engine:require('./public/crm-preview/journey-engine.js'),
  authorize:(context,brand)=>labOwner(context,brand,true),
  authorizeRead:(context,brand)=>labOwner(context,brand),
  currentIdentity:currentUser,
  getDraft:(context,brand,draftId)=>{const draft=labRead({context,brand}).store.drafts.find(d=>d.id===draftId);if(!draft)fail('TEST_DRAFT_NOT_FOUND',404);return draft;},
  getSendWindow:(context,brand,draftId,version)=>{const saved=labRead({context,brand}),draft=saved.store.drafts.find(d=>d.id===draftId);if(!draft||draft.revision!==version)fail('TEST_DRAFT_CHANGED',409);return saved.sendWindows.find(w=>w.draftId===draftId)?.window||null;},
  getBinding:internalBinding.getBinding,send:internalSend,getModelPiece:modelPieces.internalTestSnapshot,...(htmlBinding?{getHtmlBinding:htmlBinding.getBinding,sendHtml:htmlSend}:{})});
 const journeyActivationReview=require('./journey-activation-review.cjs').create({db,authorize:authorizeUser,now,getSnapshot(context,brand,draftId,version){
  const saved=labRead({context,brand}),draft=saved.store.drafts.find(d=>d.id===draftId);if(!draft||draft.revision!==version)fail('JOURNEY_REVIEW_DRAFT_CHANGED',409);
  const sendWindow=require('./journey-send-window.cjs').normalize(saved.sendWindows.find(w=>w.draftId===draftId)?.window||require('./journey-send-window.cjs').DEFAULT);
  const models=saved.modelRefs.filter(r=>r.draftId===draftId).map(ref=>{const piece=modelPieces.internalTestSnapshot(context,brand,ref.pieceId,ref.version);return {stepId:ref.stepId,pieceId:piece.id,version:piece.version,htmlSha256:crypto.createHash('sha256').update(piece.html).digest('hex'),htmlBytes:Buffer.byteLength(piece.html)};});
  return {labRevision:saved.revision,draft,sendWindow,models};
 }});
 const abRegistry=createAbRegistry({db,authorize:authorizeUser,now});

 return Object.freeze({create,resetPassword,changePassword,update,list,profile:id=>profile(find(id)),affiliateEdit,pendingAffiliateEdits,reserveAffiliateEdit,finishAffiliateEdit,labRead,labSave,paidQaRead,paidQaMutate,entryQa,journeyTest,journeyActivationReview,abRegistry,modelPieces});
}
module.exports={createSimpleAccounts,createAbRegistry,profile,FRONTS,BRANDS};
