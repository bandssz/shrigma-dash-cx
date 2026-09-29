'use strict';
const fs=require('node:fs'),path=require('node:path');
const C=require('../n8n/growth/segment-audience-cohort.cjs'),A=require('../n8n/growth/segment-audience-contract.js');
const leaf=list_id=>({op:'in_list',list_id}),definition=(brand='fish',rule=leaf(brand==='fish'?101:201))=>({schema_version:A.VERSION,brand,name:'Cohort synthetic',rule});
const catalog=brand=>({brand,current:true,lists:(brand==='fish'?[17,101,102]:[16,201,202]).map(id=>({id,brand,available:true})),fields:[],products:[],origins:[]});
const args=(brand='fish',rule)=>({definition:definition(brand,rule),baseListId:brand==='fish'?17:16,catalog:catalog(brand)});
const schema=`CREATE TABLE lists(id integer PRIMARY KEY,tags varchar[],status text,optin text);
CREATE TABLE subscribers(id integer PRIMARY KEY,status text);
CREATE TABLE subscriber_lists(subscriber_id integer,list_id integer,status text,PRIMARY KEY(subscriber_id,list_id));
CREATE INDEX fixture_cohort_base ON subscriber_lists(list_id,subscriber_id);
INSERT INTO lists VALUES(17,ARRAY['fish'],'active','single'),(101,ARRAY['fish'],'active','single'),(102,ARRAY['fish'],'active','double'),(16,ARRAY['aristo'],'active','single'),(201,ARRAY['aristo'],'active','single'),(202,ARRAY['aristo'],'active','double');
INSERT INTO subscribers SELECT n,CASE n WHEN 4 THEN 'blocklisted' WHEN 5 THEN 'disabled' ELSE 'enabled' END FROM generate_series(1,8)n;
INSERT INTO subscriber_lists SELECT n,l,'confirmed' FROM generate_series(1,6)n CROSS JOIN unnest(ARRAY[17,101,102])l;
UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=2 AND list_id=102;
UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=3 AND list_id=101 OR subscriber_id=6 AND list_id=17;
INSERT INTO subscriber_lists SELECT n,l,CASE WHEN n=8 AND l=202 THEN 'unconfirmed' ELSE 'confirmed' END FROM generate_series(7,8)n CROSS JOIN unnest(ARRAY[16,201,202])l;`;
const source=fs.readFileSync(path.join(__dirname,'../n8n/growth/campaign-provider.sql'),'utf8'),helper=source.slice(source.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_list_brand'),source.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_catalog'));
const core=fs.readFileSync(path.join(__dirname,'../n8n/growth/ab-experiment-core.sql'),'utf8'),abTables=core.slice(core.indexOf('CREATE TABLE public.crm_ab_experiment_v2'),core.indexOf('CREATE FUNCTION public.crm_ab_protocol_valid_v2'));
const access=fs.readFileSync(path.join(__dirname,'../n8n/growth/ab-audience-source-access.sql'),'utf8');
async function installAccess(db){await db.exec('CREATE SCHEMA IF NOT EXISTS crm_audience_v2');await db.exec(access);}
async function setup(db,{installAb=true}={}){await db.exec(schema);await db.exec(helper);if(installAb){await db.exec(abTables);await installAccess(db);}await db.exec("SET statement_timeout='20s'; SET lock_timeout='500ms'");const query=(text,values)=>db.query(text,values);return {db,query,resolve:p=>C.resolveCohort({...p,query})};}
module.exports={leaf,definition,catalog,args,schema,helper,abTables,access,installAccess,setup};
