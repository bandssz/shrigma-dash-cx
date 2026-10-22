'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const ROOT=path.resolve(__dirname,'..'),A=require('../activation.cjs'),R=require('../runtime.cjs');
const verifier='SCRAM-SHA-256$4096:'+Buffer.alloc(16,11).toString('base64')+'$'+Buffer.alloc(32,12).toString('base64')+':'+Buffer.alloc(32,13).toString('base64');
function state(phase){const on=phase==='staged',empty=phase==='empty';return [{rows:[{profile_sha256:A.PROFILE}]},{rows:[{context_verified:true,...A.COUNTS,...(empty?{}:{no_login_roles:on?1:2,restricted_roles:on?1:2,passworded_roles:1})}]},{rows:[{state:{issuerRows:empty?0:1,issuerMatches:!empty,issuerActive:false,subjects:0,operations:0,generations:0,liveKeys:0,serviceScram:!empty,ownerPasswordAbsent:true,serviceSessions:0,serviceLogin:on,ownerNoLogin:true,serviceRestricted:true,ownerRestricted:true}}]}];}
function fixture(t,{failAckFsync=false,lostAck=false}={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(ROOT,'independent','lab-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const descriptors=new Map();let ackFsyncs=0,ackFailures=0,phase='empty',mutations=0,clients=0;
 const fileSystem={...fs,openSync(file,...args){const fd=fs.openSync(file,...args);descriptors.set(fd,file);return fd;},closeSync(fd){descriptors.delete(fd);return fs.closeSync(fd);},fsyncSync(fd){if(descriptors.get(fd)?.endsWith('/02.json')){if(failAckFsync&&ackFailures===0){ackFailures++;throw Error('SYNTHETIC_FSYNC_REFUSED');}ackFsyncs++;}return fs.fsyncSync(fd);}};
 const requireSource=createRequire(path.join(ROOT,'journal.cjs')),m={exports:{}};
 new vm.Script('(function(require,module,exports){'+fs.readFileSync(path.join(ROOT,'journal.cjs'),'utf8')+'\n})').runInThisContext()((n)=>n==='node:fs'?fileSystem:requireSource(n),m,m.exports);
 const journal=m.exports.createJournal(dir,{uid:process.getuid()});
 const policy={schema:'crm-manager-read-activation-policy-v1',loggingVerified:true,preloadAbsent:true,pgcryptoPresent:true,pgcryptoVersionSupported:true,vectorPresent:false,auditPresent:false,unknownExtensionsPresent:false,extensionPolicySupported:true};
 const readback=A.buildPlan('stage').readback.text;
 const runtime=R.createRuntime({journal,connect:async()=>{const pid=4000+(++clients);return {async query(text){
  if(text===R.SESSION_SQL)return {rows:[{database_ok:true,actor_ok:true,version_ok:true,port_ok:true,tls_off:true,budget_ok:true,pid,backend_start:'2026-10-03 16:00:00.123456+00'}]};
  if(text===R.PRIOR_SQL)return {rows:[{absent:true}]};
  if(text===R.LEASE_SQL)return {rows:[{acquired:true}]};
  if(text===R.MATCH_SQL)return {rows:[{matched:phase==='staged'}]};
  if(text===readback)return state(phase);
  if(text.includes("'crm-manager-read-activation-policy-v1'"))return {rows:[{policy}]};
  if(text.includes("set_config('shrigma.read.scram'"))return {rows:[{accepted:true}]};
  if(text.includes('/* MUTATION START */')){mutations++;phase='staged';return {command:'DO',rows:[]};}
  if(text==='COMMIT;'){if(lostAck)throw Error('SYNTHETIC_ACK_LOST');return {command:'COMMIT',rows:[]};}
  return {command:'ROLLBACK',rows:[]};
 },async end(){}};}});
 const intent={schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action:'stage',fromPhase:'empty'};
 return {runtime,intent,journal,ackFsyncs:()=>ackFsyncs,ackFailures:()=>ackFailures,mutations:()=>mutations};
}
test('lost ACK reconciles the original stage without retry or a fabricated ACK',async t=>{
 const f=fixture(t,{lostAck:true});assert.equal((await f.runtime.execute(f.intent,{verifier})).state,'outcome_unknown');
 const r=await f.runtime.reconcile(f.intent,{verifier});assert.equal(r.state,'confirmed');assert.equal(r.commitAck,false);assert.equal(f.mutations(),1);
});
test('ACK file fsync failure requires a prefix durability barrier before claiming commitAck',async t=>{
 const f=fixture(t,{failAckFsync:true});const before=await f.runtime.execute(f.intent,{verifier});assert.equal(before.state,'outcome_unknown');assert.equal(before.commitAck,false);assert.equal(f.ackFailures(),1);
 const r=await f.runtime.reconcile(f.intent,{verifier});assert.equal(r.state,'confirmed');assert.equal(f.mutations(),1);
 assert.equal(r.commitAck===true&&f.ackFsyncs()===0,false,'commitAck claimed without successful fsync of ACK file');
});
