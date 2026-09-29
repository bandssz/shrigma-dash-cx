'use strict';
const fs=require('node:fs'),path=require('node:path');
const {setupRegularDelivery}=require('./segment-regular-delivery-fixture.cjs');
const {SCHEMA}=require('./ses-popup-recovery-fixture.cjs');
const one=async(db,q,p=[])=>(await db.query(q,p)).rows[0];
const exec=(db,q)=>typeof db.exec==='function'?db.exec(q):db.query(q);
async function setupRecovery(db,{realCrypto=false}={}){
 const delivery=await setupRegularDelivery(db);await delivery.enable();
 for(const name of ['shrigma_email_event_ingest','shrigma_email_status','shrigma_email_queue_receipt','shrigma_email_message_link']){
  await exec(db,SCHEMA.match(new RegExp('CREATE TABLE '+name+'\\([^\\n]+;'))[0]);
 }
 await exec(db,realCrypto?'CREATE EXTENSION pgcrypto':"CREATE FUNCTION digest(data bytea,algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT decode(md5(data),'hex')$$;");
 await exec(db,fs.readFileSync(path.resolve(__dirname,'../n8n/growth/segment-regular-recovery.sql'),'utf8'));
 const seed=async(cid,state='outcome_unknown')=>{
  const selected=(await delivery.batch(cid))[0],sid=selected.id;
  const grant=await delivery.claim(cid,sid,{snapshot:selected.crm_delivery_snapshot});
  if(state==='outcome_unknown')await delivery.finish(cid,sid,grant,state);
  await db.query("UPDATE shrigma_email_dispatch SET started_at=clock_timestamp()-interval '1 hour' WHERE dispatch_id=$1",[grant.dispatch_id]);
  const d=await one(db,"SELECT *,started_at+interval '1 second' mailed_at,started_at+interval '2 seconds' delivered_at FROM shrigma_email_dispatch WHERE dispatch_id=$1",[grant.dispatch_id]);
  const email=selected.email,message='fixture-'+d.dispatch_id,topic=`arn:aws:sns:${d.region}:${d.account_id}:shrigma-ses-events`;
  await db.query('INSERT INTO shrigma_email_message_link VALUES($1,$2,$3,$4)',[d.account_id,d.region,message,d.dispatch_id]);
  for(const status of ['send','delivery']){
   const ev={eventType:status==='send'?'Send':'Delivery',mail:{messageId:message,sendingAccountId:d.account_id,timestamp:d.mailed_at,destination:[email],tags:{crm_dispatch_id:[d.dispatch_id],crm_test:['false'],'ses:configuration-set':[d.configuration_set]}}};
   if(status==='delivery')ev.delivery={timestamp:d.delivered_at,recipients:[email]};
   const id=(await one(db,'SELECT gen_random_uuid() id')).id,sns='sns-'+id;
   const raw=JSON.stringify({TopicArn:topic,MessageId:sns,Message:JSON.stringify(ev)});
   const hash=(await one(db,"SELECT encode(digest(convert_to($1,'UTF8'),'sha256'),'hex') hash",[raw])).hash;
   await db.query("INSERT INTO shrigma_email_event_ingest VALUES($1,$2::jsonb,$3,$4,$5,'processed')",[id,JSON.stringify(ev),hash,sns,topic]);
   await db.query('INSERT INTO shrigma_email_queue_receipt VALUES($1,$2,$3)',[id,hash,raw]);
   await db.query("INSERT INTO shrigma_email_status VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,false,false,'matched')",[d.dispatch_id+'-'+status,id,d.account_id,d.region,message,status,d.recipient_key,d.recipient_key_version,d.dispatch_id]);
  }
  return {cid,sid,id:d.dispatch_id,grant};
 };
 const recover=(s,dry=true)=>one(db,'SELECT crm_audience_v2.regular_delivery_recover($1,$2,$3,$4) result',[s.cid,s.sid,s.id,dry]).then(r=>r.result);
 return {...delivery,seed,recover};
}
module.exports={setupRecovery,one,exec};
