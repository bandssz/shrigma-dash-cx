IF after_state IS DISTINCT FROM expected OR NOT crm_audience_v2.regular_delivery_permanently_excluded('0d8c77b2-18e7-474f-b9b7-bbfc733bac2f',174)
 OR crm_audience_v2.selection_worker_context(174) IS DISTINCT FROM initial_context THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_POST_DISPOSITION_DRIFT'; END IF;
