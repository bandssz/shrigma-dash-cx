-- Isolated Growth result source. Does not install/enable a holdout or alter attribution.
BEGIN;
CREATE TABLE IF NOT EXISTS public.growth_wa_cart_outcome_config(
 brand text PRIMARY KEY CHECK(brand IN ('aristo','fish')),
 allocation_salt uuid NOT NULL,initial_since timestamptz NOT NULL,
 enabled boolean NOT NULL DEFAULT false,reconcile_days integer NOT NULL DEFAULT 9 CHECK(reconcile_days BETWEEN 1 AND 31),
 window_minutes integer NOT NULL DEFAULT 120 CHECK(window_minutes IN (15,30,60,120))
);
INSERT INTO public.growth_wa_cart_outcome_config(brand,allocation_salt,initial_since)
VALUES('aristo','4bd4e574-9810-436b-a815-f9376d86c26a','2026-09-24T00:00:00Z'),
      ('fish','4bd4e574-9810-436b-a815-f9376d86c26a','2026-09-24T00:00:00Z') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.growth_wa_cart_outcome_run(
 run_id uuid PRIMARY KEY,brand text NOT NULL CHECK(brand IN ('aristo','fish')),
 mode text NOT NULL CHECK(mode IN ('updated','reconcile')),
 since timestamptz NOT NULL,until timestamptz NOT NULL CHECK(until>since),
 started_at timestamptz NOT NULL,completed_at timestamptz NOT NULL,
 allocation_salt uuid NOT NULL,query_hash text NOT NULL CHECK(query_hash~'^[a-f0-9]{64}$'),
 count_before integer NOT NULL,count_after integer NOT NULL,orders_read integer NOT NULL,
 pages integer NOT NULL,complete boolean NOT NULL,reason text NOT NULL,
 missing_identity integer NOT NULL,unknown_financial integer NOT NULL,payload_hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS growth_wa_cart_outcome_coverage ON public.growth_wa_cart_outcome_run(brand,mode,since,until,completed_at) WHERE complete;
CREATE TABLE IF NOT EXISTS public.growth_wa_cart_outcome_order(
 brand text NOT NULL CHECK(brand IN ('aristo','fish')),order_id text NOT NULL CHECK(order_id~'^[1-9][0-9]*$'),
 unit_key text CHECK(unit_key~'^[a-f0-9]{32}$'),identity_state text NOT NULL CHECK(identity_state IN ('matched','missing','invalid','conflict')),
 identity_changed boolean NOT NULL DEFAULT false,source_missing boolean NOT NULL DEFAULT false,membership_checked_at timestamptz,allocation_salt uuid NOT NULL,
 created_at timestamptz NOT NULL,source_updated_at timestamptz NOT NULL,first_payment_at timestamptz,paid_at timestamptz,
 test boolean NOT NULL,cancelled_at timestamptz,financial_status text NOT NULL,
 financial_state text NOT NULL,currency text,received_cents numeric(20,0),refunded_cents numeric(20,0),net_cents numeric(20,0),
 source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),observed_at timestamptz NOT NULL,
 last_run_id uuid NOT NULL REFERENCES public.growth_wa_cart_outcome_run(run_id),
 PRIMARY KEY(brand,order_id),CHECK((identity_state='matched')=(unit_key IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS growth_wa_cart_outcome_identity ON public.growth_wa_cart_outcome_order(brand,unit_key,created_at);
CREATE INDEX IF NOT EXISTS growth_wa_cart_outcome_created ON public.growth_wa_cart_outcome_order(brand,created_at);
CREATE TABLE IF NOT EXISTS public.growth_wa_cart_outcome_revision(
 brand text NOT NULL,order_id text NOT NULL,source_updated_at timestamptz NOT NULL,
 source_hash text NOT NULL,run_id uuid NOT NULL REFERENCES public.growth_wa_cart_outcome_run(run_id),
 observed_at timestamptz NOT NULL,normalized jsonb NOT NULL,
 PRIMARY KEY(brand,order_id,source_updated_at,source_hash)
);

CREATE OR REPLACE FUNCTION public.growth_wa_cart_outcomes_jobs_v1(p_mode text,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $fn$
 WITH clocks AS(SELECT c.*,coalesce((SELECT max(r.until) FROM public.growth_wa_cart_outcome_run r WHERE r.brand=c.brand AND r.mode='updated' AND r.complete AND r.allocation_salt=c.allocation_salt),c.initial_since) AS watermark FROM public.growth_wa_cart_outcome_config c WHERE c.enabled),
 raw_jobs AS(
  SELECT brand,allocation_salt::text AS salt,'updated' AS mode,greatest(initial_since,watermark-interval '10 minutes') AS since,
   least(greatest(initial_since,watermark-interval '10 minutes')+make_interval(mins=>window_minutes),p_now-interval '2 minutes') AS until FROM clocks WHERE p_mode='updated'
  UNION ALL
  SELECT c.brand,c.allocation_salt::text,'reconcile',greatest(c.initial_since,d AT TIME ZONE 'UTC'),(d+make_interval(mins=>c.window_minutes)) AT TIME ZONE 'UTC'
  FROM clocks c CROSS JOIN LATERAL generate_series(date_trunc('day',p_now AT TIME ZONE 'UTC')-make_interval(days=>c.reconcile_days),p_now AT TIME ZONE 'UTC',make_interval(mins=>c.window_minutes))d WHERE p_mode='reconcile'
 ), checked AS(
  SELECT j.*,(SELECT max(r.completed_at) FROM public.growth_wa_cart_outcome_run r WHERE r.brand=j.brand AND r.mode=j.mode AND r.complete AND r.allocation_salt=j.salt::uuid AND r.since=j.since AND r.until=j.until) AS last_complete
  FROM raw_jobs j WHERE j.since<j.until AND j.until<=p_now-interval '2 minutes'
 ), ranked AS(
  SELECT *,row_number() OVER(PARTITION BY brand ORDER BY last_complete NULLS FIRST,since) AS brand_rank
  FROM checked WHERE mode='updated' OR last_complete IS NULL OR last_complete<p_now-interval '12 hours'
 ), chosen AS(
  SELECT brand,salt,mode,since,until,gen_random_uuid() AS run_id FROM ranked WHERE brand_rank<=2 ORDER BY brand_rank,brand LIMIT 4
 ) SELECT coalesce(jsonb_agg(to_jsonb(chosen)),'[]'::jsonb) FROM chosen
$fn$;
REVOKE ALL ON FUNCTION public.growth_wa_cart_outcomes_jobs_v1(text,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.growth_wa_cart_outcomes_ingest_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE r jsonb;v_brand text=p->>'brand';v_run uuid=(p->>'run_id')::uuid;v_n integer;
 v_complete boolean;v_prior public.growth_wa_cart_outcome_run%ROWTYPE;v_hash text=md5(p::text);
 v_missing integer;v_unknown integer;v_written integer=0;v_rows integer;
BEGIN
 IF p->>'version' IS DISTINCT FROM 'growth-wa-cart-outcomes-v1' OR v_brand NOT IN ('aristo','fish')
    OR v_brand IS NULL OR p->>'mode' NOT IN ('updated','reconcile') OR jsonb_typeof(p->'rows') IS DISTINCT FROM 'array'
    OR coalesce(p->>'reason','') NOT IN ('complete','count_changed_or_missing_rows') THEN RAISE EXCEPTION 'OUTCOME_INVALID_BATCH';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('growth-outcomes:'||v_run::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('growth-outcome-brand:'||v_brand,0));
 SELECT * INTO v_prior FROM public.growth_wa_cart_outcome_run WHERE run_id=v_run;
 IF FOUND THEN
  IF v_prior.payload_hash<>v_hash THEN RAISE EXCEPTION 'OUTCOME_RUN_ID_CONFLICT';END IF;
  RETURN jsonb_build_object('ok',v_prior.complete,'replay',true,'orders',v_prior.orders_read,'written',0);
 END IF;
 v_n=jsonb_array_length(p->'rows');
 IF v_n>500 OR (SELECT count(DISTINCT x->>'order_id') FROM jsonb_array_elements(p->'rows')x)<>v_n THEN RAISE EXCEPTION 'OUTCOME_DUPLICATE_OR_EXCESS_ORDERS';END IF;
 IF (p->>'since')::timestamptz>=(p->>'until')::timestamptz OR (p->>'until')::timestamptz>(p->>'started_at')::timestamptz
    OR (p->>'completed_at')::timestamptz<(p->>'started_at')::timestamptz THEN RAISE EXCEPTION 'OUTCOME_INVALID_WINDOW';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p->'rows') ORDER BY value->>'order_id' LOOP
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(r)k WHERE k NOT IN ('brand','order_id','created_at','source_updated_at','test','cancelled_at','identity_state','unit_key','financial_status','currency','received_cents','refunded_cents','net_cents','financial_state','first_payment_at','paid_at','source_hash'))
     OR r->>'brand' IS DISTINCT FROM v_brand OR coalesce(r->>'order_id','')!~'^[1-9][0-9]*$'
     OR coalesce(r->>'source_hash','')!~'^[a-f0-9]{64}$'
     OR (r->>'identity_state'='matched') IS DISTINCT FROM (r->>'unit_key' IS NOT NULL)
     OR r->>'identity_state' NOT IN ('matched','missing','invalid','conflict')
     OR r->>'financial_state' NOT IN ('known','unknown_amount','unknown_state','unknown_payment')
     OR jsonb_typeof(r->'test') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'OUTCOME_INVALID_NORMALIZED_ROW';END IF;
  IF (r->>'created_at')::timestamptz>(r->>'source_updated_at')::timestamptz
     OR (CASE p->>'mode' WHEN 'updated' THEN r->>'source_updated_at' ELSE r->>'created_at' END)::timestamptz<(p->>'since')::timestamptz
     OR (CASE p->>'mode' WHEN 'updated' THEN r->>'source_updated_at' ELSE r->>'created_at' END)::timestamptz>=(p->>'until')::timestamptz THEN RAISE EXCEPTION 'OUTCOME_ORDER_OUTSIDE_WINDOW';END IF;
  IF r->>'financial_state'='known' AND ((r->>'net_cents')::numeric IS NULL OR (r->>'received_cents')::numeric IS NULL OR (r->>'refunded_cents')::numeric IS NULL
    OR (r->>'received_cents')::numeric-(r->>'refunded_cents')::numeric<>(r->>'net_cents')::numeric) THEN RAISE EXCEPTION 'OUTCOME_MONEY_MISMATCH';END IF;
 END LOOP;
 SELECT count(*) FILTER(WHERE x->>'identity_state'<>'matched'),count(*) FILTER(WHERE x->>'financial_state'<>'known') INTO v_missing,v_unknown FROM jsonb_array_elements(p->'rows')x;
 v_complete=(p->>'complete')::boolean AND (p->>'count_before')::integer=v_n AND (p->>'count_after')::integer=v_n AND p->>'reason'='complete';
 INSERT INTO public.growth_wa_cart_outcome_run VALUES(v_run,v_brand,p->>'mode',(p->>'since')::timestamptz,(p->>'until')::timestamptz,(p->>'started_at')::timestamptz,(p->>'completed_at')::timestamptz,(p->>'allocation_salt')::uuid,p->>'query_hash',(p->>'count_before')::integer,(p->>'count_after')::integer,v_n,(p->>'pages')::integer,v_complete,p->>'reason',v_missing,v_unknown,v_hash);
 IF NOT v_complete THEN RETURN jsonb_build_object('ok',false,'reason','incomplete_coverage','orders',v_n,'written',0);END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p->'rows') ORDER BY value->>'order_id' LOOP
  -- Serialize competing brand/order updates before checking the source revision.
  PERFORM pg_advisory_xact_lock(hashtextextended('growth-outcome-order:'||v_brand||':'||(r->>'order_id'),0));
  IF EXISTS(SELECT 1 FROM public.growth_wa_cart_outcome_order o WHERE o.brand=v_brand AND o.order_id=r->>'order_id'
       AND o.source_updated_at=(r->>'source_updated_at')::timestamptz AND o.source_hash<>r->>'source_hash') THEN RAISE EXCEPTION 'OUTCOME_SOURCE_REVISION_CONFLICT';END IF;
  INSERT INTO public.growth_wa_cart_outcome_revision VALUES(v_brand,r->>'order_id',(r->>'source_updated_at')::timestamptz,r->>'source_hash',v_run,(p->>'completed_at')::timestamptz,r) ON CONFLICT DO NOTHING;
  INSERT INTO public.growth_wa_cart_outcome_order AS old(brand,order_id,unit_key,identity_state,allocation_salt,created_at,source_updated_at,first_payment_at,paid_at,test,cancelled_at,financial_status,financial_state,currency,received_cents,refunded_cents,net_cents,source_hash,observed_at,last_run_id)
  VALUES(v_brand,r->>'order_id',r->>'unit_key',r->>'identity_state',(p->>'allocation_salt')::uuid,(r->>'created_at')::timestamptz,(r->>'source_updated_at')::timestamptz,(r->>'first_payment_at')::timestamptz,(r->>'paid_at')::timestamptz,(r->>'test')::boolean,(r->>'cancelled_at')::timestamptz,r->>'financial_status',r->>'financial_state',r->>'currency',(r->>'received_cents')::numeric,(r->>'refunded_cents')::numeric,(r->>'net_cents')::numeric,r->>'source_hash',(p->>'completed_at')::timestamptz,v_run)
  ON CONFLICT(brand,order_id) DO UPDATE SET unit_key=excluded.unit_key,identity_state=excluded.identity_state,
   identity_changed=old.identity_changed OR (old.unit_key IS NOT NULL AND excluded.unit_key IS DISTINCT FROM old.unit_key),
   allocation_salt=excluded.allocation_salt,created_at=excluded.created_at,source_updated_at=excluded.source_updated_at,first_payment_at=excluded.first_payment_at,paid_at=excluded.paid_at,test=excluded.test,cancelled_at=excluded.cancelled_at,
   financial_status=excluded.financial_status,financial_state=excluded.financial_state,currency=excluded.currency,received_cents=excluded.received_cents,refunded_cents=excluded.refunded_cents,net_cents=excluded.net_cents,source_hash=excluded.source_hash,observed_at=excluded.observed_at,last_run_id=excluded.last_run_id
   WHERE excluded.source_updated_at>=old.source_updated_at;
  GET DIAGNOSTICS v_rows=ROW_COUNT;v_written=v_written+v_rows;
 END LOOP;
 IF p->>'mode'='reconcile' THEN
  UPDATE public.growth_wa_cart_outcome_order o SET
   source_missing=NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'rows')x WHERE x->>'order_id'=o.order_id),
   membership_checked_at=(p->>'completed_at')::timestamptz
  WHERE o.brand=v_brand AND o.created_at>=(p->>'since')::timestamptz AND o.created_at<(p->>'until')::timestamptz
   AND o.observed_at<=(p->>'completed_at')::timestamptz
   AND coalesce(o.membership_checked_at,'-infinity')<=(p->>'completed_at')::timestamptz;
 END IF;
 RETURN jsonb_build_object('ok',true,'orders',v_n,'written',v_written,'missing_identity',v_missing,'unknown_financial',v_unknown);
END $fn$;
REVOKE ALL ON FUNCTION public.growth_wa_cart_outcomes_ingest_v1(jsonb) FROM PUBLIC;

-- Input is one row per allocated person, not one row per cart/send/click.
-- Does not depend on holdout tables existing, and never enables enrollment.
CREATE OR REPLACE FUNCTION public.growth_wa_cart_outcomes_report_v1(p_cohort jsonb,p_window_hours integer,p_as_of timestamptz,p_salt uuid,p_max_stale_hours integer DEFAULT 24)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $fn$
DECLARE v_result jsonb;
BEGIN
 IF jsonb_typeof(p_cohort) IS DISTINCT FROM 'array' OR p_window_hours IS NULL OR p_window_hours NOT BETWEEN 1 AND 720
  OR p_max_stale_hours IS NULL OR p_max_stale_hours NOT BETWEEN 1 AND 168 OR p_as_of IS NULL OR p_salt IS NULL THEN RAISE EXCEPTION 'OUTCOME_INVALID_COHORT';END IF;
 IF jsonb_array_length(p_cohort)>1000 THEN RAISE EXCEPTION 'OUTCOME_COHORT_LIMIT_1000';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_cohort)c WHERE coalesce(c->>'brand','') NOT IN ('aristo','fish')
  OR coalesce(c->>'arm','') NOT IN ('holdout','treatment') OR coalesce(c->>'unit_key','')!~'^[a-f0-9]{32}$'
  OR coalesce(c->>'first_eligible_at','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_cohort)c GROUP BY c->>'brand',c->>'unit_key' HAVING count(DISTINCT c->>'arm')>1)
 THEN RAISE EXCEPTION 'OUTCOME_INVALID_COHORT';END IF;
 WITH cohort AS(
  SELECT brand,unit_key,arm,min(first_eligible_at) AS first_eligible_at,min(first_eligible_at)+make_interval(hours=>p_window_hours) AS window_end
  FROM jsonb_to_recordset(p_cohort) AS c(brand text,unit_key text,arm text,first_eligible_at timestamptz)
  WHERE p_window_hours BETWEEN 1 AND 720 AND p_max_stale_hours BETWEEN 1 AND 168 AND brand IN ('aristo','fish') AND arm IN ('holdout','treatment')
  GROUP BY brand,unit_key,arm
 ), status AS(
  SELECT c.*,(c.window_end<=p_as_of) AS mature,
   (SELECT coalesce(range_agg(tstzrange(r.since,r.until,'[)')) @> tstzrange(c.first_eligible_at,c.window_end,'[)'),false)
    FROM public.growth_wa_cart_outcome_run r WHERE r.brand=c.brand AND r.mode='reconcile' AND r.complete AND r.allocation_salt=p_salt
     AND r.completed_at>=c.window_end AND r.completed_at>=p_as_of-make_interval(hours=>p_max_stale_hours) AND r.completed_at<=p_as_of) AS coverage_complete,
   (SELECT count(*) FROM public.growth_wa_cart_outcome_order o WHERE o.brand=c.brand AND NOT o.test AND o.created_at>=c.first_eligible_at AND o.created_at<c.window_end
    AND (o.source_missing OR o.financial_state<>'known' OR o.currency IS DISTINCT FROM 'BRL' OR o.allocation_salt<>p_salt OR o.observed_at>p_as_of OR o.identity_changed OR (o.first_payment_at<c.window_end AND o.paid_at>=c.window_end) OR (o.received_cents>0 AND (o.identity_state<>'matched' OR o.financial_status NOT IN ('PAID','PARTIALLY_REFUNDED','REFUNDED'))))) AS uncertain_orders,
   (SELECT count(*) FROM public.growth_wa_cart_outcome_order o WHERE o.brand=c.brand AND o.unit_key=c.unit_key AND o.allocation_salt=p_salt AND NOT o.test AND NOT o.identity_changed
    AND NOT o.source_missing AND o.financial_state='known' AND o.financial_status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') AND o.currency='BRL' AND o.observed_at<=p_as_of AND o.received_cents>0 AND o.created_at>=c.first_eligible_at AND o.created_at<c.window_end AND o.paid_at>=c.first_eligible_at AND o.paid_at<c.window_end) AS confirmed_paid_orders,
   (SELECT coalesce(sum(o.net_cents),0) FROM public.growth_wa_cart_outcome_order o WHERE o.brand=c.brand AND o.unit_key=c.unit_key AND o.allocation_salt=p_salt AND NOT o.test AND NOT o.identity_changed
    AND NOT o.source_missing AND o.financial_state='known' AND o.financial_status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED') AND o.currency='BRL' AND o.observed_at<=p_as_of AND o.received_cents>0 AND o.created_at>=c.first_eligible_at AND o.created_at<c.window_end AND o.paid_at>=c.first_eligible_at AND o.paid_at<c.window_end) AS confirmed_net_cents
  FROM cohort c
 ), grouped AS(
  SELECT brand,arm,count(*) AS allocated,count(*) FILTER(WHERE mature) AS mature,
   count(*) FILTER(WHERE mature AND coverage_complete AND uncertain_orders=0) AS measured,
   count(*) FILTER(WHERE NOT(mature AND coverage_complete AND uncertain_orders=0)) AS unknown,
   sum(confirmed_paid_orders) FILTER(WHERE mature) AS confirmed_paid_orders,
   count(*) FILTER(WHERE mature AND confirmed_paid_orders>0) AS confirmed_buyers,
   count(*) FILTER(WHERE mature AND coverage_complete AND uncertain_orders=0 AND confirmed_paid_orders>0) AS complete_buyers,
   sum(confirmed_net_cents) FILTER(WHERE mature) AS confirmed_net_cents,
   sum(confirmed_net_cents) FILTER(WHERE mature AND coverage_complete AND uncertain_orders=0) AS complete_net_cents
  FROM status GROUP BY brand,arm
 ) SELECT jsonb_build_object('window_hours',p_window_hours,'as_of',p_as_of,'denominator','all_allocated_people','confirmed_values','partial_when_unknown_is_positive','causal_conclusion',false,'groups',coalesce(jsonb_agg(to_jsonb(grouped)),'[]'::jsonb)) INTO v_result FROM grouped;
 RETURN v_result;
END
$fn$;
REVOKE ALL ON FUNCTION public.growth_wa_cart_outcomes_report_v1(jsonb,integer,timestamptz,uuid,integer) FROM PUBLIC;
COMMIT;
