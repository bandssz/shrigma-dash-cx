'use strict';
// Importing this module does not read environment, start a child or open a port.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {parsePublicProof,PINS,PROFILE}=require('../run-install.cjs');
const EXECUTOR_SHA='48b307910621f0e12f4bbc0fbca589f43aed095f51c177721e042e9a1d632f4c';
const EXE=path.resolve(__dirname,'../run-install.cjs');
const PUBLIC_KEYS=['schema','action','phase','recordedAt','sourcePins','contextVerified','mutationAttempted','commitAcknowledged','counts','profileSha256','emptyTables','durable'];
function fail(){throw Error('MANAGER_INSTALL_SUPERVISOR_REFUSED');}
function clearAdministrativeEnvironment(env){
 const password=env.PGPASSWORD;
 const extra=Object.keys(env).some(k=>(k.startsWith('PG')&&k!=='PGPASSWORD')||k==='DATABASE_URL');
 for(const k of Object.keys(env))if(k.startsWith('PG')||k==='DATABASE_URL')delete env[k];
 if(extra||typeof password!=='string'||!password||Buffer.byteLength(password)>4096||password.includes('\0'))fail();
 return password;
}
function minimalEnvironment(password){
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',NODE_PATH:'/app/node_modules',NODE_OPTIONS:'--max-old-space-size=96',LANG:'C.UTF-8',TZ:'UTC'};
 if(password!==undefined)env.PGPASSWORD=password;
 return env;
}
function acceptedProof(raw,action){
 const proof=parsePublicProof(raw);
 if(proof.action!==action||!proof.contextVerified||!proof.durable)fail();
 if(action==='install'&&proof.phase!=='verified_installed'||action==='rollback'&&proof.phase!=='verified_absent'||action==='verify'&&!['verified_existing','verified_absent'].includes(proof.phase))fail();
 if(proof.phase!=='verified_absent'&&(proof.profileSha256!==PROFILE||proof.emptyTables!==4))fail();
 if(Object.keys(proof).length!==PUBLIC_KEYS.length||Object.keys(PINS).some(k=>proof.sourcePins[k]!==PINS[k]))fail();
 return proof;
}
function createSupervisor({action,password},{spawn,setTimer=setTimeout,clearTimer=clearTimeout,readFile=fs.readFileSync,nodePath=process.execPath}={}){
 if(!['install','verify','rollback'].includes(action)||typeof password!=='string'||!password||typeof spawn!=='function')fail();
 let secret=password,started,active=null,activeFinish=null,timer,status=Object.freeze({schema:'crm-manager-install-supervisor-v1',action,state:'pending',childExitConfirmed:false,proofBarrierConfirmed:false,proof:null});
 function refuse(state){status=Object.freeze({schema:'crm-manager-install-supervisor-v1',action,state,childExitConfirmed:false,proofBarrierConfirmed:false,proof:null});}
 function kill(){try{active?.kill('SIGKILL');}catch{}}
 async function run(){
  let expired=false;
  try{
   if(crypto.createHash('sha256').update(readFile(EXE)).digest('hex')!==EXECUTOR_SHA)fail();
   timer=setTimer(()=>{expired=true;refuse('outcome_unknown');kill();activeFinish?.({code:null,signal:'SIGKILL',error:true,raw:''});},45000);
   function child(args,env,collect){return new Promise(resolve=>{
    let proc,settled=false,bytes=0,raw='';
    function finish(value){if(settled)return;settled=true;activeFinish=null;resolve(value);}
    activeFinish=finish;
    try{proc=spawn(nodePath,args,{env,stdio:['ignore',collect?'pipe':'ignore','ignore'],shell:false,detached:false});active=proc;}catch{return finish({code:null,signal:null,error:true,raw:''});}finally{delete env.PGPASSWORD;}
    proc.on('error',()=>finish({code:null,signal:null,error:true,raw:''}));
    if(collect){proc.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>16384){refuse('proof_refused');kill();finish({code:null,signal:null,error:true,raw:''});return;}raw+=chunk.toString('utf8');});proc.stdout.on('error',()=>{kill();finish({code:null,signal:null,error:true,raw:''});});}
    proc.on('close',(code,signal)=>finish({code,signal,error:false,raw}));
   });}
   const args=[EXE,action];if(action==='rollback')args.push('--consumers-stopped');
   const childEnv=minimalEnvironment(secret);secret=undefined;
   const result=await child(args,childEnv,false);delete childEnv.PGPASSWORD;
   if(expired||result.error||result.code!==0||result.signal!==null){refuse('outcome_unknown');return status;}
   // Independent reader runs in a separately killable process; it performs its
   // own file and directory fsync. The parent's 45s budget covers BOTH children.
   const verified=await child([EXE,'proof'],minimalEnvironment(),true);
   if(expired||verified.error||verified.code!==0||verified.signal!==null)fail();
   const proof=acceptedProof(verified.raw,action);
   status=Object.freeze({schema:'crm-manager-install-supervisor-v1',action,state:'verified',childExitConfirmed:true,proofBarrierConfirmed:true,proof});
   return status;
  }catch{if(!expired)refuse('proof_refused');return status;}
  finally{secret=undefined;active=null;activeFinish=null;if(timer!==undefined)clearTimer(timer);}
 }
 return Object.freeze({run(){if(!started)started=run();return started;},getStatus(){return status;}});
}
function startCli(argv,env){
  let secret;
  try{
   secret=clearAdministrativeEnvironment(env);
   const [action,...extra]=argv;
   if(extra.length||process.getuid()!==1000||process.versions.node.split('.')[0]!=='22')fail();
   const supervisor=createSupervisor({action,password:secret},{spawn:require('node:child_process').spawn});secret=undefined;
   const server=require('node:http').createServer((req,res)=>{
    const status=supervisor.getStatus(),ok=req.method==='GET'&&req.url==='/status'&&status.state==='verified'&&status.childExitConfirmed&&status.proofBarrierConfirmed;
    res.writeHead(ok?200:503,{'content-type':'application/json','cache-control':'no-store','connection':'close'});res.end(JSON.stringify(status));
   });
   server.on('error',()=>process.exit(1));
   server.listen(8099,'127.0.0.1',()=>{supervisor.run().catch(()=>{});});
   return server;
  }catch{secret=undefined;for(const k of Object.keys(env))if(k.startsWith('PG')||k==='DATABASE_URL')delete env[k];process.exitCode=1;return null;}
}
module.exports={createSupervisor,clearAdministrativeEnvironment,minimalEnvironment,acceptedProof,EXECUTOR_SHA,startCli};
if(require.main===module)startCli(process.argv.slice(2),process.env);
