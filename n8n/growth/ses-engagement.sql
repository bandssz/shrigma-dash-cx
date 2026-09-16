-- Fish/Aristo NPS and popup delivery tracking. Run as one implicit transaction.
CREATE OR REPLACE FUNCTION public.shrigma_email_claim_engagement(b jsonb)
RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,context jsonb,reason text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
#variable_conflict use_variable
DECLARE brand text=b->>'brand';piece text=b->>'piece';flow text;email text=lower(b->>'email');ref text=b->>'ref';
 tx jsonb=b->'tx';sid int;tpl int;cfg text;sender text;reply_to text;key text;hash text;did uuid;claim uuid;
 slot jsonb;wait_time interval=interval '3 days';recipient text;keyver text;s public.subscribers%ROWTYPE;ns jsonb;nv jsonb;d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR coalesce(brand,'') NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'ENGAGEMENT_SCOPE_INVALID';END IF;
 IF piece NOT IN ('nps-d0','nps-d3','cupom-boas-vindas') OR piece IS NULL THEN RAISE EXCEPTION 'ENGAGEMENT_PIECE_INVALID';END IF;
 flow=CASE WHEN piece='cupom-boas-vindas' THEN 'popup' ELSE 'nps' END;
 tpl=CASE brand WHEN 'fish' THEN CASE piece WHEN 'nps-d0' THEN 29 WHEN 'nps-d3' THEN 31 ELSE 23 END ELSE CASE piece WHEN 'nps-d0' THEN 28 WHEN 'nps-d3' THEN 30 ELSE 22 END END;
 -- Popup sender is the existing pedidos mailbox; NPS uses contato.
 sender=(CASE WHEN flow='popup' THEN 'pedidos@' ELSE 'contato@' END)||CASE brand WHEN 'fish' THEN 'fishermans.com.br' ELSE 'oaristocrata.com' END;
 reply_to=CASE WHEN flow='popup' AND brand='fish' THEN 'pedidos@fishermans.com.br' WHEN brand='fish' THEN 'contato@fishermans.com.br' ELSE 'contato@oaristocrata.com' END;
 cfg=CASE brand WHEN 'fish' THEN 'cs-fishermans-tx' ELSE 'cs-aristocrata-tx' END;
 IF email IS NULL OR email<>btrim(email) OR email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR email LIKE '%@simulator.amazonses.com' THEN RAISE EXCEPTION 'ENGAGEMENT_EMAIL_INVALID';END IF;
 IF ref IS NULL OR ref='' OR octet_length(ref)>256 THEN RAISE EXCEPTION 'ENGAGEMENT_REF_INVALID';END IF;
 IF jsonb_typeof(tx) IS DISTINCT FROM 'object' OR (tx->>'template_id')::int IS DISTINCT FROM tpl OR lower(tx->>'subscriber_email') IS DISTINCT FROM email OR tx->>'content_type' IS DISTINCT FROM 'html'
 OR tx->>'from_email' NOT IN (sender,'Fishermans <'||sender||'>','O Aristocrata <'||sender||'>') OR tx->>'from_email' IS NULL
 OR coalesce(tx->>'subscriber_mode','external')<>'external' THEN RAISE EXCEPTION 'ENGAGEMENT_TRANSPORT_INVALID';END IF;
 IF flow='nps' AND (tx#>>'{data,order_number}' IS DISTINCT FROM ref OR lower(tx#>>'{data,e}') IS DISTINCT FROM email OR coalesce(tx#>>'{data,s}','')='') THEN RAISE EXCEPTION 'ENGAGEMENT_NPS_CONTEXT_INVALID';END IF;
 -- Read only the published controls. A pause never reserves or marks a recipient.
 slot=public.shrigma_flow_slot(brand,'email',flow,piece);
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
 sid=s.id;ns=coalesce(s.attribs->'nps_sent','{}');nv=coalesce(s.attribs->'nps','{}');
 IF flow='nps' THEN
  IF EXISTS(SELECT 1 FROM public.shrigma_send_log l WHERE l.brand=brand AND l.flow='nps' AND l.channel='email' AND l.piece=piece AND l.ref=ref) THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'legacy_already_accepted';RETURN;END IF;
  IF piece='nps-d0' THEN
   IF ns->>'order'=ref OR (ns->>'date')::timestamptz>now()-interval '45 days' OR (nv->>'date')::timestamptz>now()-interval '45 days' THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'nps_cooldown';RETURN;END IF;
  ELSE
   IF NOT public.shrigma_nps_initial_confirmed(brand,ref,email) THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'initial_not_confirmed';RETURN;END IF;
   IF ns->>'order' IS DISTINCT FROM ref OR ns->>'brand' IS DISTINCT FROM brand OR coalesce((ns->>'reminded')::boolean,true) OR ns->>'date' IS NULL OR (ns->>'date')::timestamptz>now()-wait_time OR nv->>'order'=ref THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'reminder_ineligible';RETURN;END IF;
  END IF;
 END IF;
 did=gen_random_uuid();claim=gen_random_uuid();
 INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
 SELECT did,brand,flow,piece,key,hash,'379757086665','us-east-2',cfg,r.recipient_key,r.key_version,false,'in_flight',clock_timestamp(),claim FROM public.shrigma_email_recipient_key(email) r;
 -- D0 preserves the existing mark-before-attempt rule and 45-day cooldown.
 IF piece='nps-d0' THEN
  UPDATE public.subscribers x SET attribs=coalesce(x.attribs,'{}')||jsonb_build_object('nps_sent',jsonb_build_object('order',ref,'brand',brand,'date',clock_timestamp(),'reminded',false)),updated_at=now() WHERE x.id=sid;
 END IF;
 tx=jsonb_set(tx,'{headers}',(tx->'headers')||jsonb_build_array(jsonb_build_object('X-SES-CONFIGURATION-SET',cfg),jsonb_build_object('X-SES-MESSAGE-TAGS','crm_dispatch_id='||did::text||', crm_test=false')));
 RETURN QUERY SELECT true,did,claim,tx,b,'claimed';
END;$f$;
REVOKE ALL ON FUNCTION public.shrigma_email_claim_engagement(jsonb) FROM PUBLIC;

CREATE FUNCTION public.shrigma_email_finish_engagement(p_id uuid,p_claim uuid,p_outcome text,b jsonb)
RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
#variable_conflict use_variable
DECLARE d public.shrigma_email_dispatch%ROWTYPE;logid bigint;err text;hash text;
BEGIN
 IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','outcome_unknown') THEN RAISE EXCEPTION 'ENGAGEMENT_OUTCOME_INVALID';END IF;
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id FOR UPDATE;
 hash=encode(digest(convert_to(b::text,'UTF8'),'sha256'),'hex');
 IF p_claim IS NULL OR d.claim_token IS DISTINCT FROM p_claim OR d.brand IS DISTINCT FROM b->>'brand' OR d.flow NOT IN ('nps','popup') OR d.payload_sha256 IS DISTINCT FROM hash THEN RAISE EXCEPTION 'ENGAGEMENT_FINISH_MISMATCH';END IF;
 IF d.transport_state<>'in_flight' THEN
  IF d.transport_state<>p_outcome THEN RAISE EXCEPTION 'ENGAGEMENT_OUTCOME_CONFLICT';END IF;
  RETURN QUERY SELECT d.dispatch_id,d.transport_state,d.send_log_id,d.error_code;RETURN;
 END IF;
 IF p_outcome='accepted' THEN
  INSERT INTO public.shrigma_send_log(email,brand,kind,flow,channel,piece,template_id,ref)
  VALUES(b->>'email',d.brand,'tx',d.flow,'email',d.piece,(b->>'template_id')::int,b->>'ref')
  ON CONFLICT DO NOTHING RETURNING id INTO logid;
  IF logid IS NULL THEN err='LEGACY_LOG_CONFLICT_AFTER_ACCEPT';END IF;
  IF d.piece='nps-d3' THEN
   -- Update only the current reminder marker, preserving concurrent votes and other attributes.
   UPDATE public.subscribers x SET attribs=jsonb_set(x.attribs,'{nps_sent}',(x.attribs->'nps_sent')||jsonb_build_object('reminded',true,'reminded_date',clock_timestamp())),updated_at=now()
   WHERE lower(x.email)=b->>'email' AND x.attribs->'nps_sent'->>'order'=b->>'ref' AND x.attribs->'nps_sent'->>'brand'=d.brand;
  END IF;
 ELSE err='LISTMONK_'||upper(p_outcome);END IF;
 UPDATE public.shrigma_email_dispatch x SET transport_state=p_outcome,outcome_at=clock_timestamp(),accepted_at=CASE WHEN p_outcome='accepted' THEN clock_timestamp() END,send_log_id=logid,error_code=err WHERE x.dispatch_id=p_id;
 RETURN QUERY SELECT p_id,p_outcome,logid,err;
END;$f$;
REVOKE ALL ON FUNCTION public.shrigma_email_finish_engagement(uuid,uuid,text,jsonb) FROM PUBLIC;
