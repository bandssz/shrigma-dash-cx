'use strict';
// Read-only process telemetry. No timer, persistence or operational call.
const STALE_MS=30*60*1000,INTERVAL_MS=10*60*1000,BRANDS=['aristo','fish'],FIELDS=['campaigns','changed','pending'];
const empty=()=>Object.fromEntries(BRANDS.map(brand=>[brand,{campaigns:0,changed:0,pending:0}]));
const safeCode=e=>/^CONSENT_[A-Z_]{1,70}$/.test(e?.code||'')?e.code:'CONSENT_RUN_FAILED';
function createObservation({now=Date.now,enabled=false}={}){
 const clock=()=>{try{const v=now();return Number.isSafeInteger(v)&&v>=0?v:null;}catch{return null;}};
 const createdAt=clock();let current=null,last=null;
 function start(at){current={startedAt:at,byBrand:empty(),unassignedPending:0};}
 function record(brand,before,after){
  if(!current)return;
  for(const field of FIELDS){const delta=after[field]-before[field];if(!Number.isSafeInteger(delta)||delta<0)continue;
   if(BRANDS.includes(brand))current.byBrand[brand][field]+=delta;else if(field==='pending')current.unassignedPending+=delta;
  }
 }
 function finish(result,error){
  if(!current)return;const endedAt=clock();
  last={...current,finishedAt:endedAt,durationMs:endedAt!==null&&endedAt>=current.startedAt?endedAt-current.startedAt:null,ok:!error&&FIELDS.every(k=>Number.isSafeInteger(result?.[k])&&result[k]>=0),code:error?safeCode(error):null};current=null;
 }
 function status(brand){
  const observedAt=clock(),anchor=last?.finishedAt??createdAt,ageMs=observedAt!==null&&anchor!==null&&observedAt>=anchor?observedAt-anchor:null;
  const stale=enabled===true&&(ageMs===null||ageMs>STALE_MS),selected=last?.ok&&BRANDS.includes(brand)?last.byBrand[brand]:null;
  const state=enabled!==true?'disabled':last&&!last.ok?'error':stale?'stale':current?'running':!last?'unobserved':(last.unassignedPending>0||selected?.pending>0)?'partial':'ready';
  return Object.freeze({schema:'crm-consent-observation-v1',brand,enabled:enabled===true,state,observedAt,intervalMs:INTERVAL_MS,staleAfterMs:STALE_MS,ageMs,stale,running:!!current,startedAt:current?.startedAt??last?.startedAt??null,finishedAt:last?.finishedAt??null,durationMs:last?.durationMs??null,lastError:last?.code??null,counts:Object.freeze({campaigns:selected?.campaigns??null,changed:selected?.changed??null,pending:selected&&last.unassignedPending===0?selected.pending:null}),unassignedPending:last?.ok?last.unassignedPending:null,readOnly:true});
 }
 return Object.freeze({start,record,finish,status});
}
module.exports={createObservation,STALE_MS};
