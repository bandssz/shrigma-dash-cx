'use strict';
// Exact bootstrap source, disposable VM adapters only: no real environment,
// identity database, volume, credential, socket, process signal or listener.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../services/dashboard-operational/bootstrap.cjs'),'utf8');
const RAW='SYNTHETIC_BOOTSTRAP_ERROR_CANARY';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(){
 let resolveRuntime,serverCallback;
 const runtimeDrain=new Promise(resolve=>resolveRuntime=resolve);
 const signals=new Map(),events=new Map(),logs=[];
 const counts={runtimeClose:0,serverClose:0,authClose:0,cleanup:0};
 const artifact={runtimeDir:'/synthetic/runtime',publicDir:'/synthetic/public'};
 const dataDir='/dashboard-data',pack=path.join(dataDir,'runtime-pack.json');
 const fakeFs={
  constants:fs.constants,
  existsSync:file=>file===dataDir||file===pack,
  lstatSync:file=>({uid:1000,mode:file===dataDir?0o700:0o600,size:100,
   isDirectory:()=>file===dataDir,isFile:()=>file===pack,isSymbolicLink:()=>false}),
  realpathSync:file=>file,mkdtempSync:()=>'/synthetic/bootstrap-extraction',accessSync(){},
  rmSync(file,options){
   assert.equal(file,'/synthetic/bootstrap-extraction');
   assert.equal(options.recursive,true);assert.equal(options.force,true);counts.cleanup++;
  }
 };
 const fakeProcess={
  env:{DASHBOARD_MODE:'operational',DASHBOARD_PACK_SHA256:'a'.repeat(64)},
  getuid:()=>1000,getgid:()=>1000,umask:mode=>assert.equal(mode,0o077),
  once(name,callback){assert.ok(['SIGTERM','SIGINT'].includes(name));signals.set(name,callback);}
 };
 const auth={close(){counts.authClose++;}};
 const managed={close(){counts.runtimeClose++;return runtimeDrain;}};
 const server={
  on(name,callback){assert.equal(name,'error');events.set(name,callback);},
  listen(port,host,callback){assert.equal(port,3000);assert.equal(host,'127.0.0.1');callback();},
  close(callback){counts.serverClose++;serverCallback=callback;},closeIdleConnections(){}
 };
 const runtime={
  settingsFromEnv:()=>({port:3000,host:'127.0.0.1'}),authOptionsFor:()=>({}),
  managedRuntimeFor:(_settings,provided)=>{assert.equal(provided,auth);return managed;},
  createServer:(_settings,provided)=>{assert.equal(provided.auth,auth);assert.equal(provided.managedCrmRuntime,managed);return server;}
 };
 const context={module:{exports:{}},process:fakeProcess,console:{log:value=>logs.push(value),error:value=>logs.push(value)},
  require(name){
   if(name==='node:fs')return fakeFs;
   if(name==='node:path')return path;
   if(name==='./artifact-policy.cjs')return {MAX_PACK_BYTES:1000000,unpack:()=>artifact};
   if(name===path.join(artifact.runtimeDir,'server.cjs'))return runtime;
   if(name===path.join(artifact.runtimeDir,'auth.cjs'))return {createAuth:()=>auth};
   throw Error('SYNTHETIC_IMPORT_DENIED');
  }
 };
 vm.runInNewContext(source,context,{filename:'bootstrap.cjs'});
 context.module.exports.start();
 const open=()=>{assert.equal(counts.authClose,0);assert.equal(counts.cleanup,0);};
 const stopped=exitCode=>{
  assert.deepEqual(counts,{runtimeClose:1,serverClose:1,authClose:1,cleanup:1});
  assert.equal(fakeProcess.exitCode,exitCode);assert.equal(logs.some(value=>value.includes(RAW)),false);
 };
 return {counts,open,stopped,
  signal:name=>signals.get(name)(),error:()=>events.get('error')(Error(RAW)),
  releaseRuntime:()=>resolveRuntime(),releaseServer:()=>{assert.equal(typeof serverCallback,'function');serverCallback();}
 };
}

test('startup error then SIGTERM waits for both drains and closes identity once with failure status',async()=>{
 const f=fixture();f.error();f.signal('SIGTERM');f.open();
 f.releaseRuntime();await tick();f.open();
 f.releaseServer();await tick();f.stopped(1);
 f.signal('SIGINT');await tick();f.stopped(1);
});

test('SIGTERM then startup error preserves failure while the runtime is still draining',async()=>{
 const f=fixture();f.signal('SIGTERM');f.error();f.open();
 f.releaseServer();await tick();f.open();
 f.releaseRuntime();await tick();f.stopped(1);
});

test('startup error after completed signal cleanup changes exit status without repeating identity cleanup',async()=>{
 const f=fixture();f.signal('SIGTERM');f.open();
 f.releaseRuntime();f.releaseServer();await tick();f.stopped(0);
 f.error();await tick();f.stopped(1);
 f.error();f.signal('SIGINT');await tick();f.stopped(1);
});

test('normal repeated signals keep identity open until both drains finish and clean up once',async()=>{
 const f=fixture();f.signal('SIGTERM');f.signal('SIGINT');f.open();
 f.releaseServer();await tick();f.open();
 f.releaseRuntime();await tick();f.stopped(0);
 f.signal('SIGTERM');await tick();f.stopped(0);
});
