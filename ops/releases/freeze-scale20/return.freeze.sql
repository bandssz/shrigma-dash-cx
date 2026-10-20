CREATE OR REPLACE FUNCTION crm_audience_v2.freeze_native_internal_saved_audience_20261017(access_key text, b text, audience_id uuid, expected_version integer, expected_definition_hash text, expected_context_hash text, expected_catalog_hash text, catalog_input jsonb, current_context jsonb, request_key text, payload_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
 IF is_v3 THEN RAISE EXCEPTION 'NATIVE_NEW_FREEZE_CLOSED';END IF;
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
END $function$

