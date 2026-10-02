'use strict';
// Synthetic metadata only: never reads /proc, mount paths, secrets or databases.
const test=require('node:test');
const assert=require('node:assert/strict');
const {check}=require('./preflight-mounts.cjs');
const {assess,mountOptions}=require('./jobguard.cjs');
const expected={sourceName:'source-private-marker',outputName:'new-private-marker'};
function container(){return {Mounts:[{Type:'volume',Destination:'/source-data',RW:false,Name:expected.sourceName,Source:'/private/source-marker'},{Type:'volume',Destination:'/snapshot-data',RW:true,Name:expected.outputName,Source:'/private/new-marker'}],Config:{User:'1000:1000',Env:['SECRET=private-marker']},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,PortBindings:{},Privileged:false,CapAdd:[],CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],Memory:64*1024*1024,NanoCpus:100000000,RestartPolicy:{Name:'no'}}};}
function s({dir=false,dev=1,ino=1,size=100}={}){return {isDirectory:()=>dir,isFile:()=>!dir,uid:1000,mode:dir?0o40700:0o100600,nlink:1,dev,ino,size};}
function guard(){return {uid:1000,gid:1000,mountinfo:'1 0 0:1 / / ro - overlay overlay ro\n2 1 0:2 / /source-data ro - ext4 source rw\n3 1 0:3 / /snapshot-data rw - ext4 output rw\n',interfaces:['lo'],sourceDir:s({dir:true,dev:2}),sourceDb:s({dev:2}),wal:null,shm:null,outputDir:s({dir:true,dev:3}),outputEntries:[],env:{PATH:'/usr/bin',HOSTNAME:'synthetic'},status:'CapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n',memoryMax:String(64*1024*1024),cpuMax:'10000 100000\n'};}
test('attestation is closed primitives and does not emit any identity/env/path',()=>{
 const result=check(JSON.stringify(container()),expected);assert.equal(result.pass,true);
 assert.doesNotMatch(JSON.stringify(result),/private-marker|source-marker|new-marker|SECRET|\/private/);
 for(const [key,value] of Object.entries(result))assert.ok(key==='schema'?typeof value==='string':typeof value==='boolean');
});
test('attestation requires approved distinct names and paths, not just RO/RW targets',()=>{
 const cases=[c=>{c.Mounts[1].Name=c.Mounts[0].Name;},c=>{c.Mounts[1].Source=c.Mounts[0].Source;},c=>{c.Mounts[0].Name='another-production-volume';},c=>{c.Mounts[1].Name='existing-production-volume';}];
 for(const change of cases){const c=container();change(c);assert.equal(check(JSON.stringify(c),expected).pass,false);}
 assert.throws(()=>check(JSON.stringify(container())));assert.throws(()=>check(JSON.stringify(container()),{sourceName:expected.sourceName,outputName:expected.sourceName}));
});
test('attestation rejects privilege/resource/restart failures even with correct mounts',()=>{
 for(const change of [h=>{h.Privileged=true;},h=>{h.CapAdd=['SYS_ADMIN'];},h=>{h.CapDrop=[];},h=>{h.SecurityOpt=[];},h=>{h.Memory=0;},h=>{h.Memory=513*1024*1024;},h=>{h.NanoCpus=0;},h=>{h.NanoCpus=500000001;},h=>{h.RestartPolicy.Name='always';}]){const c=container();change(c.HostConfig);assert.equal(check(JSON.stringify(c),expected).pass,false);}
});
test('actual job guard accepts RO bind even when underlying production filesystem is RW',()=>{
 assert.equal(assess(guard()),true);assert.deepEqual(mountOptions(guard().mountinfo,'/source-data'),['ro']);
});
test('actual job guard rejects ambiguous mounts and unsafe files before backup',()=>{
 const duplicate=guard();duplicate.mountinfo+='4 1 0:4 / /source-data ro - ext4 other rw\n';assert.throws(()=>assess(duplicate));
 for(const change of [g=>{g.sourceDir.mode=0o40755;},g=>{g.outputDir.mode=0o40755;},g=>{g.sourceDb.nlink=2;},g=>{g.sourceDb.uid=0;},g=>{g.sourceDb.mode=0o100644;},g=>{g.outputEntries=['identity'];},g=>{g.outputDir=g.sourceDir;},g=>{g.gid=0;}]){const g=guard();change(g);assert.equal(assess(g),false);}
});
test('actual job guard rejects capabilities and unlimited cgroup resources',()=>{
 for(const change of [g=>{g.status=g.status.replace('CapBnd:\t0000000000000000','CapBnd:\t0000000000000001');},g=>{g.status=g.status.replace('CapAmb:\t0000000000000000','CapAmb:\t0000000000000001');},g=>{g.memoryMax='max';},g=>{g.memoryMax=String(513*1024*1024);},g=>{g.cpuMax='max 100000';},g=>{g.cpuMax='50001 100000';}]){const g=guard();change(g);assert.equal(assess(g),false);}
});
test('actual snapshot job refuses application/DB/transport credentials in environment',()=>{
 for(const key of ['DASHBOARD_ENCRYPTION_KEY','DATABASE_URL','AWS_SECRET_ACCESS_KEY','SHOPIFY_ACCESS_TOKEN','PGPASSWORD','CRM_PANEL_KEY','N8N_API_KEY']){
  const g=guard();g.env[key]='synthetic-private-marker';assert.equal(assess(g),false,key+' must not be inherited into snapshot job');
 }
});
