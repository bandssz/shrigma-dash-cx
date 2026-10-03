'use strict';
// Synthetic Client only. All filesystem operations target this test's own tmpdir.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),events=require('node:events');
const R=require('./run-install.cjs'),CANARY='SYNTHETIC_PRIVATE_PASSWORD_DO_NOT_OUTPUT',PROFILE=R.PROFILE;
const ABSENT={tables:0,relations:0,indexes:0,functions:0,types:0,roles:0,no_login_roles:0,restricted_roles:0,membership_edges:0,passworded_roles:0};
const INSTALLED={tables:4,relations:13,indexes:2,functions:7,types:8,roles:2,no_login_roles:2,restricted_roles:2,membership_edges:0,passworded_roles:0};
function wrapStat(s){return new Proxy(s,{get(target,key){if(key==='uid')return 1000;const v=target[key];return typeof v==='function'?v.bind(target):v;}});}
function fixture(t,opts={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'manager-install-runner-private-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const f={...fs,lstatSync:p=>wrapStat(fs.lstatSync(p)),fstatSync:fd=>wrapStat(fs.fstatSync(fd))};
 const calls=[],flags={connected:0,ended:0,destroyed:0,mutations:0,rollbacks:0};let installed=Boolean(opts.installed);
 class FakeClient extends events.EventEmitter{
  constructor(config){super();assert.match(config.options,/(?:^| )-c transaction_timeout=500$/);this.connectionParameters={...config};if(opts.badHost)this.connectionParameters.host='foreign';this.connection={stream:{destroy:()=>{flags.destroyed++;}}};}
  async connect(){flags.connected++;if(opts.connectError)throw Error(CANARY);}
  async end(){flags.ended++;if(opts.endError)throw Error(CANARY);}
  async query(sql){
   calls.push(sql);
   if(sql==='ROLLBACK'){flags.rollbacks++;return{command:'ROLLBACK',rows:[]};}
   if(sql==="SELECT current_setting('transaction_timeout') AS transaction_timeout")return{command:'SELECT',rows:[{transaction_timeout:opts.badTransactionLimit?'0':'500ms'}]};
   if(sql.includes('AS context_verified'))return[{command:'BEGIN',rows:[]},{command:'SELECT',rows:[{context_verified:!opts.contextFalse,...(installed?INSTALLED:ABSENT),...(opts.foreignField?{raw_secret:CANARY}:{})}]},{command:'ROLLBACK',rows:[]}];
   if(sql.includes('AS issuer_empty'))return[{command:'BEGIN',rows:[]},{command:'SELECT',rows:[{issuer_empty:!opts.nonempty,subject_empty:true,operation_empty:true,generation_empty:true}]},{command:'SELECT',rows:[{profile_sha256:opts.badProfile?'f'.repeat(64):PROFILE}]},{command:'ROLLBACK',rows:[]}];
   flags.mutations++;
   assert.equal(fs.existsSync(path.join(dir,'03-sql-intent.json')),true);
   const intent=R.parsePublicProof(fs.readFileSync(path.join(dir,'03-sql-intent.json'),'utf8'));assert.equal(intent.mutationAttempted,true);assert.equal(intent.phase,'sql_dispatched');
   if(opts.pendingMutation)return new Promise(()=>{});
   if(opts.refused)throw Object.assign(Error('MANAGER_INSTALL_REFUSED'),{code:'P0001'});
   if(opts.ambiguous){installed=true;throw Error(CANARY);}
   installed=!sql.includes('DROP ROLE crm_manager_provisioner;');
   if(opts.badAck)return{command:'SELECT',rows:[]};
   return[{command:'BEGIN',rows:[]},{command:'COMMIT',rows:[]}];
  }
 }
 const action=opts.action||'install',config={action,password:CANARY,proofDirectory:dir,consumersStopped:action==='rollback'};
 const adapters={Client:FakeClient,fsImpl:f,getuid:()=>1000,now:()=>Date.UTC(2026,9,3),...(opts.fastDeadline?{setTimeoutImpl:fn=>setTimeout(fn,10)}:{})};
 const runner=R.createInstallRunner(config,adapters);
 return{dir,f,calls,flags,runner,config,adapters};
}
test('factory is inert; install uses one exact mutating query and durable COMMIT plus independent verification',async t=>{
 const f=fixture(t);assert.equal(f.flags.connected,0);assert.deepEqual(fs.readdirSync(f.dir),[]);
 const first=f.runner.run();assert.equal(f.runner.run(),first);const proof=await first;
 assert.equal(proof.phase,'verified_installed');assert.equal(proof.commitAcknowledged,true);assert.equal(proof.profileSha256,PROFILE);assert.equal(proof.emptyTables,4);
 assert.equal(f.flags.mutations,1);assert.equal(f.flags.ended,1);assert.equal(f.flags.destroyed,1);
 assert.equal(R.readPublicProof(f.dir,{fsImpl:f.f}).phase,'verified_installed');
 for(const file of fs.readdirSync(f.dir)){assert.equal(fs.statSync(path.join(f.dir,file)).mode&0o7777,0o600);assert.equal(fs.readFileSync(path.join(f.dir,file),'utf8').includes(CANARY),false);}
});
test('verify and rollback are distinct closed actions; rollback requires stopped-consumer assertion',async t=>{
 const v=fixture(t,{action:'verify',installed:true});assert.equal((await v.runner.run()).phase,'verified_existing');assert.equal(v.flags.mutations,0);
 const r=fixture(t,{action:'rollback',installed:true});assert.throws(()=>R.createInstallRunner({...r.config,consumersStopped:false},r.adapters),/MANAGER_INSTALL_REVIEW_REFUSED/);
 const proof=await r.runner.run();assert.equal(proof.phase,'verified_absent');assert.equal(proof.commitAcknowledged,true);assert.equal(r.flags.mutations,1);assert.equal(r.calls.some(s=>s.includes('DROP ROLE crm_manager_provisioner;')),true);
});
test('fixed host, UID, directory permission, nonempty volume, context and schema drift refuse before mutation',async t=>{
 for(const option of [{badHost:true},{contextFalse:true},{foreignField:true},{installed:true},{installed:true,action:'rollback',nonempty:true},{installed:true,action:'rollback',badProfile:true}]){
  const f=fixture(t,option),proof=await f.runner.run();assert.equal(f.flags.mutations,0);assert.equal(['preflight_refused','setup_refused'].includes(proof.phase),true);assert.equal(JSON.stringify(proof).includes(CANARY),false);
 }
 const uid=fixture(t);const runner=R.createInstallRunner(uid.config,{...uid.adapters,getuid:()=>0});assert.equal((await runner.run()).phase,'setup_refused');assert.equal(uid.flags.connected,0);
 const permissions=fixture(t);fs.chmodSync(permissions.dir,0o755);assert.equal((await permissions.runner.run()).phase,'setup_refused');assert.equal(permissions.flags.connected,0);
 const existing=fixture(t);fs.writeFileSync(path.join(existing.dir,'existing-private-file'),CANARY);assert.equal((await existing.runner.run()).phase,'setup_refused');assert.equal(existing.flags.connected,0);assert.equal(fs.readFileSync(path.join(existing.dir,'existing-private-file'),'utf8'),CANARY);
});
test('a divergent server transaction budget refuses before catalog reads and mutation',async t=>{
 const f=fixture(t,{badTransactionLimit:true}),proof=await f.runner.run();
 assert.equal(proof.phase,'preflight_refused');assert.equal(f.flags.mutations,0);
 assert.deepEqual(f.calls,["SELECT current_setting('transaction_timeout') AS transaction_timeout"]);
 assert.equal(proof.contextVerified,false);assert.equal(proof.mutationAttempted,false);
});
test('SQL refusal is confirmed only by cleanup ROLLBACK; COMMIT ambiguity never retries or drops',async t=>{
 const refusal=fixture(t,{refused:true});assert.equal((await refusal.runner.run()).phase,'refused_rolled_back');assert.equal(refusal.flags.rollbacks,1);
 for(const option of [{ambiguous:true},{badAck:true}]){const f=fixture(t,option),proof=await f.runner.run();assert.equal(proof.phase,'outcome_unknown');assert.equal(f.flags.mutations,1);assert.equal(f.flags.rollbacks,0);assert.equal(f.calls.some(s=>s.includes('DROP ROLE')),false);assert.equal(JSON.stringify(proof).includes(CANARY),false);}
});
test('absolute deadline destroys pending connection, persists outcome_unknown and consumes end rejection',async t=>{
 const f=fixture(t,{pendingMutation:true,fastDeadline:true,endError:true}),proof=await f.runner.run();assert.equal(proof.phase,'outcome_unknown');assert.equal(f.flags.mutations,1);assert.equal(f.flags.destroyed,1);assert.equal(R.readPublicProof(f.dir,{fsImpl:f.f}).phase,'outcome_unknown');await new Promise(resolve=>setTimeout(resolve,0));
});
test('O_EXCL volume guard prevents repeat execution even through a new runner instance',async t=>{
 const f=fixture(t);await f.runner.run();const before=f.flags.connected;const next=R.createInstallRunner(f.config,f.adapters);assert.equal((await next.run()).phase,'setup_refused');assert.equal(f.flags.connected,before);assert.equal(R.readPublicProof(f.dir,{fsImpl:f.f}).phase,'verified_installed');
});
test('public proof parser rejects raw data, malformed JSON, wrong pins and contradictory claims without leaking input',async t=>{
 const f=fixture(t),proof=await f.runner.run();
 for(const value of [CANARY,{...proof,raw_error:CANARY},{...proof,sourcePins:{...proof.sourcePins,installer:CANARY}},{...proof,commitAcknowledged:false},{...proof,counts:{...proof.counts,env:CANARY}},{...proof,action:'verify'}])assert.throws(()=>R.parsePublicProof(value),e=>e.message==='MANAGER_INSTALL_REVIEW_REFUSED'&&!e.message.includes(CANARY));
 fs.unlinkSync(path.join(f.dir,'proof.json'));assert.equal(R.readPublicProof(f.dir,{fsImpl:f.f}).phase,'outcome_unknown');
});
test('crash after durable intent stays outcome_unknown even when its mutation field is false or incomplete',async t=>{
 for(const malformed of [false,true]){
  const f=fixture(t);await f.runner.run();fs.unlinkSync(path.join(f.dir,'proof.json'));fs.unlinkSync(path.join(f.dir,'04-sql-ack.json'));
  const file=path.join(f.dir,'03-sql-intent.json'),intent=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,malformed?'{"incomplete":':JSON.stringify({...intent,mutationAttempted:false}));
  const proof=R.readPublicProof(f.dir,{fsImpl:f.f});assert.equal(proof.phase,'outcome_unknown');assert.equal(proof.mutationAttempted,true);assert.equal(proof.durable,true);
 }
});
test('writer fsync failure never dispatches intent early; reader needs its own successful file and directory barrier',async t=>{
 const f=fixture(t);let syncs=0;
 const badFs={...f.f,fsyncSync:fd=>{syncs++;if(syncs===5)throw Error(CANARY);return fs.fsyncSync(fd);}};
 const runner=R.createInstallRunner(f.config,{...f.adapters,fsImpl:badFs}),proof=await runner.run();assert.equal(proof.phase,'outcome_unknown');assert.equal(f.flags.mutations,0);
 assert.throws(()=>R.readPublicProof(f.dir,{fsImpl:{...f.f,fsyncSync:()=>{throw Error(CANARY);}}}),e=>e.message==='MANAGER_INSTALL_REVIEW_REFUSED');
 const durable=R.readPublicProof(f.dir,{fsImpl:f.f});assert.equal(durable.durable,true);assert.equal(durable.phase,'outcome_unknown');assert.equal(JSON.stringify(durable).includes(CANARY),false);
});
test('final file valid before a failed writer fsync becomes evidence only after fresh reader durability barrier',async t=>{
 const f=fixture(t);let syncs=0;
 const runner=R.createInstallRunner(f.config,{...f.adapters,fsImpl:{...f.f,fsyncSync:fd=>{syncs++;if(syncs===9)throw Error(CANARY);return fs.fsyncSync(fd);}}});
 const proof=await runner.run();assert.equal(proof.durable,false);assert.equal(proof.phase,'outcome_unknown');assert.equal(f.flags.mutations,1);
 assert.throws(()=>R.readPublicProof(f.dir,{fsImpl:{...f.f,fsyncSync:()=>{throw Error(CANARY);}}}),e=>e.message==='MANAGER_INSTALL_REVIEW_REFUSED');
 assert.equal(R.readPublicProof(f.dir,{fsImpl:f.f}).phase,'verified_installed');
});
test('valid terminal false cannot erase earlier possible mutation, ACK or verified context',async t=>{
 const f=fixture(t),proof=await f.runner.run();
 const regressed=R.parsePublicProof({...proof,phase:'preflight_refused',contextVerified:false,mutationAttempted:false,commitAcknowledged:false});
 fs.writeFileSync(path.join(f.dir,'proof.json'),JSON.stringify(regressed));
 const observed=R.readPublicProof(f.dir,{fsImpl:f.f});
 assert.equal(observed.phase,'outcome_unknown');assert.equal(observed.contextVerified,true);assert.equal(observed.mutationAttempted,true);assert.equal(observed.commitAcknowledged,true);assert.equal(observed.durable,true);
});
test('verified terminal needs both valid preparation and context prefixes',async t=>{
 for(const name of ['01-prepared.json','02-context.json']){
  const f=fixture(t);await f.runner.run();fs.unlinkSync(path.join(f.dir,name));const observed=R.readPublicProof(f.dir,{fsImpl:f.f});
  assert.equal(observed.phase,'outcome_unknown');assert.equal(observed.mutationAttempted,true);assert.equal(observed.commitAcknowledged,true);
 }
});
test('ACK without valid intent becomes outcome_unknown; readonly verify rejects any intent or ACK file',async t=>{
 const ack=fixture(t);await ack.runner.run();fs.unlinkSync(path.join(ack.dir,'03-sql-intent.json'));
 const observed=R.readPublicProof(ack.dir,{fsImpl:ack.f});assert.equal(observed.phase,'outcome_unknown');assert.equal(observed.mutationAttempted,true);assert.equal(observed.commitAcknowledged,true);
 for(const name of ['03-sql-intent.json','04-sql-ack.json']){
  const v=fixture(t,{action:'verify',installed:true});await v.runner.run();fs.writeFileSync(path.join(v.dir,name),fs.readFileSync(path.join(ack.dir,name==='03-sql-intent.json'?'04-sql-ack.json':name)),{mode:0o600});
  assert.throws(()=>R.readPublicProof(v.dir,{fsImpl:v.f}),e=>e.message==='MANAGER_INSTALL_REVIEW_REFUSED');
 }
});
test('known SQL refusal with complete intent but no COMMIT ACK remains confirmed rolled back',async t=>{
 const f=fixture(t,{refused:true});await f.runner.run();const observed=R.readPublicProof(f.dir,{fsImpl:f.f});
 assert.equal(observed.phase,'refused_rolled_back');assert.equal(observed.contextVerified,true);assert.equal(observed.mutationAttempted,true);assert.equal(observed.commitAcknowledged,false);assert.equal(fs.existsSync(path.join(f.dir,'04-sql-ack.json')),false);
});
