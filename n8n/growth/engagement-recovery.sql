-- Explicit repair requires captured HTTP acceptance, claim/context match and SES delivery. Never resends.
CREATE TABLE IF NOT EXISTS public.shrigma_email_finalization_recovery(
 dispatch_id uuid PRIMARY KEY REFERENCES public.shrigma_email_dispatch(dispatch_id),execution_id text NOT NULL,
 evidence_sha256 text NOT NULL,before_state jsonb NOT NULL,applied_at timestamptz NOT NULL DEFAULT now(),reason text NOT NULL);

CREATE OR REPLACE FUNCTION public.shrigma_email_recover_finalizations(records jsonb,dry_run boolean DEFAULT true)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE x jsonb;d public.shrigma_email_dispatch%ROWTYPE;r record;n int=0;
BEGIN
 BEGIN
 FOR x IN SELECT value FROM jsonb_array_elements(records) LOOP
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE dispatch_id=(x->>'dispatch_id')::uuid FOR UPDATE;
 IF d.transport_state='accepted' THEN CONTINUE;END IF;
 IF d.transport_state<>'in_flight' OR d.is_test OR d.claim_token IS DISTINCT FROM (x->>'claim_token')::uuid OR public.shrigma_email_transport_outcome(x->'response')<>'accepted'
 OR NOT EXISTS(SELECT 1 FROM public.shrigma_email_status s WHERE s.dispatch_id=d.dispatch_id AND NOT s.is_test AND s.status='delivery' AND s.reconciliation_status='matched') THEN RAISE EXCEPTION 'RECOVERY_PROOF_INVALID';END IF;
 INSERT INTO public.shrigma_email_finalization_recovery(dispatch_id,execution_id,evidence_sha256,before_state,reason)
 VALUES(d.dispatch_id,x->>'execution_id',x->>'evidence_sha256',to_jsonb(d),'HTTP_ACCEPT_AND_SES_DELIVERY_AFTER_N8N_EXPRESSION_FAILURE');
 SELECT * INTO r FROM public.shrigma_email_finish_engagement_http(d.dispatch_id,d.claim_token,x->'response',x->'context');
 IF r.transport_state<>'accepted' OR r.send_log_id IS NULL THEN RAISE EXCEPTION 'RECOVERY_FINALIZATION_FAILED';END IF;
 n=n+1;
END LOOP;

 IF dry_run THEN RAISE EXCEPTION USING ERRCODE='Z9916',MESSAGE='successful rollback';END IF;
 EXCEPTION WHEN SQLSTATE 'Z9916' THEN NULL;END;
 RETURN n;
END $f$;
REVOKE ALL ON FUNCTION public.shrigma_email_recover_finalizations(jsonb,boolean) FROM PUBLIC;
