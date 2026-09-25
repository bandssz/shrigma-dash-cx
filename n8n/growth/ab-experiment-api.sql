-- Dedicated Growth A/B API candidate. No shared authentication function changes.
BEGIN;
CREATE FUNCTION public.crm_ab_api_v2(k text,method text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $fn$
DECLARE auth jsonb;actor_id text;b text;tid uuid;oid uuid;r jsonb;state jsonb;rows jsonb;op public.crm_ab_action_v2%ROWTYPE;action text;ready boolean;
BEGIN
 auth:=public.shrigma_panel_operator_v1(k,'growth');
 IF jsonb_typeof(auth->'who') IS DISTINCT FROM 'string' OR coalesce(auth->>'who','')!~'^panel:.+'
  OR jsonb_typeof(auth->'caps') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('status',401,'body',jsonb_build_object('error','AB_V2_MANAGER_REQUIRED'));END IF;
 IF NOT(auth->'caps' ? 'read_content') THEN RETURN jsonb_build_object('status',403,'body',jsonb_build_object('error','AB_V2_CAPABILITY'));END IF;
 actor_id:='panel:'||encode(sha256(convert_to('crm-ab-email-operator-v2:'||(auth->>'who'),'UTF8')),'hex');
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR length(p::text)>32768 OR coalesce(p->>'brand','') NOT IN ('fish','aristo') THEN RETURN jsonb_build_object('status',422,'body',jsonb_build_object('error','AB_V2_REQUEST'));END IF;
 b:=p->>'brand';
 ready:=EXISTS(SELECT 1 FROM public.crm_ab_runtime_v2 WHERE singleton AND enabled AND isfinite(verified_at) AND verified_at<=clock_timestamp()
  AND native_query_sha256='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817');
 IF method='capabilities' AND (p-ARRAY['brand'])='{}' THEN
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('contract','crm-ab-email-v2','brand',b,'enabled',ready,
   'configure',ready AND auth->'caps' ? 'draft','review',auth->'caps' ? 'validate','schedule',ready AND auth->'caps' ? 'submit',
   'cancel',auth->'caps' ? 'submit','close',auth->'caps' ? 'draft','operation',true,'automatic_send',false));
 ELSIF method='operation' AND (p-ARRAY['brand','operation_id','action'])='{}' THEN
  IF coalesce(p->>'operation_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR coalesce(p->>'action','') NOT IN ('prepare','review','schedule','cancel','close') THEN RETURN jsonb_build_object('status',422,'body',jsonb_build_object('error','AB_V2_REQUEST'));END IF;
  oid:=(p->>'operation_id')::uuid;action:=p->>'action';
  SELECT * INTO op FROM public.crm_ab_action_v2 WHERE operation_id=oid AND crm_ab_action_v2.actor=actor_id;
  IF FOUND AND (op.request_payload->>'brand' IS DISTINCT FROM b OR CASE WHEN op.request_payload ? 'allocation' THEN 'prepare' ELSE op.request_payload->>'action' END IS DISTINCT FROM action) THEN
   RETURN jsonb_build_object('status',409,'body',jsonb_build_object('error','AB_V2_IDENTITY'));
  END IF;
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('contract','crm-ab-email-operation-v2','operation',jsonb_build_object(
   'operation_id',oid,'actor',actor_id,'action',action,'brand',b,'state',CASE WHEN op.operation_id IS NULL THEN 'missing' ELSE 'completed' END,
   'request_payload',op.request_payload,'response',op.response)));
 ELSIF method='get' AND (p-ARRAY['brand','test_id'])='{}' THEN
  IF coalesce(p->>'test_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN RETURN jsonb_build_object('status',422,'body',jsonb_build_object('error','AB_V2_REQUEST'));END IF;
  tid:=(p->>'test_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.crm_ab_experiment_v2 WHERE test_id=tid AND brand=b) THEN RETURN jsonb_build_object('status',404,'body',jsonb_build_object('error','AB_V2_NOT_FOUND'));END IF;
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('contract','crm-ab-email-v2','experiment',public.crm_ab_snapshot_v2(tid),
   'review',public.crm_ab_public_review_v2(tid),'measurement',public.crm_ab_measure_v2(tid)));
 ELSIF method='list' AND (p-ARRAY['brand'])='{}' THEN
  -- Explicit bounded recent-history view. No hidden claim that it is all history.
  SELECT coalesce(jsonb_agg(public.crm_ab_snapshot_v2(test_id) ORDER BY prepared_at DESC,test_id),'[]') INTO rows
   FROM (SELECT test_id,prepared_at FROM public.crm_ab_experiment_v2 WHERE brand=b ORDER BY prepared_at DESC,test_id LIMIT 20) recent;
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('contract','crm-ab-email-v2','brand',b,'experiments',rows,'limit',20,
   'recent_only',true,'more',EXISTS(SELECT 1 FROM public.crm_ab_experiment_v2 WHERE brand=b OFFSET 20)));
 ELSIF method='campaigns' AND (p-ARRAY['brand'])='{}' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'subject',c.subject,'send_at',c.send_at,
   'version',public.shrigma_campaign_current(c.id)->>'version','list_ids',(SELECT jsonb_agg(list_id ORDER BY list_id) FROM public.campaign_lists WHERE campaign_id=c.id),
   'validation',(SELECT validation-'_audience_fingerprint' FROM public.shrigma_campaign_validation WHERE provider_id=c.id)) ORDER BY c.id DESC),'[]') INTO rows
   FROM (SELECT * FROM public.campaigns WHERE attribs#>>'{crm,policy}'='crm-campaign-v1' AND attribs#>>'{crm,brand}'=b AND status::text='draft' AND sent=0 AND started_at IS NULL ORDER BY id DESC LIMIT 100) c;
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('contract','crm-ab-email-v2','brand',b,'campaigns',rows,'limit',100,'recent_only',true));
 ELSIF method='mutate' AND (p-ARRAY['brand','operation_id','request_payload'])='{}' THEN
  IF coalesce(p->>'operation_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR p#>>'{request_payload,brand}' IS DISTINCT FROM b THEN RETURN jsonb_build_object('status',422,'body',jsonb_build_object('error','AB_V2_REQUEST'));END IF;
  r:=public.crm_ab_control_v2(actor_id,auth->'caps',(p->>'operation_id')::uuid,p->'request_payload');
  RETURN r;
 END IF;
 RETURN jsonb_build_object('status',422,'body',jsonb_build_object('error','AB_V2_REQUEST'));
END $fn$;
REVOKE ALL ON FUNCTION public.crm_ab_api_v2(text,text,jsonb) FROM PUBLIC;
COMMIT;
