'use strict';
// Own synthetic RSA4096 and fake private adapters only. No connector/PG/OCI.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),util=require('node:util');
const R=require('./remote-operator.cjs'),O=require('./operator.cjs'),C=require('../crm-manager-read-activation-review/compose/build-compose.cjs');
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:4096,publicExponent:65537}),wrong=crypto.generateKeyPairSync('rsa',{modulusLength:4096,publicExponent:65537});
const password='a7'.repeat(32),salt=Buffer.from('0123456789abcdef');
const salted=crypto.pbkdf2Sync(password,salt,4096,32,'sha256'),client=crypto.createHmac('sha256',salted).update('Client Key').digest();
const verifier='SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+crypto.createHash('sha256').update(client).digest('base64')+':'+crypto.createHmac('sha256',salted).update('Server Key').digest('base64');salted.fill(0);client.fill(0);
const sources=Object.fromEntries(Object.keys(C.PINS).map(n=>[n,fs.readFileSync(path.join(__dirname,'../crm-manager-read-activation-review/runtime',n),'utf8')]));
const proof={schema:'crm-manager-read-runtime-result-v1',action:'stage',state:'confirmed',phase:'staged',coreVerified:true,credentialBound:true,commitAck:true};
const verified=()=>({schema:'crm-manager-read-supervisor-v1',action:'stage',state:'verified',childExitConfirmed:true,proofBarrierConfirmed:true,proof:{...proof}});
const opaque=()=>({schema:'crm-manager-read-supervisor-v1',action:'stage',state:'outcome_unknown',childExitConfirmed:false,proofBarrierConfirmed:false,proof:null});
const closed=e=>e instanceof Error&&['READ_REMOTE_OPERATOR_REFUSED','READ_CREDENTIAL_CUSTODY_REFUSED','READ_RUNTIME_COMPOSE_PROPOSAL_REFUSED'].includes(e.message)&&e.cause===undefined;
function fixture(t){const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'read-remote-synthetic-')));fs.chmodSync(parent,0o700);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));const intent={schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action:'stage',fromPhase:'empty'},plan=R.buildStagePlan({suffix:crypto.randomBytes(6).toString('hex'),sources,intent,domainId:crypto.randomUUID()}),directory=path.join(parent,'capsule');return{parent,intent,plan,directory,input:{plan,directory,password,verifier,publicKey:pair.publicKey,privateKey:pair.privateKey}};}
function fake(f,overrides={}){
 const calls=[],environments=[],fences=new Set();
 function call(action,p){calls.push({action,mode:p.mode,sha:p.planSha256,service:p.descriptor.serviceName});}
 const effect=(p,action)=>({schema:'crm-manager-read-remote-effect-v1',planSha256:p.planSha256,action,accepted:true,projectName:p.descriptor.projectName,serviceName:p.descriptor.serviceName,ownedExact:true});
 const quiescent=p=>({schema:'crm-manager-read-mcp-quiescence-v1',planSha256:p.planSha256,serviceDisabled:true,envEmpty:true,runningContainers:0,testDomainAbsent:true,volumesNotDeletedByOperator:true,allContainersInspected:false});
 const adapters={
  async fence(p,action){call('fence:'+action,p);const c=O.openExisting({directory:f.directory,intent:p.intent,privateKey:pair.privateKey});assert.equal(c.verifier,verifier);assert.equal(c.durabilityBarrier,true);assert.equal(fs.readFileSync(path.join(f.directory,O.FILE),'utf8').includes(verifier),false);const id=p.planSha256+':'+action;if(fences.has(id))throw Error('SYNTHETIC_FENCE_OCCUPIED');fences.add(id);return{schema:'crm-manager-read-remote-fence-v1',planSha256:p.planSha256,action,durable:true,firstAttempt:true};},
  async admit(p){call('admit',p);return{schema:'crm-manager-read-remote-admission-v1',planSha256:p.planSha256,capacityVerified:true,targetAbsent:true,domainAbsent:true,imagePinned:true,nineSourcesPinned:true,newVolumesAbsent:p.mode==='execute',existingSourceVerified:p.mode==='reconcile',existingLedgerVerified:p.mode==='reconcile',priorQuiescent:p.mode==='reconcile'};},
  async create(p){call('create',p);assert.equal(p.descriptor.env,'');return effect(p,'create');},
  async configurePrivate(p,dto){call('configure-private',p);assert.equal(dto.READ_SERVICE_SCRAM,verifier);assert.equal(Object.keys(dto).includes('READ_SERVICE_SCRAM'),false);for(const view of [JSON.stringify(dto),util.inspect(dto)]){assert.equal(view.includes(verifier),false);assert.equal(view.includes(password),false);}assert.equal(dto.environment.READ_ACTIVATION_OPERATION_ID,f.intent.operationId);assert.equal(dto.environment.READ_CREDENTIAL_INTENT_ID,f.intent.credentialIntentId);assert.equal(dto.environment.READ_ACTIVATION_MODE,p.mode);assert.equal(dto.environment.READ_ACTIVATION_APPROVED_ACTION,p.mode==='execute'?'stage':'readonly-reconcile');assert.equal(dto.environment.PG_ADMIN_PASSWORD,undefined);environments.push(dto.environment);return effect(p,'configure-private');},
  async start(p){call('start',p);return effect(p,'start');},
  async observe(p){call('observe-GET-status',p);return verified();},
  async stop(p){call('stop',p);return effect(p,'stop');},
  async clearPrivate(p){call('clear-private',p);return effect(p,'clear-private');},
  async inspectStopped(p){call('inspect-stopped',p);return quiescent(p);}
 };
 for(const [k,fn] of Object.entries(overrides)){const original=adapters[k];adapters[k]=(p,...args)=>fn({p,args,original,calls,effect,quiescent});}
 return{adapters,calls,environments,fences};
}
const on=a=>R.createRemoteOperator({enabled:true,stageApproved:true,readonlyReconcileApproved:true},a);
const count=(calls,action)=>calls.filter(c=>c.action===action).length;

test('OFF needs no input/custody/adapters; approval and descriptor getters are closed before values are read',async t=>{
 const off=R.createRemoteOperator({enabled:false}),unused=new Proxy({}, {get(){throw Error('NO_INPUT_READ');}});assert.equal((await off.stage(unused)).state,'disabled');assert.equal((await off.reconcile(unused)).state,'disabled');
 let reads=0;const g={};Object.defineProperty(g,'enabled',{enumerable:true,get(){reads++;return true;}});assert.throws(()=>R.createRemoteOperator(g),closed);
 const f=fixture(t),m=fake(f),denied=R.createRemoteOperator({enabled:true,stageApproved:false,readonlyReconcileApproved:false},m.adapters);await assert.rejects(denied.stage(f.input),closed);await assert.rejects(denied.reconcile({}),closed);assert.equal(m.calls.length,0);assert.equal(fs.existsSync(f.directory),false);
 const bad={...sources};Object.defineProperty(bad,'cli.cjs',{enumerable:true,get(){reads++;return sources['cli.cjs'];}});assert.throws(()=>R.buildStagePlan({suffix:'a'.repeat(12),sources:bad,intent:f.intent,domainId:crypto.randomUUID()}),closed);
 const symbolic={...f.input,[Symbol('extra')]:password};await assert.rejects(on(m.adapters).stage(symbolic),closed);assert.equal(reads,0);assert.equal(m.calls.length,0);assert.equal(fs.existsSync(f.directory),false);
});

test('exclusive encrypted custody and readback precede every remote effect; verified requires proof plus disabled/empty env/zero RUNNING',async t=>{
 const f=fixture(t),m=fake(f);const result=await on(m.adapters).stage(f.input);assert.equal(result.state,'verified');assert.equal(result.cleanupVerified,true);assert.deepEqual(result.proof,proof);
 assert.deepEqual(m.calls.map(c=>c.action),['fence:custody-retained','admit','fence:create','create','fence:configure-private','configure-private','fence:start','start','observe-GET-status','fence:stop','stop','fence:clear-private','clear-private','inspect-stopped']);
 assert.equal(count(m.calls,'create'),1);assert.equal(count(m.calls,'start'),1);assert.equal(m.environments.length,1);assert.equal(JSON.stringify(result).includes(password),false);assert.equal(JSON.stringify(result).includes(verifier),false);assert.deepEqual(fs.readdirSync(f.directory),[O.FILE]);
 const before=fs.readFileSync(path.join(f.directory,O.FILE));await assert.rejects(on(m.adapters).stage(f.input),closed);assert.equal(count(m.calls,'create'),1);assert.ok(before.equals(fs.readFileSync(path.join(f.directory,O.FILE))));
});

test('lost create/configure/start acknowledgement never retries and always attempts owned cleanup',async t=>{
 for(const lost of ['create','configurePrivate','start']){let attempts=0;const f=fixture(t),m=fake(f,{[lost]:()=>{attempts++;throw Error('RAW_PRIVATE '+password+' '+verifier);}});const out=await on(m.adapters).stage(f.input);assert.equal(out.state,'outcome_unknown');assert.equal(out.cleanupVerified,true);assert.equal(out.proof,null);assert.equal(attempts,1);assert.equal(count(m.calls,'create'),lost==='create'?0:1);assert.equal(count(m.calls,'start'),0);assert.equal(count(m.calls,'stop'),1);assert.equal(count(m.calls,'clear-private'),1);assert.equal(JSON.stringify(out).includes(password),false);await assert.rejects(on(m.adapters).stage(f.input),closed);assert.equal(count(m.calls,'stop'),1);}
});

test('deploy ACK, pending, malformed proof, getter proof or failed cleanup cannot assert a successful stage',async t=>{
 let reads=0;const getter={...proof};Object.defineProperty(getter,'state',{enumerable:true,get(){reads++;return 'confirmed';}});
 const cases=[{observe:()=>opaque()},{observe:()=>({...opaque(),state:'pending'})},{observe:()=>({...verified(),proof:{...proof,phase:'active'}})},{observe:()=>({...verified(),proof:getter})},{inspectStopped:({p,quiescent})=>({...quiescent(p),envEmpty:false})},{inspectStopped:({p,quiescent})=>({...quiescent(p),runningContainers:1})},{inspectStopped:({p,quiescent})=>({...quiescent(p),allContainersInspected:true})},{stop:()=>{throw Error(verifier);}}];
 for(const overrides of cases){const f=fixture(t),m=fake(f,overrides),out=await on(m.adapters).stage(f.input);assert.equal(out.state,'outcome_unknown');assert.equal(out.proof,null);assert.equal(count(m.calls,'create'),1);}
 assert.equal(reads,0);
});

test('reconcile after unknown outcome reopens same capsule and reuses exact source/ledger without initializer or second stage mutation',async t=>{
 const f=fixture(t),first=fake(f,{observe:()=>opaque()});const unknown=await on(first.adapters).stage(f.input);assert.equal(unknown.state,'outcome_unknown');const bytes=fs.readFileSync(path.join(f.directory,O.FILE));
 // A fresh operator and rebuilt public plan model a restart, using persisted IDs.
 const saved=JSON.parse(JSON.stringify(f.plan.intent)),stage=R.buildStagePlan({suffix:f.plan.descriptor.serviceName.slice(-12),sources,intent:saved,domainId:f.plan.descriptor.domain.id});assert.equal(stage.planSha256,f.plan.planSha256);
 const plan=R.buildReconcilePlan({suffix:crypto.randomBytes(6).toString('hex'),stagePlan:stage,domainId:crypto.randomUUID()});assert.equal(plan.intent.operationId,f.intent.operationId);assert.equal(plan.intent.credentialIntentId,f.intent.credentialIntentId);assert.deepEqual(Object.keys(plan.descriptor.compose.services),['gateway']);assert.equal(plan.descriptor.compose.services.gateway.depends_on,undefined);assert.equal(plan.descriptor.compose.services.gateway.command.at(-1),'/review/supervisor.cjs');assert.equal(plan.descriptor.compose.volumes.source.name,f.plan.descriptor.compose.volumes.source.name);assert.equal(plan.descriptor.compose.volumes.ledger.name,f.plan.descriptor.compose.volumes.ledger.name);assert.equal(plan.descriptor.compose.volumes.source.external,true);assert.equal(plan.descriptor.compose.volumes.ledger.external,true);
 const m=fake(f),out=await on(m.adapters).reconcile({plan,directory:f.directory,privateKey:pair.privateKey});assert.equal(out.state,'verified');assert.ok(bytes.equals(fs.readFileSync(path.join(f.directory,O.FILE))));assert.equal(count(first.calls,'start'),1);assert.equal(count(m.calls,'start'),1);assert.deepEqual(m.calls.slice(0,7).map(c=>c.action),['fence:custody-retained','fence:prior-stop','stop','fence:prior-clear-private','clear-private','inspect-stopped','admit']);assert.equal(m.calls.filter(c=>c.action==='start')[0].mode,'reconcile');assert.equal(m.environments[0].READ_ACTIVATION_APPROVED_ACTION,'readonly-reconcile');
});

test('wrong key, changed intent, corrupted custody and prior non-quiescence prevent creating a reconcile executor',async t=>{
 const f=fixture(t),first=fake(f);await on(first.adapters).stage(f.input);const plan=R.buildReconcilePlan({suffix:'a'.repeat(12),stagePlan:f.plan,domainId:crypto.randomUUID()}),m=fake(f),api=on(m.adapters);
 await assert.rejects(api.reconcile({plan,directory:f.directory,privateKey:wrong.privateKey}),closed);assert.equal(m.calls.length,0);
 const foreign=R.buildStagePlan({suffix:'b'.repeat(12),sources,intent:{...f.intent,credentialIntentId:crypto.randomUUID()},domainId:crypto.randomUUID()}),foreignPlan=R.buildReconcilePlan({suffix:'c'.repeat(12),stagePlan:foreign,domainId:crypto.randomUUID()});await assert.rejects(api.reconcile({plan:foreignPlan,directory:f.directory,privateKey:pair.privateKey}),closed);assert.equal(m.calls.length,0);
 const file=path.join(f.directory,O.FILE),bytes=fs.readFileSync(file);fs.writeFileSync(file,'{');await assert.rejects(api.reconcile({plan,directory:f.directory,privateKey:pair.privateKey}),closed);assert.equal(m.calls.length,0);fs.writeFileSync(file,bytes);
 const bad=fake(f,{inspectStopped:({p,quiescent})=>({...quiescent(p),runningContainers:1})}),out=await on(bad.adapters).reconcile({plan,directory:f.directory,privateKey:pair.privateKey});assert.equal(out.state,'outcome_unknown');assert.equal(count(bad.calls,'create'),0);assert.equal(count(bad.calls,'start'),0);assert.equal(count(bad.calls,'stop'),1);
});

test('capacity/ownership/source flags or non-durable/reused fence refuse dispatch; no URLs/config imply readiness',async t=>{
 for(const flag of ['capacityVerified','targetAbsent','domainAbsent','imagePinned','nineSourcesPinned','newVolumesAbsent']){const f=fixture(t),m=fake(f,{admit:async({original,p})=>({...await original(p),[flag]:false})}),out=await on(m.adapters).stage(f.input);assert.equal(out.state,'not_dispatched');assert.equal(count(m.calls,'create'),0);assert.equal(count(m.calls,'start'),0);}
 for(const changed of [{durable:false},{firstAttempt:false},{planSha256:'f'.repeat(64)}]){const f=fixture(t),m=fake(f,{fence:async({original,p,args})=>({...await original(p,...args),...changed})}),out=await on(m.adapters).stage(f.input);assert.equal(out.state,'not_dispatched');assert.equal(count(m.calls,'create'),0);assert.equal(count(m.calls,'start'),0);}
});

test('public plans snapshot IDs/resources; only a pinned plan builder can admit stage/reconcile and private data never enters descriptors',async t=>{
 const f=fixture(t),before=f.plan.planSha256;f.intent.operationId=crypto.randomUUID();assert.equal(f.plan.intent.operationId,f.input.plan.intent.operationId);assert.notEqual(f.plan.intent.operationId,f.intent.operationId);assert.equal(Object.isFrozen(f.plan.intent),true);assert.equal(Object.isFrozen(f.plan.descriptor.compose.services.gateway),true);
 const g=f.plan.descriptor.compose.services.gateway;assert.equal(g.user,'1000:1000');assert.equal(g.read_only,true);assert.deepEqual(g.cap_drop,['ALL']);assert.deepEqual(g.security_opt,['no-new-privileges:true']);assert.equal(g.cpus,0.35);assert.equal(g.mem_limit,335544320);assert.equal(g.memswap_limit,g.mem_limit);assert.equal(g.pids_limit,64);assert.deepEqual(g.entrypoint,['timeout','-s','KILL','600']);assert.equal(g.restart,'no');assert.equal(g.volumes.find(v=>v.target==='/review').read_only,true);assert.equal(JSON.stringify(f.plan).includes(verifier),false);assert.equal(JSON.stringify(f.plan).includes(password),false);assert.equal(f.plan.planSha256,before);
 const m=fake(f);await assert.rejects(on(m.adapters).stage({...f.input,plan:JSON.parse(JSON.stringify(f.plan))}),closed);assert.equal(fs.existsSync(f.directory),false);assert.equal(m.calls.length,0);assert.throws(()=>R.buildReconcilePlan({suffix:f.plan.descriptor.serviceName.slice(-12),stagePlan:f.plan,domainId:crypto.randomUUID()}),closed);
});


test('held legacy intention cannot convert to isolated project by reusing flag/IDs/capsule; no second dispatch',async t=>{
 const f=fixture(t),first=fake(f,{observe:()=>opaque()}),held=await on(first.adapters).stage(f.input);assert.equal(held.state,'outcome_unknown');assert.equal(count(first.calls,'create'),1);const ciphertext=fs.readFileSync(path.join(f.directory,O.FILE));
 const p=R.buildStagePlan({suffix:f.plan.descriptor.serviceName.slice(-12),sources,intent:{...f.plan.intent},domainId:f.plan.descriptor.domain.id,isolatedProject:true});assert.equal(p.descriptor.projectName,'crm-manager-stage-20261004');assert.equal(f.plan.descriptor.projectName,'dashboard-image-20260930');assert.notEqual(p.planSha256,f.plan.planSha256);assert.deepEqual(p.intent,f.plan.intent);assert.equal(p.descriptor.compose.volumes.ledger.name,f.plan.descriptor.compose.volumes.ledger.name);
 const next=fake(f);await assert.rejects(on(next.adapters).stage({...f.input,plan:p}),closed);assert.equal(next.calls.length,0);assert.ok(ciphertext.equals(fs.readFileSync(path.join(f.directory,O.FILE))));assert.equal(count(first.calls,'create'),1);
 const original=R.buildReconcilePlan({suffix:'abcdef012345',stagePlan:f.plan,domainId:crypto.randomUUID()});assert.equal(original.descriptor.projectName,f.plan.descriptor.projectName);assert.equal(original.parentStage,f.plan);assert.equal(original.descriptor.compose.volumes.ledger.name,f.plan.descriptor.compose.volumes.ledger.name);
});
