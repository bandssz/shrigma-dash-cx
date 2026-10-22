'use strict';
// Synthetic 4096-bit keys and password only; no real keyring, SQL or network.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process'),util=require('node:util');
const O=require('./operator.cjs');
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:4096,publicExponent:65537});
const wrong=crypto.generateKeyPairSync('rsa',{modulusLength:4096,publicExponent:65537});
const password='a7'.repeat(32),salt=Buffer.from('0123456789abcdef');
function verifier(p=password,s=salt){const salted=crypto.pbkdf2Sync(p,s,4096,32,'sha256'),client=crypto.createHmac('sha256',salted).update('Client Key').digest(),stored=crypto.createHash('sha256').update(client).digest(),server=crypto.createHmac('sha256',salted).update('Server Key').digest();salted.fill(0);client.fill(0);return 'SCRAM-SHA-256$4096:'+s.toString('base64')+'$'+stored.toString('base64')+':'+server.toString('base64');}
const scram=verifier();
function intent(){return{schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action:'stage',fromPhase:'empty'};}
function fixture(t){const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'read-custody-synthetic-')));fs.chmodSync(parent,0o700);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));const i=intent(),directory=path.join(parent,'capsule');return{parent,directory,intent:i,seal:()=>O.sealNew({directory,intent:i,password,verifier:scram,publicKey:pair.publicKey}),open:()=>O.openExisting({directory,intent:i,privateKey:pair.privateKey}),file:()=>path.join(directory,O.FILE)};}
const closed=e=>e instanceof Error&&e.message==='READ_CREDENTIAL_CUSTODY_REFUSED'&&e.cause===undefined;

test('same durable credential survives process restart; only ciphertext persists next to the separate synthetic RSA key',t=>{
 const f=fixture(t),out=f.seal();assert.equal(out.durabilityBarrier,true);assert.equal(fs.statSync(f.directory).mode&0o7777,0o700);assert.equal(fs.statSync(f.file()).mode&0o7777,0o600);
 const key=path.join(f.parent,'synthetic-rsa-private.pem');fs.writeFileSync(key,pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
 const script=path.join(f.parent,'restart-public.cjs');fs.writeFileSync(script,`'use strict';const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),O=require(${JSON.stringify(__dirname+'/operator.cjs')});const input=JSON.parse(fs.readFileSync(0,'utf8')),key=O.loadPrivateKey(input.syntheticKey);const c=O.openExisting({directory:input.directory,intent:input.intent,privateKey:key});assert.equal(c.password,'a7'.repeat(32));const salted=crypto.pbkdf2Sync(c.password,Buffer.from('0123456789abcdef'),4096,32,'sha256'),client=crypto.createHmac('sha256',salted).update('Client Key').digest(),stored=crypto.createHash('sha256').update(client).digest(),server=crypto.createHmac('sha256',salted).update('Server Key').digest();assert.equal(c.verifier,'SCRAM-SHA-256$4096:'+Buffer.from('0123456789abcdef').toString('base64')+'$'+stored.toString('base64')+':'+server.toString('base64'));process.stdout.write(JSON.stringify(c));`,{mode:0o600});
 for(let n=0;n<2;n++){const r=spawnSync(process.execPath,[...(process.execArgv.filter(x=>!x.startsWith('--test'))),script],{env:{PATH:'/usr/bin:/bin'},input:JSON.stringify({directory:f.directory,intent:f.intent,syntheticKey:key}),encoding:'utf8',timeout:10000,maxBuffer:4096});assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');assert.deepEqual(JSON.parse(r.stdout),out);assert.equal(r.stdout.includes(password),false);assert.equal(r.stdout.includes(scram),false);}
 assert.equal(f.open().password,password);assert.equal(f.open().verifier,scram);assert.equal(fs.readFileSync(f.file(),'utf8').includes(password),false);assert.equal(fs.readFileSync(f.file(),'utf8').includes(scram),false);
});

test('IDs, action, frozen spec, role/database, source/runtime pins and image cannot be substituted',t=>{
 const f=fixture(t);f.seal();const before=fs.readFileSync(f.file()),e=JSON.parse(before);
 for(const delta of [{credentialIntentId:crypto.randomUUID()},{operationId:crypto.randomUUID()},{action:'activate',fromPhase:'staged'},{fromPhase:'staged'},{extra:true}])assert.throws(()=>O.openExisting({directory:f.directory,intent:{...f.intent,...delta},privateKey:pair.privateKey}),closed);
 const deltas=[b=>b.credentialIntentId=crypto.randomUUID(),b=>b.stageOperationId=crypto.randomUUID(),b=>b.spec.loginRole='postgres',b=>b.spec.issuerId=crypto.randomUUID(),b=>b.spec.namespaceId=crypto.randomUUID(),b=>b.spec.allowedEmailDomain='foreign.invalid',b=>b.database='other_database',b=>b.sourcePins.profile='f'.repeat(64),b=>b.runtimeSourcePins['cli.cjs']='f'.repeat(64),b=>b.runtimeImage=b.runtimeImage.replace(/5ca20/,'00000')];
 for(const delta of deltas){const changed=structuredClone(e);delta(changed.binding);fs.writeFileSync(f.file(),JSON.stringify(changed));assert.throws(f.open,closed);}
 fs.writeFileSync(f.file(),before);assert.equal(f.open().verifier,scram);
});

test('corrupt or malformed envelope and wrong/weak/type-confused keys fail with a static secret-free error',t=>{
 const f=fixture(t);f.seal();const before=fs.readFileSync(f.file()),e=JSON.parse(before);
 assert.throws(()=>O.openExisting({directory:f.directory,intent:f.intent,privateKey:wrong.privateKey}),closed);
 assert.throws(()=>O.openExisting({directory:f.directory,intent:f.intent,privateKey:pair.publicKey}),closed);
 for(const delta of [x=>x.tag=Buffer.alloc(16).toString('base64'),x=>x.iv=Buffer.alloc(12).toString('base64'),x=>x.wrappedKey=Buffer.alloc(512).toString('base64'),x=>x.ciphertext=x.ciphertext.slice(0,-4),x=>x.cipher='AES-128-GCM',x=>x.keySha256='0'.repeat(64),x=>x.extra=password]){const changed=structuredClone(e);delta(changed);fs.writeFileSync(f.file(),JSON.stringify(changed));assert.throws(f.open,closed);}
 for(const bytes of [before.subarray(0,50),Buffer.from('{'),Buffer.alloc(O.MAX+1,65)]){fs.writeFileSync(f.file(),bytes);assert.throws(f.open,closed);}
 fs.writeFileSync(f.file(),before);assert.equal(f.open().password,password);
 const weak=crypto.generateKeyPairSync('rsa',{modulusLength:2048});const other=fixture(t);assert.throws(()=>O.sealNew({directory:other.directory,intent:other.intent,password,verifier:scram,publicKey:weak.publicKey}),closed);assert.equal(fs.existsSync(other.directory),false);
});

test('mismatching password/verifier never admits a new capsule or generates a replacement',t=>{
 const f=fixture(t);
 for(const changes of [{password:'b8'.repeat(32)},{verifier:verifier('c9'.repeat(32))},{password:'short'},{verifier:scram.replace('$4096:','$8192:')},{publicKey:pair.privateKey}]){assert.throws(()=>O.sealNew({directory:f.directory,intent:f.intent,password,verifier:scram,publicKey:pair.publicKey,...changes}),closed);assert.equal(fs.existsSync(f.directory),false);}
 f.seal();const before=fs.readFileSync(f.file());assert.throws(f.seal,closed);assert.throws(()=>O.sealNew({directory:f.directory,intent:intent(),password,verifier:scram,publicKey:pair.publicKey}),closed);assert.ok(before.equals(fs.readFileSync(f.file())));
});

test('relative/noncanonical paths, weak permissions, symlink/hardlink and occupied/partial directories are refused without overwrite',t=>{
 const f=fixture(t);assert.throws(()=>O.sealNew({directory:'relative',intent:f.intent,password,verifier:scram,publicKey:pair.publicKey}),closed);assert.throws(()=>O.sealNew({directory:f.parent+'/../'+path.basename(f.parent)+'/capsule',intent:f.intent,password,verifier:scram,publicKey:pair.publicKey}),closed);
 fs.chmodSync(f.parent,0o755);assert.throws(f.seal,closed);fs.chmodSync(f.parent,0o700);
 fs.mkdirSync(f.directory,{mode:0o700});assert.throws(f.seal,closed);assert.throws(f.open,closed);assert.deepEqual(fs.readdirSync(f.directory),[]);fs.rmdirSync(f.directory);
 const linked=path.join(f.parent,'linked');fs.symlinkSync(f.parent,linked);assert.throws(()=>O.sealNew({directory:path.join(linked,'capsule'),intent:f.intent,password,verifier:scram,publicKey:pair.publicKey}),closed);assert.equal(fs.existsSync(f.directory),false);
 f.seal();const bytes=fs.readFileSync(f.file());fs.chmodSync(f.file(),0o644);assert.throws(f.open,closed);fs.chmodSync(f.file(),0o600);fs.chmodSync(f.directory,0o755);assert.throws(f.open,closed);fs.chmodSync(f.directory,0o700);
 const source=path.join(f.parent,'copied-cipher');fs.writeFileSync(source,bytes,{mode:0o600});fs.unlinkSync(f.file());fs.symlinkSync(source,f.file());assert.throws(f.open,closed);fs.unlinkSync(f.file());fs.linkSync(source,f.file());assert.throws(f.open,closed);fs.unlinkSync(f.file());fs.writeFileSync(f.file(),bytes,{mode:0o600});assert.equal(f.open().password,password);
});

test('file/directory fsync barrier precedes any stage callback; failure leaves hold and never automatically overwrites or retries',t=>{
 const f=fixture(t),original=fs.fsyncSync;let syncs=0,calls=0;
 fs.fsyncSync=fd=>{syncs++;if(syncs===1)throw Error('SYNTHETIC_FSYNC_FAIL '+password);return original(fd);};
 try{assert.throws(()=>{f.seal();const c=f.open();assert.equal(c.durabilityBarrier,true);calls++;},closed);}finally{fs.fsyncSync=original;}
 assert.equal(calls,0);assert.equal(syncs,1);assert.equal(fs.existsSync(f.file()),true);const before=fs.readFileSync(f.file());assert.throws(f.seal,closed);assert.ok(before.equals(fs.readFileSync(f.file())));
 // Read-only custody reopening can establish the barrier for the SAME intent;
 // it does not dispatch SQL, rotate anything, or release a runtime hold.
 assert.equal(f.open().password,password);assert.equal(calls,0);
});

test('all operator writes are ciphertext, returned inspection is public, and import/custody have no console/stdout logging',t=>{
 const f=fixture(t),write=fs.writeSync,logs=[],written=[];const originals=Object.fromEntries(['log','error','warn','info','debug'].map(k=>[k,console[k]]));
 fs.writeSync=(fd,data,...rest)=>{written.push(Buffer.from(data));return write(fd,data,...rest);};for(const k of Object.keys(originals))console[k]=(...args)=>logs.push(args);
 let sealed,opened;
 try{sealed=f.seal();opened=f.open();assert.equal(opened.password,password);assert.equal(opened.verifier,scram);}finally{fs.writeSync=write;Object.assign(console,originals);}
 assert.equal(logs.length,0);assert.ok(written.length>=1);
 for(const bytes of written){assert.equal(bytes.includes(Buffer.from(password)),false);assert.equal(bytes.includes(Buffer.from(scram)),false);assert.equal(bytes.includes(Buffer.from('SCRAM-SHA-256')),false);}
 for(const value of [JSON.stringify(opened),util.inspect(opened),JSON.stringify(sealed)]){assert.equal(value.includes(password),false);assert.equal(value.includes(scram),false);}
 assert.equal(Object.keys(opened).includes('password'),false);assert.equal(Object.keys(opened).includes('verifier'),false);assert.deepEqual(fs.readdirSync(f.directory),[O.FILE]);
});

test('CLI is inert and never accepts a private path or password on argv/stdout',()=>{
 const r=spawnSync(process.execPath,[__dirname+'/operator.cjs','seal','synthetic-unused-private-path'],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:10000,maxBuffer:4096});assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'READ_CREDENTIAL_CUSTODY_API_ONLY\n');
});

test('existing durable RSA key loader validates private ownership/modes/path without generating or overwriting any key',t=>{
 const f=fixture(t),pub=path.join(f.parent,'synthetic-rsa-public.pem'),priv=path.join(f.parent,'synthetic-rsa-private.pem');
 fs.writeFileSync(pub,pair.publicKey.export({type:'spki',format:'pem'}),{flag:'wx',mode:0o600});fs.writeFileSync(priv,pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
 const before=fs.readFileSync(priv);const p=O.loadPublicKey(pub),k=O.loadPrivateKey(priv);assert.equal(p.asymmetricKeyDetails.modulusLength,4096);assert.equal(k.asymmetricKeyDetails.modulusLength,4096);
 O.sealNew({directory:f.directory,intent:f.intent,password,verifier:scram,publicKey:p});assert.equal(O.openExisting({directory:f.directory,intent:f.intent,privateKey:k}).password,password);
 assert.throws(()=>O.loadPublicKey(priv),closed);assert.throws(()=>O.loadPrivateKey(pub),closed);assert.throws(()=>O.loadPrivateKey('relative'),closed);
 fs.chmodSync(priv,0o644);assert.throws(()=>O.loadPrivateKey(priv),closed);fs.chmodSync(priv,0o600);
 const link=path.join(f.parent,'key-symlink');fs.symlinkSync(priv,link);assert.throws(()=>O.loadPrivateKey(link),closed);fs.unlinkSync(link);fs.linkSync(priv,link);assert.throws(()=>O.loadPrivateKey(priv),closed);fs.unlinkSync(link);
 assert.ok(before.equals(fs.readFileSync(priv)));assert.equal(O.loadPrivateKey(priv).type,'private');
});

test('direct operator APIs reject getters, symbols and nonenumerable fields before reading values or writing a capsule',t=>{
 const f=fixture(t);let reads=0;
 for(const kind of ['getterInput','symbolInput','hiddenInput','getterIntent','symbolIntent','hiddenIntent']){
  const input={directory:f.directory,intent:{...f.intent},password,verifier:scram,publicKey:pair.publicKey};
  if(kind==='getterInput')Object.defineProperty(input,'password',{enumerable:true,get(){reads++;throw Error(password);}});
  if(kind==='symbolInput')input[Symbol('hidden')]=password;
  if(kind==='hiddenInput')Object.defineProperty(input,'extra',{value:password,enumerable:false});
  if(kind==='getterIntent')Object.defineProperty(input.intent,'operationId',{enumerable:true,get(){reads++;throw Error(password);}});
  if(kind==='symbolIntent')input.intent[Symbol('hidden')]=password;
  if(kind==='hiddenIntent')Object.defineProperty(input.intent,'extra',{value:password,enumerable:false});
  assert.throws(()=>O.sealNew(input),closed);assert.equal(fs.existsSync(f.directory),false);
 }
 const input={directory:f.directory,intent:f.intent,privateKey:pair.privateKey};Object.defineProperty(input,'privateKey',{enumerable:true,get(){reads++;throw Error(password);}});assert.throws(()=>O.openExisting(input),closed);assert.equal(reads,0);
});
