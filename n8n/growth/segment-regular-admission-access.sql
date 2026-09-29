-- Additive grant for an already installed audience API. No native UPDATE grant,
-- worker grant, deployment approval or service restart. Install atomically while OFF.
DO $install$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_audience_api' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole)
  OR to_regprocedure('crm_audience_v2.regular_admission_schedule(uuid,text)') IS NULL
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled) THEN
  RAISE EXCEPTION 'REGULAR_ADMISSION_ACCESS_UNAVAILABLE';
 END IF;
 GRANT SELECT,INSERT ON crm_audience_v2.regular_admission_review,crm_audience_v2.regular_admission_request TO crm_audience_api;
 GRANT EXECUTE ON FUNCTION crm_audience_v2.regular_admission_runtime(text),crm_audience_v2.regular_admission_snapshot(integer),crm_audience_v2.regular_admission_schedule(uuid,text) TO crm_audience_api;
END
$install$;
