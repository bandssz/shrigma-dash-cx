'use strict';
// Private callback adapter for discovered procedures. No tool/client/env/key/PG
// is invoked on import. All real callbacks remain supplied by the operator.
const crypto=require('node:crypto'),O=require('./operator.cjs'),R=require('./remote-operator.cjs'),E=require('./easypanel-plan.cjs'),P=require('./public-postcondition.cjs');
const MAX=524288,frames=new WeakSet();
const PROCEDURES=Object.freeze({createComposeService:'execute_mutation',inspectComposeService:'execute_query',getDockerContainers:'execute_query',listDomains:'execute_query',updateComposeSourceInline:'execute_destructive',updateComposeEnv:'execute_destructive',createDomain:'execute_mutation',deleteDomain:'execute_destructive',deployComposeService:'execute_destructive',stopComposeService:'execute_destructive',startComposeService:'execute_mutation'});
function fail(){throw Error('READ_EASYPANEL_ADAPTER_REFUSED');}
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function plain(v){return !!v&&Object.getPrototypeOf(v)===Object.prototype;}
function data(v,k,optional=false){if(!plain(v))fail();const d=Object.getOwnPropertyDescriptor(v,k);if(!d){if(optional)return undefined;fail();}if(!d.enumerable||!Object.hasOwn(d,'value'))fail();return d.value;}
function exact(v,keys){if(!plain(v))fail();const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail();for(const k of own)data(v,k);}
function unwrap(raw,procedure,required=true){
 if(!plain(raw)||data(raw,'isError',true)===true)fail();let value=data(raw,'structuredContent',true);
 if(value===undefined){const blocks=data(raw,'content');if(!Array.isArray(blocks)||blocks.length!==1||data(blocks[0],'type')!=='text')fail();const text=data(blocks[0],'text');if(typeof text!=='string'||Buffer.byteLength(text)>MAX)fail();try{value=JSON.parse(text);}catch{fail();}}
 if(!plain(value)||data(value,'procedure')!==procedure)fail();return data(value,'result',!required);
}
function frame(step,privateRequest=false){
 if(!plain(step)||PROCEDURES[step.procedure]!==step.executor)fail();
 if(!privateRequest){const out=Object.freeze({executor:step.executor,procedure:step.procedure,input:step.input});frames.add(out);return out;}
 const out={executor:step.executor,procedure:step.procedure,private:true,projectName:step.input.projectName,serviceName:step.input.serviceName};Object.defineProperty(out,'input',{value:step.input,enumerable:false});Object.freeze(out);frames.add(out);return out;
}
// Last private transport boundary ONLY: enumerability is required by tool JSON.
// This DTO MUST NOT be printed, logged, stored publicly or echoed on failure.
function mcpArguments(request){
 if(!frames.has(request)||PROCEDURES[request.procedure]!==request.executor)fail();
 if(request.private===true){
  const i=request.input,own=Reflect.ownKeys(i);if(!plain(i)||own.length!==4||own.some(k=>typeof k!=='string'||!['projectName','serviceName','createDotEnv','env'].includes(k)))fail();
  const e=Object.getOwnPropertyDescriptor(i,'env');if(!e||e.enumerable!==false||!Object.hasOwn(e,'value')||typeof e.value!=='string'||Buffer.byteLength(e.value)>16384)fail();
  return Object.freeze({procedure:request.procedure,input:Object.freeze({projectName:data(i,'projectName'),serviceName:data(i,'serviceName'),createDotEnv:data(i,'createDotEnv'),env:e.value})});
 }
 return Object.freeze({procedure:request.procedure,input:request.input});
}
function createEasypanelAdapter(config,deps){
 exact(config,['enabled',...(data(config,'enabled')===true?['stageApproved','readonlyReconcileApproved']:[])]);if(typeof config.enabled!=='boolean')fail();
 if(!config.enabled)return Object.freeze({enabled:false});
 if(typeof config.stageApproved!=='boolean'||typeof config.readonlyReconcileApproved!=='boolean')fail();
 exact(deps,['execute','fence','admitCapacity','getAdminPassword','observeStatus','custody']);for(const name of ['execute','fence','admitCapacity','getAdminPassword','observeStatus'])if(typeof deps[name]!=='function')fail();exact(deps.custody,['directory','privateKey']);
 const enabledStage=config.stageApproved,enabledReconcile=config.readonlyReconcileApproved,a=Object.freeze({execute:deps.execute,fence:deps.fence,admitCapacity:deps.admitCapacity,getAdminPassword:deps.getAdminPassword,observeStatus:deps.observeStatus}),custody=Object.freeze({...deps.custody}),plans=new WeakMap(),readyPlans=new WeakSet(),privateEnvs=new WeakMap(),cleanupParents=new WeakSet();
 function admitted(p,execution=false){R.assertRemotePlan(p);if(p.mode==='execute'?!enabledStage&&(execution||!cleanupParents.has(p)):!enabledReconcile)fail();const c=O.openExisting({directory:custody.directory,intent:p.intent,privateKey:custody.privateKey});if(!plans.has(p))plans.set(p,E.buildEasypanelInputs({remotePlan:p}));return{plan:plans.get(p),credential:c};}
 async function rpc(p,step,privateRequest=false){admitted(p);const request=frame(step,privateRequest);try{return unwrap(await a.execute(request),step.procedure,step.executor==='execute_query');}catch{fail();}}
 async function fence(p,action){admitted(p);try{const r=await a.fence(p,action);exact(r,['schema','planSha256','action','durable','firstAttempt']);if(r.schema!=='crm-manager-read-remote-fence-v1'||r.planSha256!==p.planSha256||r.action!==action||r.durable!==true||r.firstAttempt!==true)fail();return r;}catch{fail();}}
 function effect(p,action){return Object.freeze({schema:'crm-manager-read-remote-effect-v1',planSha256:p.planSha256,action,accepted:true,projectName:p.descriptor.projectName,serviceName:p.descriptor.serviceName,ownedExact:true});}
 async function inspected(p){
  const {plan}=admitted(p),r=await rpc(p,plan.inspect),name=data(r,'name'),project=data(r,'projectName'),type=data(r,'type'),enabled=data(r,'enabled'),createDotEnv=data(r,'createDotEnv'),env=data(r,'env'),source=data(r,'source');
  if(name!==plan.target.serviceName||project!==plan.target.projectName||type!=='compose'||typeof enabled!=='boolean'||createDotEnv!==true||typeof env!=='string'||Buffer.byteLength(env)>16384||data(source,'type')!=='inline')fail();
  const content=data(source,'content');if(typeof content!=='string'||Buffer.byteLength(content)>MAX)fail();const hash=sha(content);if(![plan.bootstrapContentSha256,plan.publicProbeContentSha256,plan.executionContentSha256].includes(hash))fail();return{enabled,env,sourceHash:hash};
 }
 async function zeroRunning(p){
  const {plan}=admitted(p),r=await rpc(p,plan.inspectRunning);if(!Array.isArray(r)||r.length>16)fail();
  // Only RUNNING inventory is exposed. Never return IDs/names/metadata.
  for(const c of r){const id=data(c,'Id'),state=data(c,'State'),labels=data(c,'Labels');if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)||state!=='running'||data(labels,'com.shrigma.read-runtime-plan')!==p.descriptor.serviceName.slice(-12))fail();}
  return r.length===0;
 }
 function mappingMatches(r,plan){
  if(data(r,'id')!==plan.domain.id||data(r,'host')!==plan.domain.host||data(r,'https')!==true||data(r,'path')!=='/'||data(r,'certificateResolver')!==''||data(r,'wildcard')!==false||data(r,'destinationType')!=='service')return false;
  const middlewares=data(r,'middlewares'),d=data(r,'serviceDestination');return Array.isArray(middlewares)&&middlewares.length===0&&data(d,'projectName')===plan.target.projectName&&data(d,'serviceName')===plan.target.serviceName&&data(d,'composeService')==='gateway'&&data(d,'protocol')==='http'&&data(d,'port')===8099&&data(d,'path')==='/';
 }
 async function domains(p,global=false){
  const {plan}=admitted(p),r=await rpc(p,global?plan.inspectDomainCollision:plan.inspectDomains);if(!Array.isArray(r)||r.length>2048)fail();let found=0;
  for(const item of r){const host=data(item,'host'),id=data(item,'id');if(typeof host!=='string'||host.length<1||host.length>253||typeof id!=='string'||id.length<1||id.length>128||id===plan.domain.id&&host!==plan.domain.host)fail();if(host.toLowerCase().replace(/\.$/,'')===plan.domain.host){if(!mappingMatches(item,plan))fail();found++;}else if(!global){const kind=data(item,'destinationType'),d=kind==='service'?data(item,'serviceDestination'):null;if(d&&data(d,'projectName')===plan.target.projectName&&data(d,'serviceName')===plan.target.serviceName)fail();}}
  if(found>1)fail();return found;
 }
 async function admit(p){admitted(p,true);if(await domains(p,true)!==0)fail();try{const r=await a.admitCapacity(p);R.assertRemoteAdmission(r,p);readyPlans.add(p);return Object.freeze({...r});}catch{fail();}}
 async function create(p){const {plan}=admitted(p,true);if(!readyPlans.has(p))fail();await fence(p,'create-public-bootstrap');await rpc(p,plan.createPublicBootstrap);const observed=await inspected(p);if(observed.sourceHash!==plan.bootstrapContentSha256||observed.env!==''||await domains(p)!==0)fail();return effect(p,'create');}
 async function publicPostcondition(p){
  const {plan}=admitted(p,true),r=await inspected(p);if(r.enabled!==true||r.env!==''||r.sourceHash!==plan.publicProbeContentSha256||await domains(p)!==1)fail();
  const request=Object.freeze({schema:'crm-manager-read-public-postcondition-request-v1',planSha256:p.planSha256,url:'https://'+plan.domain.host+'/status',method:'GET',maxBytes:4096,timeoutMs:35000});
  try{return P.acceptPostcondition(await a.observeStatus(request),p);}catch{fail();}
 }
 async function configurePrivate(p,dto){
  const {plan,credential}=admitted(p,true);if(!plain(dto)||data(dto,'schema')!=='crm-manager-read-private-environment-v1'||data(dto,'planSha256')!==p.planSha256)fail();const d=Object.getOwnPropertyDescriptor(dto,'READ_SERVICE_SCRAM');if(!d||d.enumerable!==false||!Object.hasOwn(d,'value')||d.value!==credential.verifier)fail();
  const current=await inspected(p);if(current.sourceHash!==plan.bootstrapContentSha256||current.env!==''||current.enabled!==true)fail();
  // A public inline observer proves initializer POSTCONDITIONS, never exit0.
  await fence(p,'update-public-probe');await rpc(p,plan.updatePublicProbe);const prepared=await inspected(p);if(prepared.sourceHash!==plan.publicProbeContentSha256||prepared.env!=='')fail();
  if(await domains(p,true)!==0)fail();await fence(p,'create-domain');await rpc(p,plan.createTestDomain);if(await domains(p)!==1)fail();
  await fence(p,'deploy-public-probe');await rpc(p,plan.deployOnce);await publicPostcondition(p);
  // start is deliberately used ONLY while source/env remain entirely public.
  await fence(p,'stop-public-probe');await rpc(p,plan.stop);const stopped=await inspected(p);if(stopped.enabled!==false||stopped.env!==''||stopped.sourceHash!==plan.publicProbeContentSha256||!await zeroRunning(p))fail();
  await fence(p,'reenable-public-probe');await rpc(p,plan.startPublicProbe);await publicPostcondition(p);
  // Effects from source/env updates are also fenced; no assumption of inertness.
  await fence(p,'update-private-source');await rpc(p,plan.updatePrivateSource);const privateSource=await inspected(p);if(privateSource.sourceHash!==plan.executionContentSha256||privateSource.env!==''||privateSource.enabled!==true)fail();
  let password;try{password=await a.getAdminPassword(p);const privateStep=E.privateEnvInput({plan,publicFlags:data(dto,'environment'),verifier:credential.verifier,adminPassword:password});privateEnvs.set(p,privateStep.input.env);await fence(p,'configure-private-env');await rpc(p,privateStep,true);const after=await inspected(p);if(after.sourceHash!==plan.executionContentSha256||after.env!==privateStep.input.env||after.enabled!==true)fail();}catch{fail();}finally{password=undefined;}
  return effect(p,'configure-private');
 }
 async function start(p){const {plan}=admitted(p,true);const before=await inspected(p);if(before.sourceHash!==plan.executionContentSha256||!privateEnvs.has(p)||before.env!==privateEnvs.get(p)||await domains(p)!==1)fail();await fence(p,'deploy-stage');await rpc(p,plan.deployOnce);return effect(p,'start');}
 async function observe(p){const {plan}=admitted(p,true),current=await inspected(p);if(current.enabled!==true||current.sourceHash!==plan.executionContentSha256||!privateEnvs.has(p)||current.env!==privateEnvs.get(p)||await domains(p)!==1)fail();const url='https://'+p.descriptor.domain.host+'/status';try{return await a.observeStatus(Object.freeze({schema:'crm-manager-read-public-status-request-v1',planSha256:p.planSha256,url,method:'GET',maxBytes:2048,timeoutMs:35000}));}catch{fail();}}
 function context(p,c){if(c===undefined)return{fencePlan:p,prefix:''};exact(c,['fencePlan','prefix']);R.assertRemotePlan(c.fencePlan);if(!(c.prefix===''&&c.fencePlan===p)&&!(c.prefix==='prior-'&&c.fencePlan.mode==='reconcile'&&c.fencePlan.parentStage===p&&enabledReconcile))fail();if(c.prefix==='prior-')cleanupParents.add(p);return c;}
 async function stop(p,c){const ctx=context(p,c),{plan}=admitted(p);await inspected(p);await fence(ctx.fencePlan,ctx.prefix+'stop-service');await rpc(p,plan.stop);const after=await inspected(p);if(after.enabled!==false||!await zeroRunning(p))fail();return effect(p,'stop');}
 async function clearPrivate(p,c){const ctx=context(p,c),{plan}=admitted(p);await inspected(p);await fence(ctx.fencePlan,ctx.prefix+'clear-private-env');await rpc(p,plan.clearEnvironment);const after=await inspected(p);if(after.enabled!==false||after.env!=='')fail();if(await domains(p)===1){await fence(ctx.fencePlan,ctx.prefix+'cleanup-domain');await rpc(p,plan.deleteTestDomain);}if(await domains(p)!==0)fail();return effect(p,'clear-private');}
 async function inspectStopped(p){const r=await inspected(p),zero=await zeroRunning(p),absent=await domains(p)===0;return Object.freeze({schema:'crm-manager-read-mcp-quiescence-v1',planSha256:p.planSha256,serviceDisabled:r.enabled===false,envEmpty:r.env==='',runningContainers:zero?0:1,testDomainAbsent:absent,volumesNotDeletedByOperator:true,allContainersInspected:false});}
 return Object.freeze({fence,admit,create,configurePrivate,start,observe,stop,clearPrivate,inspectStopped});
}
module.exports=Object.freeze({createEasypanelAdapter,PROCEDURES,mcpArguments});
if(require.main===module){process.stderr.write('READ_EASYPANEL_ADAPTER_API_ONLY\n');process.exitCode=1;}
