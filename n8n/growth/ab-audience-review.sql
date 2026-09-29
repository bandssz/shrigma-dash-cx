-- Fresh local shadow candidate. Trusted JS service, no public RPC or grants.
-- Existing scope, assignment, native-campaign and transport guards stay intact.
DO $ab_audience_review_install$
BEGIN
 IF pg_catalog.to_regclass('crm_audience_v2.ab_scope') IS NULL
 OR pg_catalog.to_regclass('crm_audience_v2.ab_request') IS NULL
 OR pg_catalog.to_regclass('public.crm_ab_experiment_v2') IS NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.append_only()') IS NULL THEN
  RAISE EXCEPTION 'AB_AUDIENCE_REVIEW_DEPENDENCY';
 END IF;
 IF pg_catalog.to_regclass('crm_audience_v2.ab_review') IS NOT NULL
 OR pg_catalog.to_regclass('crm_audience_v2.ab_review_request') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.ab_review_guard()') IS NOT NULL THEN
  RAISE EXCEPTION 'AB_AUDIENCE_REVIEW_INSTALL_COLLISION';
 END IF;
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 CREATE TABLE crm_audience_v2.ab_review (
  review_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
  review_id uuid PRIMARY KEY,
  test_id uuid NOT NULL REFERENCES crm_audience_v2.ab_scope(test_id),
  brand text NOT NULL CHECK(brand IN('fish','aristo')),
  actor text NOT NULL CHECK(actor ~ '^panel:[A-Za-z0-9_.:-]{1,194}$'),
  evidence jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(evidence)='object' AND pg_catalog.octet_length(evidence::text)<=262144),
  evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
 );
 CREATE INDEX ab_review_head ON crm_audience_v2.ab_review(test_id,brand,review_sequence DESC);
 CREATE TABLE crm_audience_v2.ab_review_request (
  actor text NOT NULL CHECK(actor ~ '^panel:[A-Za-z0-9_.:-]{1,194}$'),
  operation_key uuid NOT NULL,
  brand text NOT NULL CHECK(brand IN('fish','aristo')),
  payload jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(payload)='object' AND pg_catalog.octet_length(payload::text)<=20000),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK(pg_catalog.jsonb_typeof(response)='object' AND pg_catalog.octet_length(response::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(actor,operation_key)
 );
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.ab_review_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE e public.crm_ab_experiment_v2%ROWTYPE;s crm_audience_v2.ab_scope%ROWTYPE;r jsonb;a jsonb;pin jsonb;confirmed boolean;
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'AB_AUDIENCE_REVIEW_ISOLATION';END IF;
  -- The service acquired this row before campaigns/definitions/members. This
  -- repeat is a validation, not a different lock order or a send authorization.
  SELECT * INTO e FROM public.crm_ab_experiment_v2 WHERE test_id=NEW.test_id AND brand=NEW.brand FOR UPDATE;
  SELECT * INTO s FROM crm_audience_v2.ab_scope WHERE test_id=NEW.test_id AND brand=NEW.brand;
  IF e.test_id IS NULL OR s.test_id IS NULL OR e.state<>'prepared' OR e.transport_bound OR e.source_complete THEN RAISE EXCEPTION 'AB_AUDIENCE_REVIEW_STATE';END IF;
  r:=NEW.evidence->'review';
  IF jsonb_typeof(NEW.evidence) IS DISTINCT FROM 'object'
   OR NOT(NEW.evidence ?& ARRAY['contract','review','protocol_hash','scope','source_snapshot_hash','allocation_fingerprint'])
   OR NEW.evidence-ARRAY['contract','review','protocol_hash','scope','source_snapshot_hash','allocation_fingerprint']<>'{}'::jsonb
   OR NEW.evidence->>'contract' IS DISTINCT FROM 'crm-ab-audience-review-v1'
   OR NEW.evidence->'scope' IS DISTINCT FROM s.scope
   OR coalesce(NEW.evidence->>'protocol_hash','') !~ '^[a-f0-9]{64}$'
   OR coalesce(NEW.evidence->>'source_snapshot_hash','') !~ '^[a-f0-9]{64}$'
   OR (NEW.evidence->'allocation_fingerprint'<>'null'::jsonb AND coalesce(NEW.evidence->>'allocation_fingerprint','') !~ '^[a-f0-9]{64}$')
   OR jsonb_typeof(r) IS DISTINCT FROM 'object'
   OR NOT(r ?& ARRAY['review_id','test_id','brand','experiment_version','scope_hash','cohort_hash','status','reason','checked_at','expires_at','arms','minimum_reached','eligible_fingerprint','snapshot_only'])
   OR r-ARRAY['review_id','test_id','brand','experiment_version','scope_hash','cohort_hash','status','reason','checked_at','expires_at','arms','minimum_reached','eligible_fingerprint','snapshot_only']<>'{}'::jsonb
   OR r->>'review_id' IS DISTINCT FROM NEW.review_id::text OR r->>'test_id' IS DISTINCT FROM NEW.test_id::text
   OR r->>'brand' IS DISTINCT FROM NEW.brand OR r->'experiment_version' IS DISTINCT FROM to_jsonb(e.version)
   OR r->>'scope_hash' IS DISTINCT FROM s.scope_hash OR r->>'cohort_hash' IS DISTINCT FROM s.cohort_hash
   OR r->'snapshot_only' IS DISTINCT FROM 'true'::jsonb OR coalesce(r->>'status','') NOT IN('confirmed','unavailable')
   OR jsonb_typeof(r->'arms') IS DISTINCT FROM 'array'
   OR coalesce(r->>'checked_at','') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
   OR coalesce(r->>'expires_at','') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
  THEN RAISE EXCEPTION 'AB_AUDIENCE_REVIEW_EVIDENCE';END IF;
  confirmed:=r->>'status'='confirmed';
  IF jsonb_array_length(r->'arms')<>2 OR r#>>'{arms,0,arm}' IS DISTINCT FROM 'a' OR r#>>'{arms,1,arm}' IS DISTINCT FROM 'b'
   OR (r->>'checked_at')::timestamptz>clock_timestamp()
   OR confirmed AND (r->'reason' IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(r->'minimum_reached') IS DISTINCT FROM 'boolean'
    OR coalesce(r->>'eligible_fingerprint','') !~ '^[a-f0-9]{64}$' OR NEW.evidence->'allocation_fingerprint'='null'::jsonb
    OR (r->>'expires_at')::timestamptz<=clock_timestamp() OR (r->>'expires_at')::timestamptz>(r->>'checked_at')::timestamptz+interval '5 minutes')
   OR NOT confirmed AND (r->>'expires_at' IS DISTINCT FROM r->>'checked_at' OR r->'minimum_reached' IS DISTINCT FROM 'null'::jsonb OR r->'eligible_fingerprint' IS DISTINCT FROM 'null'::jsonb
    OR coalesce(r->>'reason','') NOT IN('source_unavailable','source_expired','audience_archived','context_changed','list_source_unavailable','external_source_unavailable','allocation_unavailable','allocation_changed','allocation_malformed'))
  THEN RAISE EXCEPTION 'AB_AUDIENCE_REVIEW_EVIDENCE';END IF;
  FOR a IN SELECT value FROM jsonb_array_elements(r->'arms') LOOP
   SELECT value INTO pin FROM jsonb_array_elements(s.scope->'bindings') WHERE value->>'arm'=a->>'arm';
   IF NOT(a ?& ARRAY['arm','campaign_id','allocated','eligible','excluded','revoked','missing'])
    OR a-ARRAY['arm','campaign_id','allocated','eligible','excluded','revoked','missing']<>'{}'::jsonb
    OR a->'campaign_id' IS DISTINCT FROM pin->'campaign_id' OR jsonb_typeof(a->'allocated') IS DISTINCT FROM 'number'
    OR coalesce(a->>'allocated','') !~ '^[1-9][0-9]{0,4}$' OR (a->>'allocated')::integer>50000
    OR NOT confirmed AND (a->'eligible' IS DISTINCT FROM 'null'::jsonb OR a->'excluded' IS DISTINCT FROM 'null'::jsonb OR a->'revoked' IS DISTINCT FROM 'null'::jsonb OR a->'missing' IS DISTINCT FROM 'null'::jsonb)
   THEN RAISE EXCEPTION 'AB_AUDIENCE_REVIEW_EVIDENCE';END IF;
   IF confirmed THEN
    IF EXISTS(SELECT 1 FROM jsonb_each(a) kv WHERE key IN('eligible','excluded','revoked','missing') AND (jsonb_typeof(value)<>'number' OR value::text !~ '^(0|[1-9][0-9]{0,5})$'))
     OR (a->>'eligible')::integer+(a->>'excluded')::integer<>(a->>'allocated')::integer
     OR (a->>'revoked')::integer+(a->>'missing')::integer>(a->>'excluded')::integer
    THEN RAISE EXCEPTION 'AB_AUDIENCE_REVIEW_EVIDENCE';END IF;
   END IF;
  END LOOP;
  RETURN NEW;
 END $fn$$ddl$;
 CREATE TRIGGER ab_review_insert_guard BEFORE INSERT ON crm_audience_v2.ab_review FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.ab_review_guard();
 CREATE TRIGGER ab_review_append_only BEFORE UPDATE OR DELETE ON crm_audience_v2.ab_review FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
 CREATE TRIGGER ab_review_request_append_only BEFORE UPDATE OR DELETE ON crm_audience_v2.ab_review_request FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
 REVOKE ALL ON crm_audience_v2.ab_review,crm_audience_v2.ab_review_request FROM PUBLIC;
 REVOKE ALL ON SEQUENCE crm_audience_v2.ab_review_review_sequence_seq FROM PUBLIC;
 REVOKE ALL ON FUNCTION crm_audience_v2.ab_review_guard() FROM PUBLIC;
END $ab_audience_review_install$;
