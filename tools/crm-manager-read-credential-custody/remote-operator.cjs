'use strict';
// Inert operator/MCP-side proposal. No connector, environment, timer, SQL or
// credential is opened on import. Actual adapters require a separate review.
const crypto=require('node:crypto');
const O=require('./operator.cjs'),C=require('../crm-manager-read-activation-review/compose/build-compose.cjs');
const {acceptProof}=require('../crm-manager-read-activation-review/runtime/read-proof.cjs');
const PLAN='crm-manager-read-remote-plan-v1',RESULT='crm-manager-read-remote-result-v1';
const branded=new WeakSet();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function admitDomainId(id,intent,previous){if(typeof id!=='string'||!UUID.test(id)||id===intent.operationId||id===intent.credentialIntentId||id===previous)refuse();}
function refuse(){throw Error('READ_REMOTE_OPERATOR_REFUSED');}
function exact(v,keys){if(!v||Object.getPrototypeOf(v)!==Object.prototype)refuse();const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))refuse();for(const k of own){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||d.enumerable!==true||!Object.hasOwn(d,'value'))refuse();}}
function canonical(v){return Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);}
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const VOLUME_TAG='crm-manager-read-fresh-volume-namespace-v1';
function volumeNamespace(intent){O.binding(intent);return sha(VOLUME_TAG+'\0'+intent.operationId+'\0'+intent.credentialIntentId).slice(0,32);}
function assertFreshVolumeNamespace(p){
 if(!p||p.mode!=='execute'||p.parentStage!==null)refuse();const ns=volumeNamespace(p.intent),v=p.descriptor?.compose?.volumes;
 if(!v||v.source?.name!=='shrigma-read-source-'+ns||v.ledger?.name!=='shrigma-read-stage-'+ns||v.source.external===true||v.ledger.external===true)refuse();return true;
}
function frozen(v){if(v&&typeof v==='object'){for(const value of Object.values(v))frozen(value);Object.freeze(v);}return v;}
const clone=v=>JSON.parse(JSON.stringify(v));
function makePlan(body){const p=frozen({...body,planSha256:sha(canonical(body))});branded.add(p);return p;}
function admitPlan(p,mode){if(!branded.has(p)||p.schema!==PLAN||p.mode!==mode)refuse();return p;}
function buildStagePlan(input){
 exact(input,['suffix','sources','intent','domainId']);O.binding(input.intent);admitDomainId(input.domainId,input.intent);
 exact(input.sources,Object.keys(C.PINS));
 const intent=frozen({...input.intent}),sources=frozen({...input.sources}),descriptor=C.buildCompose({suffix:input.suffix,sources,volumeNamespace:volumeNamespace(intent)});descriptor.domain={...descriptor.domain,id:input.domainId,certificateResolver:'',path:'/',wildcard:false,middlewares:[],internalProtocol:'http'};
 return makePlan({schema:PLAN,mode:'execute',intent,descriptor,parentStage:null});
}
function buildReconcilePlan(input){
 exact(input,['suffix','stagePlan','domainId']);const stage=admitPlan(input.stagePlan,'execute');O.binding(stage.intent);admitDomainId(input.domainId,stage.intent,stage.descriptor.domain.id);
 if(typeof input.suffix!=='string'||!/^[a-f0-9]{12}$/.test(input.suffix)||input.suffix===stage.descriptor.serviceName.slice(-12))refuse();
 const serviceName='mgr-rec-'+input.suffix,aliases=[C.PROJECT+'_'+serviceName+'-gateway',C.PROJECT+'_'+serviceName+'_gateway'];if(aliases.some(a=>Buffer.byteLength(a)>63))refuse();
 const gateway=clone(stage.descriptor.compose.services.gateway);delete gateway.depends_on;
 gateway.networks={easypanel:{aliases}};gateway.labels={'com.shrigma.read-runtime-plan':input.suffix,'com.shrigma.read-runtime-purpose':'read-reconcile-isolated-review','com.shrigma.read-runtime-parent':stage.descriptor.serviceName.slice(-12)};
 const descriptor={schema:'shrigma-read-runtime-reconcile-compose-proposal-v1',inertProposal:true,deployability:'prepared_not_deployed',projectName:C.PROJECT,serviceName,env:'',createDotEnv:true,image:C.IMAGE,sourcePins:C.PINS,domain:{id:input.domainId,certificateResolver:'',host:serviceName+'.tazdb8.easypanel.host',https:true,path:'/',wildcard:false,middlewares:[],internalProtocol:'http',port:8099,composeService:'gateway',readOnlyStatusPath:'/status'},compose:{services:{gateway},volumes:{source:{external:true,name:stage.descriptor.compose.volumes.source.name},ledger:{external:true,name:stage.descriptor.compose.volumes.ledger.name}},networks:{easypanel:{external:true,name:'easypanel'}}},limitations:{deployApproved:false,mutationActionsApproved:[],privateEnvConfigured:false,priorQuiescenceRequired:true,existingLedgerReused:true,initializerIncluded:false,sharedNetworkIsFullIsolation:false}};
 return makePlan({schema:PLAN,mode:'reconcile',intent:stage.intent,descriptor,parentStage:stage});
}
function publicResult(mode,state,cleanupVerified=false,proof=null){return frozen({schema:RESULT,mode,state,cleanupVerified,proof});}
function effect(v,p,action){exact(v,['schema','planSha256','action','accepted','projectName','serviceName','ownedExact']);if(v.schema!=='crm-manager-read-remote-effect-v1'||v.planSha256!==p.planSha256||v.action!==action||v.accepted!==true||v.projectName!==p.descriptor.projectName||v.serviceName!==p.descriptor.serviceName||v.ownedExact!==true)refuse();}
function quiescence(v,p){exact(v,['schema','planSha256','serviceDisabled','envEmpty','runningContainers','testDomainAbsent','volumesNotDeletedByOperator','allContainersInspected']);if(v.schema!=='crm-manager-read-mcp-quiescence-v1'||v.planSha256!==p.planSha256||v.serviceDisabled!==true||v.envEmpty!==true||v.runningContainers!==0||v.testDomainAbsent!==true||v.volumesNotDeletedByOperator!==true||v.allContainersInspected!==false)refuse();}
function admission(v,p){
 admitPlan(p,p.mode);const schema=Object.getOwnPropertyDescriptor(v||{},'schema'),v2=schema&&Object.hasOwn(schema,'value')&&schema.value==='crm-manager-read-remote-admission-v2';
 exact(v,['schema','planSha256','capacityVerified','targetAbsent','domainAbsent','imagePinned','nineSourcesPinned','newVolumesAbsent','existingSourceVerified','existingLedgerVerified','priorQuiescent',...(v2?['volumeExistence','freshVolumeNamespaceVerified']:[])]);
 if(!['crm-manager-read-remote-admission-v1','crm-manager-read-remote-admission-v2'].includes(v.schema)||v.planSha256!==p.planSha256||['capacityVerified','targetAbsent','domainAbsent','imagePinned','nineSourcesPinned'].some(k=>v[k]!==true))refuse();
 if(v2){
  // This is a fresh-name policy, never a claim that global volumes were listed.
  assertFreshVolumeNamespace(p);if(v.newVolumesAbsent!==false||v.volumeExistence!=='unobserved'||v.freshVolumeNamespaceVerified!==true||v.existingSourceVerified!==false||v.existingLedgerVerified!==false||v.priorQuiescent!==false)refuse();
 }else if(p.mode==='execute'?(v.newVolumesAbsent!==true||v.existingSourceVerified!==false||v.existingLedgerVerified!==false||v.priorQuiescent!==false):(v.newVolumesAbsent!==false||v.existingSourceVerified!==true||v.existingLedgerVerified!==true||v.priorQuiescent!==true))refuse();
 return true;
}
function status(v){
 exact(v,['schema','action','state','childExitConfirmed','proofBarrierConfirmed','proof']);
 if(v.schema!=='crm-manager-read-supervisor-v1'||v.action!=='stage'||!['pending','verified','outcome_unknown','proof_refused'].includes(v.state)||typeof v.childExitConfirmed!=='boolean'||typeof v.proofBarrierConfirmed!=='boolean')refuse();
 if(v.state==='verified'){if(!v.childExitConfirmed||!v.proofBarrierConfirmed)refuse();exact(v.proof,['schema','action','state','phase','coreVerified','credentialBound','commitAck']);return frozen({...v,proof:acceptProof(JSON.stringify({...v.proof}),'stage')});}
 if(v.childExitConfirmed||v.proofBarrierConfirmed||v.proof!==null)refuse();return frozen({...v});
}
function privateEnvironment(p,verifier){
 const env={READ_ACTIVATION_RUNTIME_OPT_IN:'1',READ_ACTIVATION_MODE:p.mode,READ_ACTIVATION_APPROVED_ACTION:p.mode==='execute'?'stage':'readonly-reconcile',READ_ACTIVATION_ACTION:'stage',READ_ACTIVATION_OPERATION_ID:p.intent.operationId,READ_CREDENTIAL_INTENT_ID:p.intent.credentialIntentId,READ_ACTIVATION_FROM_PHASE:'empty'};
 const out={schema:'crm-manager-read-private-environment-v1',planSha256:p.planSha256,environment:frozen(env)};Object.defineProperty(out,'READ_SERVICE_SCRAM',{value:verifier,enumerable:false});return Object.freeze(out);
}
function createRemoteOperator(config,adapters){
 if(!config||Object.getPrototypeOf(config)!==Object.prototype)refuse();const enabledDescriptor=Object.getOwnPropertyDescriptor(config,'enabled');if(!enabledDescriptor||enabledDescriptor.enumerable!==true||!Object.hasOwn(enabledDescriptor,'value'))refuse();
 exact(config,['enabled',...(enabledDescriptor.value===true?['stageApproved','readonlyReconcileApproved']:[])]);
 if(typeof config.enabled!=='boolean'||config.enabled===true&&(typeof config.stageApproved!=='boolean'||typeof config.readonlyReconcileApproved!=='boolean'))refuse();
 const enabled=config.enabled===true,stageApproved=config.stageApproved===true,reconcileApproved=config.readonlyReconcileApproved===true;
 const names=['fence','admit','create','configurePrivate','start','observe','stop','clearPrivate','inspectStopped'];
 if(enabled){exact(adapters,names);if(names.some(n=>typeof adapters[n]!=='function'))refuse();}
 const a=enabled?Object.freeze(Object.fromEntries(names.map(n=>[n,adapters[n]]))):null;
 async function fence(p,action){const v=await a.fence(p,action);exact(v,['schema','planSha256','action','durable','firstAttempt']);if(v.schema!=='crm-manager-read-remote-fence-v1'||v.planSha256!==p.planSha256||v.action!==action||v.durable!==true||v.firstAttempt!==true)refuse();}
 async function cleanup(p,fencePlan=p,prefix=''){
  const context=frozen({fencePlan,prefix});
  await fence(fencePlan,prefix+'stop');effect(await a.stop(p,context),p,'stop');
  await fence(fencePlan,prefix+'clear-private');effect(await a.clearPrivate(p,context),p,'clear-private');
  quiescence(await a.inspectStopped(p),p);return true;
 }
 async function run(p,credential){
  let remoteAttempt=false,priorCleanupAttempt=false,observed=null,clean=false;
  try{
   await fence(p,'custody-retained');
   if(p.mode==='reconcile'){priorCleanupAttempt=true;await cleanup(p.parentStage,p,'prior-');}
   admission(await a.admit(p),p);
   await fence(p,'create');remoteAttempt=true;effect(await a.create(p),p,'create');
   await fence(p,'configure-private');effect(await a.configurePrivate(p,privateEnvironment(p,credential.verifier)),p,'configure-private');
   await fence(p,'start');effect(await a.start(p),p,'start');
   // This is GET /status on the fresh exact test host, never a deploy ACK.
   observed=status(await a.observe(p));
  }catch{}
  if(remoteAttempt){try{clean=await cleanup(p);}catch{}}
  return publicResult(p.mode,observed?.state==='verified'&&clean?'verified':remoteAttempt||priorCleanupAttempt?'outcome_unknown':'not_dispatched',clean,observed?.state==='verified'&&clean?observed.proof:null);
 }
 async function stage(input){
  if(!enabled)return publicResult('execute','disabled');if(!stageApproved)refuse();let p,credential;
  try{
   exact(input,['plan','directory','password','verifier','publicKey','privateKey']);p=admitPlan(input.plan,'execute');O.binding(p.intent);
   O.sealNew({directory:input.directory,intent:p.intent,password:input.password,verifier:input.verifier,publicKey:input.publicKey});
   credential=O.openExisting({directory:input.directory,intent:p.intent,privateKey:input.privateKey});
   if(credential.password!==input.password||credential.verifier!==input.verifier)refuse();
  }catch{refuse();}
  return run(p,credential);
 }
 async function reconcile(input){
  if(!enabled)return publicResult('reconcile','disabled');if(!reconcileApproved)refuse();let p,credential;
  try{exact(input,['plan','directory','privateKey']);p=admitPlan(input.plan,'reconcile');O.binding(p.intent);credential=O.openExisting({directory:input.directory,intent:p.intent,privateKey:input.privateKey});}catch{refuse();}
  return run(p,credential);
 }
 return Object.freeze({stage,reconcile});
}
module.exports=Object.freeze({PLAN,RESULT,buildStagePlan,buildReconcilePlan,assertRemotePlan:p=>{if(!branded.has(p))refuse();return admitPlan(p,p.mode);},createRemoteOperator,assertFreshVolumeNamespace,assertRemoteAdmission:admission});
if(require.main===module){process.stderr.write('READ_REMOTE_OPERATOR_API_ONLY\n');process.exitCode=1;}
