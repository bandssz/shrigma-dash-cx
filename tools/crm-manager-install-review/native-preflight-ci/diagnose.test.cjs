'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const D=require('./diagnose.cjs');
const IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815';
const meta={composeProjectName:'shrigma-native-preflight-a1b2c3d4e5f6',volumeName:'shrigma-native-preflight-volume-a1b2c3d4e5f6',status:{schema:'synthetic'},composeSha256:'a'.repeat(64),pidsProfile:'canonical'};
function row(role='installer'){const init=role==='prepare_volume';return{id:'a'.repeat(64),project:meta.composeProjectName,service:role,image:IMAGE,state:init?'exited':'running',exitCode:0,oomKilled:false,health:init?'none':'healthy',memory:init?67108864:268435456,memorySwap:init?67108864:268435456,nanoCpus:init?100000000:250000000,pidsLimit:init?16:32,readOnly:true,capDrop:['ALL'],capAdd:init?['CHOWN']:null,securityOpt:['no-new-privileges:true'],networkMode:'none',user:init?'0:0':'1000:1000',init:true,proofVolume:meta.volumeName,portBindingsCount:0,mountCount:init?1:2};}
test('closed state diagnosis separates init failure, runtime mount mismatch and ownership',()=>{
 const init=row('prepare_volume');init.exitCode=1;assert.equal(D.projectContainer(init,meta,'prepare_volume','before_cleanup').observerState,'failed');
 const runtime=row();runtime.mountCount=1;const p=D.projectContainer(runtime,meta,'installer','before_cleanup');assert.equal(p.mountCount,1);assert.equal(p.mountCountMatches,false);assert.equal(p.ownershipMatches,true);assert.equal(p.observerState,'refused');
 assert.equal(D.projectContainer(row(),meta,'installer','after_up').observerState,'ready');runtime.project='foreign';assert.equal(D.projectContainer(runtime,meta,'installer','cleanup_container').projectMatches,false);
 const text=JSON.stringify(p);for(const raw of [IMAGE,meta.composeProjectName,meta.volumeName,'a'.repeat(64)])assert.equal(text.includes(raw),false);
});
test('closed volume and CLI projections reject extras and malformed types',()=>{
 const v={name:meta.volumeName,purpose:'crm-manager-native-preflight',exclusive:meta.composeProjectName,project:meta.composeProjectName};assert.equal(D.projectVolume(v,meta,'cleanup_volume').ownershipMatches,true);v.project='<no value>';assert.equal(D.projectVolume(v,meta,'cleanup_volume').projectMatches,false);
 assert.equal(D.projectCli('container_remove',meta,124,'cleanup_container').ok,false);
 assert.equal(D.projectPhase('compose_up',meta).phase,'compose_up');assert.throws(()=>D.projectPhase('CANARY_RAW_SECRET',meta),/NATIVE_PREFLIGHT_DIAGNOSTIC_REFUSED/);
 for(const value of [{...row(),env:'CANARY_RAW_SECRET'},{...row(),exitCode:'1'},{...row(),mountCount:-1},{...row(),securityOpt:['CANARY_RAW_SECRET']},{...row(),state:'CANARY_RAW_SECRET'}])assert.throws(()=>D.projectContainer(value,meta,'installer','after_up'),/NATIVE_PREFLIGHT_DIAGNOSTIC_REFUSED/);
 assert.throws(()=>D.parse(Buffer.from([0xff])),/NATIVE_PREFLIGHT_DIAGNOSTIC_REFUSED/);assert.throws(()=>D.parse(Buffer.alloc(8193)),/NATIVE_PREFLIGHT_DIAGNOSTIC_REFUSED/);
});
test('CLI prints only closed diagnosis and never raw malformed data or errors',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-diag-pure-'));try{const file=path.join(dir,'metadata.json');fs.writeFileSync(file,JSON.stringify(meta));
 const invoke=(args,input)=>spawnSync(process.execPath,[path.join(__dirname,'diagnose.cjs'),...args],{env:{},input,encoding:'utf8',timeout:5000});
 const good=invoke(['container',file,'before_cleanup','prepare_volume'],JSON.stringify(row('prepare_volume')));assert.equal(good.status,0);assert.equal(good.stderr,'');assert.equal(JSON.parse(good.stdout).observerState,'ready');
 const bad=invoke(['container',file,'before_cleanup','installer'],JSON.stringify({...row(),password:'CANARY_RAW_SECRET'}));assert.equal(bad.status,1);assert.equal(bad.stderr,'');assert.deepEqual(JSON.parse(bad.stdout),{schema:'crm-manager-native-preflight-debug-v1',kind:'refused',reason:'projection_refused'});assert.equal(bad.stdout.includes('CANARY_RAW_SECRET'),false);
 const cli=invoke(['cli',file,'cleanup_volume:volume_remove','1'],'');assert.equal(cli.status,0);assert.equal(JSON.parse(cli.stdout).ok,false);
 const phase=invoke(['phase',file,'healthy'],'');assert.equal(phase.status,0);assert.equal(JSON.parse(phase.stdout).phase,'healthy');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
