'use strict';
// Synthetic RSA, own ciphertext/fence directories, actual public wrappers and
// fake MCP shaped exactly like observed envelopes. No real tools/network/PG.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),util=require('node:util');
const R=require('./remote-operator.cjs'),E=require('./easypanel-plan.cjs'),M=require('./easypanel-adapter.cjs'),F=require('./effect-fence.cjs'),O=require('./operator.cjs'),C=require('../crm-manager-read-activation-review/compose/build-compose.cjs'),P=require('./public-postcondition.cjs');
const sources=Object.fromEntries(Object.keys(C.PINS).map(n=>[n,fs.readFileSync(path.join(__dirname,'../crm-manager-read-activation-review/runtime',n),'utf8')]));
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:4096,publicExponent:65537}),wrong=crypto.generateKeyPairSync('rsa',{modulusLength:4096,publicExponent:65537});
const password='a7'.repeat(32),admin='SYNTHETIC_ADMIN_ONLY',salt=Buffer.from('0123456789abcdef'),salted=crypto.pbkdf2Sync(password,salt,4096,32,'sha256'),client=crypto.createHmac('sha256',salted).update('Client Key').digest();
const verifier='SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+crypto.createHash('sha256').update(client).digest('base64')+':'+crypto.createHmac('sha256',salted).update('Server Key').digest('base64');salted.fill(0);client.fill(0);
const proof={schema:'crm-manager-read-runtime-result-v1',action:'stage',state:'confirmed',phase:'staged',coreVerified:true,credentialBound:true,commitAck:true};
const verified=()=>({schema:'crm-manager-read-supervisor-v1',action:'stage',state:'verified',childExitConfirmed:true,proofBarrierConfirmed:true,proof:{...proof}});
const pending=()=>({schema:'crm-manager-read-supervisor-v1',action:'stage',state:'pending',childExitConfirmed:false,proofBarrierConfirmed:false,proof:null});
const closed=e=>e instanceof Error&&/^(READ_EASYPANEL_ADAPTER_REFUSED|READ_REMOTE_OPERATOR_REFUSED|READ_EFFECT_FENCE_REFUSED)$/.test(e.message)&&e.cause===undefined;
function fixture(t){const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'read-mcp-stage-synthetic-')));fs.chmodSync(parent,0o700);t.after(()=>fs.rmSync(parent,{force:true,recursive:true}));const directory=path.join(parent,'capsule'),effects=path.join(parent,'effects');fs.mkdirSync(effects,{mode:0o700});const intent={schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action:'stage',fromPhase:'empty'},plan=R.buildStagePlan({suffix:crypto.randomBytes(6).toString('hex'),sources,intent,domainId:crypto.randomUUID()});return{parent,directory,effects,intent,plan,input:{plan,directory,password,verifier,publicKey:pair.publicKey,privateKey:pair.privateKey}};}
function transport(f,options={}){
 const states=new Map(),calls=[],domainRows=[{id:crypto.randomUUID(),host:'existing.invalid',https:true,path:'/',certificateResolver:'',wildcard:false,middlewares:[],destinationType:'service',serviceDestination:{projectName:'existing',serviceName:'existing',composeService:'gateway',protocol:'http',port:8080,path:'/'}}],before=JSON.stringify(domainRows);let adminCalls=0,stageMutations=0,readonly=0;const admittedPlans=new Map(),publicObservations=[];
 const key=i=>i.projectName+'_'+i.serviceName;
 async function execute(request){
  const step=request.procedure;assert.equal(M.PROCEDURES[step],request.executor);const args=M.mcpArguments(request),i=args.input;assert.equal(args.procedure,step);if(request.private){assert.equal(step,'updateComposeEnv');assert.equal(Object.keys(request).includes('input'),false);assert.equal(JSON.stringify(request).includes(admin),false);assert.equal(util.inspect(request).includes(verifier),false);assert.equal(Object.keys(i).includes('env'),true);assert.equal(JSON.parse(JSON.stringify(args)).input.env,i.env);assert.equal(i.env.includes(admin),true);assert.equal(i.env.includes(verifier),true);}else assert.equal(JSON.stringify(request).includes(admin),false);
  const bound=O.openExisting({directory:f.directory,intent:f.plan.intent,privateKey:pair.privateKey});assert.equal(bound.verifier,verifier);calls.push({procedure:step,executor:request.executor,private:request.private===true,target:i.serviceName||null,sourcePhase:states.has(key(i))?JSON.parse(states.get(key(i)).source.content).services.gateway?.command?.at(-1)==='/review/supervisor.cjs'?'private':'public':null,environmentEmpty:states.has(key(i))?states.get(key(i)).env==='':null});
  let result;switch(step){
   case'createComposeService':if(states.has(key(i)))throw Error('SYNTHETIC_COLLISION');states.set(key(i),{name:i.serviceName,projectName:i.projectName,type:'compose',enabled:true,createDotEnv:true,env:i.env,source:{...i.source},running:0});result={token:admin,env:verifier};break;
   case'inspectComposeService':{const s=states.get(key(i));if(!s)throw Error('SYNTHETIC_ABSENT');const out={...s,source:{...s.source}};Object.defineProperty(out,'token',{enumerable:true,get(){throw Error('TOKEN_MUST_NOT_BE_READ');}});result=out;break;}
   case'getDockerContainers':{const s=states.get(i.service);result=s?.running?[{Id:'a'.repeat(64),State:'running',Labels:{'com.shrigma.read-runtime-plan':s.name.slice(-12)},Names:['synthetic-only'],Image:C.IMAGE}]:[];break;}
   case'listDomains':result=domainRows.filter(r=>i.projectName===undefined||r.serviceDestination.projectName===i.projectName&&r.serviceDestination.serviceName===i.serviceName);break;
   case'updateComposeSourceInline':states.get(key(i)).source={type:'inline',content:i.content};break;
   case'createDomain':domainRows.push(JSON.parse(JSON.stringify(i)));break;
   case'deleteDomain':{const at=domainRows.findIndex(r=>r.id===i.id);assert.ok(at>=1);domainRows.splice(at,1);break;}
   case'updateComposeEnv':states.get(key(i)).env=i.env;break;
   case'deployComposeService':{const s=states.get(key(i)),spec=JSON.parse(s.source.content);s.enabled=true;s.running=1;if(spec.services.gateway?.command?.at(-1)==='/review/supervisor.cjs'){const mode=s.env.match(/^READ_ACTIVATION_MODE=(.+)$/m)[1];if(mode==='execute')stageMutations++;else readonly++;}break;}
   case'startComposeService':states.get(key(i)).enabled=true;states.get(key(i)).running=1;break;
   case'stopComposeService':states.get(key(i)).enabled=false;states.get(key(i)).running=0;break;
   default:throw Error('UNEXPECTED_PROC');
  }
  if(options.lost===step&&calls.filter(c=>c.procedure===step).length===(options.lostOccurrence||1))throw Error('RAW_SECRET '+admin+' '+verifier);
  if(options.modify)result=options.modify({step,input:i,result,states,domainRows});
  return options.textFallback?{content:[{type:'text',text:JSON.stringify({procedure:step,result:result===undefined?null:result})}]}:{structuredContent:{procedure:step,result:result===undefined?null:result}};
 }
 const fence=F.openEffectFence({directory:f.effects});
 function publicResult(p){return JSON.stringify({schema:'crm-manager-read-public-postcondition-v1',mode:p.mode,planSha256:p.planSha256,sourcePinsSha256:crypto.createHash('sha256').update(JSON.stringify(C.PINS)).digest('hex'),nineSourcesPinned:true,sourceReadOnly:true,sourceRootOwned:true,sourceModesVerified:true,ledgerPhase:p.mode==='execute'?'empty':'original_intent_held',ledgerEmpty:p.mode==='execute',originalIntentHeld:p.mode==='reconcile',ledgerPrivateOwned:true,uid1000:true,noNewPrivileges:true,capabilitiesEmpty:true,rootReadOnly:true,privateEnvironmentAbsent:true,postgresConnected:false,runtimeExecuted:false});}
 const dependencies={execute,fence:fence.fence,admitCapacity:async p=>{admittedPlans.set(p.planSha256,p);return{schema:'crm-manager-read-remote-admission-v1',planSha256:p.planSha256,capacityVerified:true,targetAbsent:true,domainAbsent:true,imagePinned:true,nineSourcesPinned:true,newVolumesAbsent:p.mode==='execute',existingSourceVerified:p.mode==='reconcile',existingLedgerVerified:p.mode==='reconcile',priorQuiescent:p.mode==='reconcile',...(options.admission||{})};},getAdminPassword:async()=>{adminCalls++;return admin;},observeStatus:async q=>{
  assert.equal(q.method,'GET');assert.ok(q.url.endsWith('/status'));
  if(q.schema==='crm-manager-read-public-postcondition-request-v1'){assert.equal(q.maxBytes,4096);const p=admittedPlans.get(q.planSha256);assert.ok(p);const s=states.get(p.descriptor.projectName+'_'+p.descriptor.serviceName),spec=JSON.parse(s.source.content);assert.equal(s.env,'');assert.equal(s.enabled,true);assert.equal(s.running,1);assert.equal(spec.services.gateway.command.at(-1),P.buildPublicPostcondition({remotePlan:p}).inline);publicObservations.push(q.planSha256);return options.publicObserver?options.publicObserver(q,publicResult(p),publicObservations.length):publicResult(p);}
  assert.equal(q.schema,'crm-manager-read-public-status-request-v1');assert.equal(q.maxBytes,2048);return options.observer?options.observer(q):verified();},custody:{directory:f.directory,privateKey:pair.privateKey}};
 return{dependencies,states,calls,domainRows,fence,publicObservations,get adminCalls(){return adminCalls},get stageMutations(){return stageMutations},get readonly(){return readonly},assertExisting(){assert.equal(JSON.stringify(domainRows.filter(r=>r.host==='existing.invalid')),before);}};
}
function operator(f,m,flags={stageApproved:true,readonlyReconcileApproved:true}){const adapters=M.createEasypanelAdapter({enabled:true,...flags},m.dependencies);return{adapters,app:R.createRemoteOperator({enabled:true,...flags},adapters)};}

test('OFF is inert; gates/descriptors refuse before callbacks or private reads',async t=>{
 assert.deepEqual(M.createEasypanelAdapter({enabled:false}),{enabled:false});let reads=0;const g={};Object.defineProperty(g,'enabled',{enumerable:true,get(){reads++;return true;}});assert.throws(()=>M.createEasypanelAdapter(g),closed);
 const f=fixture(t),m=transport(f),{app}=operator(f,m,{stageApproved:false,readonlyReconcileApproved:false});await assert.rejects(app.stage(f.input),closed);assert.equal(reads,0);assert.equal(m.calls.length,0);assert.equal(m.adminCalls,0);assert.equal(fs.existsSync(f.directory),false);
});
test('capsule/fsync precedes every RPC; exact new host/domain and private env are fenced, ACK is not proof, cleanup is truthful MCP scope',async t=>{
 const f=fixture(t),m=transport(f),{app}=operator(f,m),out=await app.stage(f.input);assert.equal(out.state,'verified');assert.equal(out.cleanupVerified,true);assert.deepEqual(out.proof,proof);assert.equal(m.stageMutations,1);assert.equal(m.adminCalls,1);assert.equal(m.publicObservations.length,2);assert.deepEqual(m.calls.filter(c=>c.procedure==='startComposeService').map(c=>[c.sourcePhase,c.environmentEmpty]),[['public',true]]);assert.deepEqual(m.calls.filter(c=>c.procedure==='deployComposeService').map(c=>[c.sourcePhase,c.environmentEmpty]),[['public',true],['private',false]]);
 const d=m.calls.filter(c=>c.procedure==='createDomain');assert.equal(d.length,1);assert.equal(m.calls.filter(c=>c.procedure==='deleteDomain').length,1);m.assertExisting();const s=m.states.get(f.plan.descriptor.projectName+'_'+f.plan.descriptor.serviceName);assert.equal(s.enabled,false);assert.equal(s.env,'');assert.equal(s.running,0);assert.equal(m.domainRows.length,1);
 for(const n of fs.readdirSync(f.effects)){const b=fs.readFileSync(path.join(f.effects,n),'utf8');assert.equal(b.includes(admin),false);assert.equal(b.includes(verifier),false);assert.equal(b.includes(password),false);}assert.equal(JSON.stringify(out).includes(admin),false);assert.equal(JSON.stringify(out).includes('token'),false);
 const proof2=await operator(f,m).adapters.inspectStopped(f.plan);assert.equal(proof2.allContainersInspected,false);assert.equal(proof2.runningContainers,0);assert.equal(Object.hasOwn(proof2,'remainingContainers'),false);await assert.rejects(app.stage(f.input),closed);assert.equal(m.stageMutations,1);
});
test('deploy accepted with pending observer remains unknown; no automatic second deploy or credential generation',async t=>{
 const f=fixture(t),m=transport(f,{observer:()=>pending()}),{app}=operator(f,m),out=await app.stage(f.input);assert.equal(out.state,'outcome_unknown');assert.equal(out.cleanupVerified,true);assert.equal(out.proof,null);assert.equal(m.stageMutations,1);await assert.rejects(app.stage(f.input),closed);assert.equal(m.stageMutations,1);
});
test('lost create/env/deploy acknowledgement cleans only owned new service and never repeats the effect or exposes raw errors',async t=>{
 for(const lost of ['createComposeService','updateComposeEnv','deployComposeService']){const f=fixture(t),m=transport(f,{lost}),{app}=operator(f,m),out=await app.stage(f.input);assert.equal(out.state,'outcome_unknown');assert.equal(out.proof,null);assert.equal(m.calls.filter(c=>c.procedure===lost&&!(lost==='updateComposeEnv'&&c.private===false)).length,1);assert.equal(JSON.stringify(out).includes(admin),false);m.assertExisting();await assert.rejects(app.stage(f.input),closed);}
});
test('wrong key/corrupt capsule blocks ALL MCP calls, and invalid capacity admission blocks every mutation',async t=>{
 const f=fixture(t),m=transport(f),{app}=operator(f,m);await assert.rejects(app.stage({...f.input,privateKey:wrong.privateKey}),closed);assert.equal(m.calls.length,0);assert.equal(m.adminCalls,0);
 const g=fixture(t),n=transport(g,{admission:{capacityVerified:false}}),out=await operator(g,n).app.stage(g.input);assert.equal(out.state,'not_dispatched');assert.equal(n.calls.every(c=>c.executor==='execute_query'),true);assert.equal(n.adminCalls,0);
});
test('existing host collision and foreign mapping ID refuse before private dispatch; existing routes never change',async t=>{
 const f=fixture(t),m=transport(f);m.domainRows.push({...m.domainRows[0],host:f.plan.descriptor.domain.host});const out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'not_dispatched');assert.equal(m.calls.every(c=>c.executor==='execute_query'),true);assert.equal(m.adminCalls,0);m.assertExisting();
 const g=fixture(t),n=transport(g,{modify:({step,result,domainRows})=>{if(step==='createDomain')domainRows.at(-1).id=crypto.randomUUID();return result;}}),failed=await operator(g,n).app.stage(g.input);assert.equal(failed.state,'outcome_unknown');assert.equal(n.adminCalls,0);assert.equal(n.stageMutations,0);assert.equal(n.calls.filter(c=>c.procedure==='deleteDomain').length,0);n.assertExisting();
});
test('malformed/unbound envelopes, dangerous source drift and bad fences cannot produce successful dispatch/proof',async t=>{
 const f=fixture(t),m=transport(f);m.dependencies.execute=async request=>({structuredContent:{procedure:'wrong',result:null},content:[{type:'text',text:admin}]});const out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'not_dispatched');assert.equal(m.adminCalls,0);
 const g=fixture(t),n=transport(g);n.dependencies.fence=async(p,action)=>({schema:'crm-manager-read-remote-fence-v1',planSha256:p.planSha256,action,durable:false,firstAttempt:true});const bad=await operator(g,n).app.stage(g.input);assert.equal(bad.state,'not_dispatched');assert.equal(n.calls.length,0);
 const h=fixture(t),k=transport(h,{modify:({step,result})=>step==='inspectComposeService'?{...result,source:{type:'inline',content:'FOREIGN_SOURCE'}}:result}),unknown=await operator(h,k).app.stage(h.input);assert.equal(unknown.state,'outcome_unknown');assert.equal(k.adminCalls,0);assert.equal(k.stageMutations,0);
});
test('readonly restart uses same capsule/IDs/volumes, parks publicly without init, and cleanup prior stage needs no stage approval',async t=>{
 const f=fixture(t),m=transport(f,{observer:()=>pending()}),first=operator(f,m);await first.app.stage(f.input);assert.equal(m.stageMutations,1);const cipher=fs.readFileSync(path.join(f.directory,O.FILE));
 const rebuilt=R.buildStagePlan({suffix:f.plan.descriptor.serviceName.slice(-12),sources,intent:{...f.plan.intent},domainId:f.plan.descriptor.domain.id}),plan=R.buildReconcilePlan({suffix:crypto.randomBytes(6).toString('hex'),stagePlan:rebuilt,domainId:crypto.randomUUID()});assert.equal(rebuilt.planSha256,f.plan.planSha256);
 const n=transport(f);n.states=m.states;n.domainRows=m.domainRows;
 // Preserve actual fake remote state while using fresh callbacks/fence admission.
 n.dependencies.execute=m.dependencies.execute;n.dependencies.observeStatus=async q=>q.schema==='crm-manager-read-public-postcondition-request-v1'?JSON.stringify({schema:'crm-manager-read-public-postcondition-v1',mode:plan.mode,planSha256:plan.planSha256,sourcePinsSha256:crypto.createHash('sha256').update(JSON.stringify(C.PINS)).digest('hex'),nineSourcesPinned:true,sourceReadOnly:true,sourceRootOwned:true,sourceModesVerified:true,ledgerPhase:'original_intent_held',ledgerEmpty:false,originalIntentHeld:true,ledgerPrivateOwned:true,uid1000:true,noNewPrivileges:true,capabilitiesEmpty:true,rootReadOnly:true,privateEnvironmentAbsent:true,postgresConnected:false,runtimeExecuted:false}):verified();const app=operator(f,n,{stageApproved:false,readonlyReconcileApproved:true}).app;
 const out=await app.reconcile({plan,directory:f.directory,privateKey:pair.privateKey});assert.equal(out.state,'verified');assert.ok(cipher.equals(fs.readFileSync(path.join(f.directory,O.FILE))));const inputs=E.buildEasypanelInputs({remotePlan:plan});assert.deepEqual(Object.keys(JSON.parse(inputs.createPublicBootstrap.input.source.content).services),['public-park']);assert.equal(inputs.intent.operationId,f.plan.intent.operationId);assert.equal(inputs.intent.credentialIntentId,f.plan.intent.credentialIntentId);assert.equal(inputs.ledgerVolume,f.plan.descriptor.compose.volumes.ledger.name);assert.equal(m.stageMutations,1);assert.equal(m.readonly,1);m.assertExisting();
});

test('public postconditions are barriers twice: corrupt/missing first or second proof never obtains admin secret or dispatches PG',async t=>{
 for(const failAt of[1,2])for(const field of['planSha256','nineSourcesPinned','sourceReadOnly','ledgerEmpty','privateEnvironmentAbsent','postgresConnected','runtimeExecuted']){
  const f=fixture(t),m=transport(f,{publicObserver:(_q,raw,n)=>{if(n!==failAt)return raw;const v=JSON.parse(raw);v[field]=typeof v[field]==='boolean'?!v[field]:'b'.repeat(64);return JSON.stringify(v);}}),out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'outcome_unknown');assert.equal(out.proof,null);assert.equal(out.cleanupVerified,true);assert.equal(m.adminCalls,0);assert.equal(m.stageMutations,0);assert.equal(m.calls.filter(c=>c.private).length,0);assert.equal(m.calls.filter(c=>c.procedure==='updateComposeSourceInline'&&c.sourcePhase==='public').length,1);m.assertExisting();
 }
 const f=fixture(t),m=transport(f,{publicObserver:()=>null}),out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'outcome_unknown');assert.equal(m.adminCalls,0);assert.equal(m.stageMutations,0);
});
test('lost private deploy ACK holds original intent after exactly one private dispatch; public reenable never starts private source/env',async t=>{
 const f=fixture(t),m=transport(f,{lost:'deployComposeService',lostOccurrence:2}),out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'outcome_unknown');assert.equal(m.stageMutations,1);assert.equal(m.adminCalls,1);assert.equal(m.publicObservations.length,2);assert.equal(m.calls.filter(c=>c.procedure==='deployComposeService').length,2);assert.equal(m.calls.filter(c=>c.procedure==='startComposeService').length,1);await assert.rejects(operator(f,m).app.stage(f.input),closed);assert.equal(m.stageMutations,1);
});
test('transport materialization requires a branded private frame and public frame serialization never echoes env',()=>{
 assert.throws(()=>M.mcpArguments({executor:'execute_destructive',procedure:'updateComposeEnv',private:true,input:{env:admin}}),closed);
});

test('post-deploy source/env/domain drift cannot turn a generic status proof into successful activation',async t=>{
 for(const drift of['env','source','domain']){let observations=0;const f=fixture(t),m=transport(f,{observer:()=>{observations++;return verified();},modify:({step,result,states,domainRows})=>{if(step==='deployComposeService'){const state=states.get(f.plan.descriptor.projectName+'_'+f.plan.descriptor.serviceName);if(JSON.parse(state.source.content).services.gateway.command.at(-1)==='/review/supervisor.cjs'){if(drift==='env')state.env='';if(drift==='source')state.source={type:'inline',content:E.buildEasypanelInputs({remotePlan:f.plan}).updatePublicProbe.input.content};if(drift==='domain')domainRows.at(-1).serviceDestination.port=8080;}}return result;}}),out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'outcome_unknown');assert.equal(out.proof,null);assert.equal(observations,0);assert.equal(m.stageMutations,1);}
});

test('domain UUID collision under any other host refuses admission before create or private dispatch',async t=>{
 const f=fixture(t),m=transport(f);m.domainRows[0].id=f.plan.descriptor.domain.id;const original=JSON.stringify(m.domainRows),out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'not_dispatched');assert.equal(out.proof,null);assert.equal(m.calls.every(c=>c.executor==='execute_query'),true);assert.equal(m.adminCalls,0);assert.equal(m.stageMutations,0);assert.equal(JSON.stringify(m.domainRows),original);
});

test('DNS-equivalent uppercase or trailing-dot host collision refuses before creation',async t=>{
 for(const host of[p=>p.descriptor.domain.host.toUpperCase(),p=>p.descriptor.domain.host+'.']){const f=fixture(t),m=transport(f);m.domainRows.push({...m.domainRows[0],id:crypto.randomUUID(),host:host(f.plan)});const out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'not_dispatched');assert.equal(m.calls.every(c=>c.executor==='execute_query'),true);assert.equal(m.adminCalls,0);assert.equal(m.stageMutations,0);}
});


test('fresh volume policy V2 is explicit unknown existence and preserves all real-shaped MCP stage barriers',async t=>{
 const f=fixture(t),m=transport(f,{admission:{schema:'crm-manager-read-remote-admission-v2',newVolumesAbsent:false,volumeExistence:'unobserved',freshVolumeNamespaceVerified:true}}),out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'verified');assert.equal(m.stageMutations,1);assert.equal(m.publicObservations.length,2);assert.equal(m.adminCalls,1);assert.match(f.plan.descriptor.compose.volumes.source.name,/^shrigma-read-source-[a-f0-9]{32}$/);assert.equal(m.domainRows.length,1);m.assertExisting();await assert.rejects(operator(f,m).app.stage(f.input),closed);assert.equal(m.stageMutations,1);
});
test('invalid or falsely absent V2 receipts refuse before every MCP mutation and before admin custody',async t=>{
 for(const change of[{newVolumesAbsent:true},{volumeExistence:'absent'},{freshVolumeNamespaceVerified:false},{priorQuiescent:true},{capacityVerified:false}]){const f=fixture(t),m=transport(f,{admission:{schema:'crm-manager-read-remote-admission-v2',newVolumesAbsent:false,volumeExistence:'unobserved',freshVolumeNamespaceVerified:true,...change}}),out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'not_dispatched');assert.equal(m.calls.every(c=>c.executor==='execute_query'),true);assert.equal(m.adminCalls,0);assert.equal(m.stageMutations,0);m.assertExisting();}
 const f=fixture(t);O.sealNew({directory:f.directory,intent:f.intent,password,verifier,publicKey:pair.publicKey});const plan=R.buildReconcilePlan({suffix:'abcdef012345',stagePlan:f.plan,domainId:crypto.randomUUID()}),m=transport(f,{admission:{schema:'crm-manager-read-remote-admission-v2',volumeExistence:'unobserved',freshVolumeNamespaceVerified:true}}),{adapters}=operator(f,m);await assert.rejects(adapters.admit(plan),closed);assert.equal(m.calls.every(c=>c.executor==='execute_query'),true);assert.equal(m.adminCalls,0);
});


test('isolated project Stage routes every shaped MCP destination only to the new project and preserves existing routes',async t=>{
 const f=fixture(t);f.plan=R.buildStagePlan({suffix:f.plan.descriptor.serviceName.slice(-12),sources,intent:f.intent,domainId:f.plan.descriptor.domain.id,isolatedProject:true});f.input.plan=f.plan;const m=transport(f,{admission:{schema:'crm-manager-read-remote-admission-v2',newVolumesAbsent:false,volumeExistence:'unobserved',freshVolumeNamespaceVerified:true}}),native=m.dependencies.execute,destinations=[];
 m.dependencies.execute=async request=>{const args=M.mcpArguments(request),i=args.input;if(Object.hasOwn(i,'projectName'))destinations.push(i.projectName);if(i.serviceDestination)destinations.push(i.serviceDestination.projectName);if(args.procedure==='getDockerContainers')assert.ok(i.service.startsWith('crm-manager-stage-20261004_'));return native(request);};
 const out=await operator(f,m).app.stage(f.input);assert.equal(out.state,'verified');assert.ok(destinations.length>5);assert.equal(destinations.every(x=>x==='crm-manager-stage-20261004'),true);assert.equal(m.publicObservations.length,2);assert.equal(m.stageMutations,1);assert.equal(m.adminCalls,1);assert.equal(m.domainRows.length,1);m.assertExisting();assert.equal(m.states.get('crm-manager-stage-20261004_'+f.plan.descriptor.serviceName).enabled,false);
});
