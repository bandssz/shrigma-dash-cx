'use strict';
// Runs by docker exec; creates its child's FD3 inside the container.
const fs=require('node:fs'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite'),a=require('node:assert/strict');
const runtime='/app/native-backend/runtime',cli=runtime+'/native-worker-vault-cli.cjs',dbPath=require('/app/bootstrap.cjs').DB_FILE,ready=JSON.parse(fs.readFileSync('/tmp/c15-image-ready.json')),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const run=(args,input,privateFd=true)=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,[cli,...args],{stdio:privateFd?['pipe','pipe','pipe','pipe']:['pipe','pipe','pipe']}),parts=[[],[],[]];c.stdout.on('data',b=>parts[0].push(b));c.stderr.on('data',b=>parts[1].push(b));if(privateFd)c.stdio[3].on('data',b=>parts[2].push(b));c.on('error',reject);c.on('close',code=>resolve({code,out:Buffer.concat(parts[0]).toString(),err:Buffer.concat(parts[1]).toString(),private:Buffer.concat(parts[2]).toString()}));c.stdin.end(input?JSON.stringify(input):undefined);});
(async()=>{
 a.equal(process.getuid(),1000);a.equal(sha(fs.readFileSync('/app/native-backend/manifest.json')),ready.manifest);
 const d=new DatabaseSync(dbPath,{readOnly:true}),tables=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'shrigma_meta_wa_%' OR name LIKE 'shrigma_native_database_%') ORDER BY name").all().map(r=>r.name),snapshot=()=>tables.map(t=>({name:t,rows:d.prepare('SELECT * FROM '+t).all()})),before=snapshot();
 a(tables.length>=3);a.equal(d.prepare('SELECT count(*) n FROM shrigma_meta_wa_connection_v1').get().n,2);a.equal(d.prepare('SELECT count(*) n FROM shrigma_native_database_credential_v1').get().n,1);
 const operationId=crypto.randomUUID(),body={action:'generate',operationId,expectedManifest:ready.manifest,expectedBundleRevision:0};
 const nofd=await run(['--private-pipe'],body,false);a.equal(nofd.code,1);a.match(nofd.err,/WV_PRIVATE_PIPE_REQUIRED/);
 let r=await run(['--private-pipe'],body);a.equal(r.code,0);a.equal(r.private,'');a.equal(JSON.parse(r.out).bundleRevision,1);
 r=await run(['--receipt',operationId]);a.equal(r.code,0);a.equal(JSON.parse(r.out).receiptIsCurrent,true);
 const v=await run(['--private-pipe'],{...body,action:'verifiers',expectedBundleRevision:1});a.equal(v.code,0);a.equal(JSON.parse(v.out).privateDelivered,true);a.equal(v.out.includes('SCRAM'),false);a.equal(v.err.includes('SCRAM'),false);
 const p=JSON.parse(v.private);a.equal(p.manifest,ready.manifest);a.equal(p.operationId,operationId);a.deepEqual(Object.keys(p.verifiers).sort(),['crm_api','crm_worker']);a(Object.values(p.verifiers).every(s=>/^SCRAM-SHA-256\$4096:/.test(s)));
 const retry=await run(['--private-pipe'],{...body,action:'verifiers',expectedBundleRevision:1});a.equal(retry.code,0);a.equal(retry.private,v.private);
 const duplicate=await run(['--private-pipe'],{...body,expectedBundleRevision:1});a.equal(duplicate.code,1);a.match(duplicate.err,/WV_OPERATION_COMMITTED/);
 const stale=await run(['--private-pipe'],{...body,operationId:crypto.randomUUID()});a.equal(stale.code,1);a.match(stale.err,/WV_CAS/);
 const revoked=await run(['--private-pipe'],{...body,action:'revoke',operationId:crypto.randomUUID(),expectedBundleRevision:1});a.equal(revoked.code,0);a.equal(JSON.parse(revoked.out).slots.executor.linked,false);
 a.deepEqual(snapshot(),before);d.close();
 const file=require(runtime+'/native-worker-vault.cjs').socketPath(dbPath),s=fs.lstatSync(file);
 a.equal(s.uid,1000);a.equal(s.mode&0o777,0o600);a.equal(fs.statSync(require('node:path').dirname(file)).mode&0o777,0o700);
 console.log(JSON.stringify({schema:'shrigma-c15-docker-private-proof-v1',ok:true,node:process.version,uid:process.getuid(),sourceRevision:ready.revision,manifestSha256:ready.manifest,cliPath:cli,cliSha256:sha(fs.readFileSync(cli)),actualApiCommand:true,actualBootstrap:true,originalBootstrapUnmodified:true,dockerExecNodeParent:true,privateFd3:true,stdoutMetadataOnly:true,stablePrivatePair:true,lostAckReconciled:true,casAndReplayRefused:true,atomicRevoke:true,metaBrandsPreserved:2,legacyPgPreserved:true,socketMode:'0600',directoryMode:'0700',syntheticIdentity:true,productionUsed:false,workerEnabled:false,jobsEnabled:false,postgresConnections:0}));
})().catch(()=>{console.error(JSON.stringify({ok:false,code:'C15_PRIVATE_PARENT_PROOF_FAILED'}));process.exitCode=1;});
