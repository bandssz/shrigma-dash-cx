'use strict';
// Local public effect intents only. No env, connector, key, PG or work on import.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SCHEMA='crm-manager-read-durable-effect-v1',RECEIPT='crm-manager-read-remote-fence-v1',MAX=4096;
const PROJECT='dashboard-image-20260930',ISOLATED_PROJECT='crm-manager-stage-20261004',IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIONS=Object.freeze(['custody-retained','create','create-public-bootstrap','update-public-probe','deploy-public-probe','stop-public-probe','reenable-public-probe','configure-private','update-private-source','deploy-stage','start','stop','clear-private','destroy-service','prior-stop','prior-clear-private','prior-destroy-service','create-domain','cleanup-domain','prior-cleanup-domain','configure-private-env','stop-service','clear-private-env','prior-stop-service','prior-clear-private-env']);
function fail(){throw Error('READ_EFFECT_FENCE_REFUSED');}
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function exact(v,keys){if(!v||Object.getPrototypeOf(v)!==Object.prototype)fail();const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail();for(const k of own){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail();}}
function data(v,k){if(!v||Object.getPrototypeOf(v)!==Object.prototype)fail();const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail();return d.value;}
function canonical(v,depth=0){
 if(depth>30)fail();if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);if(typeof v==='number'){if(!Number.isFinite(v))fail();return JSON.stringify(v);}
 if(Array.isArray(v)){const keys=Reflect.ownKeys(v),length=Object.getOwnPropertyDescriptor(v,'length');if(!length||!Object.hasOwn(length,'value')||keys.length!==length.value+1||keys.some(k=>typeof k!=='string'||k!=='length'&&!/^(0|[1-9][0-9]*)$/.test(k)))fail();return'['+Array.from({length:length.value},(_,i)=>{const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail();return canonical(d.value,depth+1);}).join(',')+']';}
 if(!v||Object.getPrototypeOf(v)!==Object.prototype)fail();const keys=Reflect.ownKeys(v);if(keys.some(k=>typeof k!=='string'))fail();return'{'+keys.sort().map(k=>JSON.stringify(k)+':'+canonical(data(v,k),depth+1)).join(',')+'}';
}
function scope(p){
 exact(p,['schema','mode','intent','descriptor','parentStage','planSha256']);if(p.schema!=='crm-manager-read-remote-plan-v1'||!['execute','reconcile'].includes(p.mode)||typeof p.planSha256!=='string'||!/^[a-f0-9]{64}$/.test(p.planSha256))fail();
 const body={schema:p.schema,mode:p.mode,intent:p.intent,descriptor:p.descriptor,parentStage:p.parentStage},encoded=canonical(body);if(Buffer.byteLength(encoded)>524288||sha(encoded)!==p.planSha256)fail();
 exact(p.intent,['schema','operationId','credentialIntentId','action','fromPhase']);const i=p.intent;if(i.schema!=='crm-manager-read-runtime-intent-v1'||!UUID.test(i.operationId)||!UUID.test(i.credentialIntentId)||i.action!=='stage'||i.fromPhase!=='empty')fail();
 const d=p.descriptor,projectName=data(d,'projectName'),serviceName=data(d,'serviceName'),image=data(d,'image'),compose=data(d,'compose'),volumes=data(compose,'volumes'),source=data(data(volumes,'source'),'name'),ledger=data(data(volumes,'ledger'),'name');
 if(![PROJECT,ISOLATED_PROJECT].includes(projectName)||typeof serviceName!=='string'||!(p.mode==='execute'?/^mgr-stage-[a-f0-9]{12}$/:/^mgr-rec-[a-f0-9]{12}$/).test(serviceName)||image!==IMAGE||typeof source!=='string'||!/^shrigma-read-source-(?:[a-f0-9]{12}|[a-f0-9]{32})$/.test(source))fail();
 const namespace=source.slice('shrigma-read-source-'.length),fresh=namespace.length===32;if(ledger!=='shrigma-read-stage-'+namespace)fail();
 if(fresh&&namespace!==sha('crm-manager-read-fresh-volume-namespace-v1\0'+i.operationId+'\0'+i.credentialIntentId).slice(0,32))fail();
 if(p.mode==='execute'&&(!fresh&&namespace!==serviceName.slice(-12)||p.parentStage!==null))fail();
 if(p.mode==='reconcile'){
  const parent=p.parentStage;if(!parent||parent.mode!=='execute'||parent.intent?.operationId!==i.operationId||parent.intent?.credentialIntentId!==i.credentialIntentId||data(parent.descriptor,'projectName')!==projectName)fail();
  const parentVolumes=data(data(parent.descriptor,'compose'),'volumes');if(data(data(parentVolumes,'source'),'name')!==source||data(data(parentVolumes,'ledger'),'name')!==ledger)fail();
 }
 return Object.freeze({projectName,serviceName,mode:p.mode,operationId:i.operationId,credentialIntentId:i.credentialIntentId,sourceVolume:source,ledgerVolume:ledger,image,domainId:data(data(d,'domain'),'id'),testHostname:data(data(d,'domain'),'host')});
}
function privateDir(dir){if(typeof dir!=='string'||!path.isAbsolute(dir)||path.resolve(dir)!==dir)fail();const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700||fs.realpathSync(dir)!==dir)fail();return s;}
function syncDir(dir){const before=privateDir(dir),fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(s.dev!==before.dev||s.ino!==before.ino)fail();fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function readPublic(file){
 const before=fs.lstatSync(file);function same(s){if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.nlink!==1||(s.mode&0o7777)!==0o600||s.size<1||s.size>MAX||s.dev!==before.dev||s.ino!==before.ino||s.size!==before.size||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs)fail();}
 same(before);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{same(fs.fstatSync(fd));const b=fs.readFileSync(fd);same(fs.fstatSync(fd));if(b.length!==before.size)fail();fs.fsyncSync(fd);return b;}finally{fs.closeSync(fd);}
}
function openEffectFence(input){
 try{exact(input,['directory']);privateDir(input.directory);}catch{fail();}const directory=input.directory;
 function record(p,action){const bound=scope(p);if(!ACTIONS.includes(action))fail();return Object.freeze({schema:SCHEMA,planSha256:p.planSha256,action,scope:bound});}
 function fileFor(p,action){return path.join(directory,sha(p.planSha256+':'+action)+'.json');}
 function durable(p,action){
  const expected=record(p,action),file=fileFor(p,action),first=readPublic(file);syncDir(directory);syncDir(path.dirname(directory));const second=readPublic(file);
  if(!first.equals(second)||first.toString('utf8')!==canonical(expected)+'\n')fail();return expected;
 }
 function fence(p,action){try{
  privateDir(directory);privateDir(path.dirname(directory));const expected=record(p,action),bytes=Buffer.from(canonical(expected)+'\n');if(bytes.length>MAX)fail();
  const fd=fs.openSync(fileFor(p,action),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{let offset=0;while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(n<=0)fail();offset+=n;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  durable(p,action);return Object.freeze({schema:RECEIPT,planSha256:p.planSha256,action,durable:true,firstAttempt:true});
 }catch{fail();}}
 function inspect(p,action){try{privateDir(directory);const r=durable(p,action);return Object.freeze({schema:'crm-manager-read-effect-hold-v1',planSha256:r.planSha256,action:r.action,durable:true,replayAllowed:false,scope:r.scope});}catch{fail();}}
 return Object.freeze({fence,inspect});
}
module.exports=Object.freeze({openEffectFence,SCHEMA,RECEIPT,MAX,ACTIONS});
if(require.main===module){process.stderr.write('READ_EFFECT_FENCE_API_ONLY\n');process.exitCode=1;}
