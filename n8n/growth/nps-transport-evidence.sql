-- Permanent transport evidence; no response headers. Canonical claim context stays
-- private in the CRM database so a failed finalization can be recovered without resending.
CREATE TABLE IF NOT EXISTS public.shrigma_email_transport_evidence(
 dispatch_id uuid PRIMARY KEY REFERENCES public.shrigma_email_dispatch(dispatch_id),
 response_sha256 text NOT NULL, http_status int, outcome text NOT NULL,
 reason text NOT NULL, context jsonb NOT NULL, observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION public.shrigma_email_engagement_diagnosis(response jsonb,b jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE code int;body jsonb=response->'body';outcome text;reason text;
BEGIN
 IF coalesce(response->>'statusCode','')~'^[0-9]{3}$' THEN code=(response->>'statusCode')::int;END IF;
 IF jsonb_typeof(body)='string' THEN
  BEGIN body=(response->>'body')::jsonb;EXCEPTION WHEN invalid_text_representation THEN body=NULL;END;
 END IF;
 outcome=public.shrigma_email_transport_outcome(response);
 reason=CASE outcome WHEN 'accepted' THEN 'provider_accepted' WHEN 'rejected' THEN 'http_rejected' ELSE 'transport_unconfirmed' END;
 -- Listmonk v6.1 PushMessage returns this exact failure before enqueueing.
 -- Scope this exception to the existing one-recipient NPS transport contract.
 IF code=500 AND body->>'message'='message push timed out' AND b->>'flow'='nps'
  AND b->>'piece' IN ('nps-d0','nps-d3') AND jsonb_typeof(b#>'{tx,subscriber_email}')='string'
  AND lower(b#>>'{tx,subscriber_email}')=lower(b->>'email')
  AND NOT (b->'tx' ? 'subscriber_emails') AND NOT (b->'tx' ? 'subscriber_ids') THEN
  outcome='rejected';reason='listmonk_queue_busy_before_enqueue';
 END IF;
 RETURN jsonb_build_object('http_status',code,'outcome',outcome,'reason',reason);
END $f$;
REVOKE ALL ON FUNCTION public.shrigma_email_engagement_diagnosis(jsonb,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.shrigma_email_observe_engagement(p_id uuid,p_claim uuid,p_response jsonb,b jsonb)
RETURNS TABLE(dispatch_id uuid,claim_token uuid,response jsonb,context jsonb)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE d public.shrigma_email_dispatch%ROWTYPE;diag jsonb;hash text;existing text;
BEGIN
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id FOR UPDATE;
 IF d.claim_token IS DISTINCT FROM p_claim OR p_claim IS NULL OR d.flow<>'nps'
  OR d.payload_sha256 IS DISTINCT FROM encode(digest(convert_to(b::text,'UTF8'),'sha256'),'hex')
  OR d.brand IS DISTINCT FROM b->>'brand' THEN RAISE EXCEPTION 'NPS_EVIDENCE_CONTEXT_MISMATCH';END IF;
 IF jsonb_typeof(p_response) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'NPS_EVIDENCE_RESPONSE_INVALID';END IF;
 diag=public.shrigma_email_engagement_diagnosis(p_response,b);
 hash=encode(digest(convert_to(p_response::text,'UTF8'),'sha256'),'hex');
 SELECT e.response_sha256 INTO existing FROM public.shrigma_email_transport_evidence e WHERE e.dispatch_id=p_id;
 IF FOUND AND existing<>hash THEN RAISE EXCEPTION 'NPS_EVIDENCE_RESPONSE_CONFLICT';END IF;
 INSERT INTO public.shrigma_email_transport_evidence(dispatch_id,response_sha256,http_status,outcome,reason,context)
 VALUES(p_id,hash,(diag->>'http_status')::int,diag->>'outcome',diag->>'reason',b) ON CONFLICT DO NOTHING;
 RETURN QUERY SELECT p_id,p_claim,p_response,b;
END $f$;
REVOKE ALL ON FUNCTION public.shrigma_email_observe_engagement(uuid,uuid,jsonb,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.shrigma_email_finish_engagement_http(p_id uuid,p_claim uuid,response jsonb,b jsonb)
RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE diag jsonb;r record;
BEGIN
 diag=public.shrigma_email_engagement_diagnosis(response,b);
 SELECT * INTO r FROM public.shrigma_email_finish_engagement(p_id,p_claim,diag->>'outcome',b);
 IF diag->>'reason'='listmonk_queue_busy_before_enqueue' AND r.transport_state='rejected' THEN
  UPDATE public.shrigma_email_dispatch d SET error_code='LISTMONK_QUEUE_BUSY' WHERE d.dispatch_id=p_id;
  r.error_code='LISTMONK_QUEUE_BUSY';
 END IF;
 RETURN QUERY SELECT r.dispatch_id,r.transport_state,r.send_log_id,r.error_code;
END $f$;
REVOKE ALL ON FUNCTION public.shrigma_email_finish_engagement_http(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
