SELECT s.email,coalesce(split_part(s.name,' ',1),'') first_name,s.attribs->'nps_sent'->>'brand' brand,s.attribs->'nps_sent'->>'order' order_number
FROM subscribers s WHERE s.status='enabled' AND s.attribs->'nps_sent'->>'brand' IN ('fish','aristo')
AND s.attribs->'nps_sent'->>'date' IS NOT NULL AND (s.attribs->'nps_sent'->>'date')::timestamptz<=now()-interval '3 days'
AND s.attribs->'nps_sent'->>'reminded'='false' AND s.attribs->'nps'->>'order' IS DISTINCT FROM s.attribs->'nps_sent'->>'order'
AND NOT EXISTS(SELECT 1 FROM shrigma_email_dispatch d WHERE d.brand=s.attribs->'nps_sent'->>'brand' AND d.flow='nps' AND d.piece='nps-d3' AND d.dedupe_key=jsonb_build_array('email',s.attribs->'nps_sent'->>'order','order',false)::text)
AND NOT EXISTS(SELECT 1 FROM shrigma_send_log l WHERE l.brand=s.attribs->'nps_sent'->>'brand' AND l.flow='nps' AND l.channel='email' AND l.piece='nps-d3' AND l.ref=s.attribs->'nps_sent'->>'order')
ORDER BY (s.attribs->'nps_sent'->>'date')::timestamptz,s.id LIMIT 200;