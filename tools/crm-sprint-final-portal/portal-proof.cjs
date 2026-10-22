'use strict';
// Runs only in the fresh pinned CI image; no listener, provider or production DB.
const a=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const BASE='node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
const sourceRevision=process.argv[2];let stage='platform';
(async()=>{
 a.match(sourceRevision,/^[a-f0-9]{40}$/);a.notEqual(sourceRevision,'781653e546b08531c0b968aa75fc9edf3409f65f');
 a.equal(process.versions.node.split('.')[0],'22');a.equal(process.platform,'linux');a.equal(process.arch,'x64');a.equal(process.getuid(),1000);a.equal(process.getgid(),1000);
 stage='portal-pack';const I=require('/app/canary-image.cjs'),P=require('/app/artifact-policy.cjs');
 a.deepEqual(fs.readdirSync('/app').sort(),I.IMAGE_FILES);
 const v=I.verifyImagePack('/app');a.equal(v.pin.sourceRevision,sourceRevision);a.equal(v.pin.baseImage,BASE);
 const decoded=P.decodePack(v.input,v.pin.packSha256);
 const portalPack={files:decoded.stats.files,publicFiles:decoded.stats.publicFiles,runtimeFiles:decoded.stats.runtimeFiles,sha256:v.pin.packSha256,bytes:Buffer.byteLength(v.input)};
 const runtimeFiles=I.IMAGE_FILES.map(name=>{const file='/app/'+name,s=fs.lstatSync(file);a.ok(s.isFile()&&!s.isSymbolicLink());return {sourcePath:'generated-image/'+name,imagePath:file,bytes:s.size,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};});
 stage='synthetic-sqlite';const sqlite=require('node:sqlite');a.equal(typeof sqlite.DatabaseSync,'function');a.equal(typeof sqlite.backup,'function');
 const dir=fs.mkdtempSync('/tmp/crm-sprint-portal-proof-');let writer,reader,copy;
 try{
  writer=new sqlite.DatabaseSync(dir+'/source.sqlite');writer.exec('CREATE TABLE proof(id INTEGER PRIMARY KEY,label TEXT NOT NULL) STRICT;');writer.prepare('INSERT INTO proof VALUES(?,?)').run(1,'synthetic');writer.close();writer=null;
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(dir+'/source.sqlite')).digest('hex'),before=hash();
  reader=new sqlite.DatabaseSync(dir+'/source.sqlite',{readOnly:true});reader.exec('BEGIN');await sqlite.backup(reader,dir+'/copy.sqlite');reader.exec('ROLLBACK');reader.close();reader=null;
  copy=new sqlite.DatabaseSync(dir+'/copy.sqlite',{readOnly:true});a.deepEqual({...copy.prepare('SELECT id,label FROM proof').get()},{id:1,label:'synthetic'});a.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');copy.close();copy=null;a.equal(hash(),before);
 }finally{for(const db of [copy,reader,writer])try{db?.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});}
 process.stdout.write(JSON.stringify({schema:'crm-sprint-final-portal-source-image-v1',sourceRevision,baseImage:BASE,nodeVersion:process.versions.node,sqliteVersion:process.versions.sqlite||null,os:process.platform,architecture:process.arch,uid:process.getuid(),gid:process.getgid(),portalPack,runtimeFiles,syntheticSQLiteProof:true,applicationStarted:false,postgresSqlExecuted:false,providerCalled:false,network:'none'})+'\n');
})().catch(()=>{process.stderr.write('SOURCE_IMAGE_REFUSED:'+stage+'\n');process.exitCode=1;});
