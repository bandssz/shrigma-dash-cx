-- Temporary Aristo product-field quarantine. Preserve all semantic pins so the
-- aggregate dispatcher remains selected for scalar Shopify rules.
DO $upgrade$
DECLARE d text;needle text;replacement text;n integer;
BEGIN
 IF current_user<>'postgres' OR current_setting('server_version_num')<>'170010' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_QUARANTINE_CONTEXT'; END IF;
 LOCK TABLE crm_audience_v2.shopify_source,crm_audience_v2.config,crm_audience_v2.regular_worker_deployment,crm_audience_v2.regular_delivery_campaign,crm_audience_v2.selection_runtime,crm_audience_v2.shopify_sync_operation,crm_audience_v2.shopify_sync_mutex,crm_audience_v2.audience,crm_audience_v2.revision IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled) OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled) OR EXISTS(SELECT 1 FROM crm_audience_v2.selection_runtime WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.shopify_sync_operation WHERE state NOT IN('completed','blocked'))
  OR EXISTS(SELECT 1 FROM crm_audience_v2.shopify_sync_mutex WHERE operation_id IS NOT NULL OR lease_token IS NOT NULL OR lease_until IS NOT NULL) THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_QUARANTINE_REQUIRES_IDLE'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_catalog(text,jsonb)')) IS DISTINCT FROM '9aaa4ce1ad23bd79f9bfca24167f16c4'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_source_current(text,text,text)')) IS DISTINCT FROM '59b6fbf4aa650d40af618a0f9cbb025f'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_customer_match(jsonb,integer,text,text)')) IS DISTINCT FROM 'e090ec840509027df6698dde18ce96fc'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)')) IS DISTINCT FROM '3d8b7d13f82477ce803a27dc7db9b74e'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)')) IS DISTINCT FROM '3f037e001887923c953521334697ba9e' THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_QUARANTINE_BASE_DRIFT'; END IF;

 d:=pg_get_functiondef('crm_audience_v2.shopify_catalog(text,jsonb)'::regprocedure);needle:='product_ready:=coalesce(cfg.field_hashes->>''purchase.product''=crm_audience_v2.shopify_source_hash(b,''purchase.product'',composed)';replacement:='product_ready:=coalesce(b<>''aristo'' AND cfg.field_hashes->>''purchase.product''=crm_audience_v2.shopify_source_hash(b,''purchase.product'',composed)';n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_QUARANTINE_REWRITE';END IF;EXECUTE replace(d,needle,replacement);
 d:=pg_get_functiondef('crm_audience_v2.shopify_source_current(text,text,text)'::regprocedure);needle:='SELECT coalesce((SELECT s.enabled AND pin IS NOT NULL';replacement='SELECT coalesce((SELECT NOT (b=''aristo'' AND field=''purchase.product'') AND s.enabled AND pin IS NOT NULL';n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_QUARANTINE_REWRITE';END IF;EXECUTE replace(d,needle,replacement);
 d:=pg_get_functiondef('crm_audience_v2.shopify_customer_match(jsonb,integer,text,text)'::regprocedure);needle:='IF NOT crm_audience_v2.shopify_rule_valid(rule) OR sid IS NULL OR sid<1 OR b IS NULL OR b NOT IN(''fish'',''aristo'') THEN RETURN NULL; END IF;';replacement:=needle||E'\n IF b=''aristo'' AND rule->>''field''=''purchase.product'' THEN RETURN NULL; END IF;';n:=(length(d)-length(replace(d,needle,'')))/length(needle);IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_PRODUCT_QUARANTINE_REWRITE';END IF;EXECUTE replace(d,needle,replacement);
 PERFORM crm_audience_v2.refresh_native_catalog('aristo');
END $upgrade$;
