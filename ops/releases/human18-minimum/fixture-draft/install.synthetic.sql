-- PREPARATION ONLY. Native synthetic fixture; not a production installer.
DO $fence$ BEGIN
 IF current_database() !~ '^native17_test[0-9]+$' THEN RAISE EXCEPTION 'DRAFT_SYNTHETIC_DATABASE_REQUIRED';END IF;
END $fence$;

CREATE FUNCTION public.shrigma_campaign_draft_save_v1(a text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='500ms'
AS $draft$
DECLARE d jsonb:=p->'definition';op public.shrigma_campaign_operation%ROWTYPE;c public.campaigns%ROWTYPE;
 b text;dom text;tid integer;ids integer[];current_row jsonb;tracking jsonb;result jsonb;previous_writer text;fam text;new_headers jsonb;
BEGIN
 IF a NOT IN('draft_create','draft_update') OR jsonb_typeof(d) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(d))<>15
  OR NOT(d ?& ARRAY['schema_version','brand','channel','initiative','utm_campaign','name','subject','from_email','reply_to','list_ids','template_id','html','text','tags','send_at'])
  OR d->>'schema_version' IS DISTINCT FROM 'crm-campaign-v1' OR d->>'channel' IS DISTINCT FROM 'email'
  OR d->'send_at' IS DISTINCT FROM 'null'::jsonb OR coalesce(d->>'brand','') NOT IN('fish','aristo')
  OR jsonb_typeof(d->'initiative') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(d->'initiative'))<>2
  OR NOT((d->'initiative') ?& ARRAY['name','key']) THEN RAISE EXCEPTION 'DRAFT_INPUT';END IF;
 b:=d->>'brand';dom:=CASE b WHEN 'aristo' THEN 'oaristocrata.com' ELSE 'fishermans.com.br' END;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['name','subject','from_email','reply_to','html','text','utm_campaign']) k WHERE jsonb_typeof(d->k) IS DISTINCT FROM 'string')
  OR length(d->>'name') NOT BETWEEN 1 AND 200 OR btrim(d->>'name') IS DISTINCT FROM d->>'name'
  OR length(d->>'subject') NOT BETWEEN 1 AND 250 OR btrim(d->>'subject') IS DISTINCT FROM d->>'subject' OR d->>'subject' ~ E'[\r\n]'
  OR length(d->>'html')>300000 OR length(d->>'text')>100000
  OR d->>'html' ~* '<(script|iframe|object|embed|form)\M|\mon[a-z]+\s*=|javascript\s*:'
  OR (d->>'from_email'<>('avisos@'||dom) AND d->>'from_email'<>('avisos@marketing.'||dom))
  OR d->>'reply_to' IS DISTINCT FROM 'contato@'||dom
  OR jsonb_typeof(d#>'{initiative,key}') IS DISTINCT FROM 'string' OR jsonb_typeof(d#>'{initiative,name}') IS DISTINCT FROM 'string'
  OR length(d#>>'{initiative,name}') NOT BETWEEN 1 AND 160
  OR length(d#>>'{initiative,key}') NOT BETWEEN 1 AND 100 OR d#>>'{initiative,key}' !~ '^[a-z0-9]+([-_][a-z0-9]+)*$'
  OR length(d->>'utm_campaign') NOT BETWEEN 1 AND 100 OR d->>'utm_campaign' !~ '^[a-z0-9]+([-_][a-z0-9]+)*$'
 THEN RAISE EXCEPTION 'DRAFT_INPUT';END IF;
 IF jsonb_typeof(d->'list_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'list_ids')>30
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'list_ids') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'number' OR x::text !~ '^[1-9][0-9]{0,9}$' OR x::text::numeric>2147483647)
  OR jsonb_typeof(d->'tags') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'tags')>20
  OR NOT(d->'tags' @> '["crm-draft-editor-v2"]'::jsonb)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'tags') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 100 OR x#>>'{}' !~ '^[a-z0-9]+([-_][a-z0-9]+)*$')
  OR jsonb_typeof(d->'template_id') IS DISTINCT FROM 'number' OR d->>'template_id' !~ '^[1-9][0-9]{0,9}$' OR (d->>'template_id')::numeric>2147483647
  OR coalesce(p->>'templateVersion','') !~ '^[a-f0-9]{32}$'
 THEN RAISE EXCEPTION 'DRAFT_INPUT';END IF;
 SELECT coalesce(array_agg(x::integer ORDER BY x::integer),'{}'::integer[]) INTO ids FROM jsonb_array_elements_text(d->'list_ids') x;
 IF cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids)x)
  OR jsonb_array_length(d->'tags')<>(SELECT count(DISTINCT x) FROM jsonb_array_elements_text(d->'tags') x) THEN RAISE EXCEPTION 'DRAFT_INPUT';END IF;
 tid:=(d->>'template_id')::integer;
 -- The registry retains its existing table-before-campaign lock protocol.
 LOCK TABLE public.shrigma_template_email_registry IN SHARE MODE;
 SELECT * INTO op FROM public.shrigma_campaign_operation WHERE id=(p->>'operationId')::uuid FOR UPDATE;
 IF NOT FOUND OR op.action<>'salvar' OR op.state<>'pending' OR op.brand IS DISTINCT FROM b
  OR a='draft_create' AND op.provider_id IS NOT NULL THEN RAISE EXCEPTION 'CAMPAIGN_OPERATION_INVALID';END IF;
 IF a='draft_update' THEN
  SELECT * INTO c FROM public.campaigns WHERE id=(p->>'id')::integer FOR UPDATE;
  IF NOT FOUND OR c.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1' OR c.attribs#>>'{crm,brand}' IS DISTINCT FROM b
   OR c.attribs#>>'{crm,draft_editor}' IS DISTINCT FROM 'v2' OR (c.tags @> ARRAY['crm-draft-editor-v2']::varchar[]) IS DISTINCT FROM true
   OR c.status::text<>'draft' OR c.sent IS DISTINCT FROM 0 OR c.started_at IS NOT NULL OR c.send_at IS NOT NULL
   OR c.type::text<>'regular' OR c.content_type::text<>'html' OR c.body_source IS NOT NULL OR c.messenger<>'email'
   OR EXISTS(SELECT 1 FROM public.campaign_media cm WHERE cm.campaign_id=c.id)
   OR (op.provider_id IS NOT NULL AND op.provider_id<>c.id)
   OR NOT EXISTS(SELECT 1 FROM public.shrigma_campaign_operation o WHERE o.id::text=c.attribs#>>'{crm,created_operation_id}' AND o.provider_id=c.id AND o.brand=b AND o.action='salvar' AND o.state='succeeded')
  THEN RAISE EXCEPTION 'CAMPAIGN_SCOPE';END IF;
  current_row:=public.shrigma_campaign_current(c.id);
  IF current_row->>'version' IS DISTINCT FROM p->>'expectedVersion' THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 END IF;
 PERFORM id FROM public.templates WHERE id=tid FOR SHARE;
 IF public.shrigma_campaign_template_owned_v1(tid,b) IS DISTINCT FROM true THEN RAISE EXCEPTION 'TEMPLATE_SCOPE';END IF;
 IF (SELECT md5(to_jsonb(t)::text) FROM public.templates t WHERE id=tid) IS DISTINCT FROM p->>'templateVersion' THEN RAISE EXCEPTION 'TEMPLATE_CHANGED';END IF;
 PERFORM id FROM public.lists WHERE id=ANY(ids) ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM public.lists l WHERE id=ANY(ids) AND l.status::text='active' AND public.shrigma_campaign_list_brand(l)=b)<>cardinality(ids) THEN RAISE EXCEPTION 'LIST_SCOPE';END IF;
 IF a='draft_update' AND public.shrigma_campaign_current(c.id)->>'version' IS DISTINCT FROM p->>'expectedVersion' THEN RAISE EXCEPTION 'VERSION_CONFLICT';END IF;
 tracking:=p->'tracking';
 IF jsonb_typeof(tracking) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(tracking))<>4
  OR NOT(tracking ?& ARRAY['policy','term','list_ids','changed_links']) OR tracking->'list_ids' IS DISTINCT FROM to_jsonb(ids)
 THEN RAISE EXCEPTION 'DRAFT_TRACKING';END IF;
 IF tracking->>'policy'='crm-campaign-draft-v1' THEN
  IF tracking->'term' IS DISTINCT FROM 'null'::jsonb OR tracking->'changed_links' IS DISTINCT FROM '0'::jsonb OR p->'contentValidated' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'DRAFT_TRACKING';END IF;
 ELSIF tracking->>'policy'='crm-campaign-v1' AND a='draft_update' THEN
  IF p->'contentValidated' IS DISTINCT FROM 'true'::jsonb OR cardinality(ids)<1
   OR length(d->>'html')=0 OR length(d->>'text')=0 OR d->>'html' !~ '\{\{\s*UnsubscribeURL\s*\}\}' OR d->>'text' !~ '\{\{\s*UnsubscribeURL\s*\}\}'
   OR tracking->>'term' IS DISTINCT FROM 'lm-'||c.id::text||'-l'||array_to_string(ids,'-')
   OR jsonb_typeof(tracking->'changed_links') IS DISTINCT FROM 'number' OR tracking->>'changed_links' !~ '^(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION 'DRAFT_TRACKING';END IF;
 ELSE RAISE EXCEPTION 'DRAFT_TRACKING';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('campaign-initiative:'||b||':'||(d->>'utm_campaign'),0));
 SELECT familia INTO fam FROM public.crm_familia_campanha WHERE marca=b AND utm_campaign=d->>'utm_campaign' FOR UPDATE;
 IF FOUND AND fam IS DISTINCT FROM d#>>'{initiative,key}' THEN RAISE EXCEPTION 'INITIATIVE_CONFLICT';END IF;
 previous_writer:=current_setting('shrigma.campaign_writer',true);
 IF a='draft_create' THEN
  INSERT INTO public.campaigns(uuid,name,subject,from_email,body,altbody,body_source,headers,status,tags,type,messenger,template_id,content_type,
    send_at,started_at,sent,to_send,last_subscriber_id,max_subscriber_id,attribs)
  VALUES(gen_random_uuid(),d->>'name',d->>'subject',d->>'from_email',d->>'html',d->>'text',NULL,jsonb_build_array(jsonb_build_object('Reply-To',d->>'reply_to')),
    'draft',ARRAY(SELECT jsonb_array_elements_text(d->'tags')),'regular','email',tid,'html',NULL,NULL,0,0,0,0,
    jsonb_build_object('crm',jsonb_build_object('policy','crm-campaign-v1','brand',b,'initiative_key',d#>>'{initiative,key}','initiative_name',d#>>'{initiative,name}',
      'utm_campaign',d->>'utm_campaign','created_operation_id',op.id,'draft_editor','v2','draft_ready',false,'tracking_term',NULL))) RETURNING * INTO c;
 ELSE
  PERFORM set_config('shrigma.campaign_writer',c.id::text,true);
  SELECT coalesce(jsonb_agg(clean),'[]') INTO new_headers FROM (
   SELECT (SELECT coalesce(jsonb_object_agg(key,value),'{}') FROM jsonb_each(e) WHERE lower(key)<>'reply-to') clean
   FROM jsonb_array_elements(coalesce(c.headers,'[]')) e) h WHERE clean<>'{}'::jsonb;
  new_headers:=new_headers||jsonb_build_array(jsonb_build_object('Reply-To',d->>'reply_to'));
  UPDATE public.campaigns SET name=d->>'name',subject=d->>'subject',from_email=d->>'from_email',body=d->>'html',altbody=d->>'text',
   headers=new_headers,template_id=tid,tags=ARRAY(SELECT jsonb_array_elements_text(d->'tags')),
   attribs=jsonb_set(coalesce(c.attribs,'{}'),'{crm}',coalesce(c.attribs->'crm','{}')||jsonb_build_object('initiative_key',d#>>'{initiative,key}',
    'initiative_name',d#>>'{initiative,name}','utm_campaign',d->>'utm_campaign',
    'draft_ready',tracking->>'policy'='crm-campaign-v1','tracking_term',tracking->'term','content_template_version',p->>'templateVersion')),updated_at=clock_timestamp() WHERE id=c.id;
 END IF;
 PERFORM set_config('shrigma.campaign_writer',c.id::text,true);
 DELETE FROM public.campaign_lists WHERE campaign_id=c.id AND NOT(list_id=ANY(ids));
 INSERT INTO public.campaign_lists(campaign_id,list_id,list_name) SELECT c.id,l.id,l.name FROM public.lists l WHERE l.id=ANY(ids)
  ON CONFLICT(campaign_id,list_id) DO NOTHING;
 DELETE FROM public.shrigma_campaign_validation WHERE provider_id=c.id;
 INSERT INTO public.crm_familia_campanha(marca,utm_campaign,familia) VALUES(b,d->>'utm_campaign',d#>>'{initiative,key}') ON CONFLICT(marca,utm_campaign) DO NOTHING;
 current_row:=public.shrigma_campaign_current(c.id);
 IF current_row->'definition' IS DISTINCT FROM d OR current_row->>'status' IS DISTINCT FROM 'draft' OR current_row->'sent' IS DISTINCT FROM '0'::jsonb
  OR current_row->'started_at' IS DISTINCT FROM 'null'::jsonb OR current_row->'send_at' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'CAMPAIGN_RECEIPT_MISMATCH';END IF;
 result:=jsonb_build_object('campaign',current_row,'tracking',tracking,'operation_id',op.id);
 UPDATE public.shrigma_campaign_operation SET provider_id=c.id,state='succeeded',
  response=jsonb_build_object('status',CASE a WHEN 'draft_create' THEN 201 ELSE 200 END,'body',result),updated_at=clock_timestamp() WHERE id=op.id;
 PERFORM set_config('shrigma.campaign_writer',coalesce(previous_writer,''),true);
 RETURN result;
END $draft$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_draft_save_v1(text,jsonb) FROM PUBLIC,crm_campaign_api,crm_audience_api;

CREATE OR REPLACE FUNCTION public.shrigma_campaign_provider(a text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
 SET lock_timeout TO '3s'
AS $function$
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
 IF c.attribs#>>'{crm,draft_editor}'='v2' THEN
  IF a='update' THEN RAISE EXCEPTION 'DRAFT_FORMAT_REQUIRED';END IF;
  IF a IN('review','schedule') AND (c.attribs#>'{crm,draft_ready}' IS DISTINCT FROM 'true'::jsonb
   OR c.attribs#>>'{crm,content_template_version}' IS DISTINCT FROM (SELECT md5(to_jsonb(t)::text) FROM public.templates t WHERE t.id=c.template_id)
   OR coalesce(c.body,'')='' OR coalesce(c.altbody,'')='' OR cardinality(ids)<1) THEN RAISE EXCEPTION 'DRAFT_INCOMPLETE';END IF;
 END IF;
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
END $function$;
CREATE OR REPLACE FUNCTION public.shrigma_crm_campaign_effect_v1(p_key text, p_envelope jsonb, p_effect jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
 auth jsonb; command jsonb; operation jsonb; actor_name text; brand_name text; command_name text; action_name text; capability text;
 kind_name text; effect_action text; payload jsonb; result jsonb; op public.shrigma_campaign_operation%ROWTYPE;
 source_op public.shrigma_campaign_operation%ROWTYPE;
 campaign public.campaigns%ROWTYPE; operation_id uuid; operation_lease uuid; provider_id integer; checked timestamptz;
BEGIN
 IF p_effect->>'kind' IN('nativeContext','nativeStatus','nativeRead','nativeClear','nativeCancelRecovery') OR(p_effect->>'kind'='provider' AND p_effect->>'action' IN('native_prepare','native_result')) THEN
  RETURN crm_audience_v2.native_internal_effect_v1(p_key,p_envelope,p_effect);
 END IF;
 auth:=public.shrigma_crm_campaign_auth_v1(p_key);
 IF auth IS NULL THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_UNAUTHORIZED'; END IF;
 IF jsonb_typeof(p_envelope) IS DISTINCT FROM 'object' OR jsonb_typeof(p_effect) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_INPUT';
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_envelope))<>3 OR NOT (p_envelope ?& ARRAY['command','actor','operation']) THEN
  RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_ENVELOPE';
 END IF;
 command:=p_envelope->'command';operation:=p_envelope->'operation';actor_name:=p_envelope->>'actor';
 IF jsonb_typeof(command) IS DISTINCT FROM 'object' OR actor_name IS DISTINCT FROM auth->>'actor'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(command) k WHERE k<>ALL(ARRAY['acao','brand','id','definition','expected_version','idempotency_key','confirm','audience_review_id','source_operation_id']))
 THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_ENVELOPE'; END IF;
 command_name:=command->>'acao';brand_name:=command->>'brand';
 IF command_name IS NULL OR brand_name IS NULL OR command_name !~ '^campanha_(catalogo|listar|obter|operacao|salvar|validar|agendar|cancelar|recuperar)$'
  OR brand_name NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_COMMAND'; END IF;
 action_name:=regexp_replace(command_name,'^campanha_','');
 capability:=CASE action_name WHEN 'catalogo' THEN 'read_content' WHEN 'listar' THEN 'read_content' WHEN 'obter' THEN 'read_content'
  WHEN 'operacao' THEN 'read_content' WHEN 'salvar' THEN 'draft' WHEN 'recuperar' THEN 'draft' WHEN 'validar' THEN 'validate'
  WHEN 'agendar' THEN 'submit' WHEN 'cancelar' THEN 'submit' END;
 IF NOT (auth->'caps' ? capability) THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_FORBIDDEN'; END IF;
 kind_name:=p_effect->>'kind';effect_action:=p_effect->>'action';payload:=p_effect->'payload';
 IF kind_name IS NULL OR kind_name NOT IN ('store','provider','nativeCreate','preview') OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_effect) k WHERE k<>ALL(ARRAY['kind','action','payload','idCampaign']))
 THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_EFFECT'; END IF;

 -- Native timeout/finish follows the trigger's campaign -> operation order.
 IF kind_name='store' AND effect_action='finish' THEN
  PERFORM c.id FROM public.campaigns c JOIN public.shrigma_campaign_validation v ON v.provider_id=c.id
  JOIN public.shrigma_campaign_operation o ON o.id::text=v.validation#>>'{_native_internal,operation_id}'
  WHERE o.id::text=operation->>'id' AND o.lease::text=operation->>'lease' AND o.actor=actor_name
   AND o.brand=brand_name AND o.action=action_name AND o.provider_id=c.id
  FOR UPDATE OF c;
 END IF;
 IF operation IS NOT NULL AND operation<>'null'::jsonb THEN
  IF jsonb_typeof(operation) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(operation))<>2
   OR NOT (operation ?& ARRAY['id','lease']) THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END IF;
  BEGIN operation_id:=(operation->>'id')::uuid;operation_lease:=(operation->>'lease')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END;
  SELECT * INTO op FROM public.shrigma_campaign_operation WHERE id=operation_id FOR SHARE;
  IF NOT FOUND OR op.lease IS DISTINCT FROM operation_lease OR op.actor IS DISTINCT FROM actor_name OR op.brand IS DISTINCT FROM brand_name
   OR op.action IS DISTINCT FROM action_name THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END IF;
 ELSE operation_id:=NULL;operation_lease:=NULL; END IF;

 IF kind_name='store' THEN
  IF effect_action IS NULL OR effect_action NOT IN ('claim','get','provider','finish','validation_get','validation_set','validation_invalidate') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_EFFECT'; END IF;
  IF effect_action='claim' THEN
   IF operation_id IS NOT NULL OR action_name NOT IN ('salvar','validar','agendar','cancelar','recuperar')
    OR payload->>'actor' IS DISTINCT FROM actor_name OR payload->>'key' IS DISTINCT FROM command->>'idempotency_key'
    OR payload->>'brand' IS DISTINCT FROM brand_name OR payload->>'action' IS DISTINCT FROM action_name THEN
    RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_CLAIM'; END IF;
  ELSIF effect_action='get' THEN
   IF operation_id IS NOT NULL OR action_name<>'operacao' OR payload->>'actor' IS DISTINCT FROM actor_name
    OR payload->>'key' IS DISTINCT FROM command->>'idempotency_key' THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_READ'; END IF;
  ELSE
   IF operation_id IS NULL OR payload->>'id' IS DISTINCT FROM operation_id::text OR payload->>'lease' IS DISTINCT FROM operation_lease::text THEN
    IF effect_action IN ('provider','finish') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END IF;
   END IF;
   IF operation_id IS NULL OR (effect_action<>'finish' AND op.state<>'pending') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END IF;
   IF effect_action='provider' THEN
    BEGIN provider_id:=(payload->>'providerId')::integer;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';END;
    SELECT * INTO campaign FROM public.campaigns WHERE id=provider_id FOR SHARE;
    IF NOT FOUND OR provider_id IS NULL OR provider_id<=0 OR op.provider_id IS NOT NULL OR action_name<>'salvar' OR command ? 'id'
     OR campaign.status::text<>'draft' OR campaign.sent<>0 OR campaign.started_at IS NOT NULL
     OR campaign.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
     OR campaign.attribs#>>'{crm,brand}' IS DISTINCT FROM brand_name
     OR campaign.attribs#>>'{crm,created_operation_id}' IS DISTINCT FROM operation_id::text THEN
     RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';
    END IF;
   ELSIF effect_action='finish' THEN
    provider_id:=nullif(payload->>'providerId','')::integer;
    IF provider_id IS NOT NULL AND provider_id IS DISTINCT FROM op.provider_id
     AND (coalesce(command->>'id','') !~ '^[1-9][0-9]*$' OR provider_id IS DISTINCT FROM (command->>'id')::integer)
    THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER'; END IF;
    IF provider_id IS NOT NULL THEN
     SELECT * INTO campaign FROM public.campaigns WHERE id=provider_id FOR SHARE;
     IF NOT FOUND OR campaign.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
      OR campaign.attribs#>>'{crm,brand}' IS DISTINCT FROM brand_name THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER'; END IF;
    END IF;
   END IF;
   IF effect_action LIKE 'validation_%' THEN
    BEGIN provider_id:=(payload->>'providerId')::integer;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';END;
    IF provider_id IS NULL OR provider_id<=0 OR provider_id IS DISTINCT FROM coalesce(op.provider_id,(command->>'id')::integer)
     OR (effect_action='validation_get' AND action_name<>'agendar')
     OR (effect_action='validation_invalidate' AND action_name<>'salvar')
     OR effect_action='validation_set' THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.campaigns c WHERE c.id=provider_id AND c.attribs#>>'{crm,brand}'=brand_name AND c.attribs#>>'{crm,policy}'='crm-campaign-v1') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_SCOPE'; END IF;
   END IF;
  END IF;
  result:=public.shrigma_campaign_store(effect_action,payload);
 ELSIF kind_name='provider' AND effect_action IN('draft_create','draft_update') THEN
  IF operation_id IS NULL OR op.state<>'pending' OR action_name<>'salvar' OR payload->>'operationId' IS DISTINCT FROM operation_id::text
   OR (SELECT count(*) FROM jsonb_object_keys(p_effect))<>3 OR NOT(p_effect ?& ARRAY['kind','action','payload'])
   OR (SELECT count(*) FROM jsonb_object_keys(payload))<>(CASE effect_action WHEN 'draft_create' THEN 5 ELSE 7 END)
   OR NOT(payload ?& ARRAY['definition','tracking','templateVersion','contentValidated','operationId'])
   OR payload->'definition' IS DISTINCT FROM command->'definition' OR payload#>>'{definition,brand}' IS DISTINCT FROM brand_name
   OR NOT(payload#>'{definition,tags}' @> '["crm-draft-editor-v2"]'::jsonb)
   OR (effect_action='draft_create' AND (command ? 'id' OR op.provider_id IS NOT NULL))
   OR (effect_action='draft_update' AND (NOT(command ? 'id') OR NOT(payload ?& ARRAY['id','expectedVersion'])
    OR payload->'id' IS DISTINCT FROM command->'id' OR payload->>'expectedVersion' IS DISTINCT FROM command->>'expected_version'
    OR (op.provider_id IS NOT NULL AND op.provider_id::text IS DISTINCT FROM payload->>'id')))
  THEN RAISE EXCEPTION 'DRAFT_INPUT';END IF;
  result:=public.shrigma_campaign_draft_save_v1(effect_action,payload);
 ELSIF kind_name='provider' THEN
  IF effect_action IS NULL OR effect_action NOT IN ('catalog','list','get','update','schedule','cancel','review','recovery_inspect','recover') THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_EFFECT'; END IF;
  IF effect_action IN ('catalog','list') THEN
   IF payload->>'brand' IS DISTINCT FROM brand_name OR (effect_action='list' AND action_name<>'listar')
    OR (effect_action='catalog' AND action_name NOT IN ('catalogo','salvar','validar','agendar')) THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_SCOPE'; END IF;
  ELSIF effect_action='get' THEN
   BEGIN provider_id:=(payload->>'id')::integer;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';END;
   IF action_name NOT IN ('obter','salvar','validar','agendar','cancelar') OR provider_id<=0
    OR (command->>'id' IS NOT NULL AND provider_id IS DISTINCT FROM (command->>'id')::integer)
    OR (op.id IS NOT NULL AND op.provider_id IS NOT NULL AND provider_id IS DISTINCT FROM op.provider_id) THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER'; END IF;
  ELSIF effect_action='recovery_inspect' THEN
   IF action_name<>'operacao' OR payload->>'actor' IS DISTINCT FROM actor_name
    THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_RECOVERY'; END IF;
   SELECT * INTO source_op FROM public.shrigma_campaign_operation
    WHERE actor=actor_name AND operation_key=command->>'idempotency_key' FOR SHARE;
   IF NOT FOUND OR source_op.id::text IS DISTINCT FROM payload->>'sourceOperationId'
    OR source_op.brand IS DISTINCT FROM brand_name THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_RECOVERY'; END IF;
  ELSE
   IF operation_id IS NULL OR op.state<>'pending' OR payload->>'operationId' IS DISTINCT FROM operation_id::text
    OR effect_action IS DISTINCT FROM (CASE action_name WHEN 'salvar' THEN 'update' WHEN 'validar' THEN 'review' WHEN 'agendar' THEN 'schedule' WHEN 'cancelar' THEN 'cancel' WHEN 'recuperar' THEN 'recover' END)
   THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_OPERATION'; END IF;
   BEGIN provider_id:=(payload->>'id')::integer;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';END;
   IF provider_id<=0 OR (command ? 'id' AND provider_id IS DISTINCT FROM (command->>'id')::integer)
    OR (NOT (command ? 'id') AND NOT (action_name='salvar' AND effect_action='update' AND provider_id IS NOT DISTINCT FROM op.provider_id))
    OR (op.provider_id IS NOT NULL AND provider_id IS DISTINCT FROM op.provider_id)
   OR (NOT (effect_action='update' AND NOT (command ? 'id')) AND payload->>'expectedVersion' IS DISTINCT FROM command->>'expected_version')
   OR (effect_action='update' AND NOT (command ? 'id') AND coalesce(payload->>'expectedVersion','')='')
    OR (effect_action='schedule' AND (payload->>'audienceReviewId' IS DISTINCT FROM command->>'audience_review_id' OR command->>'confirm' IS DISTINCT FROM 'agendar'))
    OR (effect_action='cancel' AND command->>'confirm' IS DISTINCT FROM 'cancelar')
    OR (effect_action='recover' AND command->>'confirm' IS DISTINCT FROM 'recuperar')
    OR (effect_action='recover' AND payload->>'sourceOperationId' IS DISTINCT FROM command->>'source_operation_id')
   THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_SCOPE'; END IF;
  END IF;
  result:=public.shrigma_campaign_provider(effect_action,payload);
  IF effect_action='get' AND result IS NOT NULL AND result#>>'{definition,brand}' IS DISTINCT FROM brand_name THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_SCOPE'; END IF;
  IF effect_action='get' AND action_name='salvar' AND NOT (command ? 'id')
   AND (operation_id IS NULL OR result#>>'{definition,brand}' IS DISTINCT FROM brand_name
    OR NOT EXISTS(SELECT 1 FROM public.campaigns c WHERE c.id=(result->>'id')::integer
     AND c.attribs#>>'{crm,created_operation_id}'=operation_id::text)) THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';
  END IF;
 ELSIF kind_name='nativeCreate' THEN
  IF operation_id IS NULL OR op.state<>'pending' OR action_name<>'salvar' OR command ? 'id' OR op.provider_id IS NOT NULL
   OR effect_action IS NOT NULL OR p_effect ? 'idCampaign' OR payload->'send_at' IS DISTINCT FROM 'null'::jsonb
   OR payload->>'type' IS DISTINCT FROM 'regular' OR payload->>'content_type' IS DISTINCT FROM 'html'
   OR payload->'body_source' IS DISTINCT FROM 'null'::jsonb OR payload->>'messenger' IS DISTINCT FROM 'email'
   OR payload#>>'{attribs,crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
   OR payload#>>'{attribs,crm,brand}' IS DISTINCT FROM brand_name
   OR payload#>>'{attribs,crm,created_operation_id}' IS DISTINCT FROM operation_id::text THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_NATIVE_CREATE'; END IF;
  checked:=clock_timestamp();result:=jsonb_build_object('ok',true,'kind','nativeCreate','operation_id',operation_id,'checked_at',checked);
 ELSE
  BEGIN provider_id:=(p_effect->>'idCampaign')::integer;EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PROVIDER';END;
  IF operation_id IS NULL OR op.state<>'pending' OR action_name<>'salvar' OR effect_action IS NOT NULL OR provider_id<=0
   OR payload->>'content_type' IS DISTINCT FROM 'html' OR coalesce(payload->>'template_id','') !~ '^[1-9][0-9]*$'
   OR (op.provider_id IS NOT NULL AND provider_id IS DISTINCT FROM op.provider_id)
   OR (op.provider_id IS NULL AND (command->>'id')::integer IS DISTINCT FROM provider_id)
   OR (command#>>'{definition,template_id}')::integer IS DISTINCT FROM (payload->>'template_id')::integer THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PREVIEW'; END IF;
  SELECT * INTO campaign FROM public.campaigns WHERE id=provider_id FOR SHARE;
  IF NOT FOUND OR campaign.status::text<>'draft' OR campaign.sent<>0 OR campaign.started_at IS NOT NULL
   OR campaign.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1' OR campaign.attribs#>>'{crm,brand}' IS DISTINCT FROM brand_name THEN
   RAISE EXCEPTION 'CRM_CAMPAIGN_GATEWAY_PREVIEW'; END IF;
  checked:=clock_timestamp();result:=jsonb_build_object('ok',true,'kind','preview','operation_id',operation_id,'campaign_id',provider_id,'checked_at',checked);
 END IF;
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_provider(text,jsonb) FROM PUBLIC,crm_campaign_api,crm_audience_api;
REVOKE ALL ON FUNCTION public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb) FROM PUBLIC,crm_audience_api;
GRANT EXECUTE ON FUNCTION public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb) TO crm_campaign_api;
