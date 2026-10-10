"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),{Client}=require("pg");
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||"http://invalid"),reportPath=process.env.BULK_MEMBERSHIP_REPORT;
assert(process.version==="v22.23.3"&&process.getuid()===1000,"NATIVE_RUNTIME_REQUIRED");
assert(process.env.CRM_AUDIENCE_TEST_ISOLATED==="1"&&process.env.REGULAR_NATIVE_SOURCE_PROOF==="1","ISOLATED_OPT_IN_REQUIRED");
assert(u.protocol==="postgresql:"&&u.hostname==="127.0.0.1"&&u.pathname==="/postgres"&&u.port&&u.port!=="5432","DISPOSABLE_DATABASE_REQUIRED");
assert(reportPath&&path.isAbsolute(reportPath)&&!fs.existsSync(reportPath),"FRESH_REPORT_REQUIRED");
let client,ended=false;
(async()=>{
 client=new Client({connectionString:uri,statement_timeout:15000});await client.connect();
 const version=(await client.query("SHOW server_version")).rows[0].server_version;assert.match(version,/^17\.10(?:\D|$)/);
 const database={exec:sql=>client.query(sql),query:(sql,args)=>client.query(sql,args),close:async()=>{await client.end();ended=true;}};
 const result=await require("./equivalence.cjs").runWithDatabase(database);
 assert(result.ok&&result.cases.length===28&&result.rollbackConfirmed&&result.endConfirmed&&ended);
 const digest=crypto.createHash("sha256").update(fs.readFileSync(path.resolve(__dirname,"../../n8n/growth/segment-listmonk-selection.batch.sql"))).digest("hex");assert.equal(result.afterKernelSha256,digest);
 process.stdout.write(JSON.stringify({ok:true,cases:28,afterKernelSha256:digest,postgresVersion:version,rollbackConfirmed:true,endConfirmed:true,nativeRuntime:true,originalCalled:false,originalOperational:false}));
})().catch(async error=>{if(client&&!ended){try{await client.query("ROLLBACK");}catch{}try{await client.end();ended=true;}catch{}}process.stderr.write(JSON.stringify({error:"NATIVE_MEMBERSHIP_REFUSED",sqlState:/^[A-Z0-9]{5}$/.test(error.code||"")?error.code:null}));process.exitCode=1;});
