'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),events=require('node:events');
const S=require('./supervisor.cjs'),R=require('../run-install.cjs');
const PRIVATE='SYNTHETIC_ADMIN_ONLY';
function proof(action='install',phase=action==='install'?'verified_installed':'verified_absent'){
 const absent=phase==='verified_absent';
 return {schema:'crm-manager-install-public-proof-v1',action,phase,recordedAt:'2026-10-03T00:00:00.000Z',sourcePins:R.PINS,contextVerified:true,mutationAttempted:action!=='verify',commitAcknowledged:action!=='verify',counts:{tables:absent?0:4,relations:absent?0:13,indexes:absent?0:2,functions:absent?0:7,types:absent?0:8,roles:absent?0:2,no_login_roles:absent?0:2,restricted_roles:absent?0:2,membership_edges:0,passworded_roles:0},profileSha256:absent?null:R.PROFILE,emptyTables:absent?null:4,durable:true};
}
function fixture({steps=[{},{}],action='install',raw=JSON.stringify(proof(action)),tamper=false}={}){
 const calls=[],killed=[];let timer,cleared=0;
 function spawn(node,args,options){
  const i=calls.length,step=steps[i]||{};calls.push({node,args,options,env:{...options.env}});
  const child=new events.EventEmitter();child.stdout=new events.EventEmitter();child.kill=signal=>{killed.push({i,signal});if(step.killClose)queueMicrotask(()=>child.emit('close',null,signal));return true;};
  if(step.error)queueMicrotask(()=>child.emit('error',Error(PRIVATE)));
  else if(!step.pending)queueMicrotask(()=>{if(i===1)child.stdout.emit('data',Buffer.from(raw));child.emit('close',step.code===undefined?0:step.code,step.signal===undefined?null:step.signal);});
  return child;
 }
 const runner=S.createSupervisor({action,password:PRIVATE},{spawn,setTimer:(fn,ms)=>{assert.equal(ms,45000);timer=fn;return 1;},clearTimer:id=>{assert.equal(id,1);cleared++;},readFile:file=>tamper?Buffer.from('tampered'):fs.readFileSync(file),nodePath:'/known/node'});
 return{runner,calls,killed,expire:()=>timer(),cleared:()=>cleared};
}
test('import and factory are inert; parent removes all administrative environment entries before validation',()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.runner.getStatus().state,'pending');
 const env={PGPASSWORD:PRIVATE,PATH:'/x',TZ:'UTC'};assert.equal(S.clearAdministrativeEnvironment(env),PRIVATE);assert.deepEqual(env,{PATH:'/x',TZ:'UTC'});
 const bad={PGPASSWORD:PRIVATE,PGHOST:'foreign',DATABASE_URL:PRIVATE,PATH:'/x'};assert.throws(()=>S.clearAdministrativeEnvironment(bad),/SUPERVISOR_REFUSED/);assert.deepEqual(bad,{PATH:'/x'});
});
test('one mutation child, independent durable reader and two confirmed exits gate readiness; parent childEnv immediately scrubbed',async()=>{
 const f=fixture(),p=f.runner.run();assert.equal(f.runner.run(),p);assert.equal(f.calls.length,1);assert.equal(Object.hasOwn(f.calls[0].options.env,'PGPASSWORD'),false);
 const state=await p;assert.equal(state.state,'verified');assert.equal(state.childExitConfirmed,true);assert.equal(state.proofBarrierConfirmed,true);assert.equal(f.calls.length,2);
 assert.equal(f.calls[0].env.PGPASSWORD,PRIVATE);assert.equal(Object.hasOwn(f.calls[1].env,'PGPASSWORD'),false);assert.equal(f.calls[0].env.NODE_OPTIONS,'--max-old-space-size=96');assert.equal(f.calls[1].env.NODE_OPTIONS,'--max-old-space-size=96');assert.deepEqual(f.calls[0].options.stdio,['ignore','ignore','ignore']);assert.deepEqual(f.calls[1].options.stdio,['ignore','pipe','ignore']);assert.deepEqual(f.calls[1].args.slice(1),['proof']);assert.equal(f.cleared(),1);assert.equal(JSON.stringify(state).includes(PRIVATE),false);
});
test('source drift refuses before spawning or opening any connection',async()=>{
 const f=fixture({tamper:true});assert.equal((await f.runner.run()).state,'proof_refused');assert.equal(f.calls.length,0);
});
test('nonzero, signalled or errored mutation child remains uncertain and never starts proof reader or retries',async()=>{
 for(const step of [{code:1},{code:0,signal:'SIGTERM'},{error:true}]){const f=fixture({steps:[step]});const state=await f.runner.run();assert.equal(state.state,'outcome_unknown');assert.equal(f.calls.length,1);assert.equal(state.proof,null);assert.equal(JSON.stringify(state).includes(PRIVATE),false);}
});
test('45s external deadline kills a stalled mutation child and resolves uncertain even if close never arrives',async()=>{
 const f=fixture({steps:[{pending:true}]}),p=f.runner.run();f.expire();assert.equal((await p).state,'outcome_unknown');assert.deepEqual(f.killed,[{i:0,signal:'SIGKILL'}]);assert.equal(f.calls.length,1);
});
test('the same 45s budget kills a stalled fsync proof reader; zero first-child exit does not create readiness',async()=>{
 const f=fixture({steps:[{},{pending:true}]}),p=f.runner.run();await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,2);f.expire();assert.equal((await p).state,'outcome_unknown');assert.deepEqual(f.killed,[{i:1,signal:'SIGKILL'}]);
});
test('wrong action, false durability, raw fields, bad source pin, missing ACK, oversized/invalid proof and failed reader all refuse readiness',async()=>{
 const base=proof();
 for(const raw of [PRIVATE,JSON.stringify({...base,durable:false}),JSON.stringify({...base,action:'verify'}),JSON.stringify({...base,raw_error:PRIVATE}),JSON.stringify({...base,sourcePins:{...base.sourcePins,installer:'f'.repeat(64)}}),JSON.stringify({...base,commitAcknowledged:false}),'x'.repeat(17000)]){const f=fixture({raw});const state=await f.runner.run();assert.equal(state.state,'proof_refused');assert.equal(state.proof,null);assert.equal(JSON.stringify(state).includes(PRIVATE),false);}
 const failed=fixture({steps:[{},{code:1}]});assert.equal((await failed.runner.run()).state,'proof_refused');
});
test('verify and rollback proof actions remain distinct from installation and retain exact rollback assertion',async()=>{
 const v=fixture({action:'verify',raw:JSON.stringify(proof('verify','verified_existing'))});assert.equal((await v.runner.run()).proof.phase,'verified_existing');
 const r=fixture({action:'rollback'});assert.equal((await r.runner.run()).proof.phase,'verified_absent');assert.deepEqual(r.calls[0].args.slice(1),['rollback','--consumers-stopped']);
 assert.throws(()=>S.acceptedProof(proof('rollback'),'install'),/SUPERVISOR_REFUSED/);
});
