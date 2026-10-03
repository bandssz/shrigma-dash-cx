'use strict';
// Diagnostic projection only. It never decides admission or removes resources.
// Input is the existing closed INSPECT/VINSPECT, never Docker logs/config/env.
const SCHEMA='crm-manager-native-preflight-debug-v1';
const IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815';
const FIELDS=['id','project','service','image','state','exitCode','oomKilled','health','memory','memorySwap','nanoCpus','pidsLimit','readOnly','capDrop','capAdd','securityOpt','networkMode','user','init','proofVolume','portBindingsCount','mountCount'];
const STAGES=['after_up','before_cleanup','cleanup_container','cleanup_volume'];
const OPERATIONS=['compose_up','container_list','container_inspect','container_remove','volume_list','volume_inspect','volume_remove'];
const PHASES=['preflight','image_pull','plan','fresh_resources','compose_config','compose_up','healthy','cleanup','cleanup_refused','deadline','compatibility_or_runtime_refused','passed'];
function refuse(){throw Error('NATIVE_PREFLIGHT_DIAGNOSTIC_REFUSED');}
function object(v){if(!v||typeof v!=='object'||Array.isArray(v))refuse();return v;}
function closed(v,keys){object(v);if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))refuse();}
function str(v){if(typeof v!=='string'||v.length>256||/[\u0000-\u001f\u007f]/.test(v))refuse();}
function num(v,min=-1,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(v)||v<min||v>max)refuse();}
function bool(v){if(typeof v!=='boolean')refuse();}
function array(v,pattern){if(v===null)return;if(!Array.isArray(v)||v.length>64||v.some(x=>typeof x!=='string'||!pattern.test(x)))refuse();}
function equal(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function metadata(v){closed(v,['composeProjectName','volumeName','status','composeSha256','pidsProfile']);if(!/^shrigma-native-preflight-[a-f0-9]{12}$/.test(v.composeProjectName)||v.volumeName!=='shrigma-native-preflight-volume-'+v.composeProjectName.slice(-12)||!/^[a-f0-9]{64}$/.test(v.composeSha256)||!['canonical','pids_limit_only'].includes(v.pidsProfile))refuse();object(v.status);return v;}
function base(meta,kind,stage){metadata(meta);if(!STAGES.includes(stage))refuse();return{schema:SCHEMA,kind,profile:meta.pidsProfile,stage};}
function projectContainer(v,meta,role,stage){
 const result=base(meta,'container',stage);if(!['prepare_volume','installer'].includes(role))refuse();closed(v,FIELDS);
 for(const k of ['id','project','service','image','networkMode','user','proofVolume'])str(v[k]);
 if(!['created','running','paused','restarting','removing','exited','dead'].includes(v.state)||!['none','starting','healthy','unhealthy'].includes(v.health))refuse();
 num(v.exitCode,0,255);for(const k of ['memory','memorySwap','nanoCpus','pidsLimit'])num(v[k]);num(v.portBindingsCount,0,65535);num(v.mountCount,0,128);
 for(const k of ['oomKilled','readOnly','init'])bool(v[k]);array(v.capDrop,/^[A-Z_]{1,32}$/);array(v.capAdd,/^[A-Z_]{1,32}$/);array(v.securityOpt,/^[a-z0-9_:=-]{1,128}$/);
 const init=role==='prepare_volume',memory=init?67108864:268435456;
 const checks={idMatches:/^[a-f0-9]{64}$/.test(v.id),projectMatches:v.project===meta.composeProjectName,serviceMatches:v.service===role,imageMatches:v.image===IMAGE,proofVolumeMatches:v.proofVolume===meta.volumeName,userMatches:v.user===(init?'0:0':'1000:1000'),capDropMatches:equal(v.capDrop,['ALL']),capAddMatches:equal(v.capAdd||[],init?['CHOWN']:[]),securityOptMatches:Array.isArray(v.securityOpt)&&v.securityOpt.length===1&&['no-new-privileges:true','no-new-privileges'].includes(v.securityOpt[0]),networkNone:v.networkMode==='none',mountCountMatches:v.mountCount===(init?1:2)};
 const ownershipMatches=checks.idMatches&&checks.projectMatches&&checks.serviceMatches;
 const resourcesMatch=checks.imageMatches&&checks.proofVolumeMatches&&checks.userMatches&&checks.capDropMatches&&checks.capAddMatches&&checks.securityOptMatches&&checks.networkNone&&checks.mountCountMatches&&v.memory===memory&&v.memorySwap===memory&&v.nanoCpus===(init?100000000:250000000)&&v.pidsLimit===(init?16:32)&&v.readOnly&&v.init&&v.portBindingsCount===0;
 let observerState='refused';if(ownershipMatches&&resourcesMatch){observerState=v.oomKilled||['dead','removing','paused','restarting'].includes(v.state)||v.health==='unhealthy'||v.state==='exited'&&(!init||v.exitCode!==0)?'failed':init&&v.state==='exited'&&v.exitCode===0||!init&&v.state==='running'&&v.health==='healthy'?'ready':'waiting';}
 return Object.freeze({...result,role,projection:'accepted',state:v.state,exitCode:v.exitCode,oomKilled:v.oomKilled,health:v.health,memory:v.memory,memorySwap:v.memorySwap,nanoCpus:v.nanoCpus,pidsLimit:v.pidsLimit,readOnly:v.readOnly,init:v.init,portBindingsCount:v.portBindingsCount,mountCount:v.mountCount,...checks,ownershipMatches,resourcesMatch,observerState});
}
function projectVolume(v,meta,stage){const result=base(meta,'volume',stage);closed(v,['name','purpose','exclusive','project']);for(const k of Object.keys(v))str(v[k]);const checks={nameMatches:v.name===meta.volumeName,purposeMatches:v.purpose==='crm-manager-native-preflight',exclusiveMatches:v.exclusive===meta.composeProjectName,projectMatches:v.project===meta.composeProjectName};return Object.freeze({...result,projection:'accepted',...checks,ownershipMatches:Object.values(checks).every(Boolean)});}
function projectCli(operation,meta,exitCode,stage){const result=base(meta,'cli',stage);if(!OPERATIONS.includes(operation))refuse();num(exitCode,0,255);return Object.freeze({...result,operation,exitCode,ok:exitCode===0});}
function projectPhase(phase,meta){metadata(meta);if(!PHASES.includes(phase))refuse();return Object.freeze({schema:SCHEMA,kind:'failure_phase',profile:meta.pidsProfile,phase});}
function parse(bytes){if(!Buffer.isBuffer(bytes)||bytes.length>8192)refuse();let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{refuse();}return value;}
module.exports=Object.freeze({projectContainer,projectVolume,projectCli,projectPhase,parse});
if(require.main===module){
 const fs=require('node:fs');let chunks=[],size=0,oversized=false;
 process.stdin.on('data',c=>{size+=c.length;if(size>8192){oversized=true;chunks=[];}else if(!oversized)chunks.push(c);});
 process.stdin.on('error',()=>{oversized=true;});
 process.stdin.on('end',()=>{try{const[mode,metaFile,stage,extra,...rest]=process.argv.slice(2);if(rest.length||!metaFile||oversized)refuse();const stat=fs.statSync(metaFile);if(!stat.isFile()||stat.size>8192)refuse();const meta=parse(fs.readFileSync(metaFile));let result;if(mode==='phase'){if(size!==0||extra!==undefined)refuse();result=projectPhase(stage,meta);}else if(mode==='cli'){if(size!==0||!/^\d{1,3}$/.test(extra||''))refuse();const separator=stage.indexOf(':');if(separator<0)refuse();result=projectCli(stage.slice(separator+1),meta,Number(extra),stage.slice(0,separator));}else{const value=parse(Buffer.concat(chunks));result=mode==='container'?projectContainer(value,meta,extra,stage):mode==='volume'&&extra===undefined?projectVolume(value,meta,stage):refuse();}process.stdout.write(JSON.stringify(result)+'\n');}catch{process.stdout.write(JSON.stringify({schema:SCHEMA,kind:'refused',reason:'projection_refused'})+'\n');process.exitCode=1;}});
}
