'use strict';
// Pure private-domain preparation. No SQL, HTTP, provider call or send authority.
const crypto=require('node:crypto'),C=require('../../audience-slice-contract.js');
const IDENTITY='crm-contact-id-v1',ALGORITHM='sha256-rejection-bp-v1',MAX_MEMBERS=100000,TTL=300000;
const fail=code=>{throw Object.assign(Error(code),{code});};
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const fresh=(v,now)=>Number.isSafeInteger(now)&&now>=0&&stamp(v.observed_at)&&stamp(v.expires_at)&&Date.parse(v.observed_at)<=now&&Date.parse(v.expires_at)>now&&Date.parse(v.expires_at)>Date.parse(v.observed_at)&&Date.parse(v.expires_at)-Date.parse(v.observed_at)<=TTL;
function distribution(input){
 C.exact(input,['schema','brand','id','revision','key','identity_contract','algorithm']);
 if(input.schema!==C.VERSION||!C.brand(input.brand)||!C.uuid(input.id)||!C.positive(input.revision)||typeof input.key!=='string'||!C.hash(input.key)||input.identity_contract!==IDENTITY||input.algorithm!==ALGORITHM)fail('AUDIENCE_SLICE_DISTRIBUTION');
 return {schema:input.schema,brand:input.brand,id:input.id,revision:input.revision,key:input.key,identity_contract:input.identity_contract,algorithm:input.algorithm};
}
const keyHash=d=>digest([C.VERSION,'distribution-key',d.brand,d.id,d.revision,d.key,d.identity_contract,d.algorithm]);
function bucketOf(d,subjectId){
 if(typeof subjectId!=='string'||!C.uuid(subjectId))fail('AUDIENCE_SLICE_IDENTITY');
 // Exclude the small modulo remainder; the same contact keeps its bucket when
 // list order, names, e-mail address, provider or base cardinality changes.
 const threshold=Math.floor(0x100000000/C.SCALE)*C.SCALE;
 for(let counter=0;counter<16;counter++){
  const bytes=crypto.createHash('sha256').update(JSON.stringify([C.VERSION,'bucket',d.brand,d.id,d.key,d.identity_contract,subjectId,counter])).digest();
  for(let at=0;at<bytes.length;at+=4){const n=bytes.readUInt32BE(at);if(n<threshold)return n%C.SCALE;}
 }
 fail('AUDIENCE_SLICE_HASH_REFUSED');
}
const bucket=(input,subjectId)=>bucketOf(distribution(input),subjectId);
function bind(plan,input){
 const p=C.normalize(plan),d=distribution(input);
 if(p.brand!==d.brand||p.distribution_id!==d.id||p.distribution_revision!==d.revision||p.key_hash!==keyHash(d))fail('AUDIENCE_SLICE_DISTRIBUTION_CHANGED');
 return {p,d};
}
function snapshot(input,brand,now){
 C.exact(input,['schema','brand','audience_id','audience_revision','definition_hash','snapshot_id','source_hash','observed_at','expires_at','complete','identity_complete','members']);
 if(input.schema!=='crm-audience-slice-source-v1'||input.brand!==brand||!C.uuid(input.audience_id)||!C.positive(input.audience_revision)||!C.hash(input.definition_hash)||!C.uuid(input.snapshot_id)||!C.hash(input.source_hash)||typeof input.complete!=='boolean'||typeof input.identity_complete!=='boolean')fail('AUDIENCE_SLICE_SOURCE');
 if(!input.complete||!input.identity_complete){if(input.members!==null)fail('AUDIENCE_SLICE_SOURCE');return null;}
 if(!fresh(input,now))return null;
 if(!Array.isArray(input.members)||input.members.length>MAX_MEMBERS||!C.array(input.members)||input.members.some(id=>typeof id!=='string'||!C.uuid(id))||new Set(input.members).size!==input.members.length)fail('AUDIENCE_SLICE_SOURCE');
 return {...input,members:input.members.slice().sort()};
}
function ledger(input,d){
 C.exact(input,['schema','brand','distribution_id','distribution_revision','key_hash','revision','complete','claims']);
 if(input.schema!=='crm-audience-slice-claims-v1'||input.brand!==d.brand||input.distribution_id!==d.id||input.distribution_revision!==d.revision||input.key_hash!==keyHash(d)||!C.positive(input.revision)||typeof input.complete!=='boolean')fail('AUDIENCE_SLICE_CLAIMS');
 if(!input.complete){if(input.claims!==null)fail('AUDIENCE_SLICE_CLAIMS');return null;}
 if(!Array.isArray(input.claims)||input.claims.length>MAX_MEMBERS||!C.array(input.claims))fail('AUDIENCE_SLICE_CLAIMS');
 const seen=new Set(),blocked=new Set();
 for(const claim of input.claims){
  C.exact(claim,['subject_id','operation_id','state','receipt_hash']);
  if(!C.uuid(claim.subject_id)||!C.uuid(claim.operation_id)||seen.has(claim.subject_id)||!['reserved','uncertain','accepted','rejected_before_send'].includes(claim.state)||(['accepted','rejected_before_send'].includes(claim.state)?!C.hash(claim.receipt_hash):claim.receipt_hash!==null))fail('AUDIENCE_SLICE_CLAIMS');
  seen.add(claim.subject_id);if(claim.state!=='rejected_before_send')blocked.add(claim.subject_id);
 }
 return {...input,blocked};
}
const unavailable=reason=>Object.freeze({schema:C.VERSION,state:'unavailable',reason,selected_count:null,member_ids:null,authorizes_send:false});
function select({plan,distribution:input,slice_id,snapshot:source,claims,now=Date.now()}={}){
 const {p,d}=bind(plan,input),slice=p.slices.find(s=>s.id===slice_id);if(!slice)fail('AUDIENCE_SLICE_NOT_FOUND');
 if(!source||!claims)return unavailable('source_or_claims_unavailable');
 const s=snapshot(source,d.brand,now),l=ledger(claims,d);
 if(!s||!l)return unavailable(!s?'source_unavailable':'claims_unavailable');
 const assigned=s.members.filter(id=>C.includes(slice,bucketOf(d,id))),members=assigned.filter(id=>!l.blocked.has(id));
 const planHash=digest(p),snapshotHash=digest([s.brand,s.audience_id,s.audience_revision,s.definition_hash,s.source_hash,s.members]),membersHash=digest(members);
 const selectionHash=digest([p.brand,p.distribution_id,p.distribution_revision,p.key_hash,planHash,slice.id,snapshotHash,l.revision,membersHash]);
 return Object.freeze({schema:C.VERSION,state:'prepared',brand:d.brand,distribution_id:d.id,distribution_revision:d.revision,key_hash:p.key_hash,plan_hash:planHash,slice_id:slice.id,audience_id:s.audience_id,audience_revision:s.audience_revision,definition_hash:s.definition_hash,snapshot_id:s.snapshot_id,source_hash:s.source_hash,snapshot_hash:snapshotHash,ledger_revision:l.revision,members_hash:membersHash,selection_hash:selectionHash,member_ids:Object.freeze(members),selected_count:members.length,excluded_claimed_count:assigned.length-members.length,checked_at:new Date(now).toISOString(),expires_at:s.expires_at,authorizes_send:false});
}
function campaign(input,selection){
 C.exact(input,['brand','campaign_id','campaign_version','content_hash','audience_definition_hash']);
 if(input.brand!==selection.brand||!C.positive(input.campaign_id)||!C.positive(input.campaign_version)||!C.hash(input.content_hash)||input.audience_definition_hash!==selection.definition_hash)fail('AUDIENCE_SLICE_CAMPAIGN');
 return {brand:input.brand,campaign_id:input.campaign_id,campaign_version:input.campaign_version,content_hash:input.content_hash,audience_definition_hash:input.audience_definition_hash};
}
function readmit({before,current,before_campaign,current_campaign,guards,now=Date.now()}={}){
 if(before?.state!=='prepared'||current?.state!=='prepared'||!Number.isSafeInteger(now)||!stamp(before.expires_at)||!stamp(current.expires_at)||Date.parse(before.expires_at)<=now||Date.parse(current.expires_at)<=now)return unavailable('review_unavailable');
 const old=campaign(before_campaign,before),live=campaign(current_campaign,current);
 if(before.selection_hash!==current.selection_hash||JSON.stringify(old)!==JSON.stringify(live))return unavailable('review_changed');
 if(!guards)return unavailable('send_guards_unavailable');
 C.exact(guards,['brand','campaign_id','campaign_version','content_hash','definition_hash','members_hash','observed_at','expires_at','content_current','consent_current','bounce_current','frequency_current']);
 if(guards.brand!==live.brand||guards.campaign_id!==live.campaign_id||guards.campaign_version!==live.campaign_version||guards.content_hash!==live.content_hash||guards.definition_hash!==current.definition_hash||guards.members_hash!==current.members_hash||!fresh(guards,now)||Date.parse(guards.expires_at)-Date.parse(guards.observed_at)>60000||['content_current','consent_current','bounce_current','frequency_current'].some(k=>guards[k]!==true))return unavailable('send_guards_unavailable');
 // The host must still atomically compare the source/claim revisions, reserve
 // every contact and persist ONE operation before any provider delivery call.
 return Object.freeze({schema:C.VERSION,state:'prepared-for-atomic-claim',ready_for_atomic_claim:true,selection_hash:current.selection_hash,ledger_revision:current.ledger_revision,selected_count:current.selected_count,member_ids:current.member_ids,authorizes_send:false});
}
function recoveryAction(input){
 C.exact(input,['brand','distribution_id','operation_id','phase']);
 if(!C.brand(input.brand)||!C.uuid(input.distribution_id)||!C.uuid(input.operation_id)||!['reserved','uncertain','accepted','rejected_before_send'].includes(input.phase))fail('AUDIENCE_SLICE_OPERATION');
 return Object.freeze({action:['reserved','uncertain'].includes(input.phase)?'consult_original':input.phase==='accepted'?'confirmed':'new_review_required',operation_id:input.operation_id,automatic_replay:false,new_attempt_allowed:false,authorizes_send:false});
}
function projection(selection){return Object.freeze({schema:C.VERSION,state:selection.state,reason:selection.reason||null,selected_count:selection.selected_count,checked_at:selection.checked_at||null,expires_at:selection.expires_at||null,authorizes_send:false});}
module.exports=Object.freeze({VERSION:C.VERSION,ENABLED:false,IDENTITY,ALGORITHM,MAX_MEMBERS,distribution,keyHash,bucket,bind,select,campaign,readmit,recoveryAction,projection,digest});
