'use strict';
// Shadow-only, bounded DTO contract. Validation and hashes are not admission,
// authorization, source verification, recipient selection, or permission to send.
const {types}=require('node:util');
const H=require('./segment-audience-review.cjs');
const VERSION='crm-ab-audience-admission-inspect-v1',ENABLED=false;
const ACTION='ab_publico_admissao_inspecionar';
const FLAGS=Object.freeze({authorizes_selection:false,authorizes_send:false,execution_blocked:true,external_dependencies_complete:false});
const BLOCKERS=Object.freeze(['external_material_unconfirmed','execution_path_not_installed']);
const ERROR_STATUS=Object.freeze({AB_ADMISSION_INPUT:400,AB_ADMISSION_CORRUPT:503});
const LIMITS=Object.freeze({bytes:20000,nodes:1000,depth:12,version:999999999,review_ms:300000,lead_ms:900000});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,MD5=/^[a-f0-9]{32}$/;
const uuid=v=>typeof v==='string'&&UUID.test(v),hash=v=>typeof v==='string'&&HASH.test(v);
const positive=(v,max=2147483647)=>Number.isSafeInteger(v)&&v>0&&v<=max;
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=100000;
const exact=(v,keys)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=code=>Object.assign(new Error(code),{code,status:ERROR_STATUS[code]});
const timestamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function copy(value,code){
 try{
  let nodes=0;const active=new Set();
  function plain(v,depth){
   if(++nodes>LIMITS.nodes||depth>LIMITS.depth)throw Error();
   if(v===null||typeof v==='boolean'||typeof v==='string')return;
   if(typeof v==='number'){if(!Number.isSafeInteger(v)||Object.is(v,-0))throw Error();return;}
   if(typeof v!=='object'||types.isProxy(v)||active.has(v)||![Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v)))throw Error();
   active.add(v);const array=Array.isArray(v),keys=Reflect.ownKeys(v);
   for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=='string'||!Object.hasOwn(d,'value')||(!array||k!=='length')&&!d.enumerable)throw Error();if(!array||k!=='length')plain(d.value,depth+1);}
   active.delete(v);
  }
  plain(value,0);const encoded=H.canonical(value);if(Buffer.byteLength(encoded)>LIMITS.bytes)throw Error();return JSON.parse(encoded);
 }catch{throw fail(code);}
}
function request(value){
 const p=copy(value,'AB_ADMISSION_INPUT');
 if(!exact(p,['acao','brand','test_id','expected_version','expected_scope_hash','review_id'])||p.acao!==ACTION||!['fish','aristo'].includes(p.brand)||!uuid(p.test_id)||!uuid(p.review_id)||!positive(p.expected_version,LIMITS.version)||!hash(p.expected_scope_hash))throw fail('AB_ADMISSION_INPUT');
 return freeze(p);
}
function inspection(value){
 const r=copy(value,'AB_ADMISSION_CORRUPT');
 if(!exact(r,['test_id','brand','experiment_version','scope_hash','review_id','checked_at','expires_at','send_at','audience','materials','blockers'])||!uuid(r.test_id)||!['fish','aristo'].includes(r.brand)||!positive(r.experiment_version,LIMITS.version)||!hash(r.scope_hash)||!uuid(r.review_id)||!timestamp(r.checked_at)||!timestamp(r.expires_at)||!timestamp(r.send_at))throw fail('AB_ADMISSION_CORRUPT');
 const checked=Date.parse(r.checked_at),expires=Date.parse(r.expires_at),send=Date.parse(r.send_at);
 if(expires<=checked||expires-checked>LIMITS.review_ms||send-checked<LIMITS.lead_ms)throw fail('AB_ADMISSION_CORRUPT');
 const a=r.audience;
 if(!exact(a,['audience_id','audience_revision','cohort_hash','eligible_fingerprint','arms','minimum_reached','checked_at','snapshot_only'])||!uuid(a.audience_id)||!positive(a.audience_revision,LIMITS.version)||!hash(a.cohort_hash)||!hash(a.eligible_fingerprint)||a.minimum_reached!==true||!timestamp(a.checked_at)||a.snapshot_only!==true||!Array.isArray(a.arms)||a.arms.length!==2)throw fail('AB_ADMISSION_CORRUPT');
 const audienceChecked=Date.parse(a.checked_at);if(audienceChecked>checked||checked-audienceChecked>LIMITS.review_ms)throw fail('AB_ADMISSION_CORRUPT');
 for(const [i,arm]of a.arms.entries()){
  if(!exact(arm,['arm','campaign_id','allocated','eligible','excluded','revoked','missing'])||arm.arm!==['a','b'][i]||!positive(arm.campaign_id)||!positive(arm.allocated,50000)||['eligible','excluded','revoked','missing'].some(k=>!count(arm[k]))||arm.eligible+arm.excluded!==arm.allocated||arm.revoked+arm.missing>arm.excluded)throw fail('AB_ADMISSION_CORRUPT');
 }
 if(a.arms[0].campaign_id===a.arms[1].campaign_id||!Array.isArray(r.materials)||r.materials.length!==2)throw fail('AB_ADMISSION_CORRUPT');
 for(const [i,m]of r.materials.entries())if(!exact(m,['arm','campaign_id','campaign_version','material_hash'])||m.arm!==['a','b'][i]||m.campaign_id!==a.arms[i].campaign_id||typeof m.campaign_version!=='string'||!MD5.test(m.campaign_version)||!hash(m.material_hash))throw fail('AB_ADMISSION_CORRUPT');
 if(!Array.isArray(r.blockers)||r.blockers.length!==BLOCKERS.length||r.blockers.some((v,i)=>v!==BLOCKERS[i]))throw fail('AB_ADMISSION_CORRUPT');
 return freeze(r);
}
function seal(value){
 const raw=inspection(value),inspection_hash=H.digest({contract:VERSION,inspection:raw});
 return freeze({contract:VERSION,inspection:{...raw,inspection_hash},...FLAGS});
}
module.exports={VERSION,ENABLED,ACTION,FLAGS,BLOCKERS,ERROR_STATUS,LIMITS,request,inspection,seal};
