 'use strict';
// SYNTHETIC RAM PG fixture. Original public trigger bodies retained; auxiliary tables empty.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('pg'),{prepare}=require('./prepare.cjs');
const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'PUBLIC-SCHEMA.json'))),snapshot=fs.readFileSync(path.join(__dirname,'snapshot.sql'),'utf8');
(async()=>{assert.equal(process.version,'v22.23.3');assert.equal(process.getuid(),1000);assert.equal(process.env.WAVE175_ISOLATED,'1');const db=new Client({host:'127.0.0.1',port:55432,user:'postgres',database:'listmonk',options:'-c TimeZone=Etc/UTC'});await db.connect();assert.equal((await db.query("SHOW server_version_num")).rows[0].server_version_num,'170010');db.exec=async sql=>{await db.query(sql)};let cases=0;try{
 await db.exec("CREATE SCHEMA crm_audience_v2;CREATE SCHEMA crm_graph_candidate;");
 for(const name of [...new Set(schema.columns.map(x=>x.table))]){
 const columns=schema.columns.filter(x=>x.table===name).map(x=>{const types={int8:'bigint',int4:'integer',bool:'boolean',jsonb:'jsonb',timestamptz:'timestamptz',_varchar:'varchar[]',_text:'text[]',_jsonb:'jsonb[]'};return '"'+x.column+'" '+(types[x.udt]||'text');});
 await db.exec('CREATE TABLE public.'+name+'('+columns.join(',')+');');}
 await db.exec(`ALTER TABLE public.crm_familia_campanha ADD PRIMARY KEY(marca,utm_campaign);
 CREATE TABLE public.subscribers(id integer,status text);CREATE TABLE public.subscriber_lists(subscriber_id integer,list_id integer,status text);
 CREATE TABLE public.crm_ab_experiment_v2(test_id uuid,state text,version integer,window_end timestamptz);
 CREATE TABLE public.crm_ab_arm_v2(campaign_id integer,test_id uuid,finished_at timestamptz,transport_interrupted_at timestamptz);
 CREATE TABLE crm_audience_v2.campaign_binding(campaign_id integer);
 CREATE TABLE crm_audience_v2.regular_delivery_campaign(campaign_id integer);
 CREATE TABLE crm_audience_v2.regular_worker_deployment(singleton boolean);
 CREATE TABLE crm_audience_v2.regular_worker_lease(instance_id uuid);
 CREATE TABLE crm_graph_candidate.native_template_v1(clone_name text,state text,snapshot jsonb);
 CREATE FUNCTION crm_audience_v2.campaign_binding_effective(integer) RETURNS TABLE(brand text) LANGUAGE sql AS 'SELECT NULL::text WHERE false';
 CREATE FUNCTION crm_audience_v2.selection_worker_context(integer) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{"bound":false}''::jsonb';
 CREATE FUNCTION public.shrigma_campaign_is_managed(c public.campaigns) RETURNS boolean LANGUAGE sql AS 'SELECT coalesce(c.attribs#>>''{crm,policy}''=''crm-campaign-v1'',false)';
 CREATE FUNCTION public.fixture_clock() RETURNS timestamptz LANGUAGE sql AS 'SELECT ''2026-10-10T15:30:00Z''::timestamptz';`);
 for(const fn of [...new Set(schema.triggers.map(x=>x.function))])await db.exec(fn);
 for(const t of schema.triggers)await db.exec(t.definition);
 await db.exec(`INSERT INTO public.templates(id,name,type,is_default,body) VALUES(1,'SYNTHETIC', 'campaign',false,'SYNTHETIC TEMPLATE');
 INSERT INTO public.lists(id,name,tags,status,optin) VALUES(156,'SYNTHETIC ARISTO',ARRAY['aristocrata'],'active','single');
 INSERT INTO public.campaigns(id,name,body,altbody,type,messenger,status,sent,to_send,last_subscriber_id,max_subscriber_id,started_at,send_at,updated_at,template_id,attribs,tags)
 SELECT id,'SYNTHETIC '||id,'SYNTHETIC BODY','SYNTHETIC TEXT','regular','email',CASE WHEN id IN(171,174) THEN 'paused' WHEN id IN(172,173) THEN 'scheduled' ELSE 'draft' END,0,0,0,0,NULL,'2026-10-10T16:00:00Z','2026-10-10T14:00:00Z',1,NULL,ARRAY['black-antecipada','compradores'] FROM generate_series(171,177)id;
 INSERT INTO public.campaign_lists(id,campaign_id,list_id) VALUES(1,175,156);`);
 async function snap(){return (await db.query(snapshot)).rows[0].jsonb_build_object;}
 async function run(e){const literal="'"+JSON.stringify(e).replace(/'/g,"''")+"'::jsonb";return db.exec(prepare(e).replace(literal,'__FIXTURE_EXPECTED__').replaceAll('clock_timestamp()','public.fixture_clock()').replace('__FIXTURE_EXPECTED__',literal));}
 const e=await snap();await run(e);let a=await snap();assert.equal(a.campaigns.find(x=>x.id===175).status,'scheduled');assert.equal(a.alias[0].familia,'black-antecipada');assert.equal(a.campaigns.find(x=>x.id===176).status,'draft');cases++;
 await assert.rejects(()=>run(e));await db.exec('ROLLBACK');cases++;
 await db.exec("UPDATE public.campaigns SET status='draft' WHERE id=175;DELETE FROM public.crm_familia_campanha;");
 const drift=await snap();await db.exec("UPDATE public.campaigns SET body='DRIFT' WHERE id=175;");await assert.rejects(()=>run(drift));await db.exec('ROLLBACK');assert.equal((await snap()).alias.length,0);cases++;
 await db.exec("INSERT INTO public.crm_familia_campanha(marca,utm_campaign,familia) VALUES('aristo','black-antecipada-1010','CONFLICT');");await assert.rejects(async()=>run(await snap()));await db.exec('ROLLBACK');cases++;
 await db.exec("DELETE FROM public.crm_familia_campanha;INSERT INTO public.subscribers VALUES(1,'enabled');INSERT INTO public.subscriber_lists VALUES(1,156,'confirmed'),(1,7,'unsubscribed');");await assert.rejects(async()=>run(await snap()));await db.exec('ROLLBACK');cases++;
 assert.throws(()=>prepare({}));cases++;
 const masked={...await snap(),list156:{privateValueSha256:'fake'}};assert.throws(()=>prepare(masked));cases++;
 await db.exec('DELETE FROM public.subscriber_lists;DELETE FROM public.subscribers;INSERT INTO crm_audience_v2.campaign_binding VALUES(175);');await assert.rejects(async()=>run(await snap()));await db.exec('ROLLBACK');cases++;
 await db.exec("DELETE FROM crm_audience_v2.campaign_binding;CREATE OR REPLACE FUNCTION public.fixture_clock() RETURNS timestamptz LANGUAGE sql AS 'SELECT ''2026-10-10T15:46:00Z''::timestamptz';");await assert.rejects(async()=>run(await snap()));await db.exec('ROLLBACK');cases++;
 const guarded=await snap();assert.equal(guarded.campaigns.find(x=>x.id===175).status,'draft');assert.equal(guarded.alias.length,0);
 console.log(JSON.stringify({cases,passed:cases,synthetic:true,originalTriggers:schema.triggers.length,pg:(await db.query('SHOW server_version')).rows[0],node:process.version,uid:process.getuid(),originalCalls:0,smtpCalls:0,clock:'fixture_clock2026-10-10T15:30Z only; production SQL uses actual clock_timestamp'}));
}finally{await db.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
