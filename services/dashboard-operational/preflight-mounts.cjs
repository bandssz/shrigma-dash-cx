'use strict';
// Filter docker inspect to a non-sensitive boolean record. Never echo the input.
const fs=require('node:fs');
const LIMIT=1024*1024;
function fail(){throw Error('PREFLIGHT_REFUSED');}
function check(input,{sourceName,outputName}={}){
 if(typeof sourceName!=='string'||!sourceName||typeof outputName!=='string'||!outputName||sourceName===outputName)fail();
 let inspect;try{inspect=JSON.parse(input);}catch{fail();}
 const c=Array.isArray(inspect)&&inspect.length===1?inspect[0]:inspect;
 if(!c||typeof c!=='object'||!Array.isArray(c.Mounts))fail();
 const mounts=c.Mounts;
 const source=mounts.find(m=>m.Destination==='/source-data');
 const output=mounts.find(m=>m.Destination==='/snapshot-data');
 const exact=mounts.length===2&&mounts.filter(m=>m.Destination==='/source-data').length===1&&mounts.filter(m=>m.Destination==='/snapshot-data').length===1;
 const sourceRO=source?.Type==='volume'&&source.RW===false;
 const outputRW=output?.Type==='volume'&&output.RW===true;
 const separate=source?.Name!==output?.Name&&source?.Source!==output?.Source;
 const identities=source?.Name===sourceName&&output?.Name===outputName;
 const mountsPass=exact&&sourceRO&&outputRW&&separate&&identities;
 const runtimePresent=!!(c.Config&&c.HostConfig);
 const h=c.HostConfig||{};
 const user=c.Config?.User==='1000:1000';
 const netNone=h.NetworkMode==='none';
 const rootRO=h.ReadonlyRootfs===true;
 const noPorts=!h.PortBindings||Object.keys(h.PortBindings).length===0;
 const privileges=h.Privileged===false&&(!h.CapAdd||h.CapAdd.length===0)&&Array.isArray(h.CapDrop)&&h.CapDrop.includes('ALL')&&Array.isArray(h.SecurityOpt)&&h.SecurityOpt.includes('no-new-privileges:true');
 const limits=Number.isSafeInteger(h.Memory)&&h.Memory>0&&h.Memory<=512*1024*1024&&Number.isSafeInteger(h.NanoCpus)&&h.NanoCpus>0&&h.NanoCpus<=500000000;
 const noRestart=h.RestartPolicy?.Name==='no';
 const runtimePass=runtimePresent&&user&&netNone&&rootRO&&noPorts&&privileges&&limits&&noRestart;
 const pass=mountsPass&&runtimePass;
 return {schema:'identity_snapshot_mount_preflight_v1',pass,mountsPass,runtimePresent,runtimePass,sourceRO,outputRW,separateVolumes:separate,expectedIdentities:identities,exactMounts:exact};
}
if(require.main===module){
 try{
  const parts=[],block=Buffer.alloc(65536);let total=0;
  for(;;){const n=fs.readSync(0,block,0,block.length,null);if(!n)break;total+=n;if(total>LIMIT)fail();parts.push(Buffer.from(block.subarray(0,n)));}
  if(total<2)fail();const data=Buffer.concat(parts,total);
  const result=check(data,{sourceName:process.env.EXPECTED_SOURCE_VOLUME,outputName:process.env.EXPECTED_NEW_VOLUME});
  process.stdout.write(JSON.stringify(result)+'\n');
  if(!result.pass)process.exitCode=1;
 }catch{process.stdout.write('{"schema":"identity_snapshot_mount_preflight_v1","pass":false}\n');process.exitCode=1;}
}
module.exports={check};
