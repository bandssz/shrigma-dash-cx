'use strict';
const crypto=require('node:crypto');
const {isProxy}=require('node:util').types;
const PURPOSE='crm.scheduler-state-read',MAX_TTL_MS=600000;
// Exact public v5 metadata contract; prior v1/v2/v3/v4 intents retain their MAC.
// Repinning its fixed SQL requires a new approval module revision, not input.
const queryHash='5c280140c96257547f18caaa8b68dec909820363fb4bf21927ea7b773c64f235';
const V5_QUERY_HASH='43083db73f02f8195253b5c7455e27e92148582db01920c1d0c4c8b7fb5c28b7';
const V4_QUERY_HASH='e4f8d47990f356eabb87e0e2b0c5ae9efc8f3ebe7a7b30cf5322e864246b957e';
const V3_QUERY_HASH='86d6538f931260323d1a8504a315c82e234b8a0f6b77552652775b2599401fa4';
const V2_QUERY_HASH='78f2a08ad6c8514f396967a786c87c5f76c0427dd57efe4a657ae4d7beb36833';
const PREVIOUS_QUERY_HASH='49931ee6f49587b423832cd94d71de5f99e77ee556b51da2db399eeee93980e4';
const resourceHash='85c6d8aa54c0780dfa9f6463df77f9799cdd4c2af0c395ebccd7dd235750df35';
const AUTHORITY_FIELDS=Object.freeze(['ownerId','ownerRevision','connectionHash','crmBindingHash','profileRevision','credentialBindingHash','resourceHash','queryHash']);
const CURRENT_NEEDS=Object.freeze({purpose:PURPOSE,scopes:Object.freeze(['crm.read','crm.iam']),brands:Object.freeze(['fish','aristo'])});
const H=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const own=new WeakSet();function fail(code,status=403){const e=Object.assign(Error(code),{code,status});own.add(e);throw e;}
function exact(v,keys){
 if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length)fail('SCHEDULER_CHAT_ARGUMENTS_REFUSED',400);
 for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('SCHEDULER_CHAT_ARGUMENTS_REFUSED',400);}return v;
}
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&H.test(a)&&H.test(b)&&crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
function requireMethod(context,expected){if(!context||isProxy(context)||Object.getPrototypeOf(context)!==Object.prototype)fail('SCHEDULER_CHAT_NATIVE_CURRENT_REQUIRED');const d=Object.getOwnPropertyDescriptor(context,'method');if(!d||!Object.hasOwn(d,'value')||d.value!==expected)fail('SCHEDULER_CHAT_METHOD_REFUSED',405);}
function createSchedulerStateChatApproval({db,current,mac,authorizeBoundApproval,now=Date.now,ttlMs=MAX_TTL_MS,callbackTimeoutMs=12000}={}){
 if(!db?.prepare||!db?.exec||[current,mac,authorizeBoundApproval,now].some(f=>typeof f!=='function')||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>MAX_TTL_MS||!Number.isSafeInteger(callbackTimeoutMs)||callbackTimeoutMs<1||callbackTimeoutMs>12000)fail('SCHEDULER_CHAT_CONFIGURATION_REFUSED',500);
 // Same original identity SQLite handle. No alteration/promotion of native
 // scopes, browser state consents, diagnostic grants or PostgreSQL objects.
 db.exec(`CREATE TABLE IF NOT EXISTS crm_scheduler_state_chat_intent_v1(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),
 connection_id TEXT NOT NULL REFERENCES crm_native_connections_v1(id),
 purpose TEXT NOT NULL CHECK(purpose='crm.scheduler-state-read'),authority_json TEXT NOT NULL,
 intent_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN('prepared','consumed','approved','denied','expired','uncertain')),
 consumed_at INTEGER,record_mac TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS crm_scheduler_state_chat_connection_v1 ON crm_scheduler_state_chat_intent_v1(owner_id,connection_id,created_at,id);`);
 const ambiguous=new Set();
 const time=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0||t>8640000000000000-MAX_TTL_MS)fail('SCHEDULER_CHAT_CLOCK_REFUSED',503);return t;};
 function digest(x){let v;try{v=mac(canonical(x));}catch{fail('SCHEDULER_CHAT_INTEGRITY_REFUSED',409);}if(typeof v!=='string'||!H.test(v))fail('SCHEDULER_CHAT_INTEGRITY_REFUSED',409);return v;}
 const seal=r=>digest(['scheduler-state-chat-record-v1',r.id,r.owner_id,r.connection_id,r.purpose,r.authority_json,r.intent_hash,r.created_at,r.expires_at,r.state,r.consumed_at]);
 const intentHash=r=>hash(canonical({schema:'shrigma-scheduler-state-chat-intent-v1',approvalId:r.id,connectionId:r.connection_id,purpose:PURPOSE,authority:JSON.parse(r.authority_json),createdAt:r.created_at,expiresAt:r.expires_at}));
 function authority(context,connectionId){
  if(!UUID.test(connectionId||'')||!context||isProxy(context)||Object.getPrototypeOf(context)!==Object.prototype)fail('SCHEDULER_CHAT_NATIVE_CURRENT_REQUIRED');
  const bearer=Object.getOwnPropertyDescriptor(context,'nativeBearer'),method=Object.getOwnPropertyDescriptor(context,'method');
  if(!bearer||!Object.hasOwn(bearer,'value')||typeof bearer.value!=='string'||!(/^[A-Za-z0-9_-]{43}$/).test(bearer.value)||!method||!Object.hasOwn(method,'value')||!['GET','POST'].includes(method.value))fail('SCHEDULER_CHAT_NATIVE_CURRENT_REQUIRED');
  let a;try{a=exact(current(context,connectionId,CURRENT_NEEDS),AUTHORITY_FIELDS);}catch(e){if(own.has(e))throw e;fail('SCHEDULER_CHAT_CURRENT_REFUSED');}
  if(typeof a.ownerId!=='string'||!a.ownerId||a.ownerId.length>256||/[\x00-\x1f\x7f]/.test(a.ownerId)||AUTHORITY_FIELDS.slice(1).some(k=>typeof a[k]!=='string'||!H.test(a[k]))||a.resourceHash!==resourceHash||a.queryHash!==queryHash)fail('SCHEDULER_CHAT_CURRENT_REFUSED');
  return Object.freeze(Object.fromEntries(AUTHORITY_FIELDS.map(k=>[k,a[k]])));
 }
 function sameAuthority(a,b){return canonical(a)===canonical(b);}
 // Authenticate the closed historical v1/v2 queries as history only. CURRENT
 // still accepts only the new query; bound/status/confirm cannot promote it.
 function validated(r){
  if(!r||!UUID.test(r.id||'')||r.purpose!==PURPOSE||!Number.isSafeInteger(r.created_at)||!Number.isSafeInteger(r.expires_at)||r.created_at<0||r.expires_at<=r.created_at||r.expires_at-r.created_at>MAX_TTL_MS||!['prepared','consumed','approved','denied','expired','uncertain'].includes(r.state)||r.state==='prepared'&&r.consumed_at!==null||r.state!=='prepared'&&(!Number.isSafeInteger(r.consumed_at)||r.consumed_at<r.created_at)||!equal(r.record_mac,seal(r)))fail('SCHEDULER_CHAT_INTEGRITY_REFUSED',409);
  let a;try{a=exact(JSON.parse(r.authority_json),AUTHORITY_FIELDS);}catch{fail('SCHEDULER_CHAT_INTEGRITY_REFUSED',409);}if(a.ownerId!==r.owner_id||AUTHORITY_FIELDS.slice(1).some(k=>typeof a[k]!=='string'||!H.test(a[k]))||a.resourceHash!==resourceHash||![queryHash,PREVIOUS_QUERY_HASH,V2_QUERY_HASH,V3_QUERY_HASH,V4_QUERY_HASH,V5_QUERY_HASH].includes(a.queryHash)||!equal(r.intent_hash,intentHash(r)))fail('SCHEDULER_CHAT_INTEGRITY_REFUSED',409);return r;
 }
 function get(id){let r;try{r=db.prepare('SELECT * FROM crm_scheduler_state_chat_intent_v1 WHERE id=?').get(id);}catch{fail('SCHEDULER_CHAT_STORE_REFUSED',503);}if(!r)fail('SCHEDULER_CHAT_INTENT_NOT_FOUND',404);return validated(r);}
 function bound(context,connectionId,id){const a=authority(context,connectionId),r=get(id);if(r.connection_id!==connectionId||r.owner_id!==a.ownerId||!sameAuthority(a,JSON.parse(r.authority_json)))fail('SCHEDULER_CHAT_BINDING_CHANGED',409);const fresh=authority(context,connectionId);if(!sameAuthority(a,fresh))fail('SCHEDULER_CHAT_BINDING_CHANGED',409);return {a:fresh,r};}
 function view(r,t){if(t<r.created_at)fail('SCHEDULER_CHAT_CLOCK_REFUSED',503);const state=ambiguous.has(r.id)||r.state==='consumed'?'uncertain':r.state==='prepared'&&t>=r.expires_at?'expired':r.state;return Object.freeze({schema:'shrigma-scheduler-state-chat-intent-v1',approvalId:r.id,intentHash:r.intent_hash,purpose:PURPOSE,createdAt:new Date(r.created_at).toISOString(),expiresAt:new Date(r.expires_at).toISOString(),state,consumed:r.state!=='prepared'||ambiguous.has(r.id),authorized:state==='approved',automaticRetry:false,authorizesSend:false,authorizesRecovery:false,operational:false});}
 function prepare(args={}){
  exact(args,['context','connectionId']);const {context,connectionId}=args;requireMethod(context,'POST');const a=authority(context,connectionId),t=time();let rows;
  try{rows=db.prepare('SELECT * FROM crm_scheduler_state_chat_intent_v1 WHERE owner_id=? AND connection_id=? ORDER BY created_at DESC,id DESC').all(a.ownerId,connectionId);}catch{fail('SCHEDULER_CHAT_STORE_REFUSED',503);}
  for(const raw of rows){const r=validated(raw);if(!sameAuthority(a,JSON.parse(r.authority_json)))continue;if(ambiguous.has(r.id)||['consumed','uncertain'].includes(r.state))fail('SCHEDULER_CHAT_CONFIRMATION_UNCERTAIN',409);if(r.state==='approved'||r.state==='prepared'&&t<r.expires_at){if(!sameAuthority(a,authority(context,connectionId)))fail('SCHEDULER_CHAT_BINDING_CHANGED',409);return view(r,t);}}
  const r={id:crypto.randomUUID(),owner_id:a.ownerId,connection_id:connectionId,purpose:PURPOSE,authority_json:canonical(a),created_at:t,expires_at:t+ttlMs,state:'prepared',consumed_at:null};r.intent_hash=intentHash(r);r.record_mac=seal(r);
  let committed=false;try{db.exec('BEGIN IMMEDIATE');if(!sameAuthority(a,authority(context,connectionId)))fail('SCHEDULER_CHAT_BINDING_CHANGED',409);db.prepare('INSERT INTO crm_scheduler_state_chat_intent_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(r.id,r.owner_id,r.connection_id,r.purpose,r.authority_json,r.intent_hash,r.created_at,r.expires_at,r.state,null,r.record_mac);if(!sameAuthority(a,authority(context,connectionId)))fail('SCHEDULER_CHAT_BINDING_CHANGED',409);db.exec('COMMIT');committed=true;}catch(e){if(!committed)try{db.exec('ROLLBACK');}catch{}if(own.has(e))throw e;fail('SCHEDULER_CHAT_STORE_REFUSED',503);}
  bound(context,connectionId,r.id);return view(r,t);
 }
 function status(args={}){exact(args,['context','connectionId','approvalId']);requireMethod(args.context,'GET');if(!UUID.test(args.approvalId||''))fail('SCHEDULER_CHAT_ARGUMENTS_REFUSED',400);const {r}=bound(args.context,args.connectionId,args.approvalId);return view(r,time());}
 function persist(prior,next){next.record_mac=seal(next);if(db.prepare('UPDATE crm_scheduler_state_chat_intent_v1 SET state=?,consumed_at=?,record_mac=? WHERE id=? AND record_mac=?').run(next.state,next.consumed_at,next.record_mac,prior.id,prior.record_mac).changes!==1)fail('SCHEDULER_CHAT_INTENT_CHANGED',409);return next;}
 async function confirm(args={}){
  exact(args,['context','connectionId','approvalId','intentHash','decision']);const {context,connectionId,approvalId,decision}=args;requireMethod(context,'POST');
  if(!UUID.test(approvalId||'')||typeof args.intentHash!=='string'||!H.test(args.intentHash)||!['approve','deny'].includes(decision))fail('SCHEDULER_CHAT_ARGUMENTS_REFUSED',400);
  const start=bound(context,connectionId,approvalId);if(!equal(args.intentHash,start.r.intent_hash))fail('SCHEDULER_CHAT_INTENT_HASH_REFUSED',409);
  if(start.r.state!=='prepared'||ambiguous.has(approvalId))return view(start.r,time());
  const t=time();if(t<start.r.created_at)fail('SCHEDULER_CHAT_CLOCK_REFUSED',503);let consumed,committed=false;
  // This transaction must end before invoking the consent store callback,
  // which owns a separate identity transaction. Never nest BEGIN IMMEDIATE.
  try{db.exec('BEGIN IMMEDIATE');const fresh=bound(context,connectionId,approvalId),consumedAt=time();if(fresh.r.state!=='prepared'||!equal(fresh.r.record_mac,start.r.record_mac))fail('SCHEDULER_CHAT_INTENT_CHANGED',409);if(consumedAt<fresh.r.created_at)fail('SCHEDULER_CHAT_CLOCK_REFUSED',503);consumed=persist(fresh.r,{...fresh.r,state:consumedAt>=fresh.r.expires_at?'expired':decision==='deny'?'denied':'consumed',consumed_at:consumedAt});db.exec('COMMIT');committed=true;}catch(e){ambiguous.add(approvalId);if(!committed)try{db.exec('ROLLBACK');}catch{}if(own.has(e))throw e;fail('SCHEDULER_CHAT_STORE_REFUSED',503);}
  if(consumed.state!=='consumed'){bound(context,connectionId,approvalId);return view(consumed,t);}
  let accepted=false;
  try{
   const before=bound(context,connectionId,approvalId);if(before.r.state!=='consumed'||!sameAuthority(before.a,start.a))fail('SCHEDULER_CHAT_BINDING_CHANGED',409);const remaining=before.r.expires_at-time();if(remaining<=0)fail('SCHEDULER_CHAT_INTENT_EXPIRED',409);
   let timer,answer;
   try{answer=exact(await Promise.race([Promise.resolve().then(()=>{const final=bound(context,connectionId,approvalId);if(final.r.state!=='consumed'||!sameAuthority(final.a,start.a)||time()>=final.r.expires_at)fail('SCHEDULER_CHAT_BINDING_CHANGED',409);return authorizeBoundApproval({context,connectionId,authority:final.a,approvalId});}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SCHEDULER_CHAT_CALLBACK_UNCERTAIN')),Math.min(callbackTimeoutMs,remaining));})]),['authorized','purpose','connectionId','operational']);}finally{clearTimeout(timer);}
   if(answer.authorized!==true||answer.purpose!==PURPOSE||answer.connectionId!==connectionId||answer.operational!==false)fail('SCHEDULER_CHAT_CALLBACK_REFUSED',503);
   const after=bound(context,connectionId,approvalId);if(!sameAuthority(after.a,start.a)||after.r.state!=='consumed'||time()>=after.r.expires_at)fail('SCHEDULER_CHAT_BINDING_CHANGED',409);accepted=true;
  }catch{accepted=false;}
  // Any failure, late revocation or crash after consumption leaves this exact
  // intent consumed. Callback errors/contents never reach records or DTOs.
  try{consumed=persist(consumed,{...consumed,state:accepted?'approved':'uncertain'});}catch{ambiguous.add(approvalId);fail('SCHEDULER_CHAT_STORE_REFUSED',503);}
  bound(context,connectionId,approvalId);return view(consumed,time());
 }
 return Object.freeze({prepare,confirm,status});
}
module.exports=Object.freeze({createSchedulerStateChatApproval,PURPOSE,MAX_TTL_MS,queryHash,PREVIOUS_QUERY_HASH,V2_QUERY_HASH,V3_QUERY_HASH,V4_QUERY_HASH,V5_QUERY_HASH,resourceHash,AUTHORITY_FIELDS,CURRENT_NEEDS});
