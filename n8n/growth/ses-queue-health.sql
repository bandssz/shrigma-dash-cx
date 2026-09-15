ALTER TABLE public.shrigma_email_consumer_health ADD COLUMN IF NOT EXISTS queue_checked_at timestamptz;
ALTER TABLE public.shrigma_email_consumer_health ADD COLUMN IF NOT EXISTS queue_visible integer;
ALTER TABLE public.shrigma_email_consumer_health ADD COLUMN IF NOT EXISTS queue_inflight integer;
ALTER TABLE public.shrigma_email_consumer_health ADD COLUMN IF NOT EXISTS queue_delayed integer;
ALTER TABLE public.shrigma_email_consumer_health ADD COLUMN IF NOT EXISTS queue_error_at timestamptz;
ALTER TABLE public.shrigma_email_consumer_health ADD COLUMN IF NOT EXISTS queue_diagnostic jsonb;
CREATE OR REPLACE FUNCTION public.shrigma_email_queue_health(r jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE a jsonb;
BEGIN
 IF jsonb_typeof(r->'data')='string' THEN
  BEGIN r=(r->>'data')::jsonb;EXCEPTION WHEN invalid_text_representation THEN NULL;END;
 END IF;
 IF jsonb_typeof(r->'body')='object' THEN r=r->'body';END IF;
 a=r->'Attributes';
 IF coalesce(a->>'ApproximateNumberOfMessages','') !~ '^[0-9]{1,9}$'
 OR coalesce(a->>'ApproximateNumberOfMessagesNotVisible','') !~ '^[0-9]{1,9}$'
 OR coalesce(a->>'ApproximateNumberOfMessagesDelayed','') !~ '^[0-9]{1,9}$' THEN
  INSERT INTO public.shrigma_email_consumer_health(key,queue_error_at,queue_diagnostic) VALUES('ses-events',clock_timestamp(),jsonb_build_object('input_keys',(SELECT jsonb_agg(k) FROM jsonb_object_keys(r) k),'error',r->'error','body_type',jsonb_typeof(r->'body'),'data_type',jsonb_typeof(r->'data')))
  ON CONFLICT(key) DO UPDATE SET queue_error_at=excluded.queue_error_at,queue_diagnostic=excluded.queue_diagnostic;
  RETURN false;
 END IF;
 INSERT INTO public.shrigma_email_consumer_health(key,queue_checked_at,queue_visible,queue_inflight,queue_delayed)
 VALUES('ses-events',clock_timestamp(),(a->>'ApproximateNumberOfMessages')::int,(a->>'ApproximateNumberOfMessagesNotVisible')::int,(a->>'ApproximateNumberOfMessagesDelayed')::int)
 ON CONFLICT(key) DO UPDATE SET queue_checked_at=excluded.queue_checked_at,queue_visible=excluded.queue_visible,queue_inflight=excluded.queue_inflight,queue_delayed=excluded.queue_delayed;
 RETURN true;
END $f$;
REVOKE ALL ON FUNCTION public.shrigma_email_queue_health(jsonb) FROM PUBLIC;
