'use strict';
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite'),AB=require('../growth-ab-experiment-contract.js');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function fixture(connection=null){
 const db=connection||new PGlite();
 for(const f of ['tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-provider.sql'])await db.exec(read(f));
 await db.exec(`TRUNCATE subscriber_lists,subscribers;
 CREATE TABLE link_clicks(id serial PRIMARY KEY,campaign_id integer,subscriber_id integer,created_at timestamptz NOT NULL);
 CREATE TABLE settings(key text PRIMARY KEY,value jsonb);INSERT INTO settings VALUES('privacy.disable_tracking','false'),('privacy.individual_tracking','true');
 INSERT INTO subscribers SELECT n,'enabled' FROM generate_series(1,1000) n;
 INSERT INTO subscriber_lists SELECT n,3,'confirmed' FROM generate_series(1,1000) n;
 INSERT INTO subscriber_lists SELECT n,17,'unconfirmed' FROM generate_series(1,500) n;
 INSERT INTO subscriber_lists SELECT n,7,'confirmed' FROM generate_series(1,1000) n;
 INSERT INTO subscribers VALUES(1001,'blocklisted'),(1002,'enabled');
 INSERT INTO subscriber_lists VALUES(1001,3,'confirmed'),(1002,3,'unsubscribed');
 INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":101,"name":"B"}'::jsonb)).* FROM campaigns c WHERE id=100;
 INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":201,"name":"B"}'::jsonb)).* FROM campaigns c WHERE id=200;
 INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(101,3,'Fish'),(201,7,'Aristo'),(100,17,'Base Fish'),(101,17,'Base Fish');`);
 await db.exec(read('n8n/growth/ab-experiment-core.sql'));
 const protocol=async(brand='fish',id=1)=>{const ids=brand==='fish'?[100,101]:[200,201],arms=[];for(const [i,cid] of ids.entries())arms.push({arm:['a','b'][i],campaign_id:cid,expected_version:(await db.query('SELECT shrigma_campaign_current($1) AS c',[cid])).rows[0].c.version});return {contract:AB.CONTRACT,test_id:uuid(id),brand,channel:'email',name:'Synthetic experiment',hypothesis:'Compare complete messages',arms,allocation:{method:'random-permutation-v1',a_basis_points:5000},rule:{method:AB.RULE,metric:'unique_tracked_click_per_allocated',window_hours:24,minimum_per_arm:100,minimum_effect_pp:.1,alpha:.05}};};
 const prepare=async(p,op=101,actor='panel:synthetic')=>(await db.query('SELECT crm_ab_prepare_v2($1,$2,$3,$4) AS x',[actor,'["draft"]',uuid(op),JSON.stringify(p)])).rows[0].x;
 const measure=async(id=1)=>(await db.query('SELECT crm_ab_measure_v2($1) AS x',[uuid(id)])).rows[0].x;
 return {db,protocol,prepare,measure};
}
module.exports={fixture,read,uuid};
