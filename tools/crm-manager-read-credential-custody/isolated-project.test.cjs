"use strict";
// Closed project opt-in and public destinations only. No connector/PG/OCI.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const R=require('./remote-operator.cjs'),E=require('./easypanel-plan.cjs'),P=require('./public-postcondition.cjs'),F=require('./effect-fence.cjs'),C=require('../crm-manager-read-activation-review/compose/build-compose.cjs');
const LEGACY='dashboard-image-20260930',ISOLATED='crm-manager-stage-20261004',suffix='0123456789ab';
const sources=Object.fromEntries(Object.keys(C.PINS).map(n=>[n,fs.readFileSync(path.join(__dirname,'../crm-manager-read-activation-review/runtime',n),'utf8')]));
const raw=()=>({suffix,sources,intent:{schema:'crm-manager-read-runtime-intent-v1',operationId:'11111111-1111-4111-8111-111111111111',credentialIntentId:'22222222-2222-4222-8222-222222222222',action:'stage',fromPhase:'empty'},domainId:'33333333-3333-4333-8333-333333333333'});
const plan=isolated=>R.buildStagePlan({...raw(),...(isolated?{isolatedProject:true}:{})});
const clone=v=>JSON.parse(JSON.stringify(v)),canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const rehash=p=>{const body={schema:p.schema,mode:p.mode,intent:p.intent,descriptor:p.descriptor,parentStage:p.parentStage};p.planSha256=crypto.createHash('sha256').update(canonical(body)).digest('hex');return p;};
const refused=fn=>assert.throws(fn,e=>/^READ_(?:REMOTE_OPERATOR|EFFECT_FENCE|RUNTIME_COMPOSE_PROPOSAL)_REFUSED$/.test(e.message)&&e.cause===undefined);
function fence(t){const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'read-isolated-project-')));fs.chmodSync(parent,0o700);const directory=path.join(parent,'effects');fs.mkdirSync(directory,{mode:0o700});t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));return F.openEffectFence({directory});}

test('explicit isolated Compose project is literal and preserves initializer/resources/host/shared network',()=>{
 const input={suffix,sources,volumeNamespace:'a'.repeat(32)},legacy=C.buildCompose(input),p=C.buildCompose({...input,isolatedProject:true});assert.equal(C.PROJECT,LEGACY);assert.equal(C.ISOLATED_PROJECT,ISOLATED);assert.equal(legacy.projectName,LEGACY);assert.equal(p.projectName,ISOLATED);assert.equal(p.serviceName,legacy.serviceName);assert.deepEqual(p.domain,legacy.domain);assert.ok(p.domain.host.length<=63);
 assert.deepEqual(p.compose.services['init-volumes'],legacy.compose.services['init-volumes']);assert.deepEqual(p.compose.volumes,legacy.compose.volumes);assert.deepEqual(p.compose.networks,legacy.compose.networks);assert.equal(p.compose.networks.easypanel.name,'easypanel');assert.equal(p.compose.networks.easypanel.external,true);assert.deepEqual(p.sourcePins,legacy.sourcePins);assert.equal(p.image,legacy.image);
 const oldGateway=clone(legacy.compose.services.gateway),newGateway=clone(p.compose.services.gateway);delete oldGateway.networks;delete newGateway.networks;assert.deepEqual(newGateway,oldGateway);for(const alias of p.compose.services.gateway.networks.easypanel.aliases){assert.ok(alias.startsWith(ISOLATED+'_'));assert.ok(Buffer.byteLength(alias)<=63);}
});
test('isolated option admits only literal true; arbitrary project and accessor inputs refuse before getter execution',()=>{
 for(const value of[false,undefined,null,1,'true',ISOLATED,{}]){refused(()=>C.buildCompose({suffix,sources,isolatedProject:value}));refused(()=>R.buildStagePlan({...raw(),isolatedProject:value}));}
 refused(()=>C.buildCompose({suffix,sources,projectName:ISOLATED}));refused(()=>R.buildStagePlan({...raw(),projectName:ISOLATED}));
 let reads=0;for(const [fn,input]of[[C.buildCompose,{suffix,sources}],[R.buildStagePlan,raw()]]){Object.defineProperty(input,'isolatedProject',{enumerable:true,get(){reads++;return true;}});refused(()=>fn(input));}assert.equal(reads,0);
});
test('isolated Stage has stable explicit project binding and default legacy never silently converts',()=>{
 const legacy=plan(false),p=plan(true),rebuilt=R.buildStagePlan({...raw(),isolatedProject:true});assert.equal(legacy.descriptor.projectName,LEGACY);assert.equal(p.descriptor.projectName,ISOLATED);assert.equal(p.planSha256,rebuilt.planSha256);assert.notEqual(p.planSha256,legacy.planSha256);assert.equal(plan(false).planSha256,legacy.planSha256);
 assert.deepEqual(p.intent,legacy.intent);assert.deepEqual(p.descriptor.sourcePins,legacy.descriptor.sourcePins);assert.equal(p.descriptor.image,legacy.descriptor.image);assert.equal(p.descriptor.compose.volumes.source.name,legacy.descriptor.compose.volumes.source.name);assert.equal(p.descriptor.compose.volumes.ledger.name,legacy.descriptor.compose.volumes.ledger.name);assert.equal(R.assertFreshVolumeNamespace(p),true);
});
test('all E/P public and private destinations propagate the fixed new project without arbitrary target input',()=>{
 const p=plan(true),e=E.buildEasypanelInputs({remotePlan:p});assert.deepEqual(e.target,{projectName:ISOLATED,serviceName:p.descriptor.serviceName});
 for(const name of['createPublicBootstrap','inspect','inspectDomains','updatePublicProbe','startPublicProbe','updatePrivateSource','deployOnce','stop','clearEnvironment'])assert.equal(e[name].input.projectName,ISOLATED);
 assert.equal(e.inspectRunning.input.service,ISOLATED+'_'+p.descriptor.serviceName);assert.equal(e.createTestDomain.input.serviceDestination.projectName,ISOLATED);assert.deepEqual(e.inspectDomainCollision.input,{});
 const g=P.buildPublicPostcondition({remotePlan:p});for(const alias of g.compose.services.gateway.networks.easypanel.aliases)assert.ok(alias.startsWith(ISOLATED+'_'));assert.equal(g.compose.volumes.source.name,p.descriptor.compose.volumes.source.name);assert.equal(g.postconditionExpected.planSha256,p.planSha256);
 const env=E.privateEnvInput({plan:e,publicFlags:{READ_ACTIVATION_RUNTIME_OPT_IN:'1',READ_ACTIVATION_MODE:'execute',READ_ACTIVATION_APPROVED_ACTION:'stage',READ_ACTIVATION_ACTION:'stage',READ_ACTIVATION_OPERATION_ID:p.intent.operationId,READ_CREDENTIAL_INTENT_ID:p.intent.credentialIntentId,READ_ACTIVATION_FROM_PHASE:'empty'},verifier:'SCRAM-SHA-256$4096:'+'A'.repeat(22)+'==$'+'A'.repeat(43)+'=:'+'A'.repeat(43)+'=',adminPassword:'SYNTHETIC_ONLY'});assert.equal(env.input.projectName,ISOLATED);assert.equal(Object.getOwnPropertyDescriptor(env.input,'env').enumerable,false);assert.equal(JSON.stringify(env).includes('SYNTHETIC_ONLY'),false);
});
test('reconcile inherits either exact parent project and refuses any project-switch flag',()=>{
 for(const isolated of[false,true]){const p=plan(isolated),input={suffix:'abcdef012345',stagePlan:p,domainId:'44444444-4444-4444-8444-444444444444'},r=R.buildReconcilePlan(input);assert.equal(r.descriptor.projectName,p.descriptor.projectName);assert.equal(r.parentStage,p);assert.equal(r.intent,p.intent);assert.equal(r.descriptor.compose.volumes.source.name,p.descriptor.compose.volumes.source.name);assert.equal(r.descriptor.compose.volumes.ledger.name,p.descriptor.compose.volumes.ledger.name);assert.equal(r.descriptor.compose.services['init-volumes'],undefined);for(const alias of r.descriptor.compose.services.gateway.networks.easypanel.aliases)assert.ok(alias.startsWith(p.descriptor.projectName+'_'));refused(()=>R.buildReconcilePlan({...input,isolatedProject:true}));refused(()=>R.buildReconcilePlan({...input,projectName:ISOLATED}));}
});
test('new project durable fences preserve explicit scope and reject arbitrary project drift',t=>{
 const f=fence(t),p=plan(true);assert.equal(f.fence(p,'create').durable,true);assert.equal(f.inspect(p,'create').scope.projectName,ISOLATED);refused(()=>f.fence(plan(true),'create'));const fake=clone(p);fake.descriptor.projectName='arbitrary-stage-project';rehash(fake);refused(()=>f.fence(fake,'start'));
 const r=R.buildReconcilePlan({suffix:'abcdef012345',stagePlan:p,domainId:'44444444-4444-4444-8444-444444444444'});assert.equal(f.fence(r,'prior-stop').durable,true);assert.equal(f.inspect(r,'prior-stop').scope.projectName,ISOLATED);
});
test('reconcile fence refuses different parent project even when both projects are admitted and names/IDs match',t=>{
 const f=fence(t),p=plan(false),r=clone(R.buildReconcilePlan({suffix:'abcdef012345',stagePlan:p,domainId:'44444444-4444-4444-8444-444444444444'}));r.parentStage.descriptor.projectName=ISOLATED;rehash(r);refused(()=>f.fence(r,'prior-stop'));
});
