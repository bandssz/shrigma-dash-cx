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
