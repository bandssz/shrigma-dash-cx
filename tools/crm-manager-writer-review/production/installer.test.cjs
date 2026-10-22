'use strict';
// Synthetic SQL client; genuine local filesystem. UID is lab-adapted to 1000.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),events=require('node:events');
const I=require('./installer.cjs');
const SECRET='SYNTHETIC_PRIVATE_PASSWORD_NEVER_OUTPUT',ID='11111111-1111-4111-8111-111111111111';
function wrap(st){return new Proxy(st,{get(t,k){if(k==='uid')return 1000;const v=t[k];return typeof v==='function'?v.bind(t):v;}});}
const f={...fs,lstatSync:p=>wrap(fs.lstatSync(p)),fstatSync:fd=>wrap(fs.fstatSync(fd))};
function state(phase){return{issuerRows:phase==='empty'?0:1,issuerMatches:phase!=='empty',issuerActive:phase==='active',subjects:phase==='active'?1:0,operations:phase==='active'?3:0,generations:phase==='active'?1:0,liveKeys:phase==='active'?1:0,serviceScram:phase!=='empty',ownerPasswordAbsent:true,serviceSessions:0,serviceLogin:phase!=='empty',ownerNoLogin:true,serviceRestricted:true,ownerRestricted:true};}
function fixture(t,o={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'writer-production-synthetic-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const phase=o.readPhase||'active',action=o.action||'install',plan=I.buildPlan(action,phase);let installed=!!o.installed,txOld=installed,committed=false,afterMutation=false;const calls=[],flags={connected:0,mutations:0,commits:0,destroyed:0};
 class Client extends events.EventEmitter{
 constructor(p){super();this.connectionParameters={...p,...(o.badHost?{host:'wrong'}:{})};this.connection={stream:{destroy:()=>flags.destroyed++}};}
 async connect(){flags.connected++;}
 async end(){}
 async query(q){const sql=typeof q==='string'?q:q.text;calls.push(sql);
  if(sql===plan.budget.text)return{command:'SET',rows:[]};
  if(sql==="SELECT current_setting('transaction_timeout') AS transaction_timeout")return{command:'SELECT',rows:[{transaction_timeout:o.badBudget?'0':'500ms'}]};
  if(sql.startsWith('SELECT pg_backend_pid'))return{command:'SELECT',rows:[{pid:o.pid||400,startMicros:'1791000000000000'}]};
  if(sql.includes('AS original_backend_absent'))return{command:'SELECT',rows:[{original_backend_absent:!o.originalStillAlive}]};
  if(sql.startsWith('BEGIN')){txOld=installed;committed=false;return{command:'BEGIN',rows:[]};}
  if(sql===plan.rollback.text){if(!committed)installed=txOld;return{command:'ROLLBACK',rows:[]};}
  if(sql===plan.commit.text){flags.commits++;committed=true;if(o.lostCommitAck)throw Error(SECRET);return{command:'COMMIT',rows:[]};}
  if(sql===plan.readback.text){const s=state(phase);if(o.badReadState)s.issuerMatches=false;if(o.liveReadSession)s.serviceSessions=1;if(o.readStateChanged&&afterMutation)s.operations++;const readObjects={context_verified:true,...I.INSTALLED,...(phase!=='empty'?{no_login_roles:1,restricted_roles:1,passworded_roles:1}:{})};
   return[{command:'SELECT',rows:[{profile_sha256:o.badReadCore?'f'.repeat(64):I.READ_CORE}]},{command:'SELECT',rows:[readObjects]},{command:'SELECT',rows:[{state:s}]},{command:'SELECT',rows:[{legacy_sha256:o.legacyChanged&&afterMutation?'e'.repeat(64):'a'.repeat(64)}]},{command:'SELECT',rows:[{context_verified:true,...(installed?I.INSTALLED:I.ABSENT),...(o.writerRoleLogin?{no_login_roles:1}:{}),...(o.extraField?{password:SECRET}:{})}]}];}
  if(sql===plan.writerProfile.text)return[{command:'SELECT',rows:[{issuer_empty:!o.nonempty,subject_empty:true,operation_empty:true,generation_empty:true}]},{command:'SELECT',rows:[{profile_sha256:o.badWriterProfile?'b'.repeat(64):I.PROFILE}]}];
  if(sql===plan.mutating?.text){flags.mutations++;assert.equal(fs.existsSync(path.join(dir,'03-sql-intent.json')),true);assert.equal(I.parseProof(fs.readFileSync(path.join(dir,'03-sql-intent.json'),'utf8')).phase,'sql_dispatched');if(o.ddlRefused)throw Error(SECRET);if(o.pendingDDL)return new Promise(()=>{});installed=action==='install';afterMutation=true;return{command:'DO',rows:[]};}
  return{command:'DO',rows:[]};
 }
 }
 const config={enabled:true,action,readPhase:phase,operationId:ID,password:SECRET,proofDirectory:dir,...(action==='reconcile'?{originalProofDirectory:o.original}: {})};
 const deps={Client,fsImpl:f,getuid:()=>1000,now:()=>Date.UTC(2026,9,4),...(o.fastDeadline?{setTimeoutImpl:fn=>setTimeout(fn,5)}:{})};
 return{dir,flags,calls,config,deps,plan,runner:I.createWriterInstallRunner(config,deps)};
}
test('OFF and import are inert, no Client or source/file access',async()=>{let touched=0;const r=I.createWriterInstallRunner(undefined,{Client(){touched++}});assert.deepEqual(await r.run(),{schema:I.SCHEMA,phase:'disabled'});assert.equal(touched,0);assert.throws(()=>I.createWriterInstallRunner({enabled:false,password:SECRET}));});
for(const phase of ['empty','staged','active'])test('install preserves exact READ '+phase+' state and durable intent before one DDL',async t=>{
 const x=fixture(t,{readPhase:phase});assert.equal(x.flags.connected,0);const promise=x.runner.run();assert.equal(x.runner.run(),promise);const p=await promise;assert.equal(p.phase,'verified_installed');assert.equal(p.readCoreSha256,I.READ_CORE);assert.equal(p.commitAcknowledged,true);assert.equal(x.flags.mutations,1);assert.equal(x.flags.commits,1);assert.equal(I.readProof(x.dir,{fsImpl:f}).phase,'verified_installed');
 assert.ok(x.calls.indexOf(x.plan.budget.text)<x.calls.findIndex(q=>q.startsWith('BEGIN')));assert.ok(x.calls.indexOf(x.plan.readGuard.text)<x.calls.indexOf(x.plan.mutating.text));assert.ok(x.calls.lastIndexOf(x.plan.legacyGuard.text)>x.calls.indexOf(x.plan.mutating.text));for(const n of fs.readdirSync(x.dir)){assert.equal(fs.statSync(path.join(x.dir,n)).mode&0o777,0o600);assert.equal(fs.readFileSync(path.join(x.dir,n),'utf8').includes(SECRET),false);}
});
test('verify and rollback differ, rollback removes only exact installed EMPTY WRITER',async t=>{const v=fixture(t,{action:'verify',installed:true});assert.equal((await v.runner.run()).phase,'verified_existing');assert.equal(v.flags.mutations,0);const r=fixture(t,{action:'rollback',installed:true});assert.equal((await r.runner.run()).phase,'verified_absent');assert.equal(r.flags.mutations,1);assert.match(r.plan.mutating.text,/DROP ROLE crm_manager_writer_service_v1/);assert.doesNotMatch(r.plan.mutating.text.replace(/--[^\n]*/g,''),/DROP ROLE crm_manager_provisioner|CASCADE|DROP OWNED/);});
for(const o of [{badHost:true},{badBudget:true},{badReadCore:true},{badReadState:true},{liveReadSession:true},{extraField:true},{writerRoleLogin:true},{nonempty:true,installed:true,action:'rollback'},{badWriterProfile:true,installed:true,action:'rollback'}])test('fresh preflight fails closed '+Object.keys(o)[0],async t=>{const x=fixture(t,o),p=await x.runner.run();assert.equal(x.flags.mutations,0);assert.ok(['setup_refused','preflight_refused'].includes(p.phase));assert.equal(JSON.stringify(p).includes(SECRET),false);});
for(const key of ['readStateChanged','legacyChanged','ddlRefused'])test('same TX '+key+' rollback before COMMIT, no retry',async t=>{const x=fixture(t,{[key]:true}),p=await x.runner.run();assert.equal(p.phase,'refused_rolled_back');assert.equal(x.flags.mutations,1);assert.equal(x.flags.commits,0);});
test('lost COMMIT ACK stays unknown even ROLLBACK acknowledgement; same intent read-only recovery',async t=>{
 const x=fixture(t,{lostCommitAck:true});const p=await x.runner.run();assert.equal(p.phase,'outcome_unknown');assert.equal(p.commitAcknowledged,false);assert.equal(x.flags.mutations,1);const r=fixture(t,{action:'reconcile',installed:true,original:x.dir,pid:401});const q=await r.runner.run();assert.equal(q.phase,'reconciled_installed');assert.equal(q.operationId,p.operationId);assert.equal(r.flags.mutations,0);assert.equal(r.flags.commits,0);assert.equal(r.calls.some(v=>v.includes('CREATE ROLE')),false);
 const live=fixture(t,{action:'reconcile',installed:true,original:x.dir,originalStillAlive:true,pid:402});assert.equal((await live.runner.run()).phase,'hold');assert.equal(live.flags.mutations,0);
});
test('ambiguous deadline cannot start second DDL and original intent persists',async t=>{const x=fixture(t,{pendingDDL:true,fastDeadline:true});assert.equal((await x.runner.run()).phase,'outcome_unknown');assert.equal(x.flags.mutations,1);assert.equal(I.readProof(x.dir,{fsImpl:f}).phase,'outcome_unknown');assert.ok(x.flags.destroyed>=1);});
test('original UUID/pins/binding and symlinks cannot be replaced during reconciliation',async t=>{const x=fixture(t,{lostCommitAck:true});await x.runner.run();const intent=path.join(x.dir,'03-sql-intent.json'),v=JSON.parse(fs.readFileSync(intent));v.operationId='22222222-2222-4222-8222-222222222222';fs.writeFileSync(intent,JSON.stringify(v));assert.throws(()=>I.readProof(x.dir,{fsImpl:f}));fs.unlinkSync(intent);fs.symlinkSync(path.join(x.dir,'01-prepared.json'),intent);assert.throws(()=>I.readProof(x.dir,{fsImpl:f}));});
test('source plan retains component bytes except outer transaction and closes every destination/scope',()=>{const p=I.buildPlan('install','active');assert.match(p.begin.text,/SERIALIZABLE/);assert.match(p.readGuard.text,/SHARE ROW EXCLUSIVE MODE NOWAIT/);assert.match(p.readGuard.text,/core='4f5b/);assert.match(p.readGuard.text,/issuerActive'='true/);assert.match(p.locks.text,/FOR UPDATE NOWAIT/);assert.doesNotMatch(p.mutating.text,/\nBEGIN;|\nCOMMIT;/);assert.match(p.mutating.text,/CREATE TABLE public.crm_manager_writer_issuer_v1/);assert.throws(()=>I.buildPlan('stage','active'));assert.throws(()=>I.buildPlan('install','unknown'));const c=I.connectionConfig(SECRET);assert.equal(c.host,'comunicacao_postgres');assert.equal(c.database,'listmonk');assert.equal(c.ssl,false);});
