-- Existing function OID/ACL/owner/settings and every original row must survive exactly.
 FOR f IN SELECT key,value FROM jsonb_each(before_state->'functionMetadata') LOOP
  item:=after_state->'functionMetadata'->f.key;
  IF (f.value-'prosrc') IS DISTINCT FROM (item-'prosrc') THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_EXISTING_METADATA_CHANGED'; END IF;
 END LOOP;
 IF (before_state-ARRAY['functionMetadata','exclusionObjects']) IS DISTINCT FROM
 (after_state-ARRAY['functionMetadata','exclusionObjects','permanentExclusions','exclusionTableMetadata','exclusionTriggers'])
 OR after_state->'permanentExclusions' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_INSTALL_STATE_CHANGED'; END IF;
 FOR f IN SELECT key,value FROM jsonb_each(after_state->'functionMetadata') LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(__AFTER_PINS__) p WHERE p->>'signature'=f.key AND p->>'md5'=md5(f.value->>'prosrc')) THEN
   RAISE EXCEPTION 'PERMANENT_EXCLUSION_INSTALL_BODY_DRIFT'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='crm_audience_v2.regular_delivery_permanent_exclusion'::regclass AND NOT tgisinternal)<>2
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='crm_audience_v2.regular_delivery_permanent_exclusion'::regclass AND NOT tgisinternal
  AND (tgenabled<>'O' OR tgfoid<>'crm_audience_v2.regular_delivery_exclusion_immutable()'::regprocedure)) THEN
 RAISE EXCEPTION 'PERMANENT_EXCLUSION_OWN_TRIGGER_DRIFT'; END IF;
