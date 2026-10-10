SELECT pg_catalog.to_jsonb(p) AS function_metadata FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('crm_audience_v2.regular_worker_heartbeat(uuid,text,text)');
