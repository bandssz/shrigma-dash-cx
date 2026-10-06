'use strict';
// Test-only borrowed-session protocol: never connection/schema/production authority.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SOURCE_PINS={".github/workflows/dashboard-crm-mvp-controls-persistence-source-20261006.yml": {"bytes": 5239, "sha256": "3a14cfbe942850db32d0f67c1620a059f442be209a14ec379c9365d7b1fe3286", "gitBlobSha1": "73310dfc6c298a9c7c93a14ac72cfadfaf7812e9"}, "services/dashboard-operational/domain/crm-mvp-controls-persistence/codec.cjs": {"bytes": 7944, "sha256": "b240e3c840fabe6f359c57deff1ab1f6c7aae8b2e9120a2729d36781f0de3e0e", "gitBlobSha1": "9714282e34db7a260318301d7e49d349b56d5920"}, "services/dashboard-operational/domain/crm-mvp-controls-persistence/schema-v1.sql": {"bytes": 8800, "sha256": "fa7fe274af0223cc992e86d3f6b4a741714aab93e8b175712fb9b507dc24fe59", "gitBlobSha1": "9491b04de587d1d9a006070e68b9dbef9a6bbc33"}, "services/dashboard-operational/domain/crm-mvp-controls-persistence/sql.cjs": {"bytes": 14002, "sha256": "f52c780189e315f8abe6278316ce02f458b171ff15d098f24c7eb855f98b2feb", "gitBlobSha1": "2a4c647ba7e33e22fd679dd8b51152e428ccc82b"}, "services/dashboard-operational/domain/crm-mvp-controls-persistence/store.cjs": {"bytes": 11423, "sha256": "ffd6c73a813db7a95fbf2dde69b8a72c9c19ea96343933f6ceda4160a7d705c7", "gitBlobSha1": "c7ca5b6ae9ba7d3950425bc065daac211da7defb"}, "tests/crm-mvp-controls-persistence/context-pins.test.cjs": {"bytes": 3740, "sha256": "aad3117e719d5e7275549fba5854135e26b73f910b28940110af8ca1dbbb3e44", "gitBlobSha1": "e14d0b39ba1ea4df67f3c69ab09c1232ab921691"}, "tests/crm-mvp-controls-persistence/fixtures.cjs": {"bytes": 5994, "sha256": "36ca613ea6e3d0f5c1bfa01c79b58050fe51363a0667be919ec3bb044300b13d", "gitBlobSha1": "1156bc60db44749d9c93bdee668238bfc1bff7a9"}, "tests/crm-mvp-controls-persistence/pg17.test.cjs": {"bytes": 8813, "sha256": "90f3f6302f68ea043b1a9584d8d389b1c415ceede18f0fff412758158cb672c0", "gitBlobSha1": "339cfbea3e44da981729b4c68610a715de16dc15"}, "tests/crm-mvp-controls-persistence/source-ci-gate.test.cjs": {"bytes": 5498, "sha256": "3201bcad61056589621eb61b5634da17d4446aba03f619a007d0468f3bb16cbb", "gitBlobSha1": "b923f17aee27e0a65abb9bc741ce8747da66c916"}, "tests/crm-mvp-controls-persistence/store.test.cjs": {"bytes": 17968, "sha256": "249e797c00ddf843477e6bda784d0685e44507e645b0256f00315099bb393fdc", "gitBlobSha1": "b854532551c61fea01dfb0da82991d7556576591"}, "tests/crm-mvp-controls-persistence/verify-context.cjs": {"bytes": 5989, "sha256": "0e116cb7d2285bdbf57106396b18238ec83727a55dbbb6d2421616d7f2bae71d", "gitBlobSha1": "d811e05113d5448293027dd06597ba60f6532ea9"}, "tools/dashboard-crm-mvp-controls-persistence/materialize-context.cjs": {"bytes": 1764, "sha256": "ffc250fbddaaa9382d776cfb2525855b44df40d8128d7849f322d7512123757f", "gitBlobSha1": "5f493b9a4d6e4dd327a6cdf82431b1f81b188fbc"}, "tools/dashboard-crm-mvp-controls-persistence/public-context.json": {"bytes": 252343, "sha256": "c2d5a4db640e8d53ea0ce2a6bed20575c5917dfa2d5d0d7f515e09e29923a05f", "gitBlobSha1": "c72672af0cd96067270e8b2e54d0edc180202530"}, "tools/dashboard-crm-mvp-controls-persistence/source-gate.cjs": {"bytes": 11938, "sha256": "9842715fb5b8a5fbcd758012f5119f4da2e5c40320a20cd5bbefdbe629bc5c22", "gitBlobSha1": "4adf96c369c31c3987f2bca354620c87aa477f19"}};
const VERSION='SHOW server_version_num',SESSION='SELECT current_database() AS database_name, pg_backend_pid() AS backend_pid';
const SCENARIOS=new Set(['registration-race','consume-cas','brand-isolation','pending-hook','ack-hook']);
const used=new WeakSet(),wrappers=new WeakMap();
const flags=Object.freeze({sourceOnly:true,operational:false,completeReservation:false,nativeNetworkAckProof:false,productionDurabilityProved:false});
const reject=()=>{throw Error('BORROWED_PG17_PROOF_REFUSED');};
function physical(file,directory=false){if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file||file.split(path.sep).includes('.private'))reject();let current=path.parse(file).root;for(const p of file.split(path.sep).filter(Boolean)){current=path.join(current,p);const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||(current===file?(directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1):!stat.isDirectory()))reject();}if(fs.realpathSync(file)!==file)reject();}
function sources(root){physical(root,true);for(const [relative,pin] of Object.entries(SOURCE_PINS)){const f=path.join(root,relative);physical(f);const b=fs.readFileSync(f),sha=crypto.createHash('sha256').update(b).digest('hex'),blob=crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');if(b.length!==pin.bytes||sha!==pin.sha256||blob!==pin.gitBlobSha1)reject();}
 const helper=require(path.join(root,'tests/crm-mvp-controls-persistence/verify-context.cjs'));helper.verifyContext();
 // Original fourteen/contract are now verified. Never import identity references.
 return {B:require(path.join(root,'services/dashboard-operational/domain/crm-mvp-controls-persistence/store.cjs')),F:require(path.join(root,'tests/crm-mvp-controls-persistence/fixtures.cjs')),SQL:require(path.join(root,'services/dashboard-operational/domain/crm-mvp-controls-persistence/sql.cjs'))};}
function connected(c){return c&&typeof c==='object'&&typeof c.query==='function'&&c._connected===true&&c._queryable===true&&c._ending===false&&c.connection&&typeof c.connection==='object'&&Number.isSafeInteger(c.processID)&&c.processID>0&&!('totalCount' in c);}
function wrapper(c,SQL){if(wrappers.has(c))return wrappers.get(c);const state={before:null,after:null,counts:{insert:0,consume:0,finish:0,commits:0}},w={query:async(sql,params)=>{if(state.before)await state.before(sql);if(sql===SQL.INSERT)state.counts.insert++;if(sql===SQL.CONSUME)state.counts.consume++;if(sql===SQL.FINISH)state.counts.finish++;if(sql===SQL.COMMIT)state.counts.commits++;const result=await c.query(sql,params);return state.after?state.after(sql,result):result;}};const value={w,state};wrappers.set(c,value);return value;}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function expect(value){if(!value)reject();}
async function metadata(c){const v=await c.query(VERSION);expect(v?.command==='SHOW'&&v.rowCount===null&&Array.isArray(v.rows)&&v.rows.length===1&&typeof v.rows[0].server_version_num==='string'&&/^17[0-9]{4}$/.test(v.rows[0].server_version_num));const r=await c.query(SESSION);expect(r?.command==='SELECT'&&r.rowCount===1&&Array.isArray(r.rows)&&r.rows.length===1);const row=r.rows[0];expect(typeof row.database_name==='string'&&row.database_name.length>0&&Number.isSafeInteger(row.backend_pid)&&row.backend_pid===c.processID);return {version:Number(v.rows[0].server_version_num),database:row.database_name,pid:row.backend_pid};}
async function denied(p,code){let caught;try{await p;}catch(e){caught=e;}expect(caught?.code===code);}
async function run(input={}){
 let enabled=false,clients,admitTest,sourceDirectory,scenario;
 try{if(!input||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).some(k=>typeof k!=='string'||!['enabled','clients','admitTest','sourceDirectory','scenario'].includes(k)))reject();const d=Object.getOwnPropertyDescriptors(input);if(Object.values(d).some(x=>!x.enumerable||!Object.hasOwn(x,'value')))reject();({enabled=false,clients,admitTest,sourceDirectory,scenario}=input);}catch{return Object.freeze({code:'BORROWED_PG17_PROOF_REFUSED',executed:false,...flags});}

 if(enabled!==true)return Object.freeze({code:'BORROWED_PG17_PROOF_DISABLED',executed:false,...flags});
 let executed=false,hookConfigured=false;
 try{
  // Structural checks and private Root custody admission precede all SQL/imports.
  if(!Array.isArray(clients)||clients.length!==2)reject();
  const slots=[Object.getOwnPropertyDescriptor(clients,'0'),Object.getOwnPropertyDescriptor(clients,'1')];
  if(slots.some(d=>!d||d.enumerable!==true||!Object.hasOwn(d,'value')))reject();
  const values=slots.map(d=>d.value);
  if(values[0]===values[1]||values.some(c=>!connected(c)||used.has(c))||typeof admitTest!=='function'||typeof sourceDirectory!=='string'||!SCENARIOS.has(scenario))reject();
  const pair=Object.freeze(values);const admission=await admitTest(Object.freeze({clients:pair,scenario,sourceOnly:true}));
  if(!admission||Object.getPrototypeOf(admission)!==Object.prototype||Object.keys(admission).sort().join(',')!=='isolated,noExternalTransaction,reservedRowsReady,schemaInstalled'||admission.isolated!==true||admission.noExternalTransaction!==true||admission.schemaInstalled!==true||admission.reservedRowsReady!==true)reject();
  const {B,F,SQL}=sources(sourceDirectory);pair.forEach(c=>used.add(c));
  executed=true;const initial=await Promise.all(pair.map(metadata));expect(initial[0].database===initial[1].database&&initial[0].version===initial[1].version&&initial[0].pid!==initial[1].pid);
  const ws=pair.map(c=>wrapper(c,SQL)),stores=ws.map(x=>B.create(F.options(x.w)));let serializationConflicts=0;
  const i=F.identity(),registration=F.registration(i),outcome=(id)=>({...id,outcome:'accepted',expectedOperationRevision:2});
  async function stable(){const next=await Promise.all(pair.map(metadata));expect(next.every((x,n)=>same(x,initial[n])));}
  const result=[];
  if(scenario==='registration-race'){
   const race=await Promise.allSettled(stores.map(s=>s.registerOriginal(registration))),winners=race.flatMap((r,n)=>r.status==='fulfilled'?[n]:[]);expect(winners.length>=1);
   for(const r of race)if(r.status==='rejected'){expect(r.reason?.sqlstate==='40001');serializationConflicts++;}
   const winner=winners[0],receipt=await stores[winner].inspectOperation(i);expect(receipt.state==='registered'&&receipt.revision===1&&!receipt.reservationAttempted&&receipt.operationId===i.operationId&&receipt.attemptId===i.attemptId);
   expect(race.filter(r=>r.status==='fulfilled').every(r=>same(r.value,receipt)));const inserted=ws.reduce((n,x)=>n+x.state.counts.insert,0);expect(same(await stores[winner].registerOriginal(registration),receipt));expect(ws.reduce((n,x)=>n+x.state.counts.insert,0)===inserted);
   await denied(stores[winner].registerOriginal({...registration,principalRefHash:F.E}),'CRM_CONTROLS_VERIFICATION_REFUSED');
   for(let n=0;n<2;n++)if(race[n].status==='rejected')await denied(stores[n].inspectOperation(i),'CRM_CONTROLS_SESSION_UNAVAILABLE');
   result.push({id:'B1-PG-WIRE-03',phase:'registration-race',status:'passed',registrationRowsObserved:1,serializationConflicts});
  }else if(scenario==='consume-cas'){
   const original=await stores[0].registerOriginal(registration);expect(original.state==='registered'&&original.revision===1&&!original.reservationAttempted);
   const dto={...i,expectedOperationRevision:1},race=await Promise.allSettled(stores.map(s=>s.consumeReservationAttempt(dto))),winners=race.flatMap((r,n)=>r.status==='fulfilled'?[n]:[]);expect(winners.length>=1);
   for(const r of race)if(r.status==='rejected'){expect(r.reason?.sqlstate==='40001');serializationConflicts++;}
   const winner=winners[0],receipt=await stores[winner].inspectOperation(i);expect(receipt.revision===2&&receipt.reservationAttempted&&receipt.state==='registered'&&receipt.operationId===i.operationId&&receipt.attemptId===i.attemptId);
   expect(race.filter(r=>r.status==='fulfilled').every(r=>same(r.value,receipt)));const consumed=ws.reduce((n,x)=>n+x.state.counts.consume,0);expect(consumed>=1);expect(same(await stores[winner].consumeReservationAttempt(dto),receipt));expect(ws.reduce((n,x)=>n+x.state.counts.consume,0)===consumed);
   await denied(stores[winner].consumeReservationAttempt({...i,expectedOperationRevision:2}),'CRM_CONTROLS_CAS_REFUSED');
   await denied(stores[winner].consumeReservationAttempt({...i,attemptId:F.uuid(99),expectedOperationRevision:1}),'CRM_CONTROLS_DTO_REFUSED');
   for(let n=0;n<2;n++)if(race[n].status==='rejected')await denied(stores[n].inspectOperation(i),'CRM_CONTROLS_SESSION_UNAVAILABLE');
   result.push({id:'B1-PG-WIRE-03',phase:'consume-cas',status:'passed',consumedRevision:2,serializationConflicts});
  }else if(scenario==='brand-isolation'){
   const aristo=F.identity('aristo');await stores[0].registerOriginal(registration);await stores[1].registerOriginal({...F.registration(aristo),principalRefHash:F.E});
   const fish=await stores[1].inspectOperation(i),other=await stores[0].inspectOperation(aristo);expect(fish.brand==='fish'&&other.brand==='aristo'&&fish.operationId===other.operationId&&fish.principalRefHash===F.H&&other.principalRefHash===F.E);
   result.push({id:'B1-PG-WIRE-04',status:'passed',brands:2});
  }else{
   const id=F.identity('fish',scenario==='pending-hook'?61:62),prior=await stores[1].inspectOperation(id),model=F.reserved(id);expect(prior.state==='reserved'&&prior.revision===2&&prior.outcomeWriteState==='idle'&&prior.reservation===true&&same(prior.scope,model.scope)&&prior.reservedMemberCount===model.reservedMemberCount&&prior.reservedMembersHash===model.reservedMembersHash&&prior.capacityEvidenceHash===model.capacityEvidenceHash);
   if(scenario==='pending-hook'){
    hookConfigured=true;let begins=0;ws[0].state.before=async sql=>{if(sql===SQL.BEGIN_WRITE&&++begins===2)throw Object.assign(Error('synthetic test hook'),{code:'57014'});};
    await denied(stores[0].recordOutcome(outcome(id)),'CRM_CONTROLS_TRANSACTION_REFUSED');
    const pending=await stores[1].inspectOperation(id);expect(pending.state==='reserved'&&pending.outcomeWriteState==='pending'&&pending.revision===2&&same(pending.scope,prior.scope));
    await denied(stores[1].recordOutcome(outcome(id)),'CRM_CONTROLS_PENDING_CONSULT_ONLY');expect(ws.every(x=>x.state.counts.finish===0));
    result.push({id:'B1-PG-WIRE-05',status:'passed',syntheticFaultHook:true,pendingConsultOnly:true});
   }else{
    hookConfigured=true;let commits=0;ws[0].state.after=async(sql,r)=>sql===SQL.COMMIT&&++commits===2?{}:r;
    await denied(stores[0].recordOutcome(outcome(id)),'CRM_CONTROLS_ACK_UNKNOWN');const accepted=await stores[1].inspectOperation(id);expect(accepted.state==='accepted'&&accepted.revision===3&&accepted.outcomeWriteState==='idle'&&same(accepted.scope,prior.scope));
    const finished=ws.reduce((n,x)=>n+x.state.counts.finish,0);expect(finished===1);expect(same(await stores[1].recordOutcome(outcome(id)),accepted));expect(ws.reduce((n,x)=>n+x.state.counts.finish,0)===finished);
    result.push({id:'B1-PG-WIRE-06',status:'passed',syntheticFaultHook:true,confirmedRetryWrites:0});
   }
   await denied(stores[0].inspectOperation(id),'CRM_CONTROLS_SESSION_UNAVAILABLE');
  }
  await stable();result.unshift({id:'B1-PG-WIRE-02',status:'passed'});result.push({id:'B1-PG-WIRE-07',status:'passed',ownershipCalls:0});
  return Object.freeze({code:'BORROWED_PG17_SCENARIO_PASSED',executed:true,engineVersionNum:initial[0].version,runtimeVersion:process.version,twoDistinctStableSessions:true,scenarioResults:Object.freeze(result.map(Object.freeze)),syntheticFaultHooks:hookConfigured,...flags});
 }catch{return Object.freeze({code:'BORROWED_PG17_PROOF_REFUSED',executed,runtimeVersion:process.version,scenarioResults:Object.freeze([]),syntheticFaultHooks:hookConfigured,...flags});}
}
module.exports=Object.freeze({run});
