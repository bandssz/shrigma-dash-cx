'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict'),root=path.resolve(__dirname,'../../../../..'),historical=path.join(root,'operacao/runtime/sabado-20261017'),admission=JSON.parse(fs.readFileSync(path.join(__dirname,'../native-v3-admission.actual.safe.json')));a.equal(admission.ok,true);
const digest=(name,s)=>crypto.createHash(name).update(s).digest('hex'),sha=s=>digest('sha256',s),md5=s=>digest('md5',s),fragment=name=>fs.readFileSync(path.join(__dirname,name+'.fragment.sql'),'utf8');
const sources=[['catalog_lists','catalog-snapshot-fix.prepared.sql'],['freeze_native_internal_saved_audience_20261017','freeze-dependencies-install.prepared.sql'],['native_internal_snapshot_v1','native-internal-transition.sql'],['native_internal_snapshot_history_v1','native-internal-transition.sql'],['native_internal_effect_v1','native-recovery-install.prepared.sql']];
const functions=new Map();for(const[name,file]of sources){const sql=fs.readFileSync(path.join(historical,file),'utf8'),re=new RegExp('CREATE(?: OR REPLACE)? FUNCTION\\s+crm_audience_v2\\.'+name+'\\([\\s\\S]*?\\bAS\\s+(\\$[A-Za-z0-9_]*\\$)([\\s\\S]*?)\\1;','i'),m=re.exec(sql);a(m,'FUNCTION_SOURCE '+name);const pin=admission.admission.functions.find(f=>f.signature.startsWith('crm_audience_v2.'+name+'('));a(pin);a.equal(md5(m[2]),pin.body_md5,'CURRENT_BODY '+name);a.equal(pin.owner,'postgres');functions.set(name,{name,file,original:m[2],body:m[2],header:m[0].slice(0,m[0].indexOf(m[1])).replace(/^CREATE(?: OR REPLACE)? FUNCTION/i,'CREATE OR REPLACE FUNCTION'),tag:m[1],pin});}
const change=(s,x,y)=>{a.equal(s.split(x).length,2,'EXACT_V3_BOUNDARY '+x.slice(0,90));return s.replace(x,y);};
const freezer=functions.get('freeze_native_internal_saved_audience_20261017');let body=freezer.body;
body=change(body,'internal_list_id integer;','internal_list_id integer; is_v3 boolean; origin_ids integer[]; origins jsonb; base_row public.lists%ROWTYPE; states_wire text; identity_wire text; states_hash text; identity_hash text; meta_hash text;');
let start=body.indexOf(' -- A customer cannot enter this rehearsal'),end=body.indexOf(' -- Protect the chosen export',start);a(start>0&&end>start);const qa=body.slice(start,end);body=body.slice(0,start)+` is_v3:=audience_id IS DISTINCT FROM (CASE b WHEN 'aristo' THEN '23b3132a-a00b-41d3-ac31-0216a37f6100' ELSE '6b034a75-a02f-4a0e-9b18-43c4be87881b' END)::uuid;
 IF is_v3 THEN
${fragment('origins')} ELSE
${qa} END IF;
`+body.slice(end);
body=change(body,'OR cohort.eligible_count<>1 OR jsonb_typeof(cohort.member_ids)',"OR (NOT is_v3 AND cohort.eligible_count<>1) OR jsonb_typeof(cohort.member_ids)");
body=change(body," IF n<>1 OR ids[1]<>26948228 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_RECIPIENT_REFUSED';END IF;",` IF is_v3 THEN
${fragment('members')} ELSE
 IF n<>1 OR ids[1]<>26948228 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_RECIPIENT_REFUSED';END IF;
 END IF;`);
start=body.indexOf(' -- No source-list/subscriber/global-status update.');end=body.indexOf(' SELECT * INTO STRICT auth FROM crm_audience_v2.authenticate(access_key);',start);a(start>0&&end>start);const legacyCopy=body.slice(start,end);body=body.slice(0,start)+` IF is_v3 THEN
${fragment('copy')} ELSE
${legacyCopy} END IF;
`+body.slice(end);
start=body.indexOf(' receipt:=jsonb_build_object(');end=body.indexOf(' INSERT INTO crm_audience_v2.request',start);a(start>0&&end>start);const legacyReceipt=body.slice(start,end);body=body.slice(0,start)+` IF is_v3 THEN
 receipt:=jsonb_build_object('_http',200,'_body',jsonb_build_object(
  'contract','crm-native-frozen-list-v3','brand',b,'audience_id',audience_id,'audience_version',saved.version,
  'definition_hash',saved.definition_hash,'list_id',new_id,'list_uuid',new_uuid,'list_optin',base_row.optin::text,
  'eligible_count',n,'members_sha256',members_hash,'members_state_sha256',states_hash,
  'members_identity_sha256',identity_hash,'members_meta_sha256',meta_hash,
  'base',jsonb_build_object('id',base_row.id,'uuid',base_row.uuid,'optin',base_row.optin::text,'status',base_row.status::text),
  'origins',origins,'checked_at',cohort.checked_at,'frozen_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'source_operation_sha256',CASE WHEN source_operation IS NULL THEN NULL ELSE encode(sha256(convert_to(source_operation,'UTF8')),'hex') END,
  'sends',false,'schedules',false));
 ELSE
${legacyReceipt} END IF;
`+body.slice(end);freezer.body=body;
const history=functions.get('native_internal_snapshot_history_v1');history.body='\n ('+history.original.trimEnd()+'\n )\n UNION ALL\n'+fragment('history')+' LIMIT 1\n';
const live=functions.get('native_internal_snapshot_v1');live.body='\n ('+live.original.trimEnd()+'\n )\n UNION ALL\n'+fragment('live')+' LIMIT 1\n';
const effect=functions.get('native_internal_effect_v1');body=effect.body;
body=change(body,"AND left(name,char_length('[QA SAB17] Agenda nativa '))='[QA SAB17] Agenda nativa '","AND (left(name,char_length('[QA SAB17] Agenda nativa '))='[QA SAB17] Agenda nativa ' OR crm_audience_v2.native_internal_snapshot_history_v1(cid)->>'freeze_contract'='crm-native-frozen-list-v3')");
body=change(body,"'internal_test',true,'commercial',false,'list_id',snapshot->'list_id','acceptance_proved',proved)","'internal_test',snapshot->>'freeze_contract' IS DISTINCT FROM 'crm-native-frozen-list-v3','commercial',snapshot->>'freeze_contract' IS NOT DISTINCT FROM 'crm-native-frozen-list-v3','list_id',snapshot->'list_id','acceptance_proved',proved)||CASE WHEN snapshot->>'freeze_contract'='crm-native-frozen-list-v3' THEN jsonb_build_object('freeze_contract',snapshot->>'freeze_contract','eligible_count',snapshot->'eligible_count','audience_id',snapshot->'audience_id','audience_version',snapshot->'audience_version','base',snapshot->'base','origins',snapshot->'origins') ELSE '{}'::jsonb END");
body=change(body,"private_audience->'eligible_count' IS DISTINCT FROM '1'::jsonb","private_audience->'eligible_count' IS DISTINCT FROM (CASE WHEN snapshot->>'freeze_contract'='crm-native-frozen-list-v3' THEN snapshot->'eligible_count' ELSE '1'::jsonb END)");effect.body=body;
const catalog=functions.get('catalog_lists');body=catalog.body;const catalogGate=fragment('history').slice(fragment('history').indexOf(' FROM public.campaigns')); // not used as an authority substitute
a(catalogGate.includes("crm-native-frozen-list-v3"));
const close=body.indexOf(' ORDER BY l.id LIMIT 1001 FOR SHARE OF l');a(close>0);body=body.slice(0,close)+` AND NOT EXISTS(
  SELECT 1 FROM crm_audience_v2.request r CROSS JOIN LATERAL(SELECT r.response->'_body' v)x
  WHERE r.brand=b AND r.payload->>'acao'='segmento_congelar_nativo_interno' AND r.payload->>'brand'=b
   AND r.payload->>'idempotency_key'=r.operation_key AND r.response->'_http'='200'::jsonb
   AND x.v->>'contract'='crm-native-frozen-list-v3' AND x.v->>'brand'=b
   AND x.v->>'list_id'=l.id::text AND x.v->>'list_uuid'=l.uuid::text
   AND x.v->>'audience_id'=r.payload->>'id' AND x.v->'audience_version'=r.payload->'expected_version'
   AND x.v->>'definition_hash'=r.payload->>'expected_definition_hash'
   AND x.v->>'members_sha256'~'^[a-f0-9]{64}$'
   AND r.payload_hash=encode(sha256(convert_to((SELECT '{'||string_agg(to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}' FROM jsonb_each(r.payload)e(k,v)),'UTF8')),'hex')
 )
`+body.slice(close);catalog.body=body;
const order=['freeze_native_internal_saved_audience_20261017','native_internal_snapshot_history_v1','native_internal_snapshot_v1','native_internal_effect_v1','catalog_lists'],definition=(f,b=f.body)=>f.header+f.tag+b+f.tag+';\n';
function gate(label,expected,{fresh=false}={}){return `DO $${label}$ DECLARE p record; e record; BEGIN IF current_user<>'postgres' THEN RAISE EXCEPTION 'NATIVE_V3_OWNER_REQUIRED';END IF; FOR e IN SELECT * FROM (VALUES\n`+expected.map(f=>` ('${f.pin.signature}','${fresh?f.pin.body_md5:md5(f.body)}','${f.pin.acl_sha256}','${f.pin.config_sha256}'${fresh?`,'${f.pin.definition_sha256}'`:`,'${sha(f.body)}'`})`).join(',\n')+`)v(signature,body_md5,acl_sha256,config_sha256,definition_hash) LOOP SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(e.signature); IF md5(p.prosrc)<>e.body_md5 OR pg_get_userbyid(p.proowner)<>'postgres' OR NOT p.prosecdef OR p.provolatile<>'v' OR encode(sha256(convert_to(coalesce(p.proacl::text,''),'UTF8')),'hex')<>e.acl_sha256 OR encode(sha256(convert_to(coalesce(p.proconfig::text,''),'UTF8')),'hex')<>e.config_sha256 OR ${fresh?"encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')":"encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')"}<>e.definition_hash THEN RAISE EXCEPTION 'NATIVE_V3_BASE_DRIFT';END IF; END LOOP;END $${label}$;\n`;}
const items=order.map(n=>functions.get(n)),startTx="BEGIN;\nSET LOCAL lock_timeout='250ms';\nSET LOCAL statement_timeout='15s';\nSET LOCAL search_path=pg_catalog;\n",install=startTx+gate('v3pre',items,{fresh:true})+items.map(f=>definition(f)).join('\n')+gate('v3post',items)+'COMMIT;\n';
const returned=items.map(f=>({...f}));returned[0].body=change(returned[0].body,' IF is_v3 THEN\n'+fragment('origins')," IF is_v3 THEN RAISE EXCEPTION 'NATIVE_V3_NEW_FREEZE_CLOSED';END IF;\n IF is_v3 THEN\n"+fragment('origins'));
const re=returned.find(f=>f.name==='native_internal_effect_v1');re.body=change(re.body," IF kind='provider' AND action='native_prepare' THEN"," IF kind='provider' AND action='native_prepare' THEN\n  IF snapshot->>'freeze_contract'='crm-native-frozen-list-v3' AND op.action='agendar' THEN RAISE EXCEPTION 'NATIVE_V3_NEW_SCHEDULE_CLOSED';END IF;");
const compatible=startTx+gate('returnpre',items)+returned.map(f=>definition(f)).join('\n')+gate('returnpost',returned)+'COMMIT;\n';
for(const[name,text]of [['install.owner.sql',install],['return-compatible.owner.sql',compatible],['baseline.json',JSON.stringify({schema:'native-v3-five-current-bodies-v1',admissionQuerySha256:admission.sqlSha256,admissionAtUtc:admission.finishedAtUtc,functions:items.map(f=>({name:f.name,source:f.file,originalBodyMd5:md5(f.original),originalDefinitionSha256:f.pin.definition_sha256,originalStatementSha256:sha(definition(f,f.original)),candidateBodyMd5:md5(f.body),candidateBodySha256:sha(f.body),owner:f.pin.owner,aclSha256:f.pin.acl_sha256,configSha256:f.pin.config_sha256})),newFunctions:0,newTables:0,executed:false,installSha256:sha(install),compatibleReturnSha256:sha(compatible)},null,2)+'\n']])fs.writeFileSync(path.join(__dirname,name),text,{flag:'wx'});
console.log(JSON.stringify({prepared:true,functions:5,allOriginalBodiesMatched:true,newFunctions:0,newTables:0,productionExecuted:false,returnPreservesV3HistoryAndCancel:true}));
