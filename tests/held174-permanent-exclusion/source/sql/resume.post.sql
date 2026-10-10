IF after_state IS DISTINCT FROM expected OR crm_audience_v2.selection_worker_context(cid) IS DISTINCT FROM initial_context THEN RAISE EXCEPTION 'PERMANENT_EXCLUSION_POST_RESUME_DRIFT'; END IF;
