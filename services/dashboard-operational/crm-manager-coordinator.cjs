'use strict';
// Dormant, explicit invocation only. No scheduler, SQL, environment, socket,
// logs or imports of runtime modules. All dependencies are private callbacks.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CAPS=Object.freeze(['read_content','list_history','submission']);
const TTL=600000,LIFETIME=1209600000;
const PHASES=['queued','prepare_uncertain','prepared','attested','commit_uncertain','committed','promoted','revoke_pending','revoked','failed','expired'];
const LIFECYCLES=['awaiting_accept','provisioning','ready','revoking','revoked','failed'];
const RESULTS=Object.freeze(Object.fromEntries(['ready','pending','expired','revoked'].map(state=>[state,Object.freeze({state})])));
const REQUEST_KEYS=['operationId','userId','lifecycleId','owner','principalId','keySha256','generation','expectedGeneration'];
const COMMIT_KEYS=[...REQUEST_KEYS,'prepareOperationId','issuedAt','candidateExpiresAt','expiresAt'];
const PREPARED_KEYS=['schema','issuerId','namespaceId','operationId','action','userId','lifecycleId','owner','state','principalId','generation','expectedGeneration','area','slot','role','caps','issuedAt','candidateExpiresAt','expiresAt'];
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d?.enumerable===true&&Object.hasOwn(d,'value');});
const uuid=v=>typeof v==='string'&&UUID.test(v);
const time=v=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-LIFETIME;
const caps=v=>Array.isArray(v)&&Reflect.ownKeys(v).length===CAPS.length+1&&v.length===CAPS.length&&CAPS.every((c,i)=>{const d=Object.getOwnPropertyDescriptor(v,String(i));return d?.enumerable===true&&Object.hasOwn(d,'value')&&d.value===c;});
const owner=v=>typeof v==='string'&&v.length<=254&&v===v.toLowerCase()&&/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@([a-z0-9-]+\.)+[a-z]{2,63}$/.test(v)&&v.split('@')[0].length<=64;
function refuse(){const e=new Error('MANAGED_COORDINATOR_REFUSED');e.code='MANAGED_COORDINATOR_REFUSED';throw e;}
function synchronous(callback){
 const value=callback();let promise=false;
 // Refuse async DI without leaving its rejection unobserved. These callbacks
 // must finish the SQLite transaction/read before any remote action begins.
 try{Promise.prototype.then.call(value,()=>{},()=>{});promise=true;}catch{}
 if(promise)refuse();
 if(value!==null&&['object','function'].includes(typeof value)&&'then' in value){Promise.resolve(value).catch(()=>{});refuse();}
 return value;
}

function createManagerCoordinator(options){
 const required=['journal','client','attest','getOperationState'];
 if(!exact(options,[...required,...(Object.hasOwn(options||{},'now')?['now']:[])]))refuse();
 const {journal:providedJournal,client,attest,getOperationState}=options,now=Object.hasOwn(options,'now')?options.now:Date.now;
 const journalMethods=['request','beginPrepare','recordPrepared','candidateForAttestation','recordAttestation','commitDescriptor','beginCommit','recordCommitted','promote','expireCandidate','confirmRevoked'];
 const clientMethods=['prepareRead','prepareRenewalRead','operationStatus','commitRead','revokeRead'];
 if(!providedJournal||!client||journalMethods.some(k=>typeof providedJournal[k]!=='function')||clientMethods.some(k=>typeof client[k]!=='function')||[attest,getOperationState,now].some(f=>typeof f!=='function'))refuse();
 const journal=Object.freeze(Object.fromEntries(journalMethods.map(name=>[name,(...args)=>synchronous(()=>providedJournal[name](...args))])));
 let active=null;
 const clock=()=>{const value=synchronous(now);if(!time(value))refuse();return value;};

 // Adapter is synchronous and reads only the explicitly requested operation.
 // `current` binds its lifecycle/version to current eligibility. For revokes,
 // a historical lifecycle still needs compensation after a later reinvite.
 function state(operationId){
  const value=synchronous(()=>getOperationState(operationId));
  if(!exact(value,['kind','phase','candidateExpiresAt','lifecycleState','current'])||!['issue','renew','revoke'].includes(value.kind)||!PHASES.includes(value.phase)||!LIFECYCLES.includes(value.lifecycleState)||typeof value.current!=='boolean'||value.candidateExpiresAt!==null&&!time(value.candidateExpiresAt))refuse();
  if(value.kind==='revoke'&&(!['revoke_pending','revoked'].includes(value.phase)||value.candidateExpiresAt!==null)||value.kind!=='revoke'&&['revoke_pending','revoked'].includes(value.phase))refuse();
  if(['prepared','attested','commit_uncertain','committed','promoted','expired'].includes(value.phase)&&value.candidateExpiresAt===null)refuse();
  return Object.freeze({...value});
 }
 const live=s=>s.kind==='revoke'||s.current&&['provisioning','ready'].includes(s.lifecycleState);
 const same=(s,kind,phase)=>s.kind===kind&&s.phase===phase&&live(s);
 function outcome(s){
  if(s.phase==='revoked'||s.lifecycleState==='revoked')return RESULTS.revoked;
  if(!live(s))return RESULTS.pending;
  if(s.phase==='promoted'&&s.lifecycleState==='ready')return RESULTS.ready;
  if(s.phase==='expired')return RESULTS.expired;
  return RESULTS.pending;
 }
 function request(operationId,s){
  const value=journal.request(operationId),keys=s.kind==='revoke'?['operationId','userId','lifecycleId','owner']:REQUEST_KEYS;
  if(!exact(value,keys)||value.operationId!==operationId||!uuid(value.operationId)||!uuid(value.userId)||!uuid(value.lifecycleId)||!owner(value.owner))refuse();
  if(s.kind!=='revoke'&&(typeof value.principalId!=='string'||!/^dcrm-[a-f0-9]{32}$/.test(value.principalId)||typeof value.keySha256!=='string'||!/^[a-f0-9]{64}$/.test(value.keySha256)||!Number.isSafeInteger(value.generation)||value.generation<1||value.generation>999999999||!Number.isSafeInteger(value.expectedGeneration)||value.generation!==value.expectedGeneration+1||s.kind==='issue'&&value.expectedGeneration!==0||s.kind==='renew'&&value.expectedGeneration<1))refuse();
  return Object.freeze({...value});
 }
 function prepareDescriptor(operationId,s){
  const value=request(operationId,s);
  // Journal stores both generations; prepareRead's closed input omits them.
  const args=s.kind==='issue'?Object.fromEntries(Object.entries(value).filter(([key])=>!['generation','expectedGeneration'].includes(key))):{...value};
  return Object.freeze({action:s.kind==='issue'?'prepare_read':'renew_read',args:Object.freeze(args)});
 }
 function commitDescriptor(operationId,s){
  const value=journal.commitDescriptor(operationId),r=request(operationId,s);
  if(!exact(value,['action','args'])||value.action!=='commit_read'||!exact(value.args,COMMIT_KEYS)||!uuid(value.args.operationId)||value.args.operationId===operationId||value.args.prepareOperationId!==operationId||!time(value.args.issuedAt)||value.args.candidateExpiresAt!==value.args.issuedAt+TTL||value.args.expiresAt!==value.args.issuedAt+LIFETIME||value.args.candidateExpiresAt!==s.candidateExpiresAt)refuse();
  for(const key of REQUEST_KEYS.filter(k=>k!=='operationId'))if(value.args[key]!==r[key])refuse();
  return Object.freeze({action:'commit_read',args:Object.freeze({...value.args})});
 }
 function statusResult(value){
  if(!exact(value,['found',...(value?.found===true?['receipt']:[])])||typeof value.found!=='boolean'||value.found&&!plain(value.receipt))refuse();
  return value;
 }
 function restoredPrepare(value,descriptor,kind){
  const r=descriptor.args;
  if(!exact(value,PREPARED_KEYS)||value.schema!=='crm-manager-provision-receipt-v1'||!uuid(value.issuerId)||!uuid(value.namespaceId)||value.operationId!==r.prepareOperationId||value.action!==(kind==='issue'?'prepare_read':'renew_read')||value.state!=='prepared'||value.area!=='growth'||value.slot!=='crm-panel-read'||value.role!=='manager'||!caps(value.caps))refuse();
  for(const key of ['userId','lifecycleId','owner','principalId','generation','expectedGeneration','issuedAt','candidateExpiresAt','expiresAt'])if(value[key]!==r[key])refuse();
  return value; // Preserve the exact object branded by this client instance.
 }

 async function sendPrepare(operationId,s){
  journal.beginPrepare(operationId);const before=state(operationId);
  if(!same(before,s.kind,'prepare_uncertain'))return false;
  const descriptor=prepareDescriptor(operationId,before);
  const proof=await (s.kind==='issue'?client.prepareRead(descriptor.args):client.prepareRenewalRead(descriptor.args));
  if(!same(state(operationId),s.kind,'prepare_uncertain'))return false;
  journal.recordPrepared(operationId,proof);return true;
 }
 async function sendCommit(operationId,s,descriptor){
  if(s.candidateExpiresAt<=clock())return false;
  const expected=prepareDescriptor(operationId,s);
  const found=statusResult(await client.operationStatus({...expected,requireFound:true}));
  const after=state(operationId);
  if(!same(after,s.kind,'commit_uncertain')||!found.found||after.candidateExpiresAt<=clock())return false;
  const prepared=restoredPrepare(found.receipt,descriptor,s.kind);
  const proof=await client.commitRead({operationId:descriptor.args.operationId,prepared});
  if(!same(state(operationId),s.kind,'commit_uncertain'))return false;
  journal.recordCommitted(operationId,proof);return true;
 }

 async function drive(operationId){
  // Only forward transitions are performed. An error stops this invocation;
  // retries require another explicit run and reuse the durable operation ID.
  for(let step=0;step<8;step++){
   const s=state(operationId);clock();
   if(!live(s)||['promoted','revoked','failed','expired'].includes(s.phase))return outcome(s);
   if(s.kind==='revoke'){
    const args=request(operationId,s),descriptor={action:'revoke_read',args};
    const found=statusResult(await client.operationStatus({...descriptor,requireFound:false}));
    if(!same(state(operationId),'revoke','revoke_pending'))return outcome(state(operationId));
    const proof=found.found?found.receipt:await client.revokeRead(args);
    if(!same(state(operationId),'revoke','revoke_pending'))return outcome(state(operationId));
    journal.confirmRevoked(operationId,proof);return outcome(state(operationId));
   }
   if(s.phase==='queued'){
    if(!await sendPrepare(operationId,s))return outcome(state(operationId));
   }else if(s.phase==='prepare_uncertain'){
    const descriptor=prepareDescriptor(operationId,s);
    const found=statusResult(await client.operationStatus({...descriptor,requireFound:false}));
    if(!same(state(operationId),s.kind,'prepare_uncertain'))return outcome(state(operationId));
    if(found.found)journal.recordPrepared(operationId,found.receipt);
    else if(!await sendPrepare(operationId,s))return outcome(state(operationId));
   }else if(s.phase==='prepared'){
    if(s.candidateExpiresAt<=clock()){journal.expireCandidate(operationId);return outcome(state(operationId));}
    const r=request(operationId,s),bearer=journal.candidateForAttestation(operationId);
    if(typeof bearer!=='string'||!/^[a-f0-9]{64}$/.test(bearer))refuse();
    const proof=await attest(Object.freeze({owner:r.owner,principalId:r.principalId,bearer}));
    const after=state(operationId);
    if(!same(after,s.kind,'prepared'))return outcome(after);
    if(after.candidateExpiresAt<=clock()){journal.expireCandidate(operationId);return outcome(state(operationId));}
    if(!exact(proof,['owner','principalId','caps'])||proof.owner!==r.owner||proof.principalId!==r.principalId||!caps(proof.caps))refuse();
    journal.recordAttestation(operationId,proof);
   }else if(s.phase==='attested'){
    if(s.candidateExpiresAt<=clock()){journal.expireCandidate(operationId);return outcome(state(operationId));}
    journal.beginCommit(operationId);const after=state(operationId);
    if(!same(after,s.kind,'commit_uncertain'))return outcome(after);
    if(!await sendCommit(operationId,after,commitDescriptor(operationId,after)))return outcome(state(operationId));
   }else if(s.phase==='commit_uncertain'){
    const descriptor=commitDescriptor(operationId,s);
    const found=statusResult(await client.operationStatus({...descriptor,requireFound:false}));
    const after=state(operationId);
    if(!same(after,s.kind,'commit_uncertain'))return outcome(after);
    if(found.found)journal.recordCommitted(operationId,found.receipt);
    // Absence after TTL cannot prove an uncertain commit never ran. Retain it.
    else if(after.candidateExpiresAt<=clock()||!await sendCommit(operationId,after,descriptor))return RESULTS.pending;
   }else if(s.phase==='committed'){
    journal.promote(operationId);return outcome(state(operationId));
   }else return RESULTS.pending;
  }
  return RESULTS.pending;
 }
 function run(operationId){
  if(!uuid(operationId))return Promise.resolve(RESULTS.pending);
  if(active)return active.operationId===operationId?active.promise:Promise.resolve(RESULTS.pending);
  let promise;
  promise=Promise.resolve().then(()=>drive(operationId)).catch(()=>RESULTS.pending).finally(()=>{if(active?.promise===promise)active=null;});
  active={operationId,promise};return promise;
 }
 return Object.freeze({run});
}
module.exports={createManagerCoordinator};
