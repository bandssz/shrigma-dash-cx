-- Shadow candidate, OFF: unique buyers per accepted recipient of a regular
-- saved-audience campaign. Read-only. Not installed anywhere. Install only after
-- recipient-conversion-evidence.sql, in a separate reviewed production window.
-- It never sends, enrolls, backfills, enables capture or exposes an API.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='20s';
DO $guard$
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
  OR coalesce(current_setting('shrigma.buyer_conversion.install_guard',true),'')!~'^[a-f0-9]{64}$'
  OR to_regnamespace('crm_email_conversion_candidate') IS NULL
  OR to_regclass('crm_email_conversion_candidate.claim_identity_v1') IS NULL
  OR to_regclass('crm_email_conversion_candidate.capture_control_v1') IS NULL
  OR to_regclass('public.shrigma_email_dispatch') IS NULL
  OR to_regclass('public.campaigns') IS NULL
  OR to_regclass('public.crm_ab_arm_v2') IS NULL
  OR to_regclass('public.crm_attribution_order_v2') IS NULL
  OR to_regclass('public.crm_attribution_coverage_v2') IS NULL
  OR to_regclass('crm_email_conversion_candidate.buyer_read_control_v1') IS NOT NULL
  OR to_regprocedure('crm_email_conversion_candidate.buyer_conversion_v1(text,integer,integer)') IS NOT NULL THEN
  RAISE EXCEPTION 'BUYER_CONVERSION_INSTALL_GUARD';
 END IF;
 -- Version guard: the identity link must be exactly the reviewed capture v1.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_email_conversion_candidate.claim_hash_v1(jsonb)')) IS DISTINCT FROM '809f304f16e30af894858df2f224a070'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_email_conversion_candidate.accepted_coverage_v1(text,integer)')) IS DISTINCT FROM '4fb9ccc8da2518987d5873d02075ff4c' THEN
  RAISE EXCEPTION 'BUYER_CONVERSION_DEPENDENCY_DRIFT';
 END IF;
 IF (SELECT count(*) FROM pg_attribute WHERE attrelid='public.crm_attribution_order_v2'::regclass AND NOT attisdropped
   AND attname IN('brand','order_id','payload','checked_at'))<>4
  OR (SELECT count(*) FROM pg_attribute WHERE attrelid='public.crm_attribution_coverage_v2'::regclass AND NOT attisdropped
   AND attname IN('brand','day','checked_at'))<>3 THEN
  RAISE EXCEPTION 'BUYER_CONVERSION_DEPENDENCY_DRIFT';
 END IF;
END
$guard$;

-- Read gate per brand. Both brands start OFF; enabling is a Prod decision.
CREATE TABLE crm_email_conversion_candidate.buyer_read_control_v1(
 brand text PRIMARY KEY CHECK(brand IN('fish','aristo')),
 enabled boolean NOT NULL DEFAULT false
);
INSERT INTO crm_email_conversion_candidate.buyer_read_control_v1(brand) VALUES('fish'),('aristo');
REVOKE ALL ON crm_email_conversion_candidate.buyer_read_control_v1 FROM PUBLIC;

-- Contract crm-recipient-buyers-v1. Unit: people (recipient keys), never orders.
-- Person = accepted recipient key of the campaign (one per campaign, even with N
-- dispatches or N orders). Window per person: [first accepted_at,
-- first accepted_at + window_days) — start inclusive, end exclusive, 1..14 days.
-- Order = current paid-eligible attribution payload of the SAME brand whose
-- Shopify Customer GID equals the immutable captured GID.
-- Person state, in this order:
--  identity_unknown   no confirmed immutable capture (capture OFF, before
--                     coverage_started_at, unresolved, mismatch, hash drift)
--  window_open        statement time < window end
--  orders_unavailable some São Paulo day of the window has no complete order
--                     collection, or an eligible order in the window was
--                     collected without the customer identity field
--  measured           buyer true/false
-- buyers/buyer_rate exist only over measured people; with zero measured people
-- they are NULL (unknown), never 0. Opt-out follows the native claim: an
-- opted-out subscriber is never claimed (not in the denominator); opting out
-- after the accepted send does not remove the person.
CREATE FUNCTION crm_email_conversion_candidate.buyer_conversion_v1(b text,cid integer,window_days integer DEFAULT 7)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $fn$
DECLARE result jsonb;at_time timestamptz:=statement_timestamp();
 head jsonb;empty jsonb;
BEGIN
 IF window_days IS NULL OR window_days<1 OR window_days>14 THEN RAISE EXCEPTION 'BUYER_CONVERSION_WINDOW_INVALID';END IF;
 head:=jsonb_build_object('contract','crm-recipient-buyers-v1','brand',b,'campaign_id',cid,'unit','people',
  'window',jsonb_build_object('anchor','accepted_at','days',window_days,'max_days',14,'start','inclusive','end','exclusive'),
  'as_of',at_time,'authorizes_send',false);
 empty:=jsonb_build_object('accepted_people',NULL,'identity_mapped_people',NULL,'identity_unknown_people',NULL,
  'window_open_people',NULL,'orders_unavailable_people',NULL,'measured_people',NULL,'buyers',NULL,'non_buyers',NULL,
  'buyer_rate',NULL,'identity_coverage',NULL,'measured_share',NULL,'orders_without_customer',NULL,'buyers_lower_bound',NULL);
 IF b IS NULL OR b NOT IN('fish','aristo') OR cid IS NULL OR cid<=0
  OR NOT EXISTS(SELECT 1 FROM public.campaigns c WHERE c.id=cid AND c.attribs#>>'{crm,brand}'=b)
  OR EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 WHERE campaign_id=cid) THEN
  RETURN head||empty||jsonb_build_object('available',false,'reason','campaign_scope_unavailable');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM crm_email_conversion_candidate.buyer_read_control_v1 WHERE brand=b AND enabled) THEN
  RETURN head||empty||jsonb_build_object('available',false,'reason','buyer_read_disabled');
 END IF;
 WITH accepted AS (
  -- Same accepted/mapped definition as accepted_coverage_v1.
  SELECT d.recipient_key,d.recipient_key_version,d.accepted_at,e.customer_gid,
   coalesce(e.identity_state='confirmed' AND e.claim_sha256=crm_email_conversion_candidate.claim_hash_v1(to_jsonb(d))
    AND e.brand=d.brand AND e.campaign_id=cid AND e.customer_gid IS NOT NULL
    AND e.captured_at<=d.accepted_at,false) AS mapped
  FROM public.shrigma_email_dispatch d LEFT JOIN crm_email_conversion_candidate.claim_identity_v1 e USING(dispatch_id)
  WHERE d.brand=b AND d.flow='campaign' AND d.piece='audience-regular-v1:'||cid::text AND NOT d.is_test
   AND d.transport_state='accepted' AND d.accepted_at IS NOT NULL AND isfinite(d.accepted_at)
   AND d.accepted_at>=d.started_at
 ), people AS (
  SELECT recipient_key,recipient_key_version,min(accepted_at) AS anchor,
   bool_and(mapped) AND count(DISTINCT customer_gid)=1 AS mapped,
   min(customer_gid) FILTER(WHERE mapped) AS customer_gid
  FROM accepted GROUP BY recipient_key,recipient_key_version
 ), windows AS (
  SELECT p.*,p.anchor+make_interval(days=>window_days) AS until FROM people p
 ), orders AS MATERIALIZED (
  SELECT o.order_id,(o.payload->>'created_at')::timestamptz AS created_at,
   o.payload ? 'customer_identity_state' AS identity_collected,
   CASE WHEN o.payload->>'customer_identity_state'='confirmed' THEN o.payload->>'customer_gid' END AS customer_gid
  FROM public.crm_attribution_order_v2 o
  WHERE o.brand=b AND o.payload->>'eligible'='true'
   AND (o.payload->>'created_at')::timestamptz>=(SELECT min(anchor) FROM people)
   AND (o.payload->>'created_at')::timestamptz<(SELECT max(until) FROM windows)
 ), judged AS (
  SELECT w.*,
   CASE WHEN NOT w.mapped THEN 'identity_unknown'
    WHEN at_time<w.until THEN 'window_open'
    WHEN EXISTS(SELECT 1 FROM generate_series(0,((w.until-interval '1 microsecond') AT TIME ZONE 'America/Sao_Paulo')::date
       -(w.anchor AT TIME ZONE 'America/Sao_Paulo')::date) i
      WHERE NOT EXISTS(SELECT 1 FROM public.crm_attribution_coverage_v2 c
       WHERE c.brand=b AND c.day=(w.anchor AT TIME ZONE 'America/Sao_Paulo')::date+i
        AND c.checked_at>=least(w.until,(((w.anchor AT TIME ZONE 'America/Sao_Paulo')::date+i+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))))
     OR EXISTS(SELECT 1 FROM orders o WHERE NOT o.identity_collected AND o.created_at>=w.anchor AND o.created_at<w.until)
     THEN 'orders_unavailable'
    ELSE 'measured' END AS state,
   EXISTS(SELECT 1 FROM orders o WHERE o.customer_gid=w.customer_gid AND o.created_at>=w.anchor AND o.created_at<w.until) AS bought
  FROM windows w
 ), totals AS (
  SELECT count(*)::integer AS accepted,count(*) FILTER(WHERE mapped)::integer AS mapped,
   count(*) FILTER(WHERE state='identity_unknown')::integer AS unknown,
   count(*) FILTER(WHERE state='window_open')::integer AS open,
   count(*) FILTER(WHERE state='orders_unavailable')::integer AS unavailable,
   count(*) FILTER(WHERE state='measured')::integer AS measured,
   count(*) FILTER(WHERE state='measured' AND bought)::integer AS buyers,
   (SELECT count(DISTINCT o.order_id) FROM orders o WHERE o.identity_collected AND o.customer_gid IS NULL
     AND EXISTS(SELECT 1 FROM judged j WHERE j.state='measured' AND o.created_at>=j.anchor AND o.created_at<j.until))::integer AS guest
  FROM judged
 )
 SELECT head||jsonb_build_object('available',true,'reason',NULL,
  'accepted_people',t.accepted,'identity_mapped_people',t.mapped,'identity_unknown_people',t.unknown,
  'window_open_people',t.open,'orders_unavailable_people',t.unavailable,'measured_people',t.measured,
  'buyers',CASE WHEN t.measured>0 THEN t.buyers END,
  'non_buyers',CASE WHEN t.measured>0 THEN t.measured-t.buyers END,
  'buyer_rate',CASE WHEN t.measured>0 THEN round(t.buyers::numeric/t.measured,6) END,
  'identity_coverage',CASE WHEN t.accepted>0 THEN round(t.mapped::numeric/t.accepted,6) END,
  'measured_share',CASE WHEN t.accepted>0 THEN round(t.measured::numeric/t.accepted,6) END,
  'orders_without_customer',CASE WHEN t.measured>0 THEN t.guest END,
  'buyers_lower_bound',CASE WHEN t.measured>0 THEN t.guest>0 END)
 INTO result FROM totals t;
 RETURN result;
END
$fn$;
REVOKE ALL ON FUNCTION crm_email_conversion_candidate.buyer_conversion_v1(text,integer,integer) FROM PUBLIC;

DO $guard$ DECLARE r record; BEGIN
 -- Default privileges may grant other roles on creation; keep it owner-only.
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname<>'postgres' LOOP
  EXECUTE format('REVOKE ALL ON crm_email_conversion_candidate.buyer_read_control_v1 FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON FUNCTION crm_email_conversion_candidate.buyer_conversion_v1(text,integer,integer) FROM %I',r.rolname);
 END LOOP;
 IF EXISTS(SELECT 1 FROM crm_email_conversion_candidate.buyer_read_control_v1 WHERE enabled)
  OR (SELECT count(*) FROM crm_email_conversion_candidate.buyer_read_control_v1)<>2
  -- Superusers and predefined pg_* roles (e.g. pg_read_all_data) are out of
  -- this check; the API/worker roles must never read the gate or call it.
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname<>'postgres' AND NOT rolsuper AND rolname!~'^pg_' AND (
   has_function_privilege(rolname,'crm_email_conversion_candidate.buyer_conversion_v1(text,integer,integer)','EXECUTE')
   OR has_table_privilege(rolname,'crm_email_conversion_candidate.buyer_read_control_v1','SELECT'))) THEN
  RAISE EXCEPTION 'BUYER_CONVERSION_AFTER_DRIFT';
 END IF;
END $guard$;
COMMIT;
