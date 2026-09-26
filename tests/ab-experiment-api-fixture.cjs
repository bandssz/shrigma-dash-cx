'use strict';
const {fixture,read}=require('./ab-experiment-fixture.cjs');
async function setup(){
 const x=await fixture();for(const f of ['n8n/growth/ab-experiment-selection.sql','n8n/growth/ab-experiment-coordinator.sql'])await x.db.exec(read(f));
 await x.db.exec(`CREATE FUNCTION shrigma_panel_operator_v1(k text,area text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE WHEN area<>'growth' THEN NULL WHEN k IN('manager','rotated') THEN jsonb_build_object('who','panel:synthetic','label',k,'caps',jsonb_build_array('read_content','draft','validate','submit'))
   WHEN k='other' THEN '{"who":"panel:other","caps":["read_content","draft"]}'::jsonb
   WHEN k='reader' THEN '{"who":"panel:reader","caps":["read_content"]}'::jsonb
   WHEN k='bad-prefix' THEN '{"who":"template:legacy","caps":["read_content","draft"]}'::jsonb ELSE NULL END$$;
  CREATE FUNCTION shrigma_crm_operator_auth_v1(k text) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'COMBINED_AUTH_MUST_NOT_RUN';END$$;`);
 await x.db.exec(read('n8n/growth/ab-experiment-api.sql'));
 x.api=async(method,p={brand:'fish'},key='manager')=>(await x.db.query('SELECT crm_ab_api_v2($1,$2,$3) x',[key,method,JSON.stringify(p)])).rows[0].x;
 return x;
}
module.exports={setup};
