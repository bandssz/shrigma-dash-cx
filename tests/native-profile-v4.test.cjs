 'use strict';
// SYNTHETIC FIXTURES ONLY. No original receipt, SQL execution or capability.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const P=require('../tools/listmonk-regular-build/native_batch_profile.cjs'),V=require('../tools/listmonk-regular-build/joint_read_profile_v4.cjs'),M=require('../tools/listmonk-regular-build/materialize_batch_profile.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');let cases=0;
function test(name,fn){fn();cases++;console.log('PASS '+name);}
const context=fs.realpathSync(process.argv[2]),tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'c2-profile-v4-')));
function write(m){const f=path.join(tmp,'PROFILE.json'),b=JSON.stringify(m);fs.writeFileSync(f,b);return [f,sha(b)];}
function load(m,opts){return P.load(...write(m),opts);}
const clone=x=>JSON.parse(JSON.stringify(x));
try{
 const supplied=JSON.parse(fs.readFileSync(path.join(context,'crm-scheduler-batch-profile.json')));
 assert.ok((supplied.schema==='shrigma-native-batch-proof-profile-v3'&&supplied.version===3)||(supplied.schema==='shrigma-native-batch-proof-profile-v4'&&supplied.version===4));
 assert.equal(supplied.isolatedProofAuthorization,null);
 const base={...supplied,schema:'shrigma-native-batch-proof-profile-v3',version:3};
 const pins=[base.compositionDelivery,...Object.values(base.sources),...base.additionalSqlSources.map(x=>x.file)];
 for(const pin of pins){const b=fs.readFileSync(path.join(context,pin.path));assert.equal(b.length,pin.bytes);assert.equal(sha(b),pin.sha256);const f=path.join(tmp,pin.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);}
 test('v3 source behavior retained',()=>assert.equal(load(base).report.version,3));
 const m={...clone(base),schema:'shrigma-native-batch-proof-profile-v4',version:4};
 test('v4 null authorization source loads',()=>assert.equal(load(m).report.isolatedProofAuthorized,false));
 const p=load(m),expected={schema:'batch-v99-native-joint-worker-budget-read',kernelSha256:m.kernelSha256,countReadSha256:p.report.countReadSha256,recipientReadSha256:p.report.recipientPreviewQuerySha256,payloadSha256:sha('SYNTHETIC_PAYLOAD_ONLY')};
 const query=fs.readFileSync(path.join(tmp,m.sources.candidateQuery.path),'utf8'),composer=require(path.join(tmp,m.sources.composer.path)),count=composer.section(query,'next-campaigns').text;
 test('physical count matches closed derivation bytes',()=>assert.equal(p.countReadSQL,count.slice(count.indexOf('WITH '),count.indexOf('eligibleCounts AS (')).trim().replace(/,$/,'')+'\nSELECT campaign_id,to_send,max_subscriber_id FROM postContexts WHERE same_context;\n'));
 const report={schema:expected.schema,preparedPurpose:'SYNTHETIC_FIXTURE_ONLY_NO_ORIGINAL_AUTHORITY',kernelSha256:expected.kernelSha256,payloadSha256:expected.payloadSha256,statementTimeoutMs:9000,actualWorkerStatementBudgetMs:10000,transportExitCode:0,transportStderrPresent:false,transportStderrBytes:0,completed:true,readOnly:true,recipientPreviewOnly:true,recipientSectionComplete:true,operational:false,runtimeChanged:false,campaignsChanged:false,functionsChanged:false,originalPerformanceAccepted:false,fullRecipientDispatchProved:false,replayAllowed:false,results:[0,171,174].map((id,i)=>({stage:i?'recipient-preview':'joint-source-count',campaignId:id,sourceVariant:null,elapsedMs:100,sqlState:'00000',rollbackAndProcessEndConfirmed:true,stderrPresent:false,stderrBytes:0,jitLocalOffRequested:true,contextUnchanged:true,jitLocalOffConfirmed:true,sourceQuerySha256:i?expected.recipientReadSha256:expected.countReadSha256,...(i?{actualMatchedMaxAndListLiteralsBound:true,countContextUnchanged:true,aggregate:{stage:'recipient-preview',campaignId:id,rowCount:1,chosenCount:1,chosenShape:true,deliverySnapshotShape:true,withinLimit:true,fullRecipientQueryClosed:true}}:{jointStatement171174:true,actualMatchedMaxCapturedPrivately:true,actualListArgumentsCapturedPrivately:true,aggregate:{stage:'joint-source-count',campaignIds:[171,174],rowCount:2,campaignShape:true,counts:[171,174].map(campaignId=>({campaignId,toSend:1,maxSubscriberIdShape:true}))}})}))};
 function authorized(r=report,e=expected){const b=Buffer.from(JSON.stringify(r));fs.mkdirSync(path.join(tmp,'receipts'),{recursive:true});fs.writeFileSync(path.join(tmp,'receipts/joint.json'),b);return {...clone(m),isolatedProofAuthorization:{schema:'shrigma-native-joint-read-authorization-v4',readReceipt:{path:'receipts/joint.json',bytes:b.length,sha256:sha(b)},expected:clone(e)}};}
 test('synthetic joint gate accepted without operational authority',()=>{const r=load(authorized()).report;assert.equal(r.jointRead.jointCountReadAccepted,true);assert.equal(r.originalPerformanceAccepted,false);assert.equal(r.operational,false);});
 for(const [name,mutate]of [
 ['over budget',r=>r.results[0].elapsedMs=9001],['SQL failure',r=>r.results[0].sqlState='57014'],['context uncertainty',r=>r.results[1].contextUnchanged=false],['rollback uncertainty',r=>r.results[2].rollbackAndProcessEndConfirmed=false],['missing whole preview',r=>r.results.pop()],['separate counts',r=>r.results[0].stage='source-count'],['5s timeout',r=>r.statementTimeoutMs=5000],['exported parameters',r=>r.parameters={listIDs:[1]}],['row private values',r=>r.results[0].maxSubscriberId=1],['incomplete recipient query',r=>r.results[1].aggregate.fullRecipientQueryClosed=false],['performance fabrication',r=>r.originalPerformanceAccepted=true]])test(name,()=>{const r=clone(report);mutate(r);assert.throws(()=>load(authorized(r)));});
 for(const key of ['kernelSha256','countReadSha256','recipientReadSha256'])test('stale '+key,()=>{const e=clone(expected);e[key]=sha('stale');assert.throws(()=>load(authorized(report,e)));});
 test('v3 schema cannot import v4 wrapper',()=>{const a=authorized();a.version=3;a.schema=base.schema;assert.throws(()=>load(a));});
 test('version schema mismatch refused',()=>assert.throws(()=>load({...m,version:3})));
 process.env.REGULAR_NATIVE_PROOF_ISOLATED='1';
 const receipt={binarySha256:sha('SYNTHETIC_BINARY_ONLY'),querySha256:m.querySha256,kernelSha256:m.kernelSha256,composerSha256:m.sources.composer.sha256,workerTransactionSha256:p.workerTransactionSha256};
 for(const version of [3,4])test('isolated SOURCE v'+version+' requires null authorization',()=>{const source={...clone(version===3?base:m),buildReceipt:receipt};assert.equal(load(source,{forRun:true,isolatedSourceProof:true}).report.proofPurpose,'isolated-source-functional');source.isolatedProofAuthorization=authorized().isolatedProofAuthorization;assert.throws(()=>load(source,{forRun:true,isolatedSourceProof:true}));});
 test('synthetic original READ gated run requires build receipt',()=>{const a={...authorized(),buildReceipt:receipt};assert.equal(load(a,{forRun:true}).report.proofPurpose,'original-read-gated');a.buildReceipt=null;assert.throws(()=>load(a,{forRun:true}));});
 test('aggregate payload identity mismatch refused',()=>{const r=clone(report);r.payloadSha256=sha('different');assert.throws(()=>load(authorized(r)));});
 test('receipt byte pin mismatch refused',()=>{const a=authorized();a.isolatedProofAuthorization.readReceipt.sha256=sha('different');assert.throws(()=>load(a));});
 test('default run refuses missing joint receipt',()=>assert.throws(()=>load({...m,buildReceipt:receipt},{forRun:true})));
 test('materializer copies aggregate only',()=>{const a=authorized(),[profile,profileSha256]=write(a),out=path.join(tmp,'materialized');M.materialize({profile,profileSha256,out});assert.equal(fs.existsSync(path.join(out,'receipts/joint.json')),true);assert.deepEqual(fs.readdirSync(path.join(out,'receipts')),['joint.json']);assert.equal(P.load(path.join(out,'PROFILE.json'),sha(fs.readFileSync(path.join(out,'PROFILE.json')))).report.jointRead.originalAuthorityAccepted,false);});
 test('materializer refuses invalid evidence before output',()=>{const r=clone(report);r.completed=false;const [profile,profileSha256]=write(authorized(r)),out=path.join(tmp,'refused');assert.throws(()=>M.materialize({profile,profileSha256,out}));assert.equal(fs.existsSync(out),false);});
 for(const [name,value]of [['duplicate anchor',count+'eligibleCounts AS ('],['DML prefix',count.replace('WITH ','WITH DELETE ')],['missing post context',count.replace('postContexts AS','absent AS')]])test(name,()=>assert.throws(()=>V.countReadSQL(value)));
 console.log(JSON.stringify({cases,synthetic:true,operational:false,node:process.version}));
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
