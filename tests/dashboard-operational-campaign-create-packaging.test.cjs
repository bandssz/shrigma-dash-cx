'use strict';
// Builds current reviewed assets; uses synthetic identities and never starts a server.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),SERVICE=path.join(ROOT,'services/dashboard-operational');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
process.umask(0o077);
function temporary(){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'crm-create-packaging-')));
 if(process.getuid&&process.getgid)fs.chownSync(dir,process.getuid(),process.getgid());
 fs.chmodSync(dir,0o700);return dir;
}
const mkdir=dir=>fs.mkdirSync(dir,{recursive:true,mode:0o700});
function refuseNetwork(){
 const refuse=()=>{throw Error('SYNTHETIC_NETWORK_REFUSED');};
 const net=require('node:net');net.connect=refuse;net.createConnection=refuse;net.Server.prototype.listen=refuse;
 for(const module of ['node:http','node:https']){const api=require(module);api.request=refuse;api.get=refuse;}
 globalThis.fetch=refuse;
}
function cold(packFile){
 refuseNetwork();
 const {DatabaseSync}=require('node:sqlite'),policy=require(path.join(SERVICE,'artifact-policy.cjs')),parent=temporary();
 try{
  const wrapper=JSON.parse(fs.readFileSync(packFile,'utf8'));
  const artifact=policy.unpack(packFile,path.join(parent,'artifact'),{expectedSha256:wrapper.sha256});
  const serverModule=require(path.join(artifact.runtimeDir,'server.cjs')),authModule=require(path.join(artifact.runtimeDir,'auth.cjs')),proxy=require(path.join(artifact.runtimeDir,'proxy.cjs'));
  const env={DASHBOARD_MODE:'synthetic',DASHBOARD_MANAGER_HOST:'manager.synthetic.invalid',DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'growth.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'influs.synthetic.invalid'}),DASHBOARD_EMAIL_DOMAINS:'["synthetic.invalid"]',DASHBOARD_UPSTREAMS:'{}',DASHBOARD_UPSTREAM_HOSTS:'[]',DASHBOARD_ADMIN_EMAIL:'admin@synthetic.invalid',DASHBOARD_BOOTSTRAP_SHA256:'a'.repeat(64),DASHBOARD_ENCRYPTION_KEY:'1'.repeat(64),DASHBOARD_PUBLIC_DIR:artifact.publicDir};
  let upstreamCalls=0;
  const construct=enabled=>{
   const dbPath=path.join(parent,enabled?'on.sqlite':'off.sqlite');
   const settings=serverModule.settingsFromEnv({...env,DASHBOARD_DB_PATH:dbPath,...(enabled?{DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'crm-sandbox',DASHBOARD_CRM_CAMPAIGN_SUBMIT_WRITE:'enabled',DASHBOARD_UPSTREAMS:JSON.stringify({...proxy.SANDBOX_DESTINATIONS,campaigns:proxy.SANDBOX_CAMPAIGN_DESTINATION}),DASHBOARD_UPSTREAM_HOSTS:JSON.stringify([proxy.SANDBOX_HOST])}:{})});
   const auth=authModule.createAuth(serverModule.authOptionsFor(settings));let server;
   try{
    server=serverModule.createServer(settings,{auth,fetchImpl:()=>{upstreamCalls++;throw Error('SYNTHETIC_NETWORK_REFUSED');}});
    if(server.address()!==null)throw Error('SYNTHETIC_LISTENER_REFUSED');
    const db=new DatabaseSync(dbPath,{readOnly:true});
    try{return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='crm_campaign_create_v1'").get();}finally{db.close();}
   }finally{server?.close(()=>{});auth.close();}
  };
  const offNoCreateTable=construct(false)===false,onCreateTable=construct(true)===true;
  if(!offNoCreateTable||!onCreateTable||upstreamCalls!==0)throw Error('SYNTHETIC_COLD_REFUSED');
  process.stdout.write(JSON.stringify({schema:'crm-create-cold-proof-v1',offNoCreateTable,onCreateTable,noServerListen:true,upstreamCalls,configuredOldSpaceMiB:128,maximumRssKiB:process.resourceUsage().maxRSS})+'\n');
 }finally{fs.rmSync(parent,{recursive:true,force:true});}
}
if(process.argv[2]==='cold'){
 try{if(process.argv.length!==4)throw Error();cold(process.argv[3]);}catch{process.stderr.write('Synthetic packaging proof refused.\n');process.exitCode=1;}
}else{
 const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
 let parent,packFile,metadata;
 test.before(()=>{
  parent=temporary();
  require(path.join(SERVICE,'build.cjs')).build(path.join(parent,'dist'));
  metadata=require(path.join(SERVICE,'pack-runtime.cjs')).pack(path.join(parent,'dist'),path.join(parent,'pack'));
  packFile=path.join(parent,'pack/runtime-pack.json');
  assert.ok(metadata.packBytes<=950000&&metadata.seedMountsBytes<=960000);
  assert.ok(require(path.join(SERVICE,'artifact-policy.cjs')).RUNTIME_FILES.includes('crm-campaign-create.cjs'));
 });
 test.after(()=>{if(parent)fs.rmSync(parent,{recursive:true,force:true});});
 test('fresh heap128 process decodes current pack and constructs OFF/ON auth/server with no network or listener',()=>{
  const result=spawnSync(process.execPath,['--no-warnings','--max-old-space-size=128',__filename,'cold',packFile],{env:{},encoding:'utf8',timeout:15000,maxBuffer:4096});
  assert.equal(result.status,0);assert.equal(result.stderr,'');
  const proof=JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(proof).sort(),['configuredOldSpaceMiB','maximumRssKiB','noServerListen','offNoCreateTable','onCreateTable','schema','upstreamCalls'].sort());
  assert.equal(proof.schema,'crm-create-cold-proof-v1');assert.equal(proof.offNoCreateTable&&proof.onCreateTable&&proof.noServerListen,true);assert.equal(proof.upstreamCalls,0);assert.equal(proof.configuredOldSpaceMiB,128);assert.ok(proof.maximumRssKiB>0);
 });
 test('online WAL backup and restore into a new target preserve CREATE ciphertext and resume the same key using GET only',async t=>{
  const {fixture}=require('./dashboard-operational-campaign-create-fixture.cjs'),f=fixture(t);
  const utility=require(path.join(SERVICE,'backup-identity.cjs')),canary=require(path.join(SERVICE,'backup-canary-job.cjs'));
  f.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE users(email TEXT NOT NULL,role TEXT NOT NULL,password_hash TEXT NOT NULL,encrypted_key TEXT NOT NULL);');
  f.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(canary.ADMIN,'superadmin','SYNTHETIC_PASSWORD_SENTINEL',f.options().encrypt('SYNTHETIC_CREDENTIAL_SENTINEL'));
  f.behavior(({method,dispatch})=>method==='POST'?Promise.reject(Error('SYNTHETIC_LOST_ACK')):dispatch());
  assert.equal((await f.creator.submit(f.ctx,f.command())).state,'pending');
  const source=fs.realpathSync(f.filename),snapshot=path.join(parent,'backup/create-recovery'),target=path.join(parent,'new-target');
  mkdir(snapshot);mkdir(target);
  const fingerprint=db=>{
   const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
   const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
   const tables=names.map(({name})=>({name,rows:db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all().map(row=>JSON.stringify(row)).sort()}));
   return sha(JSON.stringify({schema,tables}));
  };
  const before=fingerprint(f.db),mainBefore=sha(fs.readFileSync(source)),walBefore=sha(fs.readFileSync(source+'-wal'));
  const identity=await utility.createBackup(source,path.join(snapshot,'identity')),packBytes=fs.readFileSync(packFile),packPin=JSON.parse(packBytes).sha256;
  fs.writeFileSync(path.join(snapshot,'runtime-pack.json'),packBytes,{mode:0o600});
  fs.writeFileSync(path.join(snapshot,'snapshot.json'),JSON.stringify({schema:canary.SNAPSHOT_SCHEMA,packSha256:packPin,identitySha256:identity.sha256}),{mode:0o600});
  assert.equal(fingerprint(f.db),before);assert.equal(sha(fs.readFileSync(source)),mainBefore);assert.equal(sha(fs.readFileSync(source+'-wal')),walBefore);
  await canary.verifySnapshot('create-recovery',{backupRoot:path.join(parent,'backup')});
  fs.writeFileSync(path.join(target,'runtime-pack.json'),packBytes,{mode:0o600});
  await canary.restoreShadowCanary('create-recovery',packPin,{backupRoot:path.join(parent,'backup'),restoreDir:target});
  const restored=new DatabaseSync(path.join(target,'dashboard.sqlite'));
  try{
   assert.equal(fingerprint(restored),before);
   const row=restored.prepare('SELECT * FROM crm_campaign_create_v1').get();
   assert.equal(row.phase,'uncertain');assert.equal(row.campaign_id,null);assert.equal(row.created_version,null);assert.notEqual(row.remote_key,row.client_key);assert.equal(f.options().decrypt(row.input_ciphertext),JSON.stringify(f.command()));
   assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM users WHERE role='superadmin' AND email=?").get(canary.ADMIN).count,1);
   const creator=require(path.join(SERVICE,'crm-campaign-create.cjs')).createCampaignCreator({...f.options(),db:restored});
   f.behavior(null);const start=f.calls.length;
   assert.equal((await creator.reconcile(f.ctx,f.selector())).state,'pending');
   const calls=f.calls.slice(start);assert.ok(calls.length>0);assert.ok(calls.every(v=>v.method==='GET'&&v.q.acao==='campanha_operacao'));assert.equal(calls.filter(v=>v.method==='POST').length,0);assert.equal(fingerprint(restored),before);
  }finally{restored.close();}
 });
}
