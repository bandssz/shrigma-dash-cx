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
