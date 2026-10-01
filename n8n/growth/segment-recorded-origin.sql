-- Prospectively recorded forms, integrated with the existing audience runtime.
-- Install atomically after products + confirmed-count + VIP receipts, while all selection workers
-- are OFF. No configuration is enabled, no origin inferred, no native write.
DO $boundary$
BEGIN
 IF to_regclass('crm_audience_v2.recorded_origin_receipt') IS NULL
  OR to_regprocedure('crm_audience_v2.recorded_origin_match(jsonb,integer,text,text)') IS NOT NULL THEN RAISE EXCEPTION 'RECORDED_ORIGIN_INSTALL_BOUNDARY'; END IF;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.recorded_origin_source WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled) THEN RAISE EXCEPTION 'RECORDED_ORIGIN_REQUIRES_OFF'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_catalog_valid(jsonb,text)')) IS DISTINCT FROM 'ee6b980fa6b18f7f773fa8cd8456125b' THEN RAISE EXCEPTION 'RECORDED_ORIGIN_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_rule(jsonb,integer,text,integer,jsonb)')) IS DISTINCT FROM '33cb0e048a1ec706bf26c6ef57a04b81' THEN RAISE EXCEPTION 'RECORDED_ORIGIN_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_regular_rule_match(jsonb,integer[],integer,text)')) IS DISTINCT FROM 'eb2fe4aaabc4ed2104723aec04418561' THEN RAISE EXCEPTION 'RECORDED_ORIGIN_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.refresh_native_catalog(text)')) IS DISTINCT FROM 'b65e47dfb795e3138583bcb83c50e0e8' THEN RAISE EXCEPTION 'RECORDED_ORIGIN_BASE_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_matches_for_rule(jsonb,text,text)')) IS DISTINCT FROM '75c1295f3a9122342ad95ac8daccc6a1'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)')) IS DISTINCT FROM '3d8b7d13f82477ce803a27dc7db9b74e'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)')) IS DISTINCT FROM '4adcbdd47bcb8d731c2d35bd60ea0ff9'
  OR has_function_privilege('crm_audience_api','crm_audience_v2.shopify_matches_for_rule(jsonb,text,text)','EXECUTE')
  OR has_function_privilege('crm_audience_api','crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)','EXECUTE')
  OR NOT has_function_privilege('crm_audience_api','crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'RECORDED_ORIGIN_COUNT_BOUNDARY'; END IF;
END $boundary$;

CREATE FUNCTION crm_audience_v2.recorded_origin_source_hash(b text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT CASE WHEN b='aristo' THEN '35f00a12cf1b7fc3df384475d42f585228fddcdc8bf317685c0569079c6197ae' END
$fn$;
CREATE FUNCTION crm_audience_v2.recorded_origin_descriptor(s crm_audience_v2.recorded_origin_source) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
 WITH pin AS (SELECT jsonb_build_object('contract','crm-recorded-origin-exists-v1','brand',s.brand,'origin',s.canonical_origin,
  'scope_id',s.scope_id::text,'producer_id',s.producer_id,'producer_revision',s.producer_revision,
  'coverage_started_at',to_char(s.coverage_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) v)
 SELECT jsonb_build_object('key',s.canonical_origin,'brand',s.brand,
  'name',CASE s.canonical_origin WHEN 'vip_alma' THEN 'VIP Alma da Roça' WHEN 'vip_desodorante' THEN 'VIP Desodorante' END,
  'available',s.enabled AND s.coverage_started_at<=statement_timestamp(),
  'scope_id',s.scope_id::text,'producer_id',s.producer_id,'producer_revision',s.producer_revision,
  'coverage_started_at',pin.v->>'coverage_started_at','provenance_hash',crm_audience_v2.selection_hash(pin.v)) FROM pin
$fn$;
CREATE FUNCTION crm_audience_v2.recorded_origin_source_current(b text,origin text,pin text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT b='aristo' AND EXISTS(SELECT 1 FROM crm_audience_v2.recorded_origin_source s
  WHERE s.brand=b AND s.canonical_origin=origin AND s.enabled AND isfinite(s.coverage_started_at)
   AND s.coverage_started_at<=statement_timestamp() AND crm_audience_v2.recorded_origin_descriptor(s)->>'provenance_hash'=pin)
$fn$;
CREATE FUNCTION crm_audience_v2.recorded_origin_rule_valid(rule jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT coalesce(jsonb_typeof(rule)='object' AND rule ?& ARRAY['op','field','operator','value']
  AND rule-'op'-'field'-'operator'-'value'='{}'::jsonb AND rule->'op'='"condition"'::jsonb
  AND rule->'field'='"signup.recorded_origin"'::jsonb AND rule->'operator'='"is"'::jsonb
  AND rule->'value' IN ('"vip_alma"'::jsonb,'"vip_desodorante"'::jsonb),false)
$fn$;
CREATE FUNCTION crm_audience_v2.recorded_origin_match(rule jsonb,sid integer,b text,pin text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
 IF NOT crm_audience_v2.recorded_origin_rule_valid(rule)
  OR NOT crm_audience_v2.recorded_origin_source_current(b,rule->>'value',pin) THEN RETURN NULL; END IF;
 -- A removed or reassigned native UUID cannot borrow an older person's receipt.
 IF NOT EXISTS(SELECT 1 FROM public.subscribers WHERE id=sid AND uuid IS NOT NULL) THEN RETURN NULL; END IF;
 RETURN EXISTS(SELECT 1 FROM crm_audience_v2.recorded_origin_receipt r
  JOIN crm_audience_v2.recorded_origin_source src ON src.scope_id=r.scope_id AND src.producer_id=r.producer_id
  JOIN public.subscribers sub ON sub.id=r.subscriber_id AND sub.uuid=r.subscriber_uuid
  WHERE src.brand=b AND src.canonical_origin=rule->>'value' AND src.enabled
   AND crm_audience_v2.recorded_origin_descriptor(src)->>'provenance_hash'=pin
   AND sub.id=sid AND r.accepted_at>=src.coverage_started_at AND r.accepted_at<=statement_timestamp());
END $fn$;
CREATE FUNCTION crm_audience_v2.recorded_origin_catalog(b text,base jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
 WITH origins AS (SELECT coalesce(jsonb_agg(crm_audience_v2.recorded_origin_descriptor(s) ORDER BY s.canonical_origin),'[]'::jsonb) v
  FROM crm_audience_v2.recorded_origin_source s WHERE s.brand=b AND s.enabled AND s.coverage_started_at<=statement_timestamp()),
 fields AS (SELECT coalesce(jsonb_agg(f ORDER BY ord),'[]'::jsonb) v FROM jsonb_array_elements(base->'fields') WITH ORDINALITY x(f,ord) WHERE f->>'key'<>'signup.recorded_origin')
 SELECT base||jsonb_build_object('recorded_origins',origins.v,'fields',fields.v||jsonb_build_array(jsonb_build_object(
  'key','signup.recorded_origin','available',jsonb_array_length(origins.v)>0,
  'source_hash',CASE WHEN jsonb_array_length(origins.v)>0 THEN crm_audience_v2.recorded_origin_source_hash(b) END))) FROM origins CROSS JOIN fields
$fn$;
CREATE FUNCTION crm_audience_v2.recorded_origin_strip(raw jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT (raw-'recorded_origins')||jsonb_build_object('fields',coalesce((SELECT jsonb_agg(f ORDER BY ord)
  FROM jsonb_array_elements(raw->'fields') WITH ORDINALITY x(f,ord) WHERE f->>'key'<>'signup.recorded_origin'),'[]'::jsonb))
$fn$;
CREATE FUNCTION crm_audience_v2.selection_recorded_origin_rule(rule jsonb,sid integer,b text,source_config jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $fn$
DECLARE o jsonb; pin text; field_hash text; matched boolean;
BEGIN
 IF NOT crm_audience_v2.recorded_origin_rule_valid(rule) THEN RETURN NULL; END IF;
 field_hash:=crm_audience_v2.recorded_origin_source_hash(b);
 IF field_hash IS NULL OR (SELECT count(*) FROM jsonb_array_elements(source_config->'fields') f
  WHERE f->>'key'='signup.recorded_origin' AND f->'available'='true'::jsonb AND f->>'source_hash'=field_hash)<>1 THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(source_config->'recorded_origins') v
  WHERE v->>'key'=rule->>'value' AND v->>'brand'=b AND v->'available'='true'::jsonb)<>1 THEN RETURN NULL; END IF;
 SELECT v INTO o FROM jsonb_array_elements(source_config->'recorded_origins') v WHERE v->>'key'=rule->>'value';
 pin:=o->>'provenance_hash';
 IF NOT crm_audience_v2.recorded_origin_source_current(b,rule->>'value',pin) THEN RETURN NULL; END IF;
 matched:=CASE WHEN sid=0 THEN false ELSE crm_audience_v2.recorded_origin_match(rule,sid,b,pin) END;
 RETURN jsonb_build_object('match',matched,'nodes',1,'pins',jsonb_build_array(jsonb_build_object(
  'rule_key','{"op":"condition","field":"signup.recorded_origin","operator":"is","value":'||to_jsonb(rule->>'value')::text||'}',
  'source','crm','source_hash',field_hash,'recorded_origin_provenance_hash',pin)));
END $fn$;

CREATE OR REPLACE FUNCTION crm_audience_v2.selection_catalog_valid(raw jsonb,brand text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE x jsonb; seen text[]:=ARRAY[]::text[];
BEGIN
 IF jsonb_typeof(raw) IS DISTINCT FROM 'object'
  OR NOT(raw ?& ARRAY['currency','timezone','shop_id','fields','products','origins'])
  OR raw-'currency'-'timezone'-'shop_id'-'fields'-'products'-'origins'-'recorded_origins'<>'{}'::jsonb THEN RETURN false; END IF;
 IF raw->'currency'<>'null'::jsonb AND (jsonb_typeof(raw->'currency')<>'string' OR raw->>'currency' !~ '^[A-Z]{3}$') THEN RETURN false; END IF;
 IF raw->'shop_id'<>'null'::jsonb AND (jsonb_typeof(raw->'shop_id')<>'string' OR raw->>'shop_id' !~ '^gid://shopify/Shop/[1-9][0-9]{0,19}$') THEN RETURN false; END IF;
 IF raw->'timezone'<>'null'::jsonb AND (jsonb_typeof(raw->'timezone')<>'string'
  OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.selection_timezone WHERE name=raw->>'timezone')) THEN RETURN false; END IF;
 IF jsonb_typeof(raw->'fields')<>'array' OR jsonb_typeof(raw->'products')<>'array' OR jsonb_typeof(raw->'origins')<>'array' THEN RETURN false; END IF;
 IF jsonb_array_length(raw->'fields')>8 OR jsonb_array_length(raw->'products')>1000 OR jsonb_array_length(raw->'origins')>3 THEN RETURN false; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(raw->'fields') LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR NOT(x ?& ARRAY['key','available','source_hash']) OR x-'key'-'available'-'source_hash'<>'{}'::jsonb
   OR x->>'key' NOT IN('purchase.count','purchase.last_date','purchase.amount','purchase.product','signup.origin','signup.recorded_origin','email.opened','email.clicked')
   OR jsonb_typeof(x->'key')<>'string' OR (x->>'key')=ANY(seen) OR jsonb_typeof(x->'available')<>'boolean'
   OR (x->'source_hash'<>'null'::jsonb AND (jsonb_typeof(x->'source_hash')<>'string' OR x->>'source_hash' !~ '^[0-9a-f]{64}$'))
   OR (x->'available'='true'::jsonb AND x->'source_hash'='null'::jsonb) THEN RETURN false; END IF;
  seen:=array_append(seen,x->>'key');
 END LOOP;
 seen:=ARRAY[]::text[];
 FOR x IN SELECT value FROM jsonb_array_elements(raw->'products') LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR NOT(x ?& ARRAY['id','brand','name','available']) OR x-'id'-'brand'-'name'-'available'<>'{}'::jsonb
   OR x->>'brand' IS DISTINCT FROM brand OR jsonb_typeof(x->'id')<>'string' OR x->>'id' !~ '^gid://shopify/Product/[1-9][0-9]{0,19}$'
   OR (x->>'id')=ANY(seen) OR jsonb_typeof(x->'name')<>'string' OR crm_audience_v2.selection_utf16_length(x->>'name')>500 OR jsonb_typeof(x->'available')<>'boolean' THEN RETURN false; END IF;
  seen:=array_append(seen,x->>'id');
 END LOOP;
 seen:=ARRAY[]::text[];
 FOR x IN SELECT value FROM jsonb_array_elements(raw->'origins') LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR NOT(x ?& ARRAY['key','brand','name','available','provenance_hash']) OR x-'key'-'brand'-'name'-'available'-'provenance_hash'<>'{}'::jsonb
   OR x->>'brand' IS DISTINCT FROM brand OR jsonb_typeof(x->'key')<>'string' OR x->>'key' NOT IN('popup','vip_alma','vip_desodorante')
   OR (x->>'key')=ANY(seen) OR jsonb_typeof(x->'name')<>'string' OR crm_audience_v2.selection_utf16_length(x->>'name')>500 OR jsonb_typeof(x->'available')<>'boolean'
   OR (x->'provenance_hash'<>'null'::jsonb AND (jsonb_typeof(x->'provenance_hash')<>'string' OR x->>'provenance_hash' !~ '^[0-9a-f]{64}$'))
   OR (x->'available'='true'::jsonb AND x->'provenance_hash'='null'::jsonb) THEN RETURN false; END IF;
  seen:=array_append(seen,x->>'key');
 END LOOP;
 seen:=ARRAY[]::text[];
 IF raw ? 'recorded_origins' THEN
  IF jsonb_typeof(raw->'recorded_origins') IS DISTINCT FROM 'array' OR jsonb_array_length(raw->'recorded_origins')>2 THEN RETURN false; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(raw->'recorded_origins') LOOP
   IF jsonb_typeof(x) IS DISTINCT FROM 'object'
    OR NOT(x ?& ARRAY['key','brand','name','available','scope_id','producer_id','producer_revision','coverage_started_at','provenance_hash'])
    OR x-'key'-'brand'-'name'-'available'-'scope_id'-'producer_id'-'producer_revision'-'coverage_started_at'-'provenance_hash'<>'{}'::jsonb
    OR brand<>'aristo' OR x->>'brand' IS DISTINCT FROM brand OR x->>'key' NOT IN('vip_alma','vip_desodorante')
    OR jsonb_typeof(x->'key')<>'string' OR (x->>'key')=ANY(seen)
    OR jsonb_typeof(x->'name')<>'string' OR crm_audience_v2.selection_utf16_length(x->>'name') NOT BETWEEN 1 AND 500 OR x->>'name' ~ '[[:cntrl:]]'
    OR jsonb_typeof(x->'available')<>'boolean' OR jsonb_typeof(x->'scope_id')<>'string' OR x->>'scope_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR x->>'producer_id' IS DISTINCT FROM (CASE x->>'key' WHEN 'vip_alma' THEN 'NAmTWZ7vddQ8LX1k' WHEN 'vip_desodorante' THEN 'ywJDsgBDhZOBgoxb' END)
    OR jsonb_typeof(x->'producer_revision')<>'string' OR x->>'producer_revision' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(x->'coverage_started_at')<>'string' OR x->>'coverage_started_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    OR to_char((x->>'coverage_started_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM x->>'coverage_started_at'
    OR jsonb_typeof(x->'provenance_hash')<>'string' OR x->>'provenance_hash' !~ '^[a-f0-9]{64}$'
    OR x->>'provenance_hash' IS DISTINCT FROM crm_audience_v2.selection_hash(jsonb_build_object(
     'contract','crm-recorded-origin-exists-v1','brand',brand,'origin',x->>'key','scope_id',x->>'scope_id',
     'producer_id',x->>'producer_id','producer_revision',x->>'producer_revision','coverage_started_at',x->>'coverage_started_at')) THEN RETURN false; END IF;
   seen:=array_append(seen,x->>'key');
  END LOOP;
 END IF;
 RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $fn$;
CREATE OR REPLACE FUNCTION crm_audience_v2.selection_rule(rule jsonb,sid integer,brand text,depth integer DEFAULT 1,source_config jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE child jsonb; result jsonb; matches boolean; nodes integer:=1;
 pins jsonb:='[]'::jsonb; selected_list_id integer; native_optin text; source_hash text;
BEGIN
 IF depth<1 OR depth>4 OR jsonb_typeof(rule) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF rule->>'op'='confirmed' THEN
  IF rule-'op'-'rule'<>'{}'::jsonb OR NOT(rule ?& ARRAY['op','rule']) OR NOT crm_audience_v2.shopify_rule_valid(rule->'rule') THEN RETURN NULL; END IF;
  result:=crm_audience_v2.selection_rule(rule->'rule',sid,brand,depth+1,source_config);
  IF result IS NULL OR (result->>'nodes')::integer+1>32 THEN RETURN NULL; END IF;
  RETURN result||jsonb_build_object('match',coalesce((result->>'match')::boolean,false),'nodes',(result->>'nodes')::integer+1);
 END IF;
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
  IF rule->>'field' IN('purchase.count','purchase.amount','purchase.last_date','purchase.product') THEN
   RETURN crm_audience_v2.selection_shopify_rule(rule,sid,brand,source_config);
  END IF;
  IF rule->>'field'='signup.recorded_origin' THEN RETURN crm_audience_v2.selection_recorded_origin_rule(rule,sid,brand,source_config); END IF;
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
CREATE OR REPLACE FUNCTION crm_audience_v2.selection_regular_rule_match(rule jsonb,consented integer[],sid integer,brand text) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE child jsonb; matched boolean; result boolean; pin text;
 BEGIN
  IF rule->>'op'='confirmed' THEN
   IF rule-'op'-'rule'<>'{}'::jsonb OR NOT(rule ?& ARRAY['op','rule']) OR NOT crm_audience_v2.shopify_rule_valid(rule->'rule') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
   SELECT field_hashes->>(rule#>>'{rule,field}') INTO pin FROM crm_audience_v2.shopify_source WHERE shopify_source.brand=selection_regular_rule_match.brand;
   IF NOT crm_audience_v2.shopify_source_current(brand,rule#>>'{rule,field}',pin) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
   RETURN coalesce(crm_audience_v2.shopify_customer_match(rule->'rule',sid,brand,pin),false);
  END IF;
  IF rule->>'op'='in_list' THEN RETURN (rule->>'list_id')::integer=ANY(consented); END IF;
  IF rule->>'op'='condition' THEN
   IF rule->>'field' IN('purchase.count','purchase.amount','purchase.last_date','purchase.product') THEN
    SELECT field_hashes->>(rule->>'field') INTO pin FROM crm_audience_v2.shopify_source WHERE shopify_source.brand=selection_regular_rule_match.brand;
    RETURN crm_audience_v2.shopify_customer_match(rule,sid,brand,pin);
   END IF;
   IF rule->>'field'='signup.recorded_origin' THEN
    SELECT crm_audience_v2.recorded_origin_descriptor(s)->>'provenance_hash' INTO pin FROM crm_audience_v2.recorded_origin_source s WHERE s.brand=selection_regular_rule_match.brand AND s.canonical_origin=rule->>'value' AND s.enabled;
    RETURN crm_audience_v2.recorded_origin_match(rule,sid,brand,pin);
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
 expected:=crm_audience_v2.recorded_origin_catalog(b,expected);
 SELECT * INTO c FROM crm_audience_v2.config WHERE brand=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_CONFIG'; END IF;
 IF NOT c.enabled THEN RETURN; END IF;
 IF NOT (crm_audience_v2.selection_catalog_valid(c.catalog,b) AND crm_audience_v2.shopify_catalog_trusted(b,crm_audience_v2.recorded_origin_strip(c.catalog),native,composed)) OR c.base_list_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.lists l WHERE l.id=c.base_list_id AND public.shrigma_campaign_list_brand(l)=b AND l.status::text='active' AND l.optin::text IN ('single','double')) THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_SOURCE'; END IF;
 -- Native TTL stays independent. Shopify source age is validated separately;
 -- enabling fields requires the private reviewed source configuration.
 PERFORM subscriber_id,campaign_id,created_at FROM public.campaign_views LIMIT 0;
 PERFORM subscriber_id,campaign_id,created_at FROM public.link_clicks LIMIT 0;
 at:=clock_timestamp();
 IF c.catalog=expected AND c.checked_at<=at AND c.expires_at>at+interval '2 minutes' THEN RETURN; END IF;
 SELECT * INTO c FROM crm_audience_v2.config WHERE brand=b FOR UPDATE;
 PERFORM 1 FROM crm_audience_v2.shopify_source WHERE brand=b FOR SHARE;
 PERFORM 1 FROM crm_audience_v2.recorded_origin_source WHERE brand=b ORDER BY canonical_origin FOR SHARE;
 composed:=crm_audience_v2.shopify_catalog(b,native);
 expected:=CASE WHEN EXISTS(SELECT 1 FROM crm_audience_v2.shopify_source WHERE brand=b AND enabled) THEN composed ELSE native END;
 IF NOT c.enabled OR NOT (crm_audience_v2.selection_catalog_valid(c.catalog,b) AND crm_audience_v2.shopify_catalog_trusted(b,crm_audience_v2.recorded_origin_strip(c.catalog),native,composed)) THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_SOURCE'; END IF;
 expected:=crm_audience_v2.recorded_origin_catalog(b,expected);
 UPDATE crm_audience_v2.config SET catalog=expected,checked_at=clock_timestamp(),expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=b;
END $fn$;

REVOKE ALL ON FUNCTION crm_audience_v2.recorded_origin_source_hash(text),crm_audience_v2.recorded_origin_descriptor(crm_audience_v2.recorded_origin_source),
 crm_audience_v2.recorded_origin_source_current(text,text,text),crm_audience_v2.recorded_origin_rule_valid(jsonb),crm_audience_v2.recorded_origin_match(jsonb,integer,text,text),
 crm_audience_v2.recorded_origin_catalog(text,jsonb),crm_audience_v2.recorded_origin_strip(jsonb),crm_audience_v2.selection_recorded_origin_rule(jsonb,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_audience_v2.recorded_origin_source_current(text,text,text),crm_audience_v2.recorded_origin_match(jsonb,integer,text,text) TO crm_audience_api;
