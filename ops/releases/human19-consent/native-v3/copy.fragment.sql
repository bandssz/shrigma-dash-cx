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
