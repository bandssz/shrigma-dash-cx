'use strict';
// Public configured provider only; OFF/import opens no file, socket, env or credential.
// A pinned CLI source embeds this configuration and exports only createProviders.
const CONFIG = Object.freeze({enabled:false});
const MODULE_PINS = Object.freeze({
  "remote-operator.cjs": "c780d91c178dfe00ffdc9af7265211ceeb66e12d14a096b60895f306141d3df5",
  "operator.cjs": "b3a6972dc8d3ce9d30d95c717c703efd293592cc14222392968df61887fca1f0",
  "status-reader.cjs": "8e5659d2f3c718e326f5c8eae130b61e4f68c689ea2d4a9efaa0a0e6dd40e3ff",
  "public-postcondition.cjs": "661bcac5bb4a467bf7f7ce90b974a2294b37209b724e59bd6c7036bd57b666d1",
  "../crm-manager-read-activation-review/compose/build-compose.cjs": "0be6f7b41433eab086a4a9f1fb5bf4e49cc611f9d257d7c9dfc27067571a00ea",
  "../crm-manager-read-activation-review/runtime/activation.cjs": "9a3459983b415661e2665e8c3f6de1ae4fa6aa712ae012ebd3344da09e180a83",
  "../crm-manager-read-activation-review/runtime/sources.cjs": "9c216b9e651c52e142babb3c069493b4f8329cdc0320eadef37be99bd13a1de8",
  "../crm-manager-read-activation-review/runtime/runtime.cjs": "0fde24c3837f50847f7ec282427318389d83e6ce3321a98b4ef6679b30751331",
  "../crm-manager-read-activation-review/runtime/journal.cjs": "bbd69749e555c850fc620bf60aa9f6f226668511e1ee9b9aca7a482d852f7466",
  "../crm-manager-read-activation-review/runtime/cli.cjs": "abeb28eacbf4daf6692becb5c4caeefaad5bd32d2c42be97dd04cb026e5143c9",
  "../crm-manager-read-activation-review/runtime/read-proof.cjs": "4404e1ccd52cda9a9dccf6bdc648178f06659a5b9bc1ea64bc6fbe8652b52e65",
  "../crm-manager-read-activation-review/runtime/source-pins.cjs": "e4c9171752be502cc1101bb0e5edd055901d58d0402b7e24a8da59e3ef645d72",
  "../crm-manager-read-activation-review/runtime/supervisor.cjs": "b48c0ea980c23f2b343383e7fbfe0392707b8418a3005e4fec694bcfaacb87b0",
  "../crm-manager-read-activation-review/runtime/health.cjs": "d6a058b1beadb3b6ea24a154f6d9238ad90ad017906a4de51fcbdaa8e01462ed"
});
const ERROR='READ_PINNED_PROVIDER_REFUSED',BIND='crm-manager-read-driver-scope-binding-v1';
function refuse(){throw Error(ERROR);}
function exact(v,keys,hidden=[]){
 if(!v||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length)refuse();
 for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=='string'||!keys.includes(k)||!Object.hasOwn(d,'value')||d.enumerable===hidden.includes(k))refuse();}
}
function canonical(v){return Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);}
function hash(b){return require('node:crypto').createHash('sha256').update(b).digest('hex');}
function digest(s){if(typeof s!=='string'||!/^[a-f0-9]{64}$/.test(s))refuse();}
function configCheck(c){
 const on=Object.getOwnPropertyDescriptor(c||{},'enabled')?.value;
 exact(c,on===true?['enabled','mode','runtimeDirectory','planFile','planFileSha256','evidenceFile','evidenceSha256','binding','vectors']:['enabled']);
 if(typeof c.enabled!=='boolean')refuse();if(!c.enabled)return false;
 if(c.mode!=='execute')refuse();
 for(const k of ['runtimeDirectory','planFile','evidenceFile'])if(typeof c[k]!=='string'||!c[k].startsWith('/')||c[k].includes('\0'))refuse();
 for(const k of ['planFileSha256','evidenceSha256'])digest(c[k]);
 exact(c.binding,['schema','planSha256','mode','scopesSha256']);if(c.binding.schema!==BIND||c.binding.mode!==c.mode)refuse();digest(c.binding.planSha256);digest(c.binding.scopesSha256);
 exact(c.vectors,['queries','mutations']);if(!Array.isArray(c.vectors.queries)||c.vectors.queries.length!==4||!Array.isArray(c.vectors.mutations)||c.vectors.mutations.length!==10)refuse();
 for(const v of [...c.vectors.queries,...c.vectors.mutations])digest(v);
 return true;
}
function readPinned(file,digestValue,max){
 const fs=require('node:fs'),path=require('node:path');digest(digestValue);
 if(path.resolve(file)!==file)refuse();const dir=path.dirname(file),ds=fs.lstatSync(dir);
 if(!ds.isDirectory()||ds.isSymbolicLink()||ds.uid!==process.getuid()||(ds.mode&0o7777)!==0o700||fs.realpathSync(dir)!==dir)refuse();
 const before=fs.lstatSync(file),same=s=>{if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o7777)!==0o600||s.size<1||s.size>max||s.dev!==before.dev||s.ino!==before.ino||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs)refuse();};same(before);
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let b;
 try{same(fs.fstatSync(fd));b=fs.readFileSync(fd);same(fs.fstatSync(fd));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 same(fs.lstatSync(file));if(b.length!==before.size||hash(b)!==digestValue)refuse();return b;
}
function json(b){if(b[0]===0xef&&b[1]===0xbb&&b[2]===0xbf)refuse();try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{refuse();}}
function moduleCheck(directory){
 const fs=require('node:fs'),path=require('node:path');
 if(path.resolve(directory)!==directory||fs.realpathSync(directory)!==directory)refuse();
 for(const [name,pin]of Object.entries(MODULE_PINS)){const file=path.resolve(directory,name),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||hash(fs.readFileSync(file))!==pin)refuse();}
}
function utc(s){
 if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(s))refuse();const n=Date.parse(s);if(!Number.isSafeInteger(n)||new Date(n).toISOString()!==s)refuse();return n;
}
function collectionUtc(s){if(typeof s!=='string'||!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/.test(s))refuse();return utc(s.replace(' ','T').replace(' UTC','.000Z'));}
function evidenceCheck(e,c,p,C,R,now){
 exact(e,['schema','observed','pins','ciEvidence','receipt','ttlMilliseconds','receiptValidFromUtc','receiptExpiresAtUtc','authorizeStage','externalScopesBound','stageReady','expiredReceiptsMustBeRefused','automaticRefreshOrRetry','realVolumeInventoryObserved','actualStageCalls']);
 if(e.schema!=='crm-manager-read-prelaunch-evidence-v1'||e.ttlMilliseconds!==10000||e.expiredReceiptsMustBeRefused!==true||e.actualStageCalls!==0||['authorizeStage','externalScopesBound','stageReady','automaticRefreshOrRetry','realVolumeInventoryObserved'].some(k=>e[k]!==false))refuse();
 const o=e.observed;
 exact(o,['schema','collectionStartedUtc','collectionFinishedUtc','planFileSha256','planSha256','projectName','expectedCreatedAt','serviceName','host','domainId','projectMatches','createdAtMatches','servicesCount','targetAbsentAtSampling','domainInventoryValidated','domainsCount','hostAbsentAtSampling','domainIdAbsentAtSampling','capacity','receiptIssued','stageAuthorized','stageReady','mutationCallsByThisAgent','postgresCalls','rawConfigOrMetricsPublished']);
 if(o.schema!=='crm-manager-read-plan-admission-observation-v1'||o.planFileSha256!==c.planFileSha256||o.planSha256!==p.planSha256||o.projectName!==p.descriptor.projectName||o.serviceName!==p.descriptor.serviceName||o.host!==p.descriptor.domain.host||o.domainId!==p.descriptor.domain.id||o.expectedCreatedAt!=='2026-10-04T01:52:49.260Z'||o.servicesCount!==0||!Number.isSafeInteger(o.domainsCount)||o.domainsCount<0||o.domainsCount>100000)refuse();
 for(const k of ['projectMatches','createdAtMatches','targetAbsentAtSampling','domainInventoryValidated','hostAbsentAtSampling','domainIdAbsentAtSampling'])if(o[k]!==true)refuse();
 for(const k of ['receiptIssued','stageAuthorized','stageReady','rawConfigOrMetricsPublished'])if(o[k]!==false)refuse();
 if(o.mutationCallsByThisAgent!==0||o.postgresCalls!==0)refuse();
 const a=o.capacity;exact(a,['procedure','minimumFreeMemMb','minimumCpuHeadroom','minimumFreeDiskGb','memoryPassed','cpuPassed','diskPassed','unitsConservativelyBounded','snapshotOnly','reservationClaimed']);
 if(a.procedure!=='getLegacyMonitorSystemStats'||a.minimumFreeMemMb!==2200||a.minimumCpuHeadroom!==1||a.minimumFreeDiskGb!==4.3||a.reservationClaimed!==false||['memoryPassed','cpuPassed','diskPassed','unitsConservativelyBounded','snapshotOnly'].some(k=>a[k]!==true))refuse();
 const pins=e.pins;exact(pins,['schema','planFileSha256','planSha256','planMatches','projectName','serviceName','host','domainId','sourceEntries','image','rSourceSha256','cSourceSha256','imageAdmissionGuardSha256','freshVolumeNamespaceVerified','sourceInputsArePublic','postgresConnected']);
 if(pins.schema!=='crm-manager-read-public-plan-binding-proof-v1'||pins.planFileSha256!==c.planFileSha256||pins.planSha256!==p.planSha256||pins.projectName!==p.descriptor.projectName||pins.serviceName!==p.descriptor.serviceName||pins.host!==p.descriptor.domain.host||pins.domainId!==p.descriptor.domain.id||pins.image!==C.IMAGE||pins.rSourceSha256!==MODULE_PINS['remote-operator.cjs']||pins.cSourceSha256!==MODULE_PINS['../crm-manager-read-activation-review/compose/build-compose.cjs']||pins.imageAdmissionGuardSha256!=='d4936fc711ef8b1d3155ad415f4e38fc9d216dc7195f71d380870eda37a61fcd'||['planMatches','freshVolumeNamespaceVerified','sourceInputsArePublic'].some(k=>pins[k]!==true)||pins.postgresConnected!==false)refuse();
 if(!Array.isArray(pins.sourceEntries)||pins.sourceEntries.length!==Object.keys(C.PINS).length)refuse();
 pins.sourceEntries.forEach((v,i)=>{exact(v,['name','sha256','matches']);const name=Object.keys(C.PINS)[i];if(v.name!==name||v.sha256!==C.PINS[name]||v.matches!==true)refuse();});
 const ci=e.ciEvidence;exact(ci,['candidateSource','validationJobs','publishersSkipped','successReportedByRoot','independentlyFetchedByThisAgent','imageAdmissionUsesPinned5caAndNoUnknownVolumes']);
 if(typeof ci.candidateSource!=='string'||!/^[a-f0-9]{40}$/.test(ci.candidateSource)||ci.validationJobs!==12||ci.publishersSkipped!==3||ci.successReportedByRoot!==true||ci.independentlyFetchedByThisAgent!==false||ci.imageAdmissionUsesPinned5caAndNoUnknownVolumes!==true)refuse();
 const start=utc(e.receiptValidFromUtc),end=utc(e.receiptExpiresAtUtc),oldest=collectionUtc(o.collectionStartedUtc),finished=collectionUtc(o.collectionFinishedUtc);
 if(start!==oldest||end-start!==10000||finished<start||finished>=end||!Number.isSafeInteger(now)||now<finished||now>=end)refuse();
 if(Object.getOwnPropertyDescriptor(e.receipt||{},'schema')?.value!=='crm-manager-read-remote-admission-v2')refuse();
 R.assertFreshVolumeNamespace(p);R.assertRemoteAdmission(e.receipt,p);
 return Object.freeze({...e.receipt});
}
function createProviders(config=CONFIG,deps={}){
 if(!configCheck(config))return Object.freeze({bindScopes:()=>refuse(),admission:()=>refuse(),observeStatus:()=>refuse()});
 exact(deps,['now','transport'].filter(k=>Object.hasOwn(deps,k)));
 const now=deps.now===undefined?Date.now:deps.now;if(typeof now!=='function')refuse();
 // Snapshot public configuration; no first-seen scope or mutable caller binding.
 const c=JSON.parse(JSON.stringify(config));moduleCheck(c.runtimeDirectory);
 const path=require('node:path'),R=require(path.join(c.runtimeDirectory,'remote-operator.cjs')),C=require(path.join(c.runtimeDirectory,'../crm-manager-read-activation-review/compose/build-compose.cjs')),S=require(path.join(c.runtimeDirectory,'status-reader.cjs'));
 moduleCheck(c.runtimeDirectory);
 const f=json(readPinned(c.planFile,c.planFileSha256,524288));exact(f,['schema','stage','reconcile','planSha256']);
 if(f.schema!=='crm-manager-read-driver-plan-file-v1'||f.reconcile!==null||f.stage?.isolatedProject!==true)refuse();
 const p=R.buildStagePlan(f.stage);if(p.planSha256!==f.planSha256||p.planSha256!==c.binding.planSha256||p.descriptor.projectName!=='crm-manager-stage-20261004')refuse();
 const status=S.createStatusReader({enabled:true,plan:p},deps.transport);let bound=false;
 function bindScopes(q){
  if(bound)refuse();exact(q,['schema','planSha256','mode','scopesSha256','allowedQueries','allowedMutations'],['allowedQueries','allowedMutations']);
  for(const k of Object.keys(c.binding))if(q[k]!==c.binding[k])refuse();
  for(const [key,vector]of [['allowedQueries',c.vectors.queries],['allowedMutations',c.vectors.mutations]])if(!Array.isArray(q[key])||q[key].length!==vector.length||q[key].some((v,i)=>hash(canonical(v))!==vector[i]))refuse();
  if(hash(canonical({queries:q.allowedQueries,mutations:q.allowedMutations}))!==c.binding.scopesSha256)refuse();
  bound=true;return Object.freeze({...c.binding});
 }
 function admission(q){
  if(!bound)refuse();exact(q,['schema','planSha256','mode']);if(q.schema!=='crm-manager-read-stage-admission-request-v1'||q.planSha256!==p.planSha256||q.mode!=='execute')refuse();
  const e=json(readPinned(c.evidenceFile,c.evidenceSha256,16384));return evidenceCheck(e,c,p,C,R,now());
 }
 async function observeStatus(q){if(!bound)refuse();return status.observe(q);}
 return Object.freeze({bindScopes,admission,observeStatus});
}
function buildCliSource(config){
 configCheck(config);
 const fs=require('node:fs'),vm=require('node:vm');
 // This renders the SAME implementation plus literal public configuration.
 // Its resulting SHA must be installed into the existing driver CLI invocation.
 const source=fs.readFileSync(__filename,'utf8').trimEnd(),marker='const CONFIG = Object.freeze({enabled:false});',tail='module.exports=Object.freeze({createProviders,buildCliSource});';
 if(!source.includes(marker)||!source.endsWith(tail))refuse();
 const rendered=source.slice(0,-tail.length).replace(marker,'const CONFIG = Object.freeze('+JSON.stringify(config)+');')+'module.exports=Object.freeze({createProviders});';
 new vm.Script(rendered);return rendered+'\n';
}
module.exports=Object.freeze({createProviders,buildCliSource});
