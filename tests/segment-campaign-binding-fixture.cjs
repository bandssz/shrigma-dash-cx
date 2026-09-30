'use strict';
const F=require('./segment-audience-store-fixture.cjs'),B=require('../n8n/growth/segment-campaign-binding.cjs');
async function setup(db,options={}){
 const f=await F.setup(db,{timeoutMs:10000,...options});
 const schema=F.read('tests/campaign-provider-schema.sql');
 await db.exec(schema.slice(schema.indexOf('CREATE TABLE templates('),schema.indexOf('INSERT INTO lists VALUES')));
 await db.exec(schema.slice(schema.indexOf('INSERT INTO templates('),schema.indexOf('ALTER TABLE lists ADD COLUMN')).replace("VALUES(100,3,'Fish')","VALUES(100,101,'Fish')").replace("VALUES(200,7,'Aristo')","VALUES(200,201,'Aristo')"));
 await db.exec(`INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":300}'::jsonb)).* FROM campaigns c WHERE id=100;
 INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(300,101,'Unbound Fish');
 UPDATE campaign_lists SET list_id=17,list_name='Fish base' WHERE campaign_id=100;
 UPDATE campaign_lists SET list_id=16,list_name='Aristo base' WHERE campaign_id=200;
 INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":400,"attribs":{"crm":{"policy":"crm-campaign-v1","brand":"olivas"}}}'::jsonb)).* FROM campaigns c WHERE id=100;
 INSERT INTO crm_familia_campanha(marca,utm_campaign,familia) VALUES('fish','week','week'),('aristo','week','week');
 UPDATE subscribers SET status='blocklisted' WHERE id=4;`);
 for(const file of ['n8n/growth/campaign-store.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql','n8n/growth/segment-campaign-binding.sql'])await db.exec(F.read(file));
 await db.exec(schema.slice(schema.indexOf('CREATE FUNCTION fixture_audience_review(')));
 const service=B.createSegmentCampaignBinding({transaction:f.transaction,timeoutMs:10000,...options}),call=async(request,key='synthetic-manager-key')=>{const r=await service.execute({key,request});return {status:r._http,body:r._body};};
 const createAudience=async(brand='fish',name='binding-audience',rule)=>{const r=await f.call(f.create(brand,name,rule));if(r.status!==201)throw Error('BINDING_FIXTURE_AUDIENCE');return r.body.segment;};
 const inspect=(brand,campaign_id,a)=>call({acao:B.ACTIONS.inspect,brand,campaign_id,audience_id:a.id,audience_revision:a.version});
 const bind=(intent,idempotency_key='binding-operation-0001',key)=>call({acao:B.ACTIONS.bind,...intent,idempotency_key},key);
 const release=(brand,campaign_id,binding,idempotency_key='binding-release-0001',key,campaign_version=binding.campaign_version)=>call({acao:B.ACTIONS.release,brand,campaign_id,expected_campaign_version:campaign_version,expected_binding_version:binding.binding_version,expected_binding_hash:binding.binding_hash,idempotency_key},key);
 const current=async id=>(await db.query('SELECT public.shrigma_campaign_current($1) AS current',[id])).rows[0].current;
 const operation=(brand,idempotency_key,key)=>call({acao:B.ACTIONS.operation,brand,idempotency_key},key);
 const bound=async id=>(await db.query('SELECT * FROM crm_audience_v2.campaign_binding WHERE campaign_id=$1',[id])).rows[0];
 let sequence=0;
 const legacySchedule=async id=>{
  const v=(await db.query('SELECT fixture_audience_review($1) AS review',[id])).rows[0].review,c=await current(id);
  const op=(await db.query("SELECT public.shrigma_campaign_store('claim',$1::jsonb) AS operation",[JSON.stringify({actor:'fixture-legacy',key:'legacy-schedule-'+String(++sequence).padStart(8,'0'),hash:'a'.repeat(64),brand:c.definition.brand,action:'agendar'})])).rows[0].operation;
  return (await db.query("SELECT public.shrigma_campaign_provider('schedule',$1::jsonb) AS campaign",[JSON.stringify({id,expectedVersion:c.version,operationId:op.id,audienceReviewId:v.audience.review_id})])).rows[0].campaign;
 };
 return {...f,service,bindingCall:call,createAudience,inspect,bind,release,current,operation,bound,legacySchedule};
}
module.exports={setup};
