'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const F=require('./effect-fence.cjs'),R=require('./remote-operator.cjs'),C=require('../crm-manager-read-activation-review/compose/build-compose.cjs');
const sources=Object.fromEntries(Object.keys(C.PINS).map(n=>[n,fs.readFileSync(path.join(__dirname,'../crm-manager-read-activation-review/runtime',n),'utf8')]));
function fixture(t){const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'read-effect-synthetic-')));fs.chmodSync(parent,0o700);t.after(()=>fs.rmSync(parent,{force:true,recursive:true}));const directory=path.join(parent,'effects');fs.mkdirSync(directory,{mode:0o700});const plan=R.buildStagePlan({suffix:crypto.randomBytes(6).toString('hex'),sources,intent:{schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action:'stage',fromPhase:'empty'},domainId:crypto.randomUUID()});return{parent,directory,plan,fence:F.openEffectFence({directory}),file:action=>path.join(directory,crypto.createHash('sha256').update(plan.planSha256+':'+action).digest('hex')+'.json')};}
const closed=e=>e instanceof Error&&e.message==='READ_EFFECT_FENCE_REFUSED'&&e.cause===undefined;
test('exclusive record fsync/reopen barrier precedes effect; restart preserves public hold and refuses replay',t=>{
 const f=fixture(t),original=fs.fsyncSync;let syncs=0,effects=0;fs.fsyncSync=fd=>{syncs++;return original(fd);};
 let receipt;try{receipt=f.fence.fence(f.plan,'create');assert.ok(syncs>=4);effects++;}finally{fs.fsyncSync=original;}
 assert.equal(effects,1);assert.equal(receipt.firstAttempt,true);assert.equal(receipt.durable,true);assert.equal(fs.statSync(f.file('create')).mode&0o7777,0o600);const before=fs.readFileSync(f.file('create'));
 const restarted=F.openEffectFence({directory:f.directory});assert.equal(restarted.inspect(f.plan,'create').replayAllowed,false);assert.equal(restarted.inspect(f.plan,'create').scope.credentialIntentId,f.plan.intent.credentialIntentId);assert.throws(()=>restarted.fence(f.plan,'create'),closed);assert.ok(before.equals(fs.readFileSync(f.file('create'))));assert.equal(effects,1);
 const record=JSON.parse(before);assert.deepEqual(Object.keys(record).sort(),['action','planSha256','schema','scope']);assert.equal(before.includes(Buffer.from('READ_SERVICE_SCRAM')),false);assert.equal(before.includes(Buffer.from('PG_ADMIN_PASSWORD')),false);assert.equal(before.includes(Buffer.from('node -e')),false);
});
test('failed durability leaves immutable hold, causes zero effects and never overwrites/retries or claims completion',t=>{
 const f=fixture(t),original=fs.fsyncSync;let effects=0;fs.fsyncSync=()=>{throw Error('SYNTHETIC_FSYNC_FAIL');};
 try{assert.throws(()=>{f.fence.fence(f.plan,'start');effects++;},closed);}finally{fs.fsyncSync=original;}
 assert.equal(effects,0);assert.ok(fs.existsSync(f.file('start')));const before=fs.readFileSync(f.file('start'));assert.throws(()=>f.fence.fence(f.plan,'start'),closed);assert.ok(before.equals(fs.readFileSync(f.file('start'))));assert.equal(f.fence.inspect(f.plan,'start').replayAllowed,false);
});
test('weak modes, symlink/hardlink or occupied/partial records are refused without overwrite or cross-target reads',t=>{
 const f=fixture(t);fs.chmodSync(f.directory,0o755);assert.throws(()=>f.fence.fence(f.plan,'start'),closed);fs.chmodSync(f.directory,0o700);assert.equal(fs.readdirSync(f.directory).length,0);
 const sentinel=path.join(f.parent,'sentinel');fs.writeFileSync(sentinel,'SENTINEL',{mode:0o600});fs.symlinkSync(sentinel,f.file('start'));assert.throws(()=>f.fence.fence(f.plan,'start'),closed);assert.throws(()=>f.fence.inspect(f.plan,'start'),closed);assert.equal(fs.readFileSync(sentinel,'utf8'),'SENTINEL');fs.unlinkSync(f.file('start'));
 fs.writeFileSync(f.file('start'),'{',{mode:0o600});assert.throws(()=>f.fence.fence(f.plan,'start'),closed);assert.throws(()=>f.fence.inspect(f.plan,'start'),closed);assert.equal(fs.readFileSync(f.file('start'),'utf8'),'{');fs.unlinkSync(f.file('start'));
 f.fence.fence(f.plan,'start');const link=path.join(f.parent,'linked');fs.linkSync(f.file('start'),link);assert.throws(()=>f.fence.inspect(f.plan,'start'),closed);fs.unlinkSync(link);fs.chmodSync(f.file('start'),0o644);assert.throws(()=>f.fence.inspect(f.plan,'start'),closed);
});
test('changed plan/hash/scope/action and getters/symbols cannot create a record; same ledger reconcile has separate public fences',t=>{
 const f=fixture(t);let reads=0;const bad=JSON.parse(JSON.stringify(f.plan));bad.intent.operationId=crypto.randomUUID();assert.throws(()=>f.fence.fence(bad,'start'),closed);
 const getter={...f.plan};Object.defineProperty(getter,'descriptor',{enumerable:true,get(){reads++;return f.plan.descriptor;}});assert.throws(()=>f.fence.fence(getter,'start'),closed);assert.equal(reads,0);assert.throws(()=>f.fence.fence({...f.plan,[Symbol('extra')]:true},'start'),closed);assert.throws(()=>f.fence.fence(f.plan,'../../other'),closed);assert.equal(fs.readdirSync(f.directory).length,0);
 const rec=R.buildReconcilePlan({suffix:crypto.randomBytes(6).toString('hex'),stagePlan:f.plan,domainId:crypto.randomUUID()});f.fence.fence(f.plan,'stop');f.fence.fence(rec,'prior-stop');assert.equal(f.fence.inspect(rec,'prior-stop').scope.ledgerVolume,f.plan.descriptor.compose.volumes.ledger.name);assert.equal(f.fence.inspect(rec,'prior-stop').scope.operationId,f.plan.intent.operationId);assert.equal(fs.readdirSync(f.directory).length,2);
});
