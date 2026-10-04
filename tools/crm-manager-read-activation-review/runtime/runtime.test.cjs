'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const A=require('./activation.cjs'),R=require('./runtime.cjs'),{createJournal}=require('./journal.cjs');
const i=(action='stage')=>({schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action,fromPhase:action==='stage'?'empty':action==='activate'?'staged':'active'});
const verifier='SCRAM-SHA-256$4096:'+Buffer.alloc(16,1).toString('base64')+'$'+Buffer.alloc(32,2).toString('base64')+':'+Buffer.alloc(32,3).toString('base64');
function snapshot(phase){const login=['staged','active'].includes(phase),empty=phase==='empty';return {profileSha256:A.PROFILE,objects:{context_verified:true,...A.COUNTS,...(!empty?{no_login_roles:login?1:2,restricted_roles:login?1:2,passworded_roles:1}:{})},state:{issuerRows:empty?0:1,issuerMatches:!empty,issuerActive:phase==='active',subjects:0,operations:0,generations:0,liveKeys:0,serviceScram:!empty,ownerPasswordAbsent:true,serviceSessions:0,serviceLogin:login,ownerNoLogin:true,serviceRestricted:true,ownerRestricted:true}};}
const policy={schema:'crm-manager-read-activation-policy-v1',loggingVerified:true,preloadAbsent:true,pgcryptoPresent:true,pgcryptoVersionSupported:true,vectorPresent:false,auditPresent:false,unknownExtensionsPresent:false,extensionPolicySupported:true};
function fixture(t,{phase='empty',lostAck=false,matched=true,priorAbsent=true,failLog=false}={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'read-runtime-lab-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const journal=createJournal(dir,{uid:process.getuid()}),trace=[];let writes=0,connections=0,dbPhase=phase;
 function client(){let closed=false;return {async query(text,values){
  trace.push({text,hasSecret:values?.includes(verifier)===true});
  if(text===R.SESSION_SQL)return {rows:[{database_ok:true,actor_ok:true,version_ok:true,port_ok:true,tls_off:true,budget_ok:true,pid:100+connections,backend_start:'2026-10-03 12:00:00.123456+00'}]};
  if(text===R.PRIOR_SQL)return {rows:[{absent:priorAbsent}]};
  if(text===R.LEASE_SQL)return {rows:[{acquired:true}]};
  if(text===R.MATCH_SQL)return {rows:[{matched}]};
  if(text.includes("'crm-manager-read-activation-policy-v1'"))return {rows:[{policy:{...policy,loggingVerified:!failLog}}]};
  if(text.includes("set_config('shrigma.read.scram'"))return {rows:[{accepted:true}]};
  if(text===A.buildPlan('stage').readback.text){const s=snapshot(dbPhase);return [{rows:[{profile_sha256:s.profileSha256}]},{rows:[s.objects]},{rows:[{state:s.state}]}];}
  if(text.includes('/* MUTATION START */')){writes++;dbPhase=text.includes('LOGIN PASSWORD')?'staged':text.includes('SET active=true')?'active':'disabled';return {command:'DO',rows:[]};}
  if(text==='COMMIT;'){if(lostAck)throw Error('PRIVATE_CANARY_ERROR');return {command:'COMMIT',rows:[]};}
  return {command:'OK',rows:[{accepted:true}]};
 },async end(){closed=true;trace.push({end:closed});}};}
 const connect=async()=>{connections++;return client();},runtime=R.createRuntime({journal,connect});
 return {dir,journal,trace,runtime,connect,writes:()=>writes,connections:()=>connections,phase:()=>dbPhase};
}
test('intent and dispatch are durable before first mutation BEGIN; logging guard precedes secret; closed proof',async t=>{
 const f=fixture(t),q=i();const base=f.journal.append;
 const runtime=R.createRuntime({journal:{...f.journal,append(id,e){if(e.kind==='dispatch'){assert.equal(f.writes(),0);assert.equal(f.trace.some(e=>e.hasSecret),false);}return base(id,e);}},connect:async()=>{const db=await f.connect();return {query:async(text,values)=>{if(text.includes('/* MUTATION START */'))assert.equal(f.journal.load(q.operationId).events[0].kind,'dispatch');return db.query(text,values);},end:()=>db.end()};}});
 const result=await runtime.execute(q,{verifier});assert.equal(result.state,'confirmed');assert.equal(result.commitAck,true);assert.equal(f.writes(),1);
 const h=f.journal.load(q.operationId);assert.deepEqual(h.events.map(e=>e.kind),['dispatch','commit_ack','readback']);
 const firstSecret=f.trace.findIndex(e=>e.hasSecret),logs=f.trace.findIndex(e=>e.text?.startsWith("SET LOCAL log_statement='none'"));assert.ok(logs>=0&&logs<firstSecret);
 assert.deepEqual(Object.keys(result),['schema','action','state','phase','coreVerified','credentialBound','commitAck']);assert.ok(!JSON.stringify(h).includes(verifier));
});
test('lost COMMIT ACK stays unknown and reload uses READ ONLY without new mutation',async t=>{
 const f=fixture(t,{lostAck:true}),q=i();assert.equal((await f.runtime.execute(q,{verifier})).state,'outcome_unknown');assert.equal(f.writes(),1);
 const start=f.trace.length,result=await f.runtime.reconcile(q,{verifier});assert.equal(result.state,'confirmed');assert.equal(result.commitAck,false);assert.equal(f.writes(),1);assert.ok(f.trace.slice(start).some(e=>e.text?.includes('READ ONLY')));assert.ok(!f.trace.slice(start).some(e=>e.text?.includes('MUTATION START')));
 await assert.rejects(f.runtime.execute(q,{verifier}));assert.equal(f.writes(),1);
});
test('same-format different verifier cannot turn uncertain stage into confirmation',async t=>{
 const f=fixture(t,{lostAck:true,matched:false}),q=i();await f.runtime.execute(q,{verifier});assert.equal((await f.runtime.reconcile(q,{verifier})).state,'outcome_unknown');assert.equal(f.writes(),1);
});
test('live prior PG session holds reconciliation even when desired state is visible',async t=>{
 const f=fixture(t,{lostAck:true,priorAbsent:false}),q=i();await f.runtime.execute(q,{verifier});assert.equal((await f.runtime.reconcile(q,{verifier})).state,'outcome_unknown');assert.equal(f.writes(),1);
});
test('LOG_GUARD refusal binds no verifier and dispatches no mutation',async t=>{
 const f=fixture(t,{failLog:true}),result=await f.runtime.execute(i(),{verifier});assert.equal(result.state,'not_dispatched');assert.equal(f.writes(),0);assert.equal(f.trace.some(e=>e.hasSecret),false);
});
test('dispatch durability failure does not BEGIN mutation or send secret',async t=>{
 const f=fixture(t),q=i(),journal={...f.journal,append(){throw Error('PRIVATE_CANARY_ERROR');}};
 const r=R.createRuntime({journal,connect:f.connect});assert.equal((await r.execute(q,{verifier})).state,'not_dispatched');assert.equal(f.writes(),0);assert.equal(f.trace.some(e=>e.hasSecret),false);assert.equal(f.trace.some(e=>e.text?.includes('BEGIN ISOLATION LEVEL SERIALIZABLE')),false);
});
test('intent durability failure refuses all PG I/O',async t=>{
 const f=fixture(t),r=R.createRuntime({journal:{...f.journal,create(){throw Error('PRIVATE_CANARY_ERROR');}},connect:async()=>{assert.fail('PG I/O before durable intent');}});
 await assert.rejects(r.execute(i(),{verifier}));assert.equal(f.writes(),0);
});
test('ACK durability failure never claims persisted ACK; same attempt is reconciled read-only',async t=>{
 const f=fixture(t),q=i(),r=R.createRuntime({journal:{...f.journal,append(id,e){if(e.kind==='commit_ack')throw Error('PRIVATE_CANARY_ERROR');return f.journal.append(id,e);}},connect:f.connect});
 const result=await r.execute(q,{verifier});assert.equal(result.state,'outcome_unknown');assert.equal(result.commitAck,false);assert.equal(f.writes(),1);
 assert.equal((await f.runtime.reconcile(q,{verifier})).commitAck,false);assert.equal(f.writes(),1);
});
test('500ms is configured and read back before the first read-only BEGIN',async t=>{
 const f=fixture(t);await f.runtime.execute(i(),{verifier});const firstBegin=f.trace.findIndex(e=>e.text?.startsWith('BEGIN'));
 assert.equal(f.trace[0].text,"SET transaction_timeout='500ms'");assert.equal(f.trace[1].text,R.SESSION_SQL);assert.ok(firstBegin>1);
});
test('activate requires exact RAM credential binding before any mutation',async t=>{
 const f=fixture(t,{phase:'staged',matched:false});const result=await f.runtime.execute(i('activate'),{verifier});assert.equal(result.state,'not_dispatched');assert.equal(f.writes(),0);
});
test('disable never binds secret, preserves public receipt history',async t=>{
 const f=fixture(t,{phase:'active'}),q=i('disable');const result=await f.runtime.execute(q);assert.equal(result.state,'confirmed');assert.equal(result.credentialBound,false);assert.equal(f.trace.some(e=>e.hasSecret),false);assert.equal(f.journal.load(q.operationId).events[0].kind,'dispatch');
});
test('closed journal rejects occupied operation, symlink, extra fields and wrong UID/mode',t=>{
 const f=fixture(t),q=i();f.journal.create(q);assert.throws(()=>f.journal.create(q));assert.throws(()=>f.journal.append(q.operationId,{kind:'commit_ack',secret:'sentinel'}));
 const name=path.join(f.dir,q.operationId,'01.json');fs.symlinkSync('00.json',name);assert.throws(()=>f.journal.load(q.operationId));fs.unlinkSync(name);
 fs.chmodSync(path.join(f.dir,q.operationId,'00.json'),0o644);assert.throws(()=>f.journal.load(q.operationId));assert.throws(()=>createJournal(f.dir,{uid:process.getuid()+1}));
});
test('import is inert and fixed destination cannot be selected by browser or environment',()=>{
 const {DESTINATION}=require('./cli.cjs');assert.deepEqual(DESTINATION,{host:'comunicacao_postgres',port:5432,database:'listmonk',user:'postgres',ssl:false});assert.equal(Object.isFrozen(DESTINATION),true);
 assert.throws(()=>R.intent({...i(),action:'writer'}));assert.throws(()=>R.intent({...i(),host:'other'}));
});
