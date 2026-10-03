'use strict';
// Portable public builder only. Import does not read environment/files/network.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PINS=Object.freeze({builder:'678d0f71221ee24cb67058690b7b81b61b036502487f57fa1aa3b2ca7b8ddf21',originalBootstrap:'804e31f4b2674e469b2114a1fe9961e5192fc3be67a40382b90f1cac1c90da0e',fixedBootstrap:'0292fb5e7da032567fabdb167b1bb84c4b3d0c95142fd82dd6b55188569f5c31'});
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function fail(){throw Error('NATIVE_PREFLIGHT_PLAN_REFUSED');}
function closed(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail();}
function bootModule(base64,pin){const crypto=require('node:crypto'),vm=require('node:vm'),b=Buffer.from(base64,'base64');if(crypto.createHash('sha256').update(b).digest('hex')!==pin)throw Error('NATIVE_PREFLIGHT_REFUSED');const m={exports:{}};new vm.Script('(function(module,exports,require){'+b.toString('utf8')+'\n})').runInThisContext()(m,m.exports,require);return m.exports;}
function initializerEntry(config){
 try{const b=bootModule(config.boot,config.bootSha);b.initializeVolume();}
 catch(e){const category=e?.code==='EACCES'?'permission_denied':e?.code==='ENOMEM'?'memory_refused':'guard_refused';process.stderr.write(JSON.stringify({schema:'crm-manager-native-preflight-diagnostic-v1',phase:'initializer_failed',category})+'\n');process.exitCode=1;}
}
function runtimeEntry(config){
 const fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');let phase='runtime_guard';
 const refuse=()=>{throw Error('NATIVE_PREFLIGHT_REFUSED');};
 try{
  if(Object.keys(process.env).some(k=>k.startsWith('PG')||k==='DATABASE_URL'))refuse();
  const b=bootModule(config.boot,config.bootSha),raw=Buffer.from(process.argv.slice(1).join(''),'base64');if(raw.length>262144||sha(raw)!==config.bundleSha)refuse();
  // Synthetic presence exercises the exact guard. No caller credential is read.
  process.env.PGPASSWORD='NATIVE_SMOKE_SYNTHETIC_ONLY';
  const expected=config.status,body=JSON.stringify(expected);
  const load=file=>{
   if(file==='/app/node_modules/pg/package.json')return require(file); // Metadata only.
   if(file!=='/review/supervisor/supervisor.cjs')refuse();
   return{startCli(argv,env){
    if(JSON.stringify(argv)!=='["install"]')refuse();delete env.PGPASSWORD;phase='staged_source';
    for(const[name,pin]of Object.entries(b.EXPECTED)){const file='/review/'+name,s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o7777)!==0o444||sha(fs.readFileSync(file))!==pin)refuse();}
    if(Object.keys(env).some(k=>k.startsWith('PG')||k==='DATABASE_URL'))refuse();
    phase='proof_fsync';const dir='/manager-install-proof',file=dir+'/native-preflight.json';
    const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const d=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
    const readProof=()=>{const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.uid!==1000||before.gid!==1000||(before.mode&0o7777)!==0o600)refuse();const p=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let first,second,content;try{first=fs.fstatSync(p);fs.fsyncSync(p);content=fs.readFileSync(p,'utf8');second=fs.fstatSync(p);}finally{fs.closeSync(p);}const directory=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}const after=fs.lstatSync(file);if(first.ino!==before.ino||first.dev!==before.dev||first.size!==before.size||first.ino!==second.ino||first.dev!==second.dev||first.size!==second.size||before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||after.uid!==1000||after.gid!==1000||(after.mode&0o7777)!==0o600||content!==body)refuse();};
    readProof();phase='local_health';
    const server=http.createServer((q,r)=>{if(q.method!=='GET'||q.url!=='/status'){r.writeHead(404);return r.end();}try{readProof();r.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});r.end(body);}catch{r.writeHead(503);r.end();}});
    server.on('error',()=>{process.exitCode=1;server.close();});server.listen(8098,'127.0.0.1');return server;
   }};
  };
  const result=b.bootstrap(JSON.parse(raw.toString('utf8')),{load});if(!result)refuse();
 }catch{delete process.env.PGPASSWORD;process.stderr.write(JSON.stringify({schema:'crm-manager-native-preflight-diagnostic-v1',phase,category:'guard_refused'})+'\n');process.exitCode=1;}
}
function healthEntry(expected){const http=require('node:http');const request=http.get('http://127.0.0.1:8098/status',{timeout:2000},res=>{const chunks=[];let bytes=0;res.on('data',c=>{bytes+=c.length;if(bytes>2048)return request.destroy();chunks.push(c);});res.on('end',()=>{try{const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode!==200||JSON.stringify(v)!==JSON.stringify(expected))throw Error();process.exit(0);}catch{process.exit(1);}});});request.on('timeout',()=>request.destroy());request.on('error',()=>process.exit(1));}
function buildPreflight(options){
 closed(options,['suffix','runtimeRoot','pidsProfile']);const{suffix,runtimeRoot=path.resolve(__dirname,'../runtime'),pidsProfile='canonical'}=options;
 if(typeof suffix!=='string'||!/^[a-f0-9]{12}$/.test(suffix)||typeof runtimeRoot!=='string'||!path.isAbsolute(runtimeRoot)||!['canonical','pids_limit_only'].includes(pidsProfile))fail();
 const builderFile=path.join(runtimeRoot,'compose/build-compose.cjs'),runtimeBoot=fs.readFileSync(path.join(runtimeRoot,'compose/bootstrap.cjs')),fixedBoot=fs.readFileSync(path.join(__dirname,'bootstrap.fixed.cjs'));
 if(sha(fs.readFileSync(builderFile))!==PINS.builder||![PINS.originalBootstrap,PINS.fixedBootstrap].includes(sha(runtimeBoot))||sha(fixedBoot)!==PINS.fixedBootstrap)fail();
 const {buildCompose}=require(builderFile),plan=buildCompose({suffix}),c=JSON.parse(plan.json),s=c.services.installer,init=c.services.prepare_volume;
 const bundle=Buffer.from(s.entrypoint.slice(5).join(''),'base64');if(sha(bundle)!==plan.bundleSha256)fail();
 const status={schema:'crm-manager-native-preflight-v1',phase:'passed',mode:'no-sql',bootstrapSha256:PINS.fixedBootstrap,bundleSha256:plan.bundleSha256,nodeMajor:22,uid:1000,gid:1000,sourceFiles:8,proofDurable:true,externalNetwork:false,pidsProfile};
 const args={boot:fixedBoot.toString('base64'),bootSha:PINS.fixedBootstrap,bundleSha:plan.bundleSha256,status};
 const entry=fn=>'const bootModule='+bootModule.toString()+';('+fn.toString()+')('+JSON.stringify(args)+');';
 init.entrypoint=['node','--max-old-space-size=16','-e',entry(initializerEntry)];
 s.entrypoint=['node','--max-old-space-size=96','-e',entry(runtimeEntry),'--',...bundle.toString('base64').match(/.{1,24576}/g)];
 delete s.env_file;delete s.networks;s.network_mode='none';delete c.networks;
 s.healthcheck={test:['CMD','node','--max-old-space-size=16','-e','('+healthEntry.toString()+')('+JSON.stringify(status)+');'],interval:'5s',timeout:'3s',start_period:'10s',retries:2};
 if(pidsProfile==='pids_limit_only'){delete init.deploy.resources.limits.pids;delete s.deploy.resources.limits.pids;}
 const composeProjectName='shrigma-native-preflight-'+suffix,volume=Object.keys(c.volumes)[0],volumeName='shrigma-native-preflight-volume-'+suffix;
 c.volumes[volume].name=volumeName;c.volumes[volume].labels={'com.shrigma.purpose':'crm-manager-native-preflight','com.shrigma.exclusive-service':composeProjectName};
 c['x-shrigma-install-review']={schema:'crm-manager-native-preflight-plan-v1',composeProjectName,noSql:true,noCredentials:true,runtimeBootstrapSha256:sha(runtimeBoot),testedBootstrapSha256:PINS.fixedBootstrap,bundleSha256:plan.bundleSha256,pidsProfile};
 const json=JSON.stringify(c,null,2)+'\n';if(json.includes('${')||Buffer.byteLength(json)>524288||[...init.entrypoint,...s.entrypoint].some(v=>Buffer.byteLength(v)>98304))fail();
 return Object.freeze({composeProjectName,volumeName,json,status,composeSha256:sha(json),pidsProfile});
}
module.exports={buildPreflight,PINS};
if(require.main===module){try{const[suffix,out,runtimeRoot,pidsProfile,...extra]=process.argv.slice(2);if(extra.length||!path.isAbsolute(out||''))fail();const plan=buildPreflight({suffix,runtimeRoot,pidsProfile});fs.writeFileSync(path.join(out,'compose.preflight.json'),plan.json,{flag:'wx',mode:0o600});fs.writeFileSync(path.join(out,'plan.metadata.json'),JSON.stringify({...plan,json:undefined},null,2)+'\n',{flag:'wx',mode:0o600});}catch{process.stderr.write('Native preflight plan refused.\n');process.exitCode=1;}}
