-- Local regular-worker candidate. No activation, grants or schedule authority.
-- Runtime failure is a statement error: counts/cursor/status cannot commit as
-- if the audience were empty. Native eligibility alone may return false.
DO $regular_selection_install$
BEGIN
 IF pg_catalog.to_regprocedure('crm_audience_v2.selection_context(integer,text,boolean)') IS NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.selection_regular_context(integer)') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.selection_regular_matches(jsonb,integer)') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.selection_regular_rule_match(jsonb,integer[],integer,text)') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.selection_regular_ready(integer)') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.selection_regular_allowed(integer,integer)') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.selection_worker_context(integer)') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.selection_worker_allowed(integer,integer)') IS NOT NULL THEN
  RAISE EXCEPTION 'SEGMENT_REGULAR_SELECTION_DEPENDENCY_OR_COLLISION';
 END IF;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.selection_regular_context(cid integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE ctx jsonb;
 BEGIN
  ctx:=crm_audience_v2.selection_context(cid,'7abbff0c76a874e233f8cd6ae99c15b33632e34d1ac93b0b3ca337ed08868d9a',true);
  IF ctx IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
  IF ctx->'bound'='true'::jsonb THEN
   SELECT ctx||jsonb_build_object('list_ids',jsonb_agg(DISTINCT pin->'list_id'),
    'single_list_ids',coalesce(jsonb_agg(DISTINCT pin->'list_id') FILTER(WHERE pin->>'optin'='single'),'[]'::jsonb))
   INTO ctx FROM jsonb_array_elements(ctx->'list_pins') pin;
  END IF;
  RETURN ctx;
 END $fn$$ddl$;
 -- The whole tree and every list/opt-in were already checked in this statement's
 -- materialized context. Evaluate only membership here; no per-recipient hashes,
 -- catalog scans, source metadata reads or construction of pins are needed.
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.selection_regular_rule_match(rule jsonb,consented integer[],sid integer,brand text) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE child jsonb; matched boolean;
 BEGIN
  IF rule->>'op'='in_list' THEN RETURN (rule->>'list_id')::integer=ANY(consented); END IF;
  IF rule->>'op'='condition' THEN
   matched:=crm_audience_v2.selection_engagement_match(rule,sid,brand);
   IF matched IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
   RETURN matched;
  END IF;
  IF rule->>'op' NOT IN('and','or') OR rule->>'op' IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE';
  END IF;
  FOR child IN SELECT value FROM jsonb_array_elements(rule->'rules') LOOP
   matched:=crm_audience_v2.selection_regular_rule_match(child,consented,sid,brand);
   IF rule->>'op'='and' AND NOT matched THEN RETURN false; END IF;
   IF rule->>'op'='or' AND matched THEN RETURN true; END IF;
  END LOOP;
  RETURN rule->>'op'='and';
 END $fn$$ddl$;
 -- Worker queries materialize this validated context once per campaign and
 -- statement. It is never a stored authority or reusable consent snapshot.
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.selection_regular_matches(ctx jsonb,sid integer) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE consented integer[];
 BEGIN
  IF ctx IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
  IF ctx->'bound'='false'::jsonb THEN RETURN true; END IF;
  -- A real opt-out, disabled contact or expression non-match is ineligible;
  -- source/runtime/context failure above must never be represented as zero.
  IF NOT EXISTS(SELECT 1 FROM public.subscribers s WHERE s.id=sid AND s.status::text='enabled') THEN RETURN false; END IF;
  SELECT coalesce(array_agg(sl.list_id),ARRAY[]::integer[]) INTO consented FROM public.subscriber_lists sl
   WHERE sl.subscriber_id=sid AND ctx->'list_ids' @> to_jsonb(sl.list_id)
    AND (sl.status::text='confirmed' OR (sl.status::text='unconfirmed' AND ctx->'single_list_ids' @> to_jsonb(sl.list_id)));
  RETURN (ctx->>'base_list_id')::integer=ANY(consented)
   AND crm_audience_v2.selection_regular_rule_match(ctx#>'{definition,rule}',consented,sid,ctx->>'brand');
 END $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.selection_regular_ready(cid integer) RETURNS boolean
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
  SELECT crm_audience_v2.selection_regular_context(cid) IS NOT NULL
 $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.selection_regular_allowed(cid integer,sid integer) RETURNS boolean
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
  SELECT crm_audience_v2.selection_regular_matches(crm_audience_v2.selection_regular_context(cid),sid)
 $fn$$ddl$;
 REVOKE ALL ON FUNCTION crm_audience_v2.selection_regular_context(integer),crm_audience_v2.selection_regular_rule_match(jsonb,integer[],integer,text),crm_audience_v2.selection_regular_matches(jsonb,integer),crm_audience_v2.selection_regular_ready(integer),crm_audience_v2.selection_regular_allowed(integer,integer) FROM PUBLIC;
-- Separate pin for the native-worker candidate whose reads do not acknowledge
-- delivery. No runtime is enabled and no sender receives privileges here.
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.selection_worker_context(cid integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE ctx jsonb;
 BEGIN
  ctx:=crm_audience_v2.selection_context(cid,'084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d',true);
  IF ctx IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
  IF ctx->'bound'='true'::jsonb THEN
   SELECT ctx||jsonb_build_object('list_ids',jsonb_agg(DISTINCT pin->'list_id'),
    'single_list_ids',coalesce(jsonb_agg(DISTINCT pin->'list_id') FILTER(WHERE pin->>'optin'='single'),'[]'::jsonb))
   INTO ctx FROM jsonb_array_elements(ctx->'list_pins') pin;
  END IF;
  RETURN ctx;
 END $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.selection_worker_allowed(cid integer,sid integer) RETURNS boolean
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
  SELECT crm_audience_v2.selection_regular_matches(crm_audience_v2.selection_worker_context(cid),sid)
 $fn$$ddl$;
 REVOKE ALL ON FUNCTION crm_audience_v2.selection_worker_context(integer),crm_audience_v2.selection_worker_allowed(integer,integer) FROM PUBLIC;
END $regular_selection_install$;
