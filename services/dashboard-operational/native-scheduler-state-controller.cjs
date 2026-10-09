'use strict';
const crypto=require('node:crypto');
const {isProxy}=require('node:util').types;
const {createSchedulerStateRead,PURPOSE,queryHash,resourceHash,credentialBinding,canonical}=require('./native-scheduler-state.cjs');
const H=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEYS=['ownerId','ownerRevision','connectionHash','crmBindingHash','profileRevision','credentialBindingHash','resourceHash','queryHash'];
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};
function exact(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)||{},'value')||!Object.getOwnPropertyDescriptor(v,k).enumerable))fail('SCHEDULER_STATE_ARGUMENTS_REFUSED',400);return v;}
const CODES=new Set(['SCHEDULER_STATE_OFF','SCHEDULER_STATE_UNAVAILABLE','SCHEDULER_STATE_BUSY','SCHEDULER_STATE_PROTOCOL_REFUSED','SCHEDULER_STATE_OWNER_REFUSED','SCHEDULER_STATE_CREDENTIAL_REFUSED','SCHEDULER_STATE_ADMISSION_REFUSED','SCHEDULER_STATE_TIMEOUT','SCHEDULER_STATE_SESSION_REFUSED','SCHEDULER_STATE_QUERY_FAILED','SCHEDULER_STATE_ACK_UNKNOWN','SCHEDULER_STATE_DRIVER_REFUSED','SCHEDULER_STATE_PEER_REFUSED','SCHEDULER_STATE_DEPENDENCY_MISSING','SCHEDULER_STATE_SCHEMA_REFUSED','SCHEDULER_STATE_ACL_REFUSED','SCHEDULER_STATE_CLOCK_REFUSED','SCHEDULER_STATE_CLOSE_UNCONFIRMED','SCHEDULER_STATE_CLOSE_FAILED','SCHEDULER_STATE_REFUSED','SCHEDULER_STATE_BINDING_CHANGED']);
function createSchedulerStateController({enabled=false,driver,auth,now=Date.now}={}){
 const consent=auth?.nativeSchedulerStateConsent,vault=auth?.nativeDatabaseVault,store=auth?.nativeConnections;
 const ready=enabled===true&&typeof driver?.Client==='function'&&driver.version==='8.23.1'&&H.test(driver.packageSha256||'')&&['status','authorize','require','invalidate'].every(k=>typeof consent?.[k]==='function')&&typeof vault?.getPrivateCredential==='function'&&typeof store?.authenticate==='function'&&typeof now==='function';
 let active=null,closing=false;const receipts=new Map(),TTL=10*60*1000,LIMIT=64;
 const clock=()=>{const t=now();if(!Number.isSafeInteger(t)||t<0||t>8640000000000000)fail('SCHEDULER_STATE_CLOCK_REFUSED',503);return t;};
 function requireReady(){if(!ready||closing)fail('SCHEDULER_STATE_NOT_ADMITTED',503);}
 function native(context){requireReady();if(context?.nativeBearer===undefined||context.method!=='GET')fail('SCHEDULER_STATE_NATIVE_REQUIRED');let c;try{c=store.authenticate(context.nativeBearer,{scope:'crm.read'});}catch{fail('SCHEDULER_STATE_CONNECTION_REFUSED');}if(!UUID.test(c?.id||''))fail('SCHEDULER_STATE_CONNECTION_REFUSED');return c.id;}
 function current(context,id,expected){
  requireReady();if(native(context)!==id)fail('SCHEDULER_STATE_BINDING_CHANGED',409);const b=exact(consent.require({context,connectionId:id}),KEYS);
  if(typeof b.ownerId!=='string'||!b.ownerId||b.ownerId.length>256||/[\x00-\x1f\x7f]/.test(b.ownerId)||KEYS.slice(1).some(k=>typeof b[k]!=='string'||!H.test(b[k]))||b.queryHash!==queryHash||b.resourceHash!==resourceHash||expected&&canonical(b)!==canonical(expected))fail('SCHEDULER_STATE_BINDING_CHANGED',409);
  return Object.freeze({...b});
 }
 function privateCredential(call){current(call.context,call.id,call.binding);const p=vault.getPrivateCredential({ownerId:call.binding.ownerId});if(!p||p.ownerId!==call.binding.ownerId||credentialBinding(p)!==call.binding.credentialBindingHash)fail('SCHEDULER_STATE_BINDING_CHANGED',409);return p;}
 const core=ready?createSchedulerStateRead({enabled:true,driver,now,
  getPrivateCredential:({ownerId})=>{if(!active||ownerId!==active.binding.ownerId)fail('SCHEDULER_STATE_BINDING_CHANGED',409);return privateCredential(active);},
  admitState:proof=>{if(!active||!['connect','peer','begin','catalog','read','rollback','end','release'].includes(proof?.phase)||proof.purpose!==PURPOSE)fail('SCHEDULER_STATE_BINDING_CHANGED',409);const b=current(active.context,active.id,active.binding),p=privateCredential(active);if(proof.ownerId!==b.ownerId||proof.credentialRevision!==p.revision||proof.credentialBindingHash!==b.credentialBindingHash||proof.resourceHash!==b.resourceHash||proof.queryHash!==b.queryHash)fail('SCHEDULER_STATE_BINDING_CHANGED',409);return {admitted:true,ownerId:b.ownerId,credentialRevision:p.revision,credentialBindingHash:b.credentialBindingHash,resourceHash:b.resourceHash,queryHash:b.queryHash,purpose:PURPOSE};}
 }):null;
 function status(args={}){requireReady();exact(args,['context','connectionId']);return consent.status(args);}
 function authorize(args={}){requireReady();exact(args,['context','connectionId','consent']);return consent.authorize(args);}
 async function perform(context,id,binding){if(active)fail('SCHEDULER_STATE_BUSY',409);const call={context:Object.freeze({...context}),id,binding};active=call;try{current(call.context,id,binding);const result=await core.inspect({}, {ownerId:binding.ownerId});current(call.context,id,binding);return result;}finally{if(active===call)active=null;}}
 async function nativeReadReceipt(args={}){
  requireReady();exact(args,['context']);const {context}=args,id=native(context),binding=current(context,id),bindingHash=sha(canonical(binding)),old=receipts.get(id);
  if(old){if(old.bindingHash!==bindingHash)fail('SCHEDULER_STATE_BINDING_CHANGED',409);if(old.pending)return Object.freeze({status:409,body:Object.freeze({error:'SCHEDULER_STATE_BUSY'})});if(old.result.status!==200||clock()<=old.expiresAt){current(context,id,binding);return old.result;}}
  if(active)return Object.freeze({status:409,body:Object.freeze({error:'SCHEDULER_STATE_BUSY'})});if(!old&&receipts.size>=LIMIT)fail('SCHEDULER_STATE_RECEIPT_CAPACITY',503);
  const slot={bindingHash,pending:true,result:null,expiresAt:0};receipts.set(id,slot);let result;
  try{result={status:200,body:await perform(context,id,binding)};}catch(e){result={status:503,body:{error:CODES.has(e?.code)?e.code:'SCHEDULER_STATE_REFUSED'}};}
  // Suppress both success and fault payloads when authorization changes;
  // consume the attempt so a later invocation cannot replay uncertain work.
  try{current(context,id,binding);}catch{slot.pending=false;slot.result=Object.freeze({status:409,body:Object.freeze({error:'SCHEDULER_STATE_BINDING_CHANGED'})});fail('SCHEDULER_STATE_BINDING_CHANGED',409);}
  let expiresAt=0;if(result.status===200){try{expiresAt=clock()+TTL;}catch{result={status:503,body:{error:'SCHEDULER_STATE_CLOCK_REFUSED'}};}}
  slot.pending=false;slot.result=Object.freeze({status:result.status,body:Object.freeze(result.body)});slot.expiresAt=expiresAt;return slot.result;
 }
 // All exposed native reads share the receipt fence. There is no uncached
 // inspect export that could replay a failed or uncertain attempt.
 async function inspect(args={}){const r=await nativeReadReceipt(args);if(r.status!==200)fail(r.body.error,r.status);return r.body;}
 async function close(){closing=true;if(core)await core.close();return Object.freeze({closed:true,operational:false});}
 return Object.freeze({status,authorize,inspect,nativeReadReceipt,close,enabled:ready});
}
module.exports=Object.freeze({createSchedulerStateController,PURPOSE});
