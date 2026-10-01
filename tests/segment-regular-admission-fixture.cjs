'use strict';
const {randomUUID}=require('node:crypto');
const F=require('./segment-campaign-binding-fixture.cjs'),A=require('./segment-audience-store-fixture.cjs');
const C=require('../n8n/growth/campaign-contract.js'),T=require('../n8n/growth/campaign-tracking.js');
const R=require('../n8n/growth/segment-regular-admission.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs');
const read=A.read;
async function setup(db){
 const f=await F.setup(db,{countProvider:Counter.countAudience});
 await db.exec(`UPDATE shrigma_panel_permission_v1 SET caps=caps||'["validate","submit"]'::jsonb WHERE principal_id='manager';
 ALTER TABLE campaigns ADD COLUMN uuid uuid NOT NULL DEFAULT gen_random_uuid(),ADD COLUMN to_send integer NOT NULL DEFAULT 0,
 ADD COLUMN max_subscriber_id integer NOT NULL DEFAULT 0,ADD COLUMN last_subscriber_id integer NOT NULL DEFAULT 0,
 ADD COLUMN archive_slug text,ADD COLUMN archive_template_id integer,ADD COLUMN archive_meta jsonb NOT NULL DEFAULT '{}',ADD COLUMN created_at timestamptz DEFAULT now();
 ALTER TABLE templates ADD COLUMN subject text NOT NULL DEFAULT 'Synthetic subject',ADD COLUMN body_source text,ADD COLUMN is_default boolean NOT NULL DEFAULT false,ADD COLUMN created_at timestamptz DEFAULT now();
 ALTER TABLE lists ADD COLUMN uuid uuid NOT NULL DEFAULT gen_random_uuid(),ADD COLUMN type text NOT NULL DEFAULT 'private',ADD COLUMN description text NOT NULL DEFAULT '',ADD COLUMN created_at timestamptz DEFAULT now(),ADD COLUMN updated_at timestamptz DEFAULT now();
 ALTER TABLE media ADD COLUMN uuid uuid NOT NULL DEFAULT gen_random_uuid(),ADD COLUMN provider text NOT NULL DEFAULT 'filesystem',ADD COLUMN content_type text NOT NULL DEFAULT 'application/pdf',ADD COLUMN thumb text NOT NULL DEFAULT '',ADD COLUMN meta jsonb NOT NULL DEFAULT '{}',ADD COLUMN created_at timestamptz DEFAULT now();
 ALTER TABLE campaign_lists ADD CONSTRAINT admission_cl_fk FOREIGN KEY(campaign_id) REFERENCES campaigns(id);
 ALTER TABLE campaign_media ADD CONSTRAINT admission_cm_fk FOREIGN KEY(campaign_id) REFERENCES campaigns(id);
 CREATE TABLE campaign_views(campaign_id integer,subscriber_id integer,created_at timestamptz NOT NULL);
 CREATE TABLE link_clicks(campaign_id integer,subscriber_id integer,created_at timestamptz NOT NULL);`);
 const native=read('tests/sql/journey-cart-fixture.sql');
 await db.exec(native.match(/CREATE TABLE shrigma_email_dispatch\([^\n]+;/)[0]);
 await db.exec(native.match(/CREATE FUNCTION shrigma_email_recipient_key\([^\n]+;/)[0]);
 await db.exec(read('n8n/growth/segment-runtime-access.sql'));
 for(const brand of ['fish','aristo']){
  const catalog={currency:null,timezone:null,shop_id:null,fields:[...['purchase.count','purchase.last_date','purchase.amount','purchase.product','signup.origin'].map(key=>({key,available:false,source_hash:null})),...['email.opened','email.clicked'].map(key=>({key,available:true,source_hash:Counter.engagementSourceHash(brand,key)}))],products:[],origins:[]};
  await db.query('UPDATE crm_audience_v2.config SET catalog=$2::jsonb WHERE brand=$1',[brand,JSON.stringify(catalog)]);
  f.catalogHashes[brand]=(await f.call({acao:'segmentos_listar',brand,limit:50,offset:0})).body.catalog.catalog_hash;
 }
 for(const file of ['segment-listmonk-selection.sql','segment-regular-readiness.sql','segment-regular-delivery.sql','segment-regular-worker-lease.sql','segment-regular-operation-guard.sql','segment-regular-admission.sql'])await db.exec(read('n8n/growth/'+file));
 for(const [brand,cid]of [['fish',100],['aristo',200]]){
  const c=await f.current(cid),catalog=(await db.query("SELECT shrigma_campaign_provider('catalog',jsonb_build_object('brand',$1::text)) AS v",[brand])).rows[0].v;
  const domain=brand==='fish'?'fishermans.com.br':'oaristocrata.com';
  const p=C.prepare({...c.definition,html:'<p><a href="https://'+domain+'/collections/all">Loja</a> {{ UnsubscribeURL }}</p>',text:'Loja https://'+domain+'/collections/all {{ UnsubscribeURL }}'},{catalog,tracking:T,trackingId:cid});
  await db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(cid)]);await tx.query('DELETE FROM campaign_media WHERE campaign_id=$1',[cid]);await tx.query("UPDATE campaigns SET body=$2,altbody=$3,attribs=$4::jsonb,headers=jsonb_build_array(jsonb_build_object('Reply-To',$5::text)) WHERE id=$1",[cid,p.payload.body,p.payload.altbody,JSON.stringify(p.payload.attribs),p.definition.reply_to]);});
  const a=await f.createAudience(brand,'admission-'+brand,{op:'in_list',list_id:brand==='fish'?101:201}),i=await f.inspect(brand,cid,a);
  const bound=await f.bind(i.body.intent,'admission-bind-'+brand);if(bound.status!==201)throw Error(JSON.stringify(bound));
  await db.query("INSERT INTO crm_audience_v2.regular_sender_policy VALUES($1,$2,'000000000000','fixture','fixture',false)",[brand,'contato@'+domain]);
 }
 const instance=randomUUID(),worker='a'.repeat(64),runtime='b'.repeat(64);
 const approve=async()=>{
  await db.query("UPDATE crm_audience_v2.regular_sender_policy SET enabled=true");
  await db.query("UPDATE crm_audience_v2.regular_worker_deployment SET enabled=true,worker_sha256=$1,runtime_sha256=$2,query_sha256='084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d',database_role=session_user,approved_at=clock_timestamp(),approved_by='fixture-only',topology_receipt_sha256=repeat('f',64)",[worker,runtime]);
  await db.query('SELECT crm_audience_v2.regular_worker_heartbeat($1,$2,$3)',[instance,worker,runtime]);
 };
 const service=R.createRegularAdmission({transaction:f.transaction,countProvider:Counter.countAudience,refreshCatalog:({query,brand})=>query('SELECT crm_audience_v2.refresh_native_catalog($1)',[brand])});
 const call=async(p,key='synthetic-manager-key')=>{const r=await service.execute({request:p,key});return {status:r._http,body:r._body};};
 const prepareRequest=async(brand='fish')=>{const b=await f.bound(brand==='fish'?100:200);return {acao:R.ACTIONS.prepare,brand,campaign_id:b.campaign_id,expected_campaign_version:b.campaign_version,expected_binding_version:b.binding_version,expected_binding_hash:b.binding_hash};};
 const scheduleRequest=(p,r,op='admission-schedule-0001')=>({...p,acao:R.ACTIONS.schedule,review_id:r.body.review.review_id,confirm:'agendar',idempotency_key:op});
 return {...f,bindingService:f.service,service,call,approve,prepareRequest,scheduleRequest};
}
module.exports={setup};
