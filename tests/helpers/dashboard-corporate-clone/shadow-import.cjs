'use strict';
// One-shot, offline identity clone. No environment, server startup or external key.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {DatabaseSync,backup}=require('node:sqlite');
const ADMIN='felipebandeira@oaristocrata.com',SCHEMA='dashboard_v23_shadow_import_v1';
const ERROR='Dashboard shadow import refused.';
const fail=()=>{throw Error(ERROR);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===keys.slice().sort().join(',');
function build({seedVolume,sourceDir,destDir,uid,gid,requireReadOnlyMount=false}){
 if(typeof seedVolume!=='function'||!Number.isSafeInteger(uid)||uid<=0||!Number.isSafeInteger(gid)||gid<=0)fail();
 function stat(p,dir=false){if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p)fail();const s=fs.lstatSync(p);if(s.isSymbolicLink()||(dir?!s.isDirectory():!s.isFile())||s.uid!==uid||s.gid!==gid||(s.mode&0o777)!==(dir?0o700:0o600)||(!dir&&s.nlink!==1)||fs.realpathSync(p)!==p)fail();return s;}
 function integrity(db){const r=db.prepare('PRAGMA integrity_check').all();if(r.length!==1||r[0].integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)fail();}
 function snapshot(db){
  integrity(db);
  const admins=db.prepare("SELECT email,password_hash FROM users WHERE role='superadmin'").all();
  if(admins.length!==1||admins[0].email!==ADMIN||typeof admins[0].password_hash!=='string'||!admins[0].password_hash)fail();
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
  const h=crypto.createHash('sha256');h.update(JSON.stringify(schema));
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  let rows=0,totalBytes=0,users=0,upstreamCredentials=0;
  for(const {name} of tables){
   const quoted='"'+name.replaceAll('"','""')+'"';
   const statement=db.prepare('SELECT * FROM '+quoted);statement.setReadBigInts(true);
   const encoded=statement.all().map(row=>JSON.stringify(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?['integer',v.toString()]:v instanceof Uint8Array?['blob',Buffer.from(v).toString('hex')]:v]))).sort();
   rows+=encoded.length;if(name==='users')users=encoded.length;if(name==='upstream_credentials')upstreamCredentials=encoded.length;
   h.update(JSON.stringify(name));for(const row of encoded){totalBytes+=Buffer.byteLength(row);if(totalBytes>32*1024*1024)fail();h.update(row);h.update('\n');}
  }
  return {digest:h.digest('hex'),counts:{tables:tables.length,rows,users,upstreamCredentials,superadmins:1}};
 }
 function oldPack(expected){
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))fail();
  const p=path.join(sourceDir,'runtime-pack.json'),s=stat(p);if(s.size>950000)fail();const bytes=fs.readFileSync(p),wrapper=JSON.parse(bytes.toString('utf8'));
  if(!exact(wrapper,['schema','sha256','gzipBase64'])||wrapper.schema!=='shrigma_dashboard_operational_pack_v1'||wrapper.sha256!==expected||typeof wrapper.gzipBase64!=='string'||Buffer.from(wrapper.gzipBase64,'base64').toString('base64')!==wrapper.gzipBase64)fail();
  const raw=zlib.gunzipSync(Buffer.from(wrapper.gzipBase64,'base64'),{maxOutputLength:16*1024*1024});if(sha(raw)!==expected||!Array.isArray(JSON.parse(raw.toString('utf8'))))fail();return {s,bytes};
 }
 async function run(expectedSourcePackSha256){
  let source,target;
  try{
   if(process.getuid?.()!==uid||process.getgid?.()!==gid||typeof backup!=='function')fail();
   if(requireReadOnlyMount){const matches=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(line=>line.split(' ')).filter(fields=>fields[4]===sourceDir);if(matches.length!==1||!matches[0][5].split(',').includes('ro'))fail();}
   stat(sourceDir,true);stat(destDir,true);if(sourceDir===destDir||destDir.startsWith(sourceDir+'/')||sourceDir.startsWith(destDir+'/')||fs.readdirSync(destDir).length)fail();
   const old=oldPack(expectedSourcePackSha256),sourceFile=path.join(sourceDir,'dashboard.sqlite'),original=stat(sourceFile);if(original.size>64*1024*1024)fail();
   for(const suffix of ['-wal','-shm']){let exists=true;try{fs.lstatSync(sourceFile+suffix);}catch(e){if(e.code==='ENOENT')exists=false;else throw e;}if(exists)stat(sourceFile+suffix);}
   source=new DatabaseSync(sourceFile,{readOnly:true});source.exec('PRAGMA busy_timeout=5000; BEGIN');const before=snapshot(source);
   const seeded=seedVolume({dataDir:destDir,expectedUid:uid,expectedGid:gid});
   if(!seeded||seeded.seeded!==true||!exact(seeded.pin,['schema','baseImage','sourceRevision','packSha256'])||!/^[a-f0-9]{40}$/.test(seeded.pin.sourceRevision)||!/^[a-f0-9]{64}$/.test(seeded.pin.packSha256)||fs.readdirSync(destDir).join(',')!=='runtime-pack.json')fail();
   const packFile=path.join(destDir,'runtime-pack.json'),packStat=stat(packFile),packBytes=fs.readFileSync(packFile);
   fs.writeFileSync(path.join(destDir,'.shadow-import-attempted-v1'),'v1\n',{flag:'wx',mode:0o600});
   const destination=path.join(destDir,'dashboard.sqlite');const fd=fs.openSync(destination,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);
   await backup(source,destination);source.exec('ROLLBACK');source.close();source=null;
   const after=stat(sourceFile),oldAfter=stat(path.join(sourceDir,'runtime-pack.json'));if(after.dev!==original.dev||after.ino!==original.ino||oldAfter.dev!==old.s.dev||oldAfter.ino!==old.s.ino||!fs.readFileSync(path.join(sourceDir,'runtime-pack.json')).equals(old.bytes))fail();
   stat(destination);target=new DatabaseSync(destination);target.exec('PRAGMA wal_checkpoint(TRUNCATE)');if(target.prepare('PRAGMA journal_mode=DELETE').get().journal_mode!=='delete')fail();const copied=snapshot(target);target.close();target=null;
   if(copied.digest!==before.digest)fail();
   for(const suffix of ['-wal','-shm'])if(fs.existsSync(destination+suffix))fail();
   const finalPack=stat(packFile);if(finalPack.dev!==packStat.dev||finalPack.ino!==packStat.ino||!fs.readFileSync(packFile).equals(packBytes)||fs.readdirSync(destDir).sort().join(',')!=='.shadow-import-attempted-v1,dashboard.sqlite,runtime-pack.json')fail();
   stat(destination);const dirfd=fs.openSync(destDir,'r');try{fs.fsyncSync(dirfd);}finally{fs.closeSync(dirfd);}
   return Object.freeze({schema:SCHEMA,newRevision:seeded.pin.sourceRevision,sourceAdminPreserved:true,counts:Object.freeze(copied.counts),ready:true});
  }catch{fail();}finally{try{source?.close();}catch{}try{target?.close();}catch{}}
 }
 return Object.freeze({run});
}
function createShadowImporter({seedVolume}){return build({seedVolume,sourceDir:'/source-identity',destDir:'/dashboard-data',uid:1000,gid:1000,requireReadOnlyMount:true});}
// Lab only: no CLI route to alter paths or identity. Must match the unprivileged caller.
function createLabShadowImporter(options){if(!exact(options,['seedVolume','sourceDir','destDir','uid','gid'])||options.uid!==process.getuid?.()||options.gid!==process.getgid?.())fail();return build(options);}
if(require.main===module){
 const args=process.argv.slice(2);
 Promise.resolve().then(()=>{if(args.length!==1||process.getuid?.()!==1000||process.getgid?.()!==1000)fail();const {seedVolume}=require('/app/canary-start.cjs');return createShadowImporter({seedVolume}).run(args[0]);}).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error(ERROR);process.exitCode=1;});
}
module.exports={createShadowImporter,createLabShadowImporter};
