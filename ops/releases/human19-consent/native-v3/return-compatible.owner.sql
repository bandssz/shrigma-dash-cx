BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path=pg_catalog;
DO $returnpre$ DECLARE p record; e record; BEGIN IF current_user<>'postgres' THEN RAISE EXCEPTION 'NATIVE_V3_OWNER_REQUIRED';END IF; FOR e IN SELECT * FROM (VALUES
 ('crm_audience_v2.freeze_native_internal_saved_audience_20261017(text,text,uuid,integer,text,text,text,jsonb,jsonb,text,text)','cc208e098c39d5094314231a64f55ac5','de3acaefa2fbe5de94c089ceb592fd3853ce48678aefba3c52365414d1aa1720','0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491','8b6f29459f8959df08bcc45a3360897cd02cfda004a6b0f43ffb02ece1e5f1b8'),
 ('crm_audience_v2.native_internal_snapshot_history_v1(integer)','53d65cc4e58a24e4f7eda18e1c7b7bfc','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3','0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491','e4a49a8162c3bf2360b93419074b836e425d5301ca71ce7ef9650f8530e54ea8'),
 ('crm_audience_v2.native_internal_snapshot_v1(integer)','1b1e8f033d395937d3dcc871b8fdd83c','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3','0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491','128a671f042dedad546b199f18b3871f4147dca83db4c46fffecfa546cc685e7'),
 ('crm_audience_v2.native_internal_effect_v1(text,jsonb,jsonb)','b2aeda8243901ff6de5be2d152a3ce10','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3','0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491','017cfd0fe525650a06a11ec375bb3b2bc25d0f7d07c9ad0a760bf0da47b5ae36'),
 ('crm_audience_v2.catalog_lists(text)','98ca7d3d8fa47e1df9d9cc733c929c29','de3acaefa2fbe5de94c089ceb592fd3853ce48678aefba3c52365414d1aa1720','0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491','a9a0d1714da224f39e803ac5067f31514f6ed36b574564eebda212a006572018'))v(signature,body_md5,acl_sha256,config_sha256,definition_hash) LOOP SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(e.signature); IF md5(p.prosrc)<>e.body_md5 OR pg_get_userbyid(p.proowner)<>'postgres' OR NOT p.prosecdef OR p.provolatile<>'v' OR encode(sha256(convert_to(coalesce(p.proacl::text,''),'UTF8')),'hex')<>e.acl_sha256 OR encode(sha256(convert_to(coalesce(p.proconfig::text,''),'UTF8')),'hex')<>e.config_sha256 OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>e.definition_hash THEN RAISE EXCEPTION 'NATIVE_V3_BASE_DRIFT';END IF; END LOOP;END $returnpre$;
CREATE OR REPLACE FUNCTION crm_audience_v2.freeze_native_internal_saved_audience_20261017(
 access_key text, b text, audience_id uuid, expected_version integer,
 expected_definition_hash text, expected_context_hash text, expected_catalog_hash text,
 catalog_input jsonb, current_context jsonb, request_key text, payload_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $fn$
DECLARE auth record; prior record; saved record; cfg record; cohort record;
 actor_id text; ids integer[]; n integer; inserted integer; new_id integer;
 new_uuid uuid; members_hash text; payload jsonb; receipt jsonb; canonical_payload text; aggregate_catalog jsonb; source_operation text; internal_list_id integer; is_v3 boolean; origin_ids integer[]; origins jsonb; base_row public.lists%ROWTYPE; states_wire text; identity_wire text; states_hash text; identity_hash text; meta_hash text;
BEGIN
 IF b IS NULL OR b NOT IN('fish','aristo') OR audience_id IS NULL
  OR expected_version IS NULL OR expected_version<1
  OR expected_definition_hash IS NULL OR expected_definition_hash!~'^[a-f0-9]{64}$'
  OR expected_context_hash IS NULL OR expected_context_hash!~'^[a-f0-9]{64}$'
  OR expected_catalog_hash IS NULL OR expected_catalog_hash!~'^[a-f0-9]{64}$'
  OR payload_hash IS NULL OR payload_hash!~'^[a-f0-9]{64}$'
  OR request_key IS NULL OR request_key!~'^[A-Za-z0-9_.:-]{8,128}$'
  OR jsonb_typeof(catalog_input) IS DISTINCT FROM 'object'
  OR catalog_input->>'brand' IS DISTINCT FROM b
  OR catalog_input->'current' IS DISTINCT FROM 'true'::jsonb
  OR catalog_input->>'catalog_hash' IS DISTINCT FROM expected_catalog_hash
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_INPUT'; END IF;
 SELECT * INTO STRICT auth FROM crm_audience_v2.authenticate(access_key);
 actor_id:=auth.operator->>'who';
 IF auth.live_count IS DISTINCT FROM 1 OR actor_id IS NULL
  OR auth.live_actor IS DISTINCT FROM actor_id
  OR jsonb_typeof(auth.operator->'caps') IS DISTINCT FROM 'array'
  OR (auth.operator->'caps' ?& ARRAY['read_content','draft','validate','submit']) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_DENIED'; END IF;
 payload:=jsonb_build_object('acao','segmento_congelar_nativo_interno','brand',b,
  'id',audience_id,'expected_version',expected_version,
  'expected_definition_hash',expected_definition_hash,
  'expected_context_hash',expected_context_hash,'expected_catalog_hash',expected_catalog_hash,
  'idempotency_key',request_key);
 -- This exact payload has only flat ASCII keys and scalar string/integer
 -- values, so this ordering is the original JS canonical serializer's output.
 SELECT '{'||string_agg(to_json(k)::text||':'||v::text,',' ORDER BY k COLLATE "C")||'}'
 INTO canonical_payload FROM jsonb_each(payload) e(k,v);
 IF encode(sha256(convert_to(canonical_payload,'UTF8')),'hex')<>payload_hash
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_PAYLOAD_HASH'; END IF;
 -- Same lock and original receipt used by existing audience operations.
 PERFORM pg_advisory_xact_lock(hashtextextended(
  'crm-audience-v2-request:'||jsonb_build_array(actor_id,request_key)::text,0));
 SELECT * INTO STRICT auth FROM crm_audience_v2.authenticate(access_key);
 IF auth.live_count IS DISTINCT FROM 1 OR auth.live_actor IS DISTINCT FROM actor_id
  OR auth.operator->>'who' IS DISTINCT FROM actor_id
  OR jsonb_typeof(auth.operator->'caps') IS DISTINCT FROM 'array'
  OR (auth.operator->'caps' ?& ARRAY['read_content','draft','validate','submit']) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_ACCESS_CHANGED'; END IF;
 SELECT * INTO prior FROM crm_audience_v2.request r
  WHERE r.actor=actor_id AND r.operation_key=request_key;
 IF FOUND THEN
  IF prior.brand IS DISTINCT FROM b OR prior.payload IS DISTINCT FROM payload
   OR prior.payload_hash IS DISTINCT FROM payload_hash
  THEN RAISE EXCEPTION 'NATIVE_FREEZE_REQUEST_CONFLICT'; END IF;
  RETURN prior.response;
 END IF;
 SELECT * INTO STRICT saved FROM crm_audience_v2.audience a
  WHERE a.id=audience_id AND a.brand=b FOR SHARE;
 IF saved.archived OR saved.version<>expected_version
  OR saved.definition_hash<>expected_definition_hash
  OR saved.context_hash<>expected_context_hash
  OR saved.context IS DISTINCT FROM current_context
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_AUDIENCE_CHANGED'; END IF;
 SELECT * INTO STRICT cfg FROM crm_audience_v2.config_snapshot(b);
 IF cfg.enabled IS DISTINCT FROM true OR cfg.base_list_id IS DISTINCT FROM (CASE WHEN b='aristo' THEN 16 ELSE 17 END)
  OR current_context#>>'{base,id}' IS DISTINCT FROM cfg.base_list_id::text
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_SOURCE_UNAVAILABLE'; END IF;
 is_v3:=audience_id IS DISTINCT FROM (CASE b WHEN 'aristo' THEN '23b3132a-a00b-41d3-ac31-0216a37f6100' ELSE '6b034a75-a02f-4a0e-9b18-43c4be87881b' END)::uuid;
 IF is_v3 THEN RAISE EXCEPTION 'NATIVE_V3_NEW_FREEZE_CLOSED';END IF;
 IF is_v3 THEN
 -- Origins come from the saved definition and its pinned context, never input.
 SELECT array_agg(id ORDER BY id) INTO origin_ids FROM (
  SELECT cfg.base_list_id id UNION
  SELECT (rule->>'list_id')::integer FROM jsonb_path_query(saved.definition,'strict $.rule.** ? (@.op == "in_list")') rule
 ) selected;
 IF origin_ids IS NULL OR cardinality(origin_ids)<1 OR jsonb_typeof(current_context->'rules') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_ORIGINS_UNCONFIRMED';END IF;
 PERFORM l.id FROM public.lists l WHERE l.id=ANY(origin_ids) ORDER BY l.id FOR SHARE OF l;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>cardinality(origin_ids) THEN RAISE EXCEPTION 'NATIVE_FREEZE_ORIGINS_UNCONFIRMED';END IF;
 SELECT * INTO STRICT base_row FROM public.lists l WHERE l.id=cfg.base_list_id;
 SELECT jsonb_agg(jsonb_build_object('id',l.id,'uuid',l.uuid,'optin',l.optin::text,'status',l.status::text) ORDER BY l.id)
 INTO origins FROM public.lists l WHERE l.id=ANY(origin_ids) AND l.status::text='active'
  AND l.optin::text IN('single','double') AND public.shrigma_campaign_list_brand(l)=b;
 IF jsonb_array_length(origins) IS DISTINCT FROM cardinality(origin_ids)
  OR current_context#>>'{base,optin}' IS DISTINCT FROM base_row.optin::text
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(current_context->'rules') c
   LEFT JOIN public.lists l ON l.id=(c->>'list_id')::integer
   WHERE c ? 'list_id' AND (l.id IS NULL OR NOT(l.id=ANY(origin_ids)) OR c->>'optin' IS DISTINCT FROM l.optin::text))
  OR EXISTS(SELECT 1 FROM unnest(origin_ids) x(id) WHERE id<>cfg.base_list_id
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(current_context->'rules') c WHERE c->>'list_id'=id::text))
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_ORIGIN_CONTEXT_CHANGED';END IF;
 ELSE
 -- A customer cannot enter this rehearsal even if the caller passes a broad
 -- saved audience. The same original base/consent predicates still apply.
 internal_list_id:=CASE WHEN b='aristo' THEN 176 ELSE 175 END;
 PERFORM 1 FROM public.lists l WHERE l.id=internal_list_id AND l.status::text='active'
  AND l.optin::text IN ('single','double') AND public.shrigma_campaign_list_brand(l)=b FOR SHARE OF l;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_INTERNAL_LIST_UNCONFIRMED';END IF;
 PERFORM 1 FROM public.subscribers s WHERE s.id=26948228 AND s.status::text='enabled'
  AND lower(s.email)='felipebandeira+codex@oaristocrata.com' FOR SHARE OF s;
 IF NOT FOUND THEN RAISE EXCEPTION 'NATIVE_INTERNAL_IDENTITY_UNCONFIRMED';END IF;
 PERFORM 1 FROM public.subscriber_lists sl WHERE sl.subscriber_id=26948228
  AND sl.list_id IN (cfg.base_list_id,internal_list_id) AND sl.status::text='confirmed' FOR SHARE OF sl;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>2
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_CONSENT_UNCONFIRMED';END IF;
 END IF;
 -- Protect the chosen export from promotion until this atomic list/receipt
 -- commits. No source value is changed and no snapshot is fabricated.
 SELECT s.current_operation INTO source_operation FROM crm_audience_v2.shopify_source s
  WHERE s.brand=b FOR SHARE OF s;
 -- Same aggregate projection as Source76. Recorded-origin rules require the
 -- existing inline resolver and are deliberately not admitted by this helper.
 IF jsonb_path_exists(saved.definition,'$.rule.** ? (@.field == "signup.recorded_origin")')
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_RULE_UNSUPPORTED'; END IF;
 aggregate_catalog:=catalog_input-'recorded_origins';
 aggregate_catalog:=jsonb_set(aggregate_catalog,'{fields}',coalesce((
  SELECT jsonb_agg(f) FROM jsonb_array_elements(catalog_input->'fields') f
  WHERE f->>'key'<>'signup.recorded_origin'),'[]'::jsonb));
 SELECT * INTO STRICT cohort FROM crm_audience_v2.shopify_native_flat_members_20261017(
  saved.definition->'rule',b,cfg.base_list_id,aggregate_catalog);
 IF cohort.source_confirmed IS DISTINCT FROM true OR cohort.member_ids IS NULL
  OR cohort.eligible_count IS NULL OR cohort.eligible_count<1
  OR (NOT is_v3 AND cohort.eligible_count<>1) OR jsonb_typeof(cohort.member_ids)<>'array'
  OR jsonb_array_length(cohort.member_ids)<>cohort.eligible_count
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_MEMBERS_UNCONFIRMED'; END IF;
 SELECT array_agg(v::integer ORDER BY v::integer) INTO ids
  FROM jsonb_array_elements_text(cohort.member_ids) e(v);
 IF (SELECT count(DISTINCT v) FROM unnest(ids) u(v))<>cardinality(ids)
  OR EXISTS(SELECT 1 FROM unnest(ids) u(v) WHERE v IS NULL OR v<1)
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_MEMBER_GRAIN'; END IF;
 n:=cardinality(ids);
 IF is_v3 THEN
 -- Narrow ordered locks protect only this new cohort while its list is copied.
 PERFORM s.id FROM public.subscribers s WHERE s.id=ANY(ids) ORDER BY s.id FOR SHARE OF s;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>n OR EXISTS(SELECT 1 FROM public.subscribers s WHERE s.id=ANY(ids) AND (s.status::text<>'enabled' OR s.uuid IS NULL))
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_MEMBER_CHANGED';END IF;
 PERFORM sl.subscriber_id FROM public.subscriber_lists sl WHERE sl.list_id=cfg.base_list_id AND sl.subscriber_id=ANY(ids)
  ORDER BY sl.subscriber_id FOR SHARE OF sl;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>n OR EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.list_id=cfg.base_list_id AND sl.subscriber_id=ANY(ids)
  AND NOT(sl.status::text='confirmed' OR base_row.optin::text='single' AND sl.status::text='unconfirmed'))
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_CONSENT_CHANGED';END IF;
 SELECT '['||string_agg('['||sl.subscriber_id::text||','||to_json(sl.status::text)::text||']',',' ORDER BY sl.subscriber_id)||']'
 INTO states_wire FROM public.subscriber_lists sl WHERE sl.list_id=cfg.base_list_id AND sl.subscriber_id=ANY(ids);
 SELECT '['||string_agg('['||s.id::text||','||to_json(s.uuid::text)::text||']',',' ORDER BY s.id)||']'
 INTO identity_wire FROM public.subscribers s WHERE s.id=ANY(ids);
 states_hash:=encode(sha256(convert_to(states_wire,'UTF8')),'hex');
 identity_hash:=encode(sha256(convert_to(identity_wire,'UTF8')),'hex');
 -- Metadata hash is deliberately SQL-opaque; JS never hashes jsonb::text.
 SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(sl.subscriber_id,sl.meta) ORDER BY sl.subscriber_id)::text,'UTF8')),'hex')
 INTO meta_hash FROM public.subscriber_lists sl WHERE sl.list_id=cfg.base_list_id AND sl.subscriber_id=ANY(ids);
 ELSE
 IF n<>1 OR ids[1]<>26948228 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_RECIPIENT_REFUSED';END IF;
 END IF;
 members_hash:=encode(sha256(convert_to('['||array_to_string(ids,',')||']','UTF8')),'hex');
 IF is_v3 THEN
 new_uuid:=gen_random_uuid();
 INSERT INTO public.lists(uuid,name,type,optin,status,tags,description)
 VALUES(new_uuid,'CRM · '||b||' · público '||audience_id::text||' · '||left(request_key,16),
  'private',base_row.optin,'active',ARRAY[b,'crm-frozen-snapshot'],
  'crm-native-frozen-list-v3; audience='||audience_id::text||'; revision='||expected_version||'; members_sha256='||members_hash)
 RETURNING id INTO new_id;
 INSERT INTO public.subscriber_lists(subscriber_id,list_id,status,meta)
 SELECT sl.subscriber_id,new_id,sl.status,sl.meta FROM public.subscriber_lists sl
 WHERE sl.list_id=cfg.base_list_id AND sl.subscriber_id=ANY(ids);
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>n OR states_hash IS DISTINCT FROM (
  SELECT encode(sha256(convert_to('['||string_agg('['||sl.subscriber_id::text||','||to_json(sl.status::text)::text||']',',' ORDER BY sl.subscriber_id)||']','UTF8')),'hex')
  FROM public.subscriber_lists sl WHERE sl.list_id=new_id)
 OR meta_hash IS DISTINCT FROM (
  SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(sl.subscriber_id,sl.meta) ORDER BY sl.subscriber_id)::text,'UTF8')),'hex')
  FROM public.subscriber_lists sl WHERE sl.list_id=new_id)
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_COPY_CHANGED';END IF;
 ELSE
 -- No source-list/subscriber/global-status update. Every inserted object is new.
 new_uuid:=gen_random_uuid();
 INSERT INTO public.lists(uuid,name,type,optin,status,tags,description)
 VALUES(new_uuid,'CRM · '||b||' · público '||audience_id::text||' · '||left(request_key,16),
  'private','double','active',ARRAY[b,'crm-frozen-snapshot'],
  'crm-native-frozen-v1; audience='||audience_id::text||'; revision='||expected_version||'; members_sha256='||members_hash)
 RETURNING id INTO new_id;
 INSERT INTO public.subscriber_lists(subscriber_id,list_id,status)
 SELECT id,new_id,'confirmed' FROM unnest(ids) u(id);
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>n THEN RAISE EXCEPTION 'NATIVE_FREEZE_INSERT_MISMATCH'; END IF;
 END IF;
 SELECT * INTO STRICT auth FROM crm_audience_v2.authenticate(access_key);
 IF auth.live_count IS DISTINCT FROM 1 OR auth.live_actor IS DISTINCT FROM actor_id
  OR auth.operator->>'who' IS DISTINCT FROM actor_id
  OR jsonb_typeof(auth.operator->'caps') IS DISTINCT FROM 'array'
  OR (auth.operator->'caps' ?& ARRAY['read_content','draft','validate','submit']) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'NATIVE_FREEZE_ACCESS_CHANGED'; END IF;
 IF is_v3 THEN
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
 receipt:=jsonb_build_object('_http',200,'_body',jsonb_build_object(
  'contract','crm-native-frozen-internal-list-v2','brand',b,'audience_id',audience_id,
  'audience_version',saved.version,'definition_hash',saved.definition_hash,
  'list_id',new_id,'list_uuid',new_uuid,'eligible_count',n,
  'members_sha256',members_hash,'checked_at',cohort.checked_at,
  'internal_test',true,'source_operation_sha256',CASE WHEN source_operation IS NULL THEN NULL ELSE encode(sha256(convert_to(source_operation,'UTF8')),'hex') END,
  'schedules',false,'sends',false));
 END IF;
 INSERT INTO crm_audience_v2.request(actor,operation_key,brand,payload,payload_hash,response)
 VALUES(actor_id,request_key,b,payload,payload_hash,receipt);
 RETURN receipt;
END $fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.native_internal_snapshot_history_v1(pid integer) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $snapshot$
 (
 SELECT jsonb_build_object('list_id',l.id,'list_uuid',l.uuid,'audience_id',r.payload->>'id',
  'audience_version',r.payload->'expected_version','definition_hash',r.payload->>'expected_definition_hash',
  'request_hash',r.payload_hash,'request_actor',r.actor,'request_key',r.operation_key,
  'list_hash',r.payload_hash)
 FROM public.campaigns c JOIN public.campaign_lists cl ON cl.campaign_id=c.id
 JOIN public.lists l ON l.id=cl.list_id JOIN crm_audience_v2.request r ON r.brand=c.attribs#>>'{crm,brand}'
 CROSS JOIN LATERAL (SELECT r.response->'_body' v)x
 WHERE c.id=pid AND pid NOT IN(185,188,189,190,191,198)
  AND c.created_at>='2026-10-17T18:00:00Z'::timestamptz
  AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}' IN('fish','aristo')
  AND c.type::text='regular' AND c.messenger='email' AND c.sent=0 AND c.started_at IS NULL
  AND EXISTS(SELECT 1 FROM public.shrigma_campaign_operation o WHERE o.id::text=c.attribs#>>'{crm,created_operation_id}'
   AND o.actor=r.actor AND o.action='salvar' AND o.state='succeeded' AND o.provider_id=c.id AND o.brand=r.brand
   AND o.created_at>='2026-10-17T18:00:00Z'::timestamptz)
  AND (SELECT count(*) FROM public.campaign_lists z WHERE z.campaign_id=c.id)=1
  AND public.shrigma_campaign_list_brand(l)=r.brand
  AND r.payload->>'acao'='segmento_congelar_nativo_interno' AND r.payload->>'brand'=r.brand
  AND r.payload->>'idempotency_key'=r.operation_key
  AND r.payload->>'id'=CASE r.brand WHEN 'aristo' THEN '23b3132a-a00b-41d3-ac31-0216a37f6100' ELSE '6b034a75-a02f-4a0e-9b18-43c4be87881b' END
  AND r.response->'_http'='200'::jsonb AND x.v->>'contract'='crm-native-frozen-internal-list-v2'
  AND x.v->>'brand'=r.brand AND x.v->'internal_test'='true'::jsonb
  AND x.v->'schedules'='false'::jsonb AND x.v->'sends'='false'::jsonb AND x.v->'eligible_count'='1'::jsonb
  AND x.v->>'list_id'=l.id::text AND x.v->>'list_uuid'=l.uuid::text
  AND x.v->>'audience_id'=r.payload->>'id' AND x.v->'audience_version'=r.payload->'expected_version'
  AND x.v->>'definition_hash'=r.payload->>'expected_definition_hash'
  AND x.v->>'definition_hash'~'^[a-f0-9]{64}$' AND r.payload->>'expected_context_hash'~'^[a-f0-9]{64}$'
  AND r.payload->>'expected_catalog_hash'~'^[a-f0-9]{64}$'
  AND r.payload_hash=encode(sha256(convert_to((SELECT '{'||string_agg(to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}' FROM jsonb_each(r.payload)e(k,v)),'UTF8')),'hex')
  AND x.v->>'members_sha256'=encode(sha256(convert_to('[26948228]','UTF8')),'hex')
 LIMIT 1
 )
 UNION ALL
 SELECT jsonb_build_object('list_id',l.id,'list_uuid',l.uuid,'audience_id',r.payload->>'id',
  'audience_version',r.payload->'expected_version','definition_hash',r.payload->>'expected_definition_hash',
  'request_hash',r.payload_hash,'request_actor',r.actor,'request_key',r.operation_key,'list_hash',r.payload_hash,
  'freeze_contract','crm-native-frozen-list-v3','eligible_count',x.v->'eligible_count',
  'list_optin',x.v->>'list_optin','base',x.v->'base','origins',x.v->'origins',
  'members_sha256',x.v->>'members_sha256','members_state_sha256',x.v->>'members_state_sha256',
  'members_identity_sha256',x.v->>'members_identity_sha256','members_meta_sha256',x.v->>'members_meta_sha256')
 FROM public.campaigns c JOIN public.campaign_lists cl ON cl.campaign_id=c.id
 JOIN public.lists l ON l.id=cl.list_id JOIN crm_audience_v2.request r ON r.brand=c.attribs#>>'{crm,brand}'
 CROSS JOIN LATERAL (SELECT r.response->'_body' v)x
 WHERE c.id=pid AND pid NOT IN(185,188,189,190,191,198)
  AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}' IN('fish','aristo')
  AND c.type::text='regular' AND c.messenger='email' AND c.sent=0 AND c.started_at IS NULL
  AND x.v->>'contract'='crm-native-frozen-list-v3' AND r.response->'_http'='200'::jsonb
  AND c.created_at>=(x.v->>'frozen_at')::timestamptz
  AND EXISTS(SELECT 1 FROM public.shrigma_campaign_operation o WHERE o.id::text=c.attribs#>>'{crm,created_operation_id}'
   AND o.actor=r.actor AND o.action='salvar' AND o.state='succeeded' AND o.provider_id=c.id AND o.brand=r.brand
   AND o.response->'status'='201'::jsonb
   AND o.response#>>'{body,operation_id}'=o.id::text
   AND o.response#>'{body,campaign,id}'=to_jsonb(c.id)
   AND o.response#>>'{body,campaign,definition,brand}'=r.brand
   AND o.response#>'{body,campaign,definition,list_ids}'=jsonb_build_array(l.id)
   AND o.created_at>=(x.v->>'frozen_at')::timestamptz)
  AND (SELECT count(*) FROM public.campaign_lists z WHERE z.campaign_id=c.id)=1
  AND public.shrigma_campaign_list_brand(l)=r.brand
  AND r.payload->>'acao'='segmento_congelar_nativo_interno' AND r.payload->>'brand'=r.brand
  AND r.payload->>'idempotency_key'=r.operation_key AND x.v->>'brand'=r.brand
  AND x.v->>'list_id'=l.id::text AND x.v->>'list_uuid'=l.uuid::text
  AND x.v->>'audience_id'=r.payload->>'id' AND x.v->'audience_version'=r.payload->'expected_version'
  AND x.v->>'definition_hash'=r.payload->>'expected_definition_hash'
  AND x.v->>'definition_hash'~'^[a-f0-9]{64}$' AND r.payload->>'expected_context_hash'~'^[a-f0-9]{64}$'
  AND r.payload->>'expected_catalog_hash'~'^[a-f0-9]{64}$'
  AND x.v->'sends'='false'::jsonb AND x.v->'schedules'='false'::jsonb
  AND x.v->>'eligible_count'~'^[1-9][0-9]{0,9}$' AND x.v->>'list_optin' IN('single','double')
  AND jsonb_typeof(x.v->'base')='object' AND jsonb_typeof(x.v->'origins')='array'
  AND x.v#>>'{base,id}'=CASE r.brand WHEN 'aristo' THEN '16' ELSE '17' END
  AND x.v#>>'{base,optin}'=x.v->>'list_optin'
  AND jsonb_array_length(x.v->'origins')>=1
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(x.v->'origins') o WHERE o=x.v->'base')
  AND (SELECT count(DISTINCT o->>'id') FROM jsonb_array_elements(x.v->'origins') o)=jsonb_array_length(x.v->'origins')
  AND x.v->>'members_sha256'~'^[a-f0-9]{64}$' AND x.v->>'members_state_sha256'~'^[a-f0-9]{64}$'
  AND x.v->>'members_identity_sha256'~'^[a-f0-9]{64}$' AND x.v->>'members_meta_sha256'~'^[a-f0-9]{64}$'
  AND r.payload_hash=encode(sha256(convert_to((SELECT '{'||string_agg(to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}' FROM jsonb_each(r.payload)e(k,v)),'UTF8')),'hex')
 LIMIT 1
$snapshot$;

CREATE OR REPLACE FUNCTION crm_audience_v2.native_internal_snapshot_v1(pid integer) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $snapshot$
 (
 SELECT jsonb_build_object('list_id',l.id,'list_uuid',l.uuid,'audience_id',r.payload->>'id',
  'audience_version',r.payload->'expected_version','definition_hash',r.payload->>'expected_definition_hash',
  'request_hash',r.payload_hash,'request_actor',r.actor,'request_key',r.operation_key,
  'list_hash',encode(sha256(convert_to(to_jsonb(l)::text,'UTF8')),'hex'))
 FROM public.campaigns c JOIN public.campaign_lists cl ON cl.campaign_id=c.id
 JOIN public.lists l ON l.id=cl.list_id JOIN crm_audience_v2.request r ON r.brand=c.attribs#>>'{crm,brand}'
 CROSS JOIN LATERAL (SELECT r.response->'_body' v)x
 WHERE c.id=pid AND pid NOT IN(185,188,189,190,191,198)
  AND c.created_at>='2026-10-17T18:00:00Z'::timestamptz
  AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}' IN('fish','aristo')
  AND c.type::text='regular' AND c.messenger='email' AND c.sent=0 AND c.started_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.campaign_media cm WHERE cm.campaign_id=c.id)
  AND EXISTS(SELECT 1 FROM public.shrigma_campaign_operation o WHERE o.id::text=c.attribs#>>'{crm,created_operation_id}'
   AND o.actor=r.actor AND o.action='salvar' AND o.state='succeeded' AND o.provider_id=c.id AND o.brand=r.brand
   AND o.created_at>='2026-10-17T18:00:00Z'::timestamptz)
  AND (SELECT count(*) FROM public.campaign_lists z WHERE z.campaign_id=c.id)=1
  AND NOT EXISTS(SELECT 1 FROM public.campaign_lists z WHERE z.list_id=l.id AND z.campaign_id<>c.id)
  AND l.type::text='private' AND l.optin::text='double' AND l.status::text='active'
  AND public.shrigma_campaign_list_brand(l)=r.brand
  AND r.payload->>'acao'='segmento_congelar_nativo_interno' AND r.payload->>'brand'=r.brand
  AND r.payload->>'idempotency_key'=r.operation_key
  AND r.payload->>'id'=CASE r.brand WHEN 'aristo' THEN '23b3132a-a00b-41d3-ac31-0216a37f6100' ELSE '6b034a75-a02f-4a0e-9b18-43c4be87881b' END
  AND r.response->'_http'='200'::jsonb AND x.v->>'contract'='crm-native-frozen-internal-list-v2'
  AND x.v->>'brand'=r.brand AND x.v->'internal_test'='true'::jsonb
  AND x.v->'schedules'='false'::jsonb AND x.v->'sends'='false'::jsonb AND x.v->'eligible_count'='1'::jsonb
  AND x.v->>'list_id'=l.id::text AND x.v->>'list_uuid'=l.uuid::text
  AND x.v->>'audience_id'=r.payload->>'id' AND x.v->'audience_version'=r.payload->'expected_version'
  AND x.v->>'definition_hash'=r.payload->>'expected_definition_hash'
  AND x.v->>'definition_hash'~'^[a-f0-9]{64}$' AND r.payload->>'expected_context_hash'~'^[a-f0-9]{64}$'
  AND r.payload->>'expected_catalog_hash'~'^[a-f0-9]{64}$'
  AND r.payload_hash=encode(sha256(convert_to((SELECT '{'||string_agg(to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}' FROM jsonb_each(r.payload)e(k,v)),'UTF8')),'hex')
  AND x.v->>'members_sha256'=encode(sha256(convert_to('[26948228]','UTF8')),'hex')
  AND (SELECT count(*) FROM public.subscriber_lists sl WHERE sl.list_id=l.id)=1
  AND EXISTS(SELECT 1 FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id
   WHERE sl.list_id=l.id AND sl.subscriber_id=26948228 AND sl.status::text='confirmed' AND s.status::text='enabled'
    AND lower(s.email)='felipebandeira+codex@oaristocrata.com')
  AND (SELECT count(*) FROM public.subscriber_lists sl WHERE sl.subscriber_id=26948228 AND sl.status::text='confirmed'
   AND sl.list_id=ANY(CASE r.brand WHEN 'aristo' THEN ARRAY[16,176] ELSE ARRAY[17,175] END))=2
 LIMIT 1
 )
 UNION ALL
 SELECT h.s||jsonb_build_object('list_hash',encode(sha256(convert_to(to_jsonb(l)::text,'UTF8')),'hex'))
 FROM (SELECT crm_audience_v2.native_internal_snapshot_history_v1(pid) s) h
 JOIN public.lists l ON l.id=(h.s->>'list_id')::integer
 JOIN public.lists base ON base.id=(h.s#>>'{base,id}')::integer
 WHERE h.s->>'freeze_contract'='crm-native-frozen-list-v3'
  AND l.type::text='private' AND l.status::text='active' AND l.optin::text=h.s->>'list_optin'
  AND l.uuid::text=h.s->>'list_uuid' AND base.uuid::text=h.s#>>'{base,uuid}'
  AND base.status::text='active' AND base.optin::text=h.s#>>'{base,optin}'
  AND NOT EXISTS(SELECT 1 FROM public.campaign_media cm WHERE cm.campaign_id=pid)
  AND NOT EXISTS(SELECT 1 FROM public.campaign_lists z WHERE z.list_id=l.id AND z.campaign_id<>pid)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(h.s->'origins') o LEFT JOIN public.lists original ON original.id=(o->>'id')::integer
   WHERE original.id IS NULL OR original.uuid::text IS DISTINCT FROM o->>'uuid'
    OR original.optin::text IS DISTINCT FROM o->>'optin' OR original.status::text IS DISTINCT FROM o->>'status')
  AND (SELECT count(*) FROM public.subscriber_lists sl WHERE sl.list_id=l.id)=(h.s->>'eligible_count')::bigint
  AND h.s->>'members_sha256'=(SELECT encode(sha256(convert_to('['||string_agg(sl.subscriber_id::text,',' ORDER BY sl.subscriber_id)||']','UTF8')),'hex') FROM public.subscriber_lists sl WHERE sl.list_id=l.id)
  AND h.s->>'members_state_sha256'=(SELECT encode(sha256(convert_to('['||string_agg('['||sl.subscriber_id::text||','||to_json(sl.status::text)::text||']',',' ORDER BY sl.subscriber_id)||']','UTF8')),'hex') FROM public.subscriber_lists sl WHERE sl.list_id=l.id)
  AND h.s->>'members_identity_sha256'=(SELECT encode(sha256(convert_to('['||string_agg('['||s.id::text||','||to_json(s.uuid::text)::text||']',',' ORDER BY s.id)||']','UTF8')),'hex') FROM public.subscriber_lists sl JOIN public.subscribers s ON s.id=sl.subscriber_id WHERE sl.list_id=l.id)
  AND h.s->>'members_meta_sha256'=(SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(sl.subscriber_id,sl.meta) ORDER BY sl.subscriber_id)::text,'UTF8')),'hex') FROM public.subscriber_lists sl WHERE sl.list_id=l.id)
  AND NOT EXISTS(SELECT 1 FROM public.subscriber_lists frozen JOIN public.subscribers s ON s.id=frozen.subscriber_id
   LEFT JOIN public.subscriber_lists original ON original.list_id=base.id AND original.subscriber_id=s.id
   WHERE frozen.list_id=l.id AND (s.status::text<>'enabled' OR original.subscriber_id IS NULL
    OR NOT(original.status::text='confirmed' OR base.optin::text='single' AND original.status::text='unconfirmed')))
 LIMIT 1
$snapshot$;

CREATE OR REPLACE FUNCTION crm_audience_v2.native_internal_effect_v1(k text,envelope jsonb,effect jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $effect$
DECLARE previous jsonb;recovery jsonb;auth jsonb;cmd jsonb;operation jsonb;kind text;action text;payload jsonb;cid integer;oid uuid;olease uuid;
 c public.campaigns%ROWTYPE;op public.shrigma_campaign_operation%ROWTYPE;v jsonb;p jsonb;snapshot jsonb;
 current_row jsonb;h text;credential_hash text;at timestamptz;expiry timestamptz;checked timestamptz;audience jsonb;private_audience jsonb;proved boolean;
BEGIN
 auth:=public.shrigma_crm_campaign_auth_v1(k);cmd:=envelope->'command';operation:=envelope->'operation';kind:=effect->>'kind';action:=effect->>'action';payload:=effect->'payload';
 IF jsonb_typeof(envelope) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(envelope))<>3
  OR NOT(envelope ?& ARRAY['command','actor','operation']) OR jsonb_typeof(cmd) IS DISTINCT FROM 'object'
  OR auth->>'actor' IS NULL OR envelope->>'actor' IS DISTINCT FROM auth->>'actor'
  OR coalesce(cmd->>'brand','') NOT IN('fish','aristo') OR ((auth->'caps') ?& ARRAY['read_content','draft','validate','submit']) IS DISTINCT FROM true
  OR jsonb_typeof(effect) IS DISTINCT FROM 'object' OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_AUTH_REFUSED';END IF;
 credential_hash:=encode(sha256(convert_to(k,'UTF8')),'hex');
 IF NOT crm_audience_v2.native_internal_live_v1(auth->>'actor',credential_hash) THEN RAISE EXCEPTION 'NATIVE_INTERNAL_AUTH_REFUSED';END IF;
 IF coalesce(cmd->>'id','')!~'^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'NATIVE_INTERNAL_INPUT';END IF;cid:=(cmd->>'id')::integer;
 -- Explicit POST continuation of the SAME uncertain cancel; never a new claim.
 IF kind='nativeCancelRecovery' THEN
  IF operation IS DISTINCT FROM 'null'::jsonb OR cmd->>'acao' IS DISTINCT FROM 'campanha_cancelar'
   OR cmd->>'confirm' IS DISTINCT FROM 'cancelar'
   OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(cmd)x) IS DISTINCT FROM ARRAY['acao','brand','confirm','expected_version','id','idempotency_key']
   OR effect IS DISTINCT FROM jsonb_build_object('kind','nativeCancelRecovery','payload',jsonb_build_object('id',cid))
  THEN RAISE EXCEPTION 'NATIVE_RECOVERY_INPUT';END IF;
  SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
  SELECT * INTO STRICT op FROM public.shrigma_campaign_operation WHERE actor=auth->>'actor' AND operation_key=cmd->>'idempotency_key' FOR UPDATE;
  SELECT validation INTO v FROM public.shrigma_campaign_validation WHERE provider_id=cid FOR UPDATE;p:=v->'_native_internal';
  h:=encode(sha256(convert_to((SELECT '{'||string_agg(to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}' FROM jsonb_each(cmd)e(k,v)),'UTF8')),'hex');
  snapshot:=crm_audience_v2.native_internal_snapshot_history_v1(cid);
  IF op.action IS DISTINCT FROM 'cancelar' OR op.brand IS DISTINCT FROM cmd->>'brand' OR op.provider_id IS DISTINCT FROM cid
   OR op.request_hash IS DISTINCT FROM h OR c.attribs#>>'{crm,brand}' IS DISTINCT FROM op.brand
   OR p->>'contract' IS DISTINCT FROM 'crm-native-internal-transition-v1' OR p->>'operation_id' IS DISTINCT FROM op.id::text
   OR p->>'lease' IS DISTINCT FROM op.lease::text OR p->>'actor' IS DISTINCT FROM op.actor OR p->>'brand' IS DISTINCT FROM op.brand
   OR p->>'action' IS DISTINCT FROM 'cancelar' OR p->>'request_hash' IS DISTINCT FROM h
   OR p->>'credential_sha256' IS DISTINCT FROM credential_hash OR snapshot IS NULL OR p->'snapshot' IS DISTINCT FROM snapshot
   OR c.status::text IS DISTINCT FROM 'draft' OR c.sent IS DISTINCT FROM 0 OR c.started_at IS NOT NULL
   OR p->>'current_version' IS DISTINCT FROM public.shrigma_campaign_current(cid)->>'version'
   OR p->>'material_sha256' IS DISTINCT FROM encode(sha256(convert_to((to_jsonb(c)-ARRAY['status','send_at','updated_at'])::text,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'NATIVE_RECOVERY_CHANGED';END IF;
  recovery:=p->'recovery';
  IF op.state='succeeded' AND p->>'stage'='complete' AND c.send_at IS NULL
   AND recovery->>'contract'='crm-native-cancel-recovery-v1' AND recovery->>'operation_id'=op.id::text
   AND recovery->>'request_hash'=h AND op.response#>'{body,campaign}'=public.shrigma_campaign_current(cid)
  THEN previous:=recovery->'previous_operation';
  ELSE
   IF op.state<>'outcome_unknown' OR p->>'stage' IS DISTINCT FROM 'clear_send_at'
    OR c.send_at IS NULL OR c.send_at IS DISTINCT FROM (p->>'send_at')::timestamptz
   THEN RAISE EXCEPTION 'NATIVE_RECOVERY_UNAVAILABLE';END IF;
   previous:=public.shrigma_campaign_store('get',jsonb_build_object('actor',op.actor,'key',op.operation_key));
   IF previous->>'id' IS DISTINCT FROM op.id::text OR previous->>'state' IS DISTINCT FROM 'outcome_unknown'
    OR previous->'response' IS DISTINCT FROM op.response THEN RAISE EXCEPTION 'NATIVE_RECOVERY_RECEIPT_CHANGED';END IF;
   IF recovery IS NOT NULL AND (recovery->>'contract' IS DISTINCT FROM 'crm-native-cancel-recovery-v1'
    OR recovery->'previous_operation' IS DISTINCT FROM previous) THEN RAISE EXCEPTION 'NATIVE_RECOVERY_CHANGED';END IF;
   recovery:=jsonb_build_object('contract','crm-native-cancel-recovery-v1','operation_id',op.id,'request_hash',h,'previous_operation',previous);
   p:=p||jsonb_build_object('recovery',recovery,'expires_at',clock_timestamp()+interval '2 minutes');
   UPDATE public.shrigma_campaign_validation SET validation=jsonb_set(validation,'{_native_internal}',p),updated_at=clock_timestamp() WHERE provider_id=cid;
  END IF;
  RETURN jsonb_build_object('contract','crm-native-internal-plan-v1','campaign_id',cid,'campaign_uuid',c.uuid,'list_id',snapshot->'list_id',
   'send_at',p->'send_at','stage','clear_send_at','completed',op.state='succeeded','operation',jsonb_build_object('id',op.id,'lease',op.lease),'previous_operation',previous);
 END IF;

 IF kind='nativeContext' THEN
  IF cmd->>'acao' IS DISTINCT FROM 'campanha_nativa_contexto' OR operation IS DISTINCT FROM 'null'::jsonb
   OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(cmd)x) IS DISTINCT FROM ARRAY['acao','brand','id'] OR effect IS DISTINCT FROM jsonb_build_object('kind','nativeContext','payload',jsonb_build_object('id',cid))
  THEN RAISE EXCEPTION 'NATIVE_INTERNAL_INPUT';END IF;
  -- Release admission comes from historical native receipts in the ORIGINAL
  -- intentions. A later schedule must not hide its own cancellation control.
  SELECT NOT EXISTS(SELECT 1 FROM unnest(ARRAY['aristo','fish'])b WHERE NOT EXISTS(
   SELECT 1 FROM public.campaigns cc JOIN public.shrigma_campaign_operation cancelop ON cancelop.provider_id=cc.id
   WHERE cc.attribs#>>'{crm,brand}'=b AND crm_audience_v2.native_internal_snapshot_history_v1(cc.id) IS NOT NULL
    AND cancelop.actor=auth->>'actor' AND cancelop.brand=b AND cancelop.action='cancelar' AND cancelop.state='succeeded'
    AND cancelop.response->'status'='200'::jsonb AND cancelop.response#>'{body,native_internal}'='true'::jsonb
    AND cancelop.response#>>'{body,campaign,status}'='draft' AND cancelop.response#>'{body,campaign,sent}'='0'::jsonb
    AND cancelop.response#>'{body,campaign,started_at}'='null'::jsonb
    AND cancelop.response#>'{body,campaign,send_at}'='null'::jsonb
    AND EXISTS(SELECT 1 FROM public.shrigma_campaign_operation scheduleop WHERE scheduleop.provider_id=cc.id
     AND scheduleop.actor=cancelop.actor AND scheduleop.brand=b AND scheduleop.action='agendar' AND scheduleop.state='succeeded'
     AND scheduleop.response->'status'='200'::jsonb AND scheduleop.response#>'{body,native_internal}'='true'::jsonb
     AND scheduleop.created_at<cancelop.created_at AND scheduleop.response#>>'{body,campaign,status}'='scheduled'
     AND scheduleop.response#>'{body,campaign,sent}'='0'::jsonb AND scheduleop.response#>'{body,campaign,started_at}'='null'::jsonb)
  )) INTO proved;
  IF NOT EXISTS(SELECT 1 FROM public.campaigns WHERE id=cid AND attribs#>>'{crm,brand}'=cmd->>'brand'
   AND (left(name,char_length('[QA SAB17] Agenda nativa '))='[QA SAB17] Agenda nativa ' OR crm_audience_v2.native_internal_snapshot_history_v1(cid)->>'freeze_contract'='crm-native-frozen-list-v3')) THEN
   RETURN jsonb_build_object('schema','crm-native-internal-context-v1','brand',cmd->>'brand','campaign_id',cid,'eligible',false,'internal_test',true,'commercial',false,'list_id',NULL,'acceptance_proved',proved);
  END IF;
  snapshot:=CASE WHEN EXISTS(SELECT 1 FROM public.campaigns WHERE id=cid AND status::text='scheduled') THEN crm_audience_v2.native_internal_snapshot_history_v1(cid) ELSE crm_audience_v2.native_internal_snapshot_v1(cid) END;
  RETURN jsonb_build_object('schema','crm-native-internal-context-v1','brand',cmd->>'brand','campaign_id',cid,
   'eligible',snapshot IS NOT NULL AND EXISTS(SELECT 1 FROM public.campaigns WHERE id=cid AND attribs#>>'{crm,brand}'=cmd->>'brand'),
   'internal_test',snapshot->>'freeze_contract' IS DISTINCT FROM 'crm-native-frozen-list-v3','commercial',snapshot->>'freeze_contract' IS NOT DISTINCT FROM 'crm-native-frozen-list-v3','list_id',snapshot->'list_id','acceptance_proved',proved)||CASE WHEN snapshot->>'freeze_contract'='crm-native-frozen-list-v3' THEN jsonb_build_object('freeze_contract',snapshot->>'freeze_contract','eligible_count',snapshot->'eligible_count','audience_id',snapshot->'audience_id','audience_version',snapshot->'audience_version','base',snapshot->'base','origins',snapshot->'origins') ELSE '{}'::jsonb END;
 END IF;
 IF cmd->>'acao' NOT IN('campanha_agendar','campanha_cancelar') OR cmd->>'confirm' IS DISTINCT FROM replace(cmd->>'acao','campanha_','')
  OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(cmd)x) IS DISTINCT FROM
   (CASE WHEN cmd->>'acao'='campanha_agendar' THEN ARRAY['acao','audience_review_id','brand','confirm','expected_version','id','idempotency_key'] ELSE ARRAY['acao','brand','confirm','expected_version','id','idempotency_key'] END)
  OR jsonb_typeof(operation) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(operation))<>2 OR NOT(operation ?& ARRAY['id','lease'])
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_INPUT';END IF;
 oid:=(operation->>'id')::uuid;olease:=(operation->>'lease')::uuid;
 -- Every native path uses campaign -> operation -> validation, including finish.
 SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
 SELECT * INTO STRICT op FROM public.shrigma_campaign_operation WHERE id=oid FOR UPDATE;
 h:=encode(sha256(convert_to((SELECT '{'||string_agg(to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}' FROM jsonb_each(cmd)e(k,v)),'UTF8')),'hex');
 IF op.lease IS DISTINCT FROM olease OR op.actor IS DISTINCT FROM auth->>'actor' OR op.brand IS DISTINCT FROM cmd->>'brand'
  OR op.action IS DISTINCT FROM replace(cmd->>'acao','campanha_','') OR op.operation_key IS DISTINCT FROM cmd->>'idempotency_key'
  OR op.request_hash IS DISTINCT FROM h OR c.attribs#>>'{crm,brand}' IS DISTINCT FROM op.brand
  OR op.provider_id IS NOT NULL AND op.provider_id<>cid
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_OPERATION_CHANGED';END IF;
 snapshot:=CASE WHEN op.action='cancelar' THEN crm_audience_v2.native_internal_snapshot_history_v1(cid) ELSE crm_audience_v2.native_internal_snapshot_v1(cid) END;IF snapshot IS NULL THEN RAISE EXCEPTION 'NATIVE_INTERNAL_SNAPSHOT_REFUSED';END IF;
 SELECT validation INTO v FROM public.shrigma_campaign_validation WHERE provider_id=cid FOR UPDATE;
 p:=v->'_native_internal';at:=clock_timestamp();
 IF kind='provider' AND action='native_prepare' THEN
  IF snapshot->>'freeze_contract'='crm-native-frozen-list-v3' AND op.action='agendar' THEN RAISE EXCEPTION 'NATIVE_V3_NEW_SCHEDULE_CLOSED';END IF;
  IF effect<>jsonb_build_object('kind','provider','action','native_prepare','payload',jsonb_build_object('id',cid,'operationId',oid,'expectedVersion',cmd->>'expected_version')||CASE WHEN op.action='agendar' THEN jsonb_build_object('audienceReviewId',cmd->>'audience_review_id') ELSE '{}'::jsonb END)
   OR op.state<>'pending' OR public.shrigma_campaign_current(cid)->>'version' IS DISTINCT FROM cmd->>'expected_version'
   OR c.sent<>0 OR c.started_at IS NOT NULL OR c.send_at IS NULL OR c.send_at<=at
  THEN RAISE EXCEPTION 'NATIVE_INTERNAL_PREPARE_REFUSED';END IF;
  IF p IS NOT NULL AND p->>'stage'<>'complete' THEN RAISE EXCEPTION 'NATIVE_INTERNAL_TRANSITION_PENDING';END IF;
  IF op.action='agendar' THEN
   IF c.status::text<>'draft' OR c.send_at<at+interval '15 minutes' OR v->>'version' IS DISTINCT FROM cmd->>'expected_version'
    OR v->>'policy' IS DISTINCT FROM 'crm-campaign-v1' OR v->'ok' IS DISTINCT FROM 'true'::jsonb
    OR v#>>'{audience,review_id}' IS DISTINCT FROM cmd->>'audience_review_id'
    OR v#>>'{audience,campaign_version}' IS DISTINCT FROM cmd->>'expected_version'
    OR v#>>'{audience,brand}' IS DISTINCT FROM op.brand OR v#>'{audience,list_ids}' IS DISTINCT FROM jsonb_build_array(snapshot->'list_id')
   THEN RAISE EXCEPTION 'NATIVE_INTERNAL_REVIEW_REFUSED';END IF;
   expiry:=(v#>>'{audience,expires_at}')::timestamptz;checked:=(v#>>'{audience,checked_at}')::timestamptz;
   IF expiry IS NULL OR checked IS NULL OR checked>at OR expiry<=at OR expiry-checked<>interval '5 minutes' THEN RAISE EXCEPTION 'NATIVE_INTERNAL_REVIEW_EXPIRED';END IF;
   private_audience:=public.shrigma_campaign_audience(cid);
   IF coalesce(v->>'_audience_fingerprint','')!~'^[a-f0-9]{64}$' OR private_audience->>'_fingerprint' IS DISTINCT FROM v->>'_audience_fingerprint' OR private_audience->'eligible_count' IS DISTINCT FROM (CASE WHEN snapshot->>'freeze_contract'='crm-native-frozen-list-v3' THEN snapshot->'eligible_count' ELSE '1'::jsonb END)
    OR private_audience->'native_disabled_count' IS DISTINCT FROM '0'::jsonb THEN RAISE EXCEPTION 'NATIVE_INTERNAL_AUDIENCE_CHANGED';END IF;
   audience:=(v->'audience')||jsonb_build_object('rechecked_at',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  ELSE
   IF c.status::text<>'scheduled' THEN RAISE EXCEPTION 'NATIVE_INTERNAL_CANCEL_REFUSED';END IF;
   expiry:=at+interval '2 minutes';audience:=NULL;
  END IF;
  p:=jsonb_build_object('contract','crm-native-internal-transition-v1','operation_id',oid,'lease',olease,'actor',op.actor,
   'request_hash',h,'credential_sha256',credential_hash,'brand',op.brand,'campaign_id',cid,'action',op.action,
   'stage',CASE WHEN op.action='agendar' THEN 'schedule' ELSE 'to_draft' END,'snapshot',snapshot,
   'material_sha256',encode(sha256(convert_to((to_jsonb(c)-ARRAY['status','send_at','updated_at'])::text,'UTF8')),'hex'),
   'current_version',cmd->>'expected_version','send_at',c.send_at,'expires_at',least(expiry,at+interval '2 minutes'),'audience',audience);
  INSERT INTO public.shrigma_campaign_validation(provider_id,validation) VALUES(cid,coalesce(v,'{}'::jsonb)||jsonb_build_object('_native_internal',p))
   ON CONFLICT(provider_id) DO UPDATE SET validation=excluded.validation,updated_at=clock_timestamp();
  UPDATE public.shrigma_campaign_operation SET provider_id=cid,updated_at=clock_timestamp() WHERE id=oid;
  RETURN jsonb_build_object('contract','crm-native-internal-plan-v1','campaign_id',cid,'campaign_uuid',c.uuid,'list_id',snapshot->'list_id','send_at',public.shrigma_campaign_current(cid)->'send_at','stage',p->>'stage');
 END IF;
 IF p->>'contract' IS DISTINCT FROM 'crm-native-internal-transition-v1' OR p->>'operation_id' IS DISTINCT FROM oid::text
  OR p->>'lease' IS DISTINCT FROM olease::text OR p->>'request_hash' IS DISTINCT FROM h OR p->>'credential_sha256' IS DISTINCT FROM credential_hash
  OR p->'snapshot' IS DISTINCT FROM snapshot OR p->>'actor' IS DISTINCT FROM op.actor
 THEN RAISE EXCEPTION 'NATIVE_INTERNAL_PERMIT_CHANGED';END IF;
 IF kind='provider' AND action='native_result' THEN
  IF effect<>jsonb_build_object('kind','provider','action','native_result','payload',jsonb_build_object('id',cid,'operationId',oid))
   OR op.state<>'succeeded' OR p->>'stage'<>'complete' OR op.response#>'{body,campaign}' IS DISTINCT FROM public.shrigma_campaign_current(cid)
  THEN RAISE EXCEPTION 'NATIVE_INTERNAL_RESULT_UNCONFIRMED';END IF;
  RETURN (op.response#>'{body,campaign}')||jsonb_build_object('native_internal',true)||CASE WHEN op.action='agendar' THEN jsonb_build_object('audience',op.response#>'{body,audience}') ELSE '{}'::jsonb END;
 END IF;
 IF effect ? 'action' OR (SELECT count(*) FROM jsonb_object_keys(effect))<>3 OR effect->>'idCampaign' IS DISTINCT FROM cid::text
  OR kind NOT IN('nativeStatus','nativeClear','nativeRead') THEN RAISE EXCEPTION 'NATIVE_INTERNAL_EFFECT_REFUSED';END IF;
 IF kind='nativeRead' THEN
  IF payload<>'{}'::jsonb OR op.state NOT IN('pending','succeeded','outcome_unknown') THEN RAISE EXCEPTION 'NATIVE_INTERNAL_EFFECT_REFUSED';END IF;
 ELSE
  IF (op.state='pending' OR (op.state='outcome_unknown' AND op.action='cancelar' AND p->>'stage'='clear_send_at' AND p#>>'{recovery,contract}'='crm-native-cancel-recovery-v1' AND p#>>'{recovery,operation_id}'=op.id::text AND p#>>'{recovery,request_hash}'=op.request_hash)) IS DISTINCT FROM true OR p->>'expires_at' IS NULL OR (p->>'expires_at')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'NATIVE_INTERNAL_PERMIT_EXPIRED';END IF;
  IF (kind='nativeStatus' AND NOT((p->>'stage'='schedule' AND payload=jsonb_build_object('status','scheduled')) OR(p->>'stage'='to_draft' AND payload=jsonb_build_object('status','draft')))
   OR kind='nativeClear' AND (p->>'stage'<>'clear_send_at' OR payload IS DISTINCT FROM jsonb_build_object('send_at',NULL,'lists',jsonb_build_array(snapshot->'list_id'),'attribs',c.attribs))) IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'NATIVE_INTERNAL_EFFECT_REFUSED';END IF;
 END IF;
 RETURN jsonb_build_object('ok',true,'kind',kind,'operation_id',oid,'campaign_id',cid,'checked_at',clock_timestamp());
END $effect$;

CREATE OR REPLACE FUNCTION crm_audience_v2.catalog_lists(b text)
RETURNS TABLE(id integer,name text,status text,optin text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $catalog_snapshot$
 SELECT l.id,l.name::text,l.status::text,l.optin::text FROM public.lists l
 WHERE b IN ('fish','aristo') AND public.shrigma_campaign_list_brand(l)=b
 AND NOT EXISTS (
  SELECT 1 FROM crm_audience_v2.request r
  CROSS JOIN LATERAL (SELECT r.response->'_body' v) x
  WHERE r.brand=b AND r.payload->>'acao'='segmento_congelar_nativo_interno'
   AND r.payload->>'brand'=b AND r.payload->>'idempotency_key'=r.operation_key
   AND r.response->'_http'='200'::jsonb
   AND x.v->>'contract'='crm-native-frozen-internal-list-v2'
   AND x.v->>'brand'=b AND x.v->'internal_test'='true'::jsonb
   AND x.v->'schedules'='false'::jsonb AND x.v->'sends'='false'::jsonb
   AND x.v->'eligible_count'='1'::jsonb
   AND x.v->>'list_id'=l.id::text AND x.v->>'list_uuid'=l.uuid::text
   AND x.v->>'audience_id'=r.payload->>'id'
   AND x.v->'audience_version'=r.payload->'expected_version'
   AND x.v->>'definition_hash'=r.payload->>'expected_definition_hash'
   AND x.v->>'definition_hash'~'^[a-f0-9]{64}$'
   AND r.payload->>'expected_context_hash'~'^[a-f0-9]{64}$'
   AND r.payload->>'expected_catalog_hash'~'^[a-f0-9]{64}$'
   AND r.payload_hash=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((
    SELECT '{'||pg_catalog.string_agg(pg_catalog.to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}'
    FROM pg_catalog.jsonb_each(r.payload)e(k,v)
   ),'UTF8')),'hex')
   AND x.v->>'members_sha256'=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('[26948228]','UTF8')),'hex')
   AND l.type::text='private' AND l.optin::text='double' AND l.status::text='active'
   AND (SELECT pg_catalog.count(*) FROM public.subscriber_lists sl WHERE sl.list_id=l.id)=1
   AND EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.list_id=l.id AND sl.subscriber_id=26948228 AND sl.status::text='confirmed')
 )
 AND NOT EXISTS(
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
 ORDER BY l.id LIMIT 1001 FOR SHARE OF l
 $catalog_snapshot$;
DO $returnpost$ DECLARE p record; e record; BEGIN IF current_user<>'postgres' THEN RAISE EXCEPTION 'NATIVE_V3_OWNER_REQUIRED';END IF; FOR e IN SELECT * FROM (VALUES
 ('crm_audience_v2.freeze_native_internal_saved_audience_20261017(text,text,uuid,integer,text,text,text,jsonb,jsonb,text,text)','ab0337494a1578a8ec61423b09b5b230','de3acaefa2fbe5de94c089ceb592fd3853ce48678aefba3c52365414d1aa1720','0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491','fd2d1176a71c0e85b31f6a7e8f2bfe277403c000cda88c7a0000fcffc203d31a'),
 ('crm_audience_v2.native_internal_snapshot_history_v1(integer)','53d65cc4e58a24e4f7eda18e1c7b7bfc','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3','0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491','e4a49a8162c3bf2360b93419074b836e425d5301ca71ce7ef9650f8530e54ea8'),
 ('crm_audience_v2.native_internal_snapshot_v1(integer)','1b1e8f033d395937d3dcc871b8fdd83c','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3','0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491','128a671f042dedad546b199f18b3871f4147dca83db4c46fffecfa546cc685e7'),
 ('crm_audience_v2.native_internal_effect_v1(text,jsonb,jsonb)','d5f4224958cc42590e348debacb195f4','c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3','0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491','8101945b9dc016e4ef7fd797de2f54877884ea0e75eeb940f2c76ff4f03a3ddc'),
 ('crm_audience_v2.catalog_lists(text)','98ca7d3d8fa47e1df9d9cc733c929c29','de3acaefa2fbe5de94c089ceb592fd3853ce48678aefba3c52365414d1aa1720','0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491','a9a0d1714da224f39e803ac5067f31514f6ed36b574564eebda212a006572018'))v(signature,body_md5,acl_sha256,config_sha256,definition_hash) LOOP SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(e.signature); IF md5(p.prosrc)<>e.body_md5 OR pg_get_userbyid(p.proowner)<>'postgres' OR NOT p.prosecdef OR p.provolatile<>'v' OR encode(sha256(convert_to(coalesce(p.proacl::text,''),'UTF8')),'hex')<>e.acl_sha256 OR encode(sha256(convert_to(coalesce(p.proconfig::text,''),'UTF8')),'hex')<>e.config_sha256 OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>e.definition_hash THEN RAISE EXCEPTION 'NATIVE_V3_BASE_DRIFT';END IF; END LOOP;END $returnpost$;
COMMIT;
