'use strict';
// Import is inert: no environment, file, timer, database, logger or server access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PINS=Object.freeze({installer:'33a412f3d8b8fc4293010e2aec95dc5a8ba3f1296f86000d50e79cfb87ec0bd9',rollback:'dace1eab926186c4aa277d89c92813ce0ac06cc5fd971c0569f2cd9ef0734d4f',profile:'a20c51e10dfff6c781b94158ed392a38c1ec64d30966281ecd2ede72e52f62e9',objects:'00ebc821445ec653bd96b01fa1b74a82207551a1cebd1498e7ddd512bc41a370',empty:'a55f9a2fe863f5797383915b0239f3aab5e3733dcdc8ee222b7ff3f4a9fdb697'});
const PROFILE='4f5b8bdec729d2924c043da6bd3c0f8f2ce01a82af614187cefa1322ecef11c9',SCHEMA='crm-manager-install-public-proof-v1';
const COUNT_KEYS=['tables','relations','indexes','functions','types','roles','no_login_roles','restricted_roles','membership_edges','passworded_roles'];
const INSTALLED=Object.freeze({tables:4,relations:13,indexes:2,functions:7,types:8,roles:2,no_login_roles:2,restricted_roles:2,membership_edges:0,passworded_roles:0});
const ABSENT=Object.freeze(Object.fromEntries(COUNT_KEYS.map(k=>[k,0])));
const PHASES=['prepared','context_verified','sql_dispatched','sql_commit_acknowledged','verified_installed','verified_existing','verified_absent','preflight_refused','refused_rolled_back','verification_failed','outcome_unknown','setup_refused'];
const FILES=['01-prepared.json','02-context.json','03-sql-intent.json','04-sql-ack.json','proof.json'];
const READ_BEGIN="BEGIN;SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;SET LOCAL search_path=pg_catalog;SET LOCAL statement_timeout='4s';SET LOCAL lock_timeout='500ms';SET LOCAL idle_in_transaction_session_timeout='5s';";
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function fail(){throw Error('MANAGER_INSTALL_REVIEW_REFUSED');}
function closed(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail();}
function counts(value){closed(value,COUNT_KEYS);for(const v of Object.values(value))if(!Number.isSafeInteger(v)||v<0||v>100000)fail();return Object.freeze({...value});}
function equalCounts(a,b){return COUNT_KEYS.every(k=>a[k]===b[k]);}
function parsePublicProofInternal(value){
 let object;try{object=typeof value==='string'?JSON.parse(value):value;}catch{fail();}
 closed(object,['schema','action','phase','recordedAt','sourcePins','contextVerified','mutationAttempted','commitAcknowledged','counts','profileSha256','emptyTables','durable']);
 if(object.schema!==SCHEMA||!['install','verify','rollback'].includes(object.action)||!PHASES.includes(object.phase)||typeof object.recordedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(object.recordedAt))fail();
 closed(object.sourcePins,Object.keys(PINS));if(Object.keys(PINS).some(k=>object.sourcePins[k]!==PINS[k]))fail();
 for(const k of ['contextVerified','mutationAttempted','commitAcknowledged','durable'])if(typeof object[k]!=='boolean')fail();
 if(object.counts!==null)counts(object.counts);
 if(![null,PROFILE].includes(object.profileSha256)||![null,4].includes(object.emptyTables))fail();
 if(object.commitAcknowledged&&!object.mutationAttempted||object.action==='verify'&&(object.mutationAttempted||object.commitAcknowledged))fail();
 if(object.phase==='prepared'&&(object.contextVerified||object.mutationAttempted||object.commitAcknowledged)||object.phase==='context_verified'&&(!object.contextVerified||object.mutationAttempted||object.commitAcknowledged))fail();
 if(object.phase==='sql_dispatched'&&(!object.contextVerified||!object.mutationAttempted||object.commitAcknowledged)||object.phase==='sql_commit_acknowledged'&&(!object.contextVerified||!object.mutationAttempted||!object.commitAcknowledged))fail();
 if(['verified_installed','verified_existing'].includes(object.phase)&&(!object.contextVerified||object.profileSha256!==PROFILE||object.emptyTables!==4||!equalCounts(object.counts||{},INSTALLED)))fail();
 if(object.phase==='verified_absent'&&(!object.contextVerified||!equalCounts(object.counts||{},ABSENT)||object.action==='install'||object.action==='rollback'&&(!object.mutationAttempted||!object.commitAcknowledged)))fail();
 if(object.phase==='verified_installed'&&(object.action!=='install'||!object.mutationAttempted||!object.commitAcknowledged))fail();
 if(object.phase==='verified_existing'&&(object.action!=='verify'||object.mutationAttempted||object.commitAcknowledged))fail();
 if(object.phase==='refused_rolled_back'&&(!object.mutationAttempted||object.commitAcknowledged))fail();
 return Object.freeze({...object,sourcePins:PINS,counts:object.counts===null?null:counts(object.counts)});
}
function parsePublicProof(value){try{return parsePublicProofInternal(value);}catch{fail();}}
function readSources(){const result={};for(const [key,pin]of Object.entries(PINS)){const raw=fs.readFileSync(path.join(__dirname,'sql',key+'.sql'));if(sha(raw)!==pin)fail();result[key]=raw.toString('utf8');}return Object.freeze(result);}
function statDirectory(directory,f){const stat=f.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==1000||(stat.mode&0o7777)!==0o700)fail();}
function openStore(directory,f){
 statDirectory(directory,f);if(f.readdirSync(directory).length!==0)fail();
 const dir=f.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 const stat=f.fstatSync(dir);if(!stat.isDirectory()||stat.uid!==1000||(stat.mode&0o7777)!==0o700){f.closeSync(dir);fail();}
 return{write(name,proof){if(!FILES.includes(name))fail();const bytes=Buffer.from(JSON.stringify(parsePublicProof(proof)));if(bytes.length>16384)fail();let file;
  try{file=f.openSync(path.join(directory,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);const st=f.fstatSync(file);if(!st.isFile()||st.uid!==1000||(st.mode&0o7777)!==0o600||st.nlink!==1)fail();f.writeFileSync(file,bytes);f.fsyncSync(file);f.closeSync(file);file=undefined;f.fsyncSync(dir);}finally{if(file!==undefined)f.closeSync(file);}},close(){f.closeSync(dir);}};
}
function readPublicProof(directory,{fsImpl=fs}={}){
 let dir;
 try{
  statDirectory(directory,fsImpl);dir=fsImpl.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);const dirBefore=fsImpl.fstatSync(dir);
  const names=fsImpl.readdirSync(directory).sort();if(names.some(n=>!FILES.includes(n)))fail();let last=null,uncertain=false;
  const validFiles=new Set(),highest={context:false,mutation:false,ack:false};
  const phaseByFile={'01-prepared.json':'prepared','02-context.json':'context_verified','03-sql-intent.json':'sql_dispatched','04-sql-ack.json':'sql_commit_acknowledged'};
  function bytes(fd,size){const out=Buffer.alloc(16385),n=fsImpl.readSync(fd,out,0,out.length,0);if(n!==size||n>16384)fail();return out.subarray(0,n);}
  for(const name of FILES)if(names.includes(name)){
   let fd;try{
    const file=path.join(directory,name);fd=fsImpl.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const before=fsImpl.fstatSync(fd);
    if(!before.isFile()||before.uid!==1000||before.nlink!==1||(before.mode&0o7777)!==0o600||before.size>16384)fail();
    const raw=bytes(fd,before.size);fsImpl.fsyncSync(fd);const after=fsImpl.fstatSync(fd),named=fsImpl.lstatSync(file);
    if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k]!==after[k])||named.dev!==after.dev||named.ino!==after.ino||!bytes(fd,after.size).equals(raw))fail();
    let parsed;try{parsed=parsePublicProof(raw.toString('utf8'));if(phaseByFile[name]&&parsed.phase!==phaseByFile[name])fail();if(last&&parsed.action!==last.action)fail();}
    catch{if(name==='01-prepared.json'||name==='02-context.json')fail();uncertain=true;continue;}
    if(highest.context&&!parsed.contextVerified||highest.mutation&&!parsed.mutationAttempted||highest.ack&&!parsed.commitAcknowledged)uncertain=true;
    highest.context=highest.context||parsed.contextVerified;highest.mutation=highest.mutation||parsed.mutationAttempted;highest.ack=highest.ack||parsed.commitAcknowledged;
    validFiles.add(name);last=parsed;
   }finally{if(fd!==undefined)fsImpl.closeSync(fd);}
  }
  fsImpl.fsyncSync(dir);const dirAfter=fsImpl.fstatSync(dir),namedDir=fsImpl.lstatSync(directory);
  if(dirBefore.dev!==dirAfter.dev||dirBefore.ino!==dirAfter.ino||namedDir.dev!==dirAfter.dev||namedDir.ino!==dirAfter.ino||JSON.stringify(fsImpl.readdirSync(directory).sort())!==JSON.stringify(names))fail();
  if(!last)fail();
  // A terminal record cannot erase an earlier context, possible mutation or
  // COMMIT acknowledgment. Prefix records themselves must be valid and ordered.
  const possible=names.includes('03-sql-intent.json')||names.includes('04-sql-ack.json')||highest.mutation;
  if(last.action==='verify'&&possible)fail();
  if(validFiles.has('03-sql-intent.json')&&(!validFiles.has('01-prepared.json')||!validFiles.has('02-context.json'))||names.includes('04-sql-ack.json')&&!validFiles.has('03-sql-intent.json'))uncertain=true;
  if(last.phase.startsWith('verified_')&&(!validFiles.has('01-prepared.json')||!validFiles.has('02-context.json')))uncertain=true;
  if(last.mutationAttempted&&(!validFiles.has('03-sql-intent.json')||last.commitAcknowledged&&!validFiles.has('04-sql-ack.json')))uncertain=true;
  if(last.phase==='refused_rolled_back'&&names.includes('04-sql-ack.json'))uncertain=true;
  if(uncertain||!validFiles.has('proof.json'))last=parsePublicProof({...last,phase:possible?'outcome_unknown':'preflight_refused',contextVerified:highest.context,mutationAttempted:possible,commitAcknowledged:highest.ack,durable:true});
  return parsePublicProof({...last,contextVerified:highest.context,mutationAttempted:possible,commitAcknowledged:highest.ack,durable:true});
 }catch{fail();}finally{if(dir!==undefined)try{fsImpl.closeSync(dir);}catch{}}
}
function connectionConfig(password){return {host:'comunicacao_postgres',port:5432,database:'listmonk',user:'postgres',password,ssl:false,application_name:'shrigma-manager-install-review-v1',options:'-c search_path=pg_catalog -c statement_timeout=4000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=5000 -c transaction_timeout=500',connectionTimeoutMillis:2000,query_timeout:5000,statement_timeout:4000,lock_timeout:500,idle_in_transaction_session_timeout:5000};}
function requireConnection(client,expected){const p=client.connectionParameters;if(!p)fail();for(const k of ['host','port','database','user','password','ssl','application_name','options'])if(p[k]!==expected[k])fail();}
function flattenRows(result){return(Array.isArray(result)?result:[result]).flatMap(v=>v?.rows||[]);}
function oneRow(result){const rows=flattenRows(result);if(rows.length!==1)fail();return rows[0];}
function ack(result,command){const a=Array.isArray(result)?result:[result];return a.length>0&&a[a.length-1]?.command===command;}
function createInstallRunner(config,adapters={}){
 closed(config,['action','password','proofDirectory','consumersStopped']);
 if(!['install','verify','rollback'].includes(config.action)||typeof config.password!=='string'||!config.password||Buffer.byteLength(config.password)>4096||config.password.includes('\0')||typeof config.proofDirectory!=='string'||!path.isAbsolute(config.proofDirectory)||typeof config.consumersStopped!=='boolean'||config.consumersStopped!==(config.action==='rollback'))fail();
 const allowed=['Client','fsImpl','getuid','now','setTimeoutImpl','clearTimeoutImpl'];if(!adapters||Object.keys(adapters).some(k=>!allowed.includes(k))||typeof adapters.Client!=='function')fail();
 const f=adapters.fsImpl||fs,getuid=adapters.getuid||(()=>process.getuid()),now=adapters.now||Date.now,setTimer=adapters.setTimeoutImpl||setTimeout,clearTimer=adapters.clearTimeoutImpl||clearTimeout;
 let password=config.password,started;
 const action=config.action,directory=config.proofDirectory;
 async function execute(){
  let client=null,store=null,deadline,timer,closedClient=false,phase='setup_refused',contextVerified=false,mutationAttempted=false,commitAcknowledged=false,observed=null,profileSha256=null,emptyTables=null;
  const proof=(state,durable)=>parsePublicProof({schema:SCHEMA,action,phase:state,recordedAt:new Date(now()).toISOString(),sourcePins:PINS,contextVerified,mutationAttempted,commitAcknowledged,counts:observed,profileSha256,emptyTables,durable});
  function cut(){if(client&&!closedClient){closedClient=true;try{client.connection?.stream?.destroy();}catch{}}}
  async function bounded(promise){return Promise.race([promise,deadline]);}
  async function read(sql){const result=await bounded(client.query(sql));if(!ack(result,'ROLLBACK'))fail();return oneRow(result);}
  let sources;
  async function verifyInstalled(){
   const result=await bounded(client.query(READ_BEGIN+sources.empty+sources.profile+'ROLLBACK;'));
   if(!ack(result,'ROLLBACK'))fail();const rows=flattenRows(result);if(rows.length!==2)fail();
   closed(rows[0],['issuer_empty','subject_empty','operation_empty','generation_empty']);if(Object.values(rows[0]).some(v=>v!==true))fail();
   closed(rows[1],['profile_sha256']);if(rows[1].profile_sha256!==PROFILE)fail();emptyTables=4;profileSha256=PROFILE;
  }
  async function observe(){
   const obj=await read(READ_BEGIN+sources.objects+'ROLLBACK;');closed(obj,['context_verified',...COUNT_KEYS]);if(obj.context_verified!==true)fail();contextVerified=true;observed=counts(Object.fromEntries(COUNT_KEYS.map(k=>[k,obj[k]])));
   if(equalCounts(observed,ABSENT))return'absent';if(!equalCounts(observed,INSTALLED))fail();await verifyInstalled();return'installed';
  }
  try{
   if(getuid()!==1000)fail();sources=readSources();store=openStore(directory,f);
   store.write('01-prepared.json',proof('prepared',true));
   deadline=new Promise((_,reject)=>{timer=setTimer(()=>{cut();reject(Error('MANAGER_INSTALL_DEADLINE'));},30000);});
   const params=connectionConfig(password);client=new adapters.Client(params);requireConnection(client,params);password=undefined;
   client.on?.('error',()=>{});phase='preflight_refused';await bounded(client.connect());
   // PostgreSQL 17 terminates this session when any transaction spans 500 ms.
   // lock_timeout alone limits acquisition waits, never lock retention. Confirm
   // the server accepted the session-only budget before catalog reads or DDL.
   const limits=oneRow(await bounded(client.query("SELECT current_setting('transaction_timeout') AS transaction_timeout")));
   closed(limits,['transaction_timeout']);if(limits.transaction_timeout!=='500ms')fail();
   const before=await observe();phase='preflight_refused';
   if(action==='install'&&before!=='absent'||action==='rollback'&&before!=='installed')fail();
   store.write('02-context.json',proof('context_verified',true));
   if(action==='verify')phase=before==='installed'?'verified_existing':'verified_absent';
   else{
    // Durable intent MUST precede the only mutating query. No retry exists.
    mutationAttempted=true;phase='outcome_unknown';store.write('03-sql-intent.json',proof('sql_dispatched',true));
    let result;
    try{result=await bounded(client.query(sources[action==='install'?'installer':'rollback']));}
    catch(error){
     const known=error?.code==='P0001'&&['MANAGER_INSTALL_REFUSED','CRM_MANAGER_ROLE_INSTALL_REFUSED','MANAGER_EMPTY_ROLLBACK_REFUSED'].includes(error?.message);
     if(known){const cleanup=await bounded(client.query('ROLLBACK'));if(ack(cleanup,'ROLLBACK'))phase='refused_rolled_back';}
     throw Error('MANAGER_INSTALL_SQL_NOT_CONFIRMED');
    }
    if(!ack(result,'COMMIT'))fail();commitAcknowledged=true;store.write('04-sql-ack.json',proof('sql_commit_acknowledged',true));
    profileSha256=null;emptyTables=null;
    const after=await observe();if(action==='install'&&after!=='installed'||action==='rollback'&&after!=='absent')fail();phase=action==='install'?'verified_installed':'verified_absent';
   }
   const result=proof(phase,true);store.write('proof.json',result);return result;
  }catch{
   if(mutationAttempted&&phase!=='refused_rolled_back')phase='outcome_unknown';
   else if(phase==='setup_refused'&&contextVerified)phase='preflight_refused';
   let result=proof(phase,false);try{if(store){result=proof(phase,true);store.write('proof.json',result);}}catch{result=proof(phase,false);}return result;
  }finally{
   password=undefined;if(timer!==undefined)clearTimer(timer);cut();
   // Destroy first: end() must never keep a failed query/session alive. Ignore
   // error data and consume async rejections; do not start rollback or DROP.
   try{const ending=client?.end?.();ending?.catch?.(()=>{});}catch{}
   try{if(client?.connectionParameters)client.connectionParameters.password='';}catch{}
   try{store?.close();}catch{}
  }
 }
 return Object.freeze({run(){if(!started)started=execute();return started;}});
}
module.exports={createInstallRunner,parsePublicProof,readPublicProof,PINS,PROFILE};
if(require.main===module){
 (async()=>{
  try{
   const [action,confirmation,...extra]=process.argv.slice(2);if(action==='proof'){if(confirmation!==undefined||extra.length||process.getuid()!==1000)fail();const result=readPublicProof('/manager-install-proof');process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=['verified_installed','verified_existing','verified_absent'].includes(result.phase)?0:1;return;}if(extra.length||confirmation!==(action==='rollback'?'--consumers-stopped':undefined))fail();
   if(Object.keys(process.env).some(k=>k.startsWith('PG')&&k!=='PGPASSWORD'||k==='DATABASE_URL'))fail();
   let password=process.env.PGPASSWORD;delete process.env.PGPASSWORD;
   if(process.versions.node.split('.')[0]!=='22')fail();const pg=require('pg');if(require('pg/package.json').version!=='8.13.1')fail();
   const runner=createInstallRunner({action,password,proofDirectory:'/manager-install-proof',consumersStopped:action==='rollback'},{Client:pg.Client});password=undefined;const result=await runner.run();
   process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=['verified_installed','verified_existing','verified_absent'].includes(result.phase)&&result.durable?0:1;
  }catch{process.stdout.write('{"schema":"crm-manager-install-public-proof-v1","phase":"setup_refused"}\n');process.exitCode=1;}
 })();
}
