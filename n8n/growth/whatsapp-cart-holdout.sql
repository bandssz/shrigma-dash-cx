-- Candidate only. Apply only after reviewing a fresh workflow/database snapshot.
-- No existing table/function is changed. Default: enrollment disabled.
BEGIN;
CREATE TABLE IF NOT EXISTS public.growth_wa_cart_holdout_run (
 run_key text PRIMARY KEY,
 enrollment_enabled boolean NOT NULL DEFAULT false,
 holdout_bps integer NOT NULL CHECK (holdout_bps=500),
 allocation_salt uuid NOT NULL,
 starts_at timestamptz,
 enrollment_ends_at timestamptz,
 CHECK (NOT enrollment_enabled OR (starts_at IS NOT NULL AND enrollment_ends_at IS NOT NULL AND enrollment_ends_at>starts_at))
);
INSERT INTO public.growth_wa_cart_holdout_run(run_key,holdout_bps,allocation_salt)
VALUES ('wa-cart-20260924-v1',500,'4bd4e574-9810-436b-a815-f9376d86c26a') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.growth_wa_cart_holdout_unit (
 run_key text NOT NULL REFERENCES public.growth_wa_cart_holdout_run(run_key),
 brand text NOT NULL CHECK(brand IN ('aristo','fish')),
 unit_key text NOT NULL CHECK(unit_key ~ '^[0-9a-f]{32}$'),
 bucket integer NOT NULL CHECK(bucket BETWEEN 0 AND 9999),
 arm text NOT NULL CHECK(arm IN ('holdout','treatment')),
 first_eligible_at timestamptz NOT NULL,
 PRIMARY KEY(run_key,brand,unit_key)
);
CREATE TABLE IF NOT EXISTS public.growth_wa_cart_holdout_journey (
 run_key text NOT NULL,
 brand text NOT NULL,
 cart_ref text NOT NULL CHECK(cart_ref<>''),
 unit_key text NOT NULL,
 subscriber_id bigint NOT NULL,
 cart_at timestamptz NOT NULL,
 first_eligible_at timestamptz NOT NULL,
 PRIMARY KEY(run_key,brand,cart_ref),
 FOREIGN KEY(run_key,brand,unit_key) REFERENCES public.growth_wa_cart_holdout_unit(run_key,brand,unit_key)
);
CREATE TABLE IF NOT EXISTS public.growth_wa_cart_holdout_eligibility (
 run_key text NOT NULL,
 brand text NOT NULL,
 cart_ref text NOT NULL,
 piece text NOT NULL CHECK(piece IN ('carrinho-30min','carrinho-24h')),
 first_eligible_at timestamptz NOT NULL,
 PRIMARY KEY(run_key,brand,cart_ref,piece),
 FOREIGN KEY(run_key,brand,cart_ref) REFERENCES public.growth_wa_cart_holdout_journey(run_key,brand,cart_ref)
);

CREATE OR REPLACE FUNCTION public.growth_wa_cart_holdout_freeze_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
 IF (NEW.run_key,NEW.holdout_bps,NEW.allocation_salt,NEW.starts_at) IS DISTINCT FROM
    (OLD.run_key,OLD.holdout_bps,OLD.allocation_salt,OLD.starts_at)
    AND EXISTS(SELECT 1 FROM public.growth_wa_cart_holdout_unit WHERE run_key=OLD.run_key) THEN
  RAISE EXCEPTION 'HOLDOUT_PROTOCOL_ALREADY_ENROLLED';
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS growth_wa_cart_holdout_freeze ON public.growth_wa_cart_holdout_run;
CREATE TRIGGER growth_wa_cart_holdout_freeze BEFORE UPDATE ON public.growth_wa_cart_holdout_run
FOR EACH ROW EXECUTE FUNCTION public.growth_wa_cart_holdout_freeze_v1();

-- The SQL caller supplies ONLY rows that passed the existing eligibility rules.
-- A batch records the complete eligible population before the existing send limit.
-- No send reservation, subscriber flags, email flow or WhatsApp contact is mutated.
CREATE OR REPLACE FUNCTION public.growth_wa_cart_holdout_gate_v1(p_brand text,p_candidates jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $fn$
DECLARE
 cfg public.growth_wa_cart_holdout_run%ROWTYPE;
 journey public.growth_wa_cart_holdout_journey%ROWTYPE;
 candidate jsonb;
 decisions jsonb='{}'::jsonb;
 v_ref text;v_piece text;v_key text;v_unit text;v_bucket integer;v_arm text;
 v_subscriber bigint;v_cart_at timestamptz;v_phone text;v_now timestamptz=statement_timestamp();
BEGIN
 IF p_brand NOT IN ('aristo','fish') OR p_brand IS NULL OR jsonb_typeof(p_candidates) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'HOLDOUT_INVALID_INPUT';
 END IF;
 SELECT * INTO STRICT cfg FROM public.growth_wa_cart_holdout_run
 WHERE run_key='wa-cart-20260924-v1' FOR SHARE;
 FOR candidate IN SELECT value FROM jsonb_array_elements(p_candidates) LOOP
  v_ref=candidate->>'cart_ref';v_piece=candidate->>'piece';v_phone=candidate->>'phone';
  IF coalesce(v_ref,'')='' OR v_piece NOT IN ('carrinho-30min','carrinho-24h') OR v_piece IS NULL
     OR coalesce(candidate->>'subscriber_id','') !~ '^[1-9][0-9]*$'
     OR coalesce(v_phone,'') !~ '^55[0-9]{10,11}$' THEN RAISE EXCEPTION 'HOLDOUT_INVALID_CANDIDATE'; END IF;
  v_subscriber=(candidate->>'subscriber_id')::bigint;
  v_cart_at=(candidate->>'cart_at')::timestamptz;
  IF v_cart_at IS NULL OR v_cart_at>v_now THEN RAISE EXCEPTION 'HOLDOUT_INVALID_CART_TIME';END IF;
  v_key=v_subscriber::text||'|'||v_ref||'|'||v_piece;
  v_arm=NULL;
  -- A cart keeps its original allocation even if its phone/subscriber is updated.
  SELECT * INTO journey FROM public.growth_wa_cart_holdout_journey j
   WHERE j.run_key=cfg.run_key AND j.brand=p_brand AND j.cart_ref=v_ref;
  IF NOT FOUND AND cfg.enrollment_enabled AND v_now>=cfg.starts_at AND v_now<cfg.enrollment_ends_at
     AND v_cart_at>=cfg.starts_at AND v_piece='carrinho-30min'
     AND NOT EXISTS(SELECT 1 FROM public.shrigma_send_log l
       WHERE l.brand=p_brand AND l.channel='whatsapp' AND l.flow='carrinho' AND l.ref=v_ref
         AND l.piece IN ('carrinho-30min','carrinho-24h')) THEN
   -- Pseudonymous person/brand key; the source phone is never stored here.
   v_unit=md5(cfg.allocation_salt::text||'|'||p_brand||'|'||v_phone);
   v_bucket=(('x'||substr(md5('bucket|'||v_unit),1,8))::bit(32)::bigint % 10000)::integer;
   INSERT INTO public.growth_wa_cart_holdout_unit(run_key,brand,unit_key,bucket,arm,first_eligible_at)
    VALUES(cfg.run_key,p_brand,v_unit,v_bucket,CASE WHEN v_bucket<cfg.holdout_bps THEN 'holdout' ELSE 'treatment' END,v_now)
    ON CONFLICT DO NOTHING;
   INSERT INTO public.growth_wa_cart_holdout_journey(run_key,brand,cart_ref,unit_key,subscriber_id,cart_at,first_eligible_at)
    VALUES(cfg.run_key,p_brand,v_ref,v_unit,v_subscriber,v_cart_at,v_now) ON CONFLICT DO NOTHING;
   -- Read the winner after a concurrent enrollment, never trust a proposed arm.
   SELECT * INTO STRICT journey FROM public.growth_wa_cart_holdout_journey j
    WHERE j.run_key=cfg.run_key AND j.brand=p_brand AND j.cart_ref=v_ref;
  END IF;
  IF journey.cart_ref IS NOT NULL THEN
   SELECT u.arm INTO STRICT v_arm FROM public.growth_wa_cart_holdout_unit u
    WHERE u.run_key=journey.run_key AND u.brand=journey.brand AND u.unit_key=journey.unit_key;
   INSERT INTO public.growth_wa_cart_holdout_eligibility(run_key,brand,cart_ref,piece,first_eligible_at)
    VALUES(cfg.run_key,p_brand,v_ref,v_piece,v_now) ON CONFLICT DO NOTHING;
  END IF;
  decisions=decisions||jsonb_build_object(v_key,jsonb_build_object('send',v_arm IS DISTINCT FROM 'holdout','arm',coalesce(v_arm,'outside_experiment')));
 END LOOP;
 RETURN decisions;
END $fn$;
REVOKE ALL ON FUNCTION public.growth_wa_cart_holdout_gate_v1(text,jsonb) FROM PUBLIC;
COMMIT;
