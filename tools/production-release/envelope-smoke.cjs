'use strict';
// The actual launcher, auth and SQLite recover a committed WAL after a crash.
const fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http'),{spawn,spawnSync}=require('node:child_process'),a=require('node:assert/strict');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 a.equal(process.getuid(),1000);a.equal(process.version,'v22.23.3');
 const token=crypto.randomBytes(24).toString('base64url'),password=crypto.randomBytes(24).toString('base64url'),host='gerencial.shrigma.com.br',email='felipebandeira@oaristocrata.com';
 Object.assign(process.env,{DASHBOARD_MODE:'operational',DASHBOARD_UPSTREAM_PROFILE:'production',DASHBOARD_MANAGER_HOST:host,DASHBOARD_AREA_HOSTS:JSON.stringify({growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'}),DASHBOARD_EMAIL_DOMAINS:'["oaristocrata.com","shrigma.com.br","fishermans.com.br"]',DASHBOARD_ADMIN_EMAIL:email,DASHBOARD_BOOTSTRAP_SHA256:hash(token),DASHBOARD_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DASHBOARD_UPSTREAMS:'{}',DASHBOARD_UPSTREAM_HOSTS:'[]',HOST:'127.0.0.1',PORT:'8080'});
 fs.writeFileSync('/dashboard-data/runtime-pack.json',fs.readFileSync('/app/runtime-pack.json'),{flag:'wx',mode:0o600});
 const request=(path,{method='GET',body}={})=>new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port:8080,path,method,agent:false,headers:{Host:host,Origin:'https://'+host,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})}},res=>{let s='';res.on('data',b=>s+=b);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(s),cookie:res.headers['set-cookie']?.[0]});}catch{reject(Error('SMOKE_RESPONSE'));}});});r.on('error',reject);r.setTimeout(5000,()=>r.destroy(Error('SMOKE_TIMEOUT')));r.end(body?JSON.stringify(body):undefined);});
 const start=()=>spawn(process.execPath,['/app/shrigma-production-launcher.cjs','start'],{stdio:'ignore'});
 const healthy=async child=>{for(let i=0;i<150;i++){a.equal(child.exitCode,null,'LAUNCHER_EXITED');try{const r=await request('/healthz');if(r.status===200)return r.body;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('SMOKE_START_TIMEOUT');};
 const stop=async child=>{if(child.exitCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');let timer;await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SMOKE_STOP_TIMEOUT')),10000);})]).finally(()=>clearTimeout(timer));a.equal(child.exitCode,0);};
 let child=start();
 try{
  await healthy(child);
  a.equal((await request('/auth/bootstrap/complete',{method:'POST',body:{email,token,password}})).status,200);
  a.equal((await request('/auth/login',{method:'POST',body:{email,password}})).status,200);
  await stop(child);
  const crash=spawnSync(process.execPath,['-e',"const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/dashboard-data/dashboard.sqlite');db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0');db.prepare('INSERT INTO identity_metadata(key,encrypted_value) VALUES(?,?)').run('synthetic-wal-recovery','committed-before-crash');if(fs.statSync('/dashboard-data/dashboard.sqlite-wal').size<=0)process.exit(2);process.kill(process.pid,'SIGKILL');"],{stdio:'ignore'});
  a.equal(crash.signal,'SIGKILL');const pendingBytes=fs.statSync('/dashboard-data/dashboard.sqlite-wal').size;a(pendingBytes>0);a(fs.statSync('/dashboard-data/dashboard.sqlite-shm').size>0);
  child=start();const h=await healthy(child),contract=JSON.parse(fs.readFileSync('/app/shrigma-production.json'));
  a.equal(h.nativeBackendManifestSha256,contract.manifestSha256);a.equal(h.journeyPresentationManifestSha256,contract.presentationManifestSha256);
  const login=await request('/auth/login',{method:'POST',body:{email,password}});a.equal(login.status,200);a(login.cookie);
  const health=spawnSync(process.execPath,['/app/shrigma-production-launcher.cjs','health'],{encoding:'utf8'});a.equal(health.status,0);a.equal(JSON.parse(health.stdout.trim()).ok,true);
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync('/dashboard-data/dashboard.sqlite',{readOnly:true});try{a.equal(db.prepare('SELECT encrypted_value FROM identity_metadata WHERE key=?').get('synthetic-wal-recovery').encrypted_value,'committed-before-crash');a.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
  await stop(child);
  console.log(JSON.stringify({schema:'shrigma-envelope-wal-startup-v1',ok:true,node:process.version,uid:process.getuid(),sameComposeLauncher:true,realStartExistingFactory:true,realHealthExisting:true,realSyntheticLogin:true,pendingWalBytes:pendingBytes,committedWalRecovered:true,verifierSubstitutions:0,manualWalRemoval:false,productionIdentityUsed:false,productionDatabaseUsed:false,sourceRevision:contract.sourceRevision}));
 }finally{if(child.exitCode===null)child.kill('SIGTERM');}
}
main().catch(()=>{console.error('ENVELOPE_WAL_STARTUP_FAILED');process.exitCode=1;});
