-- Prospective Aristocrata VIP form receipts. OFF by default.
-- This records a positive accepted form event; it is not historical signup origin
-- and never authorizes transport. No producer role grant is installed here.
BEGIN;
DO $install$
BEGIN
 IF to_regnamespace('crm_audience_v2') IS NULL
  OR to_regprocedure('crm_audience_v2.append_only()') IS NULL
  OR to_regprocedure('public.shrigma_crm_vip_subscribe_v1(text,text,boolean,text)') IS NULL THEN
  RAISE EXCEPTION 'RECORDED_ORIGIN_DEPENDENCY';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.shrigma_crm_vip_subscribe_v1(text,text,boolean,text)'::regprocedure
  AND pg_get_userbyid(p.proowner)='postgres' AND NOT p.prosecdef AND p.provolatile='v'
  AND md5(p.prosrc)='c7cb4706377aff4e35c9ec2734a9f2c8'
  AND cardinality(p.proconfig)=2 AND p.proconfig @> ARRAY['search_path=pg_catalog, public','lock_timeout=500ms']::text[]
  AND NOT has_function_privilege('public','public.shrigma_crm_vip_subscribe_v1(text,text,boolean,text)','EXECUTE')) THEN
  RAISE EXCEPTION 'RECORDED_ORIGIN_CONSENT_DRIFT';
 END IF;
 IF to_regclass('crm_audience_v2.recorded_origin_source') IS NOT NULL
  OR to_regclass('crm_audience_v2.recorded_origin_receipt') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace
   AND proname IN('recorded_origin_source_guard','recorded_origin_subscribe_v2','recorded_origin_operation_v2')) THEN
  RAISE EXCEPTION 'RECORDED_ORIGIN_ALREADY_INSTALLED';
 END IF;
END $install$;

CREATE TABLE crm_audience_v2.recorded_origin_source (
 canonical_origin text PRIMARY KEY CHECK(canonical_origin IN('vip_alma','vip_desodorante')),
 brand text NOT NULL DEFAULT 'aristo' CHECK(brand='aristo'),
 scope_id uuid NOT NULL UNIQUE,
 producer_id text NOT NULL UNIQUE CHECK(producer_id IN('NAmTWZ7vddQ8LX1k','ywJDsgBDhZOBgoxb')),
 producer_revision text NOT NULL CHECK(producer_revision~'^[0-9a-f]{64}$'),
 coverage_started_at timestamptz NOT NULL CHECK(coverage_started_at NOT IN ('infinity'::timestamptz,'-infinity'::timestamptz)
  AND date_trunc('milliseconds',coverage_started_at)=coverage_started_at),
 enabled boolean NOT NULL DEFAULT false,
 CHECK((canonical_origin='vip_alma' AND producer_id='NAmTWZ7vddQ8LX1k')
    OR (canonical_origin='vip_desodorante' AND producer_id='ywJDsgBDhZOBgoxb'))
);

CREATE TABLE crm_audience_v2.recorded_origin_receipt (
 scope_id uuid NOT NULL REFERENCES crm_audience_v2.recorded_origin_source(scope_id),
 producer_id text NOT NULL,
 event_id uuid NOT NULL,
 subscriber_id integer NOT NULL CHECK(subscriber_id>0),
 subscriber_uuid uuid NOT NULL,
 accepted_at timestamptz NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash~'^[0-9a-f]{64}$'),
 PRIMARY KEY(producer_id,event_id),
 UNIQUE(scope_id,event_id),
 UNIQUE(scope_id,producer_id,event_id,subscriber_uuid)
);
CREATE INDEX recorded_origin_receipt_match ON crm_audience_v2.recorded_origin_receipt(scope_id,subscriber_id,subscriber_uuid);

CREATE FUNCTION crm_audience_v2.recorded_origin_source_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,crm_audience_v2 AS $fn$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.enabled AND NEW.coverage_started_at>clock_timestamp() THEN
   RAISE EXCEPTION 'RECORDED_ORIGIN_COVERAGE_FUTURE';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM crm_audience_v2.recorded_origin_receipt r WHERE r.scope_id=OLD.scope_id) THEN
   RAISE EXCEPTION 'RECORDED_ORIGIN_SOURCE_IMMUTABLE';
  END IF;
  RETURN OLD;
 END IF;
 IF NEW.canonical_origin IS DISTINCT FROM OLD.canonical_origin
  OR NEW.brand IS DISTINCT FROM OLD.brand
  OR NEW.producer_id IS DISTINCT FROM OLD.producer_id THEN
  RAISE EXCEPTION 'RECORDED_ORIGIN_SOURCE_IMMUTABLE';
 END IF;
 IF (NEW.scope_id IS DISTINCT FROM OLD.scope_id OR NEW.coverage_started_at IS DISTINCT FROM OLD.coverage_started_at
      OR NEW.producer_revision IS DISTINCT FROM OLD.producer_revision)
  AND EXISTS(SELECT 1 FROM crm_audience_v2.recorded_origin_receipt r WHERE r.scope_id=OLD.scope_id) THEN
  RAISE EXCEPTION 'RECORDED_ORIGIN_SCOPE_IMMUTABLE';
 END IF;
 IF NEW.enabled AND NEW.coverage_started_at>clock_timestamp() THEN
  RAISE EXCEPTION 'RECORDED_ORIGIN_COVERAGE_FUTURE';
 END IF;
 RETURN NEW;
END $fn$;

CREATE TRIGGER recorded_origin_source_guard
 BEFORE INSERT OR UPDATE OR DELETE ON crm_audience_v2.recorded_origin_source
 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.recorded_origin_source_guard();
CREATE TRIGGER recorded_origin_receipt_immutable
 BEFORE UPDATE OR DELETE ON crm_audience_v2.recorded_origin_receipt
 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();

CREATE FUNCTION crm_audience_v2.recorded_origin_subscribe_v2(
 p_email text,p_origem text,p_corrigido boolean,p_source text,p_event_id uuid,p_producer_revision text
) RETURNS TABLE(eligible boolean,reason text,producer_id text,event_id uuid,receipt_hash text,accepted_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,crm_audience_v2 SET lock_timeout='500ms' AS $fn$
DECLARE
 canonical text; expected_producer text; cfg crm_audience_v2.recorded_origin_source%ROWTYPE;
 prior crm_audience_v2.recorded_origin_receipt%ROWTYPE; consent record;
 sid integer; suuid uuid; candidate_hash text; accepted timestamptz;
BEGIN
 canonical:=CASE p_source WHEN 'alma' THEN 'vip_alma' WHEN 'desodorante' THEN 'vip_desodorante' END;
 expected_producer:=CASE p_source WHEN 'alma' THEN 'NAmTWZ7vddQ8LX1k' WHEN 'desodorante' THEN 'ywJDsgBDhZOBgoxb' END;
 IF canonical IS NULL OR p_event_id IS NULL OR p_producer_revision IS NULL
  OR p_producer_revision!~'^[0-9a-f]{64}$' THEN
  RETURN QUERY SELECT false,'invalid_input'::text,expected_producer,p_event_id,NULL::text,NULL::timestamptz;RETURN;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(expected_producer||':'||p_event_id::text,721944));
 SELECT r.* INTO prior FROM crm_audience_v2.recorded_origin_receipt r
  WHERE r.producer_id=expected_producer AND r.event_id=p_event_id;
 IF FOUND THEN
  SELECT s.id,s.uuid INTO sid,suuid FROM public.subscribers s WHERE s.email=p_email;
  candidate_hash:=encode(sha256(convert_to(jsonb_build_object(
   'scope_id',prior.scope_id,'producer_id',expected_producer,'producer_revision',p_producer_revision,
   'event_id',p_event_id,'subscriber_uuid',suuid,'canonical_origin',canonical,
   'submitted_origin',p_origem,'corrected',p_corrigido)::text,'UTF8')),'hex');
  IF sid IS NULL OR prior.subscriber_id IS DISTINCT FROM sid OR prior.subscriber_uuid IS DISTINCT FROM suuid
   OR prior.scope_id IS DISTINCT FROM (SELECT s.scope_id FROM crm_audience_v2.recorded_origin_source s
      WHERE s.producer_id=expected_producer AND s.canonical_origin=canonical)
   OR prior.payload_hash IS DISTINCT FROM candidate_hash THEN
   RAISE EXCEPTION 'RECORDED_ORIGIN_REPLAY_MISMATCH';
  END IF;
  RETURN QUERY SELECT false,'replayed'::text,prior.producer_id,prior.event_id,prior.payload_hash,prior.accepted_at;RETURN;
 END IF;
 SELECT s.* INTO cfg FROM crm_audience_v2.recorded_origin_source s
  WHERE s.canonical_origin=canonical AND s.producer_id=expected_producer FOR SHARE;
 IF NOT FOUND OR NOT cfg.enabled OR cfg.coverage_started_at>statement_timestamp() THEN
  RETURN QUERY SELECT false,'source_unavailable'::text,expected_producer,p_event_id,NULL::text,NULL::timestamptz;RETURN;
 END IF;
 IF cfg.producer_revision IS DISTINCT FROM p_producer_revision THEN
  RETURN QUERY SELECT false,'producer_revision_changed'::text,expected_producer,p_event_id,NULL::text,NULL::timestamptz;RETURN;
 END IF;
 SELECT * INTO consent FROM public.shrigma_crm_vip_subscribe_v1(p_email,p_origem,p_corrigido,p_source);
 IF NOT FOUND OR consent.eligible IS DISTINCT FROM true THEN
  RETURN QUERY SELECT false,coalesce(consent.reason,'consent_unavailable'),expected_producer,p_event_id,NULL::text,NULL::timestamptz;RETURN;
 END IF;
 SELECT s.id,s.uuid INTO STRICT sid,suuid FROM public.subscribers s WHERE s.email=p_email AND s.status::text='enabled' FOR UPDATE;
 candidate_hash:=encode(sha256(convert_to(jsonb_build_object(
  'scope_id',cfg.scope_id,'producer_id',cfg.producer_id,'producer_revision',cfg.producer_revision,
  'event_id',p_event_id,'subscriber_uuid',suuid,'canonical_origin',cfg.canonical_origin,
  'submitted_origin',p_origem,'corrected',p_corrigido)::text,'UTF8')),'hex');
 accepted:=clock_timestamp();
 IF accepted<cfg.coverage_started_at THEN RAISE EXCEPTION 'RECORDED_ORIGIN_COVERAGE_INVALID'; END IF;
 INSERT INTO crm_audience_v2.recorded_origin_receipt(scope_id,producer_id,event_id,subscriber_id,subscriber_uuid,accepted_at,payload_hash)
 VALUES(cfg.scope_id,cfg.producer_id,p_event_id,sid,suuid,accepted,candidate_hash);
 RETURN QUERY SELECT true,consent.reason,cfg.producer_id,p_event_id,candidate_hash,accepted;
END $fn$;

CREATE FUNCTION crm_audience_v2.recorded_origin_operation_v2(p_producer_id text,p_event_id uuid)
RETURNS TABLE(found boolean,reason text,producer_id text,event_id uuid,receipt_hash text,accepted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,crm_audience_v2 AS $fn$
 SELECT r.producer_id IS NOT NULL,CASE WHEN r.producer_id IS NULL THEN 'not_found' ELSE 'accepted' END,
  p_producer_id,p_event_id,r.payload_hash,r.accepted_at
 FROM (SELECT p_producer_id producer_id) p
 LEFT JOIN crm_audience_v2.recorded_origin_receipt r
  ON r.producer_id=p_producer_id AND r.event_id=p_event_id
$fn$;

REVOKE ALL ON TABLE crm_audience_v2.recorded_origin_source,crm_audience_v2.recorded_origin_receipt FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_audience_v2.recorded_origin_source_guard(),
 crm_audience_v2.recorded_origin_subscribe_v2(text,text,boolean,text,uuid,text),
 crm_audience_v2.recorded_origin_operation_v2(text,uuid) FROM PUBLIC;
COMMIT;
