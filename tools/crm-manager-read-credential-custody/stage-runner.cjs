'use strict';
// API-only composition. No environment, files, timers, sockets or dependency import on OFF/import.
const NODE_TIMEOUT_MS=45000,CALLBACK_TIMEOUT_MS=40000,GET_TIMEOUT_MS=35000;
function refused(){throw Error('READ_STAGE_RUNNER_REFUSED');}
function exact(v,keys){if(!v||Object.getPrototypeOf(v)!==Object.prototype)refused();const ks=Reflect.ownKeys(v);if(ks.length!==keys.length||ks.some(k=>typeof k!=='string'||!keys.includes(k)))refused();for(const k of ks){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))refused();}}
const freeze=v=>Object.freeze(v);
function disabled(mode){return freeze({schema:'crm-manager-read-remote-result-v1',mode,state:'disabled',cleanupVerified:false,proof:null});}
function createStageRunner(config={enabled:false},deps){
 if(!config||Object.getPrototypeOf(config)!==Object.prototype)refused();
 exact(config,Reflect.ownKeys(config).includes('enabled')&&Object.getOwnPropertyDescriptor(config,'enabled')?.value===true?['enabled','stageApproved','readonlyReconcileApproved']:['enabled']);
 if(typeof config.enabled!=='boolean')refused();
 if(!config.enabled)return freeze({enabled:false,stage:async()=>disabled('execute'),reconcile:async()=>disabled('reconcile'),close:async()=>{}});
 if(typeof config.stageApproved!=='boolean'||typeof config.readonlyReconcileApproved!=='boolean')refused();
 if(!deps||Object.getPrototypeOf(deps)!==Object.prototype)refused();
 exact(deps,['custody','effectsDirectory','requestDirectory','transport','getAdminPassword','admission','observeStatus',...(Object.hasOwn(deps,'timers')?['timers']:[])]);
 exact(deps.custody,['directory','privateKey']);exact(deps.transport,['input','output']);
 for(const n of['getAdminPassword','admission','observeStatus'])if(typeof deps[n]!=='function')refused();
 if(typeof deps.effectsDirectory!=='string'||typeof deps.requestDirectory!=='string'||typeof deps.custody.directory!=='string')refused();
 if(deps.timers){exact(deps.timers,['setTimeout','clearTimeout']);if(typeof deps.timers.setTimeout!=='function'||typeof deps.timers.clearTimeout!=='function')refused();}
 const R=require('./remote-operator.cjs'),M=require('./easypanel-adapter.cjs'),F=require('./effect-fence.cjs'),B=require('./stdio-bridge.cjs');
 const flags=freeze({...config}),effectsDirectory=deps.effectsDirectory,requestDirectory=deps.requestDirectory,timers=freeze(deps.timers?{...deps.timers}:{setTimeout,clearTimeout}),custody=freeze({...deps.custody}),transport=freeze({...deps.transport}),callbacks=freeze({getAdminPassword:deps.getAdminPassword,admission:deps.admission,observeStatus:deps.observeStatus});
 let closed=false,active=null,bridge=null,fence=null;const plans=new Map(),cancellers=new Set();
 function bounded(fn){if(closed)return Promise.reject(Error('READ_STAGE_RUNNER_REFUSED'));return new Promise((resolve,reject)=>{let settled=false,timer;const finish=(error,value)=>{if(settled)return;settled=true;timers.clearTimeout(timer);cancellers.delete(cancel);error?reject(Error('READ_STAGE_RUNNER_REFUSED')):resolve(value);},cancel=()=>finish(true);cancellers.add(cancel);timer=timers.setTimeout(cancel,CALLBACK_TIMEOUT_MS);Promise.resolve().then(()=>{if(closed)refused();return fn();}).then(v=>finish(false,v),()=>finish(true));});}
 function remember(p){try{R.assertRemotePlan(p);}catch{refused();}plans.set(p.planSha256,p);if(p.parentStage)plans.set(p.parentStage.planSha256,p.parentStage);return p;}
 function hold(p,action){if(closed)refused();if(!fence)fence=F.openEffectFence({directory:effectsDirectory});return fence.fence(p,action);}
 async function execute(frame){if(closed)refused();if(!bridge)bridge=B.createStdioBridge({enabled:true,directory:requestDirectory,materialize:M.mcpArguments,input:transport.input,output:transport.output,timeoutMs:NODE_TIMEOUT_MS});return bridge.execute(frame);}
 const adapters=M.createEasypanelAdapter({...flags},{execute,fence:hold,custody,
  admitCapacity:p=>bounded(()=>callbacks.admission(freeze({schema:'crm-manager-read-stage-admission-request-v1',planSha256:p.planSha256,mode:p.mode}))),
  getAdminPassword:p=>bounded(async()=>{const value=await callbacks.getAdminPassword(freeze({schema:'crm-manager-read-stage-admin-request-v1',planSha256:p.planSha256,mode:p.mode}));if(typeof value!=='string'||value.length<1||value.length>1024||/[\r\n\0\\']/.test(value))refused();return value;}),
  observeStatus:q=>bounded(()=>{exact(q,['schema','planSha256','url','method','maxBytes','timeoutMs']);const p=plans.get(q.planSha256),publicProof=q.schema==='crm-manager-read-public-postcondition-request-v1';if(!p||!publicProof&&q.schema!=='crm-manager-read-public-status-request-v1'||q.url!=='https://'+p.descriptor.domain.host+'/status'||q.method!=='GET'||q.maxBytes!==(publicProof?4096:2048)||q.timeoutMs!==GET_TIMEOUT_MS)refused();return callbacks.observeStatus(freeze({...q}));})
 });
 const app=R.createRemoteOperator({...flags},adapters);
 async function run(mode,input){if(closed||active||mode==='execute'&&!flags.stageApproved||mode==='reconcile'&&!flags.readonlyReconcileApproved)refused();exact(input,mode==='execute'?['plan','password','verifier','publicKey']:['plan']);const p=remember(input.plan);if(p.mode!==mode)refused();
  const work=mode==='execute'?app.stage({plan:p,directory:custody.directory,password:input.password,verifier:input.verifier,publicKey:input.publicKey,privateKey:custody.privateKey}):app.reconcile({plan:p,directory:custody.directory,privateKey:custody.privateKey});active=work;
  try{return await work;}catch{refused();}finally{active=null;}
 }
 async function close(){closed=true;bridge?.abort();for(const cancel of [...cancellers])cancel();if(active)try{await active;}catch{}}
 return freeze({enabled:true,stage:input=>run('execute',input),reconcile:input=>run('reconcile',input),close});
}
module.exports=freeze({createStageRunner,NODE_TIMEOUT_MS,CALLBACK_TIMEOUT_MS,GET_TIMEOUT_MS});
if(require.main===module){process.stderr.write('READ_STAGE_RUNNER_API_ONLY\n');process.exitCode=1;}
