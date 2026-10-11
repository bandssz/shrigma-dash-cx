"use strict";
// Real PostgreSQL17.10 two-client contention. No original, no SMTP, no lease fabrication.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),a=require("node:assert/strict"),{performance}=require("node:perf_hooks");
const ASSETS={
  "prepare.cjs": "eb720857ab797f4f2b68d76d81488adc1ea1682a69292a164cd5da07f88f1384",
  "APPLY.atomic.sql": "d778e1cb98cfc7794d874ed95be360dc4c03061a9fc7cbf9171c6268376f7d97",
  "RESTORE.atomic.sql": "28444a8628b3dd50e13089719ff3c927a18b43cf73ca337d8e889a8f777cb141",
  "snapshot.private-read.sql": "ee6d941acd6f4c7dc090955fd08f750f2fe0f0a5163c6bc647c86879d35f02a5",
  "fixture.cjs": "21aa2ddfa932b7c350319408e887d5ce20b92dc291d576036e2f29c543ddfb75",
  "fixture-extra-guards.sql": "53ee6e4d2aef2128a05a0bc719473a7e5a91ae7a93ab0b34b3326fcb9ec7e1c1",
  "FUNCTION.proposed.sql": "a45eed57cf0b43db41873fc198f0c80f9f00c3fe8cba08ebbc29638168d0d606"
};
const sha=x=>crypto.createHash("sha256").update(x).digest("hex");
const SIG="crm_audience_v2.regular_worker_heartbeat(uuid,text,text)",INSTANCE="77777777-7777-4777-8777-777777777777";
let db,holder,src,fixture,phase="boundary",mainTx=false,holderTx=false,rollbackConfirmed=true,ended=false;const cases=[];
async function rb(){try{await db.query("ROLLBACK");mainTx=false;}catch{rollbackConfirmed=false;throw Error("ROLLBACK_UNCONFIRMED");}}
async function begin(timeout="10s"){await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");mainTx=true;await db.query(`SET LOCAL statement_timeout='${timeout}'`);await db.query("SET LOCAL lock_timeout='500ms'");}
async function commit(){await db.query("COMMIT");mainTx=false;}
async function metadata(){return(await db.query(src.prepare("apply").snapshotReadSQL)).rows[0].function_metadata;}
async function allFunctions(){return(await db.query("SELECT jsonb_object_agg(p.oid::text,to_jsonb(p) ORDER BY p.oid) functions FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','crm_audience_v2')")).rows[0].functions;}
async function state(){return(await db.query(`SELECT jsonb_build_object('lease',(SELECT to_jsonb(l) FROM crm_audience_v2.regular_worker_lease l WHERE singleton),'deployment',(SELECT to_jsonb(d) FROM crm_audience_v2.regular_worker_deployment d WHERE singleton),'selection',(SELECT to_jsonb(r) FROM crm_audience_v2.selection_runtime r WHERE singleton),'dispatch',(SELECT jsonb_agg(to_jsonb(d) ORDER BY dispatch_id) FROM public.shrigma_email_dispatch d),'campaigns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.campaigns c),'controls',(SELECT jsonb_agg(to_jsonb(c) ORDER BY campaign_id) FROM crm_audience_v2.regular_delivery_campaign c),'configs',(SELECT jsonb_agg(to_jsonb(c) ORDER BY brand) FROM crm_audience_v2.config c)) state`)).rows[0].state;}
async function heartbeat(args=[INSTANCE,fixture.CANDIDATE.workerSha256,fixture.CANDIDATE.runtimeSha256]){return(await db.query("SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) result",args)).rows[0].result;}
async function renew(){await begin();const r=await heartbeat();a.equal(r.ready,true);a.equal(r.reason,"ready");a.equal(Date.parse(r.expires_at)-Date.parse(r.checked_at),60000);await commit();return r;}
async function alter(stage,expected){const p=src.prepare(stage);await db.query(p.statements[0]);mainTx=true;for(const s of p.statements.slice(1,4))await db.query(s);await db.query(p.statements[4],[JSON.stringify({schema:"heartbeat-contention-expected-v1",stage,functionMetadata:expected})]);await db.query(p.statements[5]);await db.query(p.statements[6]);await db.query(p.statements[7]);mainTx=false;}
// hold returns its release promise without awaiting it; claim/lock acquisition is awaited first.
async function lockHolder(actualClaim){
 await holder.query("BEGIN ISOLATION LEVEL READ COMMITTED");holderTx=true;await holder.query("SET LOCAL statement_timeout='10s'");await holder.query("SET LOCAL lock_timeout='500ms'");
 if(actualClaim){const ctl=(await holder.query("SELECT envelope_from,configuration_set FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=174")).rows[0];const result=(await holder.query("SELECT crm_audience_v2.regular_delivery_claim_live($1::uuid,174,1,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9) result",[INSTANCE,crypto.randomUUID(),fixture.CANDIDATE.workerSha256,fixture.CANDIDATE.runtimeSha256,ctl.envelope_from,"synthetic@example.invalid","d".repeat(64),"{}",ctl.configuration_set])).rows[0].result;a.equal(result.should_send,false);a.equal(result.reason,"accepted");}
 else await holder.query("SELECT 1 FROM crm_audience_v2.regular_worker_lease WHERE singleton FOR SHARE");
 const release=(async()=>{try{await holder.query("SELECT pg_sleep(2.8)");await holder.query("COMMIT");holderTx=false;}catch(e){try{await holder.query("ROLLBACK");holderTx=false;}catch{rollbackConfirmed=false;}throw e;}})();
 return {release};
}
async function contention(name,{actualClaim=false,args,wantReady=false,sqlstate,timeout="10s"}={}){
 phase=name;const before=await state(),{release}=await lockHolder(actualClaim);let result,error,elapsed;
 try{await begin(timeout);const at=performance.now();try{result=await heartbeat(args);}catch(e){error=e;}elapsed=performance.now()-at;
  if(sqlstate){a.equal(error&&error.code,sqlstate);await rb();}
  else{if(error)throw error;a.equal(result.ready,wantReady);a(elapsed>=1800,"must observe real >2s row-lock contention");
   if(wantReady){a.equal(result.reason,"ready");a.equal(result.instance_id,INSTANCE);a.equal(Date.parse(result.expires_at),Date.parse(before.lease.expires_at));a(Date.parse(result.checked_at)>Date.parse(before.lease.heartbeat_at));a(Date.parse(result.checked_at)<Date.parse(result.expires_at));
    // Same conservative grant arithmetic used by the real Go store: elapsed reduces it.
    a(Date.now()+Date.parse(result.expires_at)-Date.parse(result.checked_at)-elapsed<=Date.parse(before.lease.expires_at)+50);
   }else{a.equal(result.reason,"lease_unavailable");a.equal(result.instance_id,undefined);a.equal(result.expires_at,undefined);}
   await commit();}
 }finally{if(mainTx)await rb();await release;}
 a.deepEqual(await state(),before);cases.push({name,actualClaimLive:actualClaim,holderMs:2800,elapsedMs:Number(elapsed.toFixed(3)),ready:wantReady,sqlstate:error?error.code:"00000",previousDeadlineOnly:wantReady,stateUnchanged:true,rollback:!!sqlstate,noSmtp:true});
}
async function main(){
 a.equal(process.env.HEARTBEAT_CONTENTION_FIXTURE_ISOLATED,"1");a.equal(process.env.CRM_AUDIENCE_TEST_ISOLATED,"1");a.equal(process.env.REGULAR_NATIVE_SOURCE_PROOF,"1");a.equal(process.version,"v22.23.3");a.equal(process.platform,"linux");a.equal(process.arch,"x64");a.equal(process.getuid(),1000);a.equal(require("pg/package.json").version,"8.23.1");
 const url=new URL(process.env.HEARTBEAT_CONTENTION_FIXTURE_URL||"https://invalid");a.equal(url.protocol,"postgresql:");a.equal(url.hostname,"127.0.0.1");a.equal(url.pathname,"/listmonk");a(url.port&&url.port!=="5432");a.equal(url.username,"postgres");a.equal(url.password,"");a.equal(url.search,"");a.equal(url.hash,"");
 const dir=process.env.HEARTBEAT_CONTENTION_SOURCE_DIR;a(dir&&path.isAbsolute(dir)&&!fs.lstatSync(dir).isSymbolicLink());for(const[n,h]of Object.entries(ASSETS)){const p=path.join(dir,n);a(!fs.lstatSync(p).isSymbolicLink());a.equal(sha(fs.readFileSync(p)),h);}src=require(path.join(dir,"prepare.cjs"));fixture=require(path.join(dir,"fixture.cjs"));
 const{Client}=require("pg");db=new Client({connectionString:url.href,options:"-c TimeZone=Etc/UTC",query_timeout:12000});holder=new Client({connectionString:url.href,options:"-c TimeZone=Etc/UTC",query_timeout:12000});
 try{await db.connect();await holder.connect();a.deepEqual((await db.query("SELECT current_setting('server_version_num') v,current_database() d,current_setting('TimeZone') tz,session_user=current_user AS same")).rows[0],{v:"170010",d:"listmonk",tz:"Etc/UTC",same:true});
  phase="synthetic-full-schema-seed";await fixture.prepareFixture(db,process.env.HEARTBEAT_CONTENTION_REPO_ROOT);
  await db.query("ALTER FUNCTION crm_audience_v2.regular_worker_heartbeat(uuid,text,text) SET lock_timeout='2s'");const original=await metadata();a.equal(crypto.createHash("md5").update(original.prosrc).digest("hex"),"985e4c706fd8eb9326414cbc0d1eb89c");await renew();
  await db.query("UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=false WHERE campaign_id=174");await db.query("UPDATE public.campaigns SET status='scheduled' WHERE id=174");await db.query("UPDATE public.campaigns SET status='running' WHERE id=174");
  await contention("baseline-2s-actual-accepted-claim",{actualClaim:true,sqlstate:"55P03"});
  const beforeApply=await state(),allBefore=await allFunctions();await alter("apply",original);a.deepEqual(await state(),beforeApply);const after=await metadata(),target=structuredClone(original);target.prosrc=fs.readFileSync(path.join(dir,"FUNCTION.proposed.sql"),"utf8").split("AS $fn$")[1].split("$fn$;")[0];a.deepEqual(after,target);const allExpected=structuredClone(allBefore);allExpected[String(original.oid)]=target;a.deepEqual(await allFunctions(),allExpected);cases.push({name:"apply-one-prosrc-only",oidOwnerAclInvokerConfigAndPeersPreserved:true});
  await renew();await contention("candidate-2s-actual-accepted-claim",{actualClaim:true,wantReady:true});
  await renew();await contention("other-error-57014-not-caught",{actualClaim:true,sqlstate:"57014",timeout:"1s"});
  await renew();await contention("competing-identity-refused",{actualClaim:true,args:["88888888-8888-4888-8888-888888888888",fixture.CANDIDATE.workerSha256,fixture.CANDIDATE.runtimeSha256]});
  await renew();await db.query("UPDATE crm_audience_v2.regular_worker_deployment SET enabled=false");await contention("deployment-off-refused");await db.query("UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true");
  await renew();await db.query("UPDATE crm_audience_v2.regular_worker_lease SET suspended=true,suspension_reason='competing_instance'");await contention("suspension-refused");await db.query("UPDATE crm_audience_v2.regular_worker_lease SET suspended=false,suspension_reason=NULL");
  await renew();await db.query("UPDATE crm_audience_v2.selection_runtime SET enabled=false");await contention("selection-off-refused");await db.query("UPDATE crm_audience_v2.selection_runtime SET enabled=true");
  await renew();await db.query("UPDATE crm_audience_v2.selection_runtime SET verified_at=clock_timestamp()-interval '6 minutes'");await contention("selection-stale-refused");
  await renew();await db.query("UPDATE crm_audience_v2.regular_worker_lease SET expires_at=clock_timestamp()+interval '1 second'");await contention("expiry-during-wait-refused");
  await renew();const beforeRestore=await state();await alter("restore",after);a.deepEqual(await state(),beforeRestore);a.deepEqual(await metadata(),original);a.deepEqual(await allFunctions(),allBefore);cases.push({name:"restore-exact-metadata",restored:true});phase="closed";
 }finally{try{if(mainTx)await rb();}finally{try{if(holderTx){try{await holder.query("ROLLBACK");holderTx=false;}catch{rollbackConfirmed=false;}}}finally{const r=await Promise.allSettled([db.end(),holder.end()]);ended=r.every(x=>x.status==="fulfilled");}}}
}
main().then(()=>{a(ended&&rollbackConfirmed);const r={schema:"heartbeat-contention-native-proof-v1",ok:true,cases,caseCount:cases.length,node:process.version,uid:process.getuid(),postgresVersion:"17.10",pgVersion:"8.23.1",sourcePins:ASSETS,realOriginalClaimLiveFunction:true,previousCommittedLeaseOnly:true,heartbeatRefreshDuringFallback:false,allPeersPreserved:true,clientEndConfirmed:ended,rollbackConfirmed,fixtureServersEnded:false,originalCalls:0,originalWrites:0,smtpCalls:0,operational:false};const p=process.env.HEARTBEAT_CONTENTION_FIXTURE_RECEIPT;a(p&&path.isAbsolute(p)&&!fs.existsSync(p));fs.writeFileSync(p,JSON.stringify(r,null,2)+"\n",{flag:"wx",mode:0o644});process.stdout.write(JSON.stringify({schema:r.schema,ok:true,cases:r.caseCount,clientEndConfirmed:ended,rollbackConfirmed,originalCalls:0,operational:false})+"\n");}).catch(e=>{process.stdout.write(JSON.stringify({schema:"heartbeat-contention-native-proof-v1",ok:false,phase,sqlstate:typeof e.code==="string"&&/^[A-Z0-9]{5}$/.test(e.code)?e.code:null,cases,clientEndConfirmed:ended,rollbackConfirmed,originalCalls:0,operational:false})+"\n");process.exitCode=1;});
