'use strict';
// Same launcher in every envelope, including rollback over the previous native image.
const fs=require('node:fs'),crypto=require('node:crypto');
const CONTRACT='/app/shrigma-production.json',ROOT='/app/native-backend';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function immutableRead(file,max){
 const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==0||s.gid!==0||(s.mode&0o777)!==0o444||s.size<1||s.size>max||fs.realpathSync(file)!==file)throw Error('PRODUCTION_FILE_REFUSED');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const same=t=>['dev','ino','size','mode','nlink','uid','gid','mtimeMs','ctimeMs'].every(k=>s[k]===t[k]);if(!same(fs.fstatSync(fd)))throw Error('PRODUCTION_FILE_REFUSED');const b=fs.readFileSync(fd);if(!same(fs.fstatSync(fd))||!same(fs.lstatSync(file))||b.length!==s.size)throw Error('PRODUCTION_FILE_REFUSED');return b;}finally{fs.closeSync(fd);}
}
function validate(contract,manifestBytes){
 const m=JSON.parse(manifestBytes);
 if(Object.keys(contract).sort().join(',')!=='artifactImage,manifestSha256,presentationManifestSha256,schema,sourceRevision'||contract.schema!=='shrigma-production-envelope-v1'||!/^ghcr\.io\/bandssz\/shrigma-dash-native-connection@sha256:[a-f0-9]{64}$/.test(contract.artifactImage)||!/^([a-f0-9]{40})$/.test(contract.sourceRevision)||sha(manifestBytes)!==contract.manifestSha256||m.sourceRevision!==contract.sourceRevision||m.presentationManifestSha256!==contract.presentationManifestSha256)throw Error('PRODUCTION_CONTRACT_REFUSED');
 return {manifestSha256:contract.manifestSha256,imageDigest:contract.artifactImage.split('@sha256:')[1]};
}
async function run(mode){
 if(!['start','health','verify'].includes(mode))throw Error('PRODUCTION_MODE_REFUSED');
 immutableRead('/app/shrigma-production-launcher.cjs',16384);
 const contract=JSON.parse(immutableRead(CONTRACT,4096)),args=validate(contract,immutableRead(ROOT+'/manifest.json',65536));
 require(ROOT+'/bootstrap.cjs').verifyRelease(args.manifestSha256);
 if(mode==='verify')return {schema:contract.schema,verified:true,...contract};
 if(mode==='health')return require(ROOT+'/health-existing.cjs').healthExisting(args);
 const r=await require(ROOT+'/start-existing.cjs').startExisting(args);return {schema:contract.schema,started:true,existingContinuityVerified:r.continuity.existingGrantVerified};
}
if(require.main===module)run(process.argv[2]).then(r=>console.log(JSON.stringify(r)),()=>{console.error('PRODUCTION_ENVELOPE_REFUSED');process.exitCode=1;});
module.exports={validate,run};
