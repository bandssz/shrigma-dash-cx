'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {createNativeHistory,SQL}=require('../services/crm-campaign/native-history.cjs');
const auth={actor:'panel:synthetic-original',caps:['read_content']},command={acao:'campanha_operacao',brand:'fish',idempotency_key:'synthetic-original-intent'};
function fixture(proof){const calls=[];return {calls,reader:createNativeHistory({query:async(sql,args)=>{calls.push({sql,args});return {rows:[{result:proof}]};}})};}
for(const state of ['succeeded','rejected','outcome_unknown','pending'])test('historical '+state+' is read unchanged and never re-executed',async()=>{
 const operation={id:'synthetic-operation',operation_key:command.idempotency_key,brand:'fish',action:'salvar',state,providerId:185,response:state==='succeeded'?{status:201,body:{original:true}}:null};
 const f=fixture({auth,operation}),r=await f.reader.execute({key:'synthetic-key',auth,command});a.deepEqual(r.body,{operation});a.equal(f.calls.length,1);a.deepEqual(f.calls[0].args,['synthetic-key',auth.actor,command.idempotency_key,'fish']);a.doesNotMatch(f.calls[0].sql,/\b(INSERT|UPDATE|DELETE|FOR SHARE|FOR UPDATE)\b/i);a(!Object.hasOwn(r.body,'recovery'));a(!Object.hasOwn(r.body,'accepted'));
});
test('foreign operations, revoked actor and missing history remain typed denials',async()=>{
 for(const proof of [{auth,operation:{brand:'aristo'}},{auth,operation:null},{auth:null,operation:{brand:'fish'}},{auth:{actor:'panel:other',caps:['read_content']},operation:{brand:'fish'}}]){const f=fixture(proof);await a.rejects(f.reader.execute({key:'synthetic-key',auth,command}),e=>[403,404].includes(e.status));a.equal(f.calls.length,1);}
});
test('lookup without read_content and malformed original nonce do no query',async()=>{
 for(const input of [{auth:{...auth,caps:['list_history','submission']},command},{auth,command:{...command,idempotency_key:'bad\nnonce'}}]){const f=fixture(null);await a.rejects(f.reader.execute({key:'synthetic-key',...input}));a.equal(f.calls.length,0);}
});
test('the prepared query revalidates authority in the same statement and never selects a lease',()=>{
 a.match(SQL,/WITH verified AS MATERIALIZED/);a.match(SQL,/o.actor=\$2::text AND o.operation_key=\$3::text AND o.brand=\$4::text/);a.doesNotMatch(SQL,/\b(lease|request_hash)\b/);
});
