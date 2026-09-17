-- Olivas uses the same delivery reservation and vote-before-ClickUp pattern.
-- Brand-specific attributes preserve Fish/Aristo votes on shared subscribers.
-- Provision templates, sender, landing and Flow key privately before enabling.
ALTER TABLE shrigma_nps_vote_sync DROP CONSTRAINT shrigma_nps_vote_sync_brand_check;
ALTER TABLE shrigma_nps_vote_sync ADD CONSTRAINT shrigma_nps_vote_sync_brand_check CHECK(brand IN ('fish','aristo','olivas'));

CREATE OR REPLACE FUNCTION public.shrigma_olivas_nps_initial_confirmed(p_brand text, p_ref text, p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT p_brand IN ('olivas') AND EXISTS(
  SELECT 1 FROM public.shrigma_send_log l
  WHERE l.brand=p_brand AND l.flow='nps' AND l.channel='email' AND l.piece='nps-d0'
   AND l.ref=p_ref AND lower(l.email)=lower(p_email) AND l.erro IS NULL
 ) AND NOT EXISTS(
  SELECT 1 FROM public.shrigma_email_dispatch d
  WHERE d.brand=p_brand AND d.flow='nps' AND d.piece='nps-d0' AND NOT d.is_test
   AND d.dedupe_key=jsonb_build_array('email',p_ref,'order',false)::text
   AND (d.transport_state<>'accepted' OR EXISTS(
    SELECT 1 FROM public.shrigma_email_status s WHERE s.dispatch_id=d.dispatch_id
     AND s.reconciliation_status='matched' AND NOT s.is_test
     AND s.status IN ('bounce','complaint','reject','rendering_failure')
   ))
 );
$function$;
CREATE OR REPLACE FUNCTION public.shrigma_olivas_nps_prepare(b jsonb,piece_arg text)
RETURNS TABLE(brand text,email text,ref text,piece text,tx jsonb) LANGUAGE plpgsql AS $$
DECLARE c jsonb;
BEGIN
 SELECT config INTO STRICT c FROM shrigma_nps_config WHERE singleton;
 brand='olivas';email=lower(btrim(coalesce(b->>'email','')));ref=btrim(coalesce(nullif(b->>'order_number',''),b->>'ref',''));piece=piece_arg;
 IF b->>'brand' IS DISTINCT FROM brand OR piece NOT IN ('nps-d0','nps-d3') OR email='' OR ref='' THEN RAISE EXCEPTION 'OLIVAS_NPS_INPUT_INVALID'; END IF;
 tx=jsonb_build_object('subscriber_mode','external','subscriber_email',email,'template_id',(c->'OLIVAS_TEMPLATES'->>piece)::int,
 'from_email',c->'FROM'->>'olivas','content_type','html','data',jsonb_build_object('first_name',coalesce(b->>'first_name',''),'order_number',ref,
 'nps_url',c->'LP'->>'olivas','p',ref,'e',email,'s',shrigma_nps_sign('olivas|'||ref,email)));
 RETURN NEXT;
END $$;
CREATE OR REPLACE FUNCTION public.shrigma_olivas_nps_receive(b jsonb)
RETURNS TABLE(brand text,email text,ref text,piece text,tx jsonb) LANGUAGE plpgsql AS $$
DECLARE secret text;
BEGIN
 SELECT config->>'OLIVAS_FLOW_KEY' INTO STRICT secret FROM shrigma_nps_config WHERE singleton;
 IF secret IS NULL OR b->>'k' IS DISTINCT FROM secret THEN RAISE EXCEPTION 'OLIVAS_NPS_UNAUTHORIZED'; END IF;
 RETURN QUERY SELECT * FROM shrigma_olivas_nps_prepare(b-'k','nps-d0');
END $$;
CREATE OR REPLACE FUNCTION public.shrigma_olivas_nps_claim(b jsonb)
 RETURNS TABLE(should_send boolean, dispatch_id uuid, claim_token uuid, payload jsonb, context jsonb, reason text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict use_variable
DECLARE brand text=b->>'brand';piece text=b->>'piece';flow text;email text=lower(b->>'email');ref text=b->>'ref';
 tx jsonb=b->'tx';sid int;tpl int;cfg text;sender text;reply_to text;key text;hash text;did uuid;claim uuid;
 slot jsonb;wait_time interval=interval '3 days';recipient text;keyver text;s public.subscribers%ROWTYPE;ns jsonb;nv jsonb;d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR coalesce(brand,'') NOT IN ('olivas') THEN RAISE EXCEPTION 'ENGAGEMENT_SCOPE_INVALID';END IF;
 IF piece NOT IN ('nps-d0','nps-d3') OR piece IS NULL THEN RAISE EXCEPTION 'ENGAGEMENT_PIECE_INVALID';END IF;
 flow=CASE WHEN piece='cupom-boas-vindas' THEN 'popup' ELSE 'nps' END;
 SELECT (config->'OLIVAS_TEMPLATES'->>piece)::int INTO STRICT tpl FROM shrigma_nps_config WHERE singleton;
 sender='sac@olivasdocampo.com';reply_to=sender;cfg='not-instrumented';
 IF tpl IS NULL THEN RAISE EXCEPTION 'OLIVAS_NPS_TEMPLATE_MISSING'; END IF;
 IF email IS NULL OR email<>btrim(email) OR email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR email LIKE '%@simulator.amazonses.com' THEN RAISE EXCEPTION 'ENGAGEMENT_EMAIL_INVALID';END IF;
 IF ref IS NULL OR ref='' OR octet_length(ref)>256 THEN RAISE EXCEPTION 'ENGAGEMENT_REF_INVALID';END IF;
 IF jsonb_typeof(tx) IS DISTINCT FROM 'object' OR (tx->>'template_id')::int IS DISTINCT FROM tpl OR lower(tx->>'subscriber_email') IS DISTINCT FROM email OR tx->>'content_type' IS DISTINCT FROM 'html'
 OR tx->>'from_email' NOT IN (sender,'Olivas do Campo <'||sender||'>') OR tx->>'from_email' IS NULL
 OR coalesce(tx->>'subscriber_mode','external')<>'external' THEN RAISE EXCEPTION 'ENGAGEMENT_TRANSPORT_INVALID';END IF;
 IF flow='nps' AND (tx#>>'{data,order_number}' IS DISTINCT FROM ref OR lower(tx#>>'{data,e}') IS DISTINCT FROM email OR coalesce(tx#>>'{data,s}','')='') THEN RAISE EXCEPTION 'ENGAGEMENT_NPS_CONTEXT_INVALID';END IF;
 -- Read only the published controls. A pause never reserves or marks a recipient.
 slot=public.shrigma_flow_slot(brand,'email',flow,piece);
 IF NOT coalesce((slot->>'_managed')::boolean,false) THEN RAISE EXCEPTION 'OLIVAS_NPS_FLOW_UNAVAILABLE'; END IF;
 IF (slot->>'_managed')::boolean THEN
  IF NOT coalesce((slot->>'_allowed')::boolean,false) THEN
   RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'flow_paused';RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.templates t JOIN public.shrigma_template_email_registry r ON r.template_id=t.id
   WHERE t.id::text=slot->>'template_id' AND r.brand=brand AND t.type='tx') THEN RAISE EXCEPTION 'ENGAGEMENT_TEMPLATE_UNAVAILABLE';END IF;
  IF tpl IS DISTINCT FROM (slot->>'template_id')::int THEN
   -- Let Listmonk render the selected template's subject with the same data.
   tx=(tx-'subject')||jsonb_build_object('template_id',(slot->>'template_id')::int);
  END IF;
  tpl=(slot->>'template_id')::int;
  IF piece='nps-d3' THEN wait_time=make_interval(secs=>60*(slot->>'wait_min')::double precision);END IF;
 END IF;
 -- Canonical transport and immutable context are captured before reservation.
 tx=tx||jsonb_build_object('subscriber_mode','external','subscriber_email',email,'headers',jsonb_build_array(jsonb_build_object('Reply-To',reply_to)));
 b=b||jsonb_build_object('email',email,'flow',flow,'tx',tx,'template_id',tpl);
 hash=encode(digest(convert_to(b::text,'UTF8'),'sha256'),'hex');
 key=jsonb_build_array('email',ref,CASE WHEN flow='popup' THEN email ELSE 'order' END,false)::text;
 -- Serializes different NPS orders for the same recipient as well as duplicate requests.
 PERFORM pg_advisory_xact_lock(hashtextextended('engagement:'||brand||':'||flow||':'||email,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('engagement-ref:'||brand||':'||flow||':'||piece||':'||ref,0));
 SELECT * INTO d FROM public.shrigma_email_dispatch x WHERE x.brand=brand AND x.flow=flow AND x.piece=piece AND x.dedupe_key=key FOR UPDATE;
 IF FOUND THEN RETURN QUERY SELECT false,d.dispatch_id,NULL::uuid,NULL::jsonb,NULL::jsonb,d.transport_state;RETURN;END IF;
 SELECT * INTO s FROM public.subscribers x WHERE lower(x.email)=email ORDER BY x.id LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR s.status::text<>'enabled' THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'subscriber_unavailable';RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM subscriber_lists sl WHERE sl.subscriber_id=s.id AND sl.list_id BETWEEN 40 AND 43 AND sl.status::text='confirmed') THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'olivas_subscription_unavailable';RETURN;END IF;
 sid=s.id;ns=coalesce(s.attribs->'nps_sent_olivas','{}');nv=coalesce(s.attribs->'nps_olivas','{}');
 IF flow='nps' THEN
  IF EXISTS(SELECT 1 FROM public.shrigma_send_log l WHERE l.brand=brand AND l.flow='nps' AND l.channel='email' AND l.piece=piece AND l.ref=ref) THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'legacy_already_accepted';RETURN;END IF;
  IF piece='nps-d0' THEN
   IF ns->>'order'=ref OR (ns->>'date')::timestamptz>now()-interval '45 days' OR (nv->>'date')::timestamptz>now()-interval '45 days' THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'nps_cooldown';RETURN;END IF;
  ELSE
   IF NOT public.shrigma_olivas_nps_initial_confirmed(brand,ref,email) THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'initial_not_confirmed';RETURN;END IF;
   IF ns->>'order' IS DISTINCT FROM ref OR ns->>'brand' IS DISTINCT FROM brand OR coalesce((ns->>'reminded')::boolean,true) OR ns->>'date' IS NULL OR (ns->>'date')::timestamptz>now()-wait_time OR nv->>'order'=ref THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'reminder_ineligible';RETURN;END IF;
  END IF;
 END IF;
 did=gen_random_uuid();claim=gen_random_uuid();
 INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
 SELECT did,brand,flow,piece,key,hash,'379757086665','us-east-2',cfg,r.recipient_key,r.key_version,false,'in_flight',clock_timestamp(),claim FROM public.shrigma_email_recipient_key(email) r;
 -- D0 preserves the existing mark-before-attempt rule and 45-day cooldown.
 IF piece='nps-d0' THEN
  UPDATE public.subscribers x SET attribs=coalesce(x.attribs,'{}')||jsonb_build_object('nps_sent_olivas',jsonb_build_object('order',ref,'brand',brand,'date',clock_timestamp(),'reminded',false)),updated_at=now() WHERE x.id=sid;
 END IF;
 -- SES event routing for Olivas is not enabled; never claim delivery from an API acceptance.
 RETURN QUERY SELECT true,did,claim,tx,b,'claimed';
END;$function$;
CREATE OR REPLACE FUNCTION public.shrigma_olivas_nps_record_vote(b jsonb)
 RETURNS TABLE(response jsonb, sync_id uuid)
 LANGUAGE plpgsql
AS $function$
DECLARE n int;p text=coalesce(b->>'p','');e text=lower(coalesce(b->>'e',''));
 m text='olivas';
 sub subscribers%ROWTYPE;prev jsonb;v jsonb;stamp text;bucket text;action text='novo';task text;days int;
BEGIN
 response=jsonb_build_object('ok',false,'error','assinatura inválida');
 -- The score contract is an integer 0..10. A malformed value must never be a vote.
 IF coalesce(b->>'n','') !~ '^(10|[0-9])$' THEN RETURN NEXT;RETURN;END IF;
 n=(b->>'n')::int;
 IF b->>'m' IS DISTINCT FROM 'olivas' OR p='' OR e='' OR nullif(b->>'s','') IS NULL OR public.shrigma_nps_sign('olivas|'||p,e) IS NULL OR b->>'s' IS DISTINCT FROM public.shrigma_nps_sign('olivas|'||p,e) THEN RETURN NEXT;RETURN;END IF;
 SELECT * INTO sub FROM subscribers WHERE email=e FOR UPDATE;
 IF NOT FOUND THEN response=jsonb_build_object('ok',false,'error','subscriber não encontrado');RETURN NEXT;RETURN;END IF;
 IF sub.attribs->'nps_sent_olivas'->>'order' IS DISTINCT FROM p OR NOT public.shrigma_olivas_nps_initial_confirmed('olivas',p,e) THEN RETURN NEXT;RETURN;END IF;
 prev=sub.attribs->'nps_olivas';
 SELECT (config->>'JANELA_DIAS')::int INTO STRICT days FROM public.shrigma_nps_config WHERE singleton;
 IF prev->>'order'=p THEN
  IF coalesce(prev->>'date','')<>'' AND now()>(prev->>'date')::timestamptz+make_interval(days=>days) THEN
   response=jsonb_build_object('ok',true,'locked',true,'motivo','janela de alteração expirada');RETURN NEXT;RETURN;
  END IF;
  IF prev->>'score'=n::text THEN response=jsonb_build_object('ok',true,'repetido',true);RETURN NEXT;RETURN;END IF;
  action='revoto';task=prev->>'task_id';
 END IF;
 stamp=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 bucket=CASE WHEN n<=6 THEN 'detrator' WHEN n<=8 THEN 'passivo' ELSE 'promotor' END;
 v=jsonb_build_object('order',p,'score',n,'bucket',bucket,'brand',m,'date',stamp,'task_id',task,
  'comment',CASE WHEN prev->>'order'=p THEN prev->'comment' ELSE 'null'::jsonb END,
  'area',CASE WHEN prev->>'order'=p THEN prev->'area' ELSE 'null'::jsonb END);
 UPDATE subscribers SET attribs=coalesce(attribs,'{}'::jsonb)||jsonb_build_object('nps_olivas',v),updated_at=now() WHERE id=sub.id;
 UPDATE public.shrigma_nps_vote_sync SET state='superseded',updated_at=now()
 WHERE subscriber_id=sub.id AND brand=m AND order_ref=p AND state='pending';
 INSERT INTO public.shrigma_nps_vote_sync(subscriber_id,brand,order_ref,vote_date,payload,task_id)
 VALUES(sub.id,m,p,stamp,v||jsonb_build_object('email',e),task) RETURNING id INTO sync_id;
 response=jsonb_build_object('ok',true,'acao',action,'nota',n,'bucket',bucket,'task_id',task);
 RETURN NEXT;
END $function$;
CREATE OR REPLACE FUNCTION public.shrigma_olivas_nps_claim_vote_sync(job uuid)
 RETURNS TABLE(sync_id uuid, payload jsonb)
 LANGUAGE plpgsql
AS $function$
DECLARE j public.shrigma_nps_vote_sync%ROWTYPE;
BEGIN
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job;
 IF NOT FOUND OR j.brand<>'olivas' THEN RETURN;END IF;
 PERFORM 1 FROM subscribers WHERE id=j.subscriber_id FOR UPDATE;
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job FOR UPDATE;
 IF NOT FOUND OR j.state<>'pending' THEN RETURN;END IF;
 -- Serialize side effects for the same subscriber, including concurrent revotes.
 IF EXISTS(SELECT 1 FROM public.shrigma_nps_vote_sync WHERE subscriber_id=j.subscriber_id AND id<>j.id AND state IN ('in_flight','outcome_unknown')) THEN RETURN;END IF;
 UPDATE public.shrigma_nps_vote_sync SET state='in_flight',updated_at=now() WHERE id=j.id;
 sync_id=j.id;payload=j.payload;
 SELECT payload||jsonb_build_object('task_id',coalesce(attribs->'nps_olivas'->>'task_id',j.task_id)) INTO payload FROM subscribers
 WHERE id=j.subscriber_id AND attribs->'nps_olivas'->>'order'=j.order_ref;
 IF payload IS NULL THEN payload=j.payload;END IF;
 RETURN NEXT;
END $function$;
CREATE OR REPLACE FUNCTION public.shrigma_olivas_nps_finish_vote_sync(job uuid, result jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE j public.shrigma_nps_vote_sync%ROWTYPE;t text=nullif(result->>'task_id','');
BEGIN
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job;
 IF NOT FOUND OR j.brand<>'olivas' THEN RETURN false;END IF;
 PERFORM 1 FROM subscribers WHERE id=j.subscriber_id FOR UPDATE;
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job FOR UPDATE;
 IF NOT FOUND OR j.state<>'in_flight' THEN RETURN false;END IF;
 UPDATE public.shrigma_nps_vote_sync SET state=CASE WHEN result->>'ok'='true' AND t IS NOT NULL THEN 'synced' ELSE 'outcome_unknown' END,
 task_id=coalesce(t,task_id),updated_at=now() WHERE id=job;
 IF t IS NOT NULL THEN
  -- Only attach the external ID; never rewrite a newer score or a concurrent comment.
  UPDATE subscribers SET attribs=jsonb_set(attribs,'{nps_olivas,task_id}',to_jsonb(t)),updated_at=now()
  WHERE id=j.subscriber_id AND attribs->'nps_olivas'->>'order'=j.order_ref AND attribs->'nps_olivas'->>'brand'=j.brand;
 END IF;
 RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION public.shrigma_olivas_nps_finish_http(p_id uuid,p_claim uuid,r jsonb,b jsonb)
RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text) LANGUAGE plpgsql AS $$
BEGIN
 IF b->>'brand' IS DISTINCT FROM 'olivas' THEN RAISE EXCEPTION 'OLIVAS_NPS_SCOPE'; END IF;
 RETURN QUERY SELECT * FROM public.shrigma_email_finish_engagement_http(p_id,p_claim,r,b);
 IF EXISTS(SELECT 1 FROM shrigma_email_dispatch d WHERE d.dispatch_id=p_id AND d.brand='olivas' AND d.piece='nps-d3' AND d.transport_state='accepted') THEN
  UPDATE subscribers s SET attribs=jsonb_set(s.attribs,'{nps_sent_olivas}',(s.attribs->'nps_sent_olivas')||jsonb_build_object('reminded',true,'reminded_date',clock_timestamp())),updated_at=now()
  WHERE lower(s.email)=b->>'email' AND s.attribs->'nps_sent_olivas'->>'order'=b->>'ref';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shrigma_olivas_nps_comment(b jsonb)
RETURNS TABLE(response jsonb,sync_id uuid) LANGUAGE plpgsql AS $$
DECLARE sub subscribers%ROWTYPE;v jsonb;e text=lower(coalesce(b->>'e',''));p text=coalesce(b->>'p','');c text=btrim(coalesce(b->>'comment',''));
BEGIN
 response=jsonb_build_object('ok',false,'error','Comentário não validado.');
 IF b->>'m' IS DISTINCT FROM 'olivas' OR p='' OR e='' OR b->>'s' IS DISTINCT FROM shrigma_nps_sign('olivas|'||p,e) OR c='' OR length(c)>4000 THEN RETURN NEXT;RETURN;END IF;
 SELECT * INTO sub FROM subscribers WHERE email=e FOR UPDATE;
 v=sub.attribs->'nps_olivas';
 IF NOT FOUND OR v->>'order' IS DISTINCT FROM p OR now()>(v->>'date')::timestamptz+interval '7 days' THEN RETURN NEXT;RETURN;END IF;
 IF v->>'comment'=c THEN response=jsonb_build_object('ok',true,'repetido',true);RETURN NEXT;RETURN;END IF;
 v=v||jsonb_build_object('comment',c);
 UPDATE subscribers SET attribs=jsonb_set(attribs,'{nps_olivas}',v),updated_at=now() WHERE id=sub.id;
 INSERT INTO shrigma_nps_vote_sync(subscriber_id,brand,order_ref,vote_date,payload,task_id)
 VALUES(sub.id,'olivas',p,v->>'date',v||jsonb_build_object('email',e,'sync_kind','comment'),v->>'task_id') RETURNING id INTO sync_id;
 response=jsonb_build_object('ok',true);RETURN NEXT;
END $$;

ALTER TABLE shrigma_flow_definition DROP CONSTRAINT shrigma_flow_definition_brand_check;
ALTER TABLE shrigma_flow_definition ADD CONSTRAINT shrigma_flow_definition_brand_check CHECK(brand IN ('fish','aristo','olivas'));
ALTER TABLE shrigma_template_email_registry DROP CONSTRAINT shrigma_template_email_registry_brand_check;
ALTER TABLE shrigma_template_email_registry ADD CONSTRAINT shrigma_template_email_registry_brand_check CHECK(brand IN ('fish','aristo','olivas'));
REVOKE ALL ON FUNCTION public.shrigma_olivas_nps_initial_confirmed(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shrigma_olivas_nps_prepare(jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shrigma_olivas_nps_receive(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shrigma_olivas_nps_claim(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shrigma_olivas_nps_record_vote(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shrigma_olivas_nps_claim_vote_sync(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shrigma_olivas_nps_finish_vote_sync(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shrigma_olivas_nps_finish_http(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shrigma_olivas_nps_comment(jsonb) FROM PUBLIC;