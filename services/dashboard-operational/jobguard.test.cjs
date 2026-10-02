'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assess,mountOptions}=require('./jobguard.cjs');
function fakeStat({dir=false,dev=1,ino=1,size=1}={}){return {isDirectory:()=>dir,isFile:()=>!dir,uid:1000,mode:dir?0o40700:0o100600,nlink:1,dev,ino,size};}
function valid(){return {uid:1000,gid:1000,mountinfo:'1 0 0:1 / / ro - overlay overlay ro\n2 1 0:2 / /source-data ro - ext4 source ro\n3 1 0:3 / /snapshot-data rw - ext4 output rw\n',interfaces:['lo'],sourceDir:fakeStat({dir:true,dev:2}),sourceDb:fakeStat({dev:2,size:100}),wal:null,shm:null,outputDir:fakeStat({dir:true,dev:3}),outputEntries:[],env:{PATH:'/usr/bin'},status:'CapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n',memoryMax:String(64*1024*1024),cpuMax:'10000 100000\n'};}
test('jobguard requires source RO, root RO, distinct empty output, UID1000 and network none',()=>{
 assert.equal(assess(valid()),true);
 const zeroWal=valid();zeroWal.wal=fakeStat({dev:2,size:0});assert.equal(assess(zeroWal),true);
 const zeroMain=valid();zeroMain.sourceDb.size=0;assert.equal(assess(zeroMain),false);
 for(const change of [v=>{v.mountinfo=v.mountinfo.replace('/source-data ro','/source-data rw');},v=>{v.mountinfo=v.mountinfo.replace('/ / ro','/ / rw');},v=>{v.outputDir=fakeStat({dir:true,dev:2});},v=>{v.outputEntries=['.attempted'];},v=>{v.uid=0;},v=>{v.interfaces=['eth0','lo'];},v=>{v.env.DASHBOARD_ENCRYPTION_KEY='synthetic';},v=>{v.sourceDb.size=512*1024*1024+1;},v=>{v.status=v.status.replace('NoNewPrivs:\t1','NoNewPrivs:\t0');},v=>{v.status=v.status.replace('CapEff:\t0000000000000000','CapEff:\t0000000000000001');},v=>{v.memoryMax='max';},v=>{v.cpuMax='max 100000';}]){
  const bad=valid();change(bad);assert.equal(assess(bad),false);
 }
 assert.deepEqual(mountOptions(valid().mountinfo,'/source-data'),['ro']);
});
