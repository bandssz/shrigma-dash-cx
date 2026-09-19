-- B06 candidate. Install before journey-cart-entry.sql; enables no sender.
-- Native template creation is separate because Listmonk keeps a compiled cache.
BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS public.shrigma_journey_template_release_v1 (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 brand text NOT NULL CHECK(brand='fish'),
 source_template_id integer NOT NULL CHECK(source_template_id>0),
 content_hash text NOT NULL,
 snapshot jsonb NOT NULL CHECK(snapshot->>'type'='tx'),
 clone_name text NOT NULL UNIQUE,
 cache_target text NOT NULL CHECK(length(btrim(cache_target)) BETWEEN 1 AND 128),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','creating','ready')),
 claim_token uuid,
 clone_template_id integer UNIQUE REFERENCES public.templates(id),
 cache_ack_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(clone_name='__shrigma_journey_tx_v1_'||id::text),
 CHECK((state='reserved')=(claim_token IS NULL)),
 CHECK((state='ready')=(clone_template_id IS NOT NULL AND cache_ack_at IS NOT NULL)),
 UNIQUE(brand,source_template_id,content_hash,cache_target)
);

CREATE OR REPLACE FUNCTION public.shrigma_journey_template_content_v1(t jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
 SELECT jsonb_build_object('type',t->'type','subject',t->'subject','body',t->'body','body_source',t->'body_source')
$f$;

-- The namespace is protected from INSERT, before a native API acknowledgement.
-- This avoids a create/seal race that could put different bytes into the cache.
CREATE OR REPLACE FUNCTION public.shrigma_journey_template_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE r public.shrigma_journey_template_release_v1%ROWTYPE;
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') AND starts_with(OLD.name,'__shrigma_journey_tx_v1_') THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'JOURNEY_TEMPLATE_IMMUTABLE';END IF;
  IF (to_jsonb(OLD)-ARRAY['updated_at','is_default']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['updated_at','is_default'])
   OR NEW.is_default THEN RAISE EXCEPTION 'JOURNEY_TEMPLATE_IMMUTABLE';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'DELETE' AND starts_with(NEW.name,'__shrigma_journey_tx_v1_') THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'JOURNEY_TEMPLATE_CREATE_REQUIRED';END IF;
  SELECT * INTO r FROM public.shrigma_journey_template_release_v1 WHERE clone_name=NEW.name FOR UPDATE;
  IF NOT FOUND OR r.state<>'creating' OR NEW.is_default OR NEW.type::text<>'tx'
   OR public.shrigma_journey_template_content_v1(to_jsonb(NEW)) IS DISTINCT FROM r.snapshot
   THEN RAISE EXCEPTION 'JOURNEY_TEMPLATE_RESERVED_CONTENT_REQUIRED';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $f$;

DO $guard$
BEGIN
 IF EXISTS(SELECT 1 FROM public.templates t WHERE starts_with(t.name,'__shrigma_journey_tx_v1_')
  AND NOT EXISTS(SELECT 1 FROM public.shrigma_journey_template_release_v1 r WHERE r.clone_name=t.name))
  THEN RAISE EXCEPTION 'JOURNEY_TEMPLATE_NAMESPACE_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.templates'::regclass AND tgname='shrigma_journey_template_guard_v1'
  AND (tgfoid<>'public.shrigma_journey_template_guard_v1()'::regprocedure OR tgenabled<>'O'))
  THEN RAISE EXCEPTION 'JOURNEY_TEMPLATE_GUARD_DRIFT';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.templates'::regclass AND tgname='shrigma_journey_template_guard_v1') THEN
  CREATE TRIGGER shrigma_journey_template_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON public.templates
   FOR EACH ROW EXECUTE FUNCTION public.shrigma_journey_template_guard_v1();
 END IF;
END $guard$;
CREATE UNIQUE INDEX IF NOT EXISTS shrigma_journey_template_name_v1 ON public.templates(name)
 WHERE starts_with(name,'__shrigma_journey_tx_v1_');

-- The operator's catalog keeps editable originals only. A release is a backend
-- object and cannot be accidentally offered as the next editable template.
CREATE OR REPLACE FUNCTION public.shrigma_journey_template_catalog_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
BEGIN
 IF EXISTS(SELECT 1 FROM public.templates WHERE id=NEW.template_id AND starts_with(name,'__shrigma_journey_tx_v1_'))
  THEN RAISE EXCEPTION 'JOURNEY_RELEASE_NOT_EDITABLE_CATALOG';END IF;
 RETURN NEW;
END $f$;
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shrigma_template_email_registry'::regclass AND tgname='shrigma_journey_template_catalog_guard_v1') THEN
  CREATE TRIGGER shrigma_journey_template_catalog_guard_v1 BEFORE INSERT OR UPDATE ON public.shrigma_template_email_registry
   FOR EACH ROW EXECUTE FUNCTION public.shrigma_journey_template_catalog_guard_v1();
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.shrigma_journey_template_release_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'JOURNEY_RELEASE_PRESERVE';END IF;
 IF (to_jsonb(OLD)-ARRAY['state','claim_token','clone_template_id','cache_ack_at']) IS DISTINCT FROM
  (to_jsonb(NEW)-ARRAY['state','claim_token','clone_template_id','cache_ack_at']) THEN RAISE EXCEPTION 'JOURNEY_RELEASE_IMMUTABLE';END IF;
 IF NOT ((OLD.state='reserved' AND NEW.state='creating' AND NEW.claim_token IS NOT NULL AND NEW.clone_template_id IS NULL AND NEW.cache_ack_at IS NULL)
  OR (OLD.state='creating' AND NEW.state='ready' AND NEW.claim_token=OLD.claim_token AND NEW.clone_template_id IS NOT NULL AND NEW.cache_ack_at IS NOT NULL))
  THEN RAISE EXCEPTION 'JOURNEY_RELEASE_TRANSITION';END IF;
 RETURN NEW;
END $f$;
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.shrigma_journey_template_release_v1'::regclass AND tgname='shrigma_journey_template_release_guard_v1') THEN
  CREATE TRIGGER shrigma_journey_template_release_guard_v1 BEFORE UPDATE OR DELETE ON public.shrigma_journey_template_release_v1
   FOR EACH ROW EXECUTE FUNCTION public.shrigma_journey_template_release_guard_v1();
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.shrigma_journey_template_prepare_v1(p_source integer,p_cache_target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $f$
DECLARE t jsonb;s jsonb;h text;r public.shrigma_journey_template_release_v1%ROWTYPE;rid uuid;
BEGIN
 IF p_source IS NULL OR p_source<=0 OR p_cache_target IS NULL OR length(btrim(p_cache_target)) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'JOURNEY_RELEASE_IDENTITY';END IF;
 SELECT to_jsonb(x) INTO t FROM public.templates x JOIN public.shrigma_template_email_registry g ON g.template_id=x.id
  WHERE x.id=p_source AND x.type::text='tx' AND g.brand='fish' AND NOT starts_with(x.name,'__shrigma_journey_tx_v1_') FOR SHARE OF x,g;
 IF t IS NULL THEN RAISE EXCEPTION 'JOURNEY_RELEASE_SOURCE_UNAVAILABLE';END IF;
 s:=public.shrigma_journey_template_content_v1(t);
 h:=encode(public.digest(convert_to(s::text,'UTF8'),'sha256'),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('journey-template:'||p_source||':'||h||':'||p_cache_target,0));
 SELECT * INTO r FROM public.shrigma_journey_template_release_v1 WHERE brand='fish' AND source_template_id=p_source AND content_hash=h AND cache_target=p_cache_target;
 IF NOT FOUND THEN
  rid:=gen_random_uuid();
  INSERT INTO public.shrigma_journey_template_release_v1(id,brand,source_template_id,content_hash,snapshot,clone_name,cache_target)
   VALUES(rid,'fish',p_source,h,s,'__shrigma_journey_tx_v1_'||rid::text,p_cache_target) RETURNING * INTO r;
 END IF;
 RETURN to_jsonb(r)-'claim_token';
END $f$;

CREATE OR REPLACE FUNCTION public.shrigma_journey_template_begin_v1(p_id uuid,p_cache_target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $f$
DECLARE r public.shrigma_journey_template_release_v1%ROWTYPE;
BEGIN
 SELECT * INTO STRICT r FROM public.shrigma_journey_template_release_v1 WHERE id=p_id FOR UPDATE;
 IF r.cache_target IS DISTINCT FROM p_cache_target THEN RAISE EXCEPTION 'JOURNEY_CACHE_TARGET_MISMATCH';END IF;
 IF r.state<>'reserved' THEN RETURN jsonb_build_object('should_create',false,'release',to_jsonb(r)-'claim_token');END IF;
 UPDATE public.shrigma_journey_template_release_v1 SET state='creating',claim_token=gen_random_uuid() WHERE id=p_id RETURNING * INTO r;
 RETURN jsonb_build_object('should_create',true,'release',to_jsonb(r));
END $f$;

CREATE OR REPLACE FUNCTION public.shrigma_journey_template_confirm_v1(p_id uuid,p_claim uuid,p_clone integer,p_cache_target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $f$
DECLARE r public.shrigma_journey_template_release_v1%ROWTYPE;t jsonb;
BEGIN
 SELECT * INTO STRICT r FROM public.shrigma_journey_template_release_v1 WHERE id=p_id FOR UPDATE;
 IF r.claim_token IS DISTINCT FROM p_claim OR r.cache_target IS DISTINCT FROM p_cache_target OR r.state='reserved' THEN RAISE EXCEPTION 'JOURNEY_RELEASE_CLAIM_MISMATCH';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.templates'::regclass AND tgname='shrigma_journey_template_guard_v1'
  AND tgfoid='public.shrigma_journey_template_guard_v1()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'JOURNEY_TEMPLATE_GUARD_UNAVAILABLE';END IF;
 SELECT to_jsonb(x) INTO t FROM public.templates x WHERE x.id=p_clone AND x.name=r.clone_name FOR SHARE;
 IF t IS NULL OR public.shrigma_journey_template_content_v1(t) IS DISTINCT FROM r.snapshot OR (t->>'is_default')::boolean
  OR EXISTS(SELECT 1 FROM public.shrigma_template_email_registry WHERE template_id=p_clone) THEN RAISE EXCEPTION 'JOURNEY_RELEASE_CLONE_MISMATCH';END IF;
 IF r.state='ready' THEN
  IF r.clone_template_id IS DISTINCT FROM p_clone THEN RAISE EXCEPTION 'JOURNEY_RELEASE_CLONE_MISMATCH';END IF;
 ELSE
  UPDATE public.shrigma_journey_template_release_v1 SET state='ready',clone_template_id=p_clone,cache_ack_at=clock_timestamp() WHERE id=p_id RETURNING * INTO r;
 END IF;
 RETURN to_jsonb(r)-'claim_token';
END $f$;

REVOKE ALL ON public.shrigma_journey_template_release_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shrigma_journey_template_content_v1(jsonb),public.shrigma_journey_template_guard_v1(),
 public.shrigma_journey_template_catalog_guard_v1(),public.shrigma_journey_template_release_guard_v1(),public.shrigma_journey_template_prepare_v1(integer,text),
 public.shrigma_journey_template_begin_v1(uuid,text),public.shrigma_journey_template_confirm_v1(uuid,uuid,integer,text) FROM PUBLIC;
COMMIT;
