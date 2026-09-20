'use strict';
// Pure SQL/workflow generator. Frozen operational inputs and generated output
// belong in private deployment artifacts, never committed fixtures.
const {createHash}=require('node:crypto');
const I=require('./whatsapp-order-status-integration.cjs');
const VERSION='wa-order-status-v1',LEGACY='legacy',MARKER='WA_ORDER_VERSIONED_SELECTION_V1';
const SIGNATURE='public.shrigma_flow_slot(text,text,text,text,text,text)';
const NEW_SIGNATURE='public.shrigma_flow_slot_wa_versioned_v1(text,text,text,text,text,text,text)';
const OLD_QUERY="SELECT shrigma_flow_slot($1::text,'whatsapp',$2::text,$3::text,$4::text,$5::text) AS config;";
const OLD_ARGS="={{ [$json.brand,$json.flow,$json.piece,$json.variant||'',String($json.template_id||'')] }}";
const QUERY="SELECT public.shrigma_flow_slot_wa_versioned_v1($1::text,'whatsapp',$2::text,$3::text,$4::text,$5::text,$6::text) AS config;";
const ARGS="={{ [$json.brand,$json.flow,$json.piece,$json.variant||'',String($json.template_id||''),$json._order_status_source?'wa-order-status-v1':'legacy'] }}";
const ORIGINAL_SOURCE=`
 SELECT coalesce((SELECT coalesce(s.value,'{}'::jsonb)||jsonb_build_object('_managed',true,'_allowed',f.enabled AND coalesce((s.value->>'enabled')::boolean,false),'_flow_key',f.key,'_version',f.published_version)
 FROM shrigma_flow_definition f CROSS JOIN LATERAL jsonb_array_elements(f.binding->'steps') b
 LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(f.published->'steps') WHERE value->>'key'=b->>'key') s ON true
 WHERE f.brand=p_brand AND f.runtime_ready AND b->>'channel'=p_channel AND b->>'flow'=p_flow AND b->>'piece'=p_piece
 AND coalesce(b->>'variant','')=coalesce(p_variant,'')
 AND (coalesce(b->>'source_template_id','')='' OR b->>'source_template_id'=p_source OR s.value->>'template_id'=p_source)
 ORDER BY f.key,b->>'key' LIMIT 1),jsonb_build_object('_managed',false))
`;
function ensure(ok,message){if(!ok)throw Error(message);}
const clone=structuredClone;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const lit=x=>{
 const value=String(x);
 // The maintenance webhook expression engine evaluates template delimiters
 // inside its query field. Keep every such literal out of the query text.
 if(value.includes('{{')||value.includes('}}'))return "convert_from(decode('"+Buffer.from(value,'utf8').toString('hex')+"','hex'),'UTF8')";
 return "'"+value.replace(/'/g,"''")+"'";
};
const json=x=>lit(JSON.stringify(x))+'::jsonb';
const fields=s=>Object.fromEntries(['template_id','template_name','category','signature'].map(k=>[k,s[k]]));
function manifest(contracts,flows){
 ensure(Array.isArray(contracts)&&contracts.length===6&&Array.isArray(flows)&&flows.length===4,'Six contracts and four exact flow snapshots required');
 const plan=I.planStageSwitch(flows,contracts);
 ensure(plan.updates.length===4&&new Set(contracts.map(c=>c.flow_key+'|'+c.step_key)).size===6&&new Set(contracts.map(c=>c.target.id)).size===6,'Six unique slots/targets across four flows required');
 return contracts.map(c=>{
  const u=plan.updates.find(x=>x.key===c.flow_key),old=u.expected.published.steps.find(x=>x.key===c.step_key),next=u.next.published.steps.find(x=>x.key===c.step_key);
  ensure(old.channel==='whatsapp'&&old.flow==='transacional'&&['aristo','fish'].includes(c.brand)&&['pedido-pago','rastreio-criado'].includes(old.piece),'Only reviewed transactional order slots are supported');
  const prior=fields(old),target=fields(next);
  ensure(Object.values(prior).every(x=>x!==undefined)&&Object.values(target).every(x=>x!==undefined),'Exact old/new identity and signature required');
  return {brand:c.brand,flow_key:c.flow_key,step_key:c.step_key,flow:'transacional',piece:c.piece,variant:old.variant||'',caller_template_id:c.caller_template_id,source_version:c.source_version,prior,target};
 });
}
function generate({freshFunction,contracts,flows}){
 ensure(freshFunction&&typeof freshFunction.definition==='string','Fresh function definition required');
 const body=freshFunction.definition.match(/AS \$function\$([\s\S]*)\$function\$/)?.[1];
 ensure(body===ORIGINAL_SOURCE&&freshFunction.security_definer===false&&freshFunction.language==='sql'&&freshFunction.config===null,'Current six-argument selector differs; inspect before adapting');
 ensure(freshFunction.arguments==="p_brand text, p_channel text, p_flow text, p_piece text, p_variant text, p_source text",'Selector signature changed');
 const release=manifest(contracts,flows),raw=ORIGINAL_SOURCE.trim().replace('FROM shrigma_flow_definition','FROM public.shrigma_flow_definition');
 const sql=`BEGIN;
-- ${MARKER}: install compatibility BEFORE switching the four visible rows.
DO $preflight$
DECLARE a record; current_rows jsonb;
BEGIN
 IF to_regprocedure(${lit(NEW_SIGNATURE)}) IS NOT NULL THEN RAISE EXCEPTION 'versioned_selector_already_exists_no_reinstall'; END IF;
 IF pg_get_functiondef(${lit(SIGNATURE)}::regprocedure) IS DISTINCT FROM ${lit(freshFunction.definition)} THEN RAISE EXCEPTION 'selector_source_drift'; END IF;
 SELECT p.prosecdef,p.proconfig,p.proacl,pg_get_userbyid(p.proowner) AS owner INTO a FROM pg_proc p WHERE p.oid=${lit(SIGNATURE)}::regprocedure;
 IF a.prosecdef OR a.proconfig IS NOT NULL OR a.owner IS DISTINCT FROM current_user OR coalesce(to_jsonb(a.proacl),'null'::jsonb) IS DISTINCT FROM ${json(freshFunction.acl)} THEN RAISE EXCEPTION 'selector_authority_drift'; END IF;
 PERFORM f.key FROM public.shrigma_flow_definition f WHERE f.key IN (SELECT value->>'key' FROM jsonb_array_elements(${json(flows)})) ORDER BY f.key FOR SHARE;
 SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.key),'[]'::jsonb) INTO current_rows FROM public.shrigma_flow_definition f WHERE f.key IN (SELECT value->>'key' FROM jsonb_array_elements(${json(flows)}));
 IF current_rows IS DISTINCT FROM (SELECT jsonb_agg(value ORDER BY value->>'key') FROM jsonb_array_elements(${json(flows)})) THEN RAISE EXCEPTION 'flow_snapshot_drift'; END IF;
END $preflight$;
CREATE FUNCTION public.shrigma_flow_slot_wa_versioned_v1(p_brand text,p_channel text,p_flow text,p_piece text,p_variant text,p_source text,p_runtime_contract text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $versioned$
DECLARE cfg jsonb; r jsonb; matches jsonb; selected jsonb; entries constant jsonb := ${json(release)};
BEGIN
 ${raw} INTO cfg;
 SELECT jsonb_agg(value) INTO matches FROM jsonb_array_elements(entries)
 WHERE p_channel='whatsapp' AND value->>'brand'=p_brand AND value->>'flow'=p_flow AND value->>'piece'=p_piece AND value->>'variant'=coalesce(p_variant,'')
 AND p_source IN (value->>'caller_template_id',value->'prior'->>'template_id',value->'target'->>'template_id');
 IF matches IS NULL THEN RETURN cfg; END IF;
 IF jsonb_array_length(matches)<>1 THEN RETURN cfg||jsonb_build_object('_managed',true,'_allowed',false,'_compatibility_block','release_slot_ambiguous'); END IF;
 r:=matches->0;
 IF cfg->'_managed' IS DISTINCT FROM 'true'::jsonb OR cfg->>'_flow_key' IS DISTINCT FROM r->>'flow_key' OR cfg->>'key' IS DISTINCT FROM r->>'step_key' THEN
  RETURN cfg||jsonb_build_object('_managed',true,'_allowed',false,'_compatibility_block','release_slot_unavailable');
 END IF;
 selected:=jsonb_build_object('template_id',cfg->'template_id','template_name',cfg->'template_name','category',cfg->'category','signature',cfg->'signature');
 IF selected IS DISTINCT FROM r->'prior' AND selected IS DISTINCT FROM r->'target' THEN
  RETURN cfg||jsonb_build_object('_allowed',false,'_compatibility_block','release_selection_drift');
 END IF;
 IF p_runtime_contract IS DISTINCT FROM '${LEGACY}' AND p_runtime_contract IS DISTINCT FROM '${VERSION}' THEN
  RETURN cfg||jsonb_build_object('_allowed',false,'_compatibility_block','runtime_contract_unknown');
 END IF;
 IF selected=r->'target' AND (coalesce((cfg->>'_version')::integer,0)<(r->>'source_version')::integer+1) THEN
  RETURN cfg||jsonb_build_object('_allowed',false,'_compatibility_block','release_version_not_published');
 END IF;
 -- Only identity/category/signature are pinned. Current enabled, _allowed,
 -- flow/piece/key, cadence and logical deduplication identities never change.
 IF p_runtime_contract='${LEGACY}' AND selected=r->'target' THEN
  RETURN cfg||(r->'prior')||jsonb_build_object('_runtime_contract','${LEGACY}','_runtime_content_version',r->'source_version','_runtime_release','${VERSION}');
 END IF;
 RETURN cfg||jsonb_build_object('_runtime_contract',p_runtime_contract,'_runtime_content_version',cfg->'_version','_runtime_release','${VERSION}');
END $versioned$;
REVOKE ALL ON FUNCTION ${NEW_SIGNATURE} FROM PUBLIC;
-- Copy precisely the old EXECUTE audience/options; add no new principal.
DO $acl$
DECLARE a record;
BEGIN
 FOR a IN SELECT x.grantee,x.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid=${lit(SIGNATURE)}::regprocedure AND x.privilege_type='EXECUTE' LOOP
  EXECUTE 'GRANT EXECUTE ON FUNCTION ${NEW_SIGNATURE} TO '||CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END||CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
 END LOOP;
END $acl$;
CREATE OR REPLACE FUNCTION public.shrigma_flow_slot(p_brand text,p_channel text,p_flow text,p_piece text,p_variant text DEFAULT '',p_source text DEFAULT '')
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $legacy$
 SELECT public.shrigma_flow_slot_wa_versioned_v1(p_brand,p_channel,p_flow,p_piece,p_variant,p_source,'${LEGACY}')
$legacy$;
COMMIT;
`;
 const expectedFunctions=[{signature:SIGNATURE,source:sql.split('AS $legacy$')[1].split('$legacy$;')[0],language:'sql',config:null,defaults:2},{signature:NEW_SIGNATURE,source:sql.split('AS $versioned$')[1].split('$versioned$;')[0],language:'plpgsql',config:['search_path=public, pg_temp'],defaults:0}];
 return {sql,release,expectedFunctions,marker:MARKER,sha256:createHash('sha256').update(sql).digest('hex'),runtime_contract:VERSION,workflow_changes:0,selection_changes:0};
}
function patchMotor(fresh,{expectedVersionId}={}){
 ensure(fresh?.versionId===expectedVersionId&&expectedVersionId&&Array.isArray(fresh.nodes),'Fresh matching motor export required');
 const w=clone(fresh),ns=w.nodes.filter(n=>n.name==='Configuração publicada (PG)');ensure(ns.length===1&&ns[0].type==='n8n-nodes-base.postgres','Native selector node required');
 const n=ns[0],p=n.parameters;
 ensure(w.nodes.some(n=>n.name==='Aplica fluxo publicado'&&n.parameters?.jsCode?.includes(I.MOTOR_MARKER))&&w.nodes.some(n=>n.name==='Interpreta resposta'&&n.parameters?.jsCode?.includes('WA_UNCERTAIN_RESERVATION_V1')),'Current order and uncertain-outcome guards required');
 if(p.query===QUERY&&p.options?.queryReplacement===ARGS)return {workflow:w,changes:[]};
 ensure(p.operation==='executeQuery'&&p.query===OLD_QUERY&&p.options?.queryReplacement===OLD_ARGS&&p.options.queryBatching==='independently','Current native selector changed');
 p.query=QUERY;p.options.queryReplacement=ARGS;
 return {workflow:w,changes:[{node:n.name,field:'query'},{node:n.name,field:'options.queryReplacement'}]};
}
module.exports={VERSION,LEGACY,MARKER,SIGNATURE,NEW_SIGNATURE,ORIGINAL_SOURCE,OLD_QUERY,OLD_ARGS,QUERY,ARGS,manifest,generate,patchMotor};
