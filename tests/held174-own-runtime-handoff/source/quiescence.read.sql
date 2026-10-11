-- Fixed aggregate-only prerequisite. It proves no HTTP/msgQ/SMTP drain.
SELECT jsonb_build_object(
 'regularRunning',(SELECT count(*)::integer FROM public.campaigns WHERE type::text='regular' AND status::text='running'),
 'allFlowReserved',count(*) FILTER(WHERE transport_state='reserved'),
 'allFlowInFlight',count(*) FILTER(WHERE transport_state='in_flight'),
 'allFlowUnknown',count(*) FILTER(WHERE transport_state='outcome_unknown'),
 'checkpointDispatchFingerprint',jsonb_build_object('count',count(*),'md5',md5(coalesce(string_agg(md5(to_jsonb(d)::text),'' ORDER BY dispatch_id),''))))
FROM public.shrigma_email_dispatch d;
