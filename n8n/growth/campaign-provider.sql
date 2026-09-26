-- Listmonk v6.1 provider primitives. Authenticated backend only.
-- Create remains the native Listmonk API. These writes touch only CRM-managed drafts.
CREATE OR REPLACE FUNCTION public.shrigma_campaign_list_brand(l public.lists) RETURNS text
LANGUAGE sql STABLE AS $$
 SELECT CASE
 WHEN coalesce(l.tags,'{}') && ARRAY['cross','aposentada','olivas']::varchar[] THEN NULL
 WHEN (coalesce(l.tags,'{}') && ARRAY['aristo','aristocrata']::varchar[] OR l.id=16)
  AND NOT (coalesce(l.tags,'{}') && ARRAY['fish','fishermans']::varchar[] OR l.id=17) THEN 'aristo'
 WHEN (coalesce(l.tags,'{}') && ARRAY['fish','fishermans']::varchar[] OR l.id=17)
  AND NOT (coalesce(l.tags,'{}') && ARRAY['aristo','aristocrata']::varchar[] OR l.id=16) THEN 'fish'
 ELSE NULL END
$$;
CREATE OR REPLACE FUNCTION public.shrigma_campaign_catalog(b text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN b NOT IN ('aristo','fish') OR b IS NULL THEN NULL ELSE
 jsonb_build_object('brand',b,'current',true,'read_at',clock_timestamp(),
  'lists',coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'brand',b,'available',l.status::text='active') ORDER BY l.id)
   FROM public.lists l WHERE public.shrigma_campaign_list_brand(l)=b),'[]'::jsonb),
  'templates',coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'type',t.type,'available',true,
   'version',md5(to_jsonb(t)::text)) ORDER BY t.id) FROM public.templates t WHERE t.type::text='campaign'),'[]'::jsonb),
  'initiatives',coalesce((SELECT jsonb_agg(jsonb_build_object('utm_campaign',f.utm_campaign,'key',f.familia) ORDER BY f.utm_campaign)
   FROM public.crm_familia_campanha f WHERE f.marca=b),'[]'::jsonb)) END
$$;
CREATE OR REPLACE FUNCTION public.shrigma_campaign_current(pid integer) RETURNS jsonb
LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',c.id,'version',md5(jsonb_build_object('campaign',to_jsonb(c),'lists',li.snapshot,'media',me.snapshot,'template',to_jsonb(t))::text),
 'status',c.status,'sent',c.sent,'started_at',c.started_at,
 'send_at',CASE WHEN c.send_at IS NULL THEN NULL ELSE to_char(c.send_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
 'definition',jsonb_build_object('schema_version','crm-campaign-v1','brand',c.attribs#>>'{crm,brand}','channel','email',
  'initiative',jsonb_build_object('key',c.attribs#>>'{crm,initiative_key}','name',c.attribs#>>'{crm,initiative_name}'),
  'utm_campaign',c.attribs#>>'{crm,utm_campaign}','name',c.name,'subject',c.subject,'from_email',c.from_email,
  'reply_to',(SELECT e.value FROM jsonb_array_elements(coalesce(c.headers,'[]')) a CROSS JOIN LATERAL jsonb_each_text(a) e WHERE lower(e.key)='reply-to' LIMIT 1),
  'list_ids',li.ids,'template_id',c.template_id,'html',c.body,'text',c.altbody,'tags',to_jsonb(c.tags),
  'send_at',CASE WHEN c.send_at IS NULL THEN NULL ELSE to_char(c.send_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END))
 FROM public.campaigns c LEFT JOIN public.templates t ON t.id=c.template_id
 CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(cl.list_id ORDER BY cl.list_id),'[]') ids,
  coalesce(jsonb_agg(jsonb_build_object('relation',to_jsonb(cl),'list',to_jsonb(l)) ORDER BY cl.list_id),'[]') snapshot
  FROM public.campaign_lists cl LEFT JOIN public.lists l ON l.id=cl.list_id WHERE cl.campaign_id=c.id) li
 CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(jsonb_build_object('relation',to_jsonb(cm),'media',to_jsonb(m)) ORDER BY cm.media_id,cm.filename),'[]') snapshot FROM public.campaign_media cm LEFT JOIN public.media m ON m.id=cm.media_id WHERE cm.campaign_id=c.id) me
 WHERE c.id=pid AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}' IN ('aristo','fish')
$$;
-- Current regular-campaign eligibility, aligned with Listmonk v6.1.0.
-- Only aggregates leave SQL. Subscription rows remain mutable for opt-out.
CREATE OR REPLACE FUNCTION public.shrigma_campaign_audience(pid integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $aud$
DECLARE c public.campaigns%ROWTYPE;b text;ids integer[];result jsonb;
BEGIN
 SELECT * INTO c FROM public.campaigns WHERE id=pid;
 b:=c.attribs#>>'{crm,brand}';
 IF NOT FOUND OR c.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
  OR b IS NULL OR b NOT IN ('aristo','fish') OR c.type::text<>'regular' OR c.messenger<>'email' THEN RAISE EXCEPTION 'CAMPAIGN_SCOPE'; END IF;
 SELECT array_agg(list_id ORDER BY list_id) INTO ids FROM public.campaign_lists WHERE campaign_id=pid;
 IF ids IS NULL OR cardinality(ids)<1 OR cardinality(ids)>30 OR EXISTS(SELECT 1 FROM unnest(ids) x WHERE x IS NULL)
  OR (SELECT count(*) FROM public.lists l WHERE l.id=ANY(ids) AND l.status::text='active' AND public.shrigma_campaign_list_brand(l)=b)<>cardinality(ids) THEN RAISE EXCEPTION 'LIST_SCOPE'; END IF;
 WITH members AS MATERIALIZED (
  SELECT s.id,s.status::text AS global_status,
   bool_or(CASE l.optin::text WHEN 'double' THEN sl.status::text='confirmed'
     WHEN 'single' THEN sl.status::text IN ('confirmed','unconfirmed') ELSE false END) AS eligible_link
  FROM public.subscriber_lists sl JOIN public.lists l ON l.id=sl.list_id
  JOIN public.subscribers s ON s.id=sl.subscriber_id WHERE sl.list_id=ANY(ids) GROUP BY s.id,s.status
 ), eligible AS (
  SELECT id,global_status,(row_number() OVER(ORDER BY id)-1)/1024 AS chunk
  FROM members WHERE global_status<>'blocklisted' AND eligible_link
 ), chunks AS (
  SELECT chunk,encode(sha256(convert_to(string_agg(id::text||':'||global_status,',' ORDER BY id),'UTF8')),'hex') AS hash
  FROM eligible GROUP BY chunk
 ) SELECT jsonb_build_object('policy','listmonk-6.1-regular-v1','brand',b,'list_ids',to_jsonb(ids),
  'eligible_count',count(*) FILTER(WHERE global_status<>'blocklisted' AND eligible_link),
  'unique_members_count',count(*),'excluded_blocklisted_count',count(*) FILTER(WHERE global_status='blocklisted'),
  'excluded_subscription_count',count(*) FILTER(WHERE global_status<>'blocklisted' AND NOT eligible_link),
  'native_disabled_count',count(*) FILTER(WHERE global_status='disabled' AND eligible_link),
  '_fingerprint',encode(sha256(convert_to(jsonb_build_array('listmonk-6.1-regular-v1',b,to_jsonb(ids),
    coalesce((SELECT string_agg(hash,'' ORDER BY chunk) FROM chunks),''))::text,'UTF8')),'hex')) INTO result FROM members;
 RETURN result;
END $aud$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_audience(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.shrigma_campaign_provider(a text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s'
AS $fn$
DECLARE c public.campaigns%ROWTYPE; op public.shrigma_campaign_operation%ROWTYPE;
 current_row jsonb;d jsonb:=p->'definition';b text;cat jsonb;ids integer[];tid integer; fam text;new_headers jsonb; previous_writer text;
 audience jsonb;validation jsonb;review_at timestamptz;review_expiry timestamptz;
BEGIN
 IF a IN ('recovery_inspect','recover') THEN RETURN public.shrigma_campaign_recovery(a,p);
 ELSIF a='catalog' THEN RETURN public.shrigma_campaign_catalog(p->>'brand');
 ELSIF a='get' THEN RETURN public.shrigma_campaign_current((p->>'id')::integer);
 ELSIF a='list' THEN RETURN coalesce((SELECT jsonb_agg(public.shrigma_campaign_current(ca.id) ORDER BY ca.id DESC)
  FROM public.campaigns ca WHERE ca.attribs#>>'{crm,policy}'='crm-campaign-v1' AND ca.attribs#>>'{crm,brand}'=p->>'brand'),'[]'::jsonb);
 END IF;
 IF a NOT IN ('update','schedule','cancel','review') THEN RAISE EXCEPTION 'CAMPAIGN_PROVIDER_ACTION'; END IF;
 -- Lock operation then campaign consistently; old workers and different identities cannot write.
 SELECT * INTO op FROM public.shrigma_campaign_operation WHERE id=(p->>'operationId')::uuid FOR UPDATE;
 IF NOT FOUND OR op.state<>'pending' OR op.action<>(CASE WHEN a='update' THEN 'salvar' WHEN a='cancel' THEN 'cancelar' WHEN a='review' THEN 'validar' ELSE 'agendar' END) THEN RAISE EXCEPTION 'CAMPAIGN_OPERATION_INVALID'; END IF;
 SELECT * INTO c FROM public.campaigns WHERE id=(p->>'id')::integer FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CAMPAIGN_NOT_FOUND'; END IF;
 b:=c.attribs#>>'{crm,brand}';
 IF b IS DISTINCT FROM op.brand OR c.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
  OR (op.provider_id IS NOT NULL AND op.provider_id<>c.id) THEN RAISE EXCEPTION 'CAMPAIGN_SCOPE'; END IF;
 current_row:=public.shrigma_campaign_current(c.id);
 IF current_row->>'version' IS DISTINCT FROM p->>'expectedVersion' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 IF a='cancel' THEN
  -- The row lock arbitrates cancellation against the native worker. Never cancel
  -- a due, started or partly delivered campaign through this future-schedule path.
  IF c.status::text<>'scheduled' OR c.sent IS DISTINCT FROM 0 OR c.started_at IS NOT NULL
   OR c.send_at IS NULL OR c.send_at<=clock_timestamp() THEN RAISE EXCEPTION 'CAMPAIGN_LOCKED'; END IF;
  previous_writer:=current_setting('shrigma.campaign_writer',true);
  PERFORM set_config('shrigma.campaign_writer',c.id::text,true);
  UPDATE public.campaigns SET status='cancelled',updated_at=clock_timestamp() WHERE id=c.id;
  -- CAMPAIGN_ATOMIC_CANCEL_RECEIPT_V1: status and its durable receipt commit together.
  current_row:=public.shrigma_campaign_current(c.id);
  IF current_row->>'status' IS DISTINCT FROM 'cancelled' OR current_row->'sent' IS DISTINCT FROM '0'::jsonb
   OR current_row->'started_at' IS DISTINCT FROM 'null'::jsonb OR (current_row->>'id')::integer IS DISTINCT FROM c.id
   OR nullif(current_row->>'send_at','')::timestamptz IS DISTINCT FROM c.send_at THEN RAISE EXCEPTION 'CAMPAIGN_RECEIPT_MISMATCH'; END IF;
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,state='succeeded',
   response=jsonb_build_object('status',200,'body',jsonb_build_object('campaign',current_row,'operation_id',op.id)),updated_at=clock_timestamp() WHERE id=op.id;
  PERFORM set_config('shrigma.campaign_writer',coalesce(previous_writer,''),true);
  RETURN current_row;
 END IF;
 IF c.status::text<>'draft' OR c.sent<>0 OR c.started_at IS NOT NULL OR c.type::text<>'regular'
  OR c.content_type::text<>'html' OR c.body_source IS NOT NULL OR c.messenger<>'email' THEN RAISE EXCEPTION 'CAMPAIGN_LOCKED'; END IF;
 IF a IN ('schedule','review') THEN d:=current_row->'definition'; END IF;
 IF d->>'brand' IS DISTINCT FROM b OR d->>'schema_version' IS DISTINCT FROM 'crm-campaign-v1'
  OR d->>'channel' IS DISTINCT FROM 'email' THEN RAISE EXCEPTION 'CAMPAIGN_SCOPE'; END IF;
 SELECT array_agg(x::integer ORDER BY x::integer) INTO ids FROM jsonb_array_elements_text(d->'list_ids') x;
 tid:=(d->>'template_id')::integer;
 IF ids IS NULL OR cardinality(ids)<1 OR cardinality(ids)>30 OR cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids)x) THEN RAISE EXCEPTION 'LIST_SCOPE'; END IF;
 -- Locks prevent catalog changes during this transaction, including list archival.
 PERFORM id FROM public.lists WHERE id=ANY(ids) ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM public.lists l WHERE id=ANY(ids) AND l.status::text='active' AND public.shrigma_campaign_list_brand(l)=b)<>cardinality(ids) THEN RAISE EXCEPTION 'LIST_SCOPE'; END IF;
 PERFORM id FROM public.templates WHERE id=tid FOR SHARE;
 PERFORM m.id FROM public.media m JOIN public.campaign_media cm ON cm.media_id=m.id WHERE cm.campaign_id=c.id ORDER BY m.id FOR SHARE OF m;
 IF NOT EXISTS(SELECT 1 FROM public.templates WHERE id=tid AND type::text='campaign') THEN RAISE EXCEPTION 'TEMPLATE_SCOPE'; END IF;
 IF public.shrigma_campaign_current(c.id)->>'version' IS DISTINCT FROM p->>'expectedVersion' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 IF a='update' AND (SELECT md5(to_jsonb(t)::text) FROM public.templates t WHERE id=tid) IS DISTINCT FROM p->>'templateVersion' THEN RAISE EXCEPTION 'TEMPLATE_CHANGED'; END IF;
 IF coalesce(d->>'utm_campaign','') !~ '^[a-z0-9]+([-_][a-z0-9]+)*$' OR coalesce(d#>>'{initiative,key}','') !~ '^[a-z0-9]+([-_][a-z0-9]+)*$' THEN RAISE EXCEPTION 'INITIATIVE_INVALID'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('campaign-initiative:'||b||':'||(d->>'utm_campaign'),0));
 SELECT familia INTO fam FROM public.crm_familia_campanha WHERE marca=b AND utm_campaign=d->>'utm_campaign' FOR UPDATE;
 IF FOUND AND fam IS DISTINCT FROM d#>>'{initiative,key}' THEN RAISE EXCEPTION 'INITIATIVE_CONFLICT'; END IF;
 -- Audience revisions are produced only here, never from browser/store JSON.
 IF a='review' THEN
  review_at:=clock_timestamp();audience:=public.shrigma_campaign_audience(c.id);
  validation:=jsonb_build_object('policy','crm-campaign-v1','version',current_row->>'version','ok',true,
   'validated_at',to_char(review_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   '_audience_fingerprint',audience->>'_fingerprint','audience',(audience-'_fingerprint')||jsonb_build_object(
    'review_id',gen_random_uuid(),'campaign_id',c.id,'campaign_version',current_row->>'version','frozen',false,
    'checked_at',to_char(review_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expires_at',to_char((review_at+interval '5 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  INSERT INTO public.shrigma_campaign_validation(provider_id,validation) VALUES(c.id,validation)
   ON CONFLICT(provider_id) DO UPDATE SET validation=excluded.validation,updated_at=clock_timestamp();
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
  RETURN jsonb_build_object('campaign',current_row,'validation',validation-'_audience_fingerprint');
 END IF;
 previous_writer:=current_setting('shrigma.campaign_writer',true);
 PERFORM set_config('shrigma.campaign_writer',c.id::text,true);
 IF a='schedule' THEN
  IF NOT EXISTS(SELECT 1 FROM public.shrigma_campaign_validation v WHERE provider_id=c.id AND v.validation->>'version'=p->>'expectedVersion'
   AND v.validation->>'policy'='crm-campaign-v1' AND v.validation->'ok'='true'::jsonb) THEN RAISE EXCEPTION 'VALIDATION_STALE'; END IF;
  IF c.send_at IS NULL OR c.send_at<clock_timestamp()+interval '15 minutes' THEN RAISE EXCEPTION 'SCHEDULE_TOO_SOON'; END IF;
  IF fam IS NULL THEN RAISE EXCEPTION 'INITIATIVE_MISSING'; END IF;
  -- CAMPAIGN_AUDIENCE_REVIEW_V1: recheck in the same transaction as status+receipt.
  SELECT v.validation INTO validation FROM public.shrigma_campaign_validation v WHERE provider_id=c.id FOR UPDATE;
  IF coalesce(p->>'audienceReviewId','')='' OR validation#>>'{audience,review_id}' IS DISTINCT FROM p->>'audienceReviewId'
   OR validation#>>'{audience,policy}' IS DISTINCT FROM 'listmonk-6.1-regular-v1'
   OR validation#>>'{audience,campaign_version}' IS DISTINCT FROM current_row->>'version'
   OR validation#>>'{audience,brand}' IS DISTINCT FROM b
   OR validation#>'{audience,list_ids}' IS DISTINCT FROM to_jsonb(ids)
   OR validation#>>'{audience,campaign_id}' IS DISTINCT FROM c.id::text
   OR coalesce(validation->>'_audience_fingerprint','') !~ '^[0-9a-f]{64}$'
   OR coalesce(validation#>>'{audience,checked_at}','') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
   OR coalesce(validation#>>'{audience,expires_at}','') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' THEN RAISE EXCEPTION 'AUDIENCE_REVIEW_REQUIRED'; END IF;
  BEGIN
   review_at:=(validation#>>'{audience,checked_at}')::timestamptz;review_expiry:=(validation#>>'{audience,expires_at}')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'AUDIENCE_REVIEW_REQUIRED'; END;
  IF review_expiry-review_at<>interval '5 minutes' OR review_at>clock_timestamp() OR review_expiry<=clock_timestamp() THEN RAISE EXCEPTION 'AUDIENCE_STALE'; END IF;
  audience:=public.shrigma_campaign_audience(c.id);
  IF (audience->>'native_disabled_count')::bigint>0 THEN RAISE EXCEPTION 'AUDIENCE_DISABLED'; END IF;
  IF (audience->>'eligible_count')::bigint=0 THEN RAISE EXCEPTION 'AUDIENCE_EMPTY'; END IF;
  IF audience->>'_fingerprint' IS DISTINCT FROM validation->>'_audience_fingerprint'
   OR (audience-'_fingerprint') IS DISTINCT FROM ((validation->'audience')-ARRAY['review_id','campaign_id','campaign_version','checked_at','expires_at','frozen']) THEN RAISE EXCEPTION 'AUDIENCE_CHANGED'; END IF;
  -- The receipt uses the same final instant checked after counting the union.
  review_at:=clock_timestamp();
  IF review_expiry<=review_at THEN RAISE EXCEPTION 'AUDIENCE_STALE'; END IF;
  IF c.send_at<review_at+interval '15 minutes' THEN RAISE EXCEPTION 'SCHEDULE_TOO_SOON'; END IF;
  validation:=jsonb_set(validation,'{audience}',(validation->'audience')||jsonb_build_object('rechecked_at',to_char(review_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  UPDATE public.campaigns SET status='scheduled' ,updated_at=clock_timestamp() WHERE id=c.id;
 ELSE
  -- Native content compilation must be confirmed by the backend before this call.
  IF p->'contentValidated' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'CONTENT_UNVALIDATED'; END IF;
  IF coalesce(d->>'name','')='' OR coalesce(d->>'subject','')='' OR coalesce(d->>'html','')='' OR coalesce(d->>'text','')='' THEN RAISE EXCEPTION 'CONTENT_EMPTY'; END IF;
  -- Preserve every unrelated header, even keys sharing one object with Reply-To.
  SELECT coalesce(jsonb_agg(clean),'[]') INTO new_headers FROM (
   SELECT (SELECT coalesce(jsonb_object_agg(key,value),'{}') FROM jsonb_each(e) WHERE lower(key)<>'reply-to') clean
   FROM jsonb_array_elements(coalesce(c.headers,'[]')) e) h WHERE clean<>'{}'::jsonb;
  new_headers:=new_headers||jsonb_build_array(jsonb_build_object('Reply-To',d->>'reply_to'));
  UPDATE public.campaigns SET name=d->>'name',subject=d->>'subject',from_email=d->>'from_email',body=d->>'html',altbody=d->>'text',
   send_at=nullif(d->>'send_at','')::timestamptz,headers=new_headers,template_id=tid,
   tags=ARRAY(SELECT jsonb_array_elements_text(d->'tags')),
   attribs=jsonb_set(coalesce(c.attribs,'{}'),'{crm}',coalesce(c.attribs->'crm','{}')||jsonb_build_object('policy','crm-campaign-v1','brand',b,
     'initiative_key',d#>>'{initiative,key}','initiative_name',d#>>'{initiative,name}','utm_campaign',d->>'utm_campaign')),
   updated_at=clock_timestamp() WHERE id=c.id;
  DELETE FROM public.campaign_lists WHERE campaign_id=c.id AND NOT(list_id=ANY(ids));
  INSERT INTO public.campaign_lists(campaign_id,list_id,list_name) SELECT c.id,id,name FROM public.lists WHERE id=ANY(ids)
   ON CONFLICT(campaign_id,list_id) DO UPDATE SET list_name=excluded.list_name;
  INSERT INTO public.crm_familia_campanha(marca,utm_campaign,familia) VALUES(b,d->>'utm_campaign',d#>>'{initiative,key}') ON CONFLICT DO NOTHING;
  DELETE FROM public.shrigma_campaign_validation WHERE provider_id=c.id;
 END IF;
 current_row:=public.shrigma_campaign_current(c.id);
 IF a='schedule' THEN
  -- CAMPAIGN_ATOMIC_SCHEDULE_RECEIPT_V1: losing the runtime's final step cannot orphan a confirmed schedule.
  IF current_row->>'status' IS DISTINCT FROM 'scheduled' OR current_row->'sent' IS DISTINCT FROM '0'::jsonb
   OR current_row->'started_at' IS DISTINCT FROM 'null'::jsonb OR (current_row->>'id')::integer IS DISTINCT FROM c.id
   OR nullif(current_row->>'send_at','')::timestamptz IS DISTINCT FROM c.send_at THEN RAISE EXCEPTION 'CAMPAIGN_RECEIPT_MISMATCH'; END IF;
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,state='succeeded',
   response=jsonb_build_object('status',200,'body',jsonb_build_object('campaign',current_row,'operation_id',op.id,'audience',validation->'audience')),updated_at=clock_timestamp() WHERE id=op.id;
  current_row:=current_row||jsonb_build_object('audience',validation->'audience');
 ELSE
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
 END IF;
 PERFORM set_config('shrigma.campaign_writer',coalesce(previous_writer,''),true);
 RETURN current_row;
END $fn$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_list_brand(public.lists),public.shrigma_campaign_catalog(text),public.shrigma_campaign_current(integer),public.shrigma_campaign_provider(text,jsonb) FROM PUBLIC;
