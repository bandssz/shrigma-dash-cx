'use strict';
// This health process receives the container environment too: remove the
// administrative entries before a local request. It never loads pg or SQL.
for(const k of Object.keys(process.env))if(k.startsWith('PG')||k==='DATABASE_URL')delete process.env[k];
const {acceptedProof}=require('./supervisor.cjs');
const action=process.argv[2];
if(!['install','verify','rollback'].includes(action)||process.argv.length!==3||process.getuid()!==1000){process.exitCode=1;}
else{
 let bytes=0,raw='';
 const req=require('node:http').get({host:'127.0.0.1',port:8099,path:'/status',timeout:1500},res=>{
  res.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>20000)req.destroy();else raw+=chunk.toString('utf8');});
  res.on('end',()=>{try{const s=JSON.parse(raw);if(res.statusCode!==200||Object.keys(s).sort().join(',')!==['schema','action','state','childExitConfirmed','proofBarrierConfirmed','proof'].sort().join(',')||s.schema!=='crm-manager-install-supervisor-v1'||s.action!==action||s.state!=='verified'||s.childExitConfirmed!==true||s.proofBarrierConfirmed!==true)throw Error();acceptedProof(s.proof,action);process.exitCode=0;}catch{process.exitCode=1;}});
  res.on('error',()=>{process.exitCode=1;});
 });
 req.on('timeout',()=>req.destroy());req.on('error',()=>{process.exitCode=1;});
}
