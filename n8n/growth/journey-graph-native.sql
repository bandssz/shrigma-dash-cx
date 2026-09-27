-- Candidate only. Creates immutable native-template reservations, never sends.
-- One-shot transaction: existing objects are a collision, never silently adopted.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $install$
BEGIN
 IF to_regclass('crm_graph_candidate.message_release_v1') IS NULL OR to_regclass('public.templates') IS NULL OR to_regclass('public.shrigma_template_email_registry') IS NULL THEN RAISE EXCEPTION 'GRAPH_NATIVE_DEPENDENCY';END IF;
 IF EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='crm_graph_candidate'::regnamespace AND relname IN ('native_template_v1','native_request_v1'))
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='crm_graph_candidate'::regnamespace AND proname IN ('native_content_v1','native_receipt_v1','native_guard_check_v1','native_clone_check_v1','native_immutable_v1','native_template_guard_v1','native_registry_guard_v1','native_prepare_v1','native_operation_v1','native_begin_v1','native_confirm_v1','native_get_v1','native_resolve_v1','native_candidate_v1'))
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('graph_native_template_guard_v1','graph_native_registry_guard_v1') AND tgrelid IN ('public.templates'::regclass,'public.shrigma_template_email_registry'::regclass))
 OR EXISTS(SELECT 1 FROM public.templates WHERE starts_with(name,'__shrigma_graph_tx_v1_'))
 OR to_regclass('public.graph_native_template_name_v1') IS NOT NULL
 THEN RAISE EXCEPTION 'GRAPH_NATIVE_COLLISION';END IF;
END $install$;

CREATE TABLE crm_graph_candidate.native_template_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 release_id uuid NOT NULL REFERENCES crm_graph_candidate.message_release_v1(id),
 material_sha256 text NOT NULL CHECK(material_sha256~'^[a-f0-9]{64}$'),native_sha256 text NOT NULL CHECK(native_sha256~'^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=300000),
 clone_name text NOT NULL UNIQUE,cache_target text NOT NULL CHECK(cache_target~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','creating','ready')),claim_token uuid,
 clone_template_id integer UNIQUE REFERENCES public.templates(id),cache_ack_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(release_id,cache_target),
 CHECK(clone_name='__shrigma_graph_tx_v1_'||id::text),CHECK((state='reserved')=(claim_token IS NULL)),
 CHECK((state='ready' AND clone_template_id IS NOT NULL AND cache_ack_at IS NOT NULL) OR (state<>'ready' AND clone_template_id IS NULL AND cache_ack_at IS NULL))
);
CREATE TABLE crm_graph_candidate.native_request_v1(
 request_id uuid PRIMARY KEY,actor text NOT NULL,payload jsonb NOT NULL,cache_target text NOT NULL,
 native_id uuid NOT NULL REFERENCES crm_graph_candidate.native_template_v1(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION crm_graph_candidate.native_content_v1(t jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('type',t->'type','subject',t->'subject','body',t->'body','body_source',t->'body_source')
$f$;
CREATE FUNCTION crm_graph_candidate.native_receipt_v1(r crm_graph_candidate.native_template_v1) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
 SELECT jsonb_build_object('contract','journey_graph_native_v1','native_id',r.id,'brand',r.brand,'release_id',r.release_id,
 'material_sha256',r.material_sha256,'native_sha256',r.native_sha256,'cache_target',r.cache_target,'state',r.state,
 'clone_template_id',r.clone_template_id,'cache_ack_at',r.cache_ack_at)
$f$;
CREATE FUNCTION crm_graph_candidate.native_guard_check_v1() RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate AS $f$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.templates'::regclass AND tgname='graph_native_template_guard_v1' AND tgfoid='crm_graph_candidate.native_template_guard_v1()'::regprocedure AND tgenabled='O' AND tgtype=31)
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shrigma_template_email_registry'::regclass AND tgname='graph_native_registry_guard_v1' AND tgfoid='crm_graph_candidate.native_registry_guard_v1()'::regprocedure AND tgenabled='O' AND tgtype=23)
 OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.graph_native_template_name_v1') AND indisunique AND indisvalid AND indisready)
 THEN RAISE EXCEPTION 'GRAPH_NATIVE_GUARD_UNAVAILABLE';END IF;
END $f$;
CREATE FUNCTION crm_graph_candidate.native_clone_check_v1(r crm_graph_candidate.native_template_v1,tid integer) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate AS $f$
DECLARE t jsonb;m crm_graph_candidate.message_release_v1%ROWTYPE;
BEGIN
 PERFORM crm_graph_candidate.native_guard_check_v1();
 SELECT * INTO m FROM crm_graph_candidate.message_release_v1 WHERE id=r.release_id;
 IF NOT FOUND OR m.brand IS DISTINCT FROM r.brand OR m.material_sha256 IS DISTINCT FROM r.material_sha256 OR m.material->'native' IS DISTINCT FROM r.snapshot
 OR encode(sha256(convert_to(r.snapshot::text,'UTF8')),'hex') IS DISTINCT FROM r.native_sha256 THEN RAISE EXCEPTION 'GRAPH_NATIVE_RELEASE_MISMATCH';END IF;
 SELECT to_jsonb(x) INTO t FROM public.templates x WHERE x.id=tid AND x.name=r.clone_name;
 IF t IS NULL OR t->>'type' IS DISTINCT FROM 'tx' OR t->>'is_default' IS DISTINCT FROM 'false'
 OR crm_graph_candidate.native_content_v1(t) IS DISTINCT FROM r.snapshot
 OR EXISTS(SELECT 1 FROM public.shrigma_template_email_registry WHERE template_id=tid) THEN RAISE EXCEPTION 'GRAPH_NATIVE_CLONE_MISMATCH';END IF;
END $f$;
CREATE FUNCTION crm_graph_candidate.native_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate AS $f$
BEGIN
 IF TG_TABLE_NAME='native_request_v1' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'GRAPH_NATIVE_IMMUTABLE';END IF;
 IF (to_jsonb(OLD)-ARRAY['state','claim_token','clone_template_id','cache_ack_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','claim_token','clone_template_id','cache_ack_at'])
 OR NOT ((OLD.state='reserved' AND NEW.state='creating' AND NEW.claim_token IS NOT NULL AND NEW.clone_template_id IS NULL AND NEW.cache_ack_at IS NULL)
 OR (OLD.state='creating' AND NEW.state='ready' AND NEW.claim_token=OLD.claim_token AND NEW.clone_template_id IS NOT NULL AND NEW.cache_ack_at IS NOT NULL)) THEN RAISE EXCEPTION 'GRAPH_NATIVE_IMMUTABLE';END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER graph_native_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.native_template_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.native_immutable_v1();
CREATE TRIGGER graph_native_request_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.native_request_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.native_immutable_v1();

CREATE FUNCTION crm_graph_candidate.native_template_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate AS $f$
DECLARE r crm_graph_candidate.native_template_v1%ROWTYPE;
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') AND starts_with(OLD.name,'__shrigma_graph_tx_v1_') THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GRAPH_NATIVE_TEMPLATE_IMMUTABLE';END IF;
  IF (to_jsonb(OLD)-ARRAY['updated_at','is_default']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['updated_at','is_default']) OR NEW.is_default IS DISTINCT FROM false THEN RAISE EXCEPTION 'GRAPH_NATIVE_TEMPLATE_IMMUTABLE';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'DELETE' AND starts_with(NEW.name,'__shrigma_graph_tx_v1_') THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GRAPH_NATIVE_CREATE_REQUIRED';END IF;
  SELECT * INTO r FROM crm_graph_candidate.native_template_v1 WHERE clone_name=NEW.name FOR UPDATE;
  IF NOT FOUND OR r.state<>'creating' OR NEW.is_default IS DISTINCT FROM false OR NEW.type::text<>'tx'
   OR crm_graph_candidate.native_content_v1(to_jsonb(NEW)) IS DISTINCT FROM r.snapshot THEN RAISE EXCEPTION 'GRAPH_NATIVE_RESERVED_CONTENT_REQUIRED';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $f$;
CREATE TRIGGER graph_native_template_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON public.templates FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.native_template_guard_v1();
CREATE UNIQUE INDEX graph_native_template_name_v1 ON public.templates(name) WHERE starts_with(name,'__shrigma_graph_tx_v1_');
CREATE FUNCTION crm_graph_candidate.native_registry_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
BEGIN
 IF EXISTS(SELECT 1 FROM public.templates WHERE id=NEW.template_id AND starts_with(name,'__shrigma_graph_tx_v1_')) THEN RAISE EXCEPTION 'GRAPH_NATIVE_NOT_EDITABLE_CATALOG';END IF;
 RETURN NEW;
END $f$;
CREATE TRIGGER graph_native_registry_guard_v1 BEFORE INSERT OR UPDATE ON public.shrigma_template_email_registry FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.native_registry_guard_v1();

CREATE FUNCTION crm_graph_candidate.native_get_v1(b text,nid uuid,target text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate AS $f$
DECLARE r crm_graph_candidate.native_template_v1%ROWTYPE;
BEGIN
 SELECT * INTO r FROM crm_graph_candidate.native_template_v1 WHERE id=nid AND brand=b AND cache_target=target AND b IN ('fish','aristo');
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF r.state='ready' THEN PERFORM crm_graph_candidate.native_clone_check_v1(r,r.clone_template_id);END IF;
 RETURN crm_graph_candidate.native_receipt_v1(r);
END $f$;
CREATE FUNCTION crm_graph_candidate.native_operation_v1(a text,p jsonb,target text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate AS $f$
DECLARE o crm_graph_candidate.native_request_v1%ROWTYPE;
BEGIN
 SELECT * INTO o FROM crm_graph_candidate.native_request_v1 WHERE request_id=(p->>'request_id')::uuid;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF o.actor IS DISTINCT FROM a OR o.payload IS DISTINCT FROM p OR o.cache_target IS DISTINCT FROM target THEN RAISE EXCEPTION 'GRAPH_NATIVE_REPLAY_MISMATCH';END IF;
 RETURN crm_graph_candidate.native_get_v1(p->>'brand',o.native_id,target);
END $f$;
CREATE FUNCTION crm_graph_candidate.native_prepare_v1(a text,p jsonb,target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE m crm_graph_candidate.message_release_v1%ROWTYPE;r crm_graph_candidate.native_template_v1%ROWTYPE;replay jsonb;s jsonb;nid uuid;
BEGIN
 IF a IS NULL OR a!~'^panel:.{1,194}$' OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR p-ARRAY['request_id','brand','release_id','expected_material_sha256']<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(p))<>4
 OR coalesce(p->>'brand','') NOT IN ('fish','aristo') OR coalesce(p->>'expected_material_sha256','')!~'^[a-f0-9]{64}$'
 OR coalesce(p->>'request_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 OR coalesce(p->>'release_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 OR target IS NULL OR target!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RAISE EXCEPTION 'GRAPH_NATIVE_REQUEST_INVALID';END IF;
 PERFORM crm_graph_candidate.native_guard_check_v1();
 PERFORM pg_advisory_xact_lock(hashtextextended('graph-native-request:'||(p->>'request_id'),0));
 replay:=crm_graph_candidate.native_operation_v1(a,p,target);IF replay IS NOT NULL THEN RETURN replay;END IF;
 SELECT * INTO m FROM crm_graph_candidate.message_release_v1 WHERE id=(p->>'release_id')::uuid AND brand=p->>'brand';
 IF NOT FOUND OR m.material_sha256 IS DISTINCT FROM p->>'expected_material_sha256' THEN RAISE EXCEPTION 'GRAPH_NATIVE_RELEASE_MISMATCH';END IF;
 s:=m.material->'native';
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR s-ARRAY['type','subject','body','body_source']<>'{}'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(s))<>4
 OR s->>'type' IS DISTINCT FROM 'tx' OR jsonb_typeof(s->'subject') IS DISTINCT FROM 'string' OR jsonb_typeof(s->'body') IS DISTINCT FROM 'string'
 OR jsonb_typeof(s->'body_source') NOT IN ('string','null') OR m.material->>'brand' IS DISTINCT FROM m.brand
 OR encode(sha256(convert_to(m.material::text,'UTF8')),'hex') IS DISTINCT FROM m.material_sha256 THEN RAISE EXCEPTION 'GRAPH_NATIVE_RELEASE_MISMATCH';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('graph-native-release:'||m.id::text||':'||target,0));
 SELECT * INTO r FROM crm_graph_candidate.native_template_v1 WHERE release_id=m.id AND cache_target=target;
 IF NOT FOUND THEN
  nid:=gen_random_uuid();INSERT INTO crm_graph_candidate.native_template_v1(id,brand,release_id,material_sha256,native_sha256,snapshot,clone_name,cache_target)
  VALUES(nid,m.brand,m.id,m.material_sha256,encode(sha256(convert_to(s::text,'UTF8')),'hex'),s,'__shrigma_graph_tx_v1_'||nid::text,target) RETURNING * INTO r;
 END IF;
 INSERT INTO crm_graph_candidate.native_request_v1(request_id,actor,payload,cache_target,native_id) VALUES((p->>'request_id')::uuid,a,p,target,r.id);
 RETURN crm_graph_candidate.native_get_v1(r.brand,r.id,target);
END $f$;
CREATE FUNCTION crm_graph_candidate.native_begin_v1(b text,nid uuid,target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE r crm_graph_candidate.native_template_v1%ROWTYPE;
BEGIN
 PERFORM crm_graph_candidate.native_guard_check_v1();
 SELECT * INTO r FROM crm_graph_candidate.native_template_v1 WHERE id=nid AND brand=b AND cache_target=target AND b IN ('fish','aristo') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_NATIVE_NOT_FOUND';END IF;
 IF r.state<>'reserved' THEN RETURN jsonb_build_object('should_create',false,'receipt',crm_graph_candidate.native_get_v1(b,nid,target));END IF;
 UPDATE crm_graph_candidate.native_template_v1 SET state='creating',claim_token=gen_random_uuid() WHERE id=nid RETURNING * INTO r;
 RETURN jsonb_build_object('should_create',true,'receipt',crm_graph_candidate.native_receipt_v1(r),'snapshot',r.snapshot,'clone_name',r.clone_name,'claim_token',r.claim_token);
END $f$;
CREATE FUNCTION crm_graph_candidate.native_confirm_v1(b text,nid uuid,token uuid,tid integer,target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE r crm_graph_candidate.native_template_v1%ROWTYPE;
BEGIN
 SELECT * INTO r FROM crm_graph_candidate.native_template_v1 WHERE id=nid AND brand=b AND cache_target=target AND b IN ('fish','aristo') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_NATIVE_NOT_FOUND';END IF;
 IF token IS NULL OR r.claim_token IS DISTINCT FROM token OR r.state='reserved' THEN RAISE EXCEPTION 'GRAPH_NATIVE_CLAIM_MISMATCH';END IF;
 PERFORM 1 FROM public.templates WHERE id=tid FOR SHARE;
 PERFORM crm_graph_candidate.native_clone_check_v1(r,tid);
 IF r.state='ready' THEN
  IF r.clone_template_id IS DISTINCT FROM tid THEN RAISE EXCEPTION 'GRAPH_NATIVE_CLONE_MISMATCH';END IF;
 ELSE UPDATE crm_graph_candidate.native_template_v1 SET state='ready',clone_template_id=tid,cache_ack_at=clock_timestamp() WHERE id=nid RETURNING * INTO r;
 END IF;
 RETURN crm_graph_candidate.native_receipt_v1(r);
END $f$;
CREATE FUNCTION crm_graph_candidate.native_resolve_v1(b text,rid uuid,h text,target text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,crm_graph_candidate AS $f$
DECLARE r crm_graph_candidate.native_template_v1%ROWTYPE;
BEGIN
 SELECT * INTO r FROM crm_graph_candidate.native_template_v1 WHERE release_id=rid AND brand=b AND material_sha256=h AND cache_target=target AND b IN ('fish','aristo');
 IF NOT FOUND OR r.state<>'ready' THEN RAISE EXCEPTION 'GRAPH_NATIVE_NOT_READY';END IF;
 PERFORM crm_graph_candidate.native_clone_check_v1(r,r.clone_template_id);
 RETURN crm_graph_candidate.native_receipt_v1(r);
END $f$;
CREATE FUNCTION crm_graph_candidate.native_candidate_v1(b text,nid uuid,target text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,crm_graph_candidate AS $f$
DECLARE r crm_graph_candidate.native_template_v1%ROWTYPE;tid integer;
BEGIN
 SELECT * INTO r FROM crm_graph_candidate.native_template_v1 WHERE id=nid AND brand=b AND cache_target=target AND b IN ('fish','aristo');
 IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_NATIVE_NOT_FOUND';END IF;
 PERFORM crm_graph_candidate.native_guard_check_v1();
 SELECT id INTO tid FROM public.templates WHERE name=r.clone_name;
 IF tid IS NOT NULL THEN PERFORM crm_graph_candidate.native_clone_check_v1(r,tid);END IF;
 RETURN jsonb_build_object('receipt',crm_graph_candidate.native_receipt_v1(r),'native_id_candidate',tid,'clone_name',r.clone_name,'snapshot',r.snapshot);
END $f$;
REVOKE ALL ON crm_graph_candidate.native_template_v1,crm_graph_candidate.native_request_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_graph_candidate.native_content_v1(jsonb),crm_graph_candidate.native_receipt_v1(crm_graph_candidate.native_template_v1),crm_graph_candidate.native_guard_check_v1(),crm_graph_candidate.native_clone_check_v1(crm_graph_candidate.native_template_v1,integer),crm_graph_candidate.native_immutable_v1(),crm_graph_candidate.native_template_guard_v1(),crm_graph_candidate.native_registry_guard_v1(),crm_graph_candidate.native_get_v1(text,uuid,text),crm_graph_candidate.native_operation_v1(text,jsonb,text),crm_graph_candidate.native_prepare_v1(text,jsonb,text),crm_graph_candidate.native_begin_v1(text,uuid,text),crm_graph_candidate.native_confirm_v1(text,uuid,uuid,integer,text),crm_graph_candidate.native_resolve_v1(text,uuid,text,text),crm_graph_candidate.native_candidate_v1(text,uuid,text) FROM PUBLIC;
COMMIT;
