'use strict';
// Observer availability only; a healthy observer may report outcome_unknown.
for(const k of ['PG_ADMIN_PASSWORD','READ_SERVICE_SCRAM'])delete process.env[k];
let bytes=0,raw='';
const req=require('node:http').get({host:'127.0.0.1',port:8099,path:'/status',timeout:1500},res=>{
 res.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>2048)req.destroy();else raw+=chunk.toString('utf8');});
 res.on('end',()=>{try{const s=JSON.parse(raw),keys=['schema','action','state','childExitConfirmed','proofBarrierConfirmed','proof'];if(res.statusCode!==200||Object.keys(s).length!==keys.length||keys.some(k=>!Object.hasOwn(s,k))||s.schema!=='crm-manager-read-supervisor-v1'||!['stage','activate','disable'].includes(s.action)||!['pending','verified','outcome_unknown','proof_refused'].includes(s.state)||typeof s.childExitConfirmed!=='boolean'||typeof s.proofBarrierConfirmed!=='boolean')throw Error();if(s.state==='verified'){if(!s.childExitConfirmed||!s.proofBarrierConfirmed)throw Error();require('./read-proof.cjs').acceptProof(JSON.stringify(s.proof),s.action);}else if(s.childExitConfirmed||s.proofBarrierConfirmed||s.proof!==null)throw Error();process.exitCode=0;}catch{process.exitCode=1;}});
 res.on('error',()=>{process.exitCode=1;});
});
req.on('timeout',()=>req.destroy());req.on('error',()=>{process.exitCode=1;});
