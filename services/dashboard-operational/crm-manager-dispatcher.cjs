'use strict';
// Explicit private batch only. No timer, startup hook, environment, socket,
// logger, SQL, HTTP, automatic renewal, queue or retry loop is installed.
const MAXIMUM=8,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES=Object.freeze(['ready','pending','expired','revoked']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function exact(value,keys){try{return plain(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(value,k);return d?.enumerable===true&&Object.hasOwn(d,'value');});}catch{return false;}}
function refuse(){const e=new Error('MANAGED_DISPATCHER_REFUSED');e.code='MANAGED_DISPATCHER_REFUSED';throw e;}
function synchronous(callback){
 const value=callback();let promise=false;
 try{Promise.prototype.then.call(value,()=>{},()=>{});promise=true;}catch{}
 if(promise)refuse();
 if(value!==null&&['object','function'].includes(typeof value)&&'then' in value){Promise.resolve(value).catch(()=>{});refuse();}
 return value;
}
function snapshot(value){
 if(!Array.isArray(value)||value.length>MAXIMUM||Reflect.ownKeys(value).length!==value.length+1)refuse();
 const ids=[];
 for(let index=0;index<value.length;index++){
  const d=Object.getOwnPropertyDescriptor(value,String(index));
  if(!d?.enumerable||!Object.hasOwn(d,'value')||typeof d.value!=='string'||!UUID.test(d.value))refuse();
  ids.push(d.value);
 }
 return Object.freeze([...new Set(ids)]);
}
const empty=()=>({ready:0,pending:0,expired:0,revoked:0});
function createManagerDispatcher(options){
 if(!exact(options,['getPendingOperations','coordinator'])||typeof options.getPendingOperations!=='function')refuse();
 let descriptor;try{if(!plain(options.coordinator))refuse();descriptor=Object.getOwnPropertyDescriptor(options.coordinator,'run');}catch{refuse();}
 if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='function')refuse();
 const getter=options.getPendingOperations,coordinator=options.coordinator,run=descriptor.value;let active=null;
 async function processBatch(){
  const counts=empty();let ids;
  try{ids=snapshot(synchronous(()=>getter(MAXIMUM)));}
  // A discovery failure is one aggregate pending condition. It does not claim
  // that the queue is empty or disclose the operation/error that blocked it.
  catch{counts.pending=1;return Object.freeze(counts);}
  for(const operationId of ids){
   try{
    const value=await Reflect.apply(run,coordinator,[operationId]);
    if(!exact(value,['state'])||!STATES.includes(value.state))refuse();
    counts[value.state]++;
   }catch{counts.pending++;}
  }
  return Object.freeze(counts);
 }
 function drain(){
  if(active)return active;
  let promise;promise=Promise.resolve().then(processBatch).catch(()=>Object.freeze({ready:0,pending:1,expired:0,revoked:0})).finally(()=>{if(active===promise)active=null;});
  active=promise;return promise;
 }
 return Object.freeze({drain});
}
module.exports={createManagerDispatcher};
