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
