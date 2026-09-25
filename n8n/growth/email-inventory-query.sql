-- Published e-mail configuration, independent of event counts and the selected period.
(SELECT coalesce(jsonb_agg(jsonb_build_object(
  'brand',f.brand,'flow_key',f.key,'piece',s->>'piece','template_id',s->>'template_id',
  'published_version',f.published_version,'flow_enabled',f.enabled,'step_enabled',s->'enabled','runtime_ready',f.runtime_ready
) ORDER BY f.brand,f.key,s->>'piece'),'[]'::jsonb)
 FROM public.shrigma_flow_definition f
 CROSS JOIN LATERAL jsonb_array_elements(f.published->'steps') s
 WHERE f.brand IN ('fish','aristo') AND f.binding->>'merged_into' IS NULL
   AND s->>'channel'='email' AND (s->>'is_test' IS NULL OR s->>'is_test'='false')) AS email_steps
