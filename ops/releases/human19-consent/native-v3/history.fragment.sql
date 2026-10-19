 SELECT jsonb_build_object('list_id',l.id,'list_uuid',l.uuid,'audience_id',r.payload->>'id',
  'audience_version',r.payload->'expected_version','definition_hash',r.payload->>'expected_definition_hash',
  'request_hash',r.payload_hash,'request_actor',r.actor,'request_key',r.operation_key,'list_hash',r.payload_hash,
  'freeze_contract','crm-native-frozen-list-v3','eligible_count',x.v->'eligible_count',
  'list_optin',x.v->>'list_optin','base',x.v->'base','origins',x.v->'origins',
  'members_sha256',x.v->>'members_sha256','members_state_sha256',x.v->>'members_state_sha256',
  'members_identity_sha256',x.v->>'members_identity_sha256','members_meta_sha256',x.v->>'members_meta_sha256')
 FROM public.campaigns c JOIN public.campaign_lists cl ON cl.campaign_id=c.id
 JOIN public.lists l ON l.id=cl.list_id JOIN crm_audience_v2.request r ON r.brand=c.attribs#>>'{crm,brand}'
 CROSS JOIN LATERAL (SELECT r.response->'_body' v)x
 WHERE c.id=pid AND pid NOT IN(185,188,189,190,191,198)
  AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}' IN('fish','aristo')
  AND c.type::text='regular' AND c.messenger='email' AND c.sent=0 AND c.started_at IS NULL
  AND x.v->>'contract'='crm-native-frozen-list-v3' AND r.response->'_http'='200'::jsonb
  AND c.created_at>=(x.v->>'frozen_at')::timestamptz
  AND EXISTS(SELECT 1 FROM public.shrigma_campaign_operation o WHERE o.id::text=c.attribs#>>'{crm,created_operation_id}'
   AND o.actor=r.actor AND o.action='salvar' AND o.state='succeeded' AND o.provider_id=c.id AND o.brand=r.brand
   AND o.response->'status'='201'::jsonb
   AND o.response#>>'{body,operation_id}'=o.id::text
   AND o.response#>'{body,campaign,id}'=to_jsonb(c.id)
   AND o.response#>>'{body,campaign,definition,brand}'=r.brand
   AND o.response#>'{body,campaign,definition,list_ids}'=jsonb_build_array(l.id)
   AND o.created_at>=(x.v->>'frozen_at')::timestamptz)
  AND (SELECT count(*) FROM public.campaign_lists z WHERE z.campaign_id=c.id)=1
  AND public.shrigma_campaign_list_brand(l)=r.brand
  AND r.payload->>'acao'='segmento_congelar_nativo_interno' AND r.payload->>'brand'=r.brand
  AND r.payload->>'idempotency_key'=r.operation_key AND x.v->>'brand'=r.brand
  AND x.v->>'list_id'=l.id::text AND x.v->>'list_uuid'=l.uuid::text
  AND x.v->>'audience_id'=r.payload->>'id' AND x.v->'audience_version'=r.payload->'expected_version'
  AND x.v->>'definition_hash'=r.payload->>'expected_definition_hash'
  AND x.v->>'definition_hash'~'^[a-f0-9]{64}$' AND r.payload->>'expected_context_hash'~'^[a-f0-9]{64}$'
  AND r.payload->>'expected_catalog_hash'~'^[a-f0-9]{64}$'
  AND x.v->'sends'='false'::jsonb AND x.v->'schedules'='false'::jsonb
  AND x.v->>'eligible_count'~'^[1-9][0-9]{0,9}$' AND x.v->>'list_optin' IN('single','double')
  AND jsonb_typeof(x.v->'base')='object' AND jsonb_typeof(x.v->'origins')='array'
  AND x.v#>>'{base,id}'=CASE r.brand WHEN 'aristo' THEN '16' ELSE '17' END
  AND x.v#>>'{base,optin}'=x.v->>'list_optin'
  AND jsonb_array_length(x.v->'origins')>=1
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(x.v->'origins') o WHERE o=x.v->'base')
  AND (SELECT count(DISTINCT o->>'id') FROM jsonb_array_elements(x.v->'origins') o)=jsonb_array_length(x.v->'origins')
  AND x.v->>'members_sha256'~'^[a-f0-9]{64}$' AND x.v->>'members_state_sha256'~'^[a-f0-9]{64}$'
  AND x.v->>'members_identity_sha256'~'^[a-f0-9]{64}$' AND x.v->>'members_meta_sha256'~'^[a-f0-9]{64}$'
  AND r.payload_hash=encode(sha256(convert_to((SELECT '{'||string_agg(to_json(e.k)::text||':'||e.v::text,',' ORDER BY e.k COLLATE "C")||'}' FROM jsonb_each(r.payload)e(k,v)),'UTF8')),'hex')
