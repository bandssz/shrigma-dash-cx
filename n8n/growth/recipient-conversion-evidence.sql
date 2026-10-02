-- Shadow candidate: prospective claim identity for saved-audience campaigns.
-- Install/enable is a separate production operation. No historical backfill.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='20s';
DO $guard$
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
  OR coalesce(current_setting('shrigma.recipient_conversion.install_guard',true),'')!~'^[a-f0-9]{64}$'
  OR to_regclass('public.shrigma_email_dispatch') IS NULL
  OR to_regclass('public.crm_ab_arm_v2') IS NULL
  OR to_regclass('crm_audience_v2.shopify_customer_fact') IS NULL
  OR to_regclass('crm_audience_v2.shopify_identity') IS NULL
  OR to_regprocedure('crm_audience_v2.shopify_snapshot(text)') IS NULL
  OR to_regprocedure('crm_audience_v2.regular_delivery_claim(integer,integer,uuid,text,text,text,text,text,jsonb)') IS NULL
  OR to_regprocedure('public.shrigma_email_recipient_key(text)') IS NULL
  OR to_regprocedure('crm_audience_v2.campaign_binding_effective(integer)') IS NULL
  OR to_regnamespace('crm_email_conversion_candidate') IS NOT NULL THEN
  RAISE EXCEPTION 'RECIPIENT_CONVERSION_INSTALL_GUARD';
 END IF;
END
$guard$;
CREATE SCHEMA crm_email_conversion_candidate AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA crm_email_conversion_candidate FROM PUBLIC;
CREATE TABLE crm_email_conversion_candidate.capture_control_v1(
 brand text PRIMARY KEY CHECK(brand IN('fish','aristo')),
 enabled boolean NOT NULL DEFAULT false,
 coverage_started_at timestamptz,
 CHECK(NOT enabled OR (coverage_started_at IS NOT NULL AND isfinite(coverage_started_at)))
);
INSERT INTO crm_email_conversion_candidate.capture_control_v1(brand) VALUES('fish'),('aristo');
CREATE TABLE crm_email_conversion_candidate.claim_identity_v1(
 dispatch_id uuid PRIMARY KEY REFERENCES public.shrigma_email_dispatch(dispatch_id),
 brand text NOT NULL CHECK(brand IN('fish','aristo')),
 campaign_id integer NOT NULL CHECK(campaign_id>0),
 binding_version integer NOT NULL CHECK(binding_version>0),
 subscriber_id integer NOT NULL CHECK(subscriber_id>0),
 subscriber_uuid uuid,
 recipient_key text NOT NULL,
 recipient_key_version text NOT NULL,
 claim_sha256 text NOT NULL CHECK(claim_sha256~'^[a-f0-9]{64}$'),
 captured_at timestamptz NOT NULL CHECK(isfinite(captured_at)),
 started_at timestamptz NOT NULL CHECK(isfinite(started_at)),
 identity_state text NOT NULL CHECK(identity_state IN('confirmed','source_unavailable','identity_unresolved','recipient_mismatch')),
 customer_gid text,
 source_operation_id text,
 source_query_sha256 text,
 source_producer_revision text,
 source_provenance_sha256 text,
 source_observed_at timestamptz,
 source_expires_at timestamptz,
 CHECK((identity_state='confirmed')=(customer_gid IS NOT NULL)),
 CHECK(customer_gid IS NULL OR customer_gid~'^gid://shopify/Customer/[1-9][0-9]{0,24}$'),
 CHECK(identity_state<>'confirmed' OR (subscriber_uuid IS NOT NULL AND source_operation_id IS NOT NULL
  AND source_query_sha256~'^[a-f0-9]{64}$' AND source_provenance_sha256~'^[a-f0-9]{64}$'
  AND source_producer_revision IS NOT NULL AND source_observed_at IS NOT NULL
  AND source_expires_at IS NOT NULL AND isfinite(source_observed_at) AND isfinite(source_expires_at)
  AND source_observed_at<=captured_at AND captured_at<source_expires_at))
);
CREATE INDEX claim_identity_campaign_v1 ON crm_email_conversion_candidate.claim_identity_v1(brand,campaign_id);
REVOKE ALL ON ALL TABLES IN SCHEMA crm_email_conversion_candidate FROM PUBLIC;

CREATE FUNCTION crm_email_conversion_candidate.claim_hash_v1(d jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT encode(public.digest(convert_to((d-ARRAY['transport_state','outcome_at','accepted_at','send_log_id','error_code'])::text,'UTF8'),'sha256'),'hex')
$fn$;
REVOKE ALL ON FUNCTION crm_email_conversion_candidate.claim_hash_v1(jsonb) FROM PUBLIC;

CREATE FUNCTION crm_email_conversion_candidate.capture_claim_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
DECLARE ctl crm_email_conversion_candidate.capture_control_v1%ROWTYPE;
 cfg crm_audience_v2.shopify_source%ROWTYPE;fact crm_audience_v2.shopify_customer_fact%ROWTYPE;
 s public.subscribers%ROWTYPE;snap jsonb;parts jsonb;cid integer;sid integer;version integer;
 state text:='source_unavailable';gid text;native_key text;native_version text;at_time timestamptz;
 provenance text;observed timestamptz;expiry timestamptz;
BEGIN
 IF NEW.brand NOT IN('fish','aristo') OR NEW.brand IS NULL OR NEW.flow IS DISTINCT FROM 'campaign'
  OR NEW.is_test IS DISTINCT FROM false OR NEW.transport_state IS DISTINCT FROM 'in_flight'
  OR NEW.piece IS NULL OR NEW.piece!~'^audience-regular-v1:[1-9][0-9]{0,9}$'
  OR NEW.claim_token IS NULL OR NEW.started_at IS NULL OR NOT isfinite(NEW.started_at)
  OR NEW.recipient_key IS NULL OR NEW.recipient_key_version IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO ctl FROM crm_email_conversion_candidate.capture_control_v1 WHERE brand=NEW.brand FOR SHARE;
 IF NOT FOUND OR NOT ctl.enabled OR NEW.started_at<ctl.coverage_started_at THEN RETURN NULL;END IF;
 BEGIN parts:=NEW.dedupe_key::jsonb;
 EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;END;
 IF jsonb_typeof(parts) IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 IF jsonb_array_length(parts)<>3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(parts)x
  WHERE jsonb_typeof(x) IS DISTINCT FROM 'number' OR x::text!~'^[1-9][0-9]{0,9}$'
   OR (x::text)::numeric>2147483647) THEN RETURN NULL;END IF;
 cid:=(parts->>0)::integer;version:=(parts->>1)::integer;sid:=(parts->>2)::integer;
 IF NEW.piece IS DISTINCT FROM 'audience-regular-v1:'||cid::text THEN RETURN NULL;END IF;
 -- The native claim already owns this campaign FOR UPDATE. Take the same lock
 -- before inspecting assignment/binding, keeping the native lock order. A/B
 -- dispatches share this piece/dedupe format and must not enter regular coverage.
 PERFORM 1 FROM public.campaigns c WHERE c.id=cid AND c.status::text='running'
  AND c.attribs#>>'{crm,brand}'=NEW.brand FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 WHERE campaign_id=cid)
  OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding_effective(cid) b
   WHERE b.brand=NEW.brand AND b.binding_version=version) THEN RETURN NULL;END IF;
 SELECT * INTO s FROM public.subscribers WHERE id=sid FOR SHARE;
 IF FOUND THEN
  SELECT r.recipient_key,r.key_version INTO native_key,native_version FROM public.shrigma_email_recipient_key(s.email)r;
  IF native_key IS DISTINCT FROM NEW.recipient_key OR native_version IS DISTINCT FROM NEW.recipient_key_version THEN
   state:='recipient_mismatch';
  ELSE
   SELECT * INTO cfg FROM crm_audience_v2.shopify_source WHERE brand=NEW.brand FOR SHARE;
   IF FOUND AND cfg.enabled THEN
    snap:=crm_audience_v2.shopify_snapshot(NEW.brand);
    IF snap->'current'='true'::jsonb THEN
     SELECT x.* INTO fact FROM crm_audience_v2.shopify_customer_fact x
      JOIN crm_audience_v2.shopify_identity i ON i.brand=x.brand AND i.customer_gid=x.customer_gid
       AND i.subscriber_id=x.subscriber_id AND i.subscriber_uuid=x.subscriber_uuid AND i.email=x.email
      WHERE x.brand=NEW.brand AND x.operation_id=cfg.current_operation AND x.subscriber_id=sid
       AND x.subscriber_uuid=s.uuid AND x.identity_state='resolved' AND x.email=lower(btrim(s.email));
     state:='identity_unresolved';
     IF FOUND THEN
      SELECT b.provenance_sha256,b.observed_at,b.started_at+make_interval(secs=>cfg.max_age_seconds)
       INTO provenance,observed,expiry FROM crm_audience_v2.shopify_batch b
       WHERE b.brand=NEW.brand AND b.operation_id=cfg.current_operation AND b.status='ready';
      at_time:=clock_timestamp();
      IF FOUND AND provenance~'^[a-f0-9]{64}$' AND isfinite(observed) AND isfinite(expiry)
       AND observed<=at_time AND at_time<expiry THEN state:='confirmed';gid:=fact.customer_gid;
      ELSE state:='source_unavailable';END IF;
     END IF;
    END IF;
   END IF;
  END IF;
 ELSE state:='identity_unresolved';END IF;
 at_time:=clock_timestamp();
 -- Recheck the wall clock after every possible row-lock wait.
 IF state='confirmed' AND at_time>=expiry THEN state:='source_unavailable';gid:=NULL;END IF;
 INSERT INTO crm_email_conversion_candidate.claim_identity_v1(dispatch_id,brand,campaign_id,binding_version,
  subscriber_id,subscriber_uuid,recipient_key,recipient_key_version,claim_sha256,captured_at,started_at,
  identity_state,customer_gid,source_operation_id,source_query_sha256,source_producer_revision,
  source_provenance_sha256,source_observed_at,source_expires_at)
 VALUES(NEW.dispatch_id,NEW.brand,cid,version,sid,s.uuid,NEW.recipient_key,NEW.recipient_key_version,
  crm_email_conversion_candidate.claim_hash_v1(to_jsonb(NEW)),at_time,NEW.started_at,state,gid,
  CASE WHEN state='confirmed' THEN cfg.current_operation END,CASE WHEN state='confirmed' THEN cfg.query_sha256 END,
  CASE WHEN state='confirmed' THEN cfg.producer_revision END,CASE WHEN state='confirmed' THEN provenance END,
  CASE WHEN state='confirmed' THEN observed END,CASE WHEN state='confirmed' THEN expiry END);
 RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION crm_email_conversion_candidate.capture_claim_v1() FROM PUBLIC;
CREATE TRIGGER crm_conversion_capture_claim_v1 AFTER INSERT ON public.shrigma_email_dispatch
 FOR EACH ROW EXECUTE FUNCTION crm_email_conversion_candidate.capture_claim_v1();

CREATE FUNCTION crm_email_conversion_candidate.reject_claim_mutation_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'RECIPIENT_CONVERSION_IMMUTABLE';END
$fn$;
REVOKE ALL ON FUNCTION crm_email_conversion_candidate.reject_claim_mutation_v1() FROM PUBLIC;
CREATE TRIGGER crm_conversion_claim_immutable_v1 BEFORE UPDATE OR DELETE
 ON crm_email_conversion_candidate.claim_identity_v1 FOR EACH ROW
 EXECUTE FUNCTION crm_email_conversion_candidate.reject_claim_mutation_v1();

-- Owner-only coverage, not a conversion metric and not a public recipient API.
CREATE FUNCTION crm_email_conversion_candidate.accepted_coverage_v1(b text,cid integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE result jsonb;
BEGIN
 IF b IS NULL OR b NOT IN('fish','aristo') OR cid IS NULL OR cid<=0
  OR NOT EXISTS(SELECT 1 FROM public.campaigns c WHERE c.id=cid AND c.attribs#>>'{crm,brand}'=b)
  OR EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 WHERE campaign_id=cid) THEN
  RETURN jsonb_build_object('contract','crm-recipient-coverage-v1','brand',b,'campaign_id',cid,
   'coverage_available',false,'reason','campaign_scope_unavailable',
   'accepted_people',NULL,'mapped_people',NULL,'unknown_people',NULL,'authorizes_send',false);
 END IF;
 WITH accepted AS (
  SELECT d.recipient_key,d.recipient_key_version,
   e.identity_state='confirmed' AND e.claim_sha256=crm_email_conversion_candidate.claim_hash_v1(to_jsonb(d))
    AND e.brand=d.brand AND e.campaign_id=cid AND e.customer_gid IS NOT NULL
    AND e.captured_at<=d.accepted_at AS mapped
  FROM public.shrigma_email_dispatch d LEFT JOIN crm_email_conversion_candidate.claim_identity_v1 e USING(dispatch_id)
  WHERE b IN('fish','aristo') AND cid>0 AND d.brand=b AND d.flow='campaign'
   AND d.piece='audience-regular-v1:'||cid::text AND NOT d.is_test
   AND d.transport_state='accepted' AND d.accepted_at IS NOT NULL AND isfinite(d.accepted_at)
   AND d.accepted_at>=d.started_at
 ), people AS (
  SELECT recipient_key,recipient_key_version,bool_and(coalesce(mapped,false)) AS mapped
  FROM accepted GROUP BY recipient_key,recipient_key_version
 )
 SELECT jsonb_build_object('contract','crm-recipient-coverage-v1','brand',b,'campaign_id',cid,
  'coverage_available',true,
  'accepted_people',count(*),'mapped_people',count(*) FILTER(WHERE mapped),
  'unknown_people',count(*) FILTER(WHERE NOT mapped),'authorizes_send',false)
 INTO result FROM people;
 RETURN result;
END
$fn$;
REVOKE ALL ON FUNCTION crm_email_conversion_candidate.accepted_coverage_v1(text,integer) FROM PUBLIC;
COMMIT;
