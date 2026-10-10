'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const schema=fs.readFileSync(path.join(__dirname,'schema.sql'));
a.equal(sha(schema),'9d94ea32ee76aab91f6fc5c1179539513a8a955984951570ed537b1916230a8f');
const profile=path.join(root,'crm-scheduler-batch-profile.json');
a.equal(sha(fs.readFileSync(profile)),'bf267a271a23b449c4d1f9ea707fcaa2c12f3ffd66ca709dd9765ef4a9fd2953');
const fixture=path.join(root,'tests/segment-regular-native-fixture.cjs');
a.equal(sha(fs.readFileSync(fixture)),'9f9435b2107f7659929f326644789bdd56bd70b91f315044a1f5ff99a8e608ae');
a.equal(process.version,'v22.23.3');a.equal(process.getuid(),1000);a.equal(process.platform,'linux');a.equal(process.arch,'x64');
a.equal(process.env.CRM_AUDIENCE_TEST_ISOLATED,'1');a.equal(process.env.REGULAR_NATIVE_PROOF_ISOLATED,'1');
a.equal(require('pg/package.json').version,'8.23.1');
const u=new URL(process.env.TEST_DATABASE_URL||'http://invalid');
a.equal(u.protocol,'postgresql:');a.equal(u.hostname,'127.0.0.1');a.equal(u.port,'55432');a.equal(u.pathname,'/listmonk');
a.equal(u.username,'postgres');a.equal(u.password,'');a.equal(u.search,'');a.equal(u.hash,'');
const {Client}=require('pg');
async function main(){
 const db=new Client({connectionString:u.href,options:'-c TimeZone=Etc/UTC',statement_timeout:15000});let ended=false;
 try{
  await db.connect();
  const row=(await db.query("SELECT current_setting('server_version_num')::integer version, count(*)::int tables FROM pg_tables WHERE schemaname NOT IN('pg_catalog','information_schema')")).rows[0];
  a.equal(row.version,170010);a.equal(row.tables,0,'Fixture must be new and empty');
  await db.query(schema.toString('utf8'));
  await db.query("INSERT INTO settings(key,value) VALUES('migrations','[\"v6.1.0\"]')");
 }finally{await db.end();ended=true;}
 a.equal(ended,true);
 const env={...process.env,REGULAR_NATIVE_BATCH_PROFILE:profile,REGULAR_NATIVE_BATCH_PROFILE_SHA256:'bf267a271a23b449c4d1f9ea707fcaa2c12f3ffd66ca709dd9765ef4a9fd2953'};
 delete env.REGULAR_NATIVE_SOURCE_PROOF;
 const child=spawnSync(process.execPath,[fixture,'prepare-batch-dependencies'],{cwd:root,env,stdio:'inherit',timeout:60000});
 a.equal(child.error,undefined);a.equal(child.signal,null);a.equal(child.status,0);
 console.log(JSON.stringify({schema:'own-recovery-fixture-bootstrap-v1',officialVersion:'6.1.0',officialCommit:'1b5e8d38c778e869003486d3c38bc7a964661e91',isolated:true,originalCalls:0,clientsEnded:true,workerOrSMTPStarted:false}));
}
main().catch(e=>{console.log(JSON.stringify({schema:'own-recovery-fixture-bootstrap-v1',status:'FAILED',code:e.code||'ASSERTION',originalCalls:0}));process.exitCode=1;});
