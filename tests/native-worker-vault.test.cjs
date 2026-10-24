'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process'),{once}=require('node:events'),{DatabaseSync}=require('node:sqlite');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
const mod=require(runtime+'/native-worker-vault.cjs'),cli=require(runtime+'/native-worker-vault-cli.cjs'),manifest='d'.repeat(64);
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
function fixture(dbPath){
 const dir=dbPath?null:fs.mkdtempSync('/tmp/wv-');dbPath ||= path.join(dir,'s.sqlite');
 const db=new DatabaseSync(dbPath),key=crypto.randomBytes(32);
 let profile={id:'original-owner',revision:'a'.repeat(64),original:true,active:true},clock=0,encryptCalls=0,failEncrypt=0;
 const encrypt=text=>{if(++encryptCalls===failEncrypt)throw Error('synthetic encryption failure');const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return ['v1',iv.toString('base64url'),Buffer.concat([c.update(text),c.final()]).toString('base64url'),c.getAuthTag().toString('base64url')].join('.');};
 const decrypt=text=>{const[,iv,b,tag]=text.split('.'),c=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));c.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([c.update(Buffer.from(b,'base64url')),c.final()]).toString();};
 const mac=x=>crypto.createHmac('sha256',key).update(x).digest('hex');
 const opts={db,encrypt,decrypt,mac,owner:()=>profile,manifest,now:()=>1792840000000,monotonic:()=>clock};
 let vault=mod.create(opts);
 return{db,dbPath,opts,mac,get vault(){return vault;},get profile(){return profile;},set profile(p){profile=p;},expire(){clock+=30000;},failSecondCipher(){failEncrypt=encryptCalls+2;},restart(){vault.close();vault=mod.create(opts);},close(){vault.close();db.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});}};
}
const operation=(f,action='generate',revision=f.vault.status().bundleRevision,operationId=crypto.randomUUID(),connection='connection')=>{
 const c=f.vault.challenge(connection,{action:'challenge',operation:action,operationId,expectedManifest:manifest,expectedBundleRevision:revision});
 return{q:{action,nonce:c.nonce},operationId,connection};
};
const commit=(f,op)=>f.vault.generate(op.connection,op.q);
const denied=(fn,code)=>a.throws(fn,e=>e.code===code);
test('two roles persist atomically, encrypted; receipts and restart expose no password or SCRAM',()=>{
 const f=fixture();try{
  const op=operation(f),r=commit(f,op),producer=f.vault.producerConnection(),executor=f.vault.executorConnection();
  a.equal(r.bundleRevision,1);a.equal(producer.user,'crm_api');a.equal(executor.user,'crm_worker');a.notEqual(producer.password,executor.password);
  const stored=JSON.stringify(f.db.prepare('SELECT * FROM crm_worker_credential_bundle_v1').all())+JSON.stringify(f.db.prepare('SELECT * FROM crm_worker_credential_receipt_v1').all());
  for(const secret of[producer.password,executor.password,'SCRAM-SHA-256$']){a.equal(stored.includes(secret),false);a.equal(JSON.stringify(r).includes(secret),false);}
  const v=operation(f,'verifiers',1,op.operationId),privateValue=f.vault.verifiers(v.connection,v.q);
  f.restart();a.equal(f.vault.producerConnection().password,producer.password);a.equal(f.vault.status(op.operationId).receiptIsCurrent,true);
  const again=operation(f,'verifiers',1,op.operationId);a.deepEqual(f.vault.verifiers(again.connection,again.q),privateValue);
  denied(()=>operation(f,'generate',1,op.operationId),'WV_OPERATION_COMMITTED');
 }finally{f.close();}
});
test('second cipher failure and receipt-write failure roll back the pair and audit together',()=>{
 for(const mode of['cipher','receipt']){const f=fixture();try{
  if(mode==='cipher')f.failSecondCipher();else f.db.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON crm_worker_credential_receipt_v1 BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  denied(()=>commit(f,operation(f)),'WV_COMMIT_REFUSED');
  a.equal(f.vault.status().bundleRevision,0);a.equal(f.db.prepare('SELECT count(*) n FROM crm_worker_credential_receipt_v1').get().n,0);
 }finally{f.close();}}
});
test('concurrent challenges use CAS, rotation invalidates old receipt and both connection references',()=>{
 const f=fixture();try{
  const one=operation(f),two=operation(f),r=commit(f,one);denied(()=>commit(f,two),'WV_CAS');
  const replacement=commit(f,operation(f));a.equal(replacement.bundleRevision,2);
  a.equal(f.vault.status(one.operationId).receiptIsCurrent,false);
  for(const slot of['producer','executor'])a.notEqual(r.slots[slot].connectionRef,replacement.slots[slot].connectionRef);
 }finally{f.close();}
});
test('nonces bind connection, operation, expiry, current owner and one use',()=>{
 for(const kind of['connection','operation','expiry','owner','replay','disconnect','restart']){const f=fixture();try{
  const op=operation(f);let code='WV_NONCE';
  if(kind==='connection')op.connection='other';
  if(kind==='operation')op.q.action='revoke';
  if(kind==='expiry')f.expire();
  if(kind==='owner'){f.profile={...f.profile,revision:'b'.repeat(64)};code='WV_BINDING_CHANGED';}
  if(kind==='replay')commit(f,op);
  if(kind==='disconnect')f.vault.disconnect(op.connection);
  if(kind==='restart')f.restart();
  denied(()=>commit(f,op),code);
 }finally{f.close();}}
});
test('caller cannot inject endpoint, owner, username, password or browser authority into a challenge',()=>{
 const f=fixture();try{
  for(const extra of[{host:'foreign'},{ownerId:'forged'},{username:'postgres'},{password:'synthetic'},{nativeBearer:'synthetic'},{schema:'public'}]){
   denied(()=>f.vault.challenge('c',{action:'challenge',operation:'generate',operationId:crypto.randomUUID(),expectedManifest:manifest,expectedBundleRevision:0,...extra}),'WV_INPUT');
  }
  denied(()=>f.vault.challenge('c',{action:'challenge',operation:'generate',operationId:crypto.randomUUID(),expectedManifest:'f'.repeat(64),expectedBundleRevision:0}),'WV_INPUT');
  const op=operation(f);denied(()=>f.vault.verifiers(op.connection,op.q),'WV_INPUT');
 }finally{f.close();}
});
test('inactive, different or non-original owner never resolves private values',()=>{
 const f=fixture();try{commit(f,operation(f));
  for(const change of[{active:false},{original:false},{id:'different-owner'}]){const prior=f.profile;f.profile={...prior,...change};denied(()=>f.vault.producerConnection(),change.id?'WV_BINDING_CHANGED':'WV_ORIGINAL_OWNER');f.profile=prior;}
 }finally{f.close();}
});
test('owner revision change blocks old access; current original owner can revoke and replace without decrypting old slots',()=>{
 const f=fixture();try{
  commit(f,operation(f));f.profile={...f.profile,revision:'b'.repeat(64)};
  a.equal(f.vault.status().ownerChanged,true);denied(()=>f.vault.executorConnection(),'WV_BINDING_CHANGED');
  const revoked=commit(f,operation(f,'revoke'));a.equal(revoked.slots.producer.linked,false);a.equal(f.vault.status().revoked,true);
  denied(()=>f.vault.producerConnection(),'WV_BINDING_CHANGED');
  const next=commit(f,operation(f));a.equal(next.bundleRevision,3);a.equal(f.vault.status().linked,true);
 }finally{f.close();}
});
test('sealed receipt under another operation PK, altered bundle revision and ciphertext are refused',()=>{
 for(const mode of['receipt','revision','cipher']){const f=fixture();try{
  const op=operation(f);commit(f,op);
  if(mode==='receipt'){const r=f.db.prepare('SELECT * FROM crm_worker_credential_receipt_v1').get(),other=crypto.randomUUID();f.db.prepare('INSERT INTO crm_worker_credential_receipt_v1 VALUES(?,?,?)').run(other,r.data,r.seal);denied(()=>f.vault.status(other),'WV_INTEGRITY');}
  if(mode==='revision'){f.db.exec('UPDATE crm_worker_credential_bundle_v1 SET revision=9');denied(()=>f.vault.status(),'WV_INTEGRITY');}
  if(mode==='cipher'){const r=f.db.prepare('SELECT * FROM crm_worker_credential_bundle_v1').get(),v=JSON.parse(r.data);v.slots.executor.cipher='tampered';f.db.prepare('UPDATE crm_worker_credential_bundle_v1 SET data=?').run(JSON.stringify(v));denied(()=>f.vault.executorConnection(),'WV_INTEGRITY');}
 }finally{f.close();}}
});
test('nonce capacity is bounded and expired entries are reclaimable',()=>{
 const f=fixture();try{for(let n=0;n<16;n++)operation(f);denied(()=>operation(f),'WV_BUSY');f.expire();commit(f,operation(f));a.equal(f.vault.status().bundleRevision,1);}finally{f.close();}
});
function fakeDriver({endFailure=false,wrongPeer=false,pause}={}){
 const calls=[];return{calls,Client:class{
  constructor(p){this.p=p;calls.push({user:p.user,host:p.host,database:p.database});}
  async connect(){if(pause)await pause;}
  async query(sql){calls.push(sql);return{rows:[{database:wrongPeer?'other':'listmonk',session_user:this.p.user,current_user:this.p.user,version:'170011',port:5432}]};}
  async end(){calls.push('closed');if(endFailure)throw Error(this.p.password);}
 }};
}
test('PG probe uses only fixed roles/resource and READ ONLY; close and peer errors never become proof',async()=>{
 for(const kind of['ok','close','peer']){const f=fixture();try{
  const op=operation(f);commit(f,op);const driver=fakeDriver({endFailure:kind==='close',wrongPeer:kind==='peer'}),p=operation(f,'probe',1,op.operationId),promise=f.vault.probe(p.connection,p.q,driver);
  if(kind==='ok'){const r=await promise;a.equal(r.results.length,2);a.equal(r.manifest,manifest);a.equal(driver.calls.filter(x=>x==='closed').length,2);a.deepEqual(driver.calls.filter(x=>typeof x==='object').map(x=>x.user),['crm_api','crm_worker']);a.equal(driver.calls.filter(x=>typeof x==='string').some(x=>/ALTER|INSERT|UPDATE/.test(x)),false);}
  else await a.rejects(promise,{code:kind==='close'?'WV_PG_CLOSE_UNCONFIRMED':'WV_PG_LOGIN_UNAVAILABLE'});
 }finally{f.close();}}
});
test('probe consumes nonce before await and rejects owner drift while opening sessions',async()=>{
 const f=fixture();try{
  const op=operation(f);commit(f,op);let release;const pause=new Promise(r=>release=r),driver=fakeDriver({pause}),p=operation(f,'probe',1,op.operationId),pending=f.vault.probe(p.connection,p.q,driver);
  await a.rejects(f.vault.probe(p.connection,p.q,driver),{code:'WV_NONCE'});
  f.profile={...f.profile,revision:'b'.repeat(64)};release();await a.rejects(pending,e=>['WV_BINDING_CHANGED','WV_PG_LOGIN_UNAVAILABLE'].includes(e.code));
 }finally{f.close();}
});
test('auth resolves original active owner internally; Meta and legacy PG rows survive worker rotation and revoke',async()=>{
 const {createAuth,CREDENTIAL_SLOTS}=require(runtime+'/auth.cjs'),{ORIGINAL}=require(runtime+'/native-whatsapp-connection.cjs');
 const dir=fs.mkdtempSync('/tmp/wa-'),dbPath=path.join(dir,'a.sqlite'),host='manager.synthetic.invalid',origin='https://'+host,bootstrap='synthetic-bootstrap';
 const opts={dbPath,managerHost:host,areaHosts:{growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'affiliate.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'owner@synthetic.invalid',bootstrapTokenSha256:hash(bootstrap),encryptionKey:crypto.randomBytes(32),crmNativeEnabled:true,simpleReadMode:true,crmNativeDatabaseEnabled:true,crmWorkerCredentialVaultEnabled:true,crmWorkerCredentialVaultManifest:manifest};
 let auth=createAuth(opts);const db=new DatabaseSync(dbPath);
 try{
  denied(()=>auth.nativeWorkerVault.status(),'WV_ORIGINAL_OWNER');
  await auth.completeBootstrap({email:opts.bootstrapAdminEmail,token:bootstrap,password:'Synthetic-Only-Password-2026!',host,origin});
  const login=await auth.login({email:opts.bootstrapAdminEmail,password:'Synthetic-Only-Password-2026!',host,origin}),ctx={cookieHeader:login.cookie.split(';')[0],host,origin,method:'POST',csrf:login.csrf};
  const ownerId=auth.session(ctx).user.id,meta=auth.whatsAppConnectionStore();
  for(const brand of['aristo','fish'])meta.bind({context:ctx,brand,token:'SYNTHETIC_META_TOKEN_NOT_REAL_123456',original:ORIGINAL,expectedRevision:0});
  auth.nativeDatabaseVault.bind({context:ctx,username:'synthetic_pg_owner',password:'Synthetic-PG-Only-Password-2026!',privateNetwork:true});
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'shrigma_meta_wa_%' OR name LIKE 'shrigma_native_database_%') ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>tables.map(t=>({table:t,rows:db.prepare('SELECT * FROM '+t).all()})),before=snapshot();
  const f={vault:auth.nativeWorkerVault};commit(f,operation(f));commit(f,operation(f));commit(f,operation(f,'revoke'));
  a.deepEqual(snapshot(),before);a.equal(auth.nativeDatabaseVault.getPrivateCredential({ownerId}).password,'Synthetic-PG-Only-Password-2026!');
  a.equal(Object.keys(CREDENTIAL_SLOTS).some(k=>/worker|crm_api/.test(k)),false);
  commit(f,operation(f));db.prepare("UPDATE users SET password_hash=? WHERE id=?").run('synthetic-password-revision-change',ownerId);
  denied(()=>auth.nativeWorkerVault.executorConnection(),'WV_BINDING_CHANGED');
  commit(f,operation(f));a.equal(auth.nativeWorkerVault.status().linked,true);
  const bundle=db.prepare('SELECT * FROM crm_worker_credential_bundle_v1').all();
  const held=auth.nativeWorkerVault;auth.close();denied(()=>held.status(),'WV_CLOSED');auth=createAuth({...opts,crmWorkerCredentialVaultEnabled:false});a.equal(auth.nativeWorkerVault,undefined);a.deepEqual(db.prepare('SELECT * FROM crm_worker_credential_bundle_v1').all(),bundle);
 }finally{auth.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Unix socket exchanges challenge and action; active endpoint and symlink replacements are refused',async()=>{
 const f=fixture();let server,other;try{
  server=mod.startSocket({vault:f.vault,dbPath:f.dbPath});await server.ready;
  const r=await cli.privateOperation(f.dbPath,{action:'generate',expectedManifest:manifest,expectedBundleRevision:0,operationId:crypto.randomUUID()});a.equal(r.bundleRevision,1);
  a.equal(fs.statSync(server.path).mode&0o777,0o600);
  other=mod.startSocket({vault:{close(){}},dbPath:f.dbPath});await a.rejects(other.ready,{code:'WV_SOCKET_EXISTS'});
  a.equal((await cli.request(f.dbPath,{action:'status'})).linked,true);
 }finally{await other?.close();await server?.close();f.close();}
 const g=fixture();try{
  const file=mod.socketPath(g.dbPath);fs.mkdirSync(path.dirname(file),{mode:0o700});fs.symlinkSync(g.dbPath,file);
  const s=mod.startSocket({vault:{close(){}},dbPath:g.dbPath});await a.rejects(s.ready,{code:'WV_SOCKET_EXISTS'});await s.close();a.equal(fs.lstatSync(file).isSymbolicLink(),true);
 }finally{g.close();}
});
test('same-container crash leaves an owned stale socket that can safely restart',async()=>{
 const f=fixture();let server;try{
  const file=mod.socketPath(f.dbPath);fs.mkdirSync(path.dirname(file),{mode:0o700});
  const child=spawn(process.execPath,['-e',"const n=require('net'),f=require('fs'),s=n.createServer(()=>{});s.listen(process.argv[1],()=>{f.chmodSync(process.argv[1],0o600);process.stdout.write('ready\\\\n')})",file],{stdio:['ignore','pipe','pipe']});
  await once(child.stdout,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  a.equal(fs.lstatSync(file).isSocket(),true);server=mod.startSocket({vault:f.vault,dbPath:f.dbPath});await server.ready;
  a.equal((await cli.request(f.dbPath,{action:'status'})).bundleRevision,0);
 }finally{await server?.close();f.close();}
});
test('socket drain waits for in-flight asynchronous probe before closing vault',async()=>{
 const f=fixture();let release,enteredResolve,closed=false;const entered=new Promise(r=>enteredResolve=r),pause=new Promise(r=>release=r);
 const vault={status:()=>f.vault.status(),challenge:(...q)=>f.vault.challenge(...q),disconnect:(...q)=>f.vault.disconnect(...q),close:()=>{closed=true;f.vault.close();},probe:async()=>{enteredResolve();await pause;return{schema:'synthetic'};}};
 const server=mod.startSocket({vault,dbPath:f.dbPath});try{
  const op=operation(f);commit(f,op);await server.ready;
  const pending=cli.privateOperation(f.dbPath,{action:'probe',expectedManifest:manifest,expectedBundleRevision:1,operationId:op.operationId}).catch(e=>e);
  await entered;const closing=server.close();await new Promise(r=>setImmediate(r));a.equal(closed,false);release();await closing;await pending;a.equal(closed,true);
 }finally{release?.();await server.close();f.close();}
});
test('CLI requires separate inherited FD3; only verifier pair reaches it, stdout stays metadata',async()=>{
 a.equal(process.env.WV_CLI_FIXTURE,'1');
 const f=fixture('/dashboard-data/test.sqlite');let server;
 const run=(input,fd3=true)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[runtime+'/native-worker-vault-cli.cjs','--private-pipe'],{stdio:fd3?['pipe','pipe','pipe','pipe']:['pipe','pipe','pipe']});
  const chunks=[[],[],[]];child.stdout.on('data',c=>chunks[0].push(c));child.stderr.on('data',c=>chunks[1].push(c));if(fd3)child.stdio[3].on('data',c=>chunks[2].push(c));child.on('error',reject);child.on('exit',code=>resolve({code,out:Buffer.concat(chunks[0]).toString(),err:Buffer.concat(chunks[1]).toString(),private:Buffer.concat(chunks[2]).toString()}));child.stdin.end(JSON.stringify(input));
 });
 try{
  server=mod.startSocket({vault:f.vault,dbPath:f.dbPath});await server.ready;
  const operationId=crypto.randomUUID(),input={action:'generate',expectedManifest:manifest,expectedBundleRevision:0,operationId};
  const nofd=await run(input,false);a.equal(nofd.code,1);a.match(nofd.err,/WV_PRIVATE_PIPE_REQUIRED/);a.equal(f.vault.status().bundleRevision,0);
  const generated=await run(input);a.equal(generated.code,0);a.equal(generated.private,'');a.equal(JSON.parse(generated.out).bundleRevision,1);
  const v=await run({...input,action:'verifiers',expectedBundleRevision:1});a.equal(v.code,0);a.equal(JSON.parse(v.out).privateDelivered,true);a.equal(v.out.includes('SCRAM'),false);a.equal(v.err.includes('SCRAM'),false);a.equal(Object.keys(JSON.parse(v.private).verifiers).length,2);
  for(const p of[f.vault.producerConnection().password,f.vault.executorConnection().password])a.equal((v.out+v.err+v.private).includes(p),false);
  const again=await run({...input,action:'verifiers',expectedBundleRevision:1});a.equal(again.private,v.private);
  const injected=await run({...input,action:'verifiers',expectedBundleRevision:1,host:'foreign'});a.equal(injected.code,1);a.equal(injected.private,'');
 }finally{await server?.close();f.close();fs.rmSync('/dashboard-data/test.sqlite',{force:true});}
});
