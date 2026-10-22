'use strict';
// Manual public preparation. OFF/import does not read env, files or open sockets.
const crypto=require('node:crypto');
const IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815';
const PINS=Object.freeze({
 'activation.cjs':'9a3459983b415661e2665e8c3f6de1ae4fa6aa712ae012ebd3344da09e180a83',
 'sources.cjs':'9c216b9e651c52e142babb3c069493b4f8329cdc0320eadef37be99bd13a1de8',
 'runtime.cjs':'0fde24c3837f50847f7ec282427318389d83e6ce3321a98b4ef6679b30751331',
 'journal.cjs':'bbd69749e555c850fc620bf60aa9f6f226668511e1ee9b9aca7a482d852f7466',
 'cli.cjs':'abeb28eacbf4daf6692becb5c4caeefaad5bd32d2c42be97dd04cb026e5143c9',
 'read-proof.cjs':'4404e1ccd52cda9a9dccf6bdc648178f06659a5b9bc1ea64bc6fbe8652b52e65',
 'source-pins.cjs':'e4c9171752be502cc1101bb0e5edd055901d58d0402b7e24a8da59e3ef645d72',
 'supervisor.cjs':'b48c0ea980c23f2b343383e7fbfe0392707b8418a3005e4fec694bcfaacb87b0',
 'health.cjs':'d6a058b1beadb3b6ea24a154f6d9238ad90ad017906a4de51fcbdaa8e01462ed'});
const plans=new WeakSet(),hash=v=>crypto.createHash('sha256').update(v).digest('hex'),clone=v=>JSON.parse(JSON.stringify(v));
function fail(){throw Error('MANUAL_READ_DISABLE_REFUSED');}
function exact(v,keys){if(!v||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length)fail();for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=='string'||!keys.includes(k)||!d.enumerable||!Object.hasOwn(d,'value'))fail();}}
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function uuid(s){if(typeof s!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s))fail();}
function validateScope(s){
 exact(s,['schema','sourceOnly','approved','nativeCalls','postgresCalls','sourceHead','original','reservedDisable','image','runtimePins','destination','sql','flags','privateEnvNames','resources','acceptance','remaining','automaticRetry','serviceStopEqualsNoLogin']);
 if(!s||s.schema!=='crm-manager-read-stage-compensation-scope-v1'||s.sourceOnly!==true||s.approved!==false||s.image!==IMAGE||JSON.stringify(s.runtimePins)!==JSON.stringify(PINS))fail();
 const a=s.original,b=s.reservedDisable;if(!a||!b)fail();
 exact(a,['planFileSha256','planSha256','intent','projectName','serviceName','sourceVolume','ledgerVolume']);exact(b,['intent','projectName','serviceName','host','domainId','ledgerVolume','sourceVolume','originalSourceMount','newLedgerMount','existingOriginalLedgerMountForReconcile']);
 exact(s.flags,['READ_ACTIVATION_RUNTIME_OPT_IN','READ_ACTIVATION_MODE','READ_ACTIVATION_APPROVED_ACTION','READ_ACTIVATION_ACTION','READ_ACTIVATION_OPERATION_ID','READ_CREDENTIAL_INTENT_ID','READ_ACTIVATION_FROM_PHASE']);
 if(JSON.stringify(s.privateEnvNames)!==JSON.stringify(['PG_ADMIN_PASSWORD'])||s.nativeCalls!==0||s.postgresCalls!==0||s.serviceStopEqualsNoLogin!==false)fail();
 exact(a.intent,['schema','operationId','credentialIntentId','action','fromPhase']);exact(b.intent,['schema','operationId','credentialIntentId','action','fromPhase']);
 for(const i of [a.intent,b.intent]){uuid(i.operationId);uuid(i.credentialIntentId);if(i.schema!=='crm-manager-read-runtime-intent-v1')fail();}
 if(a.intent.action!=='stage'||a.intent.fromPhase!=='empty'||b.intent.action!=='disable'||b.intent.fromPhase!=='staged'||b.intent.credentialIntentId!==a.intent.credentialIntentId||b.intent.operationId===a.intent.operationId||b.intent.operationId===b.intent.credentialIntentId)fail();uuid(b.domainId);
 const compact=b.intent.operationId.replace(/-/g,''),service='mgr-dis-'+compact.slice(0,12);
 if(a.projectName!=='crm-manager-stage-20261004'||b.projectName!==a.projectName||b.serviceName!==service||b.host!==service+'.tazdb8.easypanel.host'||b.ledgerVolume!=='shrigma-read-disable-'+compact||b.sourceVolume!==a.sourceVolume||!/^shrigma-read-source-[a-f0-9]{32}$/.test(a.sourceVolume)||!/^shrigma-read-stage-[a-f0-9]{32}$/.test(a.ledgerVolume)||b.ledgerVolume===a.ledgerVolume||b.ledgerVolume===b.sourceVolume||a.serviceName===b.serviceName||b.originalSourceMount!=='read_only'||b.newLedgerMount!=='read_write')fail();
 if(JSON.stringify(s.destination)!==JSON.stringify({host:'comunicacao_postgres',port:5432,database:'listmonk',user:'postgres',ssl:false,postgresMajor:17}))fail();
 if(s.sql.profileSha256!=='4f5b8bdec729d2924c043da6bd3c0f8f2ce01a82af614187cefa1322ecef11c9'||s.sql.mutatingSha256!=='2ebe0bb7791b99a85696cd0bdf067d7610dc76c1a996ee2d2c8ed7fa7ac82b75'||s.sql.readServiceScramAllowed!==false||s.automaticRetry!==false)fail();
 return clone(s);
}
function initializerRuntime(){
 const fs=require('node:fs');let fd;
 try{
  if(process.getuid()!==0||process.getgid()!==0||process.versions.node.split('.')[0]!=='22'||process.env.PG_ADMIN_PASSWORD!==undefined||process.env.READ_SERVICE_SCRAM!==undefined||JSON.stringify(fs.readdirSync('/sys/class/net').sort())!==JSON.stringify(['lo']))throw 0;
  const p='/runtime-proof',s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&0o7777)!==0o755||fs.realpathSync(p)!==p)throw 0;
  fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  const before=fs.fstatSync(fd);if(before.dev!==s.dev||before.ino!==s.ino||fs.readdirSync(p).length)throw 0;
  // All reads/empty checks precede ownership change. Retain the same FD.
  fs.fchmodSync(fd,0o700);fs.fchownSync(fd,1000,1000);
  const after=fs.fstatSync(fd);if(after.uid!==1000||after.gid!==1000||(after.mode&0o7777)!==0o700||after.dev!==s.dev||after.ino!==s.ino)throw 0;
  fs.fsyncSync(fd);
 }catch{process.stderr.write('MANUAL_READ_DISABLE_INITIALIZER_REFUSED\n');process.exitCode=1;}
 finally{if(fd!==undefined){try{fs.closeSync(fd);}catch{process.exitCode=1;}}}
}
function loaderRuntime(expected,pins,publicOnly){
 const fs=require('node:fs'),crypto=require('node:crypto');
 const refuse=()=>{throw Error('MANUAL_READ_DISABLE_LOADER_REFUSED');};
 try{
  if(process.getuid()!==1000||process.getgid()!==1000||process.versions.node.split('.')[0]!=='22')refuse();
  const status=new Map(fs.readFileSync('/proc/self/status','utf8').split('\n').filter(x=>x.includes(':')).map(x=>{const i=x.indexOf(':');return[x.slice(0,i),x.slice(i+1).trim()];}));
  for(const k of ['CapEff','CapPrm','CapBnd'])if(!/^0+$/.test(status.get(k)||''))refuse();if(status.get('NoNewPrivs')!=='1')refuse();
  const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').map(x=>x.split(' ')),options=p=>{const m=mounts.filter(x=>x[4]===p);if(m.length!==1)refuse();return m[0][5].split(',');};
  if(!options('/').includes('ro')||!options('/review').includes('ro')||!options('/runtime-proof').includes('rw'))refuse();
  const tmp=options('/tmp');for(const x of ['rw','nosuid','nodev','noexec'])if(!tmp.includes(x))refuse();
  const root=fs.lstatSync('/review'),ledger=fs.lstatSync('/runtime-proof');
  for(const [p,s,uid,gid,mode]of [['/review',root,0,0,0o555],['/runtime-proof',ledger,1000,1000,0o700]])if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||s.gid!==gid||(s.mode&0o7777)!==mode||fs.realpathSync(p)!==p)refuse();
  if(root.dev===ledger.dev&&root.ino===ledger.ino||JSON.stringify(fs.readdirSync('/review').sort())!==JSON.stringify(Object.keys(pins).sort()))refuse();
  for(const [n,h]of Object.entries(pins)){const f='/review/'+n,s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||s.nlink!==1||(s.mode&0o7777)!==0o444||s.size<1||s.size>20000||crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')!==h)refuse();}
  const names=fs.readdirSync('/runtime-proof');
  if(expected.mode==='execute'){if(names.length)refuse();}
  else{if(JSON.stringify(names)!==JSON.stringify([expected.intent.operationId]))refuse();const h=require('/review/journal.cjs').createJournal('/runtime-proof').readDurable(expected.intent.operationId);if(JSON.stringify(h.intent)!==JSON.stringify(expected.intent))refuse();}
  if(publicOnly){
   if(process.env.PG_ADMIN_PASSWORD!==undefined||process.env.READ_SERVICE_SCRAM!==undefined||process.env.READ_ACTIVATION_RUNTIME_OPT_IN!==undefined)refuse();
   const proof={schema:'crm-manager-read-manual-disable-postcondition-v1',planSha256:expected.planSha256,mode:expected.mode,sourcePinsSha256:expected.sourcePinsSha256,nineSourcesPinned:true,originalSourceReadOnly:true,originalSourceRootOwned:true,ledgerPrivateOwned:true,ledgerPhase:expected.mode==='execute'?'empty':'original_disable_intent_held',uid1000:true,rootReadOnly:true,capabilitiesEmpty:true,noNewPrivileges:true,privateEnvironmentAbsent:true,postgresConnected:false,runtimeExecuted:false};
   const server=require('node:http').createServer({maxHeaderSize:4096},(req,res)=>{const ok=req.method==='GET'&&req.url==='/status'&&req.headers.host===expected.host;res.writeHead(ok?200:404,{'content-type':'application/json','cache-control':'no-store','connection':'close'});res.end(ok?JSON.stringify(proof):'{"schema":"crm-manager-read-status-refused-v1"}');});
   server.maxConnections=8;server.requestTimeout=3000;server.headersTimeout=3000;server.keepAliveTimeout=1000;server.on('error',()=>{process.exitCode=1;server.close();});server.listen(8099,'0.0.0.0');return;
  }
  const flags={READ_ACTIVATION_RUNTIME_OPT_IN:'1',READ_ACTIVATION_MODE:expected.mode,READ_ACTIVATION_APPROVED_ACTION:expected.mode==='execute'?'disable':'readonly-reconcile',READ_ACTIVATION_ACTION:'disable',READ_ACTIVATION_OPERATION_ID:expected.intent.operationId,READ_CREDENTIAL_INTENT_ID:expected.intent.credentialIntentId,READ_ACTIVATION_FROM_PHASE:'staged'};
  if(Object.entries(flags).some(([k,v])=>process.env[k]!==v)||process.env.READ_SERVICE_SCRAM!==undefined||typeof process.env.PG_ADMIN_PASSWORD!=='string'||!process.env.PG_ADMIN_PASSWORD)refuse();
  require('/review/supervisor.cjs').startCli(process.env); // frozen runtime, not Stage driver
 }catch{delete process.env.PG_ADMIN_PASSWORD;delete process.env.READ_SERVICE_SCRAM;process.stderr.write('MANUAL_READ_DISABLE_LOADER_REFUSED\n');process.exitCode=1;}
}
function buildPlan(scope,mode='execute'){
 const s=validateScope(scope);if(!['execute','reconcile'].includes(mode))fail();const d=s.reservedDisable,target={projectName:d.projectName,serviceName:d.serviceName},source={type:'volume',source:'source',target:'/review',read_only:true,volume:{nocopy:true}},ledger={type:'volume',source:'ledger',target:'/runtime-proof',volume:{nocopy:true}},labels={'com.shrigma.read-manual-purpose':'disable-inactive-stage-only','com.shrigma.read-manual-operation':d.intent.operationId};
 const flags={...s.flags,READ_ACTIVATION_MODE:mode,READ_ACTIVATION_APPROVED_ACTION:mode==='execute'?'disable':'readonly-reconcile'};
 if(flags.READ_ACTIVATION_ACTION!=='disable'||flags.READ_ACTIVATION_OPERATION_ID!==d.intent.operationId||flags.READ_CREDENTIAL_INTENT_ID!==d.intent.credentialIntentId||flags.READ_ACTIVATION_FROM_PHASE!=='staged'||flags.READ_ACTIVATION_RUNTIME_OPT_IN!=='1')fail();
 const planSha256=hash(JSON.stringify({scope:s,mode})),expected={planSha256,mode,intent:d.intent,host:d.host,sourcePinsSha256:hash(JSON.stringify(PINS))},inline=publicOnly=>"'use strict';("+loaderRuntime.toString()+')('+JSON.stringify(expected)+','+JSON.stringify(PINS)+','+JSON.stringify(publicOnly)+');';
 const initializer="'use strict';("+initializerRuntime.toString()+')();';
 const init={image:IMAGE,user:'0:0',read_only:true,cap_drop:['ALL'],cap_add:['CHOWN'],security_opt:['no-new-privileges:true'],network_mode:'none',healthcheck:{disable:true},restart:'no',cpus:0.1,mem_limit:67108864,memswap_limit:67108864,pids_limit:16,environment:{},entrypoint:['node'],command:['--max-old-space-size=16','-e',initializer],volumes:[ledger],labels};
 const gateway={image:IMAGE,user:'1000:1000',read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],init:true,restart:'no',cpus:0.35,mem_limit:335544320,memswap_limit:335544320,pids_limit:64,environment:{NODE_PATH:'/app/node_modules'},env_file:['.env'],entrypoint:['timeout','-s','KILL','600'],command:['node','--max-old-space-size=96','-e',inline(false)],volumes:[source,ledger],tmpfs:['/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777'],networks:{easypanel:{aliases:[d.projectName+'_'+d.serviceName+'-gateway',d.projectName+'_'+d.serviceName+'_gateway']}},healthcheck:{test:['CMD','node','/review/health.cjs'],interval:'5s',timeout:'2s',retries:2},labels,deploy:{replicas:1,restart_policy:{condition:'none'},resources:{limits:{cpus:'0.35',memory:'320m',pids:64}}}};
 if(gateway.networks.easypanel.aliases.some(a=>Buffer.byteLength(a)>63))fail();
 const volumes={source:{external:true,name:d.sourceVolume},ledger:{external:true,name:d.ledgerVolume}},networks={easypanel:{external:true,name:'easypanel'}},privateExecution={services:{gateway},volumes,networks},publicGateway=clone(gateway);publicGateway.command=['node','--max-old-space-size=96','-e',inline(true)];delete publicGateway.env_file;publicGateway.healthcheck={disable:true};
 const publicPreflight={services:{gateway:publicGateway},volumes,networks},bootstrap={services:{'init-ledger':init},volumes:{ledger:{name:d.ledgerVolume,labels}}};
 if(mode==='reconcile')delete bootstrap.services['init-ledger']; // existing ledger; NEVER initialize
 const step=(procedure,input,executor)=>({procedure,input,executor}),publicContent=JSON.stringify(publicPreflight),privateContent=JSON.stringify(privateExecution);
 const result={schema:'crm-manager-read-manual-disable-plan-v1',mode,planSha256,approved:false,approvals:{sqlDisable:false,nativeEffects:false,originalStageVerified:false},target,intent:d.intent,image:IMAGE,pins:PINS,host:d.host,domainId:d.domainId,sourceVolume:d.sourceVolume,originalLedgerVolume:s.original.ledgerVolume,ledgerVolume:d.ledgerVolume,flags,expected,bootstrap,publicPreflight,privateExecution,publicPreflightContentSha256:hash(publicContent),privateExecutionContentSha256:hash(privateContent),initializer,loaderPublic:inline(true),loaderPrivate:inline(false),steps:{
  createBootstrap:step('createComposeService',{...target,createDotEnv:true,env:'',domains:[],source:{type:'inline',content:JSON.stringify(bootstrap)}},'execute_mutation'),
  inspect:step('inspectComposeService',target,'execute_query'),inspectRunning:step('getDockerContainers',{service:target.projectName+'_'+target.serviceName},'execute_query'),inspectDomains:step('listDomains',target,'execute_query'),inspectGlobalDomains:step('listDomains',{},'execute_query'),
  updatePublicSource:step('updateComposeSourceInline',{...target,content:publicContent},'execute_destructive'),
  createNewDomain:step('createDomain',{id:d.domainId,certificateResolver:'',host:d.host,https:true,path:'/',wildcard:false,middlewares:[],destinationType:'service',serviceDestination:{...target,composeService:'gateway',protocol:'http',port:8099,path:'/'}},'execute_mutation'),
  deployPublic:step('deployComposeService',{...target,forceRebuild:false},'execute_destructive'),stopPublicBeforePrivate:step('stopComposeService',target,'execute_destructive'),stopCleanup:step('stopComposeService',target,'execute_destructive'),
  updatePrivateSource:step('updateComposeSourceInline',{...target,content:privateContent},'execute_destructive'),deployPrivateOnce:step('deployComposeService',{...target,forceRebuild:false},'execute_destructive'),
  clearEnvironment:step('updateComposeEnv',{...target,createDotEnv:true,env:''},'execute_destructive'),deleteOwnDomain:step('deleteDomain',{id:d.domainId},'execute_destructive')},limits:{peakCpu:0.45,peakMemoryMiB:384,sourceNeverWritten:true,originalStageLedgerNeverMountedForDisable:true,sharedNetworkIsFullIsolation:false,transactionBudgetIsHardWall:false},retry:false};
 if(mode==='reconcile'){
  delete result.steps.createBootstrap;
  result.steps.stopPriorBeforeReconcile=step('stopComposeService',target,'execute_destructive');
  result.steps.clearPriorEnvironment=step('updateComposeEnv',{...target,createDotEnv:true,env:''},'execute_destructive');
  result.steps.deletePriorDomain=step('deleteDomain',{id:d.domainId},'execute_destructive');
 }
 freeze(result);plans.add(result);return result;
}
function admitPlan(plan){if(!plans.has(plan))fail();return plan;}
function publicProjection(plan){admitPlan(plan);return freeze({schema:'crm-manager-read-manual-disable-postcondition-v1',planSha256:plan.planSha256,mode:plan.mode,sourcePinsSha256:plan.expected.sourcePinsSha256,nineSourcesPinned:true,originalSourceReadOnly:true,originalSourceRootOwned:true,ledgerPrivateOwned:true,ledgerPhase:plan.mode==='execute'?'empty':'original_disable_intent_held',uid1000:true,rootReadOnly:true,capabilitiesEmpty:true,noNewPrivileges:true,privateEnvironmentAbsent:true,postgresConnected:false,runtimeExecuted:false});}
function acceptPublic(raw,plan){const expected=publicProjection(plan);if(typeof raw!=='string'||Buffer.byteLength(raw)>2048)fail();let v;try{v=JSON.parse(raw);}catch{fail();}exact(v,Object.keys(expected));for(const k of Object.keys(expected))if(v[k]!==expected[k])fail();return freeze(v);}
function acceptStatus(raw){if(typeof raw!=='string'||Buffer.byteLength(raw)>2048)fail();let v;try{v=JSON.parse(raw);}catch{fail();}exact(v,['schema','action','state','childExitConfirmed','proofBarrierConfirmed','proof']);if(v.schema!=='crm-manager-read-supervisor-v1'||v.action!=='disable'||!['pending','verified','outcome_unknown','proof_refused'].includes(v.state)||typeof v.childExitConfirmed!=='boolean'||typeof v.proofBarrierConfirmed!=='boolean')fail();if(v.state==='verified'){if(!v.childExitConfirmed||!v.proofBarrierConfirmed)fail();v.proof=require('./runtime/read-proof.cjs').acceptProof(JSON.stringify(v.proof),'disable');}else if(v.childExitConfirmed||v.proofBarrierConfirmed||v.proof!==null)fail();return freeze(v);}
function privateEnvInput({plan,approvals,adminPassword}){admitPlan(plan);exact(approvals,['sqlDisable','nativeEffects','originalStageVerified']);if(Object.values(approvals).some(x=>x!==true)||typeof adminPassword!=='string'||!adminPassword||adminPassword.length>1024||/[\r\n\0\\']/.test(adminPassword))fail();const input={...plan.target,createDotEnv:true};Object.defineProperty(input,'env',{value:Object.entries(plan.flags).map(([k,v])=>k+'='+v).join('\n')+"\nPG_ADMIN_PASSWORD='"+adminPassword+"'\n",enumerable:false});const dto={procedure:'updateComposeEnv',executor:'execute_destructive',planSha256:plan.planSha256};Object.defineProperty(dto,'input',{value:Object.freeze(input),enumerable:false});return Object.freeze(dto);}
module.exports=Object.freeze({buildPlan,admitPlan,privateEnvInput,acceptStatus,acceptPublic,publicProjection,initializerRuntime,loaderRuntime,PINS,IMAGE});
if(require.main===module){process.stdout.write('{"state":"OFF","nativeEffectsSent":0}\n');}
