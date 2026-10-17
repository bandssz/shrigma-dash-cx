'use strict';
const DB_USER='crm_audience_api';
const fail=code=>Object.assign(Error(code),{code});

function createTransaction({pool,statementTimeoutMs=10000,role=DB_USER}={}){
 if(typeof pool?.connect!=='function'||!Number.isInteger(statementTimeoutMs)||statementTimeoutMs<1||statementTimeoutMs>30000||role!==DB_USER)throw fail('CRM_AUDIENCE_TRANSACTION_CONFIG');
 let active=0;const waiters=new Set();
 const settled=()=>{if(active===0){for(const resolve of waiters)resolve();waiters.clear();}};
 async function transaction(work,{signal,readOnly=false,isolation='read committed'}={}){
  if(typeof work!=='function'||signal!==undefined&&!(signal instanceof AbortSignal)||typeof readOnly!=='boolean'||isolation!=='read committed')throw fail('CRM_AUDIENCE_TRANSACTION_INPUT');
  if(signal?.aborted)throw fail('CRM_AUDIENCE_TRANSACTION_ABORTED');
  active++;let client,destroy=false,begun=false;
  try{
   client=await pool.connect();
   if(signal?.aborted)throw fail('CRM_AUDIENCE_TRANSACTION_ABORTED');
   await client.query(`BEGIN ISOLATION LEVEL READ COMMITTED ${readOnly?'READ ONLY':'READ WRITE'}`);begun=true;
   await client.query(`SET LOCAL statement_timeout='${statementTimeoutMs}ms'`);
   const identity=await client.query('SELECT current_user AS role');
   if(identity?.rows?.length!==1||identity.rows[0]?.role!==role)throw fail('CRM_AUDIENCE_TRANSACTION_ROLE');
   const tx=Object.freeze({query:async(text,values=[],options={})=>{
    if(signal?.aborted)throw fail('CRM_AUDIENCE_TRANSACTION_ABORTED');
    if(typeof text!=='string'||!Array.isArray(values)||!options||typeof options!=='object'||Array.isArray(options))throw fail('CRM_AUDIENCE_TRANSACTION_QUERY');
    const signals=[signal,options.signal].filter(Boolean);if(signals.some(x=>!(x instanceof AbortSignal)))throw fail('CRM_AUDIENCE_TRANSACTION_QUERY');
    const querySignal=signals.length>1?AbortSignal.any(signals):signals[0];
    const result=await client.query(querySignal?{text,values,signal:querySignal}:{text,values});
    if(signal?.aborted)throw fail('CRM_AUDIENCE_TRANSACTION_ABORTED');return result;
   }});
   const result=await work(tx);
   if(signal?.aborted)throw fail('CRM_AUDIENCE_TRANSACTION_ABORTED');
   try{const committed=await client.query('COMMIT');if(committed?.command!=='COMMIT')throw fail('CRM_AUDIENCE_COMMIT_UNCONFIRMED');}catch(e){destroy=true;throw fail('CRM_AUDIENCE_COMMIT_UNCONFIRMED');}
   begun=false;return result;
  }catch(e){
   destroy=true;
   if(client&&begun){try{await client.query('ROLLBACK');}catch{}}
   throw e;
  }finally{
   if(client){try{client.release(destroy);}catch{}}
   active--;settled();
  }
 }
 transaction.active=()=>active;
 transaction.drain=()=>active===0?Promise.resolve():new Promise(resolve=>waiters.add(resolve));
 return Object.freeze(transaction);
}
module.exports={createTransaction,DB_USER};
