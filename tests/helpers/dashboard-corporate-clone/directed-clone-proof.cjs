'use strict';
// One directed synthetic clone test. No server, provider, scheduler or Docker API.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {spawnSync}=require('node:child_process');
const {DatabaseSync,backup}=require('node:sqlite');
const REVISION='a6ae8725e50c728ee8dff670d02a56df7d3be3db';
const PACK='3b90fdd344b0453cc511963eaf4029ad492fffa7622c8e1162c5c2765c4344a1';
const BASE='node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
const IMPORTER_SHA='f56ebc485865aa88f09e4307d37c5d8bcd37def73b75c1968c4d143441092a9e';
// This public identifier is mandatory in the byte-exact importer. All account
// records, passwords, keys and sessions here are disposable synthetic fixtures.
const ADMIN='felipebandeira@oaristocrata.com';
const NOW=Date.UTC(2026,9,4,12),PASSWORD='Synthetic clone fixture password 2026!',TOKEN='synthetic-clone-bootstrap-only';
const IMPORTER=path.join(__dirname,'shadow-import.cjs');
const SOURCE_ROOT=path.join(__dirname,'public-source/services/dashboard-operational');
const READY='/tmp/synthetic-clone-fixture-ready';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Error('Directed synthetic clone proof refused.');};
function publicSources(){
 const pins=JSON.parse(fs.readFileSync(path.join(__dirname,'public-source-pins.json'),'utf8'));
 assert.equal(pins.sourceRevision,REVISION);assert.equal(pins.files.length,10);
 for(const p of pins.files){const b=fs.readFileSync(path.join(__dirname,p.file));assert.equal(b.length,p.bytes);assert.equal(sha(b),p.sha256);}
 assert.equal(sha(fs.readFileSync(IMPORTER)),IMPORTER_SHA);
 return pins;
}
function privateDir(parent,name){const dir=path.join(parent,name);fs.mkdirSync(dir,{mode:0o700});return dir;}
// Byte-exact helper from backup-identity.test.cjs.
function privateDbFiles(file){
 for(const name of [file,file+'-wal',file+'-shm'])if(fs.existsSync(name))fs.chmodSync(name,0o600);
}
let policy,image,canary,createAuth;
function fixtures(){
 ({createAuth}=require(path.join(SOURCE_ROOT,'auth.cjs')));
 policy=require(path.join(SOURCE_ROOT,'artifact-policy.cjs'));
 image=require(path.join(SOURCE_ROOT,'canary-image.cjs'));
 canary=require(path.join(SOURCE_ROOT,'canary-start.cjs'));
}
// Byte-exact fixture helpers from backup-canary-job.test.cjs.
function fakePack(file,marker='synthetic'){
 const files=policy.FILES.map(name=>({path:name,encoding:policy.isText(name)?'utf8':'base64',content:policy.isText(name)?marker:'AQID'}));
 const raw=Buffer.from(JSON.stringify(files)),sha256=crypto.createHash('sha256').update(raw).digest('hex');
 fs.writeFileSync(file,JSON.stringify({schema:policy.SCHEMA,sha256,gzipBase64:zlib.gzipSync(raw).toString('base64')}),{mode:0o600});
 return sha256;
}
function directory(root,name){const result=path.join(root,name);fs.mkdirSync(result,{mode:0o700});return result;}
function seedNewPack(root,targetDir){
 const imageDir=directory(root,'new-image'),sha256=fakePack(path.join(imageDir,'runtime-pack.json'),'new-image-pack');
 fs.writeFileSync(path.join(imageDir,'image-pin.json'),JSON.stringify({schema:image.IMAGE_SCHEMA,baseImage:image.IMAGE,sourceRevision:'a'.repeat(40),packSha256:sha256}),{mode:0o600});
 const result=canary.seedVolume({dataDir:targetDir,imageDir,expectedUid:process.getuid(),expectedGid:process.getgid()});
 assert.equal(result.seeded,true);
 assert.deepEqual(fs.readdirSync(targetDir),['runtime-pack.json']);
 return sha256;
}
function owned(dir,empty=false){
 const s=fs.lstatSync(dir);assert.equal(s.isDirectory(),true);assert.equal(s.isSymbolicLink(),false);assert.equal(fs.realpathSync(dir),dir);
 assert.equal(s.uid,process.getuid());assert.equal(s.gid,process.getgid());assert.equal(s.mode&511,448);
 if(empty)assert.deepEqual(fs.readdirSync(dir),[]);
}
function oci(pins){
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);assert.equal(process.versions.node,'22.23.3');
 for(const name of ['canary-start.cjs','canary-image.cjs','artifact-policy.cjs','bootstrap.cjs']){
  const p=pins.files.find(x=>x.file.endsWith('/'+name));assert.ok(p);assert.equal(sha(fs.readFileSync('/app/'+name)),p.sha256);
 }
 const {pin}=require('/app/canary-image.cjs').verifyImagePack('/app');
 assert.deepEqual(pin,{schema:'shrigma_dashboard_canary_image_v1',baseImage:BASE,sourceRevision:REVISION,packSha256:PACK});
 const db=new DatabaseSync(':memory:');try{assert.equal(db.prepare('SELECT sqlite_version() v').get().v,'3.51.3');}finally{db.close();}
 assert.equal(typeof backup,'function');return pin;
}
function syntheticAuthOptions(dbPath,encryptionKey){
 const hosts={manager:'manager.synthetic.invalid',growth:'growth.synthetic.invalid',organico:'organico.synthetic.invalid',influs:'influs.synthetic.invalid'};
 const issuerId='11111111-1111-4111-8111-111111111111',namespaceId='22222222-2222-4222-8222-222222222222';
 return {dbPath,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},allowedEmailDomains:['oaristocrata.com','synthetic.invalid'],bootstrapAdminEmail:ADMIN,bootstrapTokenSha256:sha(TOKEN),encryptionKey,now:()=>NOW,crmManagedRead:{issuerId,namespaceId}};
}
async function syntheticFixture(sourceDir,encryptionKey){
 owned(sourceDir,true);const dbPath=path.join(sourceDir,'dashboard.sqlite');fakePack(path.join(sourceDir,'runtime-pack.json'),'old-image-pack');
 // Same direct local bootstrap pattern as brand-identity.test.cjs. No HTTP.
 const options=syntheticAuthOptions(dbPath,encryptionKey),hosts={manager:options.managerHost};
 const {issuerId,namespaceId}=options.crmManagedRead;
 const auth=createAuth(options);let db;
 try{
  await auth.completeBootstrap({email:ADMIN,token:TOKEN,password:PASSWORD,host:hosts.manager,origin:'https://'+hosts.manager});
  const login=await auth.login({email:ADMIN,password:PASSWORD,host:hosts.manager,origin:'https://'+hosts.manager});
  let context={host:hosts.manager,origin:'https://'+hosts.manager,method:'POST',cookieHeader:login.cookie.split(';')[0],csrf:login.csrf};
  db=new DatabaseSync(dbPath);db.exec('PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=0');
  // The original Auth exports its own journal; no duplicate crypto/admission.
  const journal=auth.managedCrmJournal;assert.ok(journal);
  const managers=[];
  for(const [email,brand] of [['prepare@synthetic.invalid','fish'],['commit@synthetic.invalid','aristo']]){
   const invite=auth.createInvite({context,email,areas:['growth'],brand,requestedAccess:'read'});
   await auth.acceptInvite({token:invite.token,password:PASSWORD,host:invite.host,origin:'https://'+invite.host});managers.push(invite.userId);
  }
  db.exec('CREATE TABLE synthetic_clone_payload_v1(id INTEGER PRIMARY KEY,n INTEGER NOT NULL,payload BLOB NOT NULL); CREATE TABLE synthetic_clone_audit_v1(id INTEGER PRIMARY KEY AUTOINCREMENT,payload_id INTEGER NOT NULL); CREATE INDEX synthetic_clone_n_v1 ON synthetic_clone_payload_v1(n); CREATE VIEW synthetic_clone_view_v1 AS SELECT id,n FROM synthetic_clone_payload_v1; CREATE TRIGGER synthetic_clone_trigger_v1 AFTER INSERT ON synthetic_clone_payload_v1 BEGIN INSERT INTO synthetic_clone_audit_v1(payload_id) VALUES(new.id); END;');
  db.prepare('INSERT INTO synthetic_clone_payload_v1 VALUES(?,?,?)').run(1,9223372036854775700n,Buffer.from('synthetic-base-blob'));
  // Establish a main-file baseline, then leave nonempty credentials/journals and
  // the distinguishing committed payload in active WAL, as the existing tests do.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // Preserve admitted legacy master slots; pending managers receive no slot.
  for(const [slot,bearer]of[['growth-read','synthetic-master-growth-only'],['influs-read','synthetic-master-influs-only'],['organico-read','synthetic-master-organico-only']])auth.setUpstreamCredential({context,userId:login.user.id,slot,bearer});
  const operations=managers.map(id=>db.prepare('SELECT o.operation_id FROM crm_manager_operations_v1 o JOIN crm_manager_current_v1 c USING(lifecycle_id) WHERE c.user_id=?').get(id).operation_id);
  journal.beginPrepare(operations[0]);
  const {keySha256,...request}=journal.request(operations[1]);
  const prepared={...request,schema:'crm-manager-provision-receipt-v1',issuerId,namespaceId,action:'prepare_read',state:'prepared',area:'growth',slot:'crm-panel-read',role:'manager',caps:['read_content','list_history','submission'],issuedAt:NOW,candidateExpiresAt:NOW+600000,expiresAt:NOW+14*86400000};
  journal.recordPrepared(operations[1],prepared);journal.recordAttestation(operations[1],{owner:prepared.owner,principalId:prepared.principalId,caps:prepared.caps});journal.beginCommit(operations[1]);
  // Existing journal tests reserve locally with the master and then record a
  // lost ACK. These APIs never dispatch a provider or install a writer.
  auth.setGrants({context,userId:login.user.id,permissions:{growth:{read:true,edit:true},organico:{read:true,edit:false},influs:{read:true,edit:false}}});
  const writer=await auth.login({email:ADMIN,password:PASSWORD,host:hosts.manager,origin:'https://'+hosts.manager});
  context={host:hosts.manager,origin:'https://'+hosts.manager,method:'POST',cookieHeader:writer.cookie.split(';')[0],csrf:writer.csrf};
  const campaignKey='synthetic-campaign-uncertain',audienceKey='33333333-3333-4333-8333-333333333333';
  const campaignUser=auth.reserveCampaignDraft(context,'fish',campaignKey);assert.equal(campaignUser,login.user.id);
  assert.equal(auth.campaignDraftOutcome(campaignUser,'fish',campaignKey,'uncertain'),true);
  const audienceUser=auth.reserveAudienceDraft(context,'aristo',audienceKey,'segmento_criar','a'.repeat(64),'b'.repeat(64),{definitionSha256:'c'.repeat(64)});assert.equal(audienceUser,login.user.id);
  assert.equal(auth.audienceDraftOutcome(audienceUser,'aristo',audienceKey,'segmento_criar','uncertain'),true);
  db.prepare('INSERT INTO synthetic_clone_payload_v1 VALUES(?,?,?)').run(2,-9223372036854775700n,Buffer.from('synthetic-committed-WAL-blob'));
  privateDbFiles(dbPath);assert.ok(fs.statSync(dbPath+'-wal').size>0);
  return {close(){db.close();auth.close();}};
 }catch(e){try{db?.close();}catch{}try{auth.close();}catch{}throw e;}
}
// Same stat/hash fields as ci-offsite-drill.cjs PROBE, returned in RAM only.
function sourceProbe(dir){
 const p=path.join(dir,'dashboard.sqlite'),paths=[dir,p,p+'-wal',p+'-shm'];
 const out=paths.map(f=>{const s=fs.lstatSync(f);return {dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&511,nlink:s.nlink,size:s.size,sha256:s.isFile()?sha(fs.readFileSync(f)):null};});
 assert.equal(out[0].mode,448);for(const s of out.slice(1)){assert.equal(s.mode,384);assert.equal(s.nlink,1);}assert.ok(out[2].size>0);return out;
}
function state(file){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name').all();
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
  const contents=Object.fromEntries(tables.map(name=>{
   const q='"'+name.replaceAll('"','""')+'"',s=db.prepare('SELECT * FROM '+q);s.setReadBigInts(true);
   const rows=s.all().map(row=>JSON.stringify(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?['integer',v.toString()]:v instanceof Uint8Array?['blob',Buffer.from(v).toString('hex')]:v]))).sort();return [name,rows];
  }));
  const admins=db.prepare("SELECT id,email,password_hash FROM users WHERE role='superadmin'").all();assert.equal(admins.length,1);assert.equal(admins[0].email,ADMIN);assert.ok(admins[0].password_hash);
  const upstream=db.prepare('SELECT * FROM upstream_credentials ORDER BY user_id,slot').all();assert.equal(upstream.length,3);assert.ok(upstream.every(r=>r.encrypted_key.startsWith('v1.')&&!r.encrypted_key.includes('synthetic-')));
  assert.deepEqual(db.prepare('SELECT phase FROM crm_manager_operations_v1 ORDER BY phase').all().map(r=>r.phase),['commit_uncertain','prepare_uncertain']);
  for(const table of ['campaign_draft_operations','audience_draft_operations'])assert.deepEqual(db.prepare('SELECT phase FROM '+table).all().map(r=>r.phase),['uncertain']);
  assert.equal(db.prepare('SELECT count(*) n FROM synthetic_clone_payload_v1').get().n,2);
  return {schema,contents};
 }finally{db.close();}
}
function child(expectedPack){
 const result=spawnSync(process.execPath,['--no-warnings','--max-old-space-size=64',IMPORTER,expectedPack],{encoding:'utf8',timeout:45000,killSignal:'SIGKILL',maxBuffer:16384,env:{NODE_ENV:'test',PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin'}});
 if(result.status!==0||result.signal!==null||result.stderr)fail();const r=JSON.parse(result.stdout);
 assert.deepEqual(Object.keys(r).sort(),['counts','newRevision','ready','schema','sourceAdminPreserved']);assert.equal(r.schema,'dashboard_v23_shadow_import_v1');assert.equal(r.newRevision,REVISION);assert.equal(r.ready,true);assert.equal(r.sourceAdminPreserved,true);return r;
}
async function verify(sourceDir,destDir,{hostRoot,encryptionKey}={}){
 owned(sourceDir);owned(destDir,true);
 const before=state(path.join(sourceDir,'dashboard.sqlite')),sourceBefore=sourceProbe(sourceDir),old=JSON.parse(fs.readFileSync(path.join(sourceDir,'runtime-pack.json'),'utf8'));
 const scratch=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-clone-raw-')));
 try{
  const raw=path.join(scratch,'raw.sqlite');fs.copyFileSync(path.join(sourceDir,'dashboard.sqlite'),raw);fs.chmodSync(raw,0o600);
  const db=new DatabaseSync(raw,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM synthetic_clone_payload_v1').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM upstream_credentials').get().n,0);}finally{db.close();}
 }finally{fs.rmSync(scratch,{recursive:true,force:true});}
 let receipt,seedStat,seedBytes,hostPack;
 if(hostRoot){
  const {createLabShadowImporter}=require(IMPORTER);
  receipt=await createLabShadowImporter({sourceDir,destDir,uid:process.getuid(),gid:process.getgid(),seedVolume:options=>{
   hostPack=seedNewPack(hostRoot,options.dataDir);const file=path.join(destDir,'runtime-pack.json');seedStat=fs.statSync(file);seedBytes=fs.readFileSync(file);return {seeded:true,pin:image.readImagePin(path.join(hostRoot,'new-image'))};
  }}).run(old.sha256);
  assert.equal(receipt.newRevision,'a'.repeat(40));assert.equal(receipt.ready,true);
 }else receipt=child(old.sha256);
 const packFile=path.join(destDir,'runtime-pack.json'),packStat=fs.statSync(packFile),packBytes=fs.readFileSync(packFile),pack=JSON.parse(packBytes);
 assert.notEqual(pack.sha256,old.sha256);assert.equal(pack.sha256,hostRoot?hostPack:PACK);
 if(hostRoot){assert.equal(packStat.ino,seedStat.ino);assert.equal(packStat.dev,seedStat.dev);assert.deepEqual(packBytes,seedBytes);}
 else assert.deepEqual(packBytes,fs.readFileSync('/app/runtime-pack.json'));
 assert.deepEqual(state(path.join(destDir,'dashboard.sqlite')),before);assert.deepEqual(state(path.join(sourceDir,'dashboard.sqlite')),before);assert.deepEqual(sourceProbe(sourceDir),sourceBefore);
 const attempt=path.join(destDir,'.shadow-import-attempted-v1'),attemptStat=fs.lstatSync(attempt);assert.equal(attemptStat.isFile(),true);assert.equal(attemptStat.nlink,1);assert.equal(attemptStat.mode&511,384);assert.equal(fs.readFileSync(attempt,'utf8'),'v1\n');
 assert.deepEqual(fs.readdirSync(destDir).sort(),['.shadow-import-attempted-v1','dashboard.sqlite','runtime-pack.json']);
 const destHash=sha(fs.readFileSync(path.join(destDir,'dashboard.sqlite')));
 if(hostRoot){const {createLabShadowImporter}=require(IMPORTER);await assert.rejects(createLabShadowImporter({sourceDir,destDir,uid:process.getuid(),gid:process.getgid(),seedVolume:()=>fail()}).run(old.sha256),/Dashboard shadow import refused\./);}
 else{
  const replay=spawnSync(process.execPath,['--no-warnings','--max-old-space-size=64',IMPORTER,old.sha256],{encoding:'utf8',timeout:45000,maxBuffer:16384,env:{NODE_ENV:'test',PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin'}});
  assert.equal(replay.status,1);assert.equal(replay.stdout,'');assert.equal(replay.stderr.trim(),'Dashboard shadow import refused.');
 }
 assert.equal(fs.statSync(packFile).ino,packStat.ino);assert.deepEqual(fs.readFileSync(packFile),packBytes);assert.equal(sha(fs.readFileSync(path.join(destDir,'dashboard.sqlite'))),destHash);assert.deepEqual(sourceProbe(sourceDir),sourceBefore);
 // Clone parity/replay have already been proved. Auth probing can now change
 // ONLY the disposable destination (WAL/session/rate state), never the source.
 assert.ok(Buffer.isBuffer(encryptionKey)&&encryptionKey.length===32);
 let wrong=crypto.randomBytes(32);while(wrong.equals(encryptionKey))wrong=crypto.randomBytes(32);
 assert.throws(()=>createAuth(syntheticAuthOptions(path.join(destDir,'dashboard.sqlite'),wrong)),e=>e.code==='CREDENTIAL_UNAVAILABLE'&&e.status===503);wrong.fill(0);
 const restored=createAuth(syntheticAuthOptions(path.join(destDir,'dashboard.sqlite'),encryptionKey));
 try{
  const login=await restored.login({email:ADMIN,password:PASSWORD,host:'manager.synthetic.invalid',origin:'https://manager.synthetic.invalid'});
  const context={host:'manager.synthetic.invalid',origin:'https://manager.synthetic.invalid',method:'GET',cookieHeader:login.cookie.split(';')[0],csrf:login.csrf};
  assert.equal(login.user.role,'superadmin');
  for(const [area,slot,bearer]of[['growth','growth-read','synthetic-master-growth-only'],['influs','influs-read','synthetic-master-influs-only'],['organico','organico-read','synthetic-master-organico-only']])assert.equal(restored.getUpstreamCredential({...context,area,slot,edit:false}),bearer);
 }finally{restored.close();}
 assert.deepEqual(sourceProbe(sourceDir),sourceBefore);assert.deepEqual(state(path.join(sourceDir,'dashboard.sqlite')),before);assert.equal(fs.statSync(packFile).ino,packStat.ino);assert.deepEqual(fs.readFileSync(packFile),packBytes);
 return {schema:'directed_synthetic_corporate_clone_proof_v1',pass:true,hostOnly:!!hostRoot,mode:hostRoot?'host-lab':'synthetic-oci-intended',actualOciProvenByHarnessAlone:false,nativeDockerConfigIdVerifiedByHarness:false,productionCli1000Exercised:!hostRoot,sourceMountReadOnlyCheckedByPinnedImporter:!hostRoot,sourceImagePinVerified:!hostRoot,node:process.versions.node,uid:process.getuid(),gid:process.getgid(),importerSha256:IMPORTER_SHA,sourceRevision:hostRoot?null:REVISION,imagePackSha256:hostRoot?null:PACK,allTableContentsAndSchemaEqual:true,schemaObjects:before.schema.length,tables:Object.keys(before.contents).length,masterHashAndCipherAndUpstreamsPreserved:true,uncertainJournalsNonemptyAndPreserved:true,activeWalCaptured:true,rawMainCounterproofPassed:true,sourceFilesAndSidecarsUnchanged:true,newPackInodePreserved:true,attemptMarkerPresent:true,attemptPowerLossDurabilityProven:false,replayRefusedWithoutChanges:true,sameSyntheticKeyAuthOpened:true,wrongSyntheticKeyAuthRefused:true,authProbeAfterCloneParity:true,destinationAuthProbeMayChangeState:true,realDataOrCredentialsUsed:false,providerCalls:0,networkCalls:0,registryImageReference:null};
}
async function main(){
 const mode=process.argv.slice(2).join(' ');if(!['--host-synthetic','--fixture-hold','--fixture-ready','--verify-oci'].includes(mode))fail();
 const pins=publicSources();fixtures();
 if(mode==='--host-synthetic'){
  assert.equal(process.versions.node.split('.')[0],'25');assert.ok(process.getuid()>0&&process.getgid()>0);
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-corporate-clone-'))),sourceDir=privateDir(root,'source'),destDir=privateDir(root,'destination');let fixture;
  const encryptionKey=crypto.randomBytes(32);
  try{fixture=await syntheticFixture(sourceDir,encryptionKey);return await verify(sourceDir,destDir,{hostRoot:root,encryptionKey});}finally{fixture?.close();encryptionKey.fill(0);fs.rmSync(root,{recursive:true,force:true});}
 }
 oci(pins);
 if(mode==='--fixture-ready'){assert.equal(fs.readFileSync(READY,'utf8'),'synthetic fixture ready\n');return {syntheticFixtureReady:true};}
 // Future CI provides only a newly generated synthetic key to both containers,
 // through the existing runtime env name. Never read any host configuration.
 const keyHex=process.env.DASHBOARD_ENCRYPTION_KEY;assert.equal(typeof keyHex,'string');assert.match(keyHex,/^[a-f0-9]{64}$/);
 const encryptionKey=Buffer.from(keyHex,'hex');delete process.env.DASHBOARD_ENCRYPTION_KEY;
 if(mode==='--fixture-hold'){
  const fixture=await syntheticFixture('/source-identity',encryptionKey);fs.writeFileSync(READY,'synthetic fixture ready\n',{flag:'wx',mode:0o600});
  process.once('SIGTERM',()=>{fixture.close();encryptionKey.fill(0);process.exit(0);});process.once('SIGINT',()=>{fixture.close();encryptionKey.fill(0);process.exit(0);});setInterval(()=>{},3600000);return {syntheticFixtureReady:true,realDataOrCredentialsUsed:false};
 }
 try{return await verify('/source-identity','/dashboard-data',{encryptionKey});}finally{encryptionKey.fill(0);}
}
if(require.main===module)main().then(r=>console.log(JSON.stringify(r))).catch(error=>{
 const location=String(error.stack||'').split('\n').find(line=>line.startsWith('    at ')&&line.includes('directed-clone-proof.cjs:'));
 console.error(JSON.stringify({error:'Directed synthetic clone proof refused.',code:typeof error.code==='string'?error.code:null,location:location?.trim().replace(__dirname,'[test]')||null}));process.exitCode=1;
});
