/* Browser journal for prospective VIP recorded-origin receipts. No automatic retry. */
var VipRecordedOriginClient=(()=>{
'use strict';
const VERSION=1,CONTRACT='crm-recorded-origin-receipt-v1',UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,HASH=/^[0-9a-f]{64}$/,REASON=/^[a-z][a-z0-9_]{0,63}$/;
const exact=(v,keys)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=code=>Object.assign(Error(code),{code});
const iso=v=>{const n=Date.parse(v);if(!Number.isFinite(n))throw fail('VIP_ORIGIN_ACK_INVALID');return new Date(n).toISOString();};
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
function createRecordedOriginClient({source,producerId,producerRevision,endpoint,storage,crypto,locks,fetch,TextEncoder:Encoder=globalThis.TextEncoder,AbortController:Abort=globalThis.AbortController,setTimeout:setTimer=globalThis.setTimeout,clearTimeout:clearTimer=globalThis.clearTimeout,timeoutMs=10000,clock=Date.now}={}){
 if(!['alma','desodorante'].includes(source)||typeof producerId!=='string'||!producerId||!HASH.test(producerRevision||'')||typeof endpoint!=='string'||!/^https:\/\/[^\s]+$/.test(endpoint)
  ||!storage||typeof storage.getItem!=='function'||typeof storage.setItem!=='function'||!crypto||typeof crypto.randomUUID!=='function'||typeof crypto.subtle?.digest!=='function'
  ||!locks||typeof locks.request!=='function'||typeof fetch!=='function'||typeof Encoder!=='function'||typeof Abort!=='function'||typeof setTimer!=='function'||typeof clearTimer!=='function'
  ||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000||typeof clock!=='function')throw fail('VIP_ORIGIN_CLIENT_UNAVAILABLE');
 const key='crm.vip.recorded-origin.'+source,lockName='crm-vip-recorded-origin-'+producerId,producer=producerId,revision=producerRevision;
 function validateJournal(v){
  if(!exact(v,['version','state','source','producer_id','producer_revision','event_id','payload_fingerprint','created_at','receipt_hash','accepted_at','result_reason'])||v.version!==VERSION
   ||!['posting','uncertain','confirmed','rejected'].includes(v.state)||v.source!==source||v.producer_id!==producer||!HASH.test(v.producer_revision)||!UUID.test(v.event_id)||!HASH.test(v.payload_fingerprint)
   ||!Number.isSafeInteger(v.created_at)||v.created_at<0||v.receipt_hash!==null&&!HASH.test(v.receipt_hash)||v.accepted_at!==null&&iso(v.accepted_at)!==v.accepted_at||v.result_reason!==null&&!REASON.test(v.result_reason)
   ||v.state==='confirmed'&&(!v.receipt_hash||!v.accepted_at||v.result_reason!==null)||v.state==='rejected'&&(!v.result_reason||v.receipt_hash!==null||v.accepted_at!==null)
   ||!['confirmed','rejected'].includes(v.state)&&(v.receipt_hash!==null||v.accepted_at!==null||v.result_reason!==null))throw fail('VIP_ORIGIN_JOURNAL_INVALID');return Object.freeze({...v});
 }
 function read(){const raw=storage.getItem(key);if(raw===null)return null;try{return validateJournal(JSON.parse(raw));}catch{throw fail('VIP_ORIGIN_JOURNAL_INVALID');}}
 function write(v){const raw=JSON.stringify(validateJournal(v));storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw fail('VIP_ORIGIN_STORAGE_UNAVAILABLE');return validateJournal(v);}
 const base=(state,event_id,payload_fingerprint,created_at)=>({version:VERSION,state,source,producer_id:producer,producer_revision:revision,event_id,payload_fingerprint,created_at,receipt_hash:null,accepted_at:null,result_reason:null});
 async function fingerprint(event_id,email,origin,corrected){const value=JSON.stringify({contract:'crm-recorded-origin-browser-request-v1',source,producer_id:producer,producer_revision:revision,event_id,email,origin,corrected});return hex(await crypto.subtle.digest('SHA-256',new Encoder().encode(value)));}
 function ack(raw,{event_id,allowMissing=false}={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.contract!==CONTRACT||raw.producer_id!==producer||raw.event_id!==event_id)throw fail('VIP_ORIGIN_ACK_INVALID');
  if(raw.state==='not_found'&&allowMissing&&exact(raw,['contract','state','producer_id','event_id']))return Object.freeze({...raw});
  if(raw.state==='not_accepted'&&exact(raw,['contract','state','producer_id','event_id','reason'])&&REASON.test(raw.reason))return Object.freeze({...raw});
  if(raw.state!=='accepted'||!exact(raw,['contract','state','producer_id','event_id','receipt_hash','accepted_at','newly_recorded'])||!HASH.test(raw.receipt_hash)||typeof raw.newly_recorded!=='boolean')throw fail('VIP_ORIGIN_ACK_INVALID');
  return Object.freeze({...raw,accepted_at:iso(raw.accepted_at)});
 }
 async function request(url,options,event_id,allowMissing){
  const controller=new Abort();let timer;
  const work=(async()=>{const response=await fetch(url,{...options,signal:controller.signal});if(!response||response.ok!==true||typeof response.json!=='function')throw fail('VIP_ORIGIN_REQUEST_UNCERTAIN');let raw;try{raw=await response.json();}catch{throw fail('VIP_ORIGIN_REQUEST_UNCERTAIN');}return ack(raw,{event_id,allowMissing});})();
  const timeout=new Promise((_,reject)=>{timer=setTimer(()=>{controller.abort();reject(fail('VIP_ORIGIN_REQUEST_UNCERTAIN'));},timeoutMs);});
  try{return await Promise.race([work,timeout]);}finally{clearTimer(timer);}
 }
 async function locked(fn){let returned;try{returned=locks.request(lockName,{mode:'exclusive'},fn);}catch{throw fail('VIP_ORIGIN_CLIENT_UNAVAILABLE');}if(!returned||typeof returned.then!=='function')throw fail('VIP_ORIGIN_CLIENT_UNAVAILABLE');return returned;}
 function validInput(email,origin,corrected){if(typeof email!=='string'||email!==email.trim().toLowerCase()||email.length>254||!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)||typeof origin!=='string'||origin.length<1||origin.length>64||/[\x00-\x1f\x7f]/.test(origin)||typeof corrected!=='boolean')throw fail('VIP_ORIGIN_INPUT');}
 async function submit({email,origin,corrected=false,onJournaled}={}){
  validInput(email,origin,corrected);
  if(onJournaled!==undefined&&typeof onJournaled!=='function')throw fail('VIP_ORIGIN_INPUT');
  return locked(async()=>{const current=read();if(current){if(current.producer_revision!==revision)throw fail('VIP_ORIGIN_ATTEMPT_EXISTS');const candidate=await fingerprint(current.event_id,email,origin,corrected);if(candidate!==current.payload_fingerprint)throw fail('VIP_ORIGIN_ATTEMPT_EXISTS');return Object.freeze({state:current.state,event_id:current.event_id,requires_reconcile:!['confirmed','rejected'].includes(current.state),posted:false,reason:current.result_reason});}
   let event_id;try{event_id=crypto.randomUUID();}catch{throw fail('VIP_ORIGIN_CLIENT_UNAVAILABLE');}if(!UUID.test(event_id))throw fail('VIP_ORIGIN_CLIENT_UNAVAILABLE');
   let payload_fingerprint;try{payload_fingerprint=await fingerprint(event_id,email,origin,corrected);}catch{throw fail('VIP_ORIGIN_CLIENT_UNAVAILABLE');}
   const created_at=clock();if(!Number.isSafeInteger(created_at)||created_at<0)throw fail('VIP_ORIGIN_CLIENT_UNAVAILABLE');write(base('posting',event_id,payload_fingerprint,created_at));if(onJournaled)try{onJournaled();}catch{}
   try{const result=await request(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,origem:origin,corrigido:corrected,event_id}),credentials:'omit',cache:'no-store',redirect:'error'},event_id,false);
    if(result.state==='not_accepted'){write({...base('rejected',event_id,payload_fingerprint,created_at),result_reason:result.reason});return Object.freeze({...result,posted:true});}
    write({...base('confirmed',event_id,payload_fingerprint,created_at),receipt_hash:result.receipt_hash,accepted_at:result.accepted_at});return Object.freeze({...result,posted:true});
   }catch(e){write(base('uncertain',event_id,payload_fingerprint,created_at));throw fail(e?.code==='VIP_ORIGIN_ACK_INVALID'?'VIP_ORIGIN_ACK_INVALID':'VIP_ORIGIN_REQUEST_UNCERTAIN');}
  });
 }
 async function reconcile(){return locked(async()=>{const current=read();if(!current)throw fail('VIP_ORIGIN_JOURNAL_MISSING');if(current.state==='confirmed')return Object.freeze({contract:CONTRACT,state:'accepted',producer_id:producer,event_id:current.event_id,receipt_hash:current.receipt_hash,accepted_at:current.accepted_at,newly_recorded:false,reconciled:true});if(current.state==='rejected')return Object.freeze({contract:CONTRACT,state:'not_accepted',producer_id:producer,event_id:current.event_id,reason:current.result_reason,reconciled:true});
  const url=new URL(endpoint);url.searchParams.set('event_id',current.event_id);try{const result=await request(url.toString(),{method:'GET',credentials:'omit',cache:'no-store',redirect:'error'},current.event_id,true);if(result.state==='not_found'){write({...current,state:'uncertain'});return Object.freeze({...result,reconciled:false});}if(result.state==='not_accepted'){write({...current,state:'rejected',result_reason:result.reason});return Object.freeze({...result,reconciled:true});}write({...current,state:'confirmed',receipt_hash:result.receipt_hash,accepted_at:result.accepted_at});return Object.freeze({...result,reconciled:true});}catch(e){write({...current,state:'uncertain'});throw fail(e?.code==='VIP_ORIGIN_ACK_INVALID'?'VIP_ORIGIN_ACK_INVALID':'VIP_ORIGIN_REQUEST_UNCERTAIN');}});}
 function status(){const v=read();return v&&Object.freeze({state:v.state,source:v.source,event_id:v.event_id,requires_reconcile:!['confirmed','rejected'].includes(v.state),receipt_hash:v.receipt_hash,accepted_at:v.accepted_at,reason:v.result_reason});}
 function bindForm({form,email,button,error,origin,corrected=false,navigate,onJournaled}={}){
  if(!form||typeof form.addEventListener!=='function'||!email||!button||!error||typeof navigate!=='function')throw fail('VIP_ORIGIN_FORM_INVALID');const defaultText=button.textContent,previous=read();if(previous){email.disabled=true;button.textContent='Conferir inscrição anterior';}
  form.addEventListener('submit',async ev=>{ev.preventDefault();button.disabled=true;error.textContent='';try{const active=read(),result=active?await reconcile():await submit({email:email.value.trim().toLowerCase(),origin,corrected,onJournaled});if(result.state==='accepted')navigate();else if(result.state==='not_accepted'){email.disabled=true;button.textContent='Inscrição não confirmada';error.textContent='A inscrição não foi aceita. Nenhum novo envio será feito por este protocolo.';}else{email.disabled=true;button.textContent='Conferir inscrição anterior';error.textContent='A confirmação ainda não chegou. Use este botão para consultar novamente.';}}catch{let pending=null;try{pending=read();}catch{}if(pending){email.disabled=true;button.textContent='Conferir inscrição anterior';error.textContent='Não foi possível confirmar. A próxima tentativa apenas consultará o mesmo protocolo.';}else{email.disabled=false;button.textContent=defaultText;error.textContent='Confira os dados e tente novamente.';}}finally{button.disabled=false;}});return status();
 }
 return Object.freeze({submit,reconcile,status,bindForm});
}
return {VERSION,CONTRACT,createRecordedOriginClient};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=VipRecordedOriginClient;
