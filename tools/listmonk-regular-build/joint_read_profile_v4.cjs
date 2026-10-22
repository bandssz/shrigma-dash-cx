 'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),HASH=/^[a-f0-9]{64}$/;
const fail=()=>{throw Error('JOINT_PROFILE_V4_REFUSED');};
const exact=(v,k)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).sort().join()!==[...k].sort().join())fail();};
function wrapper(a){
 exact(a,['schema','readReceipt','expected']);if(a.schema!=='shrigma-native-joint-read-authorization-v4')fail();
 exact(a.readReceipt,['path','bytes','sha256']);if(typeof a.readReceipt.path!=='string'||/params|capsule/i.test(a.readReceipt.path)||!Number.isSafeInteger(a.readReceipt.bytes)||a.readReceipt.bytes<1||a.readReceipt.bytes>1048576||!HASH.test(a.readReceipt.sha256))fail();
 exact(a.expected,['schema','kernelSha256','countReadSha256','recipientReadSha256','payloadSha256']);
 if(!/^batch-v[0-9]+-native-joint-worker-budget-read$/.test(a.expected.schema))fail();
 for(const k of ['kernelSha256','countReadSha256','recipientReadSha256','payloadSha256'])if(!HASH.test(a.expected[k]))fail();
}
function countReadSQL(count){
 if(typeof count!=='string')fail();
 const anchor='eligibleCounts AS (';if(count.split(anchor).length!==2)fail();
 const start=count.indexOf('WITH '),end=count.indexOf(anchor);if(start<0||end<=start)fail();
 const prefix=count.slice(start,end).trim().replace(/,$/,'');
 const code=prefix.replace(/--[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
 if(/\b(?:UPDATE|DELETE|INSERT|MERGE|CALL|COPY|CREATE|ALTER|DROP|TRUNCATE)\b|;/i.test(code)||!/^WITH\s/.test(code)||(code.match(/\bpostContexts AS (?:MATERIALIZED )?\(/g)||[]).length!==1||count.slice(0,start).replace(/--[^\n]*/g,'').trim())fail();
 return prefix+'\nSELECT campaign_id,to_send,max_subscriber_id FROM postContexts WHERE same_context;\n';
}
function validate(a,data,source){
 wrapper(a);if(!Buffer.isBuffer(data)||data.length!==a.readReceipt.bytes||sha(data)!==a.readReceipt.sha256)fail();
 for(const k of ['kernelSha256','countReadSha256','recipientReadSha256'])if(a.expected[k]!==source[k])fail();
 const report=JSON.parse(data);
 const allowed=['schema','preparedPurpose','statementTimeoutMs','actualWorkerStatementBudgetMs','originalPerformanceAccepted','fullRecipientDispatchProved','readOnly','operational','causeEstablished','runtimeChanged','campaignsChanged','functionsChanged','kernelSha256','recipientPreviewOnly','recipientSectionComplete','replayAllowed','results','completed','reason','rootReadAt','payloadSha256','transportExitCode','transportStderrPresent','transportStderrBytes','transportStdoutBytes'];
 if(!report||Object.getPrototypeOf(report)!==Object.prototype||Object.keys(report).some(k=>!allowed.includes(k)))fail();
 const gate=path.join(__dirname,'joint_read_gate.cjs');if(fs.realpathSync(gate)!==gate||!fs.lstatSync(gate).isFile()||sha(fs.readFileSync(gate))!=='c9de15e1c023e00b156d87ff65a9b3aca92dc2cec6df2182c92cfdae43b509d8')fail();
 return require('./joint_read_gate.cjs').validateJointRead(report,a.expected);
}
module.exports=Object.freeze({wrapper,countReadSQL,validate});
