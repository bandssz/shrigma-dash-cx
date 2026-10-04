'use strict';
// Inert, OFF by default. Only explicitly constructed runners may perform I/O.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PROFILE='07ebbf98472f2d693a35e8bb7151e966692e2b90af921c64807041b44c067040';
const SOURCE_MANIFEST_SHA256='fb85a2345bfe31bfcf53b921df46a601be24e4d80188974890585dafbf16c5f5';
const READ_CORE='4f5b8bdec729d2924c043da6bd3c0f8f2ce01a82af614187cefa1322ecef11c9';
const SCHEMA='crm-manager-writer-production-proof-v1';
const KEYS=['tables','relations','indexes','functions','types','roles','no_login_roles','restricted_roles','membership_edges','passworded_roles'];
const INSTALLED=Object.freeze({tables:4,relations:13,indexes:2,functions:7,types:8,roles:2,no_login_roles:2,restricted_roles:2,membership_edges:0,passworded_roles:0});
const ABSENT=Object.freeze(Object.fromEntries(KEYS.map(k=>[k,0])));
const FILES=['01-prepared.json','02-context.json','03-sql-intent.json','04-sql-ack.json','proof.json'];
const PHASES=['prepared','context_verified','sql_dispatched','sql_commit_acknowledged','verified_installed','verified_absent','verified_existing','reconciled_installed','reconciled_absent','hold','outcome_unknown','refused_rolled_back','preflight_refused','setup_refused'];
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const refuse=()=>{throw Error('WRITER_PRODUCTION_REFUSED');};
const closed=(v,ks)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).length!==ks.length||ks.some(k=>!Object.hasOwn(v,k)))refuse();};
const isUUID=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const eq=(a,b)=>KEYS.every(k=>a[k]===b[k]);
function count(v){closed(v,KEYS);if(Object.values(v).some(n=>!Number.isSafeInteger(n)||n<0||n>100000))refuse();return Object.freeze({...v});}
function backend(v){closed(v,['pid','startMicros']);if(!Number.isSafeInteger(v.pid)||v.pid<1||v.pid>2147483647||typeof v.startMicros!=='string'||!/^\d{15,20}$/.test(v.startMicros))refuse();return Object.freeze({...v});}
function parseProof(v){try{
 if(typeof v==='string')v=JSON.parse(v);
 closed(v,['schema','operationId','action','readPhase','phase','recordedAt','sourcePinsSha256','backend','readCoreSha256','readStateSha256','legacySha256','writerProfileSha256','counts','emptyTables','contextVerified','mutationAttempted','commitAcknowledged','durable']);
 if(v.schema!==SCHEMA||!isUUID(v.operationId)||!['install','rollback','verify','reconcile'].includes(v.action)||!['empty','staged','active'].includes(v.readPhase)||!PHASES.includes(v.phase)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.recordedAt)||!digest(v.sourcePinsSha256))refuse();
 for(const k of ['contextVerified','mutationAttempted','commitAcknowledged','durable'])if(typeof v[k]!=='boolean')refuse();
 if(v.backend!==null)backend(v.backend);
 if(v.readCoreSha256!==null&&v.readCoreSha256!==READ_CORE||v.writerProfileSha256!==null&&v.writerProfileSha256!==PROFILE||v.emptyTables!==null&&v.emptyTables!==4)refuse();
 for(const k of ['readStateSha256','legacySha256'])if(v[k]!==null&&!digest(v[k]))refuse();
 if(v.counts!==null)count(v.counts);
 if(v.contextVerified&&(!v.backend||v.readCoreSha256!==READ_CORE||!v.readStateSha256||!v.legacySha256||!v.counts)||v.mutationAttempted&&!v.contextVerified||v.commitAcknowledged&&!v.mutationAttempted)refuse();
 if(v.phase==='prepared'&&(v.contextVerified||v.mutationAttempted)||v.phase==='context_verified'&&(!v.contextVerified||v.mutationAttempted)||v.phase==='sql_dispatched'&&(!v.mutationAttempted||v.commitAcknowledged)||v.phase==='sql_commit_acknowledged'&&!v.commitAcknowledged)refuse();
 if(['verified_installed','verified_existing','reconciled_installed'].includes(v.phase)&&(!v.contextVerified||!eq(v.counts||{},INSTALLED)||v.writerProfileSha256!==PROFILE||v.emptyTables!==4))refuse();
 if(['verified_absent','reconciled_absent'].includes(v.phase)&&(!v.contextVerified||!eq(v.counts||{},ABSENT)||v.writerProfileSha256!==null||v.emptyTables!==null))refuse();
 if(v.phase==='verified_installed'&&(v.action!=='install'||!v.commitAcknowledged)||v.phase==='verified_absent'&&v.action==='rollback'&&!v.commitAcknowledged)refuse();
 if(v.phase.startsWith('reconciled_')&&v.action!=='reconcile'||v.phase==='refused_rolled_back'&&(!v.mutationAttempted||v.commitAcknowledged))refuse();
 if(['verify','reconcile'].includes(v.action)&&(v.mutationAttempted||v.commitAcknowledged))refuse();
 return Object.freeze({...v,backend:v.backend===null?null:backend(v.backend),counts:v.counts===null?null:count(v.counts)});
 }catch{refuse();}}
function sources(){
 const manifestBytes=fs.readFileSync(path.join(__dirname,'source-pins.json'));if(sha(manifestBytes)!==SOURCE_MANIFEST_SHA256)refuse();const pins=JSON.parse(manifestBytes);
 const expected=['../writer-provision-v1.sql','../writer-empty-rollback-v1.sql','../../crm-manager-read-activation-review/activation.cjs','../../crm-manager-read-activation-review/sources.cjs','../../crm-manager-install-review/runtime/run-install.cjs','../../crm-manager-install-review/runtime/sql/installer.sql','sql/objects.sql','sql/legacy-guard.sql','sql/profile.sql','sql/empty.sql','sql/legacy-profile.sql'];
 closed(pins,expected);const out={};for(const n of expected){if(!digest(pins[n]))refuse();const b=fs.readFileSync(path.join(__dirname,n));if(sha(b)!==pins[n])refuse();out[n]=b.toString('utf8');}
 if(pins['../writer-provision-v1.sql']!=='b78251cc9bb2e28d7a2c6e286363b0e8368e3c65b17a2ae9fd9f997ae5a2160e'||pins['../writer-empty-rollback-v1.sql']!=='a5a138a4f5c0956b2cccd11a38d0c43e0e0c8e6298e3765e880a0b586aca6aeb'||pins['../../crm-manager-read-activation-review/activation.cjs']!=='9a3459983b415661e2665e8c3f6de1ae4fa6aa712ae012ebd3344da09e180a83')refuse();
 const A=require('../../crm-manager-read-activation-review/activation.cjs'),S=require('../../crm-manager-read-activation-review/sources.cjs');A.validateSources(S);
 return Object.freeze({out,A,S,pinsSha256:sha(manifestBytes)});
}
function componentBody(raw){const begin=raw.indexOf('\nBEGIN;');if(begin<0||!raw.endsWith('\nCOMMIT;\n')||/\n(?:BEGIN|COMMIT|ROLLBACK);/g.test(raw.slice(begin+7,-9)))refuse();return raw.slice(begin+8,-9);}
function buildPlan(action,readPhase){
 if(!['install','rollback','verify','reconcile'].includes(action)||!['empty','staged','active'].includes(readPhase))refuse();const s=sources();
 const a=s.A.buildPlan(readPhase==='empty'?'stage':readPhase==='staged'?'activate':'disable',readPhase==='active'?{fromPhase:'active'}:{});
 const begin=a.commands[1].text;
 const locks="DO $writer_lock$ BEGIN IF NOT pg_try_advisory_xact_lock(1609296685,2) THEN RAISE EXCEPTION USING MESSAGE='WRITER_PRODUCTION_REFUSED'; END IF; PERFORM oid FROM pg_authid WHERE rolname IN ('crm_manager_function_owner_v1','crm_manager_provisioner') FOR UPDATE NOWAIT; END $writer_lock$; LOCK TABLE public.crm_dash_chave,public.shrigma_panel_permission_v1 IN SHARE ROW EXCLUSIVE MODE NOWAIT;";
 return Object.freeze({schema:'crm-manager-writer-production-plan-v1',action,readPhase,pinsSha256:s.pinsSha256,budget:a.commands[0],begin:Object.freeze({text:begin}),readOnlyBegin:a.readOnlyBegin,logging:a.commands[2],scope:a.commands[3],readGuard:a.commands[4],locks:Object.freeze({text:locks}),legacyGuard:Object.freeze({text:s.out['sql/legacy-guard.sql']}),readback:Object.freeze({text:s.S.profile+s.S.objects+s.A.STATE_SQL+s.out['sql/legacy-profile.sql']+s.out['sql/objects.sql']}),writerProfile:Object.freeze({text:s.out['sql/empty.sql']+s.out['sql/profile.sql']}),mutating:action==='install'||action==='rollback'?Object.freeze({text:componentBody(s.out[action==='install'?'../writer-provision-v1.sql':'../writer-empty-rollback-v1.sql'])}):null,commit:a.commit,rollback:a.rollback,A:s.A});
}
function directory(f,p){if(f.realpathSync(p)!==p)refuse();const st=f.lstatSync(p);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==1000||(st.mode&0o7777)!==0o700)refuse();}
function store(f,p){directory(f,p);if(f.readdirSync(p).length)refuse();const d=f.openSync(p,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);const ds=f.fstatSync(d);if(!ds.isDirectory()||ds.uid!==1000||(ds.mode&0o7777)!==0o700){f.closeSync(d);refuse();}return{write(n,v){if(!FILES.includes(n))refuse();const b=Buffer.from(JSON.stringify(parseProof(v)));if(b.length>8192)refuse();let fd;try{fd=f.openSync(path.join(p,n),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);const st=f.fstatSync(fd);if(!st.isFile()||st.uid!==1000||st.nlink!==1||(st.mode&0o7777)!==0o600)refuse();f.writeFileSync(fd,b);f.fsyncSync(fd);}finally{if(fd!==undefined)f.closeSync(fd);}f.fsyncSync(d);},close(){f.closeSync(d);}};}
function readProof(p,{fsImpl:f=fs}={}){directory(f,p);const names=f.readdirSync(p).sort();if(names.some(n=>!FILES.includes(n)))refuse();let last=null,highest={contextVerified:false,mutationAttempted:false,commitAcknowledged:false};const seen=new Set();const binding=['operationId','action','readPhase','sourcePinsSha256'];
 for(const n of FILES)if(names.includes(n)){let fd;try{fd=f.openSync(path.join(p,n),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const st=f.fstatSync(fd);if(!st.isFile()||st.uid!==1000||st.nlink!==1||(st.mode&0o7777)!==0o600||st.size>8192)refuse();const b=Buffer.alloc(st.size+1);if(f.readSync(fd,b,0,b.length,0)!==st.size)refuse();const v=parseProof(new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,st.size)));const after=f.fstatSync(fd),named=f.lstatSync(path.join(p,n));if(['ino','dev','size','mtimeMs','ctimeMs'].some(k=>st[k]!==after[k])||named.ino!==st.ino||named.dev!==st.dev)refuse();
 if(last&&binding.some(k=>v[k]!==last[k]))refuse();if(last?.contextVerified&&(JSON.stringify(v.backend)!==JSON.stringify(last.backend)||v.readStateSha256!==last.readStateSha256||v.legacySha256!==last.legacySha256))refuse();
 const expect={'01-prepared.json':'prepared','02-context.json':'context_verified','03-sql-intent.json':'sql_dispatched','04-sql-ack.json':'sql_commit_acknowledged'};if(expect[n]&&v.phase!==expect[n])refuse();for(const k of Object.keys(highest)){if(highest[k]&&!v[k])refuse();highest[k]||=v[k];}seen.add(n);last=v;
 }finally{if(fd!==undefined)f.closeSync(fd);}}
 if(!last||!seen.has('01-prepared.json')||highest.contextVerified&&!seen.has('02-context.json')||highest.mutationAttempted&&!seen.has('03-sql-intent.json')||highest.commitAcknowledged&&!seen.has('04-sql-ack.json')||JSON.stringify(f.readdirSync(p).sort())!==JSON.stringify(names))refuse();
 if(!seen.has('proof.json'))last=parseProof({...last,phase:highest.mutationAttempted?'outcome_unknown':'preflight_refused'});return last;
}
function connectionConfig(password){return{host:'comunicacao_postgres',port:5432,database:'listmonk',user:'postgres',password,ssl:false,application_name:'shrigma-writer-production-review-v1',options:'-c search_path=pg_catalog -c statement_timeout=4000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=5000 -c transaction_timeout=500',connectionTimeoutMillis:2000,query_timeout:5000};}
const rows=v=>(Array.isArray(v)?v:[v]).flatMap(q=>q?.rows||[]);
const one=v=>{const r=rows(v);if(r.length!==1)refuse();return r[0];};
const ack=(v,k)=>(Array.isArray(v)?v:[v]).at(-1)?.command===k;
function createWriterInstallRunner(config={enabled:false},deps={}){
 if(config?.enabled===false){closed(config,['enabled']);return Object.freeze({run:async()=>Object.freeze({schema:SCHEMA,phase:'disabled'})});}
 const reconcile=config?.action==='reconcile';closed(config,['enabled','action','readPhase','operationId','password','proofDirectory',...(reconcile?['originalProofDirectory']:[])]);
 if(config.enabled!==true||!isUUID(config.operationId)||!['install','verify','rollback','reconcile'].includes(config.action)||!['empty','staged','active'].includes(config.readPhase)||typeof config.password!=='string'||!config.password||Buffer.byteLength(config.password)>4096||config.password.includes('\0')||!path.isAbsolute(config.proofDirectory)||reconcile&&(!path.isAbsolute(config.originalProofDirectory)||config.originalProofDirectory===config.proofDirectory))refuse();
 if(!deps||Object.keys(deps).some(k=>!['Client','fsImpl','getuid','now','setTimeoutImpl','clearTimeoutImpl'].includes(k))||typeof deps.Client!=='function')refuse();
 const f=deps.fsImpl||fs,getuid=deps.getuid||(()=>process.getuid()),now=deps.now||Date.now,setTimer=deps.setTimeoutImpl||setTimeout,clearTimer=deps.clearTimeoutImpl||clearTimeout;let started,password=config.password;
 async function execute(){let client,log,timer,deadline,expired=false,inTX=false,contextVerified=false,mutationAttempted=false,commitAcknowledged=false,commitDispatched=false,tuple=null,readHash=null,legacyHash=null,observed=null,writerProfile=null,emptyTables=null,phase='setup_refused',plan,original;
 const proof=(p,d)=>parseProof({schema:SCHEMA,operationId:config.operationId,action:config.action,readPhase:config.readPhase,phase:p,recordedAt:new Date(now()).toISOString(),sourcePinsSha256:plan?.pinsSha256||'0'.repeat(64),backend:tuple,readCoreSha256:contextVerified?READ_CORE:null,readStateSha256:readHash,legacySha256:legacyHash,writerProfileSha256:writerProfile,counts:observed,emptyTables,contextVerified,mutationAttempted,commitAcknowledged,durable:d});
 const cut=()=>{try{client?.connection?.stream?.destroy();}catch{}};
 const query=async q=>{if(expired)refuse();return Promise.race([client.query(q),deadline]);};
 async function snapshot(){const r=rows(await query(plan.readback));if(r.length!==5)refuse();closed(r[0],['profile_sha256']);closed(r[2],['state']);closed(r[3],['legacy_sha256']);plan.A.admitSnapshot({profileSha256:r[0].profile_sha256,objects:r[1],state:r[2].state},config.readPhase);if(!digest(r[3].legacy_sha256))refuse();closed(r[4],['context_verified',...KEYS]);if(r[4].context_verified!==true)refuse();const c=count(Object.fromEntries(KEYS.map(k=>[k,r[4][k]])));let profile=null,empty=null;if(eq(c,INSTALLED)){const p=rows(await query(plan.writerProfile));if(p.length!==2)refuse();closed(p[0],['issuer_empty','subject_empty','operation_empty','generation_empty']);closed(p[1],['profile_sha256']);if(Object.values(p[0]).some(v=>v!==true)||p[1].profile_sha256!==PROFILE)refuse();profile=PROFILE;empty=4;}else if(!eq(c,ABSENT))refuse();return{stateSha256:sha(JSON.stringify(r[2].state)),legacySha256:r[3].legacy_sha256,counts:c,profile,empty,kind:profile?'installed':'absent'};}
 async function observe(){await query(plan.readOnlyBegin);inTX=true;await query(plan.logging);await query(plan.scope);await query(plan.legacyGuard);const s=await snapshot();const end=await query(plan.rollback);if(!ack(end,'ROLLBACK'))refuse();inTX=false;return s;}
 try{
 if(getuid()!==1000)refuse();plan=buildPlan(config.action,config.readPhase);
 if(reconcile){original=readProof(config.originalProofDirectory,{fsImpl:f});if(original.operationId!==config.operationId||!['install','rollback'].includes(original.action)||!original.mutationAttempted||original.sourcePinsSha256!==plan.pinsSha256||original.readPhase!==config.readPhase)refuse();}
 log=store(f,config.proofDirectory);log.write('01-prepared.json',proof('prepared',true));
 deadline=new Promise((_,reject)=>{timer=setTimer(()=>{expired=true;cut();reject(Error('WRITER_PRODUCTION_DEADLINE'));},30000);});
 const params=connectionConfig(password);client=new deps.Client(params);const p=client.connectionParameters;if(!p||Object.keys(params).filter(k=>!['connectionTimeoutMillis','query_timeout'].includes(k)).some(k=>p[k]!==params[k]))refuse();password=undefined;client.on?.('error',()=>{});phase='preflight_refused';await Promise.race([client.connect(),deadline]);
 // Budget is set and verified BEFORE the first BEGIN, including reconciliation.
 await query(plan.budget);const b=one(await query("SELECT current_setting('transaction_timeout') AS transaction_timeout"));closed(b,['transaction_timeout']);if(b.transaction_timeout!=='500ms')refuse();
 const id=one(await query("SELECT pg_backend_pid() AS pid,(floor(extract(epoch FROM backend_start)*1000000)::numeric(20,0))::text AS \"startMicros\" FROM pg_stat_activity WHERE pid=pg_backend_pid() AND datname='listmonk' AND usename='postgres' AND application_name='shrigma-writer-production-review-v1'"));tuple=backend(id);
 if(original){const live=one(await query({text:"SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND (floor(extract(epoch FROM backend_start)*1000000)::numeric(20,0))::text=$2) AS original_backend_absent",values:[original.backend.pid,original.backend.startMicros]}));closed(live,['original_backend_absent']);if(live.original_backend_absent!==true)refuse();}
 const before=await observe();readHash=before.stateSha256;legacyHash=before.legacySha256;observed=before.counts;writerProfile=before.profile;emptyTables=before.empty;contextVerified=true;log.write('02-context.json',proof('context_verified',true));
 if(original){if(original.readStateSha256!==readHash||original.legacySha256!==legacyHash)refuse();phase=before.kind==='installed'?'reconciled_installed':'reconciled_absent';}
 else if(config.action==='verify')phase=before.kind==='installed'?'verified_existing':'verified_absent';
 else{
 if(config.action==='install'&&before.kind!=='absent'||config.action==='rollback'&&before.kind!=='installed')refuse();
 await query(plan.begin);inTX=true;await query(plan.logging);await query(plan.scope);await query(plan.readGuard);await query(plan.locks);await query(plan.legacyGuard);const locked=await snapshot();if(JSON.stringify(locked)!==JSON.stringify(before))refuse();
 mutationAttempted=true;phase='outcome_unknown';log.write('03-sql-intent.json',proof('sql_dispatched',true));
 await query(plan.mutating);await query(plan.readGuard);await query(plan.legacyGuard);const after=await snapshot();if(after.stateSha256!==readHash||after.legacySha256!==legacyHash||after.kind!==(config.action==='install'?'installed':'absent'))refuse();
 commitDispatched=true;const commit=await query(plan.commit);if(!ack(commit,'COMMIT'))refuse();inTX=false;commitAcknowledged=true;log.write('04-sql-ack.json',proof('sql_commit_acknowledged',true));
 const final=await observe();if(JSON.stringify(final)!==JSON.stringify(after))refuse();observed=final.counts;writerProfile=final.profile;emptyTables=final.empty;phase=config.action==='install'?'verified_installed':'verified_absent';
 }
 const result=proof(phase,true);log.write('proof.json',result);return result;
 }catch{
 if(inTX){try{const end=await query(plan.rollback);if(ack(end,'ROLLBACK')&&!commitDispatched&&mutationAttempted)phase='refused_rolled_back';}catch{}inTX=false;}
 if(commitAcknowledged||mutationAttempted&&phase!=='refused_rolled_back')phase='outcome_unknown';else if(reconcile)phase='hold';
 let result=proof(phase,false);try{if(log){result=proof(phase,true);log.write('proof.json',result);}}catch{result=proof(phase,false);}return result;
 }finally{password=undefined;if(timer!==undefined)clearTimer(timer);cut();try{client?.end?.()?.catch?.(()=>{});}catch{}try{if(client?.connectionParameters)client.connectionParameters.password='';}catch{}try{log?.close();}catch{}}
 }
 return Object.freeze({run(){if(!started)started=execute();return started;}});
}
module.exports=Object.freeze({createWriterInstallRunner,buildPlan,parseProof,readProof,connectionConfig,PROFILE,READ_CORE,INSTALLED,ABSENT,SCHEMA,SOURCE_MANIFEST_SHA256});
if(require.main===module){(async()=>{try{
 // Explicit operator opt-in only; OFF does not load pg, inspect a password,
 // read sources, create proof files, connect or schedule a timer.
 if(process.env.CRM_WRITER_INSTALL_REVIEW!=='1'){process.stdout.write(JSON.stringify({schema:SCHEMA,phase:'disabled'})+'\n');process.exitCode=1;return;}
 const [action,readPhase,operationId,...extra]=process.argv.slice(2);if(extra.length||Object.keys(process.env).some(k=>k.startsWith('PG')&&k!=='PGPASSWORD'||k==='DATABASE_URL')||process.versions.node.split('.')[0]!=='22')refuse();
 let password=process.env.PGPASSWORD;delete process.env.PGPASSWORD;
 const pg=require('pg');if(require('pg/package.json').version!=='8.13.1')refuse();
 const runner=createWriterInstallRunner({enabled:true,action,readPhase,operationId,password,proofDirectory:'/writer-install-proof',...(action==='reconcile'?{originalProofDirectory:'/writer-install-original-proof'}:{})},{Client:pg.Client});password=undefined;
 const p=await runner.run();process.stdout.write(JSON.stringify(p)+'\n');process.exitCode=p.durable&&['verified_installed','verified_existing','verified_absent','reconciled_installed','reconciled_absent'].includes(p.phase)?0:1;
 }catch{process.stdout.write(JSON.stringify({schema:SCHEMA,phase:'setup_refused'})+'\n');process.exitCode=1;}})();}
