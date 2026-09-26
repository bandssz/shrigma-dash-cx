-- Growth segments: preparation/count only. Fresh installation; no campaigns, contacts or lists written.
-- API parameters actor/caps must come from strict Growth panel authentication in a trusted backend.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $check$ BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['shrigma_segment_config','shrigma_segment','shrigma_segment_revision','shrigma_segment_request']) n WHERE to_regclass('public.'||n) IS NOT NULL)
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['shrigma_segment_rule_v1','shrigma_segment_definition_v1','shrigma_segment_public_v1','shrigma_segment_count_v1','shrigma_segment_api_v1'])) THEN RAISE EXCEPTION 'SEGMENT_INSTALL_COLLISION'; END IF;
 IF to_regprocedure('public.shrigma_campaign_list_brand(public.lists)') IS NULL THEN RAISE EXCEPTION 'SEGMENT_LIST_CLASSIFIER_REQUIRED'; END IF;
END $check$;
CREATE TABLE public.shrigma_segment_config(
 brand text PRIMARY KEY CHECK(brand IN('fish','aristo')),enabled boolean NOT NULL DEFAULT false,
 base_list_id integer CHECK(base_list_id>0),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.shrigma_segment_config(brand) VALUES('fish'),('aristo');
CREATE TABLE public.shrigma_segment(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand text NOT NULL CHECK(brand IN('fish','aristo')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),definition jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),archived boolean NOT NULL DEFAULT false,
 created_by text NOT NULL,updated_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(definition->>'brand'=brand AND definition->>'schema_version'='crm-segment-v1')
);
CREATE INDEX shrigma_segment_brand_idx ON public.shrigma_segment(brand,updated_at DESC,id);
CREATE TABLE public.shrigma_segment_revision(
 segment_id uuid NOT NULL REFERENCES public.shrigma_segment(id),version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL,archived boolean NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(segment_id,version)
);
CREATE TABLE public.shrigma_segment_request(
 actor text NOT NULL,operation_key text NOT NULL,brand text NOT NULL CHECK(brand IN('fish','aristo')),
 payload jsonb NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor,operation_key)
);
REVOKE ALL ON public.shrigma_segment_config,public.shrigma_segment,public.shrigma_segment_revision,public.shrigma_segment_request FROM PUBLIC;

-- Only the validated positive integer below is rendered into a SQL fragment.
-- All identifiers/operators are fixed here; no user expression is accepted.
CREATE FUNCTION public.shrigma_segment_rule_v1(r jsonb,depth integer DEFAULT 1) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $f$
DECLARE op text:=r->>'op';item jsonb;child jsonb;children jsonb:='[]';rules jsonb;ids jsonb;nodes integer:=1;lid integer;fragment text;
BEGIN
 IF depth<1 OR depth>4 THEN RAISE EXCEPTION 'SEGMENT_LIMIT'; END IF;
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'SEGMENT_RULE'; END IF;
 IF op='in_list' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(r))<>2 OR NOT r ? 'list_id' OR jsonb_typeof(r->'list_id') IS DISTINCT FROM 'number'
   OR coalesce(r->>'list_id','')!~'^[1-9][0-9]{0,9}$' OR (r->>'list_id')::bigint>2147483647 THEN RAISE EXCEPTION 'SEGMENT_LIST_ID'; END IF;
  lid:=(r->>'list_id')::integer;
  fragment:='EXISTS (SELECT 1 FROM public.subscriber_lists sl JOIN valid_lists l ON l.id=sl.list_id WHERE sl.subscriber_id=s.id AND l.id='||lid::text||' AND ((l.optin=''double'' AND sl.status::text=''confirmed'') OR (l.optin=''single'' AND sl.status::text IN (''confirmed'',''unconfirmed''))))';
  RETURN jsonb_build_object('rule',jsonb_build_object('op','in_list','list_id',lid),'nodes',1,'list_ids',jsonb_build_array(lid),'sql',fragment);
 END IF;
 IF coalesce(op,'') NOT IN('and','or') OR (SELECT count(*) FROM jsonb_object_keys(r))<>2 OR NOT r ? 'rules' OR jsonb_typeof(r->'rules') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'SEGMENT_RULE'; END IF;
 IF jsonb_array_length(r->'rules') NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'SEGMENT_RULE'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(r->'rules') LOOP
  child:=public.shrigma_segment_rule_v1(item,depth+1);nodes:=nodes+(child->>'nodes')::integer;
  IF nodes>32 THEN RAISE EXCEPTION 'SEGMENT_LIMIT'; END IF;children:=children||jsonb_build_array(child);
 END LOOP;
 SELECT jsonb_agg(v->'rule' ORDER BY (v->'rule')::text COLLATE "C"),string_agg(v->>'sql',CASE op WHEN 'and' THEN ' AND ' ELSE ' OR ' END ORDER BY (v->'rule')::text COLLATE "C") INTO rules,fragment
 FROM (SELECT DISTINCT ON (value->'rule') value AS v FROM jsonb_array_elements(children) ORDER BY value->'rule',value->>'sql') q;
 SELECT jsonb_agg(id ORDER BY id) INTO ids FROM (SELECT DISTINCT (x.value)::integer id FROM jsonb_array_elements(children) c CROSS JOIN LATERAL jsonb_array_elements_text(c.value->'list_ids') x) q;
 RETURN jsonb_build_object('rule',CASE WHEN jsonb_array_length(rules)=1 THEN rules->0 ELSE jsonb_build_object('op',op,'rules',rules) END,'nodes',nodes,'list_ids',ids,'sql','('||fragment||')');
END $f$;
CREATE FUNCTION public.shrigma_segment_definition_v1(d jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $f$
DECLARE r jsonb;
BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR length(d::text)>12000 THEN RAISE EXCEPTION 'SEGMENT_SHAPE'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(d))<>4 OR NOT d ?& ARRAY['schema_version','brand','name','rule'] THEN RAISE EXCEPTION 'SEGMENT_FIELDS'; END IF;
 IF d->>'schema_version' IS DISTINCT FROM 'crm-segment-v1' THEN RAISE EXCEPTION 'SEGMENT_VERSION'; END IF;
 IF coalesce(d->>'brand','') NOT IN('fish','aristo') THEN RAISE EXCEPTION 'SEGMENT_BRAND'; END IF;
 IF jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(btrim(d->>'name')) NOT BETWEEN 1 AND 160 OR d->>'name' ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'SEGMENT_NAME'; END IF;
 r:=public.shrigma_segment_rule_v1(d->'rule',1);
 RETURN jsonb_build_object('schema_version','crm-segment-v1','brand',d->>'brand','name',btrim(d->>'name'),'rule',r->'rule');
END $f$;
CREATE FUNCTION public.shrigma_segment_public_v1(s public.shrigma_segment) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',s.id,'brand',s.brand,'name',s.name,'definition',s.definition,'version',s.version,'archived',s.archived,'created_at',s.created_at,'updated_at',s.updated_at,'updated_by',s.updated_by)
$$;
CREATE FUNCTION public.shrigma_segment_count_v1(input jsonb,base_id integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE d jsonb:=public.shrigma_segment_definition_v1(input);r jsonb;ids integer[];base_sql text;result jsonb;
BEGIN
 IF base_id IS NULL OR base_id<=0 THEN RAISE EXCEPTION 'SEGMENT_BASE_UNCONFIRMED'; END IF;
 r:=public.shrigma_segment_rule_v1(d->'rule',1);
 SELECT array_agg(DISTINCT n ORDER BY n) INTO ids FROM (SELECT base_id n UNION ALL SELECT value::integer FROM jsonb_array_elements_text(r->'list_ids')) q;
 base_sql:=public.shrigma_segment_rule_v1(jsonb_build_object('op','in_list','list_id',base_id),1)->>'sql';
 EXECUTE 'WITH valid_lists AS MATERIALIZED (SELECT l.id,l.optin::text AS optin FROM public.lists l WHERE l.id=ANY($2::integer[]) AND l.status::text=''active'' AND public.shrigma_campaign_list_brand(l)=$1::text AND l.optin::text IN (''single'',''double'')), scope AS (SELECT count(*)=cardinality($2::integer[]) AS confirmed FROM valid_lists)
 SELECT jsonb_build_object(''source_confirmed'',scope.confirmed,''eligible_count'',CASE WHEN scope.confirmed THEN (SELECT count(*) FROM public.subscribers s WHERE s.status::text=''enabled'' AND '||base_sql||' AND '||(r->>'sql')||') ELSE NULL END,''checked_at'',statement_timestamp()) FROM scope'
 INTO result USING d->>'brand',ids;
 RETURN result||jsonb_build_object('definition',d,'definition_hash',encode(sha256(convert_to(d::text,'UTF8')),'hex'),'base_list_id',base_id,'transport_supported',false);
END $f$;

CREATE FUNCTION public.shrigma_segment_api_v1(actor text,caps jsonb,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $f$
<<segment_api>>
DECLARE action text:=p->>'acao';brand text:=p->>'brand';needed text;keys text[];idem text:=p->>'idempotency_key';
 cfg public.shrigma_segment_config%ROWTYPE;s public.shrigma_segment%ROWTYPE;old public.shrigma_segment_request%ROWTYPE;
 response jsonb;d jsonb;r jsonb;ids integer[];counted jsonb;limit_n integer;offset_n integer;expected integer;row_id uuid;mutation boolean;
BEGIN
 mutation:=action IN('segmento_criar','segmento_salvar','segmento_arquivar');
 needed:=CASE WHEN mutation THEN 'draft' WHEN action IN('segmentos_listar','segmento_obter','segmento_contar','segmento_operacao') THEN 'read_content' END;
 IF actor IS NULL OR length(actor) NOT BETWEEN 1 AND 200 OR actor ~ '[[:cntrl:]]' OR jsonb_typeof(caps) IS DISTINCT FROM 'array' OR needed IS NULL OR NOT(caps ? needed) THEN RETURN jsonb_build_object('_http',403,'_body',jsonb_build_object('error','SEGMENT_ACCESS_DENIED')); END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR length(p::text)>16000 OR coalesce(brand,'') NOT IN('fish','aristo') THEN RETURN jsonb_build_object('_http',422,'_body',jsonb_build_object('error','SEGMENT_REQUEST_INVALID')); END IF;
 keys:=CASE action WHEN 'segmentos_listar' THEN ARRAY['acao','brand','limit','offset'] WHEN 'segmento_obter' THEN ARRAY['acao','brand','id'] WHEN 'segmento_operacao' THEN ARRAY['acao','brand','idempotency_key'] WHEN 'segmento_contar' THEN ARRAY['acao','brand','id','expected_version','definition'] WHEN 'segmento_criar' THEN ARRAY['acao','brand','definition','idempotency_key'] WHEN 'segmento_salvar' THEN ARRAY['acao','brand','id','expected_version','definition','idempotency_key'] ELSE ARRAY['acao','brand','id','expected_version','idempotency_key'] END;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT k=ANY(keys)) THEN RETURN jsonb_build_object('_http',422,'_body',jsonb_build_object('error','SEGMENT_FIELDS')); END IF;
 IF mutation OR action='segmento_operacao' THEN
  IF coalesce(idem,'')!~'^[A-Za-z0-9_.:-]{8,128}$' THEN RETURN jsonb_build_object('_http',422,'_body',jsonb_build_object('error','SEGMENT_OPERATION_ID_REQUIRED')); END IF;
  IF mutation THEN PERFORM pg_advisory_xact_lock(hashtextextended('segment-request:'||jsonb_build_array(actor,idem)::text,0)); END IF;
  SELECT * INTO old FROM public.shrigma_segment_request q WHERE q.actor=shrigma_segment_api_v1.actor AND q.operation_key=idem;
  IF FOUND THEN
   IF old.brand IS DISTINCT FROM brand OR (mutation AND old.payload IS DISTINCT FROM p) THEN RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('error','SEGMENT_OPERATION_MISMATCH')); END IF;
   RETURN old.response;
  ELSIF action='segmento_operacao' THEN RETURN jsonb_build_object('_http',404,'_body',jsonb_build_object('error','SEGMENT_OPERATION_UNCONFIRMED')); END IF;
 END IF;
 <<apply_request>> BEGIN
 SELECT * INTO cfg FROM public.shrigma_segment_config c WHERE c.brand=segment_api.brand FOR SHARE;
 IF action='segmentos_listar' THEN
  IF (p ? 'limit' AND coalesce(p->>'limit','')!~'^[1-9][0-9]{0,2}$') OR (p ? 'offset' AND coalesce(p->>'offset','')!~'^(0|[1-9][0-9]{0,4})$') THEN RAISE EXCEPTION 'SEGMENT_PAGE_INVALID'; END IF;
  limit_n:=coalesce((p->>'limit')::integer,50);offset_n:=coalesce((p->>'offset')::integer,0);
  IF limit_n>100 OR offset_n>10000 THEN RAISE EXCEPTION 'SEGMENT_PAGE_INVALID'; END IF;
  SELECT coalesce(jsonb_agg(public.shrigma_segment_public_v1(q) ORDER BY q.updated_at DESC,q.id),'[]') INTO r FROM (SELECT * FROM public.shrigma_segment x WHERE x.brand=segment_api.brand ORDER BY x.updated_at DESC,x.id LIMIT limit_n OFFSET offset_n) q;
  response:=jsonb_build_object('_http',200,'_body',jsonb_build_object('segments',r,'limit',limit_n,'offset',offset_n,'capabilities',jsonb_build_object('draft',coalesce(cfg.enabled AND cfg.base_list_id IS NOT NULL AND caps ? 'draft',false),'count',coalesce(cfg.enabled AND cfg.base_list_id IS NOT NULL AND caps ? 'read_content',false),'send',false)));
  EXIT apply_request;
 END IF;
 IF action IN('segmento_obter','segmento_salvar','segmento_arquivar') OR (action='segmento_contar' AND p ? 'id') THEN
  IF coalesce(p->>'id','')!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RAISE EXCEPTION 'SEGMENT_ID_INVALID'; END IF;
  row_id:=(p->>'id')::uuid;
  IF mutation THEN SELECT * INTO s FROM public.shrigma_segment x WHERE x.id=row_id AND x.brand=segment_api.brand FOR UPDATE;
  ELSE SELECT * INTO s FROM public.shrigma_segment x WHERE x.id=row_id AND x.brand=segment_api.brand FOR SHARE; END IF;
  IF NOT FOUND THEN response:=jsonb_build_object('_http',404,'_body',jsonb_build_object('error','SEGMENT_NOT_FOUND'));EXIT apply_request;END IF;
  IF action='segmento_obter' THEN response:=jsonb_build_object('_http',200,'_body',jsonb_build_object('segment',public.shrigma_segment_public_v1(s)));EXIT apply_request; END IF;
  IF jsonb_typeof(p->'expected_version') IS DISTINCT FROM 'number' OR coalesce(p->>'expected_version','')!~'^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'SEGMENT_VERSION_REQUIRED'; END IF;
  expected:=(p->>'expected_version')::integer;
  IF expected<>s.version THEN response:=jsonb_build_object('_http',409,'_body',jsonb_build_object('error','SEGMENT_VERSION_CONFLICT','current_version',s.version));EXIT apply_request;END IF;
  IF s.archived THEN response:=jsonb_build_object('_http',409,'_body',jsonb_build_object('error','SEGMENT_ARCHIVED'));EXIT apply_request;END IF;
 END IF;
 IF cfg.brand IS NULL OR NOT cfg.enabled OR cfg.base_list_id IS NULL THEN response:=jsonb_build_object('_http',503,'_body',jsonb_build_object('error','SEGMENT_UNAVAILABLE','transport_supported',false));EXIT apply_request;END IF;
 IF action='segmento_contar' THEN
  IF (p ? 'id')=(p ? 'definition') OR (NOT p ? 'id' AND p ? 'expected_version') THEN RAISE EXCEPTION 'SEGMENT_COUNT_INPUT'; END IF;
  d:=public.shrigma_segment_definition_v1(CASE WHEN p ? 'id' THEN s.definition ELSE p->'definition' END);
  IF d->>'brand' IS DISTINCT FROM brand THEN RAISE EXCEPTION 'SEGMENT_BRAND_MISMATCH'; END IF;
  counted:=public.shrigma_segment_count_v1(d,cfg.base_list_id);
  response:=jsonb_build_object('_http',200,'_body',counted||jsonb_build_object('segment_id',s.id,'version',s.version));EXIT apply_request;
 END IF;
 IF action='segmento_arquivar' THEN
  UPDATE public.shrigma_segment SET archived=true,version=version+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
 ELSE
  d:=public.shrigma_segment_definition_v1(p->'definition');IF d->>'brand' IS DISTINCT FROM brand THEN RAISE EXCEPTION 'SEGMENT_BRAND_MISMATCH';END IF;
  r:=public.shrigma_segment_rule_v1(d->'rule',1);
  SELECT array_agg(DISTINCT n ORDER BY n) INTO ids FROM (SELECT cfg.base_list_id n UNION ALL SELECT value::integer FROM jsonb_array_elements_text(r->'list_ids')) q;
  IF (SELECT count(*) FROM public.lists l WHERE l.id=ANY(ids) AND l.status::text='active' AND l.optin::text IN('single','double') AND public.shrigma_campaign_list_brand(l)=brand)<>cardinality(ids) THEN RAISE EXCEPTION 'SEGMENT_LIST_UNAVAILABLE'; END IF;
  IF action='segmento_criar' THEN INSERT INTO public.shrigma_segment(brand,name,definition,created_by,updated_by) VALUES(brand,d->>'name',d,actor,actor) RETURNING * INTO s;
  ELSE UPDATE public.shrigma_segment SET name=d->>'name',definition=d,version=version+1,updated_by=actor,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;END IF;
 END IF;
 INSERT INTO public.shrigma_segment_revision(segment_id,version,definition,archived,actor) VALUES(s.id,s.version,s.definition,s.archived,actor);
 response:=jsonb_build_object('_http',CASE WHEN action='segmento_criar' THEN 201 ELSE 200 END,'_body',jsonb_build_object('segment',public.shrigma_segment_public_v1(s),'transport_supported',false));
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM !~ '^SEGMENT_[A-Z0-9_]+$' THEN RAISE; END IF;
  response:=jsonb_build_object('_http',422,'_body',jsonb_build_object('error',SQLERRM));
 END apply_request;
 IF mutation THEN INSERT INTO public.shrigma_segment_request(actor,operation_key,brand,payload,response) VALUES(actor,idem,brand,p,response); END IF;
 RETURN response;
END $f$;
REVOKE ALL ON FUNCTION public.shrigma_segment_rule_v1(jsonb,integer),public.shrigma_segment_definition_v1(jsonb),public.shrigma_segment_public_v1(public.shrigma_segment),public.shrigma_segment_count_v1(jsonb,integer),public.shrigma_segment_api_v1(text,jsonb,jsonb) FROM PUBLIC;
COMMIT;
