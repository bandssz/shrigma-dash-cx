'use strict';
// Private gateway composition. No browser route, API16 credential, session
// fabrication, environment read or timer is introduced by this module.
const {createTask}=require('./task.cjs'),{createStore}=require('./store.cjs');
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;
const fail=code=>{throw Object.assign(Error(code),{code});};
const SOURCE='https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35/consent-reconciliation';
function createBroker({db,encrypt,decrypt,serviceBinding,fetchImpl=fetch,sourceUrl,now=Date.now,enabledSince,enabled=false}){
 if(enabled!==true)return null;if(typeof serviceBinding!=='function'||typeof fetchImpl!=='function')throw Error('CONSENT_BROKER_CONFIG');
 const url=new URL(sourceUrl);if(url.href!==SOURCE)throw Error('CONSENT_BROKER_SOURCE');
 const store=createStore({db,encrypt,decrypt,now,enabledSince}),contexts=new Map(),registrations=new Map();
 let closing=false;
 async function call(binding,command){
  if(closing)fail('CONSENT_TASK_DISABLED');const before=await serviceBinding(command.brand);
  if(before.snapshot!==binding.snapshot||before.credential!==binding.credential)fail('CONSENT_ACCESS_CHANGED');
  const response=await fetchImpl(url.href,{method:'POST',redirect:'error',cache:'no-store',headers:{Accept:'application/json',Authorization:'Bearer '+binding.credential,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(85000)});
  if(response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||!response.body)fail('CONSENT_RESPONSE_UNCONFIRMED');
  let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)fail('CONSENT_RESPONSE_UNCONFIRMED');chunks.push(Buffer.from(chunk));}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('CONSENT_RESPONSE_UNCONFIRMED');}
  const after=await serviceBinding(command.brand);if(after.snapshot!==binding.snapshot||after.credential!==binding.credential)fail('CONSENT_ACCESS_CHANGED');
  if(response.status!==200){if(/^CONSENT_[A-Z_]{1,70}$/.test(body?.code||''))fail(body.code);fail('CONSENT_SOURCE_PENDING');}
  if(!plain(body)||body.schema!=='crm-campaign-consent-private-result-v1'||body.brand!==command.brand||body.kind!==command.kind||JSON.stringify(body).includes(binding.credential))fail('CONSENT_RESPONSE_UNCONFIRMED');
  return body.result;
 }
 const context=plan=>{const p=contexts.get(plan.brand+':'+plan.campaign_id+':'+plan.campaign_uuid);if(!p||p.freeze.list_id!==plan.frozen.id||p.freeze.list_uuid!==plan.frozen.uuid)fail('CONSENT_PLAN_CHANGED');return p;};
 const source={
  binding:record=>serviceBinding(record.brand),
  async plan(record,binding){const p=record.provenance,r=await call(binding,{kind:'plan',brand:record.brand,provenance:p});if(r?.campaign_id!==record.campaignId||r?.campaign_uuid!==p.campaignUuid)fail('CONSENT_PLAN_CHANGED');contexts.set(record.brand+':'+r.campaign_id+':'+r.campaign_uuid,p);return r;},
  member:(plan,id,binding)=>call(binding,{kind:'member',brand:plan.brand,provenance:context(plan),subscriberId:id}),
  unsubscribe:(plan,member,binding)=>call(binding,{kind:'unsubscribe',brand:plan.brand,provenance:context(plan),member})
 };
 const task=createTask({store,source,now,enabled:true});
 async function registerOne({userId,clientKey,brand,freezeKey}){
  if(closing)fail('CONSENT_TASK_DISABLED');const row=db.prepare("SELECT * FROM crm_campaign_create_v1 WHERE user_id=? AND client_key=? AND brand=? AND phase='succeeded'").get(userId,clientKey,brand);
  if(!row||row.created_at<enabledSince)fail('CONSENT_REGISTRATION_UNCONFIRMED');
  // An already recorded campaign is never registered from a newer public head.
  if(row.consent_job_ciphertext){const prior=store.list().find(r=>r.userId===userId&&r.clientKey===clientKey&&r.campaignId===row.campaign_id);if(!prior||prior.provenance.freezeKey!==freezeKey)fail('CONSENT_REGISTRATION_CHANGED');return true;}
  const binding=await serviceBinding(brand),p=await call(binding,{kind:'register',brand,createKey:row.remote_key,freezeKey});
  if(p?.campaignId!==row.campaign_id||p.brand!==brand||p.createdOperationId!==row.remote_operation_id||p.createKey!==row.remote_key)fail('CONSENT_REGISTRATION_UNCONFIRMED');
  if(closing)fail('CONSENT_TASK_DISABLED');return store.register({userId,clientKey,brand,campaignId:row.campaign_id},p);
 }
 function register(args){if(closing)return Promise.reject(Object.assign(Error('CONSENT_TASK_DISABLED'),{code:'CONSENT_TASK_DISABLED'}));const key=JSON.stringify([args.userId,args.clientKey,args.brand]);const active=registrations.get(key);if(active){if(active.freezeKey!==args.freezeKey)return Promise.reject(Object.assign(Error('CONSENT_REGISTRATION_CHANGED'),{code:'CONSENT_REGISTRATION_CHANGED'}));return active.promise;}const promise=registerOne(args).finally(()=>registrations.delete(key));registrations.set(key,{freezeKey:args.freezeKey,promise});return promise;}
 function ready({userId,brand,campaignId}){if(closing)return false;try{return store.list().some(r=>r.userId===userId&&r.brand===brand&&r.campaignId===campaignId);}catch{return false;}}
 async function close(){closing=true;await Promise.allSettled([task.close(),...[...registrations.values()].map(x=>x.promise)]);contexts.clear();}
 return Object.freeze({register,ready,tick:task.tick,close});
}
module.exports={createBroker,SOURCE};
