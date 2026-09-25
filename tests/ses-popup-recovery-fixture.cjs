'use strict';
const fs=require('node:fs'),path=require('node:path');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const SHIM="CREATE FUNCTION digest(data bytea,algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT decode(md5(data),'hex')$$;";
const SCHEMA=`
CREATE TABLE subscribers(id serial PRIMARY KEY,email text UNIQUE,status text,attribs jsonb DEFAULT '{}',updated_at timestamptz);
CREATE TABLE shrigma_send_log(id bigserial PRIMARY KEY,email text,brand text,kind text,flow text,channel text,piece text,template_id int,ref text,sent_at timestamptz DEFAULT clock_timestamp(),subscriber_id int,UNIQUE(brand,flow,channel,piece,ref));
CREATE TABLE shrigma_email_dispatch(dispatch_id uuid PRIMARY KEY,brand text,flow text,piece text,dedupe_key text,payload_sha256 text,account_id text,region text,configuration_set text,recipient_key text,recipient_key_version text,is_test boolean,transport_state text,started_at timestamptz,claim_token uuid,outcome_at timestamptz,accepted_at timestamptz,send_log_id bigint REFERENCES shrigma_send_log(id),error_code text,UNIQUE(brand,flow,piece,dedupe_key));
CREATE TABLE shrigma_email_transport_evidence(dispatch_id uuid PRIMARY KEY REFERENCES shrigma_email_dispatch(dispatch_id),context jsonb);
CREATE TABLE shrigma_email_event_ingest(ingest_id uuid PRIMARY KEY,event_payload jsonb,message_sha256 text,sns_message_id text,topic_arn text,result text);
CREATE TABLE shrigma_email_status(event_key text PRIMARY KEY,first_ingest_id uuid REFERENCES shrigma_email_event_ingest(ingest_id),account_id text,region text,message_id text,status text,recipient_key text,recipient_key_version text,dispatch_id_claim uuid,dispatch_id uuid REFERENCES shrigma_email_dispatch(dispatch_id),is_test_claim boolean,is_test boolean,reconciliation_status text);
CREATE TABLE shrigma_email_queue_receipt(ingest_id uuid REFERENCES shrigma_email_event_ingest(ingest_id),body_sha256 text,body_raw text);
CREATE TABLE shrigma_email_message_link(account_id text,region text,message_id text,dispatch_id uuid REFERENCES shrigma_email_dispatch(dispatch_id));
CREATE TABLE templates(id int,type text);CREATE TABLE shrigma_template_email_registry(template_id int,brand text);
${SHIM}
CREATE FUNCTION shrigma_email_recipient_key(address text) RETURNS TABLE(recipient_key text,key_version text) LANGUAGE sql AS $$SELECT encode(digest(convert_to(lower(address)||':synthetic-pepper','UTF8'),'sha256'),'hex'),'fixture-v1'$$;
CREATE FUNCTION shrigma_flow_slot(text,text,text,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{"_managed":false}'::jsonb$$;
CREATE FUNCTION shrigma_nps_initial_confirmed(text,text,text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
`;
const SQL=read('n8n/growth/ses-popup-recovery.sql');
const one=async(db,q,p=[])=>(await db.query(q,p)).rows[0];
async function setup(db,real=false){const schema=real?SCHEMA.replace(SHIM,'CREATE EXTENSION pgcrypto;').replace("digest(convert_to(lower(address)||':synthetic-pepper','UTF8'),'sha256')","hmac(convert_to(lower(address),'UTF8'),convert_to('synthetic-pepper','UTF8'),'sha256')"):SCHEMA;await db.exec(schema);await db.exec(read('n8n/growth/ses-engagement.sql'));await db.exec(SQL);}
let n=0;
async function seed(db,{brand='aristo',state='in_flight'}={}){
 const counter=++n,email=`popup-fixture-${counter}@example.invalid`,ref=`popup-execution:${counter}`,tpl=brand==='fish'?23:22;
 await db.query("INSERT INTO subscribers(email,status,attribs) VALUES($1,'enabled','{\"marker\":\"preserved\"}')",[email]);
 const payload={brand,email,ref,piece:'cupom-boas-vindas',tx:{template_id:tpl,subscriber_email:email,content_type:'html',from_email:'pedidos@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com'),data:{first_name:'Fixture'}}};
 const claim=await one(db,'SELECT * FROM shrigma_email_claim_engagement($1::jsonb)',[JSON.stringify(payload)]);
 await db.query("UPDATE shrigma_email_dispatch SET started_at=clock_timestamp()-interval '1 hour',transport_state=$2 WHERE dispatch_id=$1",[claim.dispatch_id,state]);
 const d=await one(db,"SELECT *,started_at+interval '3 seconds' AS mailed_at,started_at+interval '4 seconds' AS delivered_at FROM shrigma_email_dispatch WHERE dispatch_id=$1",[claim.dispatch_id]);
 const message=`fixture-message-${counter}`;
 await db.query('INSERT INTO shrigma_email_message_link VALUES($1,$2,$3,$4)',[d.account_id,d.region,message,d.dispatch_id]);
 for(const status of ['send','delivery']){
  const ev={eventType:status==='send'?'Send':'Delivery',mail:{messageId:message,sendingAccountId:d.account_id,timestamp:d.mailed_at,destination:[email],tags:{crm_dispatch_id:[d.dispatch_id],crm_test:['false'],'ses:configuration-set':[d.configuration_set]}}};
  if(status==='delivery')ev.delivery={timestamp:d.delivered_at,recipients:[email]};
  const ing=(await one(db,'SELECT gen_random_uuid() AS id')).id,sns=`fixture-sns-${counter}-${status}`,topic='arn:aws:sns:us-east-2:379757086665:shrigma-ses-events';
  const raw=JSON.stringify({TopicArn:topic,MessageId:sns,Message:JSON.stringify(ev)}),hash=(await one(db,"SELECT encode(digest(convert_to($1,'UTF8'),'sha256'),'hex') AS hash",[raw])).hash;
  await db.query("INSERT INTO shrigma_email_event_ingest VALUES($1,$2::jsonb,$3,$4,$5,'processed')",[ing,JSON.stringify(ev),hash,sns,topic]);
  await db.query('INSERT INTO shrigma_email_queue_receipt VALUES($1,$2,$3)',[ing,hash,raw]);
  await db.query("INSERT INTO shrigma_email_status VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,false,false,'matched')",[`${counter}-${status}`,ing,d.account_id,d.region,message,status,d.recipient_key,d.recipient_key_version,d.dispatch_id]);
 }
 return {id:d.dispatch_id,d,claim,payload,email,ref,message};
}
async function changeEvent(db,s,status,change){
 const r=await one(db,'SELECT i.* FROM shrigma_email_event_ingest i JOIN shrigma_email_status s ON s.first_ingest_id=i.ingest_id WHERE s.dispatch_id=$1 AND s.status=$2',[s.id,status]);
 change(r.event_payload);const raw=JSON.stringify({TopicArn:r.topic_arn,MessageId:r.sns_message_id,Message:JSON.stringify(r.event_payload)}),hash=(await one(db,"SELECT encode(digest(convert_to($1,'UTF8'),'sha256'),'hex') AS hash",[raw])).hash;
 await db.query('UPDATE shrigma_email_event_ingest SET event_payload=$2::jsonb,message_sha256=$3 WHERE ingest_id=$1',[r.ingest_id,JSON.stringify(r.event_payload),hash]);
 await db.query('UPDATE shrigma_email_queue_receipt SET body_raw=$2,body_sha256=$3 WHERE ingest_id=$1',[r.ingest_id,raw,hash]);
}
const recover=(db,s,dry=true)=>one(db,'SELECT * FROM shrigma_email_recover_popup_delivery_v1($1,$2)',[s.id,dry]);
module.exports={SCHEMA,SQL,setup,seed,changeEvent,one,recover,read};
