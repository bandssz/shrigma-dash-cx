'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const IMAGE='ghcr.io/bandssz/shrigma-dash-native-connection';
const DIGEST_RE=/^ghcr\.io\/bandssz\/shrigma-dash-native-connection@sha256:[a-f0-9]{64}$/;
const docker=(args,options={})=>execFileSync(process.env.SHRIGMA_DOCKER_BINARY||'docker',args,{encoding:'utf8',maxBuffer:20*1024*1024,...options});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function build({artifactImage,tag,directory,pull=true}){
 if(!DIGEST_RE.test(artifactImage)||!/^ghcr\.io\/bandssz\/shrigma-dash-native-connection:(?:envelope|rollback)-[a-f0-9]{40,64}$/.test(tag))throw Error('ENVELOPE_TARGET_REFUSED');
 if(pull)docker(['pull','--platform','linux/amd64',artifactImage]);
 const bytes=docker(['run','--rm','--platform','linux/amd64','--network','none','--read-only','--user','1000:1000','--entrypoint','node',artifactImage,'-e',"process.stdout.write(require('fs').readFileSync('/app/native-backend/manifest.json'))"]);
 const m=JSON.parse(bytes),contract={schema:'shrigma-production-envelope-v1',artifactImage,manifestSha256:sha(bytes),presentationManifestSha256:m.presentationManifestSha256,sourceRevision:m.sourceRevision};
 require('./launcher.cjs').validate(contract,bytes);
 fs.mkdirSync(directory,{mode:0o700});fs.copyFileSync(path.join(__dirname,'launcher.cjs'),path.join(directory,'launcher.cjs'));
 fs.writeFileSync(path.join(directory,'contract.json'),JSON.stringify(contract)+'\n',{mode:0o600});
 fs.writeFileSync(path.join(directory,'Dockerfile'),'ARG ARTIFACT_IMAGE\nFROM ${ARTIFACT_IMAGE}\nUSER 0:0\nCOPY launcher.cjs /app/shrigma-production-launcher.cjs\nCOPY contract.json /app/shrigma-production.json\nRUN chmod 0444 /app/shrigma-production-launcher.cjs /app/shrigma-production.json\nUSER 1000:1000\n');
 docker(['build','--platform','linux/amd64','--build-arg','ARTIFACT_IMAGE='+artifactImage,'--tag',tag,directory]);
 const verified=JSON.parse(docker(['run','--rm','--platform','linux/amd64','--network','none','--read-only','--user','1000:1000','--entrypoint','node',tag,'/app/shrigma-production-launcher.cjs','verify']).trim());
 if(verified.verified!==true||verified.artifactImage!==artifactImage||verified.manifestSha256!==contract.manifestSha256)throw Error('ENVELOPE_VERIFY_REFUSED');
 return {...contract,tag,launcherSha256:sha(fs.readFileSync(path.join(__dirname,'launcher.cjs')))};
}
module.exports={IMAGE,DIGEST_RE,docker,build};
