-- Include brand-isolated Olivas votes without replacing Fish/Aristo attributes.
CREATE OR REPLACE VIEW public.shrigma_nps_reporting AS
SELECT attribs FROM subscribers WHERE attribs ? 'nps'
UNION ALL
SELECT jsonb_build_object('nps',attribs->'nps_olivas') AS attribs
FROM subscribers WHERE attribs->'nps_olivas'->>'brand'='olivas';
