-- Change only the presentation default. Both computed models and order history stay intact.
DO $migration$
DECLARE definition text;updated text;
BEGIN
 SELECT pg_get_viewdef('public.crm_attribution_payload_v2'::regclass,true) INTO definition;
 IF definition ~ '''default_model''\s*,\s*''last_click''' THEN RETURN;END IF;
 updated=regexp_replace(definition,'''default_model''\s*,\s*''last_non_direct''','''default_model'', ''last_click''');
 IF updated=definition THEN RAISE EXCEPTION 'ATTRIBUTION_DEFAULT_DEFINITION_UNEXPECTED';END IF;
 EXECUTE 'CREATE OR REPLACE VIEW public.crm_attribution_payload_v2 AS '||updated;
END $migration$;
