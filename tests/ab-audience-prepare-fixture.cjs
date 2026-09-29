'use strict';
const F=require('./segment-campaign-binding-fixture.cjs'),{read,uuid}=require('./ab-experiment-fixture.cjs');
const C=require('../growth-ab-experiment-contract.js'),P=require('../n8n/growth/ab-audience-prepare.cjs');
async function setup(db){
 const f=await F.setup(db);
 await db.exec(`
 INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":101,"name":"Fish B","send_at":null}'::jsonb)).* FROM campaigns c WHERE id=100;
 INSERT INTO campaigns SELECT (jsonb_populate_record(NULL::campaigns,to_jsonb(c)||'{"id":201,"name":"Aristo B","send_at":null}'::jsonb)).* FROM campaigns c WHERE id=200;
 INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(101,17,'Fish base'),(201,16,'Aristo base');
 SELECT set_config('shrigma.campaign_writer','101',true);
 UPDATE campaigns SET send_at=(SELECT send_at FROM campaigns WHERE id=100) WHERE id=101;
 SELECT set_config('shrigma.campaign_writer','201',true);
 UPDATE campaigns SET send_at=(SELECT send_at FROM campaigns WHERE id=200) WHERE id=201;
 SELECT set_config('shrigma.campaign_writer','',true);
 TRUNCATE subscriber_lists,subscribers;
 INSERT INTO subscribers SELECT n,CASE WHEN n=7 THEN 'blocklisted' WHEN n=8 THEN 'disabled' ELSE 'enabled' END FROM generate_series(1,20)n;
 INSERT INTO subscriber_lists SELECT n,l,CASE WHEN n=6 THEN 'unsubscribed' ELSE 'confirmed' END FROM generate_series(1,20)n CROSS JOIN unnest(ARRAY[17,16])l;
 INSERT INTO subscriber_lists SELECT n,l,CASE WHEN n=5 THEN 'unconfirmed' ELSE 'confirmed' END FROM generate_series(1,8)n CROSS JOIN unnest(ARRAY[101,201])l;
 CREATE TABLE link_clicks(id serial PRIMARY KEY,campaign_id integer,subscriber_id integer,created_at timestamptz NOT NULL);
 CREATE TABLE settings(key text PRIMARY KEY,value jsonb);
 INSERT INTO settings VALUES('privacy.disable_tracking','false'),('privacy.individual_tracking','true');
 `);
 for(const file of ['n8n/growth/ab-experiment-core.sql','n8n/growth/ab-experiment-selection.sql','n8n/growth/ab-experiment-coordinator.sql','n8n/growth/ab-audience-prepare.sql','n8n/growth/ab-audience-source-access.sql'])await db.exec(read(file));
 const service=P.createAudiencePrepare({transaction:f.transaction,timeoutMs:10000});let sequence=0;
 const protocol=async(brand='fish',minimum=1)=>{
  const ids=brand==='fish'?[100,101]:[200,201],arms=[];for(const [i,id]of ids.entries())arms.push({arm:['a','b'][i],campaign_id:id,expected_version:(await f.current(id)).version});
  return {contract:C.CONTRACT,test_id:uuid(++sequence),brand,channel:'email',name:'Synthetic audience experiment',hypothesis:'Compare within the selected audience',arms,allocation:{method:'random-permutation-v1',a_basis_points:5000},rule:{method:C.RULE,metric:'unique_tracked_click_per_allocated',window_hours:24,minimum_per_arm:minimum,minimum_effect_pp:.1,alpha:.05}};
 };
 const bindBoth=async(brand='fish',rule={op:'in_list',list_id:brand==='fish'?101:201})=>{
  const a=await f.createAudience(brand,'prepare-audience-'+brand+'-'+ ++sequence,rule);
  for(const id of brand==='fish'?[100,101]:[200,201]){const checked=await f.inspect(brand,id,a);if(checked.status!==200)throw Error('FIXTURE_BIND_INSPECT');const r=await f.bind(checked.body.intent,'prepare-bind-'+id+'-'+sequence);if(![200,201].includes(r.status))throw Error('FIXTURE_BIND');}return a;
 };
 const call=(request,key='synthetic-manager-key')=>service.execute({key,request});
 const inspect=p=>call({acao:P.ACTIONS.inspect,brand:p.brand,protocol:p});
 const prepare=(p,intent,operation_id=uuid(10000+ ++sequence))=>call({acao:P.ACTIONS.prepare,brand:p.brand,protocol:p,intent,operation_id});
 const operation=(brand,id)=>call({acao:P.ACTIONS.operation,brand,operation_id:id});
 const members=async tid=>(await db.query('SELECT subscriber_id,arm FROM crm_ab_member_v2 WHERE test_id=$1 ORDER BY subscriber_id',[tid])).rows;
 return {...f,service,call,protocol,bindBoth,inspect,prepare,operation,members};
}
module.exports={setup,uuid,read};
