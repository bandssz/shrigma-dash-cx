BEGIN;SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='15s';SET LOCAL search_path=pg_catalog;DO $guard$ BEGIN IF current_user<>'postgres' OR (SELECT system_identifier::text FROM pg_control_system())<>'7641650273200603174' OR current_database()<>'listmonk' OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.native_internal_snapshot_v1(integer)') AND md5(prosrc)='1b1e8f033d395937d3dcc871b8fdd83c' AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND provolatile='v' AND encode(sha256(convert_to(coalesce(proacl::text,''),'UTF8')),'hex')='c027e95beca64045f15d2075c66162eeeeb192e6756be61c73f91c7ce14dd4f3' AND encode(sha256(convert_to(coalesce(proconfig::text,''),'UTF8')),'hex')='0e5c5deb67bdf8a0f1c087edd287aeab8d3ca04e5548a7679dd526aad7d8d491') THEN RAISE EXCEPTION 'CONSENT_LIVE_BASE_DRIFT';END IF;END $guard$;CREATE OR REPLACE FUNCTION crm_audience_v2.native_internal_snapshot_v1(pid integer) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $snapshot$
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
 (
 WITH h AS MATERIALIZED(SELECT crm_audience_v2.native_internal_snapshot_history_v1(pid) s),
 frozen_list AS MATERIALIZED(
  SELECT selected.* FROM h JOIN public.lists selected ON selected.id=(h.s->>'list_id')::integer
  WHERE h.s->>'freeze_contract'='crm-native-frozen-list-v3'
 )
 SELECT h.s||jsonb_build_object('list_hash',encode(sha256(convert_to(to_jsonb(l)::text,'UTF8')),'hex'))
 FROM h
 JOIN frozen_list l ON l.id=(h.s->>'list_id')::integer
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
 )
 LIMIT 1
$snapshot$;DO $post$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.native_internal_snapshot_v1(integer)'))<>'e2034c34dfc4832cb8ad4e2423d5f3b8' THEN RAISE EXCEPTION 'CONSENT_LIVE_POST_DRIFT';END IF;END $post$;COMMIT;
