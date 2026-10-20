\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\o /tmp/shrigma-native-write-guards-return-20261020.sql
SELECT 'BEGIN;';
SELECT pg_get_functiondef('public.shrigma_campaign_guard()'::regprocedure)||';';
SELECT 'DROP TRIGGER IF EXISTS '||quote_ident(t.tgname)||' ON '||t.tgrelid::regclass||';'||E'\n'||pg_get_triggerdef(t.oid)||';'
FROM pg_trigger t
WHERE t.tgrelid IN ('public.campaigns'::regclass,'public.campaign_lists'::regclass,'public.campaign_media'::regclass)
AND t.tgname IN ('shrigma_campaign_write_guard','shrigma_campaign_lists_guard','shrigma_campaign_media_guard')
ORDER BY t.tgname;
SELECT 'COMMIT;';
\o
BEGIN;
-- Remove the custom refusal. Keep only the existing receipt callback so
-- accounts outside the rollout can still finish their previous operator.
CREATE OR REPLACE FUNCTION public.shrigma_campaign_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog,public AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND public.shrigma_campaign_is_managed(OLD)
    AND current_setting('shrigma.campaign_writer',true) IS DISTINCT FROM OLD.id::text THEN
  PERFORM crm_audience_v2.native_internal_before_v1(OLD,NEW);
 END IF;
 RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS shrigma_campaign_write_guard ON public.campaigns;
CREATE TRIGGER shrigma_campaign_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.campaigns
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_guard();
DROP TRIGGER IF EXISTS shrigma_campaign_lists_guard ON public.campaign_lists;
DROP TRIGGER IF EXISTS shrigma_campaign_media_guard ON public.campaign_media;
COMMIT;
SELECT 'Native Listmonk writes restored; existing receipt callback retained; campaign and customer rows unchanged.';
