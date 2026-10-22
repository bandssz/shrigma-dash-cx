'use strict';
// Snapshot job guard: inspect only metadata, then permit one backup attempt.
const fs=require('node:fs');
const path=require('node:path');
const {createBackup,verifyBackup}=require('./backup-identity.cjs');
const SOURCE_DIR='/source-data';
const SOURCE_FILE='/source-data/dashboard.sqlite';
const OUTPUT_DIR='/snapshot-data';
const MAX_DB=512*1024*1024;
const BASE_ENV=new Set(['PATH','NODE_VERSION','YARN_VERSION','HOME','HOSTNAME','TERM','TZ','LANG','LC_ALL']);
function fail(){throw Error('SNAPSHOT_PREFLIGHT_REFUSED');}
function mountOptions(text,mountpoint){
 const matches=text.split('\n').filter(Boolean).map(line=>line.split(' - ')[0].split(' ')).filter(fields=>fields[4]===mountpoint);
 if(matches.length!==1||matches[0].length<6)fail();
 return matches[0][5].split(',');
}
function privateDir(s){return s?.isDirectory()&&s.uid===1000&&(s.mode&0o777)===0o700;}
function privateDb(s){return s?.isFile()&&s.uid===1000&&(s.mode&0o777)===0o600&&s.nlink===1&&s.size>0&&s.size<=MAX_DB;}
function privateSidecar(s){return s?.isFile()&&s.uid===1000&&(s.mode&0o777)===0o600&&s.nlink===1&&s.size>=0&&s.size<=MAX_DB;}
function assess({uid,gid,mountinfo,interfaces,sourceDir,sourceDb,wal,shm,outputDir,outputEntries,env,status,memoryMax,cpuMax}){
 const rootRO=mountOptions(mountinfo,'/').includes('ro');
 const sourceRO=mountOptions(mountinfo,SOURCE_DIR).includes('ro');
 const outputRW=mountOptions(mountinfo,OUTPUT_DIR).includes('rw');
 const separate=sourceDir.dev!==outputDir.dev||sourceDir.ino!==outputDir.ino;
 const statusValue=name=>new RegExp('^'+name+':\\s*([^\\n]+)','m').exec(status)?.[1]?.trim();
 const noCapabilities=['CapEff','CapPrm','CapBnd','CapAmb'].every(name=>/^0+$/.test(statusValue(name)||''));
 const noNewPrivileges=statusValue('NoNewPrivs')==='1';
 const memory=Number(memoryMax.trim());
 const cpu=/^(\d+) (\d+)\s*$/.exec(cpuMax);
 const boundedResources=Number.isSafeInteger(memory)&&memory>0&&memory<=512*1024*1024&&!!cpu&&Number(cpu[1])>0&&Number(cpu[2])>0&&Number(cpu[1])/Number(cpu[2])<=0.5;
 return uid===1000&&gid===1000&&rootRO&&sourceRO&&outputRW&&separate&&
  noCapabilities&&noNewPrivileges&&boundedResources&&
  privateDir(sourceDir)&&privateDir(outputDir)&&privateDb(sourceDb)&&
  (wal===null||privateSidecar(wal))&&(shm===null||privateSidecar(shm))&&
  Array.isArray(outputEntries)&&outputEntries.length===0&&
  Array.isArray(interfaces)&&interfaces.length===1&&interfaces[0]==='lo'&&
  Object.keys(env).every(k=>BASE_ENV.has(k));
}
function optionalStat(file){try{return fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function checkLocal(){
 const sourceDir=fs.lstatSync(SOURCE_DIR),outputDir=fs.lstatSync(OUTPUT_DIR);
 if(sourceDir.isSymbolicLink()||outputDir.isSymbolicLink())fail();
 const sourceDb=fs.lstatSync(SOURCE_FILE),wal=optionalStat(SOURCE_FILE+'-wal'),shm=optionalStat(SOURCE_FILE+'-shm');
 if(sourceDb.isSymbolicLink()||wal?.isSymbolicLink()||shm?.isSymbolicLink())fail();
 const result=assess({uid:process.getuid(),gid:process.getgid(),mountinfo:fs.readFileSync('/proc/self/mountinfo','utf8'),interfaces:fs.readdirSync('/sys/class/net').sort(),sourceDir,sourceDb,wal,shm,outputDir,outputEntries:fs.readdirSync(OUTPUT_DIR),env:process.env,status:fs.readFileSync('/proc/self/status','utf8'),memoryMax:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8'),cpuMax:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8')});
 if(!result)fail();
 return true;
}
function marker(){
 const file=path.join(OUTPUT_DIR,'.attempted');
 const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeSync(fd,'snapshot-attempt-v1\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function writeDone(result){
 const file=path.join(OUTPUT_DIR,'.done');
 const data=JSON.stringify({schema:'identity_snapshot_done_v1',bytes:result.bytes,sha256:result.sha256})+'\n';
 const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
async function health(){
 const names=fs.readdirSync(OUTPUT_DIR).sort();
 if(names.join(',')!=='.attempted,.done,identity')fail();
 const donePath=path.join(OUTPUT_DIR,'.done');
 const s=fs.lstatSync(donePath);
 if(!s.isFile()||s.isSymbolicLink()||s.uid!==1000||(s.mode&0o777)!==0o600||s.nlink!==1||s.size>256)fail();
 let done;try{done=JSON.parse(fs.readFileSync(donePath,'utf8'));}catch{fail();}
 if(done.schema!=='identity_snapshot_done_v1'||!Number.isSafeInteger(done.bytes)||done.bytes<1||done.bytes>MAX_DB||typeof done.sha256!=='string'||!/^[a-f0-9]{64}$/.test(done.sha256))fail();
 const verified=await verifyBackup(path.join(OUTPUT_DIR,'identity'));
 if(verified.bytes!==done.bytes||verified.sha256!==done.sha256)fail();
 return true;
}
async function main(mode){
 if(mode==='health'){await health();return;}
 checkLocal();
 if(mode==='check')return;
 if(mode==='hold'){
  console.log('{"schema":"identity_snapshot_preflight_v1","pass":true}');
  setInterval(()=>{},3600000);return;
 }
 if(mode==='backup'){
  marker();
  const result=await createBackup(SOURCE_FILE,path.join(OUTPUT_DIR,'identity'));
  writeDone(result);
  console.log('{"schema":"identity_snapshot_once_v1","verified":true}');
  setInterval(()=>{},3600000);return;
 }
 fail();
}
if(require.main===module){
 main(process.argv[2]).catch(()=>{console.error('{"schema":"identity_snapshot_preflight_v1","pass":false}');process.exitCode=1;});
}
module.exports={assess,checkLocal,mountOptions};
