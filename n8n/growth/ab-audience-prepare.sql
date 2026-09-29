-- Fresh local candidate only. No public RPC, grants, activation or native writes.
DO $ab_audience_install$
BEGIN
 IF pg_catalog.to_regclass('public.crm_ab_experiment_v2') IS NULL
 OR pg_catalog.to_regclass('public.crm_ab_arm_v2') IS NULL
 OR pg_catalog.to_regclass('public.crm_ab_member_v2') IS NULL
 OR pg_catalog.to_regclass('public.crm_ab_action_v2') IS NULL
 OR pg_catalog.to_regclass('crm_audience_v2.campaign_binding') IS NULL
 OR pg_catalog.to_regclass('crm_audience_v2.campaign_binding_revision') IS NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.append_only()') IS NULL THEN
  RAISE EXCEPTION 'AB_AUDIENCE_DEPENDENCY';
 END IF;
 IF pg_catalog.to_regclass('crm_audience_v2.ab_scope') IS NOT NULL
 OR pg_catalog.to_regclass('crm_audience_v2.ab_request') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='crm_audience_v2' AND p.proname IN('ab_scope_guard','ab_scope_complete','ab_binding_guard','ab_experiment_guard','ab_assignment_guard')) THEN
  RAISE EXCEPTION 'AB_AUDIENCE_INSTALL_COLLISION';
 END IF;
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 CREATE TABLE crm_audience_v2.ab_scope (
  test_id uuid PRIMARY KEY REFERENCES public.crm_ab_experiment_v2(test_id),
  brand text NOT NULL CHECK(brand IN('fish','aristo')),
  scope jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(scope)='object' AND pg_catalog.octet_length(scope::text)<=131072),
  scope_hash text NOT NULL CHECK(scope_hash ~ '^[0-9a-f]{64}$'),
  cohort_hash text NOT NULL CHECK(cohort_hash ~ '^[0-9a-f]{64}$'),
  actor text NOT NULL CHECK(actor ~ '^panel:[A-Za-z0-9_.:-]{1,194}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  created_xid xid8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id()
 );
 CREATE TABLE crm_audience_v2.ab_request (
  actor text NOT NULL CHECK(actor ~ '^panel:[A-Za-z0-9_.:-]{1,194}$'),
  operation_key uuid NOT NULL,
  brand text NOT NULL CHECK(brand IN('fish','aristo')),
  payload jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(payload)='object' AND pg_catalog.octet_length(payload::text)<=131072),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(response)='object' AND pg_catalog.octet_length(response::text)<=262144),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(actor,operation_key)
 );
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.ab_scope_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE e public.crm_ab_experiment_v2%ROWTYPE;b crm_audience_v2.campaign_binding%ROWTYPE;
  pin jsonb;row_xid text;ids integer[];
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'AB_AUDIENCE_ISOLATION';END IF;
  NEW.created_xid:=pg_current_xact_id();
  IF NOT(NEW.scope ?& ARRAY['contract','test_id','brand','audience_id','audience_revision','definition','definition_hash','context','context_hash','base_list_id','catalog_hash','bindings'])
   OR NEW.scope-ARRAY['contract','test_id','brand','audience_id','audience_revision','definition','definition_hash','context','context_hash','base_list_id','catalog_hash','bindings']<>'{}'::jsonb
   OR NEW.scope->>'contract' IS DISTINCT FROM 'crm-ab-audience-scope-v1'
   OR NEW.scope->>'test_id' IS DISTINCT FROM NEW.test_id::text OR NEW.scope->>'brand' IS DISTINCT FROM NEW.brand
   OR jsonb_typeof(NEW.scope->'bindings') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'AB_AUDIENCE_SCOPE';END IF;
  IF jsonb_array_length(NEW.scope->'bindings')<>2 OR NEW.scope#>>'{bindings,0,arm}' IS DISTINCT FROM 'a'
   OR NEW.scope#>>'{bindings,1,arm}' IS DISTINCT FROM 'b'
   OR NEW.scope#>'{bindings,0,campaign_id}' IS NOT DISTINCT FROM NEW.scope#>'{bindings,1,campaign_id}'
   OR jsonb_typeof(NEW.scope->'audience_revision') IS DISTINCT FROM 'number'
   OR jsonb_typeof(NEW.scope->'base_list_id') IS DISTINCT FROM 'number'
   OR coalesce(NEW.scope->>'catalog_hash','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'AB_AUDIENCE_SCOPE';END IF;
  FOR pin IN SELECT value FROM jsonb_array_elements(NEW.scope->'bindings') LOOP
   IF NOT(pin ?& ARRAY['arm','campaign_id','binding_version','binding_hash','campaign_version'])
    OR pin-ARRAY['arm','campaign_id','binding_version','binding_hash','campaign_version']<>'{}'::jsonb
    OR jsonb_typeof(pin->'campaign_id') IS DISTINCT FROM 'number' OR coalesce(pin->>'campaign_id','') !~ '^[1-9][0-9]{0,9}$'
    OR (pin->>'campaign_id')::numeric>2147483647 OR jsonb_typeof(pin->'binding_version') IS DISTINCT FROM 'number'
    OR coalesce(pin->>'binding_version','') !~ '^[1-9][0-9]{0,8}$'
    OR coalesce(pin->>'binding_hash','') !~ '^[0-9a-f]{64}$' OR coalesce(pin->>'campaign_version','') !~ '^[0-9a-f]{32}$'
   THEN RAISE EXCEPTION 'AB_AUDIENCE_SCOPE';END IF;
  END LOOP;
  SELECT * INTO e FROM public.crm_ab_experiment_v2 WHERE test_id=NEW.test_id FOR UPDATE;
  SELECT xmin::text INTO row_xid FROM public.crm_ab_experiment_v2 WHERE test_id=NEW.test_id;
  -- A new/touched experiment row is the MVCC barrier for snapshots older than
  -- scope admission. The application inserts it in this same transaction.
  IF e.test_id IS NULL OR e.brand IS DISTINCT FROM NEW.brand OR e.state<>'prepared' OR e.transport_bound
   OR e.version<>1 OR e.window_start IS NOT NULL OR e.window_end IS NOT NULL
   OR row_xid IS DISTINCT FROM mod(pg_current_xact_id()::text::numeric,4294967296)::text
   OR e.protocol->>'test_id' IS DISTINCT FROM NEW.test_id::text OR e.protocol->>'brand' IS DISTINCT FROM NEW.brand
   OR NOT public.crm_ab_protocol_valid_v2(e.protocol)
   OR EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 WHERE test_id=NEW.test_id)
  THEN RAISE EXCEPTION 'AB_AUDIENCE_EXPERIMENT';END IF;
  SELECT array_agg((value->>'campaign_id')::integer ORDER BY (value->>'campaign_id')::integer) INTO ids FROM jsonb_array_elements(NEW.scope->'bindings');
  PERFORM campaign_id FROM crm_audience_v2.campaign_binding WHERE campaign_id=ANY(ids) ORDER BY campaign_id FOR SHARE;
  FOR pin IN SELECT value FROM jsonb_array_elements(NEW.scope->'bindings') LOOP
   SELECT * INTO b FROM crm_audience_v2.campaign_binding WHERE campaign_id=(pin->>'campaign_id')::integer;
   IF b.campaign_id IS NULL OR b.brand IS DISTINCT FROM NEW.brand
    OR b.binding_version IS DISTINCT FROM (pin->>'binding_version')::integer OR b.binding_hash IS DISTINCT FROM pin->>'binding_hash'
    OR b.campaign_version IS DISTINCT FROM pin->>'campaign_version'
    OR b.audience_id::text IS DISTINCT FROM NEW.scope->>'audience_id' OR to_jsonb(b.audience_revision) IS DISTINCT FROM NEW.scope->'audience_revision'
    OR b.definition_hash IS DISTINCT FROM NEW.scope->>'definition_hash' OR b.context_hash IS DISTINCT FROM NEW.scope->>'context_hash'
    OR to_jsonb(b.base_list_id) IS DISTINCT FROM NEW.scope->'base_list_id'
    OR b.binding->'definition' IS DISTINCT FROM NEW.scope->'definition' OR b.binding->'context' IS DISTINCT FROM NEW.scope->'context'
    OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding_revision h WHERE h.campaign_id=b.campaign_id AND h.binding_version=b.binding_version AND h.binding=b.binding AND h.binding_hash=b.binding_hash)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.protocol->'arms') a WHERE a->>'arm'=pin->>'arm' AND a->'campaign_id'=pin->'campaign_id' AND a->>'expected_version'=b.campaign_version)
    OR e.source_list_ids IS DISTINCT FROM ARRAY[b.base_list_id]
   THEN RAISE EXCEPTION 'AB_AUDIENCE_BINDING_CHANGED';END IF;
  END LOOP;
  RETURN NEW;
 END $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.ab_binding_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 BEGIN
  -- The existing binder uses RC. Reject old RR snapshots even if they cannot
  -- see a just-committed scope; no GUC can bypass this new-table boundary.
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'AB_AUDIENCE_ISOLATION';END IF;
  IF EXISTS(SELECT 1 FROM crm_audience_v2.ab_scope s JOIN public.crm_ab_experiment_v2 e USING(test_id)
   WHERE e.brand=OLD.brand AND e.state IN('prepared','scheduled') AND s.scope->'bindings' @> jsonb_build_array(jsonb_build_object('campaign_id',OLD.campaign_id)))
  THEN RAISE EXCEPTION 'AB_AUDIENCE_BINDING_FROZEN';END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.ab_experiment_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.ab_scope WHERE test_id=OLD.test_id) THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AB_AUDIENCE_SCOPE_IMMUTABLE';END IF;
  IF NEW.state='scheduled' OR NEW.transport_bound THEN RAISE EXCEPTION 'AB_AUDIENCE_SHADOW_ONLY';END IF;
  IF (to_jsonb(NEW)-ARRAY['state','version','window_start','window_end','transport_bound','tracking_continuous','source_complete','transport_interrupted_at','transport_interruption'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','window_start','window_end','transport_bound','tracking_continuous','source_complete','transport_interrupted_at','transport_interruption'])
  THEN RAISE EXCEPTION 'AB_AUDIENCE_SCOPE_IMMUTABLE';END IF;
  RETURN NEW;
 END $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.ab_assignment_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE s crm_audience_v2.ab_scope%ROWTYPE;tid uuid;old_scoped boolean:=false;pin jsonb;
 BEGIN
  -- A stale RR snapshot must never treat newly scoped assignments as legacy.
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'AB_AUDIENCE_ISOLATION';END IF;
  IF TG_OP<>'INSERT' THEN SELECT EXISTS(SELECT 1 FROM crm_audience_v2.ab_scope WHERE test_id=OLD.test_id) INTO old_scoped;END IF;
  tid:=CASE WHEN TG_OP='DELETE' THEN OLD.test_id ELSE NEW.test_id END;
  SELECT * INTO s FROM crm_audience_v2.ab_scope WHERE test_id=tid;
  IF TG_TABLE_NAME='crm_ab_arm_v2' THEN
   IF TG_OP='INSERT' AND s.test_id IS NULL
    AND EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding WHERE campaign_id=NEW.campaign_id)
   THEN RAISE EXCEPTION 'AB_AUDIENCE_SCOPE_REQUIRED';END IF;
  END IF;
  IF s.test_id IS NULL AND NOT old_scoped THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
  IF TG_OP='DELETE' OR s.test_id IS NULL THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT_IMMUTABLE';END IF;
  IF TG_TABLE_NAME='crm_ab_arm_v2' THEN
   IF s.created_xid<>pg_current_xact_id() THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT_IMMUTABLE';END IF;
   IF TG_OP='UPDATE' AND (to_jsonb(OLD)-'allocated_count') IS DISTINCT FROM (to_jsonb(NEW)-'allocated_count') THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT_IMMUTABLE';END IF;
   SELECT value INTO pin FROM jsonb_array_elements(s.scope->'bindings') WHERE value->>'arm'=NEW.arm;
   IF pin IS NULL OR pin->'campaign_id' IS DISTINCT FROM to_jsonb(NEW.campaign_id) OR pin->>'campaign_version' IS DISTINCT FROM NEW.campaign_version
    OR NEW.list_id IS NOT NULL OR NEW.finished_at IS NOT NULL OR NEW.transport_interrupted_at IS NOT NULL
   THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT';END IF;
  ELSE
   IF TG_OP='INSERT' THEN
    IF s.created_xid<>pg_current_xact_id() OR NEW.revoked_at IS NOT NULL OR NEW.revoked_reason IS NOT NULL THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT_IMMUTABLE';END IF;
   ELSE
    IF (to_jsonb(OLD)-ARRAY['revoked_at','revoked_reason']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['revoked_at','revoked_reason'])
     OR NEW.revoked_at IS NULL OR OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason)
    THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT_IMMUTABLE';END IF;
   END IF;
  END IF;
  RETURN NEW;
 END $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.ab_scope_complete() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE e public.crm_ab_experiment_v2%ROWTYPE;n integer;actual_hash text;
 BEGIN
  SELECT * INTO e FROM public.crm_ab_experiment_v2 WHERE test_id=NEW.test_id;
  SELECT count(*)::integer,encode(sha256(convert_to('['||coalesce(string_agg(subscriber_id::text,',' ORDER BY subscriber_id),'')||']','UTF8')),'hex')
   INTO n,actual_hash FROM public.crm_ab_member_v2 WHERE test_id=NEW.test_id;
  IF n<2 OR n>100000 OR actual_hash IS DISTINCT FROM NEW.cohort_hash
   OR (SELECT count(*) FROM public.crm_ab_arm_v2 WHERE test_id=NEW.test_id)<>2
   OR EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 a WHERE a.test_id=NEW.test_id AND a.allocated_count<>(SELECT count(*) FROM public.crm_ab_member_v2 m WHERE m.test_id=a.test_id AND m.arm=a.arm))
   OR EXISTS(SELECT 1 FROM public.crm_ab_member_v2 WHERE test_id=NEW.test_id AND revoked_at IS NOT NULL)
   OR EXISTS(SELECT 1 FROM (SELECT arm,CASE WHEN row_number() OVER(ORDER BY sha256(convert_to(e.seed::text||':'||subscriber_id::text,'UTF8')),subscriber_id)<=floor(n/2.0) THEN 'a' ELSE 'b' END expected FROM public.crm_ab_member_v2 WHERE test_id=NEW.test_id) assignments WHERE arm<>expected)
  THEN RAISE EXCEPTION 'AB_AUDIENCE_COHORT_UNCONFIRMED';END IF;
  RETURN NEW;
 END $fn$$ddl$;
 CREATE TRIGGER ab_scope_insert_guard BEFORE INSERT ON crm_audience_v2.ab_scope FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.ab_scope_guard();
 CREATE TRIGGER ab_scope_append_only BEFORE UPDATE OR DELETE ON crm_audience_v2.ab_scope FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
 CREATE TRIGGER ab_request_append_only BEFORE UPDATE OR DELETE ON crm_audience_v2.ab_request FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
 CREATE CONSTRAINT TRIGGER ab_scope_complete AFTER INSERT ON crm_audience_v2.ab_scope DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.ab_scope_complete();
 CREATE TRIGGER a_ab_audience_binding_guard BEFORE UPDATE OR DELETE ON crm_audience_v2.campaign_binding FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.ab_binding_guard();
 CREATE TRIGGER ab_audience_experiment_guard BEFORE UPDATE OR DELETE ON public.crm_ab_experiment_v2 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.ab_experiment_guard();
 CREATE TRIGGER ab_audience_arm_guard BEFORE INSERT OR UPDATE OR DELETE ON public.crm_ab_arm_v2 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.ab_assignment_guard();
 CREATE TRIGGER ab_audience_member_guard BEFORE INSERT OR UPDATE OR DELETE ON public.crm_ab_member_v2 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.ab_assignment_guard();
 REVOKE ALL ON crm_audience_v2.ab_scope,crm_audience_v2.ab_request FROM PUBLIC;
 REVOKE ALL ON FUNCTION crm_audience_v2.ab_scope_guard(),crm_audience_v2.ab_scope_complete(),crm_audience_v2.ab_binding_guard(),crm_audience_v2.ab_experiment_guard(),crm_audience_v2.ab_assignment_guard() FROM PUBLIC;
END $ab_audience_install$;
