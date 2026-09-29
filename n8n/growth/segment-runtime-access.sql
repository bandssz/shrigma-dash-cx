-- Fresh-only, additive service access. Execute only as part of a reviewed
-- atomic installation; provision the login secret separately, never in Git.
DO $install$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='crm_audience_api')
  OR pg_catalog.to_regprocedure('crm_audience_v2.refresh_native_catalog(text)') IS NOT NULL
  OR pg_catalog.to_regclass('crm_audience_v2.campaign_binding') IS NULL THEN
  RAISE EXCEPTION 'SEGMENT_RUNTIME_INSTALL_COLLISION_OR_DEPENDENCY';
 END IF;
 CREATE ROLE crm_audience_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
 ALTER ROLE crm_audience_api SET statement_timeout='10s';
 ALTER ROLE crm_audience_api SET lock_timeout='500ms';
 ALTER ROLE crm_audience_api SET idle_in_transaction_session_timeout='15s';
GRANT USAGE ON SCHEMA public,crm_audience_v2 TO crm_audience_api;
GRANT SELECT ON crm_audience_v2.audience,crm_audience_v2.revision,crm_audience_v2.request,
 crm_audience_v2.campaign_binding,crm_audience_v2.campaign_binding_revision,crm_audience_v2.campaign_binding_request TO crm_audience_api;
GRANT INSERT,UPDATE ON crm_audience_v2.audience,crm_audience_v2.campaign_binding TO crm_audience_api;
GRANT INSERT ON crm_audience_v2.revision,crm_audience_v2.request,crm_audience_v2.campaign_binding_revision,crm_audience_v2.campaign_binding_request TO crm_audience_api;
GRANT SELECT ON public.lists,public.campaigns,public.campaign_lists,public.templates,public.media,public.campaign_media,public.crm_familia_campanha TO crm_audience_api;
GRANT SELECT(id,status) ON public.subscribers TO crm_audience_api;
GRANT SELECT(subscriber_id,list_id,status) ON public.subscriber_lists TO crm_audience_api;
GRANT SELECT(subscriber_id,campaign_id,created_at) ON public.campaign_views,public.link_clicks TO crm_audience_api;
GRANT EXECUTE ON FUNCTION crm_audience_v2.authenticate(text),public.shrigma_campaign_list_brand(public.lists),
 public.shrigma_campaign_provider(text,jsonb),public.shrigma_campaign_current(integer),public.shrigma_campaign_catalog(text),
 crm_audience_v2.campaign_snapshot(integer,boolean),crm_audience_v2.touch_campaign(integer),crm_audience_v2.config_snapshot(text),crm_audience_v2.catalog_lists(text),crm_audience_v2.lock_campaign_dependencies(integer) TO crm_audience_api;

EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.refresh_native_catalog(b text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE c crm_audience_v2.config%ROWTYPE; expected jsonb; at timestamptz;
BEGIN
 IF b IS NULL OR b NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_BRAND'; END IF;
 expected:=CASE b
 WHEN 'fish' THEN '{"currency":null,"timezone":null,"shop_id":null,"fields":[{"key":"purchase.count","available":false,"source_hash":null},{"key":"purchase.last_date","available":false,"source_hash":null},{"key":"purchase.amount","available":false,"source_hash":null},{"key":"purchase.product","available":false,"source_hash":null},{"key":"signup.origin","available":false,"source_hash":null},{"key":"email.opened","available":true,"source_hash":"b9ec8cdafb47449f8001b1354cbef3e59db236fd91c9e6db3d817cdf8a6dd3f5"},{"key":"email.clicked","available":true,"source_hash":"640a55ed1c7bea3a7d7ee7b7ff0e2e2a250fa78af1018dedadd53cdf1dfc602d"}],"products":[],"origins":[]}'::jsonb
 WHEN 'aristo' THEN '{"currency":null,"timezone":null,"shop_id":null,"fields":[{"key":"purchase.count","available":false,"source_hash":null},{"key":"purchase.last_date","available":false,"source_hash":null},{"key":"purchase.amount","available":false,"source_hash":null},{"key":"purchase.product","available":false,"source_hash":null},{"key":"signup.origin","available":false,"source_hash":null},{"key":"email.opened","available":true,"source_hash":"090e2d886df88c1137c54bbe245006533f9ed4b01b25ef1e00f1ca5907c275a2"},{"key":"email.clicked","available":true,"source_hash":"59a67dadaa030a2cfb2a140e217ca0cface5b511dd385ac0a797db6dcee95572"}],"products":[],"origins":[]}'::jsonb
 END;
 SELECT * INTO c FROM crm_audience_v2.config WHERE brand=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_CONFIG'; END IF;
 IF NOT c.enabled THEN RETURN; END IF;
 IF c.catalog IS DISTINCT FROM expected OR c.base_list_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.lists l WHERE l.id=c.base_list_id AND public.shrigma_campaign_list_brand(l)=b AND l.status::text='active' AND l.optin::text IN ('single','double')) THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_SOURCE'; END IF;
 -- Static native event semantics with live data on every count. No Shopify or
 -- signup provenance is inferred or silently marked available by this refresh.
 PERFORM subscriber_id,campaign_id,created_at FROM public.campaign_views LIMIT 0;
 PERFORM subscriber_id,campaign_id,created_at FROM public.link_clicks LIMIT 0;
 at:=clock_timestamp();
 IF c.checked_at<=at AND c.expires_at>at+interval '2 minutes' THEN RETURN; END IF;
 SELECT * INTO c FROM crm_audience_v2.config WHERE brand=b FOR UPDATE;
 IF NOT c.enabled OR c.catalog IS DISTINCT FROM expected THEN RAISE EXCEPTION 'SEGMENT_RUNTIME_SOURCE'; END IF;
 UPDATE crm_audience_v2.config SET checked_at=clock_timestamp(),expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=b;
END $fn$$ddl$;
REVOKE ALL ON FUNCTION crm_audience_v2.refresh_native_catalog(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_audience_v2.refresh_native_catalog(text) TO crm_audience_api;
END $install$;
