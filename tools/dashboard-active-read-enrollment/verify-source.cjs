'use strict';
// Public source admission only. Does not start a gateway or access identity data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
const BASE='c3f0ac329d04903078fc0a558ed89aa9f50696c9';
const PARENT='fe27c6a158fecce8b0b0aaae641f77c43351ce20';
const PATHS=Object.freeze([
 '.github/workflows/dashboard-active-read-enrollment-20261006.yml',
 'services/dashboard-operational/auth.cjs',
 'services/dashboard-operational/crm-manager-journal.cjs',
 'tests/dashboard-operational-active-read-enrollment.test.cjs',
 'tools/dashboard-active-read-enrollment/verify-source.cjs'
].sort());
const PINS=Object.freeze({
 'services/dashboard-operational/auth.cjs':{
  before:'cdec138777a749e39d6318d799b8d704900450ba6ad3e0798d2642c3f79ac0d4',
  after:'6579c3bffffd73f09d6e2950d010ce72ac08d5e579b7688013cb0f56cfab92bb',bytes:112250},
 'services/dashboard-operational/crm-manager-journal.cjs':{
  before:'8c233aca65b834086e8562a40cb53f0e30314a0fc3f9c1bba70faffc20296f07',
  after:'585d5dbabd920b53061dae362ff3c1be9c526195f66ae9e4f52987c8a84c9ea5',bytes:25484}
});
const TEST='tests/dashboard-operational-active-read-enrollment.test.cjs';
const TEST_SHA='8f46f841eeeed93c80bde00c822c46e975c6ccd7eae282eb45f9f0f8313e1dd5';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const refuse=()=>{throw new Error('ENROLLMENT_SOURCE_CONTRACT_REFUSED');};
function git(args){try{return execFileSync('git',['-C',ROOT,...args],{stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});}catch{refuse();}}
const gitText=args=>git(args).toString('utf8').trim();
const fileAt=(revision,file)=>git(['show',revision+':'+file]);
function runtimePaths(revision){
 return gitText(['ls-tree','-r','--name-only',revision,'services/dashboard-operational'])
  .split('\n').filter(p=>/^services\/dashboard-operational\/[^/]+\.(cjs|js)$/.test(p)&&!p.endsWith('.test.cjs')).sort();
}
function verify(){
 if(process.versions.node.split('.')[0]!=='22')refuse();
 const head=gitText(['rev-parse','HEAD']);
 if(!/^[a-f0-9]{40}$/.test(head))refuse();
 if(process.env.SOURCE_REVISION!==undefined&&process.env.SOURCE_REVISION!==head)refuse();
 if(process.env.SOURCE_REPOSITORY!==undefined&&process.env.SOURCE_REPOSITORY!=='bandssz/shrigma-dash-cx')refuse();
 if(gitText(['cat-file','-t',BASE])!=='commit'||gitText(['cat-file','-t',PARENT])!=='commit')refuse();
 git(['merge-base','--is-ancestor',BASE,PARENT]);git(['merge-base','--is-ancestor',PARENT,head]);
 const changes=gitText(['diff','--name-status','--no-renames',PARENT,head]).split('\n').map(line=>line.split('\t'));
 if(!same(changes.map(r=>r[1]).sort(),PATHS)||changes.some(r=>r.length!==2||r[0]!== (PINS[r[1]]?'M':'A')))refuse();
 for(const [file,pin]of Object.entries(PINS)){
  const original=fileAt(BASE,file),parent=fileAt(PARENT,file),actual=fileAt(head,file);
  if(sha(original)!==pin.before||!original.equals(parent)||sha(actual)!==pin.after||actual.length!==pin.bytes)refuse();
 }
 if(sha(fileAt(head,TEST))!==TEST_SHA)refuse();
 const runtime=runtimePaths(BASE);
 if(!same(runtime,runtimePaths(PARENT))||!same(runtime,runtimePaths(head)))refuse();
 for(const file of runtime)if(!PINS[file]&&!fileAt(BASE,file).equals(fileAt(PARENT,file)))refuse();
 // HEAD may change only the two pinned runtime modules. Compare all remaining
 // copied fixture modules as well, so the nine tests cannot silently drift.
 for(const file of runtime)if(!PINS[file]&&!fileAt(PARENT,file).equals(fileAt(head,file)))refuse();
 const sourceFiles=PATHS.map(file=>{
  const bytes=fileAt(head,file),actualPath=path.join(ROOT,file),stat=fs.lstatSync(actualPath);
  const tree=gitText(['ls-tree',head,file]);
  if(!stat.isFile()||stat.isSymbolicLink()||!tree.startsWith('100644 blob ')||!fs.readFileSync(actualPath).equals(bytes))refuse();
  return {path:file,bytes:bytes.length,sha256:sha(bytes),gitBlob:crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex')};
 });
 const {DatabaseSync}=require('node:sqlite');let db;
 try{db=new DatabaseSync(':memory:');if(db.isTransaction!==false)refuse();db.exec('BEGIN');if(db.isTransaction!==true)refuse();db.exec('ROLLBACK');if(db.isTransaction!==false)refuse();}finally{db?.close();}
 return {schema:'crm-active-read-enrollment-ci-source-proof-v1',state:'source-admitted-tests-pending',head,parent:PARENT,base:BASE,node:process.version,runtimeModuleCount:runtime.length,sourceFiles,expectedTests:9,providersInvoked:false,productionDataAccessed:false,deployment:false,brokersAdmitted:false};
}
try{process.stdout.write(JSON.stringify(verify())+'\n');}catch{
 process.stdout.write(JSON.stringify({schema:'crm-active-read-enrollment-ci-source-proof-v1',state:'refused',code:'ENROLLMENT_SOURCE_CONTRACT_REFUSED'})+'\n');process.exitCode=1;
}
