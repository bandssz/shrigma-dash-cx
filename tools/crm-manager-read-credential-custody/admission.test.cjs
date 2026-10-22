'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const A=require('../crm-manager-read-activation-review/runtime/activation.cjs'),R=require('../crm-manager-read-activation-review/runtime/runtime.cjs'),{createJournal}=require('../crm-manager-read-activation-review/runtime/journal.cjs');
const i=(action='stage')=>({schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action,fromPhase:action==='stage'?'empty':action==='activate'?'staged':'active'});
const O=require('./operator.cjs'),D=require('./admission.cjs');const pair=crypto.generateKeyPairSync('rsa',{modulusLength:4096,publicExponent:65537}),wrong=crypto.generateKeyPairSync('rsa',{modulusLength:4096,publicExponent:65537}),password='a7'.repeat(32);const salt=Buffer.from('0123456789abcdef'),salted=crypto.pbkdf2Sync(password,salt,4096,32,'sha256'),client=crypto.createHmac('sha256',salted).update('Client Key').digest();const verifier='SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+crypto.createHash('sha256').update(client).digest('base64')+':'+crypto.createHmac('sha256',salted).update('Server Key').digest('base64');salted.fill(0);client.fill(0);
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

function custody(t,intent=i()){const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'read-custody-admission-synthetic-')));fs.chmodSync(parent,0o700);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));const directory=path.join(parent,'credential');return{parent,directory,intent,input:{directory,intent,password,verifier,publicKey:pair.publicKey,privateKey:pair.privateKey,approvedAction:'stage'},open:()=>O.openExisting({directory,intent,privateKey:pair.privateKey})};}
const closed=e=>e instanceof Error&&e.message==='READ_CREDENTIAL_CUSTODY_ADMISSION_REFUSED'&&e.cause===undefined;
const custodyClosed=e=>e instanceof Error&&e.message==='READ_CREDENTIAL_CUSTODY_REFUSED'&&e.cause===undefined;

test('admission retains/reopens before frozen runtime connect/BEGIN; lost ACK uses the same restarted intent only in READ ONLY',async t=>{
 const q=i(),c=custody(t,q),f=fixture(t,{lostAck:true});let factories=0;
 const make=receipt=>{factories++;assert.equal(receipt.durabilityBarrier,true);assert.equal(Object.hasOwn(receipt,'password'),false);assert.equal(Object.hasOwn(receipt,'verifier'),false);assert.equal(c.open().verifier,verifier);return R.createRuntime({journal:f.journal,connect:async()=>{assert.equal(c.open().verifier,verifier);const db=await f.connect();return{query:async(text,values)=>{if(text.includes('/* MUTATION START */')){assert.equal(c.open().password,password);assert.equal(f.journal.load(q.operationId).events[0].kind,'dispatch');}return db.query(text,values);},end:()=>db.end()};}});};
 const out=await D.retainAndExecute(c.input,{createRuntime:make});assert.equal(out.state,'outcome_unknown');assert.equal(out.commitAck,false);assert.equal(f.writes(),1);assert.equal(factories,1);
 const prior=f.trace.length,capsule=fs.readFileSync(path.join(c.directory,O.FILE));
 // A new wrapper and newly opened frozen journal simulate operator/runtime restart.
 const reopenJournal=createJournal(f.dir,{uid:process.getuid()});
 const re=await D.reconcileRetained({directory:c.directory,intent:q,privateKey:pair.privateKey,approvedAction:'readonly-reconcile'},{createRuntime:receipt=>{factories++;assert.equal(receipt.durabilityBarrier,true);return R.createRuntime({journal:reopenJournal,connect:async()=>{assert.equal(c.open().verifier,verifier);return f.connect();}});}});
 assert.equal(re.state,'confirmed');assert.equal(re.commitAck,false);assert.equal(f.writes(),1);assert.equal(factories,2);assert.ok(f.trace.slice(prior).some(v=>v.text?.includes('READ ONLY')));assert.equal(f.trace.slice(prior).some(v=>v.text?.includes('MUTATION START')),false);assert.ok(capsule.equals(fs.readFileSync(path.join(c.directory,O.FILE))));
 await assert.rejects(D.retainAndExecute(c.input,{createRuntime:make}),closed);assert.equal(factories,2);assert.equal(f.writes(),1);assert.equal(f.journal.load(q.operationId).intent.credentialIntentId,q.credentialIntentId);
});

test('every custody/admission failure withholds runtime factory/connect; no getter or malformed hidden field is invoked',async t=>{
 let calls=0,reads=0;const factory=()=>{calls++;assert.fail('runtime construction before admitted custody');};
 for(const kind of ['unapproved','getterInput','symbolInput','hiddenInput','getterIntent','symbolIntent','hiddenIntent','getterDeps','wrongPrivate','fsync','occupied','relative','wrongVerifier']){
  const c=custody(t),input={...c.input},deps={createRuntime:factory};
  if(kind==='unapproved')input.approvedAction='activate';
  if(kind==='getterInput')Object.defineProperty(input,'password',{enumerable:true,get(){reads++;throw Error(password);}});
  if(kind==='symbolInput')input[Symbol('hidden')]=password;
  if(kind==='hiddenInput')Object.defineProperty(input,'extra',{enumerable:false,value:password});
  if(kind==='getterIntent'){input.intent={...c.intent};Object.defineProperty(input.intent,'operationId',{enumerable:true,get(){reads++;throw Error(password);}});}
  if(kind==='symbolIntent'){input.intent={...c.intent,[Symbol('hidden')]:password};}
  if(kind==='hiddenIntent'){input.intent={...c.intent};Object.defineProperty(input.intent,'extra',{enumerable:false,value:password});}
  if(kind==='getterDeps')Object.defineProperty(deps,'createRuntime',{enumerable:true,get(){reads++;throw Error(password);}});
  if(kind==='wrongPrivate')input.privateKey=wrong.privateKey;
  if(kind==='occupied')fs.mkdirSync(c.directory,{mode:0o700});
  if(kind==='relative')input.directory='relative';
  if(kind==='wrongVerifier')input.verifier=verifier.replace('$4096:','$8192:');
  const sync=fs.fsyncSync;if(kind==='fsync')fs.fsyncSync=()=>{throw Error(password);};
  try{await assert.rejects(D.retainAndExecute(input,deps),closed);}finally{fs.fsyncSync=sync;}
 }
 assert.equal(reads,0);assert.equal(calls,0);
 const c=custody(t);O.sealNew({directory:c.directory,intent:c.intent,password,verifier,publicKey:pair.publicKey});
 for(const changes of [{intent:{...c.intent,credentialIntentId:crypto.randomUUID()}},{intent:{...c.intent,operationId:crypto.randomUUID()}},{approvedAction:'stage'},{privateKey:wrong.privateKey}])await assert.rejects(D.reconcileRetained({directory:c.directory,intent:c.intent,privateKey:pair.privateKey,approvedAction:'readonly-reconcile',...changes},{createRuntime:factory}),closed);
 const file=path.join(c.directory,O.FILE);fs.writeFileSync(file,'{');await assert.rejects(D.reconcileRetained({directory:c.directory,intent:c.intent,privateKey:pair.privateKey,approvedAction:'readonly-reconcile'},{createRuntime:factory}),closed);assert.equal(calls,0);
});

test('intent snapshot is frozen before async factory and cannot diverge between capsule and frozen runtime',async t=>{
 const q=i(),original={...q},c=custody(t,q),f=fixture(t);let seen;
 const out=await D.retainAndExecute(c.input,{createRuntime:async receipt=>{
  assert.equal(receipt.credentialIntentId,original.credentialIntentId);q.credentialIntentId=crypto.randomUUID();q.operationId=crypto.randomUUID();q.action='activate';q.fromPhase='staged';await Promise.resolve();
  return{execute:async(value,options)=>{seen=value;assert.equal(Object.isFrozen(value),true);assert.deepEqual(value,original);return f.runtime.execute(value,options);},reconcile:(value,options)=>f.runtime.reconcile(value,options)};
 }});
 assert.equal(out.state,'confirmed');assert.equal(f.writes(),1);assert.deepEqual(f.journal.load(original.operationId).intent,original);assert.equal(seen.credentialIntentId,original.credentialIntentId);
 const recovered=O.openExisting({directory:c.directory,intent:original,privateKey:pair.privateKey});assert.equal(recovered.verifier,verifier);assert.throws(()=>O.openExisting({directory:c.directory,intent:q,privateKey:pair.privateKey}),custodyClosed);
});

test('post-factory exceptions or unclosed result stay outcome_unknown and never expose raw error or secret',async t=>{
 for(const kind of ['throw','extra','getter']){const c=custody(t);let reads=0;
  const out=await D.retainAndExecute(c.input,{createRuntime:()=>({execute:async()=>{if(kind==='throw')throw Error(password+' '+verifier);const value={schema:'crm-manager-read-runtime-result-v1',action:'stage',state:'confirmed',phase:'staged',coreVerified:true,credentialBound:true,commitAck:true};if(kind==='extra')value.extra=password;else Object.defineProperty(value,'state',{enumerable:true,get(){reads++;throw Error(password);}});return value;},reconcile:async()=>{assert.fail();}})});
  assert.equal(out.state,'outcome_unknown');assert.equal(reads,0);assert.equal(JSON.stringify(out).includes(password),false);assert.equal(JSON.stringify(out).includes(verifier),false);
 }
});

test('all nine frozen runtime source bytes are admitted before custody or factory; one tampered byte or symlink keeps connect zero',async t=>{
 const c=custody(t),open=fs.openSync,read=fs.readFileSync,lstat=fs.lstatSync,fstat=fs.fstatSync;const targets=new Map();let factories=0;
 for(const mode of ['byte','symlink','bom']){
  fs.openSync=(file,...rest)=>{const fd=open(file,...rest);if(typeof file==='string'&&file.endsWith('/runtime/cli.cjs'))targets.set(fd,file);return fd;};
  fs.readFileSync=(file,...rest)=>{const data=read(file,...rest);if(targets.has(file)){if(mode==='byte'){const changed=Buffer.from(data);changed[0]^=1;return changed;}if(mode==='bom')return Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),data]);}return data;};
  fs.lstatSync=(file,...rest)=>{const stat=lstat(file,...rest);if(typeof file==='string'&&file.endsWith('/runtime/cli.cjs'))return new Proxy(stat,{get(target,key){if(mode==='symlink'&&key==='isSymbolicLink')return()=>true;if(mode==='bom'&&key==='size')return target.size+3;return Reflect.get(target,key);}});return stat;};
  fs.fstatSync=(fd,...rest)=>{const stat=fstat(fd,...rest);if(mode==='bom'&&targets.has(fd))return new Proxy(stat,{get(target,key){return key==='size'?target.size+3:Reflect.get(target,key);}});return stat;};
  try{await assert.rejects(D.retainAndExecute(c.input,{createRuntime:()=>{factories++;assert.fail('source drift reached runtime');}}),closed);}finally{fs.openSync=open;fs.readFileSync=read;fs.lstatSync=lstat;fs.fstatSync=fstat;targets.clear();}
  assert.equal(fs.existsSync(c.directory),false);assert.equal(factories,0);
 }
 // No frozen file was edited: normal admission accepts the exact same bytes.
 assert.equal(O.binding(c.intent).credentialIntentId,c.intent.credentialIntentId);
});
