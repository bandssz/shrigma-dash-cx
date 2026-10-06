'use strict';
// Public image-only contract. Never starts an application, pool, listener or provider.
const a=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const plan=JSON.parse(fs.readFileSync('/proof/image-plan.json','utf8'));
const kind=process.argv[2],p=plan.images.find(x=>x.kind===kind);let stage='platform';
(async()=>{
 a.ok(p);a.equal(process.versions.node.split('.')[0],'22');a.equal(process.platform,'linux');a.equal(process.arch,'x64');a.equal(process.getuid(),1000);a.equal(process.getgid(),1000);
 stage='runtime-source';
 for(const f of p.runtimeFiles){const s=fs.lstatSync(f.imagePath);a.ok(s.isFile()&&!s.isSymbolicLink());a.equal(s.size,f.bytes);a.equal(crypto.createHash('sha256').update(fs.readFileSync(f.imagePath)).digest('hex'),f.sha256);}
 let pgVersion=null,pack=null,backupApi=false,disabled=null;
 if(kind==='portal'){
  stage='portal-pack';const I=require('/app/canary-image.cjs'),P=require('/app/artifact-policy.cjs');
  a.deepEqual(fs.readdirSync('/app').sort(),I.IMAGE_FILES);
  const v=I.verifyImagePack('/app');a.deepEqual(v.pin,{schema:'shrigma_dashboard_canary_image_v1',baseImage:p.baseImage,sourceRevision:plan.sourceRevision,packSha256:plan.portalPack.sha256});
  a.equal(Buffer.byteLength(v.input),plan.portalPack.bytes);const decoded=P.decodePack(v.input,plan.portalPack.sha256);
  for(const k of ['files','publicFiles','runtimeFiles'])a.equal(decoded.stats[k],plan.portalPack[k]);
  const sqlite=require('node:sqlite');a.equal(typeof sqlite.DatabaseSync,'function');a.equal(typeof sqlite.backup,'function');backupApi=true;
  stage='synthetic-sqlite';const dir=fs.mkdtempSync('/tmp/stack-image-proof-');let writer,reader,copy;
  try{
   writer=new sqlite.DatabaseSync(dir+'/source.sqlite');writer.exec('CREATE TABLE proof(id INTEGER PRIMARY KEY,label TEXT NOT NULL) STRICT;');writer.prepare('INSERT INTO proof VALUES(?,?)').run(1,'synthetic');writer.close();writer=null;
   const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(dir+'/source.sqlite')).digest('hex'),before=hash();
   reader=new sqlite.DatabaseSync(dir+'/source.sqlite',{readOnly:true});reader.exec('BEGIN');await sqlite.backup(reader,dir+'/copy.sqlite');reader.exec('ROLLBACK');reader.close();reader=null;
   copy=new sqlite.DatabaseSync(dir+'/copy.sqlite',{readOnly:true});a.deepEqual({...copy.prepare('SELECT id,label FROM proof').get()},{id:1,label:'synthetic'});a.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');copy.close();copy=null;a.equal(hash(),before);
  }finally{for(const db of [copy,reader,writer])try{db?.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});}
  pack=plan.portalPack;
 }else{
  stage='locked-dependencies';const root=p.packageRoot;
  const lock=JSON.parse(fs.readFileSync(root+'/package-lock.json','utf8'));a.equal(lock.packages['node_modules/pg'].version,'8.13.1');
  for(const [name,v] of Object.entries(lock.packages)){if(!name)continue;const installed=JSON.parse(fs.readFileSync(root+'/'+name+'/package.json','utf8'));a.equal(installed.version,v.version);}
  pgVersion=require(root+'/node_modules/pg/package.json').version;a.equal(pgVersion,'8.13.1');
  stage='dormant-import';
  const mod=require(p.module);a.equal(typeof mod[p.export],'function');
  if(kind==='writer'){const c=mod.config({...process.env});a.equal(c.enabled,false);a.equal(c.revision,plan.sourceRevision);a.equal(c.pg,undefined);disabled=true;}
  else if(kind==='template'){const c=require(p.packageRoot+'/config.cjs').config({...process.env});a.equal(c.enabled,false);a.equal(c.revision,plan.sourceRevision);a.equal(c.pg,null);disabled=true;}
  else if(kind==='audience'){const cfg=require(p.packageRoot+'/config.cjs');a.equal(typeof cfg.config,'function');a.throws(()=>cfg.config({}),{message:'CRM_AUDIENCE_CONFIG'});disabled='unconfigured-start-refused';}
  else{a.throws(()=>mod.config({}));disabled='unconfigured-start-refused';}
 }
 const result={schema:'crm-stack-image-oci-v1',kind,sourceRevision:plan.sourceRevision,baseImage:p.baseImage,nodeVersion:process.versions.node,sqliteVersion:process.versions.sqlite||null,os:process.platform,architecture:process.arch,uid:process.getuid(),gid:process.getgid(),pgVersion,checkedRuntimeFiles:p.runtimeFiles.length,portalPack:pack,sqliteBackupApi:backupApi,disabledContract:disabled,applicationStarted:false,postgresSqlExecuted:false,syntheticSqliteFixture:kind==='portal',providerCalled:false,network:'none'};
 process.stdout.write(JSON.stringify(result)+'\n');
})().catch(()=>{process.stderr.write('IMAGE_PREFLIGHT_REFUSED:'+stage+'\n');process.exitCode=1;});
