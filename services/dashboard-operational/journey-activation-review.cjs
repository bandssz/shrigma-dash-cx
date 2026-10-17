'use strict';
// Append-only review inbox. It cannot approve, enroll, schedule or send.
const crypto=require('node:crypto');
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const BLOCKERS=Object.freeze(['Entrada automática por público, compra ou data','Saída por compra paga recente','Limite diário somando campanhas e jornadas','Exclusão dos participantes das sete jornadas existentes','Público final e recebimento HTML conferidos pelo responsável','Aprovação específica de Felipe']);
function create({db,authorize,getSnapshot,now=Date.now}={}){
 if(!db||typeof authorize!=='function'||typeof getSnapshot!=='function'||typeof now!=='function')fail('JOURNEY_REVIEW_CONFIG',500);
 db.exec('CREATE TABLE IF NOT EXISTS simple_journey_activation_review_v1(request_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),owner_id TEXT NOT NULL REFERENCES users(id),brand TEXT NOT NULL CHECK(brand IN (\'fish\',\'aristo\')),draft_id TEXT NOT NULL,draft_version INTEGER NOT NULL,payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(user_id,brand,draft_id,draft_version))');
 function caller(context,brand,write=false){
  if(!['fish','aristo'].includes(brand)||context?.nativeBearer!==undefined||write&&context?.method!=='POST')fail('JOURNEY_REVIEW_COOKIE_REQUIRED',403);
  const user=authorize({...context,area:'growth',productFront:'growth',brand,edit:false});
  if(write&&(user.permissions?.growth?.edit!==true||user.role!=='superadmin'&&!user.productWriteFronts?.includes('growth')))fail('PRODUCT_WRITE_DENIED',403);return user;
 }
 function owner(){const rows=db.prepare("SELECT id FROM users WHERE role='superadmin' AND state='active'").all();if(rows.length!==1)fail('JOURNEY_REVIEW_OWNER_UNAVAILABLE',503);return rows[0].id;}
 function view(row){
  if(hash(row.payload_json)!==row.payload_sha256)fail('JOURNEY_REVIEW_INTEGRITY',503);let proposal;try{proposal=JSON.parse(row.payload_json);}catch{fail('JOURNEY_REVIEW_INTEGRITY',503);}
  return {requestId:row.request_id,requestedByUserId:row.user_id,brand:row.brand,draftId:row.draft_id,version:row.draft_version,createdAt:new Date(row.created_at).toISOString(),state:'review_requested',destination:'project-owner-inbox',proposal,commercialActivation:false,enrolls:false,schedules:false,sends:false};
 }
 function read({context,brand,requestId,draftId,version}){
  const user=caller(context,brand);if(requestId!==undefined&&(!uuid(requestId)||draftId!==undefined||version!==undefined)||draftId!==undefined&&(typeof draftId!=='string'||draftId.length<1||draftId.length>100||!Number.isSafeInteger(version)||version<1)||draftId===undefined&&version!==undefined)fail('JOURNEY_REVIEW_INPUT');
  if(requestId!==undefined){const row=db.prepare('SELECT * FROM simple_journey_activation_review_v1 WHERE request_id=? AND user_id=? AND brand=?').get(requestId,user.id,brand);if(!row)fail('JOURNEY_REVIEW_NOT_FOUND',404);return {schema:'journey-activation-review-v1',record:view(row),sends:false};}
  if(draftId!==undefined){const row=db.prepare('SELECT * FROM simple_journey_activation_review_v1 WHERE user_id=? AND brand=? AND draft_id=? AND draft_version=?').get(user.id,brand,draftId,version);if(!row)fail('JOURNEY_REVIEW_NOT_FOUND',404);return {schema:'journey-activation-review-v1',record:view(row),sends:false};}
  const rows=db.prepare('SELECT * FROM simple_journey_activation_review_v1 WHERE user_id=? AND brand=? ORDER BY created_at DESC,request_id DESC LIMIT 101').all(user.id,brand);
  return {schema:'journey-activation-review-v1',brand,records:rows.slice(0,100).map(view),more:rows.length>100,sends:false};
 }
 function inbox({context,brands=['fish','aristo'],nativeRead=false}){
  if(!Array.isArray(brands)||brands.some(b=>!['fish','aristo'].includes(b))||new Set(brands).size!==brands.length)fail('JOURNEY_REVIEW_INPUT');
  if(context?.nativeBearer!==undefined&&nativeRead!==true)fail('JOURNEY_REVIEW_COOKIE_REQUIRED',403);
  const user=authorize({...context,admin:true});if(user.role!=='superadmin'||user.id!==owner())fail('ADMIN_REQUIRED',403);
  const rows=brands.length?db.prepare('SELECT * FROM simple_journey_activation_review_v1 WHERE owner_id=? AND brand IN ('+brands.map(()=>'?').join(',')+') ORDER BY created_at DESC,request_id DESC LIMIT 101').all(user.id,...brands):[];
  return {schema:'journey-activation-review-v1',scope:'owner',records:rows.slice(0,100).map(view),more:rows.length>100,commercialActivation:false,sends:false};
 }
 function append({context,brand,draftId,version,requestId,expectedUserId}){
  const user=caller(context,brand,true);if(expectedUserId!==user.id)fail('JOURNEY_REVIEW_ACCESS_CHANGED',403);if(!uuid(requestId)||typeof draftId!=='string'||draftId.length<1||draftId.length>100||!Number.isSafeInteger(version)||version<1)fail('JOURNEY_REVIEW_INPUT');
  if(db.isTransaction)fail('JOURNEY_REVIEW_TRANSACTION',409);db.exec('BEGIN IMMEDIATE');
  try{
   if(caller(context,brand,true).id!==user.id)fail('JOURNEY_REVIEW_ACCESS_CHANGED',403);const target=owner(),old=db.prepare('SELECT * FROM simple_journey_activation_review_v1 WHERE request_id=?').get(requestId);
   if(old){if(old.user_id!==user.id||old.brand!==brand||old.draft_id!==draftId||old.draft_version!==version||old.owner_id!==target)fail('JOURNEY_REVIEW_CONFLICT',409);const result={schema:'journey-activation-review-v1',record:view(old),duplicate:true,sends:false};db.exec('COMMIT');return result;}
   const prior=db.prepare('SELECT * FROM simple_journey_activation_review_v1 WHERE user_id=? AND brand=? AND draft_id=? AND draft_version=?').get(user.id,brand,draftId,version);
   if(prior){if(prior.owner_id!==target)fail('JOURNEY_REVIEW_CONFLICT',409);const result={schema:'journey-activation-review-v1',record:view(prior),duplicate:true,sends:false};db.exec('COMMIT');return result;}
   const snapshot=getSnapshot(context,brand,draftId,version);if(!snapshot||snapshot.draft?.id!==draftId||snapshot.draft.brand!==brand||snapshot.draft.revision!==version||snapshot.draft.mode!=='test'||snapshot.draft.productionEnabled!==false)fail('JOURNEY_REVIEW_DRAFT_CHANGED',409);
   const proposal={name:snapshot.draft.name,trigger:snapshot.draft.trigger,audience:snapshot.draft.audienceRef||null,stages:snapshot.draft.steps.map(s=>({id:s.id,enabled:s.enabled,waitMinutes:s.waitMinutes,subject:s.subject,templateName:s.templateName})),exitOnPurchase:snapshot.draft.exitOnPurchase,sendWindow:snapshot.sendWindow||null,models:snapshot.models||[],labRevision:snapshot.labRevision,pendingRequirements:[...BLOCKERS],approvalMeans:'Review only. Commercial activation is unavailable.'};
   const encoded=JSON.stringify(proposal);if(Buffer.byteLength(encoded)>65536)fail('JOURNEY_REVIEW_TOO_LARGE');const t=now();if(!Number.isSafeInteger(t)||t<0)fail('CLOCK_INVALID',500);
   db.prepare('INSERT INTO simple_journey_activation_review_v1(request_id,user_id,owner_id,brand,draft_id,draft_version,payload_json,payload_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(requestId,user.id,target,brand,draftId,version,encoded,hash(encoded),t);
   const result=read({context,brand,requestId});db.exec('COMMIT');return result;
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}
 }
 return Object.freeze({read,inbox,append});
}
module.exports={create};
