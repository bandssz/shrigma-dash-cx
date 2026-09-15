-- Classify in PostgreSQL: n8n expressions support a smaller syntax than JavaScript.
CREATE OR REPLACE FUNCTION public.shrigma_email_transport_outcome(response jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE code int;body jsonb=response->'body';
BEGIN
 IF coalesce(response->>'statusCode','') ~ '^[0-9]{3}$' THEN code=(response->>'statusCode')::int;END IF;
 IF jsonb_typeof(body)='string' THEN
  BEGIN body=(response->>'body')::jsonb;EXCEPTION WHEN invalid_text_representation THEN body=NULL;END;
 END IF;
 IF code BETWEEN 200 AND 299 AND body->'data'='true'::jsonb THEN RETURN 'accepted';END IF;
 IF code IN (400,401,403,404,422) THEN RETURN 'rejected';END IF;
 RETURN 'outcome_unknown';
END $f$;
REVOKE ALL ON FUNCTION public.shrigma_email_transport_outcome(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.shrigma_email_finish_engagement_http(p_id uuid,p_claim uuid,response jsonb,b jsonb)
RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text)
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
 SELECT * FROM public.shrigma_email_finish_engagement(p_id,p_claim,public.shrigma_email_transport_outcome(response),b);
$f$;
REVOKE ALL ON FUNCTION public.shrigma_email_finish_engagement_http(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
