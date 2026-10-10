'use strict';
// Portable native SOURCE proof; only an existing isolated loopback fixture is accepted.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let phase='boundary',rollbackConfirmed=false,clientEndConfirmed=false;
function filePin(p,h){a(path.isAbsolute(p));a(!p.split(path.sep).includes('.private'));a.equal(fs.realpathSync(p),p);a(!fs.lstatSync(p).isSymbolicLink());a.equal(sha(fs.readFileSync(p)),h);}
async function main(){
 a.equal(process.env.PERMANENT_EXCLUSION_FIXTURE_ISOLATED,'1');a.equal(process.env.CRM_AUDIENCE_TEST_ISOLATED,'1');a.equal(process.env.REGULAR_NATIVE_SOURCE_PROOF,'1');
 a.equal(process.version,'v22.23.3');a.equal(process.getuid(),1000);a.equal(process.platform,'linux');a.equal(process.arch,'x64');a.equal(require('pg/package.json').version,'8.23.1');
 const u=new URL(process.env.PERMANENT_EXCLUSION_FIXTURE_URL||'https://invalid');a.equal(u.protocol,'postgresql:');a.equal(u.hostname,'127.0.0.1');a.equal(u.pathname,'/listmonk');a(u.port&&u.port!=='5432');a.equal(u.username,'postgres');a.equal(u.password,'');a.equal(u.search,'');a.equal(u.hash,'');
 const pins=JSON.parse(fs.readFileSync(path.join(__dirname,'PROOF-SOURCE-PINS.json')));for(const[n,h]of Object.entries(pins))filePin(path.join(__dirname,n),h);
 const repo=process.env.PERMANENT_EXCLUSION_REPO_ROOT;a(repo&&path.isAbsolute(repo)&&!repo.split(path.sep).includes('.private'));
 const hp=path.join(process.env.PERMANENT_EXCLUSION_HEARTBEAT_SOURCE_DIR||'', 'prepare.cjs');filePin(hp,'e1e45367ab8eea1f0ca629ea6785bb392a4f8df33d77745d3caf07de2d7366bc');
 const cp=path.join(process.env.PERMANENT_EXCLUSION_CONTENTION_SOURCE_DIR||'', 'prepare.cjs');filePin(cp,'eb720857ab797f4f2b68d76d81488adc1ea1682a69292a164cd5da07f88f1384');
 const source=require('./prepare.cjs'),candidate={...source.FIXED,workerSha256:'6'.repeat(64),imageSha256:'7'.repeat(64)}; // synthetic identity, NEVER an original admission
 const {Client}=require('pg');const db=new Client({connectionString:u.href,options:'-c TimeZone=Etc/UTC',query_timeout:12000});let result=null,failed=null,tx=false;
 try{
  phase='connect';await db.connect();const b=(await db.query("SELECT current_setting('server_version_num') v,current_database() d,current_setting('TimeZone') tz,session_user=current_user same")).rows[0];a.deepEqual(b,{v:'170010',d:'listmonk',tz:'Etc/UTC',same:true});
  a.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.regular_worker_lease')).rows[0].n,0);
  phase='begin';await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');tx=true;await db.query("SET LOCAL TimeZone='Etc/UTC';SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='500ms';SET LOCAL search_path=pg_catalog;");
  phase='seed-public-fixture';await require('./fixture.native.cjs').setup({client:db,source:candidate,repository:repo,heartbeatSource:require(hp),contentionSource:require(cp)});
  phase='focal-sql';result=await require('./pg-focal.test.cjs').run({db,candidate});a.equal(result.cases,23);phase='rollback-end';
 }catch(e){failed={phase,focalCase:typeof e.focalCase==='string'&&/^[a-z0-9-]{1,100}$/.test(e.focalCase)?e.focalCase:null,passedCases:Number.isInteger(e.passedCases)?e.passedCases:0,sqlstate:typeof e.code==='string'&&/^[A-Z0-9]{5}$/.test(e.code)?e.code:null,refusalCode:typeof e.message==='string'&&/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:null,exceptionType:e.name==='AssertionError'?'AssertionError':e.name==='Error'?'Error':'UnknownError'};}
 finally{
  if(tx){try{const r=await db.query('ROLLBACK');rollbackConfirmed=r.command==='ROLLBACK';}catch{rollbackConfirmed=false;}}
  try{await db.end();clientEndConfirmed=true;}catch{clientEndConfirmed=false;}
 }
 const report={schema:'fish-permanent-exclusion-native-proof-v1',ok:!!result&&!failed&&rollbackConfirmed&&clientEndConfirmed,caseCount:result?.cases||failed?.passedCases||0,synthetic:true,postgresVersion:'17.10',nodeVersion:process.version,uid:process.getuid(),rollbackOnly:true,rollbackConfirmed,clientEndConfirmed,fixtureServerEnded:false,serverEndOwner:'Root CI must independently stop the fixture and record server end',lateSESConsumerExecuted:false,workerExecuted:false,smtpCalls:0,originalCalls:0,originalWrites:0,operational:false,failure:failed,sourcePins:pins};
 const output=process.env.PERMANENT_EXCLUSION_FIXTURE_RECEIPT;a(output&&path.isAbsolute(output)&&!output.split(path.sep).includes('.private')&&!fs.existsSync(output));fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o644});process.stdout.write(JSON.stringify({schema:report.schema,ok:report.ok,caseCount:report.caseCount,rollbackConfirmed,clientEndConfirmed,failure:failed,originalCalls:0,operational:false})+'\n');if(!report.ok)process.exitCode=1;
}
main().catch(e=>{process.stdout.write(JSON.stringify({schema:'fish-permanent-exclusion-native-proof-v1',ok:false,phase,refusalCode:/^[A-Z0-9_]{1,100}$/.test(e.message||'')?e.message:null,rollbackConfirmed,clientEndConfirmed,originalCalls:0,operational:false})+'\n');process.exitCode=1;});
