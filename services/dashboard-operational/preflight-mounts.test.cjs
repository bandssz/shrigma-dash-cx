'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {check}=require('./preflight-mounts.cjs');
function fixture(){return {Mounts:[{Type:'volume',Destination:'/source-data',RW:false,Name:'source-sensitive',Source:'/private/source-sensitive'},{Type:'volume',Destination:'/snapshot-data',RW:true,Name:'output-sensitive',Source:'/private/output-sensitive'}],Config:{User:'1000:1000',Env:['SENSITIVE=never printed']},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,PortBindings:{},Privileged:false,CapAdd:[],CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],Memory:64*1024*1024,NanoCpus:100000000,RestartPolicy:{Name:'no'}}};}
const expected={sourceName:'source-sensitive',outputName:'output-sensitive'};
test('filtered mount attestation emits only flags and requires RO source',()=>{
 const valid=fixture(),result=check(JSON.stringify([valid]),expected);
 assert.equal(result.pass,true);assert.doesNotMatch(JSON.stringify(result),/never printed|SENSITIVE|source-sensitive|output-sensitive/);
 for(const mutate of [v=>{v.Mounts[0].RW=true;},v=>{v.Mounts.push({Type:'volume',Destination:'/extra',RW:true});},v=>{v.Config.User='0:0';},v=>{v.HostConfig.NetworkMode='bridge';},v=>{v.HostConfig.ReadonlyRootfs=false;},v=>{v.HostConfig.PortBindings={'3000/tcp':[{}]};}]){
  const bad=fixture();mutate(bad);assert.equal(check(JSON.stringify(bad),expected).pass,false);
 }
 const alias=fixture();alias.Mounts[1].Name=alias.Mounts[0].Name;alias.Mounts[1].Source=alias.Mounts[0].Source;
 assert.equal(check(JSON.stringify(alias),expected).mountsPass,false);
 const mountOnly=fixture();delete mountOnly.Config;delete mountOnly.HostConfig;
 assert.equal(check(JSON.stringify(mountOnly),expected).mountsPass,true);
 assert.equal(check(JSON.stringify(mountOnly),expected).pass,false);
});
