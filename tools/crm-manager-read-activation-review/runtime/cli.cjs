'use strict';
// No work on import. Future disposable service invocation ONLY after explicit approval.
const {createRuntime,intent}=require('./runtime.cjs'),{createJournal}=require('./journal.cjs');
const DESTINATION=Object.freeze({host:'comunicacao_postgres',port:5432,database:'listmonk',user:'postgres',ssl:false});
async function main(){
 let password,verifier,client;
 try{
  if(process.versions.node.split('.')[0]!=='22'||process.getuid?.()!==1000||process.getgid?.()!==1000||process.env.READ_ACTIVATION_RUNTIME_OPT_IN!=='1')throw Error();
  const mode=process.env.READ_ACTIVATION_MODE,action=process.env.READ_ACTIVATION_ACTION;
  if(!['execute','reconcile'].includes(mode)||mode==='execute'&&process.env.READ_ACTIVATION_APPROVED_ACTION!==action||mode==='reconcile'&&process.env.READ_ACTIVATION_APPROVED_ACTION!=='readonly-reconcile')throw Error();
  const i=intent({schema:'crm-manager-read-runtime-intent-v1',operationId:process.env.READ_ACTIVATION_OPERATION_ID,credentialIntentId:process.env.READ_CREDENTIAL_INTENT_ID,action,fromPhase:process.env.READ_ACTIVATION_FROM_PHASE});
  password=process.env.PG_ADMIN_PASSWORD;verifier=process.env.READ_SERVICE_SCRAM;
  delete process.env.PG_ADMIN_PASSWORD;delete process.env.READ_SERVICE_SCRAM;
  if(typeof password!=='string'||password.length<1||password.length>1024||password.includes('\0'))throw Error();
  const pg=require('pg');if(require('pg/package.json').version!=='8.13.1')throw Error();
  const journal=createJournal('/runtime-proof');
  const runtime=createRuntime({journal,connect:async()=>{
   client=new pg.Client({...DESTINATION,password,application_name:'shrigma-read-activation-single-attempt',connectionTimeoutMillis:5000,query_timeout:5000});
   // Never forward native error text, SQL, parameters or stack to stdout/stderr.
   client.on('error',()=>{});
   try{await client.connect();return client;}catch{try{await client.end();}catch{}throw Error('READ_ACTIVATION_RUNTIME_REFUSED');}
  }});
  const result=await runtime[mode](i,{verifier});
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode=result.state==='confirmed'?0:2;
 }catch{process.stderr.write('READ_ACTIVATION_RUNTIME_REFUSED\n');process.exitCode=1;}
 finally{password='';verifier='';delete process.env.PG_ADMIN_PASSWORD;delete process.env.READ_SERVICE_SCRAM;try{await client?.end();}catch{}}
}
if(require.main===module)main();
module.exports=Object.freeze({DESTINATION,main});
