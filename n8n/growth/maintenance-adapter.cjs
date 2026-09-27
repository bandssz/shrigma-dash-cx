'use strict';
// Trusted server only. Each query is one implicit transaction: no HTTP/retries.
// A query result may be acknowledged only after its Promise has fulfilled.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function error(code){return Object.assign(new Error(code),{code});}
function uuid(id){if(typeof id!=='string'||!UUID.test(id))throw error('MAINTENANCE_ID');return id;}
function createMaintenanceAdapter(db){
 if(!db||typeof db.query!=='function')throw error('MAINTENANCE_DATABASE');
 async function one(sql,params){
  let result;try{result=await db.query(sql,params);}catch(e){
   // No original error, SQL, PII or payload goes into this boundary's errors.
   if(e?.code==='P0001'&&/^MAINTENANCE_[A-Z_]+$/.test(e.message||''))throw error(e.message);
   throw error('MAINTENANCE_UNCONFIRMED');
  }
  if(!Array.isArray(result?.rows)||result.rows.length!==1)throw error('MAINTENANCE_UNCONFIRMED');
  return result.rows[0];
 }
 return Object.freeze({
  async admit(brand,kind,normalized){
   if(!['fish','aristo'].includes(brand)||!['cart','transactional','popup'].includes(kind))throw error('MAINTENANCE_INPUT');
   let body;try{body=JSON.stringify(normalized);}catch{throw error('MAINTENANCE_INPUT');}
   if(typeof body!=='string'||Buffer.byteLength(body,'utf8')>131072)throw error('MAINTENANCE_INPUT');
   const {receipt}=await one('SELECT crm_maintenance_candidate.admit_v1($1,$2,$3::jsonb) AS receipt',[brand,kind,body]);
   if(receipt?.contract!=='growth-maintenance-retention-v1'||receipt.persisted!==true||receipt.authorizes_send!==false||receipt.brand!==brand||!UUID.test(receipt.event_id||''))throw error('MAINTENANCE_UNCONFIRMED');
   return receipt;
  },
  async claim(eventId){
   const row=await one('SELECT * FROM crm_maintenance_candidate.claim_v1($1::uuid)',[uuid(eventId)]);
   if(row.event_id!==eventId||typeof row.should_send!=='boolean')throw error('MAINTENANCE_UNCONFIRMED');
   if(row.should_send){if(!UUID.test(row.dispatch_id||'')||!UUID.test(row.claim_token||'')||!row.payload||!row.context)throw error('MAINTENANCE_UNCONFIRMED');}
   else if(row.claim_token!==null||row.payload!==null||row.context!==null)throw error('MAINTENANCE_UNCONFIRMED');
   return row;
  },
  async control(operationId,expectedVersion,enabled,mode){
   if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||typeof enabled!=='boolean'||!['open','closed'].includes(mode))throw error('MAINTENANCE_CONTROL_INPUT');
   const {receipt}=await one('SELECT crm_maintenance_candidate.control_v1($1::uuid,$2::integer,$3::boolean,$4::text) AS receipt',[uuid(operationId),expectedVersion,enabled,mode]);
   if(receipt?.contract!=='growth-maintenance-control-v1'||receipt.drained!==false||receipt.authorizes_send!==false)throw error('MAINTENANCE_UNCONFIRMED');
   return receipt;
  },
  async reconcile(eventId){
   const {receipt}=await one('SELECT crm_maintenance_candidate.reconcile_v1($1::uuid) AS receipt',[uuid(eventId)]);
   if(receipt?.event_id!==eventId||receipt.authorizes_send!==false||receipt.drained!==false)throw error('MAINTENANCE_UNCONFIRMED');return receipt;
  }
 });
}
module.exports={createMaintenanceAdapter};
