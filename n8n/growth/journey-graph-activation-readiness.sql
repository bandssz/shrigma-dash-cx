-- Shadow status only. No activation, epoch, clone or worker approval writes.
-- Caller installs this fragment atomically while graph execution is OFF.
DO $install$ BEGIN
 IF EXISTS(SELECT 1 FROM crm_graph_candidate.control WHERE enabled)
 OR to_regclass('crm_graph_candidate.lifecycle_publication_v1') IS NULL
 OR to_regprocedure('crm_graph_candidate.graph_worker_readiness_v1()') IS NULL
 OR to_regprocedure('crm_graph_candidate.lifecycle_activation_readiness_v1(uuid,text,integer,integer,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'GRAPH_READINESS_DEPENDENCY_OR_COLLISION';END IF;
END $install$;
CREATE FUNCTION crm_graph_candidate.lifecycle_activation_readiness_v1(jid uuid,b text,v integer,rev integer,h text)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE j crm_graph_candidate.journey%ROWTYPE;r crm_graph_candidate.revision%ROWTYPE;
 p crm_graph_candidate.lifecycle_publication_v1%ROWTYPE;worker jsonb;cache jsonb;native jsonb;message jsonb;
 blockers jsonb:='[]'::jsonb;at timestamptz;target text;conflict boolean;opened boolean;
BEGIN
 IF jid IS NULL OR b IS NULL OR b NOT IN('fish','aristo') OR v IS NULL OR v<1 OR rev IS NULL OR rev<1 OR h IS NULL OR h!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_INPUT';END IF;
 SELECT * INTO j FROM crm_graph_candidate.journey WHERE id=jid AND brand=b;
 SELECT * INTO p FROM crm_graph_candidate.lifecycle_publication_v1 WHERE journey_id=jid AND brand=b AND published_revision=rev AND publication_hash=h;
 IF j.id IS NULL OR p.request_id IS NULL OR j.version IS DISTINCT FROM v OR j.published_revision IS DISTINCT FROM rev OR j.head_revision IS DISTINCT FROM rev OR j.paused IS DISTINCT FROM true THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_DRIFT';END IF;
 SELECT * INTO STRICT r FROM crm_graph_candidate.revision WHERE journey_id=jid AND brand=b AND revision=rev;
 IF r.content_hash IS DISTINCT FROM p.publication->>'content_hash' THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_DRIFT';END IF;
 IF NOT EXISTS(SELECT 1 FROM crm_graph_candidate.control WHERE singleton AND enabled) THEN blockers:=blockers||'"graph_control_off"'::jsonb;END IF;
 IF to_regclass('crm_maintenance_candidate.control') IS NULL THEN blockers:=blockers||'"maintenance_closed"'::jsonb;
 ELSE EXECUTE 'SELECT EXISTS(SELECT 1 FROM crm_maintenance_candidate.control WHERE singleton AND enabled AND mode=''open'')' INTO opened;
  IF NOT opened THEN blockers:=blockers||'"maintenance_closed"'::jsonb;END IF;
 END IF;
 worker:=crm_graph_candidate.graph_worker_readiness_v1();target:=worker#>>'{pins,cache_target}';
 IF worker->>'contract' IS DISTINCT FROM 'journey_graph_worker_readiness_v1' OR worker->>'activation_ready' IS DISTINCT FROM 'false' OR worker->>'authorizes_activate' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'GRAPH_PUBLICATION_READINESS_INVALID';END IF;
 IF worker->'blockers' ? 'deployment_off' THEN blockers:=blockers||'"worker_deployment_off"'::jsonb;
 ELSIF worker->>'state' IS DISTINCT FROM 'executor_ready' THEN blockers:=blockers||'"worker_unavailable"'::jsonb;END IF;
 IF target IS NULL OR to_regprocedure('crm_graph_candidate.cache_identity_readiness_v1(text)') IS NULL THEN
  blockers:=blockers||'"cache_identity_unverified"'::jsonb;
 ELSE
  EXECUTE 'SELECT crm_graph_candidate.cache_identity_readiness_v1($1)' INTO cache USING target;
  IF cache->>'contract' IS DISTINCT FROM 'journey_graph_cache_readiness_v1'
     OR cache->>'cache_target' IS DISTINCT FROM target OR cache->>'ready' IS DISTINCT FROM 'true' THEN
    blockers:=blockers||'"cache_identity_unverified"'::jsonb;
  END IF;
 END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(r.definition->'nodes') n WHERE n->>'type'='message')<>1
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.definition->'nodes') n WHERE n->>'type'='trigger' AND n->>'event'='cart.abandoned') THEN blockers:=blockers||'"scope_not_supported"'::jsonb;
 ELSE
  SELECT x INTO message FROM jsonb_array_elements(r.catalog->'messages') x WHERE x->>'key'=(SELECT n->>'binding' FROM jsonb_array_elements(r.definition->'nodes') n WHERE n->>'type'='message');
  IF message->>'brand' IS DISTINCT FROM b OR message->>'channel' IS DISTINCT FROM 'email' OR message#>>'{material,version}' IS DISTINCT FROM 'cart_email_material_v2' OR message#>>'{material,release_id}' IS DISTINCT FROM p.publication->>'release_id' THEN blockers:=blockers||'"scope_not_supported"'::jsonb;
  ELSIF target IS NULL OR to_regprocedure('crm_graph_candidate.native_resolve_v1(text,uuid,text,text)') IS NULL THEN blockers:=blockers||'"native_clone_not_ready"'::jsonb;
  ELSE
   BEGIN
    EXECUTE 'SELECT crm_graph_candidate.native_resolve_v1($1,$2,$3,$4)' INTO native USING b,(message#>>'{material,release_id}')::uuid,message#>>'{material,material_sha256}',target;
    IF native->>'state' IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'GRAPH_NATIVE_NOT_READY';END IF;
   EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT IN('GRAPH_NATIVE_NOT_READY','GRAPH_NATIVE_CLONE_MISMATCH','GRAPH_NATIVE_GUARD_MISMATCH') THEN RAISE;END IF;
    blockers:=blockers||'"native_clone_not_ready"'::jsonb;
   END;
  END IF;
 END IF;
 IF to_regclass('crm_graph_candidate.cart_epoch_v1') IS NULL OR to_regclass('crm_graph_candidate.cart_control_v1') IS NULL THEN blockers:=blockers||'"execution_runtime_missing"'::jsonb;
 ELSE EXECUTE 'SELECT EXISTS(SELECT 1 FROM crm_graph_candidate.cart_epoch_v1 WHERE brand=$1 AND ends_at IS NULL)' INTO conflict USING b;
  IF conflict THEN blockers:=blockers||'"epoch_conflict"'::jsonb;END IF;
 END IF;
 at:=clock_timestamp();
 RETURN jsonb_build_object('contract','journey_graph_activation_readiness_v1','state','blocked','brand',b,'journey_id',jid,'version',v,'published_revision',rev,'publication_hash',h,
  'checked_at',at,'expires_at',at+interval '30 seconds','blockers',blockers,'authorizes_activate',false,'authorizes_enrollment',false,'authorizes_send',false);
END $fn$;
REVOKE ALL ON FUNCTION crm_graph_candidate.lifecycle_activation_readiness_v1(uuid,text,integer,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_graph_candidate.lifecycle_activation_readiness_v1(uuid,text,integer,integer,text) TO crm_audience_api;
