-- Additive permissions for the authenticated API; install atomically while OFF.
-- Native contacts, consent, content, settings and schedules remain read-only.
DO $install$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_audience_api' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole)
  OR to_regprocedure('crm_audience_v2.ab_regular_schedule(uuid,text)') IS NULL
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign) THEN
  RAISE EXCEPTION 'AB_AUDIENCE_ACCESS_UNAVAILABLE';
 END IF;
 GRANT SELECT,INSERT ON public.crm_ab_experiment_v2,public.crm_ab_arm_v2,public.crm_ab_member_v2,
  crm_audience_v2.ab_scope,crm_audience_v2.ab_request,crm_audience_v2.ab_review,crm_audience_v2.ab_review_request,
  crm_audience_v2.ab_regular_review,crm_audience_v2.ab_regular_request,crm_audience_v2.ab_panel_request TO crm_audience_api;
 -- PostgreSQL row locks require one UPDATE column. Experiment/member identity
 -- is immutable under the existing guards; only the initial arm count is set.
 GRANT UPDATE(test_id) ON public.crm_ab_experiment_v2,public.crm_ab_member_v2 TO crm_audience_api;
 GRANT UPDATE(allocated_count) ON public.crm_ab_arm_v2 TO crm_audience_api;
 GRANT SELECT ON crm_audience_v2.ab_regular_pair TO crm_audience_api;
 GRANT USAGE ON SEQUENCE crm_audience_v2.ab_review_review_sequence_seq TO crm_audience_api;
 GRANT EXECUTE ON FUNCTION public.crm_ab_protocol_valid_v2(jsonb),public.crm_ab_snapshot_v2(uuid),public.crm_ab_measure_v2(uuid),
  crm_audience_v2.ab_regular_tracking(),crm_audience_v2.ab_regular_ready(text),crm_audience_v2.ab_regular_schedule(uuid,text),crm_audience_v2.ab_regular_lifecycle(uuid,integer,text,text),
  crm_audience_v2.ab_audience_cohort_source(text,integer[],integer,jsonb),crm_audience_v2.ab_audience_allocated_source(text,integer[],uuid,integer,jsonb),
  crm_audience_v2.ab_material_campaigns(integer[]),crm_audience_v2.ab_material_list_links(integer[]),crm_audience_v2.ab_material_media_links(integer[]),
  crm_audience_v2.ab_material_lists(integer[]),crm_audience_v2.ab_material_templates(integer[]),crm_audience_v2.ab_material_media(integer[]) TO crm_audience_api;
END $install$;
