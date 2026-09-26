-- Planning catalog only. One implicit transaction; no native writes or runtime grants.
DO $install$
BEGIN
 IF to_regnamespace('crm_graph_candidate') IS NULL THEN RAISE EXCEPTION 'GRAPH_STORE_REQUIRED';END IF;
 IF to_regclass('public.shrigma_flow_definition') IS NULL OR to_regclass('public.shrigma_template_email_registry') IS NULL OR to_regclass('public.templates') IS NULL THEN RAISE EXCEPTION 'GRAPH_CATALOG_DEPENDENCY';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='crm_graph_candidate'::regnamespace AND p.proname IN ('catalog_v1','catalog_ui_v1')) THEN RAISE EXCEPTION 'GRAPH_CATALOG_COLLISION';END IF;
 EXECUTE $ddl$
 CREATE FUNCTION crm_graph_candidate.catalog_v1(b text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate AS $fn$
 DECLARE messages jsonb;source_present boolean;total integer;
 BEGIN
  IF b IS NULL OR b NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'GRAPH_CATALOG_BRAND';END IF;
  -- Availability means that a real published legacy source can be selected for
  -- planning. This does not attest freshness, enrollment or an installed worker.
  SELECT EXISTS(SELECT 1 FROM public.shrigma_flow_definition f WHERE f.key=b||':carrinho' AND f.brand=b AND f.runtime_ready IS TRUE AND f.published_version>0 AND jsonb_typeof(f.published)='object' AND jsonb_typeof(f.published->'steps')='array') INTO source_present;
  SELECT count(*) INTO total FROM public.templates t WHERE t.type::text='tx' AND NOT starts_with(t.name,'__shrigma_journey_tx_v1_')
   AND EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=t.id AND r.brand=b)
   AND NOT EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=t.id AND r.brand IS DISTINCT FROM b);
  IF total>64 THEN RAISE EXCEPTION 'GRAPH_CATALOG_LIMIT';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('key','email.template.'||t.id::text,'brand',b,'channel','email','available',true,
   'release','snapshot_'||substr(encode(sha256(convert_to(jsonb_build_object('type',t.type,'subject',t.subject,'body',t.body,'body_source',to_jsonb(t)->'body_source')::text,'UTF8')),'hex'),1,48),
   'required_fields','[]'::jsonb) ORDER BY t.id),'[]') INTO messages
   FROM public.templates t WHERE t.type::text='tx' AND NOT starts_with(t.name,'__shrigma_journey_tx_v1_')
   AND EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=t.id AND r.brand=b)
   AND NOT EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=t.id AND r.brand IS DISTINCT FROM b);
  RETURN jsonb_build_object('version','journey_graph_v1','brand',b,
   'triggers',jsonb_build_array(jsonb_build_object('key','cart.abandoned','brand',b,'available',source_present,'fields',jsonb_build_array('cart.abandoned_at','purchase.confirmed','contact.email_allowed'))),
   'fields',jsonb_build_array(
    jsonb_build_object('key','cart.abandoned_at','type','timestamp','available',source_present,'max_age_seconds',300),
    jsonb_build_object('key','purchase.confirmed','type','boolean','available',false,'max_age_seconds',300),
    jsonb_build_object('key','contact.email_allowed','type','boolean','available',false,'max_age_seconds',300)),
   'messages',messages);
 END $fn$;
 $ddl$;
 EXECUTE $ddl$
 CREATE FUNCTION crm_graph_candidate.catalog_ui_v1(b text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate AS $fn$
 DECLARE catalog jsonb:=crm_graph_candidate.catalog_v1(b);labels jsonb;published_version integer;
 BEGIN
  SELECT coalesce(jsonb_object_agg('email.template.'||t.id::text,left(regexp_replace(coalesce(nullif(btrim(t.name),''),'E-mail '||t.id::text),'[[:cntrl:]]','','g'),160)),'{}') INTO labels
   FROM public.templates t WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(catalog->'messages') m WHERE m->>'key'='email.template.'||t.id::text);
  SELECT f.published_version INTO published_version FROM public.shrigma_flow_definition f WHERE f.key=b||':carrinho' AND f.brand=b;
  RETURN jsonb_build_object('catalog',catalog,'labels',jsonb_build_object(
   'triggers',jsonb_build_object('cart.abandoned','Carrinho abandonado'),
   'fields',jsonb_build_object('cart.abandoned_at','Data do abandono','purchase.confirmed','Compra após o abandono','contact.email_allowed','Permissão atual de e-mail'),
   'messages',labels),
   'readiness',jsonb_build_object('draft_only',true,'publish',false,'runtime',false,'transport',false,'source_complete',false,'immutable_release',false,'template_variables_bound',false,
    'published_legacy_version',published_version,'template_source','registered_tx_snapshot','source_model','subscriber_brand_cart_abandoned_at'),
   'unsupported',jsonb_build_array(
    jsonb_build_object('key','purchase.confirmed','label','Compra após o abandono','reason','Fonte completa ainda não conectada'),
    jsonb_build_object('key','contact.email_allowed','label','Permissão atual de e-mail','reason','Conferência antes do envio ainda não conectada'),
    jsonb_build_object('key','whatsapp','label','WhatsApp','reason','Este construtor prepara apenas e-mail'),
    jsonb_build_object('key','other_events','label','Outras entradas','reason','Disponível neste recorte: carrinho abandonado')),
   'checked_at',statement_timestamp());
 END $fn$;
 $ddl$;
 REVOKE ALL ON FUNCTION crm_graph_candidate.catalog_v1(text),crm_graph_candidate.catalog_ui_v1(text) FROM PUBLIC;
END $install$;
