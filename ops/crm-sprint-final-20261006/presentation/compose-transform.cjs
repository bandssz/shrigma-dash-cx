'use strict';
// Root applies this transform to the existing private native configuration.
// No environment, domain, volume, historical plan or controller is rewritten.
const crypto=require('node:crypto');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const OLD_IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:e1729ca3a6d064244c82a8df3d13bd1f3323797d5cfb8a80e1d6d0cf12345e32';
const OLD_CALLBACK='started=require("/app/canary-start.cjs").start();return started;';
function verifyPreservedMasterFiles(){
 const fs=require('node:fs'),crypto=require('node:crypto'),root='/dashboard-data/own-master-maintenance-v1';
 const rows=[['activation-once.json',771,'39aec2a4bc08b60e0e9c25e61111e83da903a781f030af01093428530a86c059',0o600],['readonly-observation.json',1662,'a046d1d04f2074cdaf18614204520cace06389827c3069b1193b1feaaa048a6d',0o400],['activation-result.json',334,'faf46f89e5e296d9a8f28f2d76a20e87f7075531ddaee853d7a5069665632abb',0o600]];
 const fail=()=>{throw Error('PRESENTATION_MASTER_FILES_REFUSED');};
 const same=(a,b)=>['dev','ino','size','nlink','uid','gid','mode','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
 for(const dir of ['/dashboard-data',root]){const s=fs.lstatSync(dir);if(fs.realpathSync(dir)!==dir||!s.isDirectory()||s.isSymbolicLink()||s.uid!==1000||s.gid!==1000||(s.mode&511)!==448)fail();}
 for(const [name,size,pin,mode]of rows){const file=root+'/'+name,s=fs.lstatSync(file);if(fs.realpathSync(file)!==file||!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==1000||s.gid!==1000||(s.mode&511)!==mode||s.size!==size)fail();const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{if(!same(s,fs.fstatSync(fd)))fail();const b=fs.readFileSync(fd);if(b.length!==size||crypto.createHash('sha256').update(b).digest('hex')!==pin||!same(s,fs.fstatSync(fd))||!same(s,fs.lstatSync(file)))fail();}finally{fs.closeSync(fd);}}
 return {schema:'crm-presentation-preserved-master-files-v1',filesUnchanged:3,readOnly:true,credentialsIncluded:false};
}
const DURABLE='('+verifyPreservedMasterFiles.toString()+')()';
const NEW_CALLBACK='const preserved='+DURABLE+';started=require("/app/presentation-release/release.cjs").startWithPresentation(()=>require("/app/canary-start.cjs").start());'+DURABLE+';process.stdout.write(JSON.stringify({...started.presentation,preservedMaster:preserved})+"\\n");return started;';
const READY='try{'+DURABLE+';const p=require("/app/presentation-release/release.cjs").verifyReady();if(p.manifestSha256!=="c8de73c9f4afcc31eb9040f44850ad07dd8de3ca7ed8af95a5daf10b7df1aa1b"||p.publicFilesChanged!==7||p.runtimeFilesUnchanged!==28||p.identityAccess!==false)throw Error("PRESENTATION_HEALTH_REFUSED");}catch{process.exit(1);}';
function transform(content,newImage){
 if(typeof content!=='string'||!/^ghcr\.io\/bandssz\/shrigma-dash-crm-presentation@sha256:[0-9a-f]{64}$/.test(newImage))throw Error('PRESENTATION_COMPOSE_INPUT_REFUSED');
 const before=JSON.parse(content),next=JSON.parse(content);
 if(JSON.stringify(Object.keys(before.services))!==JSON.stringify(['gateway']))throw Error('PRESENTATION_SERVICE_REFUSED');
 const old=before.services.gateway,target=next.services.gateway;
 if(old.image!==OLD_IMAGE||old.user!=='1000:1000'||old.read_only!==true||!Array.isArray(old.command)||old.command.length!==5||old.command[0]!=='node'||old.command[3]!=='-e'||typeof old.command[4]!=='string'||old.command[4].split(OLD_CALLBACK).length!==2||!Array.isArray(old.healthcheck?.test)||old.healthcheck.test.length!==6||old.healthcheck.test.slice(0,5).join('|')!=='CMD|node|--no-warnings|--max-old-space-size=64|-e')throw Error('PRESENTATION_PRESTATE_REFUSED');
 target.image=newImage;
 target.command[4]=old.command[4].replace(OLD_CALLBACK,NEW_CALLBACK);
 target.healthcheck.test[5]=READY+old.healthcheck.test[5];
 // Reversing the three exact changes must reproduce the original object.
 const reversed=JSON.parse(JSON.stringify(next));
 reversed.services.gateway.image=OLD_IMAGE;
 reversed.services.gateway.command[4]=target.command[4].replace(NEW_CALLBACK,OLD_CALLBACK);
 reversed.services.gateway.healthcheck.test[5]=target.healthcheck.test[5].slice(READY.length);
 if(JSON.stringify(reversed)!==JSON.stringify(before))throw Error('PRESENTATION_COMPOSE_EXTRA_DELTA_REFUSED');
 const output=JSON.stringify(next,null,2)+'\n';
 return {content:output,receipt:{schema:'crm-presentation-compose-transform-v1',beforeContentSha256:sha(content),afterContentSha256:sha(output),baseImage:OLD_IMAGE,childImage:newImage,oldCommandSha256:sha(old.command[4]),newCommandSha256:sha(target.command[4]),oldHealthSha256:sha(old.healthcheck.test[5]),newHealthSha256:sha(target.healthcheck.test[5]),deltaPaths:['services.gateway.image','services.gateway.command.4','services.gateway.healthcheck.test.5'],allOtherConfigurationPreserved:true,historicalMasterPlanUnchanged:true,operational:false,credentialsIncluded:false}};
}
module.exports={transform,OLD_IMAGE,OLD_CALLBACK,NEW_CALLBACK,READY};
