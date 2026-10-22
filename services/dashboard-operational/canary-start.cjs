'use strict';
const fs=require('node:fs'),path=require('node:path');
const boot=require('./bootstrap.cjs');
const {decodePack,MAX_PACK_BYTES}=require('./artifact-policy.cjs');
const {regular,verifyImagePack}=require('./canary-image.cjs');
const IMAGE_DIR='/app';
function seedVolume({dataDir=boot.DATA_DIR,imageDir=IMAGE_DIR,expectedUid=1000,expectedGid=1000,fsImpl=fs}={}){
 // Fully validate the immutable package before chmod, copying or SQLite startup.
 const {pin,input}=verifyImagePack(imageDir,{fsImpl});
 const stat=fsImpl.lstatSync(dataDir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==expectedUid||stat.gid!==expectedGid||fsImpl.realpathSync(dataDir)!==dataDir)throw Error('CANARY_VOLUME_INVALID');
 const entries=fsImpl.readdirSync(dataDir),packFile=path.join(dataDir,'runtime-pack.json');
 if(entries.length===0){
  // Docker initializes a fresh named volume from the image-owned directory.
  // Only an entirely empty, exclusively owned volume may be seeded.
  fsImpl.chmodSync(dataDir,0o700);
  const fd=fsImpl.openSync(packFile,'wx',0o600);
  try{fsImpl.writeFileSync(fd,input);fsImpl.fsyncSync(fd);}finally{fsImpl.closeSync(fd);}
  const dirfd=fsImpl.openSync(dataDir,'r');try{fsImpl.fsyncSync(dirfd);}finally{fsImpl.closeSync(dirfd);}
 }else if(!entries.includes('runtime-pack.json'))throw Error('CANARY_VOLUME_NOT_EMPTY');
 const packed=fsImpl.lstatSync(packFile);
 if(packed.uid!==expectedUid||packed.gid!==expectedGid||(packed.mode&0o777)!==0o600)throw Error('CANARY_VOLUME_PACK_INVALID');
 decodePack(regular(packFile,MAX_PACK_BYTES,fsImpl),pin.packSha256);
 // Easypanel may reset the mount directory mode on restart. Its existing owner
 // may restore this one directory's privacy; no recursive chmod/chown is used.
 fsImpl.chmodSync(dataDir,0o700);
 boot.checkStorage({dataDir,expectedUid,fsImpl});
 return {seeded:entries.length===0,pin};
}
function prepare(env=process.env){
 boot.checkIdentity();process.umask(0o077);
 const {pin}=verifyImagePack(IMAGE_DIR);
 if(env.DASHBOARD_PACK_SHA256!==undefined&&env.DASHBOARD_PACK_SHA256!==pin.packSha256)throw Error('CANARY_ENV_PIN_MISMATCH');
 // Validate all fixed-path and mode controls before seeding an unused volume.
 const fixed=boot.pinnedEnv({...env,DASHBOARD_PACK_SHA256:pin.packSha256});
 seedVolume();
 process.env.DASHBOARD_PACK_SHA256=fixed.DASHBOARD_PACK_SHA256;
 process.env.DASHBOARD_DB_PATH=fixed.DASHBOARD_DB_PATH;
 process.env.DASHBOARD_EXPECT_UID='1000';process.env.DASHBOARD_EXPECT_GID='1000';
 return pin;
}
function start(){prepare();return boot.start();}
if(require.main===module){try{start();}catch{console.error('Dashboard canary startup refused: identity, pin, empty-volume or configuration check failed.');process.exitCode=1;}}
module.exports={IMAGE_DIR,seedVolume,prepare,start};
