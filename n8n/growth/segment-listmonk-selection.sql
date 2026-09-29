-- LOCAL CANDIDATE: selection predicate only, never transport authorization.
-- Install after the audience/binding stores in a disposable fixture. No grants,
-- activation function, image change or published runtime pin is supplied here.
DO $install$
BEGIN
 IF pg_catalog.to_regclass('crm_audience_v2.campaign_binding') IS NULL
 OR pg_catalog.to_regclass('crm_audience_v2.campaign_binding_revision') IS NULL
 OR pg_catalog.to_regclass('crm_audience_v2.revision') IS NULL
 OR pg_catalog.to_regclass('crm_audience_v2.config') IS NULL THEN
  RAISE EXCEPTION 'SEGMENT_SELECTION_DEPENDENCY';
 END IF;
 IF pg_catalog.to_regclass('crm_audience_v2.selection_runtime') IS NOT NULL THEN
  RAISE EXCEPTION 'SEGMENT_SELECTION_INSTALL_COLLISION';
 END IF;
END $install$;

CREATE TABLE crm_audience_v2.selection_runtime (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 candidate_query_sha256 text,
 verified_at timestamptz,
 CHECK(candidate_query_sha256 IS NULL OR candidate_query_sha256 ~ '^[0-9a-f]{64}$')
);
INSERT INTO crm_audience_v2.selection_runtime(singleton) VALUES(true);
-- Cache names, not offsets/current time: enumerating pg_timezone_names for each
-- subscriber repeatedly resolves every installed timezone. This private local
-- snapshot is rebuilt only with a future reviewed installation/tzdata update.
CREATE TABLE crm_audience_v2.selection_timezone(name text PRIMARY KEY);
-- Factory is PostgreSQL's placeholder, not a timezone accepted by Intl/store.
INSERT INTO crm_audience_v2.selection_timezone(name) SELECT name FROM pg_catalog.pg_timezone_names WHERE name<>'Factory';

-- The service's canonical JSON hash for the supported normalized payload:
-- fixed ASCII object keys, strings, booleans, null, arrays and integer numbers.
-- Unsupported numeric representations or excessive nesting fail closed.
CREATE FUNCTION crm_audience_v2.selection_canonical(v jsonb, depth integer DEFAULT 0)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE out text; k text; x jsonb; parts text[]:=ARRAY[]::text[];
BEGIN
 IF v IS NULL OR depth>12 OR octet_length(v::text)>64000 THEN RETURN NULL; END IF;
 CASE jsonb_typeof(v)
 WHEN 'object' THEN
  FOR k,x IN SELECT key,value FROM jsonb_each(v) ORDER BY key COLLATE "C" LOOP
   IF k !~ '^[a-z_]+$' THEN RETURN NULL; END IF;
   out:=crm_audience_v2.selection_canonical(x,depth+1); IF out IS NULL THEN RETURN NULL; END IF;
   parts:=array_append(parts,to_jsonb(k)::text||':'||out);
  END LOOP;
  RETURN '{'||array_to_string(parts,',')||'}';
 WHEN 'array' THEN
  FOR x IN SELECT value FROM jsonb_array_elements(v) LOOP
   out:=crm_audience_v2.selection_canonical(x,depth+1); IF out IS NULL THEN RETURN NULL; END IF;
   parts:=array_append(parts,out);
  END LOOP;
  RETURN '['||array_to_string(parts,',')||']';
 WHEN 'number' THEN
  IF v::text !~ '^(0|[1-9][0-9]*)$' THEN RETURN NULL; END IF;
  RETURN v::text;
 WHEN 'string','boolean','null' THEN RETURN v::text;
 ELSE RETURN NULL;
 END CASE;
END $fn$;
CREATE FUNCTION crm_audience_v2.selection_hash(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT encode(sha256(convert_to(crm_audience_v2.selection_canonical(v),'UTF8')),'hex')
$fn$;

-- Conservative SQL counterpart of store.sourceConfig. External evidence never
-- becomes selectable here; malformed configuration also blocks list-only rules.
CREATE FUNCTION crm_audience_v2.selection_utf16_length(v text) RETURNS integer
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT length(v)+length(regexp_replace(v,'[^'||chr(65536)||'-'||chr(1114111)||']','','g'))
$fn$;
CREATE FUNCTION crm_audience_v2.selection_catalog_valid(raw jsonb,brand text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE x jsonb; seen text[]:=ARRAY[]::text[];
BEGIN
 IF jsonb_typeof(raw) IS DISTINCT FROM 'object'
  OR NOT(raw ?& ARRAY['currency','timezone','shop_id','fields','products','origins'])
  OR raw-'currency'-'timezone'-'shop_id'-'fields'-'products'-'origins'<>'{}'::jsonb THEN RETURN false; END IF;
 IF raw->'currency'<>'null'::jsonb AND (jsonb_typeof(raw->'currency')<>'string' OR raw->>'currency' !~ '^[A-Z]{3}$') THEN RETURN false; END IF;
 IF raw->'shop_id'<>'null'::jsonb AND (jsonb_typeof(raw->'shop_id')<>'string' OR raw->>'shop_id' !~ '^gid://shopify/Shop/[1-9][0-9]{0,19}$') THEN RETURN false; END IF;
 IF raw->'timezone'<>'null'::jsonb AND (jsonb_typeof(raw->'timezone')<>'string'
  OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.selection_timezone WHERE name=raw->>'timezone')) THEN RETURN false; END IF;
 IF jsonb_typeof(raw->'fields')<>'array' OR jsonb_typeof(raw->'products')<>'array' OR jsonb_typeof(raw->'origins')<>'array' THEN RETURN false; END IF;
 IF jsonb_array_length(raw->'fields')>7 OR jsonb_array_length(raw->'products')>1000 OR jsonb_array_length(raw->'origins')>3 THEN RETURN false; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(raw->'fields') LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR NOT(x ?& ARRAY['key','available','source_hash']) OR x-'key'-'available'-'source_hash'<>'{}'::jsonb
   OR x->>'key' NOT IN('purchase.count','purchase.last_date','purchase.amount','purchase.product','signup.origin','email.opened','email.clicked')
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
 RETURN true;
END $fn$;
CREATE FUNCTION crm_audience_v2.selection_lists_valid(brand text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 WITH rows AS MATERIALIZED (
  SELECT l.id,l.name FROM public.lists l WHERE public.shrigma_campaign_list_brand(l)=brand LIMIT 1001
 ) SELECT count(*)<=1000 AND coalesce(bool_and(coalesce(id>0 AND name IS NOT NULL
  AND crm_audience_v2.selection_utf16_length(name)<=500,false)),false) FROM rows
$fn$;

-- Exact semantic pins from segment-audience-listmonk.cjs, checked for parity in
-- the integrated selection tests. These describe source meaning, not live data.
CREATE FUNCTION crm_audience_v2.selection_engagement_source_hash(brand text,field text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT CASE brand||':'||field
  WHEN 'fish:email.opened' THEN 'b9ec8cdafb47449f8001b1354cbef3e59db236fd91c9e6db3d817cdf8a6dd3f5'
  WHEN 'fish:email.clicked' THEN '640a55ed1c7bea3a7d7ee7b7ff0e2e2a250fa78af1018dedadd53cdf1dfc602d'
  WHEN 'aristo:email.opened' THEN '090e2d886df88c1137c54bbe245006533f9ed4b01b25ef1e00f1ca5907c275a2'
  WHEN 'aristo:email.clicked' THEN '59a67dadaa030a2cfb2a140e217ca0cface5b511dd385ac0a797db6dcee95572'
 END
$fn$;
CREATE FUNCTION crm_audience_v2.selection_engagement_match(rule jsonb,sid integer,brand text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE matched boolean; days integer; cutoff timestamptz;
BEGIN
 IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR rule->>'op' IS DISTINCT FROM 'condition'
  OR NOT(rule ?& ARRAY['op','field','operator','value']) OR rule-'op'-'field'-'operator'-'value'<>'{}'::jsonb
  OR jsonb_typeof(rule->'field') IS DISTINCT FROM 'string' OR jsonb_typeof(rule->'operator') IS DISTINCT FROM 'string'
  OR rule->>'field' NOT IN('email.opened','email.clicked')
  OR rule->>'operator' NOT IN('within_last_days','not_within_last_days')
  OR jsonb_typeof(rule->'value') IS DISTINCT FROM 'number' OR rule->>'value' !~ '^[1-9][0-9]{0,3}$'
  OR (rule->>'value')::numeric>3650 OR brand IS NULL OR brand NOT IN('fish','aristo') THEN RETURN NULL; END IF;
 days:=(rule->>'value')::integer;
 cutoff:=statement_timestamp()-(days::double precision*86400*interval '1 second');
 IF rule->>'field'='email.opened' THEN
  SELECT EXISTS(SELECT 1 FROM public.campaign_views ev JOIN public.campaigns ec ON ec.id=ev.campaign_id
   WHERE ev.subscriber_id=sid AND ec.attribs#>>'{crm,policy}'='crm-campaign-v1' AND ec.attribs#>>'{crm,brand}'=brand
    AND ec.messenger::text='email' AND ec.type::text='regular'
    AND ev.created_at>=cutoff AND ev.created_at<=statement_timestamp()) INTO matched;
 ELSE
  SELECT EXISTS(SELECT 1 FROM public.link_clicks ev JOIN public.campaigns ec ON ec.id=ev.campaign_id
   WHERE ev.subscriber_id=sid AND ec.attribs#>>'{crm,policy}'='crm-campaign-v1' AND ec.attribs#>>'{crm,brand}'=brand
    AND ec.messenger::text='email' AND ec.type::text='regular'
    AND ev.created_at>=cutoff AND ev.created_at<=statement_timestamp()) INTO matched;
 END IF;
 RETURN CASE WHEN rule->>'operator'='within_last_days' THEN matched ELSE NOT matched END;
END $fn$;

-- Both branches of every group are checked, even after an OR has matched.
-- A missing/unavailable/external leaf invalidates the WHOLE bound audience.
CREATE FUNCTION crm_audience_v2.selection_rule(rule jsonb,sid integer,brand text,depth integer DEFAULT 1,source_config jsonb DEFAULT NULL)
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

CREATE FUNCTION crm_audience_v2.selection_context(cid integer,expected_query_sha256 text,native_engagement boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE b crm_audience_v2.campaign_binding%ROWTYPE; r crm_audience_v2.revision%ROWTYPE;
 c crm_audience_v2.config%ROWTYPE; result jsonb; base_result jsonb; current_context jsonb;
 current_pins jsonb; seen_at timestamptz:=statement_timestamp();
BEGIN
 SELECT * INTO b FROM crm_audience_v2.campaign_binding WHERE campaign_id=cid;
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
  'list_pins',(SELECT jsonb_agg(pin) FROM jsonb_array_elements(current_pins||(base_result->'pins')) pin WHERE pin ? 'list_id'));
END $fn$;
-- Legacy combined selector retains its false/OFF contract. Regular campaigns
-- use the separate readiness functions below, which raise on unavailable data.
CREATE FUNCTION crm_audience_v2.selection_allowed(cid integer,sid integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE ctx jsonb; result jsonb; base_result jsonb;
BEGIN
 ctx:=crm_audience_v2.selection_context(cid,'3fd5311813ee746c8059796ef5aa713154430cf06e998e5be7424cb163d62daa');
 IF ctx IS NULL THEN RETURN false; END IF;
 IF ctx->'bound'='false'::jsonb THEN RETURN true; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.subscribers s WHERE s.id=sid AND s.status::text='enabled') THEN RETURN false; END IF;
 result:=crm_audience_v2.selection_rule(ctx#>'{definition,rule}',sid,ctx->>'brand');
 base_result:=crm_audience_v2.selection_rule(jsonb_build_object('op','in_list','list_id',(ctx->>'base_list_id')::integer),sid,ctx->>'brand');
 RETURN coalesce((result->>'match')::boolean AND (base_result->>'match')::boolean,false);
END $fn$;
REVOKE ALL ON crm_audience_v2.selection_runtime,crm_audience_v2.selection_timezone FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_audience_v2.selection_canonical(jsonb,integer),
 crm_audience_v2.selection_hash(jsonb),crm_audience_v2.selection_utf16_length(text),crm_audience_v2.selection_catalog_valid(jsonb,text),crm_audience_v2.selection_lists_valid(text),crm_audience_v2.selection_rule(jsonb,integer,text,integer,jsonb),
 crm_audience_v2.selection_engagement_source_hash(text,text),crm_audience_v2.selection_engagement_match(jsonb,integer,text),
 crm_audience_v2.selection_context(integer,text,boolean),crm_audience_v2.selection_allowed(integer,integer) FROM PUBLIC;
