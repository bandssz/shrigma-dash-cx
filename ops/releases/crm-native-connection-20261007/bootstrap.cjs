'use strict';
// Fresh, explicit backend admission. Old pack/seals/controller/73a stay intact.
// The old presentation verifier covers its own artifact. This verifier covers
// the actual 46-file runtime used by this server, including three replacements.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT='/app/native-backend',READY='/tmp/shrigma-native-ready-v1.json';
const PARENT='ghcr.io/bandssz/shrigma-dash-crm-presentation-v2@sha256:1adba1fb8a222684b300ed49fbb2f0adf681bd24ab679022eb15c765328f4911';
const BASE_PACK='c80ee2a8f2611b9cb17a5d24b9b1668a7fe4218a2a95e73cb706e5b6682980da';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const refuse=()=>{throw Error('NATIVE_BACKEND_RELEASE_REFUSED');};
const same=(a,b)=>['dev','ino','size','mode','nlink','uid','gid','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
function read(file,{uid=0,gid=0,mode=0o444,max=2*1024*1024}={}){
 const s=fs.lstatSync(file);if(fs.realpathSync(file)!==file||!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==uid||s.gid!==gid||(s.mode&0o777)!==mode||s.size<1||s.size>max)refuse();
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{if(!same(s,fs.fstatSync(fd)))refuse();const b=fs.readFileSync(fd);if(b.length!==s.size||!same(s,fs.fstatSync(fd))||!same(s,fs.lstatSync(file)))refuse();return b;}finally{fs.closeSync(fd);}
}
function verifyRelease(manifestSha256){
 if(!/^[a-f0-9]{64}$/.test(manifestSha256||''))refuse();
 for(const dir of [ROOT,ROOT+'/runtime',ROOT+'/runtime/native-continuity',ROOT+'/runtime/own-foundation',ROOT+'/runtime/journey-read']){const s=fs.lstatSync(dir);if(fs.realpathSync(dir)!==dir||!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&0o777)!==0o555)refuse();}
 const bytes=read(ROOT+'/manifest.json',{max:16384});if(sha(bytes)!==manifestSha256)refuse();const m=JSON.parse(bytes);
 if(Object.keys(m).sort().join(',')!=='additions,basePackSha256,baseRuntime,databaseInspectionEnabled,files,historicalActivationReplayed,identityDatabase,operational,originalPackPreserved,parentImage,pgDriverManifestSha256,presentationChangedPaths,presentationManifestSha256,replacements,schema,sourceRevision,sqlInstallerEnabled'||m.schema!=='shrigma-native-backend-release-v2'||m.databaseInspectionEnabled!==true||!/^[a-f0-9]{64}$/.test(m.pgDriverManifestSha256||'')||!/^[a-f0-9]{64}$/.test(m.presentationManifestSha256||'')||JSON.stringify(m.presentationChangedPaths)!=='["assets/panels/growth.js","growth.html"]'||sha(read('/app/presentation-release/manifest.json',{max:16384}))!==m.presentationManifestSha256||m.parentImage!==PARENT||m.basePackSha256!==BASE_PACK||!/^[a-f0-9]{40}$/.test(m.sourceRevision)||m.identityDatabase!=='/dashboard-data/dashboard.sqlite'||m.originalPackPreserved!==true||m.historicalActivationReplayed!==false||m.sqlInstallerEnabled!==false||m.operational!==false||JSON.stringify(m.replacements)!=='["auth.cjs","server.cjs","proxy.cjs"]'||JSON.stringify(m.additions)!=='["crm-native-delegation.cjs","crm-native-mcp.cjs","crm-native-operator.cjs","native-continuity/read-only.cjs","native-continuity/pins.json","native-database-vault.cjs","native-database-operator.cjs","native-database-inventory.cjs","native-pg-driver.cjs","native-foundation-preview.cjs","own-foundation/foundation.cjs","own-foundation/manifest.json","own-foundation/sql.cjs","own-foundation/bootstrap-v1.sql","crm-journey-read.cjs","journey-read/growth-flows.js","crm-master-audience-read.cjs","crm-master-audience-count.cjs"]')refuse();
 const policy=require('/app/artifact-policy.cjs'),old=policy.decodePack(read('/app/runtime-pack.json').toString(),BASE_PACK);
 const base=old.files.filter(f=>f.path.startsWith('runtime/')).map(f=>({path:f.path.slice(8),b:Buffer.from(f.content,f.encoding)})).sort((a,b)=>a.path.localeCompare(b.path));
 if(base.length!==28||JSON.stringify(base.map(f=>({path:f.path,sha256:sha(f.b),bytes:f.b.length})))!==JSON.stringify(m.baseRuntime))refuse();
 const expected=['bootstrap.cjs','start-existing.cjs','health-existing.cjs',...base.map(f=>'runtime/'+f.path),...m.additions.map(f=>'runtime/'+f)].sort();
 const actual=[];function scan(dir,prefix=''){for(const name of fs.readdirSync(dir)){const file=dir+'/'+name;if(fs.lstatSync(file).isDirectory()){if(!['native-continuity','own-foundation','journey-read'].includes(prefix+name))refuse();scan(file,prefix+name+'/');}else actual.push(prefix+name);}}scan(ROOT+'/runtime');
 if(!Array.isArray(m.files)||m.files.length!==49||JSON.stringify(m.files.map(f=>f.path).sort())!==JSON.stringify(expected)||fs.readdirSync(ROOT).sort().join(',')!=='bootstrap.cjs,health-existing.cjs,manifest.json,runtime,start-existing.cjs'||JSON.stringify(actual.sort())!==JSON.stringify(expected.filter(f=>f.startsWith('runtime/')).map(f=>f.slice(8))))refuse();
 for(const f of m.files){if(Object.keys(f).sort().join(',')!=='bytes,path,sha256'||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<1)refuse();const b=read(ROOT+'/'+f.path);if(b.length!==f.bytes||sha(b)!==f.sha256)refuse();const before=base.find(v=>'runtime/'+v.path===f.path);if(before&&!(m.replacements.includes(before.path))&&!b.equals(before.b)||before&&m.replacements.includes(before.path)&&b.equals(before.b))refuse();}
 require(ROOT+'/runtime/native-pg-driver.cjs').verifyDriver(m.pgDriverManifestSha256);
 return m;
}
function verifyReady({manifestSha256}){
 const m=verifyRelease(manifestSha256),r=JSON.parse(read(READY,{uid:1000,gid:1000,mode:0o600,max:1024}));
 if(Object.keys(r).sort().join(',')!=='manifestSha256,schema,sourceRevision'||r.schema!=='shrigma-native-ready-v1'||r.manifestSha256!==manifestSha256||r.sourceRevision!==m.sourceRevision)refuse();
 return {nativeBackendVerified:true,manifestSha256,sourceRevision:m.sourceRevision,runtimeFiles:46,runtimeReplacements:3,originalRuntimePreserved:25,runtimeAdditions:18,databaseInspectionEnabled:true,pgDriverManifestSha256:m.pgDriverManifestSha256,sqlInstallerEnabled:false,operational:false};
}
function start({manifestSha256}={}){
 const m=verifyRelease(manifestSha256),boot=require('/app/bootstrap.cjs');boot.checkIdentity();process.umask(0o077);
 // Production prestart uses the separately admitted read-only verifier.
 // This bootstrap invokes no historical activation or issuer helper.
 if(process.env.DASHBOARD_PACK_SHA256!==undefined&&process.env.DASHBOARD_PACK_SHA256!==BASE_PACK)refuse();
 // The old canary prepared these in RAM. Derive only the already verified pin;
 // do not invoke its seeding/chmod path against the existing identity volume.
 const env=boot.pinnedEnv({...process.env,DASHBOARD_PACK_SHA256:BASE_PACK});boot.checkStorage();
 const parent=fs.realpathSync(fs.mkdtempSync('/tmp/shrigma-operational-'));let artifact,auth,server,databaseInventory,foundationPreview;
 try{
  artifact=require('/app/artifact-policy.cjs').unpack(boot.selectPackFile(),path.join(parent,'artifact'),{expectedSha256:BASE_PACK});
  const runtime=require(ROOT+'/runtime/server.cjs'),settings=runtime.settingsFromEnv({...env,DASHBOARD_NATIVE_MCP:'enabled',DASHBOARD_PUBLIC_DIR:artifact.publicDir});
  settings.crmNativeManifestSha256=manifestSha256;
  settings.crmNativeDatabaseInspection=true;
  settings.crmJourneyPresentationManifestSha256=m.presentationManifestSha256;
  auth=require(ROOT+'/runtime/auth.cjs').createAuth({...runtime.authOptionsFor(settings),crmNativeDatabaseEnabled:true});
  const driver=require(ROOT+'/runtime/native-pg-driver.cjs').loadPGDriver(m.pgDriverManifestSha256),vault=auth.nativeDatabaseVault;
  databaseInventory=require(ROOT+'/runtime/native-database-inventory.cjs').createDatabaseInventory({enabled:true,driver,getPrivateCredential:q=>vault.getPrivateCredential(q),admitInspection:q=>vault.admitInspection(q)});
  foundationPreview=require(ROOT+'/runtime/native-foundation-preview.cjs').createFoundationPreview({enabled:true,driver,vault});
  const installerOff=()=>{throw Object.assign(Error('NATIVE_INSTALLER_NOT_ADMITTED'),{code:'NATIVE_INSTALLER_NOT_ADMITTED',status:503});};
  const nativeInstaller={inspect:async(q,context)=>{
   const before=vault.inspectionBinding(context.ownerId),result=await databaseInventory.inspect(q,{ownerId:context.ownerId}),after=vault.inspectionBinding(context.ownerId);
   if(JSON.stringify(before)!==JSON.stringify(after))throw Object.assign(Error('DB_INSPECTION_ADMISSION_CHANGED'),{code:'DB_INSPECTION_ADMISSION_CHANGED',status:409});return result;
  },preview:async(q,context)=>{
   const before=vault.inspectionBinding(context.ownerId),result=await foundationPreview.preview(q,context),after=vault.inspectionBinding(context.ownerId);
   if(JSON.stringify(before)!==JSON.stringify(after))throw Object.assign(Error('DB_INSPECTION_ADMISSION_CHANGED'),{code:'DB_INSPECTION_ADMISSION_CHANGED',status:409});return result;
  },apply:installerOff,status:installerOff};
  const managedCrmRuntime=runtime.managedRuntimeFor(settings,auth);server=runtime.createServer(settings,{auth,managedCrmRuntime,nativeInstaller});
  let closing=false,failed=false;
  const close=(failure=false)=>{if(failure||process.exitCode){failed=true;process.exitCode=1;}if(closing)return;closing=true;const drain=Promise.allSettled([Promise.resolve().then(()=>managedCrmRuntime?.close()),Promise.resolve().then(()=>databaseInventory?.close()),Promise.resolve().then(()=>foundationPreview?.close())]).then(r=>{if(r.some(v=>v.status==='rejected'))throw Error('NATIVE_DRAIN_FAILED');});const stopped=new Promise(resolve=>{try{server.close(()=>resolve());server.closeIdleConnections?.();}catch{resolve();}});Promise.allSettled([drain,stopped]).then(results=>{if(results.some(r=>r.status==='rejected'))failed=true;try{auth.close();fs.rmSync(parent,{recursive:true,force:true});fs.rmSync(READY,{force:true});}catch{failed=true;}process.exitCode=failed?1:0;});};
  server.on('error',()=>close(true));process.once('SIGTERM',()=>close());process.once('SIGINT',()=>close());
  const fd=fs.openSync(READY,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,JSON.stringify({schema:'shrigma-native-ready-v1',manifestSha256,sourceRevision:m.sourceRevision})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  server.listen(settings.port,settings.host);
  return {server,artifact,nativeBackend:{manifestSha256,sourceRevision:m.sourceRevision,sqlInstallerEnabled:false,operational:false}};
 }catch(e){try{server?.close();databaseInventory?.close()?.catch(()=>{});foundationPreview?.close()?.catch(()=>{});auth?.close();fs.rmSync(parent,{recursive:true,force:true});}catch{}throw e;}
}
module.exports={verifyRelease,verifyReady,start,ROOT,READY};
