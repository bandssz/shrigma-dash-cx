'use strict';
// Disposable structural fixture. No production authority/guard is modified.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const P=require('../n8n/growth/segment-listmonk-selection.cjs');
const {setupRegularPostgres}=require('./segment-listmonk-selection-regular-postgres-fixture.cjs');
const read=p=>fs.readFileSync(path.resolve(__dirname,'..',p),'utf8');
async function setupRegularDelivery(db,options={}){
 const fixture=await setupRegularPostgres(db,{subscribersPerBrand:120,...options}),worker=P.patchRegularWorkerSource(fixture.source);
 const exec=sql=>typeof db.exec==='function'?db.exec(sql):db.query(sql);
 await exec(`ALTER TABLE subscribers ADD COLUMN email text;
  ALTER TABLE subscribers ADD COLUMN created_at timestamptz DEFAULT now();
  ALTER TABLE subscribers ADD COLUMN updated_at timestamptz DEFAULT now();
  UPDATE subscribers SET email='person-'||id||'@example.invalid';`);
 const native=read('tests/sql/journey-cart-fixture.sql');
 await exec(native.match(/CREATE TABLE shrigma_email_dispatch\([^\n]+;/)[0]);
 await exec(native.match(/CREATE FUNCTION shrigma_email_recipient_key\([^\n]+;/)[0]);
 await exec(read('n8n/growth/segment-regular-delivery.sql'));
 await db.query('UPDATE crm_audience_v2.selection_runtime SET candidate_query_sha256=$1',[worker.patched_sha256]);
 await db.query(P.section(worker.source,'next-campaigns').text,[[],[]]);
 await exec(`INSERT INTO crm_audience_v2.regular_delivery_campaign(campaign_id,binding_version,binding_hash,material,worker_sha256,runtime_sha256,envelope_from,account_id,region,configuration_set)
  SELECT c.id,b.binding_version,b.binding_hash,crm_audience_v2.regular_delivery_material(c.id),repeat('a',64),repeat('b',64),'sender@example.invalid','000000000000','fixture','fixture'
  FROM campaigns c JOIN crm_audience_v2.campaign_binding b ON b.campaign_id=c.id;`);
 const snapshot=async sid=>(await db.query('SELECT to_jsonb(s) AS snapshot FROM subscribers s WHERE id=$1',[sid])).rows[0].snapshot;
 const batch=async(cid,{cursor=0,max=fixture.subscribersPerBrand*2,limit=4}={})=>(await db.query(P.section(worker.source,'next-campaign-subscribers').text,[cid,'regular',cursor,max,[cid===100?17:16],limit])).rows;
 const state=async cid=>(await db.query('SELECT sent,last_subscriber_id FROM campaigns WHERE id=$1',[cid])).rows[0];
 const claim=async(cid,sid,{id=randomUUID(),workerHash='a'.repeat(64),runtimeHash='b'.repeat(64),sender='sender@example.invalid',recipient,snapshot:snap}={})=>{
  const s=snap??await snapshot(sid);
  return (await db.query('SELECT crm_audience_v2.regular_delivery_claim($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS result',
   [cid,sid,id,workerHash,runtimeHash,sender,recipient??s.email,'c'.repeat(64),JSON.stringify(s)])).rows[0].result;
 };
 const finish=async(cid,sid,grant,outcome='accepted')=>(await db.query('SELECT crm_audience_v2.regular_delivery_finish($1,$2,$3,$4,$5) AS result',[cid,sid,grant.dispatch_id,grant.claim_token,outcome])).rows[0].result;
 return {fixture,worker,batch,state,snapshot,claim,finish,enable:()=>db.query('UPDATE crm_audience_v2.regular_delivery_campaign SET enabled=true')};
}
module.exports={setupRegularDelivery};
