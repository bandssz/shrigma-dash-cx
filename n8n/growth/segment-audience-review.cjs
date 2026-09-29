/* Local shadow candidate. Injected providers perform READS ONLY. No store, HTTP,
 * credentials, enrollment, selector or transport is supplied by this module.
 *
 * Hash contract: recursively key-sorted JSON, arrays in their original order,
 * UTF-8 SHA-256. This is NOT PostgreSQL jsonb::text hashing. Adapters must use
 * digest() below or explicitly translate their own verified hash contract.
 * Snapshot hashes cover every field except their own hash and checked_at.
 * checked_at is a fresh read timestamp; expires_at is part of the pinned data.
 *
 * Provider contract (all objects are copied and validated before use):
 * authenticate -> {actor,caps,brands,checked_at,expires_at}.
 * readDefinition -> {brand,audience_id,revision,definition,definition_hash,
 *                    checked_at,expires_at}.
 * readCatalog -> {brand,base_list_id,catalog,catalog_hash,checked_at,expires_at}.
 * readUniverse -> {brand,base_list_id,complete,identity_confirmed,total_count,
 *   subjects:[{subject_ref,identity_confirmed,base_member_confirmed,
 *              eligibility_confirmed}],
 *   universe_hash,checked_at,expires_at}.
 * readEvidence -> {brand,revision,definition_hash,base_list_id,universe_hash,
 *   catalog_hash,sources:[{source,source_hash,coverage,
 *   negative_evidence_supported,checked_at,expires_at}],evidence:[{
 *   subject_ref,rule_key,brand,revision,definition_hash,universe_hash,
 *   catalog_hash,source,source_hash,value,complete,proof_kind,
 *   observed_at,expires_at}],evidence_hash,checked_at,expires_at}.
 * Coverage: complete_subject | positive_only | partial | unavailable.
 * Proof: complete_subject_snapshot | observed_fact |
 *        shopify_member_enumeration | unavailable.
 * A complete_subject_snapshot requires complete_subject coverage AND explicit
 * negative support. observed_fact can prove only a positive membership/event,
 * never count/amount/date comparisons or a negative predicate. An enumeration
 * of Shopify segment members is insufficient here, even when paginated fully:
 * the current adapter supplies neither a CRM identity bridge nor negative proof.
 * eligibility_confirmed attests current enabled global status, no opt-out or
 * suppression, and confirmed/opted-in membership of this exact brand base. A
 * mere subscriber/list association cannot attest eligibility. The universe
 * dates/hashes cover these consent checks as well as enumeration and identity.
 * These declarations are obligations of trusted, reviewed server adapters, not
 * client assertions. There is deliberately no operational adapter/default.
 */
'use strict';
const {createHash}=require('node:crypto');
const A=require('./segment-audience-contract.js');
const VERSION='crm-audience-review-v1',HASH_CONTRACT='canonical-json-sorted-keys-sha256-v1';
const MAX_AGE_MS=300000,HASH=/^[a-f0-9]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCES=['listmonk','shopify','crm','email'];
const CODES=new Set(['AUDIENCE_REVIEW_INPUT','AUDIENCE_REVIEW_ACCESS','AUDIENCE_REVIEW_VERSION','AUDIENCE_REVIEW_CORRUPT','AUDIENCE_REVIEW_DRIFT','AUDIENCE_REVIEW_READ_UNCONFIRMED','AUDIENCE_REVIEW_TIMEOUT','AUDIENCE_REVIEW_ABORTED']);
const fail=code=>Object.assign(new Error(code),{code});
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const stamp=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function exact(v,keys){return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>own(v,k));}
function canonical(value){
 let count=0;
 function visit(v,depth){
  if(++count>300000||depth>32)throw fail('AUDIENCE_REVIEW_CORRUPT');
  if(v===null||typeof v==='boolean')return JSON.stringify(v);
  if(typeof v==='string'){if(v.length>32768)throw fail('AUDIENCE_REVIEW_CORRUPT');return JSON.stringify(v);}
  if(typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
  if(!v||typeof v!=='object'||![Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v)))throw fail('AUDIENCE_REVIEW_CORRUPT');
  const names=Reflect.ownKeys(v),array=Array.isArray(v);
  if(names.some(k=>typeof k!=='string'||(!array||k!=='length')&&(!Object.getOwnPropertyDescriptor(v,k).enumerable||!own(Object.getOwnPropertyDescriptor(v,k),'value'))))throw fail('AUDIENCE_REVIEW_CORRUPT');
  if(array){if(names.length!==v.length+1||names.some(k=>k!=='length'&&(!/^(0|[1-9]\d*)$/.test(k)||Number(k)>=v.length)))throw fail('AUDIENCE_REVIEW_CORRUPT');return '['+v.map(x=>visit(x,depth+1)).join(',')+']';}
  return '{'+names.sort().map(k=>JSON.stringify(k)+':'+visit(v[k],depth+1)).join(',')+'}';
 }
 const result=visit(value,0);if(Buffer.byteLength(result)>8*1024*1024)throw fail('AUDIENCE_REVIEW_CORRUPT');return result;
}
const copy=v=>JSON.parse(canonical(v));
const digest=v=>createHash('sha256').update(canonical(v),'utf8').digest('hex');
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function snapshotHash(value,field){const v=copy(value);delete v.checked_at;delete v[field];return digest(v);}
function positiveFact(rule){return rule.op==='in_list'||rule.field==='purchase.product'&&rule.operator==='purchased'||rule.field==='signup.origin'&&rule.operator==='is'||['email.opened','email.clicked'].includes(rule.field)&&rule.operator==='within_last_days';}
function createAudienceReviewer({provider,clock=Date.now,timeoutMs=10000,maxSubjects=1000}={}){
 if(!provider||['authenticate','readDefinition','readUniverse','readCatalog','readEvidence'].some(k=>typeof provider[k]!=='function')||typeof clock!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000||!Number.isSafeInteger(maxSubjects)||maxSubjects<1||maxSubjects>10000)throw fail('AUDIENCE_REVIEW_INPUT');
 const now=()=>{const t=clock();if(!Number.isSafeInteger(t)||t<0)throw fail('AUDIENCE_REVIEW_READ_UNCONFIRMED');return t;};
 async function review(value,{authorization,signal:callerSignal}={}){
  let p;try{p=copy(value);}catch{throw fail('AUDIENCE_REVIEW_INPUT');}
  if(!exact(p,['brand','audience_id','expected_revision','expected_definition_hash'])||!['fish','aristo'].includes(p.brand)||(typeof p.audience_id!=='string'||!UUID.test(p.audience_id))||!positive(p.expected_revision)||typeof p.expected_definition_hash!=='string'||!HASH.test(p.expected_definition_hash))throw fail('AUDIENCE_REVIEW_INPUT');
  if(typeof authorization!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(authorization))throw fail('AUDIENCE_REVIEW_ACCESS');
  if(callerSignal!==undefined&&(!(callerSignal instanceof AbortSignal)))throw fail('AUDIENCE_REVIEW_INPUT');
  if(callerSignal?.aborted)throw fail('AUDIENCE_REVIEW_ABORTED');
  const started=now(),controller=new AbortController(),signal=controller.signal;let timer,abortHandler,rejectAbort;
  const assertRunning=()=>{if(signal.aborted)throw fail(callerSignal?.aborted?'AUDIENCE_REVIEW_ABORTED':'AUDIENCE_REVIEW_TIMEOUT');if(now()<started||now()-started>=timeoutMs)throw fail('AUDIENCE_REVIEW_TIMEOUT');};
  const validAt=(v,t)=>stamp(v.checked_at)&&stamp(v.expires_at)&&Date.parse(v.checked_at)<=t&&Date.parse(v.expires_at)>t&&Date.parse(v.expires_at)>Date.parse(v.checked_at)&&Date.parse(v.expires_at)-Date.parse(v.checked_at)<=MAX_AGE_MS;
  const fresh=v=>{if(!validAt(v,now()))throw fail('AUDIENCE_REVIEW_READ_UNCONFIRMED');return v;};
  async function read(name,args){
   assertRunning();let raw;
   try{raw=await provider[name]({...freeze(copy(args)),signal});}catch{assertRunning();throw fail('AUDIENCE_REVIEW_READ_UNCONFIRMED');}
   assertRunning();return fresh(copy(raw));
  }
  async function auth(){
   const a=await read('authenticate',{authorization,brand:p.brand});
   if(!exact(a,['actor','caps','brands','checked_at','expires_at'])||typeof a.actor!=='string'||!/^panel:[A-Za-z0-9_.:-]{1,122}$/.test(a.actor)||!Array.isArray(a.caps)||a.caps.length>32||new Set(a.caps).size!==a.caps.length||a.caps.some(x=>typeof x!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(x))||!a.caps.includes('read_content')||!Array.isArray(a.brands)||a.brands.length<1||a.brands.length>2||new Set(a.brands).size!==a.brands.length||a.brands.some(x=>!['fish','aristo'].includes(x))||!a.brands.includes(p.brand))throw fail('AUDIENCE_REVIEW_ACCESS');
   return a;
  }
  function definition(d){
   if(!exact(d,['brand','audience_id','revision','definition','definition_hash','checked_at','expires_at'])||d.brand!==p.brand||d.audience_id!==p.audience_id||!positive(d.revision)||typeof d.definition_hash!=='string'||!HASH.test(d.definition_hash))throw fail('AUDIENCE_REVIEW_CORRUPT');
   let normal;try{normal=A.normalize(d.definition);}catch{throw fail('AUDIENCE_REVIEW_CORRUPT');}
   if(normal.brand!==p.brand||digest(normal)!==d.definition_hash||digest(d.definition)!==d.definition_hash)throw fail('AUDIENCE_REVIEW_CORRUPT');
   if(d.revision!==p.expected_revision||d.definition_hash!==p.expected_definition_hash)throw fail('AUDIENCE_REVIEW_VERSION');return d;
  }
  function catalog(c){
   if(!exact(c,['brand','base_list_id','catalog','catalog_hash','checked_at','expires_at'])||c.brand!==p.brand||!positive(c.base_list_id)||c.catalog?.brand!==p.brand||typeof c.catalog.current!=='boolean'||!['fields','lists','products','origins'].every(k=>Array.isArray(c.catalog[k])&&c.catalog[k].length<=10000)||snapshotHash(c,'catalog_hash')!==c.catalog_hash)throw fail('AUDIENCE_REVIEW_CORRUPT');
   if(c.catalog.lists.some(x=>!x||x.brand!==p.brand||!positive(x.id))||c.catalog.products.some(x=>!x||x.brand!==p.brand)||c.catalog.origins.some(x=>!x||x.brand!==p.brand)||c.catalog.lists.filter(x=>x.id===c.base_list_id).length!==1)throw fail('AUDIENCE_REVIEW_CORRUPT');return c;
  }
  function universe(u,c){
   if(!exact(u,['brand','base_list_id','complete','identity_confirmed','total_count','subjects','universe_hash','checked_at','expires_at'])||u.brand!==p.brand||u.base_list_id!==c.base_list_id||typeof u.complete!=='boolean'||typeof u.identity_confirmed!=='boolean'||!Array.isArray(u.subjects)||u.subjects.length>maxSubjects||u.total_count!==null&&(!Number.isSafeInteger(u.total_count)||u.total_count<u.subjects.length)||u.complete&&u.total_count!==u.subjects.length||snapshotHash(u,'universe_hash')!==u.universe_hash)throw fail('AUDIENCE_REVIEW_CORRUPT');
   const seen=new Set();for(const s of u.subjects){if(!exact(s,['subject_ref','identity_confirmed','base_member_confirmed','eligibility_confirmed'])||typeof s.subject_ref!=='string'||!s.subject_ref||s.subject_ref.length>200||/[\x00-\x1f\x7f]/.test(s.subject_ref)||seen.has(s.subject_ref)||typeof s.identity_confirmed!=='boolean'||typeof s.base_member_confirmed!=='boolean'||typeof s.eligibility_confirmed!=='boolean'||u.identity_confirmed&&!s.identity_confirmed)throw fail('AUDIENCE_REVIEW_CORRUPT');seen.add(s.subject_ref);}return u;
  }
  function evidence(e,d,c,u){
   if(!exact(e,['brand','revision','definition_hash','base_list_id','universe_hash','catalog_hash','sources','evidence','evidence_hash','checked_at','expires_at'])||e.brand!==p.brand||e.revision!==d.revision||e.definition_hash!==d.definition_hash||e.base_list_id!==c.base_list_id||e.universe_hash!==u.universe_hash||e.catalog_hash!==c.catalog_hash||!Array.isArray(e.sources)||e.sources.length>4||!Array.isArray(e.evidence)||e.evidence.length>u.subjects.length*A.LIMITS.nodes||snapshotHash(e,'evidence_hash')!==e.evidence_hash)throw fail('AUDIENCE_REVIEW_CORRUPT');
   const sourceNames=new Set(),sourceMap=new Map(),subjects=new Set(u.subjects.map(x=>x.subject_ref)),leaves=new Map(A.leaves(d.definition).map(x=>[x.key,x.rule])),seen=new Set();
   for(const s of e.sources){if(!exact(s,['source','source_hash','coverage','negative_evidence_supported','checked_at','expires_at'])||!SOURCES.includes(s.source)||sourceNames.has(s.source)||typeof s.source_hash!=='string'||!HASH.test(s.source_hash)||!['complete_subject','positive_only','partial','unavailable'].includes(s.coverage)||typeof s.negative_evidence_supported!=='boolean'||s.coverage!=='complete_subject'&&s.negative_evidence_supported||!stamp(s.checked_at)||!stamp(s.expires_at))throw fail('AUDIENCE_REVIEW_CORRUPT');sourceNames.add(s.source);sourceMap.set(s.source,s);}
   for(const f of e.evidence){
    const rule=leaves.get(f?.rule_key),source=rule?.op==='in_list'?'listmonk':A.FIELDS[rule?.field]?.source,s=sourceMap.get(f?.source),key=JSON.stringify([f?.subject_ref,f?.rule_key]);
    if(!exact(f,['subject_ref','rule_key','brand','revision','definition_hash','universe_hash','catalog_hash','source','source_hash','value','complete','proof_kind','observed_at','expires_at'])||!subjects.has(f.subject_ref)||!rule||seen.has(key)||f.brand!==p.brand||f.revision!==d.revision||f.definition_hash!==d.definition_hash||f.universe_hash!==u.universe_hash||f.catalog_hash!==c.catalog_hash||f.source!==source||!s||f.source_hash!==s.source_hash||![true,false,null].includes(f.value)||typeof f.complete!=='boolean'||!['complete_subject_snapshot','observed_fact','shopify_member_enumeration','unavailable'].includes(f.proof_kind)||!stamp(f.observed_at)||!stamp(f.expires_at))throw fail('AUDIENCE_REVIEW_CORRUPT');seen.add(key);
   }
   return e;
  }
  const pin=v=>{const x=copy(v);delete x.checked_at;return digest(x);};
  async function work(){
   const firstAuth=await auth(),args={brand:p.brand,audience_id:p.audience_id,actor:firstAuth.actor};
   const d=definition(await read('readDefinition',args)),c=catalog(await read('readCatalog',args)),u=universe(await read('readUniverse',{...args,base_list_id:c.base_list_id}),c);
   const evidenceArgs={...args,revision:d.revision,definition_hash:d.definition_hash,base_list_id:c.base_list_id,catalog_hash:c.catalog_hash,universe_hash:u.universe_hash,subjects:u.subjects,rules:A.leaves(d.definition)};
   const e=evidence(await read('readEvidence',evidenceArgs),d,c,u);
   // Re-authenticate before further reads, then recheck every pin, and finally
   // re-authenticate again. Providers may observe changes; a review freezes none.
   const secondAuth=await auth();
   if(digest({actor:firstAuth.actor,caps:firstAuth.caps,brands:firstAuth.brands})!==digest({actor:secondAuth.actor,caps:secondAuth.caps,brands:secondAuth.brands}))throw fail('AUDIENCE_REVIEW_ACCESS');
   const d2=definition(await read('readDefinition',args)),c2=catalog(await read('readCatalog',args)),u2=universe(await read('readUniverse',{...args,base_list_id:c.base_list_id}),c2),e2=evidence(await read('readEvidence',evidenceArgs),d2,c2,u2);
   if([d,c,u,e].some((x,i)=>pin(x)!==pin([d2,c2,u2,e2][i])))throw fail('AUDIENCE_REVIEW_DRIFT');
   const finalAuth=await auth();if(digest({actor:firstAuth.actor,caps:firstAuth.caps,brands:firstAuth.brands})!==digest({actor:finalAuth.actor,caps:finalAuth.caps,brands:finalAuth.brands}))throw fail('AUDIENCE_REVIEW_ACCESS');
   assertRunning();const completed=now(),frames=[firstAuth,secondAuth,finalAuth,d,c,u,e,d2,c2,u2,e2];frames.forEach(fresh);
   const catalogReady=c.catalog.current===true&&c.catalog.lists.find(x=>x.id===c.base_list_id).available===true&&A.checkCatalog(d.definition,c.catalog).ok;
   const sourceMap=new Map(e.sources.map(s=>[s.source,s])),leaves=new Map(A.leaves(d.definition).map(x=>[x.key,x.rule])),facts=new Map(u.subjects.map(s=>[s.subject_ref,[]]));
   const usableTimes=[];
   for(const f of e.evidence){
    const s=sourceMap.get(f.source),rule=leaves.get(f.rule_key),timing={checked_at:f.observed_at,expires_at:f.expires_at};
    const adequate=f.complete===true&&typeof f.value==='boolean'&&validAt(s,completed)&&validAt(timing,completed)&&Date.parse(f.expires_at)<=Date.parse(s.expires_at)&&
     (f.proof_kind==='complete_subject_snapshot'&&s.coverage==='complete_subject'&&s.negative_evidence_supported===true||f.proof_kind==='observed_fact'&&['positive_only','complete_subject'].includes(s.coverage)&&f.value===true&&positiveFact(rule));
    if(adequate){facts.get(f.subject_ref).push(f);usableTimes.push(s.expires_at,f.expires_at);}
   }
   let matched_count=0,excluded_count=0,unknown_count=0;
   for(const s of u.subjects){const result=catalogReady&&s.identity_confirmed&&s.base_member_confirmed&&s.eligibility_confirmed?A.evaluate(d.definition,{subject_ref:s.subject_ref,revision:d.revision,evidence:facts.get(s.subject_ref),now:new Date(completed).toISOString()}).match:null;if(result===true)matched_count++;else if(result===false)excluded_count++;else unknown_count++;}
   const identityReady=u.identity_confirmed&&u.subjects.every(x=>x.identity_confirmed&&x.base_member_confirmed),eligibilityReady=u.subjects.every(x=>x.eligibility_confirmed),complete=u.complete&&identityReady&&eligibilityReady&&catalogReady&&unknown_count===0;
   const blockers=[];if(!u.complete)blockers.push('universe_incomplete');if(!identityReady)blockers.push('identity_unconfirmed');if(!eligibilityReady)blockers.push('eligibility_unconfirmed');if(!catalogReady)blockers.push('catalog_unavailable');if(unknown_count)blockers.push('evidence_unknown');
   const expires=frames.map(x=>x.expires_at).concat(usableTimes).reduce((t,x)=>Math.min(t,Date.parse(x)),completed+MAX_AGE_MS);
   const result={contract:VERSION,audience_contract:A.VERSION,hash_contract:HASH_CONTRACT,mode:'shadow',brand:p.brand,audience_id:p.audience_id,revision:d.revision,definition_hash:d.definition_hash,catalog_hash:c.catalog_hash,universe_hash:u.universe_hash,evidence_hash:e.evidence_hash,checked_at:new Date(completed).toISOString(),expires_at:new Date(expires).toISOString(),complete,counts_are_partial:!u.complete||!identityReady||!eligibilityReady,counts:{observed_count:u.subjects.length,matched_count,excluded_count,unknown_count,eligible_count:complete?matched_count:null},blockers,authorizes_selection:false,authorizes_send:false};
   return freeze({...result,review_hash:digest(result)});
  }
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
  abortHandler=()=>{controller.abort();rejectAbort(fail('AUDIENCE_REVIEW_ABORTED'));};callerSignal?.addEventListener('abort',abortHandler,{once:true});
  try{return await Promise.race([work(),aborted,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('AUDIENCE_REVIEW_TIMEOUT'));},timeoutMs);})]);}
  catch(e){throw fail(CODES.has(e?.code)?e.code:'AUDIENCE_REVIEW_READ_UNCONFIRMED');}
  finally{clearTimeout(timer);callerSignal?.removeEventListener('abort',abortHandler);controller.abort();}
 }
 return Object.freeze({enabled:false,review});
}
module.exports={VERSION,HASH_CONTRACT,MAX_AGE_MS,ENABLED:false,canonical,digest,snapshotHash,createAudienceReviewer};
