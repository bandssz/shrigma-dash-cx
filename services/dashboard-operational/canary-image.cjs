'use strict';
// The immutable image supplies the artifact pin. Runtime environment variables
// may agree with it, but cannot select another artifact.
const fs=require('node:fs'),path=require('node:path');
const {decodePack,MAX_PACK_BYTES,SCHEMA,SCHEMA_V2}=require('./artifact-policy.cjs');
const IMAGE='node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
const IMAGE_SCHEMA='shrigma_dashboard_canary_image_v1';
const IMAGE_FILES=Object.freeze(['runtime-pack.json','bootstrap.cjs','artifact-policy.cjs','canary-start.cjs','canary-image.cjs','image-pin.json'].sort());
function regular(file,maxBytes,fsImpl=fs){
 const stat=fsImpl.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>maxBytes)throw Error('IMAGE_FILE_INVALID');
 return fsImpl.readFileSync(file,'utf8');
}
function readImagePin(imageDir,{fsImpl=fs}={}){
 const pin=JSON.parse(regular(path.join(imageDir,'image-pin.json'),1024,fsImpl));
 if(!pin||typeof pin!=='object'||Array.isArray(pin)||Object.keys(pin).sort().join(',')!=='baseImage,packSha256,schema,sourceRevision'||pin.schema!==IMAGE_SCHEMA||pin.baseImage!==IMAGE||!/^[a-f0-9]{40}$/.test(pin.sourceRevision)||!/^[a-f0-9]{64}$/.test(pin.packSha256))throw Error('IMAGE_PIN_INVALID');
 return pin;
}
function verifyImagePack(imageDir,{fsImpl=fs}={}){
 const pin=readImagePin(imageDir,{fsImpl}),input=regular(path.join(imageDir,'runtime-pack.json'),MAX_PACK_BYTES,fsImpl);
 decodePack(input,pin.packSha256);
 return {pin,input};
}
function prepareImage(packDirectory,sourceRevision,destination){
 if(!/^[a-f0-9]{40}$/.test(sourceRevision||''))throw Error('IMAGE_SOURCE_REVISION_REQUIRED');
 const source=path.resolve(packDirectory),out=path.resolve(destination);
 const metadata=JSON.parse(regular(path.join(source,'deployment-metadata.json'),4096));
 if(![SCHEMA,SCHEMA_V2].includes(metadata.schema)||metadata.image!==IMAGE||metadata.runtimeUid!==1000||metadata.runtimeGid!==1000||metadata.volume!=='/dashboard-data')throw Error('IMAGE_METADATA_INVALID');
 const input=regular(path.join(source,'runtime-pack.json'),MAX_PACK_BYTES);
 decodePack(input,metadata.packSha256);if(JSON.parse(input).schema!==metadata.schema)throw Error('IMAGE_METADATA_INVALID');
 if(fs.existsSync(out)){const stat=fs.lstatSync(out);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.readdirSync(out).length)throw Error('IMAGE_DESTINATION_INVALID');}
 fs.mkdirSync(out,{recursive:true,mode:0o700});
 const pin={schema:IMAGE_SCHEMA,baseImage:IMAGE,sourceRevision,packSha256:metadata.packSha256};
 for(const file of ['runtime-pack.json','bootstrap.cjs','artifact-policy.cjs'])fs.writeFileSync(path.join(out,file),regular(path.join(source,file),file==='runtime-pack.json'?MAX_PACK_BYTES:32768),{flag:'wx',mode:0o600});
 for(const file of ['canary-start.cjs','canary-image.cjs'])fs.writeFileSync(path.join(out,file),regular(path.join(__dirname,file),32768),{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(out,'image-pin.json'),JSON.stringify(pin)+'\n',{flag:'wx',mode:0o600});
 verifyImagePack(out);
 return pin;
}
if(require.main===module){try{if(process.argv.length!==5)throw Error('IMAGE_ARGUMENTS_REQUIRED');console.log(JSON.stringify(prepareImage(process.argv[2],process.argv[3],process.argv[4])));}catch{console.error('Dashboard image preparation refused.');process.exitCode=1;}}
module.exports={IMAGE,IMAGE_SCHEMA,IMAGE_FILES,regular,readImagePin,verifyImagePack,prepareImage};
