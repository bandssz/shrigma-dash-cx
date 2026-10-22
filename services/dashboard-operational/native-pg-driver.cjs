'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT='/app/native-pg-driver',H=/^[a-f0-9]{64}$/,sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const fail=()=>{throw Error('PG_DEPENDENCY_RELEASE_REFUSED');};
function read(file,max=2*1024*1024){const s=fs.lstatSync(file);if(fs.realpathSync(file)!==file||!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==0||s.gid!==0||(s.mode&0o777)!==0o444||s.size>max)fail();const b=fs.readFileSync(file),a=fs.lstatSync(file);if(b.length!==s.size||['dev','ino','size','mtimeMs','ctimeMs'].some(k=>s[k]!==a[k]))fail();return b;}
function verifyDriver(manifestSha256){
 if(!H.test(manifestSha256||''))fail();
 const b=read(ROOT+'/manifest.json',256*1024);if(sha(b)!==manifestSha256)fail();const m=JSON.parse(b);
 if(Object.keys(m).sort().join(',')!=='files,lifecycleScriptsExecuted,lockSha256,operational,package,packageSha256,packages,schema,version'||m.schema!=='shrigma-native-pg-dependency-v1'||m.package!=='pg'||m.version!=='8.23.1'||!H.test(m.packageSha256||'')||!H.test(m.lockSha256||'')||m.lifecycleScriptsExecuted!==false||m.operational!==false||!Array.isArray(m.files)||m.files.length>2000||!Array.isArray(m.packages)||m.packages.length>100)fail();
 const actual=[];function scan(dir,prefix=''){const s=fs.lstatSync(dir);if(fs.realpathSync(dir)!==dir||!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&0o777)!==0o555)fail();for(const n of fs.readdirSync(dir)){if(!/^[A-Za-z0-9_@.+-]+$/.test(n)||n==='..')fail();const f=dir+'/'+n;if(fs.lstatSync(f).isDirectory())scan(f,prefix+n+'/');else if(prefix+n!=='manifest.json')actual.push(prefix+n);}}scan(ROOT);
 if(new Set(m.files.map(f=>f.path)).size!==m.files.length||JSON.stringify(actual.sort())!==JSON.stringify(m.files.map(f=>f.path).sort()))fail();
 for(const f of m.files){if(Object.keys(f).sort().join(',')!=='bytes,path,sha256'||typeof f.path!=='string'||f.path.split('/').some(p=>p==='..'||!p)||!H.test(f.sha256||'')||!Number.isSafeInteger(f.bytes)||f.bytes<0)fail();const b=read(path.join(ROOT,f.path));if(b.length!==f.bytes||sha(b)!==f.sha256)fail();}
 if(sha(read(ROOT+'/package-lock.json'))!==m.lockSha256||sha(canonical(m.files.filter(f=>f.path.startsWith('node_modules/pg/'))))!==m.packageSha256)fail();
 const pkg=JSON.parse(read(ROOT+'/node_modules/pg/package.json'));if(pkg.name!=='pg'||pkg.version!==m.version)fail();
 return {version:m.version,packageSha256:m.packageSha256,manifestSha256,files:m.files.length,packages:m.packages.length};
}
function loadPGDriver(manifestSha256){const v=verifyDriver(manifestSha256),pg=require(ROOT+'/node_modules/pg');if(typeof pg.Client!=='function')fail();return Object.freeze({Client:pg.Client,version:v.version,packageSha256:v.packageSha256});}
module.exports=Object.freeze({verifyDriver,loadPGDriver,ROOT});
