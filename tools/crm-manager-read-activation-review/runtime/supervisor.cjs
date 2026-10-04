'use strict';
// Public-only observer. No env, child, timer or server starts on import.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {intent}=require('./runtime.cjs'),{acceptProof}=require('./read-proof.cjs');
const PINS=require('./source-pins.cjs');
function fail(){throw Error('READ_ACTIVATION_SUPERVISOR_REFUSED');}
function baseEnv(){return {PATH:'/usr/local/bin:/usr/bin:/bin',NODE_PATH:'/app/node_modules',LANG:'C.UTF-8',TZ:'UTC',NODE_OPTIONS:'--max-old-space-size=96'};}
function createSupervisor({intent:value,mode,password,verifier},{spawn,readFile=fs.readFileSync,setTimer=setTimeout,clearTimer=clearTimeout,nodePath=process.execPath}={}){
 const i=intent(value);if(!['execute','reconcile'].includes(mode)||typeof password!=='string'||!password||typeof spawn!=='function')fail();
 let secret=password,scram=verifier,started,active=null,finishActive,timer;
 const status=(state,childExitConfirmed=false,proofBarrierConfirmed=false,proof=null)=>Object.freeze({schema:'crm-manager-read-supervisor-v1',action:i.action,state,childExitConfirmed,proofBarrierConfirmed,proof});
 let observed=status('pending');
 async function run(){let expired=false;try{
  for(const [name,pin]of Object.entries(PINS)){if(crypto.createHash('sha256').update(readFile(path.join(__dirname,name))).digest('hex')!==pin)fail();}
  timer=setTimer(()=>{expired=true;observed=status('outcome_unknown');try{active?.kill('SIGKILL');}catch{}finishActive?.({code:null,signal:'SIGKILL',error:true,raw:''});},30000);
  function child(file,args,env,collect){return new Promise(resolve=>{
   let settled=false,bytes=0,raw='',decoder=new TextDecoder('utf-8',{fatal:true});
   function finish(r){if(settled)return;settled=true;finishActive=null;resolve(r);}finishActive=finish;
   let proc;try{proc=spawn(nodePath,[path.join(__dirname,file),...args],{env,stdio:['ignore',collect?'pipe':'ignore','ignore'],shell:false,detached:false});active=proc;}catch{return finish({error:true});}finally{delete env.PG_ADMIN_PASSWORD;delete env.READ_SERVICE_SCRAM;}
   proc.on('error',()=>finish({error:true}));
   if(collect){proc.stdout.on('data',chunk=>{try{bytes+=Buffer.byteLength(chunk);if(bytes>2048)fail();raw+=decoder.decode(chunk,{stream:true});}catch{try{proc.kill('SIGKILL');}catch{}finish({error:true});}});proc.stdout.on('error',()=>finish({error:true}));}
   proc.on('close',(code,signal)=>{try{if(collect)raw+=decoder.decode();finish({code,signal,error:false,raw});}catch{finish({error:true});}});
  });}
  const env={...baseEnv(),READ_ACTIVATION_RUNTIME_OPT_IN:'1',READ_ACTIVATION_MODE:mode,READ_ACTIVATION_APPROVED_ACTION:mode==='execute'?i.action:'readonly-reconcile',READ_ACTIVATION_ACTION:i.action,READ_ACTIVATION_OPERATION_ID:i.operationId,READ_CREDENTIAL_INTENT_ID:i.credentialIntentId,READ_ACTIVATION_FROM_PHASE:i.fromPhase,PG_ADMIN_PASSWORD:secret};if(scram!==undefined)env.READ_SERVICE_SCRAM=scram;
  secret=undefined;scram=undefined;
  const result=await child('cli.cjs',[],env,false);
  if(expired||result.error||result.code!==0||result.signal!==null){observed=status('outcome_unknown');return observed;}
  const reread=await child('read-proof.cjs',[i.operationId],baseEnv(),true);
  if(expired||reread.error||reread.code!==0||reread.signal!==null)fail();
  observed=status('verified',true,true,acceptProof(reread.raw,i.action));return observed;
 }catch{if(!expired)observed=status('proof_refused');return observed;}
 finally{secret=undefined;scram=undefined;active=null;finishActive=null;if(timer!==undefined)clearTimer(timer);}}
 return Object.freeze({run(){if(!started)started=run();return started;},getStatus(){return observed;}});
}
function startCli(env=process.env){
 let password,verifier;
 try{
  if(process.getuid?.()!==1000||process.getgid?.()!==1000||process.versions.node.split('.')[0]!=='22'||env.READ_ACTIVATION_RUNTIME_OPT_IN!=='1')fail();
  const mode=env.READ_ACTIVATION_MODE,action=env.READ_ACTIVATION_ACTION;
  if(mode==='execute'&&env.READ_ACTIVATION_APPROVED_ACTION!==action||mode==='reconcile'&&env.READ_ACTIVATION_APPROVED_ACTION!=='readonly-reconcile')fail();
  const i=intent({schema:'crm-manager-read-runtime-intent-v1',operationId:env.READ_ACTIVATION_OPERATION_ID,credentialIntentId:env.READ_CREDENTIAL_INTENT_ID,action,fromPhase:env.READ_ACTIVATION_FROM_PHASE});
  password=env.PG_ADMIN_PASSWORD;verifier=env.READ_SERVICE_SCRAM;
  delete env.PG_ADMIN_PASSWORD;delete env.READ_SERVICE_SCRAM;
  const supervisor=createSupervisor({intent:i,mode,password,verifier},{spawn:require('node:child_process').spawn});password=undefined;verifier=undefined;
  const server=require('node:http').createServer({maxHeaderSize:4096},(req,res)=>{
   const ok=req.method==='GET'&&req.url==='/status';res.writeHead(ok?200:404,{'content-type':'application/json','cache-control':'no-store','connection':'close'});res.end(ok?JSON.stringify(supervisor.getStatus()):'{"schema":"crm-manager-read-status-refused-v1"}');
  });
  server.maxConnections=8;server.requestTimeout=3000;server.headersTimeout=3000;server.keepAliveTimeout=1000;
  server.on('error',()=>{process.exitCode=1;server.close();});
  // Bounded child, then keep observer alive for closed readback and explicit MCP cleanup.
  server.listen(8099,'0.0.0.0',()=>{supervisor.run().catch(()=>{});});return server;
 }catch{password=undefined;verifier=undefined;delete env.PG_ADMIN_PASSWORD;delete env.READ_SERVICE_SCRAM;process.stderr.write('READ_ACTIVATION_SUPERVISOR_REFUSED\n');process.exitCode=1;return null;}
}
if(require.main===module)startCli();
module.exports=Object.freeze({createSupervisor,startCli});
