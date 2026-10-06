'use strict';
// Explicit synthetic connected-session model for unit tests ONLY.
// No native SQL engine, durability, locking, isolation or production authority.
const C=require('../../services/dashboard-operational/domain/crm-mvp-controls-persistence/codec.cjs');
const SQL=require('../../services/dashboard-operational/domain/crm-mvp-controls-persistence/sql.cjs');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const H='a'.repeat(64),E='b'.repeat(64),NOW=10000;
const identity=(brand='fish',n=1)=>({brand,operationId:uuid(n),attemptId:uuid(n)});
const registration=i=>({...i,principalRefHash:H,registrationEvidenceHash:E});
const key=i=>`${i.brand}/${i.operationId}`;
function registered(i=identity()){return C.body({...i,principalRefHash:H,registrationEvidenceHash:E,revision:1,state:'registered',reservationAttempted:false,outcomeWriteState:'idle',registeredAt:1,updatedAt:1,scope:null,reservation:false,reservedMemberCount:null,reservedMembersHash:null,capacityEvidenceHash:null});}
function reserved(i=identity(),delta={}){const scope={brand:i.brand,operationId:i.operationId,distributionId:uuid(3),selectionHash:H,membersHash:H,memberCount:2,campaignId:1,campaignVersion:1,ledgerRevision:1,evidenceRevision:1,evidenceHash:E,expiresAt:2};return C.body({...registered(i),revision:2,state:'reserved',reservationAttempted:true,scope,reservation:true,reservedMemberCount:2,reservedMembersHash:H,capacityEvidenceHash:E,...delta});}
function database(){return {operations:new Map(),intents:new Map()};}
function seed(db,body){db.operations.set(key(body),C.encode(body));}
function client(db=database()){
 let working=null,readOnly=false;
 const logs=[],owned={connect:0,end:0,release:0},connection={logs,owned,authLease:Object.freeze({sentinel:'synthetic-owned-by-Root'}),before:null,after:null};
 const result=(command,rows=[])=>({command,rows:structuredClone(rows),rowCount:['SELECT','INSERT','UPDATE'].includes(command)?rows.length:null});
 connection.query=async(sql,params=[])=>{
  logs.push({sql,params:structuredClone(params)});if(connection.before)await connection.before(sql,params);
  let r;
  if(sql===SQL.BEGIN_READ||sql===SQL.BEGIN_WRITE){if(working)throw Object.assign(Error('synthetic overlapping transaction'),{code:'25001'});working=structuredClone(db);readOnly=sql===SQL.BEGIN_READ;r=result('BEGIN');}
  else if(sql===SQL.ROLLBACK){working=null;r=result('ROLLBACK');}
  else if(sql===SQL.COMMIT){if(!working)throw Error('synthetic no transaction');if(!readOnly){db.operations=working.operations;db.intents=working.intents;}working=null;r=result('COMMIT');}
  else{
   if(!working)throw Error('synthetic no transaction');
   const [brand,op,attempt]=params,k=`${brand}/${op}`,row=working.operations.get(k);
   const selected=row&&row.attempt_id===attempt?row:null;
   if(sql===SQL.READ||sql===SQL.LOCK)r=result('SELECT',selected?[selected]:[]);
   else if(sql===SQL.LOCK_INTENT){const intent=working.intents.get(`${k}/${params[3]}`);r=result('SELECT',intent?[intent]:[]);}
   else{
    if(readOnly)throw Object.assign(Error('synthetic read-only'),{code:'25006'});
    let rows=[];
    if(sql===SQL.INSERT){if(!row){const i={brand,operationId:op,attemptId:attempt};const body=C.body({...registered(i),principalRefHash:params[3],registrationEvidenceHash:params[4],registeredAt:Number(params[5]),updatedAt:Number(params[5])});const inserted={...C.encode(body),receipt_hash:params[6]};working.operations.set(k,inserted);rows=[inserted];}r=result('INSERT',rows);}
    else if(sql===SQL.INSERT_INTENT){const ik=`${k}/${params[3]}`;if(!working.intents.has(ik)){const intent={brand,operation_id:op,attempt_id:attempt,expected_operation_revision:params[3],target_outcome:params[4],evidence_hash:params[5],prior_scope_hash:params[6],created_at:params[7],phase:'pending'};working.intents.set(ik,intent);rows=[intent];}r=result('INSERT',rows);}
    else if(sql===SQL.FINISH_INTENT){const ik=`${k}/${params[3]}`,intent=working.intents.get(ik);if(intent&&intent.phase==='pending'&&intent.target_outcome===params[4]&&intent.evidence_hash===params[5]&&intent.prior_scope_hash===params[6]){const finished={...intent,phase:'finished'};working.intents.set(ik,finished);rows=[finished];}r=result('UPDATE',rows);}
    else if([SQL.CONSUME,SQL.PENDING,SQL.FINISH].includes(sql)){
     if(selected){const b=C.decode(selected),revision=Number(params[3]);let change=null,hash;
      if(sql===SQL.CONSUME&&b.state==='registered'&&!b.reservationAttempted&&b.revision===revision&&b.receiptHash===params[6]){change={reservationAttempted:true,revision:revision+1,updatedAt:Number(params[4])};hash=params[5];}
      if(sql===SQL.PENDING&&['reserved','uncertain'].includes(b.state)&&b.outcomeWriteState==='idle'&&b.revision===revision&&b.receiptHash===params[6]){change={outcomeWriteState:'pending',updatedAt:Number(params[4])};hash=params[5];}
      if(sql===SQL.FINISH&&['reserved','uncertain'].includes(b.state)&&b.outcomeWriteState==='pending'&&b.revision===revision&&b.receiptHash===params[7]&&C.scopeHash(b.scope)===C.scopeHash(JSON.parse(params[8]))){change={state:params[4],revision:revision+1,outcomeWriteState:'idle',updatedAt:Number(params[5])};hash=params[6];}
      if(change){const changed={...C.encode(C.change(b,change)),receipt_hash:hash};working.operations.set(k,changed);rows=[changed];}
     }r=result('UPDATE',rows);
    }else throw Error('only declared fixed SQL accepted by synthetic session');
   }
  }
  return connection.after?connection.after(sql,r):r;
 };
 for(const method of ['connect','end','release'])connection[method]=()=>{owned[method]++;throw Error('borrowed client must not be owned by foundation');};
 return connection;
}
const options=c=>({enabled:true,client:c,verifyRegistration:async i=>i,verifyOutcome:async i=>({brand:i.brand,operationId:i.operationId,attemptId:i.attemptId,outcome:i.outcome,evidenceHash:H}),clock:()=>NOW});
module.exports={C,SQL,uuid,H,E,NOW,identity,registration,key,registered,reserved,database,seed,client,options};
