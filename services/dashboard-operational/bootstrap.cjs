'use strict';
const fs=require('node:fs'),path=require('node:path');
const {unpack,MAX_PACK_BYTES}=require('./artifact-policy.cjs');
const DATA_DIR='/dashboard-data',PACK_FILE=DATA_DIR+'/runtime-pack.json',SEED_FILE='/app/runtime-pack.json',DB_FILE=DATA_DIR+'/dashboard.sqlite';
function checkIdentity({uid=process.getuid?.(),gid=process.getgid?.(),expectedUid=1000,expectedGid=1000}={}){
 if(uid!==expectedUid||gid!==expectedGid||!Number.isSafeInteger(expectedUid)||expectedUid===0||!Number.isSafeInteger(expectedGid)||expectedGid===0)throw Error('RUNTIME_IDENTITY_INVALID');
 return {uid,gid};
}
function checkStorage({dataDir=DATA_DIR,expectedUid=1000,fsImpl=fs}={}){
 const dir=fsImpl.lstatSync(dataDir);
 if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==expectedUid||(dir.mode&0o777)!==0o700||fsImpl.realpathSync(dataDir)!==dataDir)throw Error('RUNTIME_VOLUME_INVALID');
 fsImpl.accessSync(dataDir,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);
 const dbFile=path.join(dataDir,'dashboard.sqlite');
 for(const file of [dbFile,dbFile+'-wal',dbFile+'-shm'])if(fsImpl.existsSync(file)){
  const stat=fsImpl.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==expectedUid||(stat.mode&0o777)!==0o600)throw Error('RUNTIME_DATABASE_INVALID');
 }
 return dbFile;
}
function selectPackFile({dataDir=DATA_DIR,seedFile=SEED_FILE,fsImpl=fs}={}){
 // Once a volume exists it is authoritative: absence/corruption cannot revive
 // an obsolete seed. Initial installation must explicitly seed the new volume.
 if(!fsImpl.existsSync(dataDir))return seedFile;
 const dir=fsImpl.lstatSync(dataDir),file=path.join(dataDir,'runtime-pack.json');
 if(!dir.isDirectory()||dir.isSymbolicLink()||!fsImpl.existsSync(file))throw Error('RUNTIME_PACK_MISSING');
 const stat=fsImpl.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_PACK_BYTES)throw Error('RUNTIME_PACK_INVALID');
 return file;
}
function pinnedEnv(env=process.env){
 if(!['synthetic','operational'].includes(env.DASHBOARD_MODE)||!/^[a-f0-9]{64}$/.test(env.DASHBOARD_PACK_SHA256||''))throw Error('RUNTIME_CONFIG_INVALID');
 if(env.DASHBOARD_DB_PATH!==undefined&&env.DASHBOARD_DB_PATH!==DB_FILE)throw Error('RUNTIME_DATABASE_PATH_INVALID');
 if(env.DASHBOARD_EXPECT_UID!==undefined&&env.DASHBOARD_EXPECT_UID!=='1000')throw Error('RUNTIME_UID_CONFIG_INVALID');
 if(env.DASHBOARD_EXPECT_GID!==undefined&&env.DASHBOARD_EXPECT_GID!=='1000')throw Error('RUNTIME_GID_CONFIG_INVALID');
 return {...env,DASHBOARD_DB_PATH:DB_FILE,DASHBOARD_EXPECT_UID:'1000'};
}
// Called after artifact admission by start(). Exported for source-level
// initialization tests; it does not replace UID/pack/storage admission.
function initializeArtifactRuntime(artifact,env,identityStoreInput){
 let store;
 try{
  const runtime=require(path.join(artifact.runtimeDir,'server.cjs'));
  const settings=runtime.settingsFromEnv({...env,DASHBOARD_PUBLIC_DIR:artifact.publicDir});
  if(identityStoreInput!==undefined){
   // A SQLite lease must address the same actual configured store.
   if((identityStoreInput.dialect??'sqlite-v1')==='sqlite-v1'&&identityStoreInput.dbPath!==settings.dbPath)throw Error('RUNTIME_FACTORY_STARTUP_REFUSED');
   store=require(path.join(artifact.runtimeDir,'identity-store-factory.cjs')).openIdentityStore(identityStoreInput);
  }
  return runtime.initializeRuntime(settings,store);
 }catch{
  try{store?.close();}catch{}
  const error=new Error('RUNTIME_FACTORY_STARTUP_REFUSED');error.code='RUNTIME_FACTORY_STARTUP_REFUSED';throw error;
 }
}
function start(startupOptions){
 if(startupOptions!==undefined&&(!startupOptions||typeof startupOptions!=='object'||Array.isArray(startupOptions)||Object.keys(startupOptions).some(key=>key!=='identityStoreInput')))throw Error('RUNTIME_FACTORY_STARTUP_REFUSED');
 checkIdentity();process.umask(0o077);
 const env=pinnedEnv();checkStorage();
 // Validate pin, allowlist and bytes before importing code or touching SQLite.
 const parent=fs.realpathSync(fs.mkdtempSync('/tmp/shrigma-operational-'));
 let artifact;
 try{artifact=unpack(selectPackFile(),path.join(parent,'artifact'),{expectedSha256:env.DASHBOARD_PACK_SHA256});}
 catch(error){fs.rmSync(parent,{recursive:true,force:true});throw error;}
 let initialized;
 try{initialized=initializeArtifactRuntime(artifact,env,startupOptions?.identityStoreInput);}
 catch(error){fs.rmSync(parent,{recursive:true,force:true});throw error;}
 const {auth,managedCrmRuntime,server}=initialized;
 let closing=false,failureSeen=false;
 const fail=()=>{if(!failureSeen)console.error('Dashboard operational startup refused.');failureSeen=true;process.exitCode=1;};
 const close=(failed=false)=>{
  // An error may arrive while a signal is already draining, or after cleanup.
  // Preserve that failure without starting a second identity finalizer.
  if(failed)fail();
  if(closing)return;
  closing=true;
  Promise.allSettled([initialized.close()]).then(results=>{
   if(results.some(result=>result.status==='rejected'))fail();
   try{fs.rmSync(parent,{recursive:true,force:true});}catch{fail();}
   if(!failureSeen)process.exitCode=0;
  });
 };
 process.once('SIGTERM',()=>close());process.once('SIGINT',()=>close());
 server.on('error',()=>close(true));
 try{initialized.listen(()=>console.log('Dashboard operational service listening; artifact verified; persistent identity volume ready.'));}
 catch{close(true);const error=new Error('RUNTIME_FACTORY_LISTEN_REFUSED');error.code='RUNTIME_FACTORY_LISTEN_REFUSED';throw error;}
 return {server,artifact};
}
if(require.main===module){try{start();}catch{console.error('Dashboard operational startup refused: invalid identity, volume, configuration or artifact.');process.exitCode=1;}}
module.exports={DATA_DIR,PACK_FILE,SEED_FILE,DB_FILE,checkIdentity,checkStorage,selectPackFile,pinnedEnv,initializeArtifactRuntime,start};
