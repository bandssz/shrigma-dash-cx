-- Narrow follow-up to the PR191 count wrapper. It rewrites exactly one CTE
-- annotation in the installed aggregate function and changes no schema/data.
DO $inline$
DECLARE target regprocedure:='crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb)'::regprocedure;
 definition text;needle text:='shopify_facts AS MATERIALIZED (';replacement text:='shopify_facts AS NOT MATERIALIZED (';
BEGIN
 IF current_user<>'postgres' OR current_setting('server_version_num')<>'170010'
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.selection_runtime WHERE enabled) THEN RAISE EXCEPTION 'SHOPIFY_COUNT_INLINE_REQUIRES_OFF'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.shopify_count_rule_sql(jsonb,jsonb,integer)')) IS DISTINCT FROM '3d8b7d13f82477ce803a27dc7db9b74e'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=target) IS DISTINCT FROM '3f037e001887923c953521334697ba9e' THEN RAISE EXCEPTION 'SHOPIFY_COUNT_INLINE_BASE_DRIFT'; END IF;
 SELECT pg_get_functiondef(target) INTO STRICT definition;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SHOPIFY_COUNT_INLINE_DEFINITION_DRIFT'; END IF;
 EXECUTE replace(definition,needle,replacement);
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=target) IS DISTINCT FROM '11b415da695e3674c808632e61c25799' THEN RAISE EXCEPTION 'SHOPIFY_COUNT_INLINE_RESULT_DRIFT'; END IF;
END $inline$;
