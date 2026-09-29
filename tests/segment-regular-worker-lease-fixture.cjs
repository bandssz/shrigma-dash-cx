'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {setupRegularDelivery}=require('./segment-regular-delivery-fixture.cjs');
const Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const read=f=>fs.readFileSync(path.resolve(__dirname,'..',f),'utf8');
const unavailable=['purchase.count','purchase.last_date','purchase.amount','purchase.product','signup.origin'];
const catalog=brand=>({currency:null,timezone:null,shop_id:null,fields:[...unavailable.map(key=>({key,available:false,source_hash:null})),...['email.opened','email.clicked'].map(key=>({key,available:true,source_hash:Counter.engagementSourceHash(brand,key)}))],products:[],origins:[]});
async function setupWorkerLease(db){
 const f=await setupRegularDelivery(db,{catalogByBrand:{fish:catalog('fish'),aristo:catalog('aristo')}});
 const exec=sql=>typeof db.exec==='function'?db.exec(sql):db.query(sql);
 const refresh=read('n8n/growth/segment-runtime-access.sql').match(/EXECUTE \$ddl\$(CREATE FUNCTION crm_audience_v2\.refresh_native_catalog[\s\S]*?)\$ddl\$;/);
 if(!refresh)throw Error('NATIVE_CATALOG_FUNCTION_MISSING');
 await exec(refresh[1]);await exec(read('n8n/growth/segment-regular-worker-lease.sql'));
 await db.query('UPDATE crm_audience_v2.selection_runtime SET enabled=false');
 const instance=randomUUID(),worker='a'.repeat(64),runtime='b'.repeat(64);
 const approve=()=>db.query(`UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true,
  worker_sha256=$1,runtime_sha256=$2,query_sha256=$3,database_role=session_user,
  approved_at=clock_timestamp(),approved_by='fixture-only',topology_receipt_sha256=repeat('f',64)`,[worker,runtime,f.worker.patched_sha256]);
 const heartbeat=async(id=instance,w=worker,r=runtime)=>(await db.query('SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) AS result',[id,w,r])).rows[0].result;
 const liveClaim=async(cid,sid,{id=instance,w=worker,r=runtime,snapshot,configurationSet='fixture'}={})=>{
  const sub=snapshot??await f.snapshot(sid);
  return (await db.query('SELECT crm_audience_v2.regular_delivery_claim_live($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::jsonb,$11) AS result',
   [id,cid,sid,randomUUID(),w,r,'sender@example.invalid',sub.email,'c'.repeat(64),JSON.stringify(sub),configurationSet])).rows[0].result;
 };
 const lease=async()=>(await db.query('SELECT * FROM crm_audience_v2.regular_worker_lease')).rows[0];
 return {...f,workerQuery:f.worker,instance,worker,runtime,approve,heartbeat,liveClaim,lease};
}
module.exports={setupWorkerLease};
