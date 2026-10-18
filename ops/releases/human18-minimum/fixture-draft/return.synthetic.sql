DO $fence$ BEGIN IF current_database() !~ '^native17_test[0-9]+$' THEN RAISE EXCEPTION 'DRAFT_SYNTHETIC_DATABASE_REQUIRED';END IF;END $fence$;
CREATE OR REPLACE FUNCTION public.shrigma_campaign_draft_save_v1(a text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='500ms' AS $closed$ BEGIN RAISE EXCEPTION 'DRAFT_WRITES_DISABLED';END $closed$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_draft_save_v1(text,jsonb) FROM PUBLIC,crm_campaign_api,crm_audience_api;
