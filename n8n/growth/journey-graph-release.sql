-- Candidate only: immutable snapshots in the graph schema. Never edits native
-- templates/flows, creates a Listmonk clone, enrolls a contact or enables transport.
DO $install$
BEGIN
 IF to_regnamespace('crm_graph_candidate') IS NULL OR to_regclass('public.templates') IS NULL OR to_regclass('public.shrigma_template_email_registry') IS NULL OR to_regclass('public.shrigma_flow_definition') IS NULL THEN RAISE EXCEPTION 'GRAPH_RELEASE_DEPENDENCY';END IF;
 IF EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='crm_graph_candidate'::regnamespace AND relname IN ('message_release_v1','message_release_request_v1')) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='crm_graph_candidate'::regnamespace AND proname IN ('release_source_v1','release_prepare_v1','release_get_v1','release_operation_v1','release_immutable_v1')) THEN RAISE EXCEPTION 'GRAPH_RELEASE_COLLISION';END IF;
 CREATE TABLE crm_graph_candidate.message_release_v1(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand text NOT NULL CHECK(brand IN ('fish','aristo')),binding text NOT NULL,
  source_template_id integer NOT NULL,source_snapshot text NOT NULL CHECK(source_snapshot~'^snapshot_[a-f0-9]{48}$'),source jsonb NOT NULL,
  material jsonb NOT NULL CHECK(material->>'version'='journey_graph_release_v1'),material_sha256 text NOT NULL CHECK(material_sha256~'^[a-f0-9]{64}$'),
  actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(brand,binding,material_sha256));
 CREATE TABLE crm_graph_candidate.message_release_request_v1(
  request_id uuid PRIMARY KEY,actor text NOT NULL,payload jsonb NOT NULL,release_id uuid NOT NULL REFERENCES crm_graph_candidate.message_release_v1(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
 EXECUTE $ddl$
 CREATE FUNCTION crm_graph_candidate.release_immutable_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate AS $fn$
 BEGIN RAISE EXCEPTION 'GRAPH_RELEASE_IMMUTABLE';END $fn$;
 $ddl$;
 CREATE TRIGGER graph_release_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.message_release_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.release_immutable_v1();
 CREATE TRIGGER graph_release_request_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.message_release_request_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.release_immutable_v1();
 EXECUTE $ddl$
 CREATE FUNCTION crm_graph_candidate.release_source_v1(b text,tid integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate AS $fn$
 DECLARE t jsonb;f public.shrigma_flow_definition%ROWTYPE;slot jsonb;
 BEGIN
  IF b IS NULL OR b NOT IN ('fish','aristo') OR tid IS NULL OR tid<=0 THEN RAISE EXCEPTION 'GRAPH_RELEASE_BRAND';END IF;
  SELECT * INTO f FROM public.shrigma_flow_definition WHERE key=b||':carrinho' AND brand=b AND runtime_ready IS TRUE AND published_version>0;
  IF NOT FOUND OR jsonb_typeof(f.published->'steps') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GRAPH_RELEASE_FLOW_UNAVAILABLE';END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(f.published->'steps') s WHERE s->>'key'='email:carrinho-30min')<>1 THEN RAISE EXCEPTION 'GRAPH_RELEASE_SLOT_UNAVAILABLE';END IF;
  SELECT s INTO slot FROM jsonb_array_elements(f.published->'steps') s WHERE s->>'key'='email:carrinho-30min';
  IF slot->>'channel' IS DISTINCT FROM 'email' OR slot->>'flow' IS DISTINCT FROM 'carrinho' OR slot->>'piece' IS DISTINCT FROM 'carrinho-30min' OR slot->>'enabled' IS DISTINCT FROM 'true' OR slot->>'template_id' IS DISTINCT FROM tid::text THEN RAISE EXCEPTION 'GRAPH_RELEASE_SLOT_UNAVAILABLE';END IF;
  SELECT jsonb_build_object('type',x.type,'subject',x.subject,'body',x.body,'body_source',to_jsonb(x)->'body_source') INTO t FROM public.templates x WHERE x.id=tid AND x.type::text='tx' AND NOT starts_with(x.name,'__shrigma_journey_tx_v1_')
   AND EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=tid AND r.brand=b)
   AND NOT EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=tid AND r.brand IS DISTINCT FROM b);
  IF t IS NULL THEN RAISE EXCEPTION 'GRAPH_RELEASE_TEMPLATE_UNAVAILABLE';END IF;
  RETURN jsonb_build_object('brand',b,'template_id',tid,'binding','email.template.'||tid::text,'source_snapshot','snapshot_'||substr(encode(sha256(convert_to(t::text,'UTF8')),'hex'),1,48),'native',t,'slot',slot,'published_version',f.published_version);
 END $fn$;
 $ddl$;
 EXECUTE $ddl$
 CREATE FUNCTION crm_graph_candidate.release_get_v1(b text,rid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate AS $fn$
 SELECT to_jsonb(r) FROM crm_graph_candidate.message_release_v1 r WHERE r.brand=b AND r.id=rid AND b IN ('fish','aristo')
 $fn$;
 $ddl$;
 EXECUTE $ddl$
 CREATE FUNCTION crm_graph_candidate.release_operation_v1(a text,p jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate AS $fn$
 DECLARE o crm_graph_candidate.message_release_request_v1%ROWTYPE;
 BEGIN
  SELECT * INTO o FROM crm_graph_candidate.message_release_request_v1 WHERE request_id=(p->>'request_id')::uuid;
  IF NOT FOUND THEN RETURN NULL;END IF;
  IF o.actor IS DISTINCT FROM a OR o.payload IS DISTINCT FROM p THEN RAISE EXCEPTION 'GRAPH_RELEASE_REPLAY_MISMATCH';END IF;
  RETURN crm_graph_candidate.release_get_v1(p->>'brand',o.release_id);
 END $fn$;
 $ddl$;
 EXECUTE $ddl$
 CREATE FUNCTION crm_graph_candidate.release_prepare_v1(a text,p jsonb,expected jsonb,m jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $fn$
 DECLARE rid uuid;tid integer;replay jsonb;actual jsonb;h text;
 BEGIN
  IF a IS NULL OR a!~'^panel:.{1,194}$' OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR p-ARRAY['request_id','brand','binding','expected_snapshot']<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(p))<>4
   OR p->>'brand' NOT IN ('fish','aristo') OR coalesce(p->>'binding','')!~'^email\.template\.[1-9][0-9]{0,8}$' OR coalesce(p->>'expected_snapshot','')!~'^snapshot_[a-f0-9]{48}$' OR coalesce(p->>'request_id','')!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$' THEN RAISE EXCEPTION 'GRAPH_RELEASE_REQUEST_INVALID';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('graph-release-request:'||(p->>'request_id'),0));
  replay:=crm_graph_candidate.release_operation_v1(a,p);IF replay IS NOT NULL THEN RETURN replay;END IF;
  tid:=substring(p->>'binding' FROM 16)::integer;
  -- Lock only the selected native source rows, then read under the same transaction.
  PERFORM 1 FROM public.shrigma_flow_definition WHERE key=(p->>'brand')||':carrinho' FOR SHARE;
  PERFORM 1 FROM public.templates WHERE id=tid FOR SHARE;
  PERFORM 1 FROM public.shrigma_template_email_registry WHERE template_id=tid FOR SHARE;
  actual:=crm_graph_candidate.release_source_v1(p->>'brand',tid);
  IF actual IS DISTINCT FROM expected OR actual->>'source_snapshot' IS DISTINCT FROM p->>'expected_snapshot' THEN RAISE EXCEPTION 'GRAPH_RELEASE_SOURCE_CHANGED';END IF;
  IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR octet_length(m::text)>300000 OR m->>'version' IS DISTINCT FROM 'journey_graph_release_v1' OR m->>'brand' IS DISTINCT FROM p->>'brand' OR m->>'binding' IS DISTINCT FROM p->>'binding' OR m->>'source_snapshot' IS DISTINCT FROM p->>'expected_snapshot' OR m->>'source_template_id' IS DISTINCT FROM tid::text OR m->'native' IS DISTINCT FROM actual->'native'
   OR m->'readiness' IS DISTINCT FROM '{"snapshot_only":true,"native_cache_bound":false,"transport":false}'::jsonb OR jsonb_typeof(m->'variables') IS DISTINCT FROM 'object' OR jsonb_typeof(m->'required_fields') IS DISTINCT FROM 'array' OR jsonb_typeof(m->'required_item_fields') IS DISTINCT FROM 'array' OR m->'required_identity' IS DISTINCT FROM '["subject_id"]'::jsonb
   OR m#>>'{tracking,version}' IS DISTINCT FROM 'cart_email_utm_v1' OR m#>>'{tracking,source}' IS DISTINCT FROM 'email' OR m#>>'{tracking,medium}' IS DISTINCT FROM 'fluxo' OR m#>>'{tracking,campaign}' IS DISTINCT FROM (p->>'brand')||'-carrinho' OR m#>>'{tracking,content}' IS DISTINCT FROM 'carrinho-30min'
   THEN RAISE EXCEPTION 'GRAPH_RELEASE_MATERIAL_INVALID';END IF;
  h:=encode(sha256(convert_to(m::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('graph-release-content:'||(p->>'brand')||':'||h,0));
  SELECT id INTO rid FROM crm_graph_candidate.message_release_v1 WHERE brand=p->>'brand' AND binding=p->>'binding' AND material_sha256=h;
  IF rid IS NULL THEN INSERT INTO crm_graph_candidate.message_release_v1(brand,binding,source_template_id,source_snapshot,source,material,material_sha256,actor) VALUES(p->>'brand',p->>'binding',tid,p->>'expected_snapshot',actual,m,h,a) RETURNING id INTO rid;END IF;
  INSERT INTO crm_graph_candidate.message_release_request_v1(request_id,actor,payload,release_id) VALUES((p->>'request_id')::uuid,a,p,rid);
  RETURN crm_graph_candidate.release_get_v1(p->>'brand',rid);
 END $fn$;
 $ddl$;
 REVOKE ALL ON crm_graph_candidate.message_release_v1,crm_graph_candidate.message_release_request_v1 FROM PUBLIC;
 REVOKE ALL ON FUNCTION crm_graph_candidate.release_immutable_v1(),crm_graph_candidate.release_source_v1(text,integer),crm_graph_candidate.release_get_v1(text,uuid),crm_graph_candidate.release_operation_v1(text,jsonb),crm_graph_candidate.release_prepare_v1(text,jsonb,jsonb,jsonb) FROM PUBLIC;
END $install$;
