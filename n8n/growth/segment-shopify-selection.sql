-- Additive reviewed extension to the installed regular worker SQL. All existing
-- function ACLs are preserved by CREATE OR REPLACE. No source/send gate is enabled.
-- Apply atomically after segment-shopify-facts.sql; never rerun the base installs.
DO $boundary$
BEGIN
 IF to_regclass('crm_audience_v2.shopify_source') IS NULL
  OR to_regprocedure('crm_audience_v2.selection_shopify_rule(jsonb,integer,text,jsonb)') IS NOT NULL THEN
  RAISE EXCEPTION 'SHOPIFY_INTEGRATION_DEPENDENCY_OR_COLLISION';
 END IF;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled) THEN
  RAISE EXCEPTION 'SHOPIFY_INTEGRATION_REQUIRES_WORKER_OFF';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_rule(jsonb,integer,text,integer,jsonb)')) IS DISTINCT FROM '3a73d33fd5047912f81e708affba8641' THEN RAISE EXCEPTION 'SHOPIFY_INTEGRATION_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_context(integer,text,boolean)')) IS DISTINCT FROM '6d8519c41390e45c83de81d0a29d493c' THEN RAISE EXCEPTION 'SHOPIFY_INTEGRATION_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_regular_rule_match(jsonb,integer[],integer,text)')) IS DISTINCT FROM '6a466c3c4940a082dbc38c0713b97c76' THEN RAISE EXCEPTION 'SHOPIFY_INTEGRATION_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_regular_matches(jsonb,integer)')) IS DISTINCT FROM '498bedcb16841d5422733d25043c78ed' THEN RAISE EXCEPTION 'SHOPIFY_INTEGRATION_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.regular_delivery_claim(integer,integer,uuid,text,text,text,text,text,jsonb)')) IS DISTINCT FROM 'e7d321f4e826aa0dd501c9dc26300441' THEN RAISE EXCEPTION 'SHOPIFY_INTEGRATION_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.refresh_native_catalog(text)')) IS DISTINCT FROM 'a5d67bc9482f704ec18cffa06b12b17d' THEN RAISE EXCEPTION 'SHOPIFY_INTEGRATION_BASE_DRIFT'; END IF;
END $boundary$;

CREATE FUNCTION crm_audience_v2.shopify_source_hash(b text,field text,catalog jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT CASE WHEN b IN('fish','aristo') AND field IN('purchase.count','purchase.amount','purchase.last_date')
 AND catalog->>'shop_id' ~ '^gid://shopify/Shop/[1-9][0-9]{0,19}$' AND catalog->>'currency' ~ '^[A-Z]{3}$'
 AND catalog->>'timezone'='America/Sao_Paulo' THEN encode(sha256(convert_to(
 '{"brand":'||to_jsonb(b)::text||',"currency":'||(catalog->'currency')::text||',"field":'||to_jsonb(field)::text||
 ',"semantics":{"amount":"Customer.amountSpent in shop currency","api":"2026-07","count":"Customer.numberOfOrders","coverage":"completed reconciled customer export; missing and ambiguous identities unknown","freshness":"snapshot observed during export; expires 26 hours after export start","identity":"unique Customer GID and native subscriber UUID; no automatic reassignment","last_date":"Customer.lastOrder.createdAt in shop timezone","negative":"explicit Customer aggregate only; no claim about another Customer identity","query_sha256":"1ca989e8c1e9f00478e3e069f70a8fe3f0a20d1fb730022cdb766bf738a65b48","version":"shopify-customer-bulk-facts-v1"},"shop_id":'||(catalog->'shop_id')::text||',"timezone":'||(catalog->'timezone')::text||'}','UTF8')),'hex') END
$fn$;
CREATE FUNCTION crm_audience_v2.shopify_catalog(b text,native jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE cfg crm_audience_v2.shopify_source%ROWTYPE; composed jsonb; fields jsonb; k text;
BEGIN
 SELECT * INTO cfg FROM crm_audience_v2.shopify_source WHERE brand=b;
 IF NOT FOUND THEN RETURN native; END IF;
 composed:=native||jsonb_build_object('shop_id',cfg.shop_id,'currency',cfg.currency,'timezone',cfg.timezone);
 FOREACH k IN ARRAY ARRAY['purchase.count','purchase.amount','purchase.last_date'] LOOP
  IF cfg.field_hashes->>k IS DISTINCT FROM crm_audience_v2.shopify_source_hash(b,k,composed) THEN RAISE EXCEPTION 'SHOPIFY_SOURCE_PIN'; END IF;
 END LOOP;
 SELECT jsonb_agg(CASE WHEN f->>'key' IN('purchase.count','purchase.amount','purchase.last_date')
  THEN f||jsonb_build_object('available',true,'source_hash',cfg.field_hashes->>(f->>'key')) ELSE f END ORDER BY n)
 INTO fields FROM jsonb_array_elements(native->'fields') WITH ORDINALITY AS x(f,n);
 RETURN composed||jsonb_build_object('fields',fields);
END $fn$;
CREATE FUNCTION crm_audience_v2.selection_shopify_rule(rule jsonb,sid integer,b text,source_config jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE pin text; cfg crm_audience_v2.shopify_source%ROWTYPE; matched boolean;
BEGIN
 IF NOT crm_audience_v2.shopify_rule_valid(rule) THEN RETURN NULL; END IF;
 pin:=crm_audience_v2.shopify_source_hash(b,rule->>'field',source_config);
 SELECT * INTO cfg FROM crm_audience_v2.shopify_source WHERE brand=b;
 IF NOT FOUND OR NOT cfg.enabled OR pin IS NULL OR cfg.field_hashes->>(rule->>'field') IS DISTINCT FROM pin
  OR crm_audience_v2.shopify_snapshot(b)->'current' IS DISTINCT FROM 'true'::jsonb
  OR (SELECT count(*) FROM jsonb_array_elements(source_config->'fields') f WHERE f->>'key'=rule->>'field'
   AND f->'available'='true'::jsonb AND f->>'source_hash'=pin)<>1 THEN RETURN NULL; END IF;
 -- sid=0 validates context only. Individual unknown facts never become false.
 matched:=CASE WHEN sid=0 THEN false ELSE crm_audience_v2.shopify_customer_match(rule,sid,b,pin) END;
 RETURN jsonb_build_object('match',matched,'nodes',1,'pins',jsonb_build_array(jsonb_build_object(
  'rule_key','{"op":"condition","field":'||to_jsonb(rule->>'field')::text||',"operator":'||to_jsonb(rule->>'operator')::text||',"value":'||(rule->'value')::text||'}',
  'source','shopify','source_hash',pin,'shop_id',cfg.shop_id,'currency',cfg.currency,'timezone',cfg.timezone)));
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_source_hash(text,text,jsonb),crm_audience_v2.shopify_catalog(text,jsonb),
 crm_audience_v2.selection_shopify_rule(jsonb,integer,text,jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION crm_audience_v2.selection_rule(rule jsonb,sid integer,brand text,depth integer DEFAULT 1,source_config jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE child jsonb; result jsonb; matches boolean; nodes integer:=1;
 pins jsonb:='[]'::jsonb; selected_list_id integer; native_optin text; source_hash text;
BEGIN
 IF depth<1 OR depth>4 OR jsonb_typeof(rule) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF rule->>'op'='in_list' THEN
  IF rule-'op'-'list_id'<>'{}'::jsonb OR NOT(rule ?& ARRAY['op','list_id'])
   OR jsonb_typeof(rule->'list_id') IS DISTINCT FROM 'number'
   OR (rule->>'list_id') !~ '^[1-9][0-9]{0,9}$'
   OR (rule->>'list_id')::numeric>2147483647 THEN RETURN NULL; END IF;
  selected_list_id:=(rule->>'list_id')::integer;
  SELECT l.optin::text INTO native_optin FROM public.lists l
   WHERE l.id=selected_list_id AND l.status::text='active'
   AND public.shrigma_campaign_list_brand(l)=brand AND l.optin::text IN('single','double');
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.subscriber_id=sid AND sl.list_id=selected_list_id
   AND ((native_optin='double' AND sl.status::text='confirmed')
    OR (native_optin='single' AND sl.status::text IN('confirmed','unconfirmed')))) INTO matches;
  RETURN jsonb_build_object('match',matches,'nodes',1,'pins',jsonb_build_array(jsonb_build_object(
   'rule_key','{"op":"in_list","list_id":'||selected_list_id||'}','list_id',selected_list_id,'optin',native_optin)));
 END IF;
 IF rule->>'op'='condition' THEN
  -- Legacy combined callers pass no source configuration and stay list-only.
  IF source_config IS NULL THEN RETURN NULL; END IF;
  IF rule->>'field' IN('purchase.count','purchase.amount','purchase.last_date') THEN
   RETURN crm_audience_v2.selection_shopify_rule(rule,sid,brand,source_config);
  END IF;
  source_hash:=crm_audience_v2.selection_engagement_source_hash(brand,rule->>'field');
  IF source_hash IS NULL OR (SELECT count(*) FROM jsonb_array_elements(source_config->'fields') f
   WHERE f->>'key'=rule->>'field' AND f->'available'='true'::jsonb AND f->>'source_hash'=source_hash)<>1 THEN RETURN NULL; END IF;
  matches:=crm_audience_v2.selection_engagement_match(rule,sid,brand);
  IF matches IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('match',matches,'nodes',1,'pins',jsonb_build_array(jsonb_build_object(
   'rule_key','{"op":"condition","field":'||to_jsonb(rule->>'field')::text||',"operator":'||to_jsonb(rule->>'operator')::text||',"value":'||(rule->>'value')||'}',
   'source','email','source_hash',source_hash)));
 END IF;
 IF rule->>'op' NOT IN('and','or') OR rule->>'op' IS NULL
  OR rule-'op'-'rules'<>'{}'::jsonb OR jsonb_typeof(rule->'rules') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 IF jsonb_array_length(rule->'rules')<1 OR jsonb_array_length(rule->'rules')>16 THEN RETURN NULL; END IF;
 matches:=rule->>'op'='and';
 FOR child IN SELECT value FROM jsonb_array_elements(rule->'rules') LOOP
  result:=crm_audience_v2.selection_rule(child,sid,brand,depth+1,source_config);
  IF result IS NULL THEN RETURN NULL; END IF;
  nodes:=nodes+(result->>'nodes')::integer; IF nodes>32 THEN RETURN NULL; END IF;
  pins:=pins||(result->'pins');
  IF rule->>'op'='and' THEN matches:=matches AND (result->>'match')::boolean;
  ELSE matches:=matches OR (result->>'match')::boolean; END IF;
 END LOOP;
 RETURN jsonb_build_object('match',matches,'nodes',nodes,'pins',pins);
END $fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.selection_context(cid integer,expected_query_sha256 text,native_engagement boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE b crm_audience_v2.campaign_binding%ROWTYPE; r crm_audience_v2.revision%ROWTYPE;
 c crm_audience_v2.config%ROWTYPE; result jsonb; base_result jsonb; current_context jsonb;
 current_pins jsonb; seen_at timestamptz:=statement_timestamp();
BEGIN
 SELECT * INTO b FROM crm_audience_v2.campaign_binding_effective(cid);
 IF NOT FOUND THEN RETURN jsonb_build_object('bound',false); END IF; -- Preserve unbound native selection.
 IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.selection_runtime rt WHERE rt.singleton AND rt.enabled
  AND rt.candidate_query_sha256=expected_query_sha256
  AND isfinite(rt.verified_at) AND rt.verified_at<=seen_at AND rt.verified_at>seen_at-interval '5 minutes') THEN RETURN NULL; END IF;
 SELECT * INTO r FROM crm_audience_v2.revision WHERE audience_id=b.audience_id AND version=b.audience_revision;
 IF NOT FOUND OR r.archived OR r.definition_hash IS DISTINCT FROM b.definition_hash OR r.context_hash IS DISTINCT FROM b.context_hash
  OR crm_audience_v2.selection_hash(r.definition) IS DISTINCT FROM b.definition_hash
  OR crm_audience_v2.selection_hash(r.context) IS DISTINCT FROM b.context_hash
  OR r.definition->>'schema_version' IS DISTINCT FROM 'crm-audience-v2' OR r.definition->>'brand' IS DISTINCT FROM b.brand
  OR r.definition-'schema_version'-'brand'-'name'-'rule'<>'{}'::jsonb
  OR NOT(r.definition ?& ARRAY['schema_version','brand','name','rule']) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.audience a WHERE a.id=b.audience_id AND a.brand=b.brand AND NOT a.archived) THEN RETURN NULL; END IF;
 IF b.binding->>'contract' IS DISTINCT FROM 'crm-audience-campaign-binding-v1'
  OR b.binding->'definition' IS DISTINCT FROM r.definition OR b.binding->'context' IS DISTINCT FROM r.context
  OR crm_audience_v2.selection_hash(b.binding) IS DISTINCT FROM b.binding_hash
  OR b.binding->>'brand' IS DISTINCT FROM b.brand
  OR b.binding->'campaign_id' IS DISTINCT FROM to_jsonb(b.campaign_id)
  OR b.binding->'binding_version' IS DISTINCT FROM to_jsonb(b.binding_version)
  OR b.binding->>'audience_id' IS DISTINCT FROM b.audience_id::text
  OR b.binding->'audience_revision' IS DISTINCT FROM to_jsonb(b.audience_revision)
  OR b.binding->>'definition_hash' IS DISTINCT FROM b.definition_hash
  OR b.binding->>'context_hash' IS DISTINCT FROM b.context_hash
  OR b.binding->'base_list_id' IS DISTINCT FROM to_jsonb(b.base_list_id)
  OR b.binding->>'campaign_version' IS DISTINCT FROM b.campaign_version
  OR b.binding->>'catalog_hash' IS DISTINCT FROM b.catalog_hash
  OR b.binding->'authorizes_selection' IS DISTINCT FROM 'false'::jsonb
  OR b.binding->'authorizes_send' IS DISTINCT FROM 'false'::jsonb THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding_revision h WHERE h.campaign_id=cid
  AND h.binding_version=b.binding_version AND h.binding=b.binding AND h.binding_hash=b.binding_hash) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.campaigns ca WHERE ca.id=cid AND ca.type::text='regular'
  AND ca.messenger::text='email' AND ca.attribs#>>'{crm,brand}'=b.brand) THEN RETURN NULL; END IF;
 -- Native enumeration must cover exactly the brand base, not an arbitrary
 -- native union that would silently narrow an OR audience before this filter.
 IF (SELECT array_agg(cl.list_id ORDER BY cl.list_id) FROM public.campaign_lists cl WHERE cl.campaign_id=cid)
  IS DISTINCT FROM ARRAY[b.base_list_id] THEN RETURN NULL; END IF;
 SELECT * INTO c FROM crm_audience_v2.config WHERE brand=b.brand;
 IF NOT FOUND OR NOT c.enabled OR c.base_list_id IS DISTINCT FROM b.base_list_id OR c.catalog IS NULL
  OR c.checked_at IS NULL OR c.expires_at IS NULL
  OR NOT isfinite(c.checked_at) OR NOT isfinite(c.expires_at) OR c.checked_at>seen_at OR c.expires_at<=seen_at
  OR c.expires_at>c.checked_at+interval '5 minutes'
  OR NOT crm_audience_v2.selection_catalog_valid(c.catalog,b.brand)
  OR NOT crm_audience_v2.selection_lists_valid(b.brand) THEN RETURN NULL; END IF;
 result:=crm_audience_v2.selection_rule(r.definition->'rule',0,b.brand,1,CASE WHEN native_engagement THEN c.catalog ELSE NULL END);
 base_result:=crm_audience_v2.selection_rule(jsonb_build_object('op','in_list','list_id',b.base_list_id),0,b.brand);
 IF result IS NULL OR base_result IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_agg(p ORDER BY (p->>'rule_key') COLLATE "C") INTO current_pins
  FROM (SELECT DISTINCT value AS p FROM jsonb_array_elements(result->'pins')) q;
 current_context:=jsonb_build_object('contract','crm-audience-context-v1','hash_contract','canonical-json-sorted-keys-sha256-v1',
  'brand',b.brand,'base',jsonb_build_object('id',b.base_list_id,'brand',b.brand,'optin',base_result#>>'{pins,0,optin}'),'rules',current_pins);
 IF current_context IS DISTINCT FROM r.context OR crm_audience_v2.selection_hash(current_context) IS DISTINCT FROM b.context_hash THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('bound',true,'brand',b.brand,'base_list_id',b.base_list_id,'definition',r.definition,
  'shopify_expires_at',CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(current_pins) p WHERE p->>'source'='shopify')
   THEN crm_audience_v2.shopify_snapshot(b.brand)->'expires_at' END,
  'list_pins',(SELECT jsonb_agg(pin) FROM jsonb_array_elements(current_pins||(base_result->'pins')) pin WHERE pin ? 'list_id'));
END $fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.selection_regular_rule_match(rule jsonb,consented integer[],sid integer,brand text) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE child jsonb; matched boolean; result boolean; pin text;
 BEGIN
  IF rule->>'op'='in_list' THEN RETURN (rule->>'list_id')::integer=ANY(consented); END IF;
  IF rule->>'op'='condition' THEN
   IF rule->>'field' IN('purchase.count','purchase.amount','purchase.last_date') THEN
    SELECT field_hashes->>(rule->>'field') INTO pin FROM crm_audience_v2.shopify_source WHERE shopify_source.brand=selection_regular_rule_match.brand;
    RETURN crm_audience_v2.shopify_customer_match(rule,sid,brand,pin);
   END IF;
   matched:=crm_audience_v2.selection_engagement_match(rule,sid,brand);
   IF matched IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
   RETURN matched;
  END IF;
  IF rule->>'op' NOT IN('and','or') OR rule->>'op' IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE';
  END IF;
  result:=rule->>'op'='and';
  FOR child IN SELECT value FROM jsonb_array_elements(rule->'rules') LOOP
   matched:=crm_audience_v2.selection_regular_rule_match(child,consented,sid,brand);
   IF rule->>'op'='and' THEN result:=result AND matched; ELSE result:=result OR matched; END IF;
  END LOOP;
  RETURN result;
 END $fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.selection_regular_matches(ctx jsonb,sid integer) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE consented integer[]; matched boolean;
 BEGIN
  IF ctx IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
  IF ctx->'bound'='false'::jsonb THEN RETURN true; END IF;
  -- A real opt-out, disabled contact or expression non-match is ineligible;
  -- source/runtime/context failure above must never be represented as zero.
  IF NOT EXISTS(SELECT 1 FROM public.subscribers s WHERE s.id=sid AND s.status::text='enabled') THEN RETURN false; END IF;
  SELECT coalesce(array_agg(sl.list_id),ARRAY[]::integer[]) INTO consented FROM public.subscriber_lists sl
   WHERE sl.subscriber_id=sid AND ctx->'list_ids' @> to_jsonb(sl.list_id)
    AND (sl.status::text='confirmed' OR (sl.status::text='unconfirmed' AND ctx->'single_list_ids' @> to_jsonb(sl.list_id)));
  IF NOT (ctx->>'base_list_id')::integer=ANY(consented) THEN RETURN false; END IF;
  matched:=crm_audience_v2.selection_regular_rule_match(ctx#>'{definition,rule}',consented,sid,ctx->>'brand');
  IF matched IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
  RETURN matched;
 END $fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.regular_delivery_claim(
 cid integer,sid integer,did uuid,worker_sha text,runtime_sha text,
 envelope_from text,envelope_to text,payload_sha text,subscriber_snapshot jsonb)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
 SET search_path=pg_catalog SET TimeZone='UTC' SET lock_timeout='500ms' AS $fn$
 #variable_conflict use_variable
 DECLARE c public.campaigns%ROWTYPE;e crm_audience_v2.regular_delivery_campaign%ROWTYPE;
 b crm_audience_v2.campaign_binding%ROWTYPE;s public.subscribers%ROWTYPE;
 ctx jsonb;d public.shrigma_email_dispatch%ROWTYPE;k text;piece text;token uuid;first_id integer;live_at timestamptz;valid_until timestamptz;
 timestamp_pattern text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?([+-][0-9]{2}:[0-9]{2}|Z)$';
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_DELIVERY_BOUNDARY';
  END IF;
  IF cid IS NULL OR cid<=0 OR sid IS NULL OR sid<=0 OR did IS NULL
   OR worker_sha IS NULL OR worker_sha !~ '^[0-9a-f]{64}$'
   OR runtime_sha IS NULL OR runtime_sha !~ '^[0-9a-f]{64}$'
   OR payload_sha IS NULL OR payload_sha !~ '^[0-9a-f]{64}$'
   OR nullif(envelope_from,'') IS NULL OR nullif(envelope_to,'') IS NULL
   OR jsonb_typeof(subscriber_snapshot) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'SEGMENT_DELIVERY_INPUT';
  END IF;
  -- One campaign lock serializes attempts across processes as well as workers.
  SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
  SELECT * INTO STRICT e FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=cid FOR UPDATE;
  SELECT * INTO STRICT b FROM crm_audience_v2.campaign_binding_effective(cid);
  IF NOT e.enabled OR e.suspended OR c.status::text<>'running'
   OR c.sent IS DISTINCT FROM e.acknowledged_sent OR c.last_subscriber_id IS DISTINCT FROM e.acknowledged_subscriber_id
   OR e.binding_version IS DISTINCT FROM b.binding_version OR e.binding_hash IS DISTINCT FROM b.binding_hash
   OR e.worker_sha256 IS DISTINCT FROM worker_sha OR e.runtime_sha256 IS DISTINCT FROM runtime_sha
   OR e.envelope_from IS DISTINCT FROM envelope_from THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_UNAVAILABLE';
  END IF;
  -- Stabilize every declared dependency and the live selector before comparing.
  PERFORM 1 FROM crm_audience_v2.selection_runtime FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.config WHERE brand=b.brand FOR SHARE;
  -- Freeze the source pointer until the durable claim commits.
  PERFORM 1 FROM crm_audience_v2.shopify_source WHERE brand=b.brand FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.audience WHERE id=b.audience_id FOR SHARE;
  PERFORM 1 FROM public.campaign_lists WHERE campaign_id=cid ORDER BY list_id FOR SHARE;
  PERFORM 1 FROM public.campaign_media WHERE campaign_id=cid ORDER BY media_id FOR SHARE;
  PERFORM 1 FROM public.templates WHERE id=c.template_id FOR SHARE;
  PERFORM 1 FROM public.lists WHERE id IN(SELECT list_id FROM public.campaign_lists WHERE campaign_id=cid) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.media WHERE id IN(SELECT media_id FROM public.campaign_media WHERE campaign_id=cid) ORDER BY id FOR SHARE;
  ctx:=crm_audience_v2.selection_worker_context(cid);
  PERFORM 1 FROM public.lists WHERE id IN(SELECT (value->>'list_id')::integer FROM jsonb_array_elements(ctx->'list_pins')) ORDER BY id FOR SHARE;
  -- The leaf locks may wait. Read the context again under a fresh READ COMMITTED
  -- command snapshot before treating the earlier source/pin check as current.
  ctx:=crm_audience_v2.selection_worker_context(cid);
  IF ctx->'bound' IS DISTINCT FROM 'true'::jsonb
   OR e.material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(cid) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_MATERIAL_DRIFT';
  END IF;
  piece:='audience-regular-v1:'||cid::text;
  k:=jsonb_build_array(cid,b.binding_version,sid)::text;
  SELECT * INTO d FROM public.shrigma_email_dispatch x
   WHERE x.brand=b.brand AND x.flow='campaign' AND x.piece=piece AND x.dedupe_key=k FOR UPDATE;
  IF FOUND THEN
   RETURN jsonb_build_object('should_send',false,'reason',d.transport_state,'dispatch_id',d.dispatch_id,'claim_token',NULL);
  END IF;
  IF EXISTS(SELECT 1 FROM public.shrigma_email_dispatch x WHERE x.brand=b.brand
   AND x.flow='campaign' AND x.piece=piece AND x.transport_state IN('in_flight','outcome_unknown')) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_RECONCILIATION_REQUIRED';
  END IF;
  IF sid<=c.last_subscriber_id THEN
   RETURN jsonb_build_object('should_send',false,'reason','already_checkpointed','dispatch_id',NULL,'claim_token',NULL);
  END IF;
  IF sid>c.max_subscriber_id THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_CURSOR'; END IF;
  SELECT * INTO STRICT s FROM public.subscribers WHERE id=sid FOR UPDATE;
  PERFORM 1 FROM public.subscriber_lists WHERE subscriber_id=sid ORDER BY list_id FOR SHARE;
  ctx:=crm_audience_v2.selection_worker_context(cid);
  -- Never jump over another currently eligible recipient; a mutex alone cannot
  -- guarantee ordering when several native workers dequeue concurrently.
  SELECT min(sl.subscriber_id) INTO first_id FROM public.subscriber_lists sl
   WHERE sl.list_id=b.base_list_id AND sl.subscriber_id>c.last_subscriber_id AND sl.subscriber_id<=sid
    AND crm_audience_v2.selection_regular_matches(ctx,sl.subscriber_id);
  IF first_id IS NOT NULL AND first_id<>sid THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_ORDER'; END IF;
  ctx:=crm_audience_v2.selection_worker_context(cid);
  -- Selector snapshots intentionally use statement_timestamp for count/batch
  -- consistency. Delivery must additionally recheck the wall clock after waits.
  live_at:=clock_timestamp();
  SELECT least(cfg.expires_at,rt.verified_at+interval '5 minutes',(ctx->>'shopify_expires_at')::timestamptz) INTO valid_until
   FROM crm_audience_v2.config cfg CROSS JOIN crm_audience_v2.selection_runtime rt
   WHERE cfg.brand=b.brand AND cfg.enabled AND rt.enabled;
  IF valid_until IS NULL OR NOT isfinite(valid_until) OR valid_until<=live_at THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SOURCE_EXPIRED';
  END IF;
  IF NOT crm_audience_v2.selection_regular_matches(ctx,sid) THEN
   UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_subscriber_id=sid WHERE campaign_id=cid;
   UPDATE public.campaigns SET last_subscriber_id=sid,updated_at=clock_timestamp() WHERE id=cid;
   RETURN jsonb_build_object('should_send',false,'reason','ineligible','dispatch_id',NULL,'claim_token',NULL);
  END IF;
  -- The native batch may use a different session timezone. Preserve every
  -- other raw field exactly, but compare the two native timestamptz columns
  -- as instants (including microseconds), never as formatted JSON strings.
  IF (to_jsonb(s)-ARRAY['created_at','updated_at']) IS DISTINCT FROM (subscriber_snapshot-ARRAY['created_at','updated_at'])
   OR NOT(subscriber_snapshot ?& ARRAY['created_at','updated_at'])
   OR jsonb_typeof(subscriber_snapshot->'created_at') NOT IN('string','null')
   OR jsonb_typeof(subscriber_snapshot->'updated_at') NOT IN('string','null')
   OR lower(s.email) IS DISTINCT FROM lower(envelope_to) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SUBSCRIBER_DRIFT';
  END IF;
  BEGIN
   IF (subscriber_snapshot->>'created_at') !~ timestamp_pattern
    OR (subscriber_snapshot->>'updated_at') !~ timestamp_pattern
    OR (subscriber_snapshot->>'created_at')::timestamptz IS DISTINCT FROM s.created_at
    OR (subscriber_snapshot->>'updated_at')::timestamptz IS DISTINCT FROM s.updated_at THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SUBSCRIBER_DRIFT';
   END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SUBSCRIBER_DRIFT';
  END;
  token:=gen_random_uuid();
  INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,
   account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
  SELECT did,b.brand,'campaign',piece,k,payload_sha,e.account_id,e.region,e.configuration_set,
   r.recipient_key,r.key_version,false,'in_flight',clock_timestamp(),token FROM public.shrigma_email_recipient_key(envelope_to) r;
  IF NOT FOUND THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_RECIPIENT_KEY'; END IF;
  live_at:=clock_timestamp();
  IF valid_until<=live_at THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SOURCE_EXPIRED'; END IF;
  RETURN jsonb_build_object('should_send',true,'reason','claimed','dispatch_id',did,'claim_token',token,
   'checked_at',live_at,'valid_until',valid_until);
 END
$fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.refresh_native_catalog(b text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE c crm_audience_v2.config%ROWTYPE; expected jsonb; native jsonb; composed jsonb; at timestamptz;
BEGIN
 IF b IS NULL OR b NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_BRAND'; END IF;
 expected:=CASE b
 WHEN 'fish' THEN '{"currency":null,"timezone":null,"shop_id":null,"fields":[{"key":"purchase.count","available":false,"source_hash":null},{"key":"purchase.last_date","available":false,"source_hash":null},{"key":"purchase.amount","available":false,"source_hash":null},{"key":"purchase.product","available":false,"source_hash":null},{"key":"signup.origin","available":false,"source_hash":null},{"key":"email.opened","available":true,"source_hash":"b9ec8cdafb47449f8001b1354cbef3e59db236fd91c9e6db3d817cdf8a6dd3f5"},{"key":"email.clicked","available":true,"source_hash":"640a55ed1c7bea3a7d7ee7b7ff0e2e2a250fa78af1018dedadd53cdf1dfc602d"}],"products":[],"origins":[]}'::jsonb
 WHEN 'aristo' THEN '{"currency":null,"timezone":null,"shop_id":null,"fields":[{"key":"purchase.count","available":false,"source_hash":null},{"key":"purchase.last_date","available":false,"source_hash":null},{"key":"purchase.amount","available":false,"source_hash":null},{"key":"purchase.product","available":false,"source_hash":null},{"key":"signup.origin","available":false,"source_hash":null},{"key":"email.opened","available":true,"source_hash":"090e2d886df88c1137c54bbe245006533f9ed4b01b25ef1e00f1ca5907c275a2"},{"key":"email.clicked","available":true,"source_hash":"59a67dadaa030a2cfb2a140e217ca0cface5b511dd385ac0a797db6dcee95572"}],"products":[],"origins":[]}'::jsonb
 END;
 native:=expected; composed:=crm_audience_v2.shopify_catalog(b,native);
 expected:=CASE WHEN EXISTS(SELECT 1 FROM crm_audience_v2.shopify_source WHERE brand=b AND enabled) THEN composed ELSE native END;
 SELECT * INTO c FROM crm_audience_v2.config WHERE brand=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_CONFIG'; END IF;
 IF NOT c.enabled THEN RETURN; END IF;
 IF (c.catalog IS DISTINCT FROM native AND c.catalog IS DISTINCT FROM composed) OR c.base_list_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.lists l WHERE l.id=c.base_list_id AND public.shrigma_campaign_list_brand(l)=b AND l.status::text='active' AND l.optin::text IN ('single','double')) THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_SOURCE'; END IF;
 -- Native TTL stays independent. Shopify source age is validated separately;
 -- enabling fields requires the private reviewed source configuration.
 PERFORM subscriber_id,campaign_id,created_at FROM public.campaign_views LIMIT 0;
 PERFORM subscriber_id,campaign_id,created_at FROM public.link_clicks LIMIT 0;
 at:=clock_timestamp();
 IF c.catalog=expected AND c.checked_at<=at AND c.expires_at>at+interval '2 minutes' THEN RETURN; END IF;
 SELECT * INTO c FROM crm_audience_v2.config WHERE brand=b FOR UPDATE;
 PERFORM 1 FROM crm_audience_v2.shopify_source WHERE brand=b FOR SHARE;
 composed:=crm_audience_v2.shopify_catalog(b,native);
 expected:=CASE WHEN EXISTS(SELECT 1 FROM crm_audience_v2.shopify_source WHERE brand=b AND enabled) THEN composed ELSE native END;
 IF NOT c.enabled OR (c.catalog IS DISTINCT FROM native AND c.catalog IS DISTINCT FROM composed) THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_SOURCE'; END IF;
 UPDATE crm_audience_v2.config SET catalog=expected,checked_at=clock_timestamp(),expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=b;
END $fn$;
GRANT EXECUTE ON FUNCTION crm_audience_v2.shopify_source_current(text,text,text),crm_audience_v2.shopify_snapshot(text),crm_audience_v2.shopify_customer_match(jsonb,integer,text,text) TO crm_audience_api;
