'use strict';
/**
 * Offline transport for an already verified identity snapshot. Requires AWS CLI
 * v2 on the maintenance runner; it is deliberately absent from the web image.
 * Credentials come only from the standard AWS provider chain at runtime.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {DATABASE,MANIFEST,verifyBackup}=require('./backup-identity.cjs');

const SCHEMA='dashboard_identity_s3_receipt_v1';
const MAX_DATABASE_BYTES=512*1024*1024;
const MAX_MANIFEST_BYTES=4096;
const FILES=[DATABASE,MANIFEST];
const nofollow=fs.constants.O_NOFOLLOW;
function fail(code){throw Error(code);}
function lstat(file){try{return fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function absolute(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file)fail('S3_PATH_INVALID');
 return file;
}
function privateDir(dir){
 absolute(dir);
 const stat=lstat(dir);
 if(!stat?.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o700||fs.realpathSync(dir)!==dir)fail('S3_DIRECTORY_INVALID');
}
function privateFile(file,maxBytes){
 absolute(file);
 const stat=lstat(file);
 if(!stat?.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600||stat.size<1||stat.size>maxBytes||fs.realpathSync(file)!==file)fail('S3_FILE_INVALID');
 return stat;
}
function configValid(config){
 if(!config||typeof config!=='object')fail('S3_CONFIG_INVALID');
 const {bucket,prefix,endpoint,region}=config;
 if(typeof bucket!=='string'||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)||bucket.includes('..'))fail('S3_BUCKET_INVALID');
 if(typeof prefix!=='string'||prefix.length>120||prefix.startsWith('/')||prefix.endsWith('/')||prefix.split('/').some(s=>!s||s==='.'||s==='..'||!/^[A-Za-z0-9_-]+$/.test(s)))fail('S3_PREFIX_INVALID');
 if(typeof region!=='string'||!/^[A-Za-z0-9-]{2,40}$/.test(region))fail('S3_REGION_INVALID');
 let url;
 try{url=new URL(endpoint);}catch{fail('S3_ENDPOINT_INVALID');}
 if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.port&&(!/^\d{1,5}$/.test(url.port)||Number(url.port)>65535))fail('S3_ENDPOINT_INVALID');
 return {bucket,prefix,endpoint:url.origin,region};
}
function environmentConfig(env=process.env){
 return configValid({bucket:env.DASHBOARD_BACKUP_BUCKET,prefix:env.DASHBOARD_BACKUP_PREFIX,endpoint:env.DASHBOARD_BACKUP_ENDPOINT_URL,region:env.AWS_REGION||env.AWS_DEFAULT_REGION});
}
function realAws(config){
 return args=>{
  const result=spawnSync('aws',['--endpoint-url',config.endpoint,'--region',config.region,'--no-cli-pager','--output','json','s3api',...args],{
   encoding:'utf8',maxBuffer:128*1024,timeout:15*60*1000,env:{...process.env,AWS_PAGER:'',AWS_CLI_AUTO_PROMPT:'off',AWS_EC2_METADATA_DISABLED:'true'}
  });
  // Never surface CLI stderr: provider errors can contain account or endpoint details.
  if(result.error||result.status!==0||result.signal)fail('S3_COMMAND_FAILED');
  try{return JSON.parse(result.stdout||'{}');}catch{fail('S3_RESPONSE_INVALID');}
 };
}
function copyExclusive(source,target){
 const from=fs.openSync(source,fs.constants.O_RDONLY|nofollow);
 try{
  const to=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|nofollow,0o600);
  try{
   const buffer=Buffer.alloc(64*1024);let count;
   while((count=fs.readSync(from,buffer,0,buffer.length,null))>0){
    let offset=0;while(offset<count){const written=fs.writeSync(to,buffer,offset,count-offset);if(written<=0)fail('S3_COPY_FAILED');offset+=written;}
   }
   fs.fsyncSync(to);
  }finally{fs.closeSync(to);}
 }finally{fs.closeSync(from);}
}
async function sha256(file){
 const hash=crypto.createHash('sha256');
 for await(const chunk of fs.createReadStream(file))hash.update(chunk);
 return hash.digest('hex');
}
function objectValid(object){
 return object&&typeof object==='object'&&!Array.isArray(object)&&
  Object.keys(object).sort().join(',')==='bytes,key,sha256,versionId'&&
  typeof object.key==='string'&&/^[A-Za-z0-9_./-]{1,240}$/.test(object.key)&&!object.key.includes('..')&&
  typeof object.versionId==='string'&&object.versionId.length>0&&object.versionId.length<=1024&&object.versionId!=='null'&&!/[\x00-\x1f\x7f]/.test(object.versionId)&&
  Number.isSafeInteger(object.bytes)&&object.bytes>0&&object.bytes<=MAX_DATABASE_BYTES&&
  typeof object.sha256==='string'&&/^[a-f0-9]{64}$/.test(object.sha256);
}
function receiptValid(receipt,config){
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||Object.keys(receipt).sort().join(',')!=='bucket,createdAt,endpoint,objects,receiptKey,region,schema')fail('S3_RECEIPT_INVALID');
 if(receipt.schema!==SCHEMA||receipt.bucket!==config.bucket||receipt.endpoint!==config.endpoint||receipt.region!==config.region||typeof receipt.createdAt!=='string'||Number.isNaN(Date.parse(receipt.createdAt)))fail('S3_RECEIPT_INVALID');
 if(!receipt.objects||typeof receipt.objects!=='object'||Object.keys(receipt.objects).sort().join(',')!==FILES.slice().sort().join(',')||!FILES.every(name=>objectValid(receipt.objects[name])&&receipt.objects[name].key.endsWith('/'+name)))fail('S3_RECEIPT_INVALID');
 if(receipt.objects[DATABASE].key.slice(0,-DATABASE.length)!==receipt.objects[MANIFEST].key.slice(0,-MANIFEST.length)||receipt.objects[MANIFEST].bytes>MAX_MANIFEST_BYTES)fail('S3_RECEIPT_INVALID');
 if(!FILES.every(name=>receipt.objects[name].key.startsWith(config.prefix+'/')))fail('S3_RECEIPT_INVALID');
 if(receipt.receiptKey!==receipt.objects[DATABASE].key.slice(0,-DATABASE.length)+'receipt.json')fail('S3_RECEIPT_INVALID');
}
function readReceipt(file,config){
 privateFile(file,8192);
 let receipt;
 try{receipt=JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('S3_RECEIPT_INVALID');}
 receiptValid(receipt,config);
 return receipt;
}
async function verifiedSource(dir){
 privateDir(dir);
 privateFile(path.join(dir,DATABASE),MAX_DATABASE_BYTES);
 privateFile(path.join(dir,MANIFEST),MAX_MANIFEST_BYTES);
 return verifyBackup(dir);
}
function createDir(parent,name){
 privateDir(parent);
 const dir=path.join(parent,name);
 if(lstat(dir))fail('S3_TARGET_EXISTS');
 fs.mkdirSync(dir,{mode:0o700});privateDir(dir);
 return dir;
}
function prepareDownload(dir){
 for(const name of FILES){
  const fd=fs.openSync(path.join(dir,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|nofollow,0o600);
  fs.closeSync(fd);
 }
}
async function downloadFiles(receipt,dir,config,aws){
 prepareDownload(dir);
 for(const name of FILES){
  const object=receipt.objects[name],file=path.join(dir,name);
  const response=await aws(['get-object','--bucket',config.bucket,'--key',object.key,'--version-id',object.versionId,file]);
  if(response?.VersionId&&response.VersionId!==object.versionId)fail('S3_VERSION_MISMATCH');
  const stat=privateFile(file,name===MANIFEST?MAX_MANIFEST_BYTES:MAX_DATABASE_BYTES);
  if(stat.size!==object.bytes||await sha256(file)!==object.sha256)fail('S3_DOWNLOAD_MISMATCH');
 }
 const verified=await verifiedSource(dir);
 if(verified.sha256!==receipt.objects[DATABASE].sha256)fail('S3_DOWNLOAD_MISMATCH');
 return verified;
}
async function exportBackup(sourceDir,receiptPath,rawConfig,awsOverride){
 const config=configValid(rawConfig),aws=awsOverride||realAws(config);
 absolute(sourceDir);absolute(receiptPath);privateDir(path.dirname(receiptPath));
 if(lstat(receiptPath))fail('S3_TARGET_EXISTS');
 const source=await verifiedSource(sourceDir);
 const status=await aws(['get-bucket-versioning','--bucket',config.bucket]);
 if(status?.Status!=='Enabled')fail('S3_VERSIONING_REQUIRED');
 const staging=fs.mkdtempSync(path.join(path.dirname(receiptPath),'.backup-s3-'));
 try{
  privateDir(staging);
  for(const name of FILES)copyExclusive(path.join(sourceDir,name),path.join(staging,name));
  const copied=await verifiedSource(staging);
  if(copied.sha256!==source.sha256||copied.bytes!==source.bytes)fail('S3_SOURCE_CHANGED');
  const stem=[config.prefix,new Date().toISOString().replace(/[-:.]/g,'').replace(/\d{3}Z$/,'Z')+'-'+crypto.randomUUID()].filter(Boolean).join('/');
  const objects={};
  for(const name of FILES){
   const file=path.join(staging,name),key=stem+'/'+name,stat=privateFile(file,name===MANIFEST?MAX_MANIFEST_BYTES:MAX_DATABASE_BYTES),digest=await sha256(file);
   const response=await aws(['put-object','--bucket',config.bucket,'--key',key,'--body',file,'--server-side-encryption','AES256']);
   if(typeof response?.VersionId!=='string'||!response.VersionId||response.VersionId==='null')fail('S3_VERSIONING_REQUIRED');
   if(response.ServerSideEncryption!=='AES256')fail('S3_ENCRYPTION_REQUIRED');
   objects[name]={key,versionId:response.VersionId,sha256:digest,bytes:stat.size};
  }
  const receipt={schema:SCHEMA,createdAt:new Date().toISOString(),bucket:config.bucket,endpoint:config.endpoint,region:config.region,objects,receiptKey:stem+'/receipt.json'};
  receiptValid(receipt,config);
  const check=createDir(staging,'readback');
  await downloadFiles(receipt,check,config,aws);
  const receiptBytes=Buffer.from(JSON.stringify(receipt)+'\n');
  const stagedReceipt=path.join(staging,'receipt.json'),receiptFd=fs.openSync(stagedReceipt,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|nofollow,0o600);
  try{fs.writeFileSync(receiptFd,receiptBytes);fs.fsyncSync(receiptFd);}finally{fs.closeSync(receiptFd);}
  const receiptUpload=await aws(['put-object','--bucket',config.bucket,'--key',receipt.receiptKey,'--body',stagedReceipt,'--server-side-encryption','AES256']);
  if(typeof receiptUpload?.VersionId!=='string'||!receiptUpload.VersionId||receiptUpload.VersionId==='null')fail('S3_VERSIONING_REQUIRED');
  if(receiptUpload.ServerSideEncryption!=='AES256')fail('S3_ENCRYPTION_REQUIRED');
  const receiptCheck=path.join(staging,'receipt-readback.json'),checkFd=fs.openSync(receiptCheck,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|nofollow,0o600);
  fs.closeSync(checkFd);
  const receiptResponse=await aws(['get-object','--bucket',config.bucket,'--key',receipt.receiptKey,'--version-id',receiptUpload.VersionId,receiptCheck]);
  if(receiptResponse?.VersionId&&receiptResponse.VersionId!==receiptUpload.VersionId)fail('S3_VERSION_MISMATCH');
  privateFile(receiptCheck,8192);
  if(!fs.readFileSync(receiptCheck).equals(receiptBytes))fail('S3_DOWNLOAD_MISMATCH');
  copyExclusive(stagedReceipt,receiptPath);
  privateFile(receiptPath,8192);
  return {verified:true,receiptPath};
 }finally{fs.rmSync(staging,{recursive:true,force:true});}
}
async function restoreBackup(receiptPath,targetDir,rawConfig,awsOverride){
 const config=configValid(rawConfig),aws=awsOverride||realAws(config);
 absolute(receiptPath);absolute(targetDir);privateDir(path.dirname(targetDir));
 if(lstat(targetDir))fail('S3_TARGET_EXISTS');
 const receipt=readReceipt(receiptPath,config);
 const dir=createDir(path.dirname(targetDir),path.basename(targetDir));
 try{await downloadFiles(receipt,dir,config,aws);return {verified:true,targetDir};}
 catch(error){fs.rmSync(dir,{recursive:true,force:true});throw error;}
}
if(require.main===module){
 const [action,...args]=process.argv.slice(2);
 let task;
 try{
  const config=environmentConfig();
  task=action==='export'&&args.length===2?exportBackup(args[0],args[1],config):action==='restore'&&args.length===2?restoreBackup(args[0],args[1],config):Promise.reject(Error('S3_USAGE_INVALID'));
 }catch(error){task=Promise.reject(error);}
 task.then(()=>console.log('External identity backup verified.')).catch(()=>{console.error('External identity backup refused.');process.exitCode=1;});
}
module.exports={SCHEMA,configValid,environmentConfig,exportBackup,restoreBackup,readReceipt,realAws};
