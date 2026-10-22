"use strict";
// Public source-only boundaries. No network, Docker, PostgreSQL or real credentials.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const R=require('./remote-operator.cjs'),F=require('./effect-fence.cjs'),C=require('../crm-manager-read-activation-review/compose/build-compose.cjs');
const sources=Object.fromEntries(Object.keys(C.PINS).map(n=>[n,fs.readFileSync(path.join(__dirname,'../crm-manager-read-activation-review/runtime',n),'utf8')]));
const intent=()=>({schema:'crm-manager-read-runtime-intent-v1',operationId:'11111111-1111-4111-8111-111111111111',credentialIntentId:'22222222-2222-4222-8222-222222222222',action:'stage',fromPhase:'empty'});
const stage=(i=intent(),suffix='0123456789ab')=>R.buildStagePlan({suffix,sources,intent:i,domainId:'33333333-3333-4333-8333-333333333333'});
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const namespace=i=>sha('crm-manager-read-fresh-volume-namespace-v1\0'+i.operationId+'\0'+i.credentialIntentId).slice(0,32);
function receipt(p,v2=false){return{schema:'crm-manager-read-remote-admission-v'+(v2?'2':'1'),planSha256:p.planSha256,capacityVerified:true,targetAbsent:true,domainAbsent:true,imagePinned:true,nineSourcesPinned:true,newVolumesAbsent:p.mode==='execute'&&!v2,existingSourceVerified:p.mode==='reconcile',existingLedgerVerified:p.mode==='reconcile',priorQuiescent:p.mode==='reconcile',...(v2?{volumeExistence:'unobserved',freshVolumeNamespaceVerified:true}:{})};}
function fence(t){const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'read-fresh-policy-')));fs.chmodSync(parent,0o700);const directory=path.join(parent,'effects');fs.mkdirSync(directory,{mode:0o700});t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));return F.openEffectFence({directory});}
function rehash(p){const body={schema:p.schema,mode:p.mode,intent:p.intent,descriptor:p.descriptor,parentStage:p.parentStage};p.planSha256=sha(canonical(body));return p;}
const refused=fn=>assert.throws(fn,e=>/^READ_(?:REMOTE_OPERATOR|EFFECT_FENCE|RUNTIME_COMPOSE_PROPOSAL)_REFUSED$/.test(e.message)&&e.cause===undefined);

test('legacy two-field Compose API preserves original volumes, aliases and initializer',()=>{
 const p=C.buildCompose({suffix:'0123456789ab',sources});assert.equal(p.compose.volumes.source.name,'shrigma-read-source-0123456789ab');assert.equal(p.compose.volumes.ledger.name,'shrigma-read-stage-0123456789ab');
 assert.equal(p.serviceName,'mgr-stage-0123456789ab');assert.ok(Object.keys(p.compose.services.gateway.networks.easypanel.aliases).length);assert.equal(p.compose.services['init-volumes'].command.at(-1),C.buildInitializer(sources));
});
test('optional volume namespace is exactly32hex and never changes service/domain/initializer',()=>{
 for(const input of[null,undefined,{}])refused(()=>C.buildCompose(input));
 const old=C.buildCompose({suffix:'0123456789ab',sources}),ns='a'.repeat(32),p=C.buildCompose({suffix:'0123456789ab',sources,volumeNamespace:ns});assert.equal(p.compose.volumes.source.name,'shrigma-read-source-'+ns);assert.equal(p.compose.volumes.ledger.name,'shrigma-read-stage-'+ns);
 assert.equal(p.serviceName,old.serviceName);assert.deepEqual(p.domain,old.domain);assert.deepEqual(p.compose.services,old.compose.services);
 for(const value of['a'.repeat(12),'a'.repeat(31),'a'.repeat(33),'A'.repeat(32),{},undefined])refused(()=>C.buildCompose({suffix:'0123456789ab',sources,volumeNamespace:value}));
 let reads=0;const input={suffix:'0123456789ab',sources};Object.defineProperty(input,'volumeNamespace',{enumerable:true,get(){reads++;return ns;}});refused(()=>C.buildCompose(input));assert.equal(reads,0);
});
test('stage rebuild is stable and same service suffix with different intent produces disjoint128bit volumes',()=>{
 const i=intent(),p=stage(i),rebuilt=stage({...i});assert.equal(rebuilt.planSha256,p.planSha256);assert.equal(p.descriptor.compose.volumes.source.name,'shrigma-read-source-'+namespace(i));assert.equal(p.descriptor.compose.volumes.ledger.name,'shrigma-read-stage-'+namespace(i));assert.equal(R.assertFreshVolumeNamespace(p),true);
 for(const field of['operationId','credentialIntentId']){const other=stage({...i,[field]:crypto.randomUUID()});assert.notEqual(other.descriptor.compose.volumes.source.name,p.descriptor.compose.volumes.source.name);assert.notEqual(other.descriptor.compose.volumes.ledger.name,p.descriptor.compose.volumes.ledger.name);assert.equal(other.descriptor.serviceName,p.descriptor.serviceName);}
});
test('V1 actual absence remains required; V2 permits only fresh stage with explicit unobserved false-absence receipt',()=>{
 const p=stage();assert.equal(R.assertRemoteAdmission(receipt(p),p),true);refused(()=>R.assertRemoteAdmission({...receipt(p),newVolumesAbsent:false},p));assert.equal(R.assertRemoteAdmission(receipt(p,true),p),true);
 for(const change of[{newVolumesAbsent:true},{volumeExistence:'absent'},{freshVolumeNamespaceVerified:false},{existingSourceVerified:true},{existingLedgerVerified:true},{priorQuiescent:true},{capacityVerified:false},{targetAbsent:false},{domainAbsent:false},{imagePinned:false},{nineSourcesPinned:false},{planSha256:'f'.repeat(64)},{extra:true}])refused(()=>R.assertRemoteAdmission({...receipt(p,true),...change},p));
 let reads=0;const g=receipt(p,true);Object.defineProperty(g,'volumeExistence',{enumerable:true,get(){reads++;return'unobserved';}});refused(()=>R.assertRemoteAdmission(g,p));assert.equal(reads,0);
});
test('legacy48bit or incorrectly derived namespace cannot pass the V2 fresh-name precondition',()=>{
 const p=stage();for(const ns of['0123456789ab','b'.repeat(32)]){const fake=JSON.parse(JSON.stringify(p));fake.descriptor.compose.volumes.source.name='shrigma-read-source-'+ns;fake.descriptor.compose.volumes.ledger.name='shrigma-read-stage-'+ns;refused(()=>R.assertFreshVolumeNamespace(fake));}
 const fake=JSON.parse(JSON.stringify(p));fake.descriptor.compose.volumes.source.external=true;refused(()=>R.assertFreshVolumeNamespace(fake));
});
test('reconcile keeps exact original128bit names and requires V1 verified source/ledger/prior quiescence',()=>{
 const p=stage(),rec=R.buildReconcilePlan({suffix:'abcdef012345',stagePlan:p,domainId:'44444444-4444-4444-8444-444444444444'});assert.equal(rec.intent,p.intent);assert.equal(rec.descriptor.compose.volumes.source.name,p.descriptor.compose.volumes.source.name);assert.equal(rec.descriptor.compose.volumes.ledger.name,p.descriptor.compose.volumes.ledger.name);assert.equal(rec.descriptor.compose.volumes.source.external,true);assert.equal(rec.descriptor.compose.services['init-volumes'],undefined);assert.equal(R.assertRemoteAdmission(receipt(rec),rec),true);
 refused(()=>R.assertRemoteAdmission(receipt(rec,true),rec));for(const field of['existingSourceVerified','existingLedgerVerified','priorQuiescent'])refused(()=>R.assertRemoteAdmission({...receipt(rec),[field]:false},rec));
});
test('durable fresh fence binds namespace to original intent, refuses replay and preserves parent volumes on reconcile',t=>{
 const f=fence(t),p=stage();assert.equal(f.fence(p,'create').durable,true);assert.equal(f.inspect(p,'create').scope.sourceVolume,p.descriptor.compose.volumes.source.name);refused(()=>f.fence(stage({...p.intent}),'create'));
 const rec=R.buildReconcilePlan({suffix:'abcdef012345',stagePlan:p,domainId:'44444444-4444-4444-8444-444444444444'});assert.equal(f.fence(rec,'prior-stop').durable,true);assert.equal(f.inspect(rec,'prior-stop').scope.ledgerVolume,p.descriptor.compose.volumes.ledger.name);
 for(const mode of['execute','reconcile']){const fake=JSON.parse(JSON.stringify(mode==='execute'?p:rec));fake.descriptor.compose.volumes.source.name='shrigma-read-source-'+'b'.repeat(32);fake.descriptor.compose.volumes.ledger.name='shrigma-read-stage-'+'b'.repeat(32);rehash(fake);refused(()=>f.fence(fake,'start'));}
 const fake=JSON.parse(JSON.stringify(rec));fake.parentStage.descriptor.compose.volumes.source.name='shrigma-read-source-'+'c'.repeat(32);rehash(fake);refused(()=>f.fence(fake,'start'));
});
test('legacy public fence remains accepted with exact48bit service binding',t=>{
 const f=fence(t),i=intent(),descriptor=C.buildCompose({suffix:'0123456789ab',sources});descriptor.domain={...descriptor.domain,id:'33333333-3333-4333-8333-333333333333',certificateResolver:'',path:'/',wildcard:false,middlewares:[],internalProtocol:'http'};const p=rehash({schema:'crm-manager-read-remote-plan-v1',mode:'execute',intent:i,descriptor,parentStage:null});assert.equal(f.fence(p,'create').durable,true);const fake=JSON.parse(JSON.stringify(p));fake.descriptor.compose.volumes.source.name='shrigma-read-source-abcdef012345';fake.descriptor.compose.volumes.ledger.name='shrigma-read-stage-abcdef012345';rehash(fake);refused(()=>f.fence(fake,'start'));
});
