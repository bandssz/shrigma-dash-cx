'use strict';
const fs=require('node:fs'),path=require('node:path'),F=require('./segment-audience-cohort-fixture.cjs'),M=require('../n8n/growth/segment-audience-allocated.cjs');
const TESTS={fish:'00000000-0000-4000-8000-000000000001',aristo:'00000000-0000-4000-8000-000000000002'};
const args=(brand='fish',rule)=>({...F.args(brand,rule),testId:TESTS[brand]});
async function setup(db){
 await F.setup(db,{installAb:false});const core=fs.readFileSync(path.join(__dirname,'../n8n/growth/ab-experiment-core.sql'),'utf8');await db.exec(core.slice(core.indexOf('CREATE TABLE public.crm_ab_experiment_v2'),core.indexOf('CREATE FUNCTION public.crm_ab_protocol_valid_v2')));await F.installAccess(db);
 for(const [brand,ids,offset]of [['fish',[1,2,3,4,5,6,9,10],100],['aristo',[7,8],200]]){
  await db.query('INSERT INTO crm_ab_experiment_v2(test_id,brand,protocol,source_list_ids) VALUES($1,$2,$3::jsonb,$4::integer[])',[TESTS[brand],brand,'{}',[brand==='fish'?17:16]]);
  await db.query("INSERT INTO crm_ab_arm_v2(test_id,arm,campaign_id,campaign_version,allocated_count) VALUES($1,'a',$2,'synthetic',0),($1,'b',$3,'synthetic',0)",[TESTS[brand],offset,offset+1]);
  for(const id of ids)await db.query("INSERT INTO crm_ab_member_v2(test_id,subscriber_id,arm,revoked_at) VALUES($1,$2,$3,$4::timestamptz)",[TESTS[brand],id,id%2?'a':'b',id===10?'2025-01-01T00:00:00.000Z':null]);
 }
 await db.exec("UPDATE crm_ab_arm_v2 a SET allocated_count=(SELECT count(*) FROM crm_ab_member_v2 m WHERE m.test_id=a.test_id AND m.arm=a.arm);INSERT INTO subscribers VALUES(13,'enabled'),(14,'enabled');INSERT INTO subscriber_lists SELECT 13,l,'confirmed' FROM unnest(ARRAY[17,101,102])l;INSERT INTO subscriber_lists SELECT 14,l,'confirmed' FROM unnest(ARRAY[16,201,202])l;");
 const query=(text,values)=>db.query(text,values);return {db,query,resolve:p=>M.resolveAllocated({...p,query})};
}
module.exports={TESTS,args,leaf:F.leaf,setup};
