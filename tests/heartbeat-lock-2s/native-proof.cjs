"use strict";
// Real two-client PostgreSQL17.10 + real isolated Mailpit. No original server/worker/SES.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),assert=require("node:assert/strict"),net=require("node:net"),{performance}=require("node:perf_hooks");
const SOURCE_PINS=Object.freeze({
  "prepare.cjs": "e1e45367ab8eea1f0ca629ea6785bb392a4f8df33d77745d3caf07de2d7366bc",
  "APPLY.atomic.sql": "3700e61a80b21bae4b93f34584423a7e2a289ca0a66af3f1a8ff9c71403fb90e",
  "RESTORE.atomic.sql": "64360a9b9f53d09fe9960a4203731b978c02df3ed402346f1b780a46f3dec972",
  "snapshot.private-read.sql": "ee6d941acd6f4c7dc090955fd08f750f2fe0f0a5163c6bc647c86879d35f02a5"
});
const SHA=x=>crypto.createHash("sha256").update(x).digest("hex");
const BODY_SHA="9eac0eb242d4203f7dee82e595ece58d02ccbe220613b9e72d3dd9760a3b3883";
const QSHA="772efe8e05331fb201ed24cb08bb97a4625a49811d96622c2148342ce54c6700";
const SIG="crm_audience_v2.regular_worker_heartbeat(uuid,text,text)";
const INSTANCE="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",WORKER="a".repeat(64),RUNTIME="b".repeat(64);
const KEY="crm-audience-v2-regular-worker-lease";
let phase="boundary",mainClient,holderClient,inTx=false,holderTx=false,ended=false,rollbackConfirmed=true,source,api,mailPort;
const cases=[];
const equal=(x,y)=>assert.equal(JSON.stringify(x),JSON.stringify(y));
const stateSql=`SELECT jsonb_build_object('deployment',(SELECT to_jsonb(d) FROM crm_audience_v2.regular_worker_deployment d WHERE singleton),
 'lease',(SELECT to_jsonb(l) FROM crm_audience_v2.regular_worker_lease l WHERE singleton),
 'selection',(SELECT to_jsonb(s) FROM crm_audience_v2.selection_runtime s WHERE singleton),
 'controls',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY campaign_id),'[]'::jsonb) FROM crm_audience_v2.regular_delivery_campaign c),
 'dispatch',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY dispatch_id),'[]'::jsonb) FROM public.shrigma_email_dispatch d),
 'config',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY brand),'[]'::jsonb) FROM crm_audience_v2.config c)) state`;
const functionSql=`SELECT jsonb_object_agg(p.oid::text,to_jsonb(p) ORDER BY p.oid) functions FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','crm_audience_v2')`;
async function state(){return (await mainClient.query(stateSql)).rows[0].state;}
async function functions(){return (await mainClient.query(functionSql)).rows[0].functions;}
async function metadata(){return (await mainClient.query(source.prepare("apply").snapshotReadSQL)).rows[0].function_metadata;}
async function begin(seconds="10s") {await mainClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");inTx=true;await mainClient.query(`SET LOCAL statement_timeout='${seconds}'`);await mainClient.query("SET LOCAL lock_timeout='500ms'");}
async function rb(){try{await mainClient.query("ROLLBACK");inTx=false;}catch{rollbackConfirmed=false;throw Error("ROLLBACK_UNCONFIRMED");}}
async function commit(){await mainClient.query("COMMIT");inTx=false;}
async function heartbeat(instance=INSTANCE,worker=WORKER,runtime=RUNTIME){return (await mainClient.query("SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) result",[instance,worker,runtime])).rows[0].result;}
function ready(r){assert.equal(r.ready,true);assert.equal(r.reason,"ready");assert.equal(r.instance_id,INSTANCE);assert.equal(Date.parse(r.expires_at)-Date.parse(r.checked_at),60000);assert.ok(Date.parse(r.expires_at)>Date.now());}
async function messageCount(){
 const url=new URL("/api/v1/messages",api),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
 try{const r=await fetch(url,{signal:controller.signal,redirect:"error"});assert.equal(r.status,200);const reader=r.body.getReader();let n=0,parts=[];
  for(;;){const v=await reader.read();if(v.done)break;n+=v.value.byteLength;if(n>65536){await reader.cancel();throw Error("MAILPIT_OUTPUT_BOUND");}parts.push(Buffer.from(v.value));}
  const d=JSON.parse(Buffer.concat(parts).toString("utf8"));assert.ok(Number.isSafeInteger(d.total)&&d.total>=0&&d.total<=4);return d.total;
 }finally{clearTimeout(timer);}
}
async function smtpOne(){
 const socket=net.createConnection({host:"127.0.0.1",port:mailPort});let buffer="",bytes=0,pending=null,closed=false;
 const reject=e=>{if(pending){const p=pending;pending=null;p.reject(e);}};
 const consume=()=>{if(!pending)return;const lines=buffer.split("\r\n");let used=0,code=null;
  for(let i=0;i<lines.length-1;i++){assert.match(lines[i],/^\d{3}[ -]/);used+=lines[i].length+2;if(lines[i][3]===" "){code=Number(lines[i].slice(0,3));break;}}
  if(code!==null){buffer=buffer.slice(used);const p=pending;pending=null;p.resolve(code);}
 };
 socket.setTimeout(4000,()=>socket.destroy(Error("SMTP_TIMEOUT")));
 socket.on("data",b=>{bytes+=b.length;if(bytes>8192){socket.destroy(Error("SMTP_OUTPUT_BOUND"));return;}buffer+=b.toString("utf8");try{consume();}catch{socket.destroy(Error("SMTP_PROTOCOL"));}});
 socket.on("error",()=>reject(Error("SMTP_REFUSED")));socket.on("close",()=>{closed=true;reject(Error("SMTP_CLOSED"));});
 const reply=()=>new Promise((resolve,reject)=>{assert.equal(pending,null);pending={resolve,reject};consume();if(closed)reject(Error("SMTP_CLOSED"));});
 const send=async(s,code)=>{socket.write(s+"\r\n");assert.equal(await reply(),code);};
 try{assert.equal(await reply(),220);await send("EHLO heartbeat-fixture.example.invalid",250);
  await send("MAIL FROM:<heartbeat-fixture@example.invalid>",250);await send("RCPT TO:<heartbeat-sink@example.invalid>",250);
  await send("DATA",354);await send("From: heartbeat-fixture@example.invalid\r\nTo: heartbeat-sink@example.invalid\r\nSubject: isolated heartbeat lock 2s\r\n\r\nSynthetic fixture only. No original campaign.\r\n.",250);
  await send("QUIT",221);
 }finally{socket.destroy();}
}
async function alter(stage,expected){
 phase="metadata-"+stage;const p=source.prepare(stage);assert.equal(p.executionAvailable,false);
 await mainClient.query(p.statements[0]);inTx=true;for(const s of p.statements.slice(1,4))await mainClient.query(s);
 await mainClient.query(p.statements[4],[JSON.stringify({schema:"heartbeat-lock-2s-expected-v1",stage,functionMetadata:expected})]);
 await mainClient.query(p.statements[5]);await mainClient.query(p.statements[6]);await mainClient.query(p.statements[7]);inTx=false;
}
async function contention(ms,shouldReady){
 const before=await state();const beforeM=await messageCount();await holderClient.query("BEGIN");holderTx=true;
 await holderClient.query("SET LOCAL statement_timeout='5s'");await holderClient.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[KEY]);
 const release=(async()=>{try{await holderClient.query("SELECT pg_sleep($1::double precision)",[ms/1000]);await holderClient.query("COMMIT");holderTx=false;}catch(e){await holderClient.query("ROLLBACK");holderTx=false;throw e;}})();
 let result,error,elapsed;try{await begin();const start=performance.now();try{result=await heartbeat();}catch(e){error=e;}elapsed=performance.now()-start;
  if(shouldReady){if(error)throw error;ready(result);assert.ok(elapsed>=500&&elapsed<2000);assert.equal((await mainClient.query("SHOW lock_timeout")).rows[0].lock_timeout,"500ms");await commit();}
  else{assert.equal(error&&error.code,"55P03");assert.ok(elapsed>=(ms===800?350:1800));await rb();}
 }finally{if(inTx)await rb();await release;}
 if(!shouldReady)equal(await state(),before);assert.equal(await messageCount(),beforeM);
 return {holderMs:ms,elapsedMs:Number(elapsed.toFixed(3)),ready:!!shouldReady,sqlstate:error?error.code:"00000",commitAcknowledged:!!shouldReady,rollback:!shouldReady,smtpUnchanged:true};
}
async function negative(name,args,reason,sqlstate){phase=name;const before=await state(),count=await messageCount();await begin();
 try{let result,error;try{result=await heartbeat(...args);}catch(e){error=e;}
  if(sqlstate)assert.equal(error&&error.code,sqlstate);else{if(error)throw error;assert.equal(result.ready,false);assert.equal(result.reason,reason);}await rb();
 }finally{if(inTx)await rb();}
 equal(await state(),before);assert.equal(await messageCount(),count);cases.push({name,refused:true,rollback:true,stateUnchanged:true,smtpUnchanged:true});
}
async function main(){
 assert.equal(process.env.HEARTBEAT_LOCK_FIXTURE_ISOLATED,"1");assert.equal(process.env.CRM_AUDIENCE_TEST_ISOLATED,"1");
 assert.equal(process.version,"v22.23.3");assert.equal(process.platform,"linux");assert.equal(process.arch,"x64");assert.equal(process.getuid(),1000);
 assert.equal(require("pg/package.json").version,"8.23.1");
 const u=new URL(process.env.HEARTBEAT_LOCK_FIXTURE_URL||"http://invalid");assert.equal(u.protocol,"postgresql:");assert.equal(u.hostname,"127.0.0.1");assert.equal(u.pathname,"/listmonk");assert.ok(u.port&&u.port!=="5432");assert.equal(u.username,"postgres");assert.equal(u.password,"");assert.equal(u.search,"");assert.equal(u.hash,"");
 api=new URL(process.env.HEARTBEAT_LOCK_MAILPIT_API||"https://invalid");assert.equal(api.protocol,"http:");assert.equal(api.hostname,"127.0.0.1");assert.ok(api.port&&!["80","443"].includes(api.port));assert.equal(api.username,"");assert.equal(api.password,"");assert.equal(api.pathname,"/");assert.equal(api.search,"");assert.equal(api.hash,"");
 mailPort=Number(process.env.HEARTBEAT_LOCK_MAILPIT_SMTP_PORT);assert.ok(Number.isInteger(mailPort)&&mailPort>1024&&mailPort<65536&&mailPort!==Number(u.port));
 const dir=process.env.HEARTBEAT_LOCK_SOURCE_DIR;assert.ok(dir&&path.isAbsolute(dir)&&!fs.lstatSync(dir).isSymbolicLink());
 for(const [name,expected]of Object.entries(SOURCE_PINS)){const q=path.join(dir,name);assert.ok(!fs.lstatSync(q).isSymbolicLink());assert.equal(SHA(fs.readFileSync(q)),expected);}
 source=require(path.join(dir,"prepare.cjs"));const {Client}=require("pg");
 mainClient=new Client({connectionString:u.href,options:"-c TimeZone=Etc/UTC",query_timeout:12000});holderClient=new Client({connectionString:u.href,options:"-c TimeZone=Etc/UTC",query_timeout:6000});
 try{await mainClient.connect();await holderClient.connect();
  const b=(await mainClient.query("SELECT current_setting('server_version_num') version,current_database() db,session_user=current_user AS same,current_setting('TimeZone') tz")).rows[0];
  assert.deepEqual(b,{version:"170010",db:"listmonk",same:true,tz:"Etc/UTC"});assert.equal(await messageCount(),0);
  const m=await metadata();assert.equal(SHA(m.prosrc),BODY_SHA);assert.equal(Buffer.byteLength(m.prosrc),4143);assert.equal(m.prosecdef,false);assert.equal(m.provolatile,"v");
  assert.deepEqual([...m.proconfig].sort(),["lock_timeout=500ms","search_path=pg_catalog"].sort());
  const untouchedFunctions=await functions();const originalState=await state();assert.equal(originalState.deployment.enabled,false);assert.equal(originalState.lease,null);assert.deepEqual(originalState.controls,[]);assert.deepEqual(originalState.dispatch,[]);
  phase="synthetic-identity-seed";await mainClient.query(`UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true,worker_sha256=$1,runtime_sha256=$2,query_sha256=$3,database_role=session_user,approved_at=clock_timestamp()-interval '1 minute',approved_by='synthetic-heartbeat-lock-fixture',topology_receipt_sha256=$4 WHERE singleton`,[WORKER,RUNTIME,QSHA,"f".repeat(64)]);
  await begin();ready(await heartbeat());await commit();
  phase="original-500ms-contention";cases.push({name:phase,...await contention(800,false)});
  const beforeAlter=await state();await alter("apply",m);equal(await state(),beforeAlter);const applied=await metadata(),expected=structuredClone(m);expected.proconfig=expected.proconfig.map(v=>v==="lock_timeout=500ms"?"lock_timeout=2s":v);equal(applied,expected);
  const allAfter=await functions();const allExpected=structuredClone(untouchedFunctions);allExpected[String(m.oid)]=expected;equal(allAfter,allExpected);
  cases.push({name:"apply-only-function-proconfig",bodyOidOwnerAclInvokerAndPeersUnchanged:true,allOtherStateUnchanged:true});
  phase="candidate-800ms-contention";cases.push({name:phase,...await contention(800,true)});
  phase="committed-live-identity-then-mailpit";await begin();const until=(await mainClient.query("SELECT crm_audience_v2.regular_worker_require($1::uuid,$2,$3) until",[INSTANCE,WORKER,RUNTIME])).rows[0].until;assert.ok(new Date(until).getTime()>Date.now());await commit();await smtpOne();assert.equal(await messageCount(),1);
  cases.push({name:phase,realOriginalHeartbeatAndRequireFunction:true,commitBeforeSmtp:true,mailpitAcceptedMessages:1,syntheticMessageOnly:true});
  phase="candidate-2500ms-contention";cases.push({name:phase,...await contention(2500,false)});
  await negative("wrong-worker-identity",[INSTANCE,"c".repeat(64),RUNTIME],"identity_unavailable");
  await negative("competing-instance",["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",WORKER,RUNTIME],"competing_instance");
  await negative("zero-instance",["00000000-0000-0000-0000-000000000000",WORKER,RUNTIME],null,"P0001");
  const beforeRestore=await state();await alter("restore",applied);equal(await state(),beforeRestore);equal(await metadata(),m);equal(await functions(),untouchedFunctions);assert.equal(await messageCount(),1);
  cases.push({name:"restore-exact-metadata",bodyOidOwnerAclInvokerAndPeersRestored:true,allOtherStateUnchanged:true});assert.equal(cases.length,9);phase="closed";
 }finally{
  try{if(inTx)await rb();}finally{
   try{if(holderTx)await holderClient.query("ROLLBACK");holderTx=false;}finally{
    const r=await Promise.allSettled([mainClient.end(),holderClient.end()]);ended=r.every(x=>x.status==="fulfilled");
   }
  }
 }
}
main().then(()=>{
 assert.equal(ended,true);assert.equal(rollbackConfirmed,true);const report={schema:"heartbeat-lock-2s-native-pg-mailpit-proof-v1",ok:true,cases,caseCount:9,
  node:process.version,uid:process.getuid(),postgresVersion:"17.10",pgVersion:"8.23.1",sourcePins:SOURCE_PINS,bodySha256:BODY_SHA,
  functionOriginalAndRestoreMd5:"985e4c706fd8eb9326414cbc0d1eb89c",sourceOnly:true,originalCalls:0,originalWrites:0,originalWorkerExecuted:false,actualOriginalRuntimeMeasured:false,
  fixtureHeartbeatFunctionReal:true,fixtureTwoClientConcurrency:true,mailpitGenuine:true,mailpitSyntheticMessages:1,clientEndConfirmed:ended,rollbackConfirmed,
  fixtureServersEnded:false,operational:false};const file=process.env.HEARTBEAT_LOCK_FIXTURE_RECEIPT;assert.ok(file&&path.isAbsolute(file)&&!fs.existsSync(file));
 fs.writeFileSync(file,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o644});fs.chmodSync(file,0o644);assert.equal(fs.statSync(file).mode&0o777,0o644);process.stdout.write(JSON.stringify({schema:report.schema,ok:true,cases:9,clientEndConfirmed:true,rollbackConfirmed:true,originalCalls:0,operational:false})+"\n");
}).catch(e=>{process.stdout.write(JSON.stringify({schema:"heartbeat-lock-2s-native-pg-mailpit-proof-v1",ok:false,phase,sqlstate:typeof e.code==="string"&&/^[A-Z0-9]{5}$/.test(e.code)?e.code:null,cases,clientEndConfirmed:ended,rollbackConfirmed,originalCalls:0,operational:false})+"\n");process.exitCode=1;});
