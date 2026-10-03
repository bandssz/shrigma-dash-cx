'use strict';
// Exact discovered MCP inputs. No connector, env, key, PG or call on import.
const crypto=require('node:crypto'),R=require('./remote-operator.cjs'),P=require('./public-postcondition.cjs');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex'),clone=v=>JSON.parse(JSON.stringify(v)),admittedPlans=new WeakSet();
function fail(){throw Error('READ_EASYPANEL_PLAN_REFUSED');}
function exact(v,keys){if(!v||Object.getPrototypeOf(v)!==Object.prototype)fail();const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail();for(const k of own){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail();}}
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function buildEasypanelInputs(input){
 exact(input,['remotePlan']);const p=R.assertRemotePlan(input.remotePlan),d=p.descriptor,target={projectName:d.projectName,serviceName:d.serviceName};
 let bootstrap;
 if(p.mode==='execute')bootstrap={services:{'init-volumes':clone(d.compose.services['init-volumes'])},volumes:clone(d.compose.volumes)};
 else bootstrap={services:{'public-park':{image:d.image,user:'1000:1000',read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],network_mode:'none',healthcheck:{disable:true},restart:'no',cpus:0.05,mem_limit:33554432,memswap_limit:33554432,pids_limit:16,environment:{},entrypoint:['node'],command:['--max-old-space-size=16','-e','process.exit(0)'],labels:{'com.shrigma.read-runtime-plan':d.serviceName.slice(-12),'com.shrigma.read-runtime-purpose':'read-reconcile-public-park'}}}};
 const gateway=clone(d.compose.services.gateway);delete gateway.depends_on;
 const execution={services:{gateway},volumes:{source:{external:true,name:d.compose.volumes.source.name},ledger:{external:true,name:d.compose.volumes.ledger.name}},networks:clone(d.compose.networks)};
 const probe=P.buildPublicPostcondition({remotePlan:p}),probeContent=JSON.stringify(probe.compose),publicContent=JSON.stringify(bootstrap),executionContent=JSON.stringify(execution),step=(procedure,input,executor)=>({procedure,input,executor}),domain=d.domain;
 const plan=freeze({schema:'crm-manager-read-easypanel-input-plan-v2',remotePlan:p,mode:p.mode,target,domain,image:d.image,sourcePins:d.sourcePins,intent:p.intent,sourceVolume:d.compose.volumes.source.name,ledgerVolume:d.compose.volumes.ledger.name,bootstrapContentSha256:sha(publicContent),publicProbeContentSha256:sha(probeContent),executionContentSha256:sha(executionContent),
  createPublicBootstrap:step('createComposeService',{...target,createDotEnv:true,env:'',domains:[],source:{type:'inline',content:publicContent}},'execute_mutation'),
  inspect:step('inspectComposeService',{...target},'execute_query'),inspectRunning:step('getDockerContainers',{service:target.projectName+'_'+target.serviceName},'execute_query'),
  inspectDomains:step('listDomains',{...target},'execute_query'),inspectDomainCollision:step('listDomains',{},'execute_query'),
  updatePublicProbe:step('updateComposeSourceInline',{...target,content:probeContent},'execute_destructive'),
  startPublicProbe:step('startComposeService',{...target},'execute_mutation'),
  updatePrivateSource:step('updateComposeSourceInline',{...target,content:executionContent},'execute_destructive'),
  createTestDomain:step('createDomain',{id:domain.id,certificateResolver:'',host:domain.host,https:true,path:'/',wildcard:false,middlewares:[],destinationType:'service',serviceDestination:{...target,composeService:'gateway',protocol:'http',port:8099,path:'/'}},'execute_mutation'),
  deleteTestDomain:step('deleteDomain',{id:domain.id},'execute_destructive'),
  deployOnce:step('deployComposeService',{...target,forceRebuild:false},'execute_destructive'),stop:step('stopComposeService',{...target},'execute_destructive'),clearEnvironment:step('updateComposeEnv',{...target,createDotEnv:true,env:''},'execute_destructive'),
  unproven:{bootstrapOCI:false,sourceEnvUpdatesDoNotDeploy:'public_UI_evidence_not_backend_review',destroyPreservesExternalVolumes:false,allStoppedContainersInspectable:false,actualRPCExecuted:false,privateDeployApproved:false}});
 admittedPlans.add(plan);return plan;
}
function privateEnvInput(input){
 exact(input,['plan','publicFlags','verifier','adminPassword']);const p=input.plan;if(!admittedPlans.has(p))fail();
 exact(input.publicFlags,['READ_ACTIVATION_RUNTIME_OPT_IN','READ_ACTIVATION_MODE','READ_ACTIVATION_APPROVED_ACTION','READ_ACTIVATION_ACTION','READ_ACTIVATION_OPERATION_ID','READ_CREDENTIAL_INTENT_ID','READ_ACTIVATION_FROM_PHASE']);const v=input.publicFlags;
 if(v.READ_ACTIVATION_RUNTIME_OPT_IN!=='1'||v.READ_ACTIVATION_MODE!==p.mode||v.READ_ACTIVATION_APPROVED_ACTION!==(p.mode==='execute'?'stage':'readonly-reconcile')||v.READ_ACTIVATION_ACTION!=='stage'||v.READ_ACTIVATION_FROM_PHASE!=='empty'||v.READ_ACTIVATION_OPERATION_ID!==p.intent.operationId||v.READ_CREDENTIAL_INTENT_ID!==p.intent.credentialIntentId||typeof input.verifier!=='string'||!/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/.test(input.verifier)||typeof input.adminPassword!=='string'||input.adminPassword.length<1||input.adminPassword.length>1024||/[\r\n\0\\']/.test(input.adminPassword))fail();
 const env=[...Object.entries(v).map(([k,x])=>k+'='+x),"READ_SERVICE_SCRAM='"+input.verifier+"'","PG_ADMIN_PASSWORD='"+input.adminPassword+"'"].join('\n')+'\n';
 const privateInput={...p.target,createDotEnv:true};Object.defineProperty(privateInput,'env',{value:env,enumerable:false});Object.freeze(privateInput);
 const result={procedure:'updateComposeEnv',executor:'execute_destructive',planSha256:p.remotePlan.planSha256};Object.defineProperty(result,'input',{value:privateInput,enumerable:false});return Object.freeze(result);
}
module.exports=Object.freeze({buildEasypanelInputs,privateEnvInput});
if(require.main===module){process.stderr.write('READ_EASYPANEL_PLAN_API_ONLY\n');process.exitCode=1;}
