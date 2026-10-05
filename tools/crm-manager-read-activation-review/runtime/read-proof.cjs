'use strict';
const {createJournal}=require('./journal.cjs'),A=require('./activation.cjs');
function fail(){throw Error('READ_ACTIVATION_PROOF_REFUSED');}
function readProof(journal,id){
 const h=journal.readDurable(id),i=h.intent,expected={stage:'staged',activate:'active',disable:'disabled'}[i.action],last=h.events.at(-1);
 if(!expected||last?.kind!=='readback'||last.state!=='confirmed'||last.phase!==expected)fail();
 return Object.freeze({schema:'crm-manager-read-runtime-result-v1',action:i.action,state:'confirmed',phase:expected,coreVerified:true,credentialBound:i.action!=='disable',commitAck:h.events.some(e=>e.kind==='commit_ack')});
}
function acceptProof(raw,action){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>2048)fail();const p=JSON.parse(raw),keys=['schema','action','state','phase','coreVerified','credentialBound','commitAck'];
 if(!p||Object.keys(p).length!==keys.length||keys.some(k=>!Object.hasOwn(p,k))||p.schema!=='crm-manager-read-runtime-result-v1'||p.action!==action||p.state!=='confirmed'||p.phase!==({stage:'staged',activate:'active',disable:'disabled'}[action])||p.coreVerified!==true||p.credentialBound!==(action!=='disable')||typeof p.commitAck!=='boolean')fail();return Object.freeze(p);
}
function main(){
 for(const k of ['PG_ADMIN_PASSWORD','READ_SERVICE_SCRAM'])delete process.env[k];
 try{if(process.getuid?.()!==1000||process.getgid?.()!==1000||process.versions.node.split('.')[0]!=='22'||process.argv.length!==3)fail();const p=readProof(createJournal('/runtime-proof'),process.argv[2]);process.stdout.write(JSON.stringify(p)+'\n');}
 catch{process.stderr.write('READ_ACTIVATION_PROOF_REFUSED\n');process.exitCode=1;}
}
if(require.main===module)main();
module.exports=Object.freeze({readProof,acceptProof});
