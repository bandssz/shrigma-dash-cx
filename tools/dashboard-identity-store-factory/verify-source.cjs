'use strict';
// Source-only CI. No Auth, driver, SQL, identity, provider or deployment imports.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
const BASE='cc82776f8b8ff20b4adfb0eaa6494fa41020c4e9';
const FROZEN_BASE='c3f0ac329d04903078fc0a558ed89aa9f50696c9';
const BRANCH='codex/identity-store-factory-source-20261006';
const TOOL='tools/dashboard-identity-store-factory/verify-source.cjs';
const WORKFLOW='.github/workflows/dashboard-identity-store-factory-20261006.yml';
const PINS=Object.freeze({
  "services/dashboard-operational/auth.cjs": {
    "bytes": 113175,
    "sha256": "30b1f1d81e54013122116c864d57b88b12003e95cba79c0b254afbcece8cfaee"
  },
  "services/dashboard-operational/server.cjs": {
    "bytes": 94223,
    "sha256": "05c335fa1cfc24d379b6505eda0ff09cd42285d3120c24eabefb7ec438b91073"
  },
  "services/dashboard-operational/bootstrap.cjs": {
    "bytes": 5850,
    "sha256": "92f136a3ad4581dacd99dcecd61c31f058d64ba8cbd35f0abd1132064112a744"
  },
  "services/dashboard-operational/identity-store-factory.cjs": {
    "bytes": 3770,
    "sha256": "2db0cb45162b8addfc6c297a4c1acbce92cd8f2f5eaaeb8abaf0222c21a41c32"
  },
  "services/dashboard-operational/identity-pg/admission.cjs": {
    "bytes": 8008,
    "sha256": "d23cd6f0f4ca2493659497903039c1138e66b837f0e07cb935c64c0ac51696e8"
  },
  "services/dashboard-operational/identity-pg/database-sync.cjs": {
    "bytes": 4591,
    "sha256": "8a3ab845009c3448ba7b396215c1f11486a7af487259380f2a1884ecc771cbc5"
  },
  "services/dashboard-operational/identity-pg/protocol.cjs": {
    "bytes": 1348,
    "sha256": "5f63cc9e91db42bbe5adb52adc6fbdf5a6a49bb0e0e491c7044ab7cf303e6ada"
  },
  "services/dashboard-operational/identity-pg/runtime-grants.cjs": {
    "bytes": 1346,
    "sha256": "f6d3fc38ec99598bb4e9d49d8ac0af4de2bfa47f2780526bd7869274cfb4c3cf"
  },
  "services/dashboard-operational/identity-pg/runtime-grants.json": {
    "bytes": 4206,
    "sha256": "3e08d5871b19f4f06816a67994fbb98914c051464858ea1899c9df3c29371203"
  },
  "services/dashboard-operational/identity-pg/sql-map.cjs": {
    "bytes": 4476,
    "sha256": "501694cfe8ba97065b9290a20199eae987aaa9c4a3b00686694242c1e3edd905"
  },
  "services/dashboard-operational/identity-pg/statement-registry.json": {
    "bytes": 250011,
    "sha256": "486c611511379931792dd66487d1d95ffdf6a27867a7d7050aed5bc415ae97f7"
  },
  "services/dashboard-operational/identity-pg/worker.cjs": {
    "bytes": 11034,
    "sha256": "6855653b3722e1a99857a6eea322d1b68d2c672d9133b83a12f03525baa704fa"
  },
  "tests/dashboard-operational-identity-factory.test.cjs": {
    "bytes": 2984,
    "sha256": "c4bd39d792b487dc3ac43847b836e869cddddf9c33204ba7b80312bdd14fb486"
  },
  "tests/dashboard-operational-identity-factory-integration.test.cjs": {
    "bytes": 8906,
    "sha256": "9517c29494eb6618ffcb2993fe7b16e4ff11d0544ce790a778778b65660fa4ed"
  }
});
const MODIFIED=Object.freeze({
 'services/dashboard-operational/auth.cjs':'6579c3bffffd73f09d6e2950d010ce72ac08d5e579b7688013cb0f56cfab92bb',
 'services/dashboard-operational/server.cjs':'b3e0cc550831647f16e09db073f27dc6cdebe81cae09263e8c15c5616ac1a40e',
 'services/dashboard-operational/bootstrap.cjs':'6f3bff53826eff2788be17181fbae2a619ec42a482092cf25924ad0864c6dde0'
});
const UNCHANGED=Object.freeze({
 'services/dashboard-operational/crm-manager-journal.cjs':{bytes:25484,sha256:'585d5dbabd920b53061dae362ff3c1be9c526195f66ae9e4f52987c8a84c9ea5'},
 'tests/dashboard-operational-active-read-enrollment.test.cjs':{bytes:17516,sha256:'8f46f841eeeed93c80bde00c822c46e975c6ccd7eae282eb45f9f0f8313e1dd5'}
});
const SOURCE_PIN_NAMES=Object.freeze(['auth.cjs','crm-manager-journal.cjs','crm-manager-writer-journal.cjs','crm-manager-writer-auth-adapter.cjs','crm-campaign-create.cjs','crm-campaign-delivery.cjs','crm-manager-runtime.cjs'].sort());
const PATHS=Object.freeze([...Object.keys(PINS),TOOL,WORKFLOW].sort());
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const refuse=()=>{throw Error('IDENTITY_FACTORY_SOURCE_CONTRACT_REFUSED');};
function git(args){try{return execFileSync('git',['-C',ROOT,...args],{stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});}catch{refuse();}}
const gitText=args=>git(args).toString('utf8').trim();
const fileAt=(rev,file)=>git(['show',rev+':'+file]);
function physical(file){
 if(!/^(?:\.github\/workflows|tools\/dashboard-identity-store-factory|tests|services\/dashboard-operational(?:\/identity-pg)?)\/[a-z][a-z0-9.-]+\.(?:cjs|json|yml)$/.test(file))refuse();
 const target=path.join(ROOT,file),before=fs.lstatSync(target);
 const stable=(a,b)=>['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>1024*1024||fs.realpathSync(target)!==target)refuse();
 const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{if(!stable(before,fs.fstatSync(fd)))refuse();const bytes=fs.readFileSync(fd);if(bytes.length!==before.size||!stable(before,fs.fstatSync(fd))||!stable(before,fs.lstatSync(target)))refuse();return bytes;}finally{fs.closeSync(fd);}
}
function verify(){
 if(process.versions.node!=='22.23.3')refuse();
 const head=gitText(['rev-parse','HEAD']);
 if(!/^[a-f0-9]{40}$/.test(head)||process.env.SOURCE_REVISION!==head||process.env.SOURCE_REPOSITORY!=='bandssz/shrigma-dash-cx'||process.env.SOURCE_BRANCH!==BRANCH)refuse();
 if(gitText(['cat-file','-t',BASE])!=='commit'||gitText(['cat-file','-t',FROZEN_BASE])!=='commit'||gitText(['status','--porcelain','--untracked-files=all'])!=='')refuse();
 git(['merge-base','--is-ancestor',FROZEN_BASE,BASE]);git(['merge-base','--is-ancestor',BASE,head]);
 const changes=gitText(['diff','--name-status','--no-renames',BASE,head]).split('\n').map(line=>line.split('\t'));
 if(!same(changes.map(row=>row[1]).sort(),PATHS)||changes.some(row=>row.length!==2||row[0]!== (MODIFIED[row[1]]?'M':'A')))refuse();
 const files=PATHS.map(file=>{
  const bytes=fileAt(head,file),actual=physical(file),tree=gitText(['ls-tree',head,file]);
  if(!tree.startsWith('100644 blob ')||!actual.equals(bytes))refuse();
  const pin=PINS[file];if(pin&&(bytes.length!==pin.bytes||sha(bytes)!==pin.sha256))refuse();
  if(MODIFIED[file]&&sha(fileAt(BASE,file))!==MODIFIED[file])refuse();
  return {path:file,bytes:bytes.length,sha256:sha(bytes),gitBlob:crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex')};
 });
 for(const [file,pin]of Object.entries(UNCHANGED)){
  const before=fileAt(BASE,file),after=fileAt(head,file);
  if(!before.equals(after)||after.length!==pin.bytes||sha(after)!==pin.sha256||!physical(file).equals(after)||!gitText(['ls-tree',head,file]).startsWith('100644 blob '))refuse();
 }
 const adapter='services/dashboard-operational/identity-pg/';
 const adapterNames=Object.keys(PINS).filter(file=>file.startsWith(adapter)).map(file=>file.slice(adapter.length)).sort();
 if(!same(fs.readdirSync(path.join(ROOT,adapter)).sort(),adapterNames))refuse();
 const registry=JSON.parse(physical(adapter+'statement-registry.json').toString('utf8'));
 const {registrySha256,...body}=registry;
 if(registry.schema!=='dashboard-pg-adapter-exact-registry-v1'||registry.sourceRevision!=='unpublished-enrollment-factory-candidate'||registrySha256!=='55adf6b3680faaebc671d476f95312d2f3dc16828ac57f11d181c9b4102f7f98'||sha(JSON.stringify(body))!==registrySha256||registry.statements.length!==247||registry.statements.filter(s=>s.kind==='query').length!==226||!same(registry.sourcePins.map(pin=>pin.path).sort(),SOURCE_PIN_NAMES))refuse();
 for(const pin of registry.sourcePins){
  const file='services/dashboard-operational/'+pin.path;
  if(!/^[a-f0-9]{64}$/.test(pin.sha256)||sha(fileAt(head,file))!==pin.sha256||!physical(file).equals(fileAt(head,file)))refuse();
 }
 const grants=JSON.parse(physical(adapter+'runtime-grants.json').toString('utf8'));
 if(grants.schema!=='dashboard-pg-runtime-grants-v1'||grants.registrySha256!==registrySha256||grants.relations.length!==29)refuse();
 return {schema:'dashboard-identity-factory-ci-source-proof-v1',state:'source-contract-verified-tests-pending',head,base:BASE,frozenBaseSourceRevision:FROZEN_BASE,finalGitRevisionAdmitted:null,node:process.version,exactDeltaPaths:16,pinnedPayloadFiles:14,files,unchangedJournalAndEnrollmentTest:true,registryStatements:247,queryStatements:226,registrySourcePins:7,registrySha256,expectedTests:{factoryAndSourceIntegration:14,enrollment:9},identityDataAccessed:false,postgresConnected:false,driversImported:false,imageBuilt:false,deployment:false,packageAllowlistAdmitsFactory:false,operational:false};
}
try{process.stdout.write(JSON.stringify(verify())+'\n');}catch{
 process.stdout.write(JSON.stringify({schema:'dashboard-identity-factory-ci-source-proof-v1',state:'refused',code:'IDENTITY_FACTORY_SOURCE_CONTRACT_REFUSED'})+'\n');process.exitCode=1;
}
