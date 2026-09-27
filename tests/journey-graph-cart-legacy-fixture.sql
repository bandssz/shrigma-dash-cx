-- Synthetic fixture: exact read-only exported CART function definitions. No production data.
CREATE OR REPLACE FUNCTION public.shrigma_email_claim_cart(b jsonb)
 RETURNS TABLE(should_send boolean, dispatch_id uuid, claim_token uuid, payload jsonb, context jsonb, reason text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_brand text=b->>'brand'; v_stage text=b->>'toque'; v_piece text; v_template int;
v_id int; v_at timestamptz; v_ref text; v_key text; v_hash text; v_cfg text; v_list int;
v_recipient text; v_key_version text; v_dispatch uuid; v_claim uuid; v_tx jsonb=b->'tx';
s public.subscribers%ROWTYPE; a jsonb; f jsonb; age interval; stage_now text; stage_config jsonb;
d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR coalesce(v_brand,'') NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'CART_SCOPE_INVALID'; END IF;
v_piece='carrinho-'||CASE v_stage WHEN 't05' THEN '30min' WHEN 't1' THEN '1h' WHEN 't2' THEN '2h' WHEN 't24' THEN '24h' WHEN 't48' THEN '48h' END;
v_template=(CASE v_brand WHEN 'fish' THEN '{"t05":60,"t1":11,"t2":61,"t24":26,"t48":27}' ELSE '{"t05":95,"t1":96,"t2":97,"t24":98,"t48":99}' END::jsonb->>v_stage)::int;
IF v_piece IS NULL OR b->>'piece' IS DISTINCT FROM v_piece OR b->>'chave' IS DISTINCT FROM 'cart_'||v_stage||'_at' OR (b->>'template_id')::int IS DISTINCT FROM v_template OR (v_tx->>'template_id')::int IS DISTINCT FROM v_template THEN RAISE EXCEPTION 'CART_TEMPLATE_INVALID'; END IF;
stage_config=shrigma_flow_slot(v_brand,'email','carrinho',v_piece);
IF (stage_config->>'_managed')::boolean THEN
 IF NOT (stage_config->>'_allowed')::boolean THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'flow_paused';RETURN;END IF;
 v_template=(stage_config->>'template_id')::int;
 v_tx=jsonb_set(v_tx,'{template_id}',to_jsonb(v_template));
 b=b||jsonb_build_object('template_id',v_template,'tx',v_tx);
END IF;
IF coalesce(b->>'subscriber_id','') !~ '^[1-9][0-9]*$' OR coalesce(b->>'ref','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN RAISE EXCEPTION 'CART_IDENTITY_INVALID'; END IF;
v_id=(b->>'subscriber_id')::int;v_at=(b->>'ref')::timestamptz;
v_ref=to_char(v_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
v_key=jsonb_build_array('email',v_ref,v_id,false)::text;
v_hash=encode(digest(convert_to(jsonb_set(b-'marketing_7d','{ref}',to_jsonb(v_ref))::text,'UTF8'),'sha256'),'hex');
IF v_tx->>'subscriber_email' IS DISTINCT FROM b->>'email' OR coalesce(b->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR lower(b->>'email') LIKE '%@simulator.amazonses.com' THEN RAISE EXCEPTION 'CART_EMAIL_INVALID'; END IF;
IF v_tx->>'from_email' IS DISTINCT FROM (CASE v_brand WHEN 'fish' THEN 'Fishermans <contato@fishermans.com.br>' ELSE 'O Aristocrata <contato@oaristocrata.com>' END)
 OR v_tx->'headers' IS DISTINCT FROM jsonb_build_array(jsonb_build_object('Reply-To',CASE v_brand WHEN 'fish' THEN 'contato@fishermans.com.br' ELSE 'contato@oaristocrata.com' END)) THEN RAISE EXCEPTION 'CART_SENDER_INVALID'; END IF;
PERFORM pg_advisory_xact_lock(hashtextextended('r4-claim:'||v_brand||':carrinho:'||v_piece||':'||v_key,0));
SELECT * INTO d FROM public.shrigma_email_dispatch x WHERE x.brand=v_brand AND x.flow='carrinho' AND x.piece=v_piece AND x.dedupe_key=v_key FOR UPDATE;
IF FOUND THEN RETURN QUERY SELECT false,d.dispatch_id,NULL::uuid,NULL::jsonb,NULL::jsonb,CASE WHEN d.payload_sha256<>v_hash THEN 'payload_conflict' ELSE d.transport_state END; RETURN; END IF;
SELECT * INTO s FROM public.subscribers WHERE id=v_id FOR UPDATE;
IF NOT FOUND THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'subscriber_missing';RETURN;END IF;
a=s.attribs->v_brand; f=coalesce(a->'flows','{}');v_list=CASE v_brand WHEN 'fish' THEN 22 ELSE 21 END;
IF s.status::text<>'enabled' OR lower(s.email) IS DISTINCT FROM lower(b->>'email')
 OR NOT EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.subscriber_id=v_id AND sl.list_id=v_list AND sl.status::text<>'unsubscribed')
 OR (a->>'cart_abandoned_at')::timestamptz IS DISTINCT FROM v_at
 OR coalesce(a->>'cart_url','')=''
 OR v_tx#>>'{data,checkout_url}' IS DISTINCT FROM (a->>'cart_url')||(CASE WHEN position('?' in a->>'cart_url')>0 THEN '&' ELSE '?' END)||'utm_source=email&utm_medium=fluxo&utm_campaign='||v_brand||'-carrinho&utm_content='||v_piece
 OR (CASE WHEN a->>'last_order_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (a->>'last_order_at')::timestamptz END)>=v_at
 THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'eligibility_changed';RETURN;END IF;
age=now()-v_at;
stage_now=CASE
 WHEN age>=shrigma_flow_wait(v_brand,'email','carrinho-30min',30) AND shrigma_flow_stage_enabled(v_brand,'email','carrinho-30min') AND age<interval '1 hour' AND NOT f?'cart_t05_at' THEN 't05'
 WHEN age>=shrigma_flow_wait(v_brand,'email','carrinho-1h',60) AND shrigma_flow_stage_enabled(v_brand,'email','carrinho-1h') AND age<interval '4 hours' AND NOT f?'cart_t1_at' THEN 't1'
 WHEN age>=shrigma_flow_wait(v_brand,'email','carrinho-2h',120) AND shrigma_flow_stage_enabled(v_brand,'email','carrinho-2h') AND age<interval '5 hours' AND NOT f?'cart_t2_at' AND (NOT f?'cart_t1_at' OR (f->>'cart_t1_at')::timestamptz<=now()-interval '45 minutes') THEN 't2'
 WHEN age>=shrigma_flow_wait(v_brand,'email','carrinho-24h',1440) AND shrigma_flow_stage_enabled(v_brand,'email','carrinho-24h') AND age<interval '27 hours' AND NOT f?'cart_t24_at' THEN 't24'
 WHEN age>=shrigma_flow_wait(v_brand,'email','carrinho-48h',2880) AND shrigma_flow_stage_enabled(v_brand,'email','carrinho-48h') AND age<interval '51 hours' AND NOT f?'cart_t48_at' THEN 't48' END;
IF stage_now IS DISTINCT FROM v_stage OR (v_stage IN ('t24','t48') AND coalesce((SELECT x.marketing_7d FROM public.shrigma_exposure_7d x WHERE x.subscriber_id=v_id),0)>=3) THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'cadence_or_cap_changed';RETURN;END IF;
IF EXISTS(SELECT 1 FROM public.shrigma_send_log l WHERE l.brand=v_brand AND l.flow='carrinho' AND l.piece=v_piece AND l.subscriber_id=v_id AND l.channel='email' AND CASE WHEN l.ref ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN l.ref::timestamptz=v_at ELSE false END) THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'legacy_already_accepted';RETURN;END IF;
v_cfg=CASE v_brand WHEN 'fish' THEN 'cs-fishermans-tx' ELSE 'cs-aristocrata-tx' END;
SELECT r.recipient_key,r.key_version INTO v_recipient,v_key_version FROM public.shrigma_email_recipient_key(b->>'email') r;
v_dispatch=gen_random_uuid();v_claim=gen_random_uuid();
INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
VALUES(v_dispatch,v_brand,'carrinho',v_piece,v_key,v_hash,'379757086665','us-east-2',v_cfg,v_recipient,v_key_version,false,'in_flight',clock_timestamp(),v_claim);
v_tx=jsonb_set(v_tx,'{headers}',(v_tx->'headers')||jsonb_build_array(jsonb_build_object('X-SES-CONFIGURATION-SET',v_cfg),jsonb_build_object('X-SES-MESSAGE-TAGS','crm_dispatch_id='||v_dispatch::text||', crm_test=false')));
RETURN QUERY SELECT true,v_dispatch,v_claim,v_tx,b,'claimed';
END;$function$;
CREATE OR REPLACE FUNCTION public.shrigma_email_finish_cart(p_id uuid, p_claim uuid, p_outcome text, b jsonb)
 RETURNS TABLE(dispatch_id uuid, transport_state text, send_log_id bigint, error_code text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE d public.shrigma_email_dispatch%ROWTYPE; v_ref text;v_hash text;v_log bigint;v_error text;
BEGIN
IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','outcome_unknown') THEN RAISE EXCEPTION 'DISPATCH_OUTCOME_INVALID';END IF;
SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id FOR UPDATE;
IF p_claim IS NULL OR d.claim_token IS DISTINCT FROM p_claim OR d.brand IS DISTINCT FROM b->>'brand' OR d.flow<>'carrinho' THEN RAISE EXCEPTION 'DISPATCH_CLAIM_MISMATCH';END IF;
v_ref=to_char((b->>'ref')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
v_hash=encode(digest(convert_to(jsonb_set(b-'marketing_7d','{ref}',to_jsonb(v_ref))::text,'UTF8'),'sha256'),'hex');
IF v_hash IS DISTINCT FROM d.payload_sha256 THEN RAISE EXCEPTION 'DISPATCH_FINISH_PAYLOAD_MISMATCH';END IF;
IF d.transport_state<>'in_flight' THEN
 IF d.transport_state<>p_outcome THEN RAISE EXCEPTION 'DISPATCH_OUTCOME_CONFLICT';END IF;
 RETURN QUERY SELECT d.dispatch_id,d.transport_state,d.send_log_id,d.error_code;RETURN;
END IF;
IF p_outcome='accepted' THEN
 INSERT INTO public.shrigma_send_log(email,brand,kind,flow,channel,piece,template_id,ref,subscriber_id)
 VALUES(b->>'email',d.brand,'tx','carrinho','email',d.piece,(b->>'template_id')::int,b->>'ref',(b->>'subscriber_id')::int)
 ON CONFLICT DO NOTHING RETURNING id INTO v_log;
 IF v_log IS NULL THEN v_error='LEGACY_LOG_CONFLICT_AFTER_ACCEPT';END IF;
 -- A late response must never mark a newer cart cycle as already notified.
 UPDATE public.subscribers s SET attribs=coalesce(s.attribs,'{}')||jsonb_build_object(d.brand,
 coalesce(s.attribs->d.brand,'{}')||jsonb_build_object('flows',coalesce(s.attribs->d.brand->'flows','{}')||jsonb_build_object(b->>'chave',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))),updated_at=now()
 WHERE s.id=(b->>'subscriber_id')::int AND (s.attribs->d.brand->>'cart_abandoned_at')::timestamptz=(b->>'ref')::timestamptz;
ELSE v_error='LISTMONK_'||upper(p_outcome);END IF;
UPDATE public.shrigma_email_dispatch x SET transport_state=p_outcome,outcome_at=clock_timestamp(),accepted_at=CASE WHEN p_outcome='accepted' THEN clock_timestamp() END,send_log_id=v_log,error_code=v_error WHERE x.dispatch_id=p_id;
RETURN QUERY SELECT p_id,p_outcome,v_log,v_error;
END;$function$;
