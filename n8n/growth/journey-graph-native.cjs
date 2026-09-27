/* Trusted backend adapter only. Native template creation is never email transport.
   Dependencies select a fixed verified Listmonk instance; no URL or credential input. */
'use strict';
const {isDeepStrictEqual}=require('node:util');
const VERSION='journey_graph_native_v1',ENABLED=false,PREFIX='__shrigma_graph_tx_v1_';
const RECEIPT_KEYS=Object.freeze(['brand','cache_ack_at','cache_target','clone_template_id','contract','material_sha256','native_id','native_sha256','release_id','state']);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),brand=x=>x==='fish'||x==='aristo';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x),keys=(x,n)=>object(x)&&Object.keys(x).sort().join(',')===[...n].sort().join(',');
const copy=x=>JSON.parse(JSON.stringify(x));
function fail(code,identity={}){throw Object.assign(Error(code),{code,...identity});}
function validateReceipt(r,expected={}){
 if(!keys(r,RECEIPT_KEYS)||r.contract!==VERSION||!uuid(r.native_id)||!uuid(r.release_id)||!brand(r.brand)||!hash(r.material_sha256)||!hash(r.native_sha256)||typeof r.cache_target!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.cache_target)||!['reserved','creating','ready'].includes(r.state))fail('GRAPH_NATIVE_RECEIPT_INVALID');
 if(r.state==='ready'?(!Number.isSafeInteger(r.clone_template_id)||r.clone_template_id<=0||typeof r.cache_ack_at!=='string'||!Number.isFinite(Date.parse(r.cache_ack_at))):(r.clone_template_id!==null||r.cache_ack_at!==null))fail('GRAPH_NATIVE_RECEIPT_INVALID');
 for(const [key,value]of Object.entries(expected))if(r[key]!==value)fail('GRAPH_NATIVE_RECEIPT_INVALID');
 return copy(r);
}
function snapshot(s){
 if(!keys(s,['type','subject','body','body_source'])||s.type!=='tx'||typeof s.subject!=='string'||!s.subject.trim()||typeof s.body!=='string'||!s.body.trim()||!(s.body_source===null||typeof s.body_source==='string')||Buffer.byteLength(JSON.stringify(s))>300000)fail('GRAPH_NATIVE_SNAPSHOT_INVALID');
 return copy(s);
}
function nativeMatches(response,nid,name,s){
 const t=response?.body?.data;
 return response?.status===200&&object(t)&&Number.isSafeInteger(t.id)&&t.id>0&&(nid===null||nid===t.id)&&t.name===name&&t.is_default===false&&isDeepStrictEqual({type:t.type,subject:t.subject,body:t.body,body_source:t.body_source},s);
}
function createNativeProvider({query,nativeCreate,nativeRead,cacheTarget,timeoutMs=10000}={}){
 if(typeof query!=='function'||typeof nativeCreate!=='function'||typeof nativeRead!=='function'||typeof cacheTarget!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cacheTarget)||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)fail('GRAPH_NATIVE_ADAPTER_REQUIRED');
 const confirmations=new Map();
 const identity=(b,nid)=>{if(!brand(b)||!uuid(nid))fail('GRAPH_NATIVE_REQUEST_INVALID');return {brand:b,native_id:nid};};
 const request=(actor,p)=>{
  if(typeof actor!=='string'||!/^panel:.{1,194}$/.test(actor)||!keys(p,['request_id','brand','release_id','expected_material_sha256'])||!uuid(p.request_id)||!uuid(p.release_id)||!brand(p.brand)||!hash(p.expected_material_sha256))fail('GRAPH_NATIVE_REQUEST_INVALID');
  return copy(p);
 };
 const one=async(q,args)=>{
  let r;try{r=await query(q,args);}catch(e){const code=/^GRAPH_NATIVE_[A-Z_]+$/.test(e?.message||'')?e.message:'GRAPH_NATIVE_OUTCOME_UNKNOWN';fail(code);}
  if(!Array.isArray(r?.rows)||r.rows.length!==1||!Object.hasOwn(r.rows[0],'result'))fail('GRAPH_NATIVE_OUTCOME_UNKNOWN');return r.rows[0].result;
 };
 const checked=(r,b,more={})=>validateReceipt(r,{brand:b,cache_target:cacheTarget,...more});
 async function call(fn,arg){
  const controller=new AbortController();let timer;
  try{
   const result=await Promise.race([Promise.resolve().then(()=>fn(arg,{cacheTarget,signal:controller.signal,timeoutMs,maxResponseBytes:350000})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('timeout'));},timeoutMs);})]);
   if(Buffer.byteLength(JSON.stringify(result)??'')>350000)fail('GRAPH_NATIVE_RESPONSE_LIMIT');return result;
  }finally{clearTimeout(timer);}
 }
 const api={
  async prepare(actor,p){p=request(actor,p);return checked(await one('SELECT crm_graph_candidate.native_prepare_v1($1::text,$2::jsonb,$3::text) AS result',[actor,p,cacheTarget]),p.brand,{release_id:p.release_id,material_sha256:p.expected_material_sha256});},
  async operation(actor,p){p=request(actor,p);const r=await one('SELECT crm_graph_candidate.native_operation_v1($1::text,$2::jsonb,$3::text) AS result',[actor,p,cacheTarget]);return r===null?null:checked(r,p.brand,{release_id:p.release_id,material_sha256:p.expected_material_sha256});},
  async inspect(b,nid){identity(b,nid);const r=await one('SELECT crm_graph_candidate.native_get_v1($1::text,$2::uuid,$3::text) AS result',[b,nid,cacheTarget]);if(r===null)fail('GRAPH_NATIVE_NOT_FOUND');return checked(r,b,{native_id:nid});},
  async resolve(b,rid,h){if(!brand(b)||!uuid(rid)||!hash(h))fail('GRAPH_NATIVE_REQUEST_INVALID');return checked(await one('SELECT crm_graph_candidate.native_resolve_v1($1::text,$2::uuid,$3::text,$4::text) AS result',[b,rid,h,cacheTarget]),b,{release_id:rid,material_sha256:h,state:'ready'});},
  async create(b,nid){
   const id=identity(b,nid),begin=await one('SELECT crm_graph_candidate.native_begin_v1($1::text,$2::uuid,$3::text) AS result',[b,nid,cacheTarget]);
   const receipt=checked(begin?.receipt,b,{native_id:nid});
   if(begin.should_create===false){if(!keys(begin,['should_create','receipt'])||receipt.state==='reserved')fail('GRAPH_NATIVE_RECEIPT_INVALID');return receipt;}
   if(!keys(begin,['should_create','receipt','snapshot','clone_name','claim_token'])||begin.should_create!==true||receipt.state!=='creating'||!uuid(begin.claim_token)||begin.clone_name!==PREFIX+nid)fail('GRAPH_NATIVE_RECEIPT_INVALID');
   const s=snapshot(begin.snapshot);let response;
   try{response=await call(nativeCreate,{name:begin.clone_name,...s,is_default:false});}catch{fail('GRAPH_NATIVE_OUTCOME_UNKNOWN',id);}
   if(!nativeMatches(response,null,begin.clone_name,s))fail('GRAPH_NATIVE_OUTCOME_UNKNOWN',id);
   // This capability stays only in this provider instance after an exact native ACK.
   // Losing it never permits another create; GET/SQL cannot prove compiled cache.
   confirmations.set(b+':'+nid,{token:begin.claim_token,tid:response.body.data.id,release_id:receipt.release_id,material_sha256:receipt.material_sha256});
   return api.confirm(b,nid);
  },
  async confirm(b,nid){
   const id=identity(b,nid),key=b+':'+nid,ack=confirmations.get(key);if(!ack)fail('GRAPH_NATIVE_ACK_REQUIRED');
   let receipt;try{receipt=checked(await one('SELECT crm_graph_candidate.native_confirm_v1($1::text,$2::uuid,$3::uuid,$4::integer,$5::text) AS result',[b,nid,ack.token,ack.tid,cacheTarget]),b,{native_id:nid,release_id:ack.release_id,material_sha256:ack.material_sha256,state:'ready',clone_template_id:ack.tid});}catch{fail('GRAPH_NATIVE_OUTCOME_UNKNOWN',id);}
   confirmations.delete(key);return receipt;
  },
  async reconcile(b,nid){
   identity(b,nid);const r=await one('SELECT crm_graph_candidate.native_candidate_v1($1::text,$2::uuid,$3::text) AS result',[b,nid,cacheTarget]);
   if(!keys(r,['receipt','native_id_candidate','clone_name','snapshot'])||r.clone_name!==PREFIX+nid)fail('GRAPH_NATIVE_RECEIPT_INVALID');
   const receipt=checked(r.receipt,b,{native_id:nid}),tid=r.native_id_candidate,s=snapshot(r.snapshot);
   if(tid!==null&&(!Number.isSafeInteger(tid)||tid<=0))fail('GRAPH_NATIVE_RECEIPT_INVALID');
   let diagnosis=receipt.state==='ready'?'ready':receipt.state==='reserved'?'not_started':tid===null?'native_missing':'native_exists_cache_unconfirmed';
   if(receipt.state!=='ready'&&tid!==null){
    try{if(!nativeMatches(await call(nativeRead,tid),tid,r.clone_name,s))diagnosis='native_mismatch';}catch{diagnosis='native_read_unconfirmed';}
   }
   return {receipt,diagnosis,native_id_candidate:tid};
  }
 };
 return Object.freeze(api);
}
module.exports={VERSION,ENABLED,PREFIX,RECEIPT_KEYS,validateReceipt,createNativeProvider};
