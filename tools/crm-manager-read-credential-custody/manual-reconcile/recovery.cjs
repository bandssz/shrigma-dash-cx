'use strict';
// Manual public observation/plan preparation only. OFF/import has no effects.
const PINS = Object.freeze({
 "driver.cjs": "1c6d854ef7c4d2dd5aa936818f2c3f00c243c2407cce8d3c1531c3de7aee4dfa",
 "functions-relay.js": "4bf3b307d6c679a8579555aebd7fc8c52b0ed5ce95f89b0d55ce988794cfd1cb",
 "provider-factory.cjs": "44f61646414a6d06abc60b6d654d240951e275750c54539afd8d92e158613d15",
 "public-readback.cjs": "ab923f265834d91ba8b74d0ce2db1311cd108774bea0c610a5c34e0ef00709d7",
 "stdio-bridge.cjs": "884253deda501e5654d0bb1527910e887eea853d61ae5ca4a0116b4c6b740dee",
 "stage-runner.cjs": "bd69cfc8d17a338ad22bf7706f3fdb4d919a2fb46dd71b00bc73a6e98ba3c105",
 "easypanel-adapter.cjs": "ee0b34b95e33773947667a13ce6b9464fd67d2053b8de41a74ebf06454c55aa7",
 "easypanel-plan.cjs": "b06d41b326d4e6afb4d87fe27e7c2c17a6d90228b6f7b5461fd8e99a08f1e8b5",
 "effect-fence.cjs": "d1722bb985d775557e35f3be7953e3776a0afc09a56b5a4fb9a8072242a325bb",
 "remote-operator.cjs": "c780d91c178dfe00ffdc9af7265211ceeb66e12d14a096b60895f306141d3df5",
 "operator.cjs": "b3a6972dc8d3ce9d30d95c717c703efd293592cc14222392968df61887fca1f0",
 "status-reader.cjs": "8e5659d2f3c718e326f5c8eae130b61e4f68c689ea2d4a9efaa0a0e6dd40e3ff",
 "public-postcondition.cjs": "661bcac5bb4a467bf7f7ce90b974a2294b37209b724e59bd6c7036bd57b666d1",
 "../crm-manager-read-activation-review/activation.cjs": "9a3459983b415661e2665e8c3f6de1ae4fa6aa712ae012ebd3344da09e180a83",
 "../crm-manager-read-activation-review/sources.cjs": "9c216b9e651c52e142babb3c069493b4f8329cdc0320eadef37be99bd13a1de8",
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
const ERROR='READ_MANUAL_RECONCILE_REFUSED';
function refuse(){throw Error(ERROR);}
function exact(q,keys){if(!q||Object.getPrototypeOf(q)!==Object.prototype||Reflect.ownKeys(q).length!==keys.length)refuse();for(const k of keys){const d=Object.getOwnPropertyDescriptor(q,k);if(!d?.enumerable||!Object.hasOwn(d,'value'))refuse();}}
const hash=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
const canonical=q=>Array.isArray(q)?'['+q.map(canonical).join(',')+']':q&&typeof q==='object'?'{'+Object.keys(q).sort().map(k=>JSON.stringify(k)+':'+canonical(q[k])).join(',')+'}':JSON.stringify(q);
function directory(p){const fs=require('node:fs'),path=require('node:path'),s=fs.lstatSync(p);if(typeof p!=='string'||path.resolve(p)!==p||fs.realpathSync(p)!==p||!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700)refuse();return s;}
function readPinned(file,digest,max=524288){
 const fs=require('node:fs'),path=require('node:path');if(typeof file!=='string'||path.resolve(file)!==file||! /^[a-f0-9]{64}$/.test(digest))refuse();directory(path.dirname(file));
 const first=fs.lstatSync(file),admit=s=>{if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o7777)!==0o600||s.size<1||s.size>max||s.dev!==first.dev||s.ino!==first.ino||s.size!==first.size||s.mtimeMs!==first.mtimeMs||s.ctimeMs!==first.ctimeMs)refuse();};admit(first);
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let b;try{admit(fs.fstatSync(fd));b=fs.readFileSync(fd);admit(fs.fstatSync(fd));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}admit(fs.lstatSync(file));if(b.length!==first.size||hash(b)!==digest)refuse();return b;
}
function json(b){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{refuse();}}
function retain(file,value,max=16384){
 const fs=require('node:fs'),path=require('node:path');if(!Number.isSafeInteger(max)||max<1||max>524288)refuse();directory(path.dirname(file));const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>max)refuse();
 const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const d=fs.openSync(path.dirname(file),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}readPinned(file,hash(bytes),max);return Object.freeze({file,sha256:hash(bytes),bytes:bytes.length});
}
function modules(runtimeDirectory){
 const fs=require('node:fs'),path=require('node:path');if(path.resolve(runtimeDirectory)!==runtimeDirectory||fs.realpathSync(runtimeDirectory)!==runtimeDirectory)refuse();
 for(const[n,h]of Object.entries(PINS)){const f=path.resolve(runtimeDirectory,n),s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||hash(fs.readFileSync(f))!==h)refuse();}
 const get=n=>require(path.resolve(runtimeDirectory,n));return{R:get('remote-operator.cjs'),O:get('operator.cjs'),E:get('easypanel-plan.cjs'),P:get('public-postcondition.cjs'),M:get('easypanel-adapter.cjs'),F:get('effect-fence.cjs'),B:get('stdio-bridge.cjs'),S:get('status-reader.cjs')};
}
function plans(c){
 exact(c,['runtimeDirectory','originalPlanFile','originalPlanSha256','observerSuffix','observerDomainId','reconcileSuffix','reconcileDomainId','projectCreatedAt']);
 const m=modules(c.runtimeDirectory),f=json(readPinned(c.originalPlanFile,c.originalPlanSha256));exact(f,['schema','stage','reconcile','planSha256']);if(f.schema!=='crm-manager-read-driver-plan-file-v1'||f.reconcile!==null)refuse();
 const stage=m.R.buildStagePlan(f.stage);if(stage.planSha256!==f.planSha256)refuse();
 const observer=m.R.buildReconcilePlan({stagePlan:stage,suffix:c.observerSuffix,domainId:c.observerDomainId}),reconcile=m.R.buildReconcilePlan({stagePlan:stage,suffix:c.reconcileSuffix,domainId:c.reconcileDomainId});
 if(observer.descriptor.serviceName===reconcile.descriptor.serviceName||observer.descriptor.domain.id===reconcile.descriptor.domain.id||typeof c.projectCreatedAt!=='string'||! /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.projectCreatedAt))refuse();
 return{...m,stage,observer,reconcile,original:f,config:c};
}
function unwrap(raw,procedure,required=true){if(!raw||raw.isError===true)refuse();let q=raw.structuredContent;if(q===undefined){if(!Array.isArray(raw.content)||raw.content.length!==1||raw.content[0]?.type!=='text'||typeof raw.content[0].text!=='string'||Buffer.byteLength(raw.content[0].text)>524288)refuse();q=json(Buffer.from(raw.content[0].text));}if(!q||q.procedure!==procedure||required&&!Object.hasOwn(q,'result'))refuse();return q.result;}
function quiescence(q,p){exact(q,['schema','planSha256','serviceDisabled','envEmpty','runningContainers','testDomainAbsent','volumesNotDeletedByOperator','allContainersInspected']);if(q.schema!=='crm-manager-read-mcp-quiescence-v1'||q.planSha256!==p.planSha256||q.serviceDisabled!==true||q.envEmpty!==true||q.runningContainers!==0||q.testDomainAbsent!==true||q.volumesNotDeletedByOperator!==true||q.allContainersInspected!==false)refuse();return Object.freeze({...q});}
// Native query values projected by the fixed functions controller, not booleans.
function nativeSnapshot(q,x,now,observerMustBeAbsent=true){
 exact(q,['schema','startedAt','finishedAt','project','domains','capacity']);if(q.schema!=='crm-manager-read-manual-native-snapshot-v1'||!Number.isSafeInteger(q.startedAt)||!Number.isSafeInteger(q.finishedAt)||q.finishedAt<q.startedAt||now<q.finishedAt||now>=q.startedAt+10000)refuse();
 exact(q.project,['name','createdAt','serviceNames']);if(q.project.name!==x.stage.descriptor.projectName||q.project.createdAt!==x.config.projectCreatedAt||!Array.isArray(q.project.serviceNames)||q.project.serviceNames.length>64||q.project.serviceNames.some(n=>typeof n!=='string'||! /^[a-z0-9][a-z0-9-]{0,63}$/.test(n))||new Set(q.project.serviceNames).size!==q.project.serviceNames.length)refuse();
 for(const p of[...(observerMustBeAbsent?[x.observer]:[]),x.reconcile]){if(q.project.serviceNames.includes(p.descriptor.serviceName))refuse();}
 if(!Array.isArray(q.domains)||q.domains.length>2048)refuse();for(const d of q.domains){exact(d,['id','host']);if(typeof d.id!=='string'||d.id.length<1||d.id.length>128||typeof d.host!=='string'||d.host.length<1||d.host.length>253)refuse();for(const p of[x.observer,x.reconcile])if(d.id===p.descriptor.domain.id||d.host.toLowerCase().replace(/\.$/,'')===p.descriptor.domain.host)refuse();}
 exact(q.capacity,['freeMemMb','cpuCount','cpuUsedPercentage','freeDiskGb']);const a=q.capacity;if(!Number.isFinite(a.freeMemMb)||a.freeMemMb<2200||!Number.isFinite(a.cpuCount)||a.cpuCount<1||!Number.isFinite(a.cpuUsedPercentage)||a.cpuUsedPercentage<0||a.cpuUsedPercentage>100||a.cpuCount*(1-a.cpuUsedPercentage/100)<1||typeof a.freeDiskGb!=='string'||! /^(0|[1-9]\d*)(\.\d+)?$/.test(a.freeDiskGb)||!Number.isFinite(Number(a.freeDiskGb))||Number(a.freeDiskGb)<4.3)refuse();return true;
}
function observerScopes(x){
 const a=x.E.buildEasypanelInputs({remotePlan:x.observer}),p=x.E.buildEasypanelInputs({remotePlan:x.stage}),steps=[p.inspect,p.inspectRunning,p.inspectDomains,a.inspect,a.inspectRunning,a.inspectDomains,a.inspectDomainCollision,p.stop,p.clearEnvironment,p.deleteTestDomain,a.createPublicBootstrap,a.updatePublicProbe,a.createTestDomain,a.deployOnce,a.stop,a.clearEnvironment,a.deleteTestDomain];
 return{steps,queries:steps.filter(s=>s.executor==='execute_query').map(s=>({procedure:s.procedure,input:s.input})),mutations:steps.filter(s=>s.executor!=='execute_query').map(s=>({procedure:s.procedure,input:s.input})),observer:a,prior:p};
}
function createObserver(config={enabled:false},deps){
 exact(config,config?.enabled===true?['enabled','approved','plan','directory','custodyDirectory','privateKeyFile','snapshotFile','snapshotSha256']:['enabled']);if(typeof config.enabled!=='boolean')refuse();if(!config.enabled)return Object.freeze({run:async()=>({schema:'crm-manager-read-manual-observation-result-v1',state:'disabled',postgresConnected:false})});if(config.approved!==true)refuse();
 exact(deps,['execute','observeStatus',...(Object.hasOwn(deps,'now')?['now']:[])]);if(typeof deps.execute!=='function'||typeof deps.observeStatus!=='function')refuse();const now=deps.now||Date.now,x=plans(config.plan),s=observerScopes(x),fs=require('node:fs'),path=require('node:path');directory(config.directory);
 const key=x.O.loadPrivateKey(config.privateKeyFile);x.O.openExisting({directory:config.custodyDirectory,intent:x.stage.intent,privateKey:key});
 const fence=x.F.openEffectFence({directory:path.join(config.directory,'effects')}),frames=new WeakSet();let started=false,closed=false;
 const materialize=f=>{if(frames.has(f))return Object.freeze({procedure:f.procedure,input:f.input});return x.M.mcpArguments(f);};
 const bounded=fn=>new Promise((resolve,reject)=>{let done=false;const t=setTimeout(()=>{if(done)return;done=true;closed=true;reject(Error(ERROR));},40000);Promise.resolve().then(()=>{if(closed)refuse();return fn();}).then(v=>{if(!done){done=true;clearTimeout(t);resolve(v);}},()=>{if(!done){done=true;clearTimeout(t);closed=true;reject(Error(ERROR));}});});
 const execute=f=>bounded(()=>{x.O.openExisting({directory:config.custodyDirectory,intent:x.stage.intent,privateKey:key});return deps.execute(f,materialize);});
 const adapter=x.M.createEasypanelAdapter({enabled:true,stageApproved:false,readonlyReconcileApproved:true},{execute,fence:(p,a)=>fence.fence(p,a),admitCapacity:()=>refuse(),getAdminPassword:()=>refuse(),observeStatus:()=>refuse(),custody:{directory:config.custodyDirectory,privateKey:key}});
 async function direct(step,action){if(closed)refuse();fence.fence(x.observer,action);const f=Object.freeze({executor:step.executor,procedure:step.procedure,input:step.input});frames.add(f);return unwrap(await execute(f),step.procedure,false);}
 async function inspect(){const f=Object.freeze({executor:s.observer.inspect.executor,procedure:s.observer.inspect.procedure,input:s.observer.inspect.input});frames.add(f);const r=unwrap(await execute(f),f.procedure);if(r?.projectName!==x.observer.descriptor.projectName||r.name!==x.observer.descriptor.serviceName||r.type!=='compose'||r.enabled!==true||r.createDotEnv!==true||r.env!==''||r.source?.type!=='inline'||typeof r.source.content!=='string')refuse();return hash(r.source.content);}
 async function contain(p,prior=false){const c=prior?{fencePlan:x.observer,prefix:'prior-'}:undefined;await adapter.stop(p,c);await adapter.clearPrivate(p,c);return quiescence(await adapter.inspectStopped(p),p);}
 async function run(){
  if(started)refuse();started=true;let attempted=false,projection=null,prior=null,cleanup=null,observedAt=null;
  try{
   nativeSnapshot(json(readPinned(config.snapshotFile,config.snapshotSha256,16384)),x,now());
   // The same capsule is reopened by M before every native callback.
   prior=await contain(x.stage,true);
   attempted=true;await direct(s.observer.createPublicBootstrap,'create-public-bootstrap');if(await inspect()!==s.observer.bootstrapContentSha256)refuse();
   await direct(s.observer.updatePublicProbe,'update-public-probe');if(await inspect()!==s.observer.publicProbeContentSha256)refuse();
   await direct(s.observer.createTestDomain,'create-domain');await direct(s.observer.deployOnce,'deploy-public-probe');
   const q={schema:'crm-manager-read-public-postcondition-request-v1',planSha256:x.observer.planSha256,url:'https://'+x.observer.descriptor.domain.host+'/status',method:'GET',maxBytes:4096,timeoutMs:35000};
   projection=x.P.acceptPostcondition(await bounded(()=>deps.observeStatus(q)),x.observer);observedAt=now();retain(path.join(config.directory,'original-volume-postcondition.json'),projection);
  }catch{}
  if(attempted&&!closed){try{cleanup=await contain(x.observer);}catch{}}
  if(!projection||!prior||!cleanup||closed)return Object.freeze({schema:'crm-manager-read-manual-observation-result-v1',state:'outcome_unknown',postgresConnected:false,originalIntentPreserved:true,noAutomaticRetry:true});
  const evidence={schema:'crm-manager-read-original-observation-v1',originalPlanSha256:x.stage.planSha256,observerPlanSha256:x.observer.planSha256,reconcilePlanSha256:x.reconcile.planSha256,intent:x.stage.intent,sourceVolume:x.stage.descriptor.compose.volumes.source.name,ledgerVolume:x.stage.descriptor.compose.volumes.ledger.name,projection,priorQuiescence:prior,observerQuiescence:cleanup,observedAt,completedAt:now(),postgresConnected:false};
  const retained=retain(path.join(config.directory,'original-observation.json'),evidence);return Object.freeze({schema:'crm-manager-read-manual-observation-result-v1',state:'observed',postgresConnected:false,originalIntentPreserved:true,observerCleanupVerified:true,evidence:retained});
 }
 return Object.freeze({run,materialize,scope:observerScopes(x)});
}
function admission(e,snapshot,x,now){
 exact(e,['schema','originalPlanSha256','observerPlanSha256','reconcilePlanSha256','intent','sourceVolume','ledgerVolume','projection','priorQuiescence','observerQuiescence','observedAt','completedAt','postgresConnected']);
 if(e.schema!=='crm-manager-read-original-observation-v1'||e.originalPlanSha256!==x.stage.planSha256||e.observerPlanSha256!==x.observer.planSha256||e.reconcilePlanSha256!==x.reconcile.planSha256||canonical(e.intent)!==canonical(x.stage.intent)||e.sourceVolume!==x.stage.descriptor.compose.volumes.source.name||e.ledgerVolume!==x.stage.descriptor.compose.volumes.ledger.name||e.postgresConnected!==false||!Number.isSafeInteger(e.observedAt)||!Number.isSafeInteger(e.completedAt)||e.completedAt<e.observedAt||now<e.completedAt||now-e.observedAt>600000)refuse();
 x.P.acceptPostcondition(JSON.stringify(e.projection),x.observer);quiescence(e.priorQuiescence,x.stage);quiescence(e.observerQuiescence,x.observer);nativeSnapshot(snapshot,x,now,false);
 const r={schema:'crm-manager-read-remote-admission-v1',planSha256:x.reconcile.planSha256,capacityVerified:true,targetAbsent:true,domainAbsent:true,imagePinned:true,nineSourcesPinned:true,newVolumesAbsent:false,existingSourceVerified:true,existingLedgerVerified:true,priorQuiescent:true};x.R.assertRemoteAdmission(r,x.reconcile);return Object.freeze(r);
}
module.exports=Object.freeze({plans,modules,readPinned,retain,hash,canonical,json,observerScopes,nativeSnapshot,quiescence,createObserver,admission,PINS});
