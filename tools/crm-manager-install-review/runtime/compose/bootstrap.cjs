'use strict';
// Pure on import. Runtime reads only fixed local kernel/volume metadata.
const fs=require('node:fs'),crypto=require('node:crypto');
const EXPECTED=Object.freeze({'run-install.cjs':'ed5b2c033b04fb1d6fc7ab818ac095bbfb207134b1442e14a004d8c62701e75e','sql/installer.sql':'33a412f3d8b8fc4293010e2aec95dc5a8ba3f1296f86000d50e79cfb87ec0bd9','sql/rollback.sql':'dace1eab926186c4aa277d89c92813ce0ac06cc5fd971c0569f2cd9ef0734d4f','sql/profile.sql':'a20c51e10dfff6c781b94158ed392a38c1ec64d30966281ecd2ede72e52f62e9','sql/objects.sql':'00ebc821445ec653bd96b01fa1b74a82207551a1cebd1498e7ddd512bc41a370','sql/empty.sql':'a55f9a2fe863f5797383915b0239f3aab5e3733dcdc8ee222b7ff3f4a9fdb697','supervisor/supervisor.cjs':'5610bad16343e8e4bc6398c004f0875858698e0871236bf34d4199372ee4f6b0','supervisor/health.cjs':'03498749c08cbaf62ad6e8320e7e31cc2f40a05ca8b671db21de5288a4502ea1'});
function fail(){throw Error('MANAGER_INSTALL_BOOTSTRAP_REFUSED');}
function closed(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function text(f,file,max=65536){const value=f.readFileSync(file,'utf8');if(typeof value!=='string'||Buffer.byteLength(value)>max)fail();return value;}
function integer(value){if(!/^[1-9][0-9]{0,15}$/.test(value.trim()))fail();return BigInt(value.trim());}
function limits(f,{cpuDenominator,memory,pids}){
 const cpu=text(f,'/sys/fs/cgroup/cpu.max',128).trim().split(/\s+/);if(cpu.length!==2||integer(cpu[0])*BigInt(cpuDenominator)>integer(cpu[1]))fail();
 if(integer(text(f,'/sys/fs/cgroup/memory.max',128))>BigInt(memory)||integer(text(f,'/sys/fs/cgroup/pids.max',128))>BigInt(pids))fail();
}
function mounts(f){return text(f,'/proc/self/mountinfo').trim().split('\n').map(line=>{
 const fields=line.split(' '),sep=fields.indexOf('-');if(sep<6||fields.length<sep+4)fail();
 const point=fields[4].replace(/\\(040|011|012|134)/g,(_,n)=>({'040':' ','011':'\t','012':'\n','134':'\\'}[n]));if(/\\[0-9]/.test(point))fail();
 return{point,flags:fields[5].split(','),type:fields[sep+1],superFlags:fields[sep+3].split(',')};
 });}
function status(f,cap){const raw=text(f,'/proc/self/status',16384);for(const field of ['CapEff','CapPrm','CapBnd']){const value=raw.match(new RegExp('^'+field+':\\s*([0-9a-fA-F]+)$','m'));if(!value||BigInt('0x'+value[1])!==BigInt(cap))fail();}if(!/^NoNewPrivs:\s*1$/m.test(raw))fail();}
function directory(f,file,uid,gid,mode){const stat=f.lstatSync(file);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||stat.gid!==gid||(stat.mode&0o7777)!==mode)fail();if(f.readdirSync(file).length!==0)fail();return stat;}
function common(proc,f,cap){
 if(proc.platform!=='linux'||proc.versions.node.split('.')[0]!=='22')fail();status(f,cap);
 const m=mounts(f),root=m.filter(v=>v.point==='/');if(root.length!==1||!root[0].flags.includes('ro'))fail();
 if(m.some(v=>/(^|\/)\.ssh(\/|$)|(^|\/)\.aws(\/|$)|\/docker\.sock$/.test(v.point)))fail();
 const proof=m.filter(v=>v.point==='/manager-install-proof');if(proof.length!==1||!proof[0].flags.includes('rw')||proof[0].type==='tmpfs')fail();return m;
}
function guardRuntime({proc=process,fsImpl=fs}={}){
 if(proc.getuid()!==1000||proc.getgid()!==1000||!proc.execArgv.includes('--max-old-space-size=96'))fail();
 if(Object.keys(proc.env).some(k=>k.startsWith('PG')&&k!=='PGPASSWORD'||k==='DATABASE_URL')||!Object.hasOwn(proc.env,'PGPASSWORD'))fail();
 const m=common(proc,fsImpl,0);limits(fsImpl,{cpuDenominator:4,memory:268435456,pids:32});
 const review=m.filter(v=>v.point==='/review');if(review.length!==1||review[0].type!=='tmpfs'||!['rw','nosuid','nodev','noexec'].every(v=>review[0].flags.includes(v)))fail();
 const size=review[0].superFlags.map(v=>/^size=([1-9][0-9]*)([kmg]?)$/.exec(v)).find(Boolean);if(!size||BigInt(size[1])*({k:1024n,m:1048576n,g:1073741824n,'':1n}[size[2]])>67108864n)fail();
 directory(fsImpl,'/review',1000,1000,0o700);directory(fsImpl,'/manager-install-proof',1000,1000,0o700);return true;
}
function initializeVolume({proc=process,fsImpl=fs}={}){
 if(proc.getuid()!==0||proc.getgid()!==0||!proc.execArgv.includes('--max-old-space-size=16')||Object.keys(proc.env).some(k=>k.startsWith('PG')||k==='DATABASE_URL'))fail();
 common(proc,fsImpl,1);limits(fsImpl,{cpuDenominator:10,memory:67108864,pids:16});
 if(JSON.stringify(fsImpl.readdirSync('/sys/class/net').sort())!==JSON.stringify(['lo']))fail();
 directory(fsImpl,'/manager-install-proof',0,0,0o755);
 // Only a new, root-owned, empty volume is admitted. Make it private BEFORE
 // ownership transfer; no file or other existing directory is ever changed.
 fsImpl.chmodSync('/manager-install-proof',0o700);fsImpl.chownSync('/manager-install-proof',1000,1000);
 // With CHOWN only, root cannot enumerate a now-1000-owned mode0700 volume.
 // Empty was proved before transfer; guardRuntime repeats it as UID1000 before
 // any staging or SQL. Keep this final check metadata-only, without new caps.
 const transferred=fsImpl.lstatSync('/manager-install-proof');
 if(!transferred.isDirectory()||transferred.isSymbolicLink()||transferred.uid!==1000||transferred.gid!==1000||(transferred.mode&0o7777)!==0o700)fail();return true;
}
function validateBundle(bundle){
 closed(bundle,['schema','files']);if(bundle.schema!=='crm-manager-install-public-bundle-v1'||!Array.isArray(bundle.files)||bundle.files.length!==Object.keys(EXPECTED).length)fail();
 const seen=new Set(),result=[];
 for(const entry of bundle.files){closed(entry,['name','sha256','base64']);if(!Object.hasOwn(EXPECTED,entry.name)||seen.has(entry.name)||entry.sha256!==EXPECTED[entry.name]||typeof entry.base64!=='string'||entry.base64.length>131072||!/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64))fail();
  const bytes=Buffer.from(entry.base64,'base64');if(bytes.toString('base64')!==entry.base64||sha(bytes)!==entry.sha256)fail();seen.add(entry.name);result.push({name:entry.name,bytes});
 }return result;
}
function bootstrap(bundle,{proc=process,fsImpl=fs,load=require}={}){
 try{
  const files=validateBundle(bundle);guardRuntime({proc,fsImpl});
  if(load('/app/node_modules/pg/package.json').version!=='8.13.1')fail();
  fsImpl.mkdirSync('/review/sql',{mode:0o700});fsImpl.mkdirSync('/review/supervisor',{mode:0o700});
  for(const file of files){let fd;try{fd=fsImpl.openSync('/review/'+file.name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o400);fsImpl.writeFileSync(fd,file.bytes);fsImpl.fsyncSync(fd);}finally{if(fd!==undefined)fsImpl.closeSync(fd);}fsImpl.chmodSync('/review/'+file.name,0o444);}
  fsImpl.chmodSync('/review/sql',0o555);fsImpl.chmodSync('/review/supervisor',0o555);fsImpl.chmodSync('/review',0o555);
  return load('/review/supervisor/supervisor.cjs').startCli(['install'],proc.env);
 }catch{for(const key of Object.keys(proc.env))if(key.startsWith('PG')||key==='DATABASE_URL')delete proc.env[key];proc.exitCode=1;return null;}
}
module.exports={EXPECTED,guardRuntime,initializeVolume,validateBundle,bootstrap};
