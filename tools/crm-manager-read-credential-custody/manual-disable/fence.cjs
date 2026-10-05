'use strict';
// Local public effects fence, separate from F/StageRunner. Never an MCP endpoint.
function persistFence({plan,action,directory}){
 const M=require('./manual-disable.cjs');M.admitPlan(plan);
 if(!Object.hasOwn(plan.steps,action)&&action!=='updatePrivateEnv')throw Error('MANUAL_DISABLE_FENCE_REFUSED');
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),fail=()=>{throw Error('MANUAL_DISABLE_FENCE_REFUSED');};
 const s=fs.lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700||path.resolve(directory)!==directory||fs.realpathSync(directory)!==directory)fail();
 const value={schema:'crm-manager-read-manual-disable-effect-hold-v1',planSha256:plan.planSha256,mode:plan.mode,action,intent:plan.intent,target:plan.target,sourceVolume:plan.sourceVolume,ledgerVolume:plan.ledgerVolume,host:plan.host,domainId:plan.domainId,image:plan.image,sourcePinsSha256:plan.expected.sourcePinsSha256,publicSourceSha256:plan.publicPreflightContentSha256,privateSourceSha256:plan.privateExecutionContentSha256,initializerSha256:crypto.createHash('sha256').update(plan.initializer).digest('hex'),durable:true,replayAllowed:false};
 const bytes=Buffer.from(JSON.stringify(value)+'\n'),file=path.join(directory,plan.planSha256+'-'+action+'.json'),fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const dfd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{const actual=fs.fstatSync(dfd);if(actual.dev!==s.dev||actual.ino!==s.ino)fail();fs.fsyncSync(dfd);}finally{fs.closeSync(dfd);}
 const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid()||before.nlink!==1||(before.mode&0o7777)!==0o600)fail();
 const read=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const actual=fs.fstatSync(read);if(actual.dev!==before.dev||actual.ino!==before.ino||!fs.readFileSync(read).equals(bytes))fail();fs.fsyncSync(read);}finally{fs.closeSync(read);}
 return Object.freeze({file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),durable:true,replayAllowed:false});
}
module.exports=Object.freeze({persistFence});
