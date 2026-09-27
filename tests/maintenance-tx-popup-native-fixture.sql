-- Synthetic database only. Real TX bodies/lock order from reviewed exports.
-- Only SES account changes to 000000000000 and WA-only selector constants to [].
-- No control flow changes. HMAC fixture/tables are synthetic, never transport.
ALTER TABLE shrigma_email_dispatch ADD COLUMN payload_sha256 text,ADD COLUMN account_id text,ADD COLUMN region text,ADD COLUMN configuration_set text,ADD COLUMN recipient_key text,ADD COLUMN recipient_key_version text,ADD COLUMN started_at timestamptz,ADD COLUMN accepted_at timestamptz,ADD COLUMN outcome_at timestamptz,ADD COLUMN send_log_id bigint,ADD COLUMN error_code text;
CREATE TABLE shrigma_send_log(id bigserial PRIMARY KEY,email text,brand text,kind text,flow text,channel text,piece text,template_id integer,ref text,subscriber_id integer);
CREATE UNIQUE INDEX synthetic_native_send_log_once ON shrigma_send_log(brand,flow,piece,ref,coalesce(subscriber_id,0)) WHERE channel='email';
CREATE TABLE templates(id integer PRIMARY KEY,subject text);
INSERT INTO templates VALUES(5,'Synthetic Fish'),(15,'Synthetic Aristo');
CREATE TABLE shrigma_flow_definition(key text PRIMARY KEY,brand text,published_version integer,published jsonb,binding jsonb,enabled boolean,runtime_ready boolean);
INSERT INTO shrigma_flow_definition SELECT b||':pedido',b,1,jsonb_build_object('steps',jsonb_build_array(jsonb_build_object('key','email:pedido-confirmado','channel','email','flow','transacional','piece','pedido-confirmado','enabled',true,'template_id',t))),jsonb_build_object('steps',jsonb_build_array(jsonb_build_object('key','email:pedido-confirmado','channel','email','flow','transacional','piece','pedido-confirmado'))),true,true FROM (VALUES('fish','5'),('aristo','15')) v(b,t);
CREATE FUNCTION public.digest(b bytea,algorithm text) RETURNS bytea LANGUAGE plpgsql IMMUTABLE AS $$BEGIN IF algorithm<>'sha256' THEN RAISE EXCEPTION 'SYNTHETIC_DIGEST_ALGORITHM';END IF;RETURN sha256(b);END$$;
CREATE FUNCTION public.shrigma_email_recipient_key(email text) RETURNS TABLE(recipient_key text,key_version text) LANGUAGE sql IMMUTABLE AS $$SELECT encode(sha256(convert_to('synthetic-only:'||lower(email),'UTF8')),'hex'),'synthetic-v1'$$;

-- Production MD5 2bbb5a4d82999780838351f1723bd52d; fixture only.
DROP FUNCTION shrigma_flow_slot_wa_versioned_v1(text,text,text,text,text,text,text);
CREATE OR REPLACE FUNCTION public.shrigma_flow_slot_wa_versioned_v1(p_brand text, p_channel text, p_flow text, p_piece text, p_variant text, p_source text, p_runtime_contract text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE cfg jsonb; r jsonb; matches jsonb; selected jsonb; entries constant jsonb := '[]'::jsonb;
BEGIN
 SELECT coalesce((SELECT coalesce(s.value,'{}'::jsonb)||jsonb_build_object('_managed',true,'_allowed',f.enabled AND coalesce((s.value->>'enabled')::boolean,false),'_flow_key',f.key,'_version',f.published_version)
 FROM public.shrigma_flow_definition f CROSS JOIN LATERAL jsonb_array_elements(f.binding->'steps') b
 LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(f.published->'steps') WHERE value->>'key'=b->>'key') s ON true
 WHERE f.brand=p_brand AND f.runtime_ready AND b->>'channel'=p_channel AND b->>'flow'=p_flow AND b->>'piece'=p_piece
 AND coalesce(b->>'variant','')=coalesce(p_variant,'')
 AND (coalesce(b->>'source_template_id','')='' OR b->>'source_template_id'=p_source OR s.value->>'template_id'=p_source)
 ORDER BY f.key,b->>'key' LIMIT 1),jsonb_build_object('_managed',false)) INTO cfg;
 SELECT jsonb_agg(value) INTO matches FROM jsonb_array_elements(entries)
 WHERE p_channel='whatsapp' AND value->>'brand'=p_brand AND value->>'flow'=p_flow AND value->>'piece'=p_piece AND value->>'variant'=coalesce(p_variant,'')
 AND p_source IN (value->>'caller_template_id',value->'prior'->>'template_id',value->'target'->>'template_id');
 IF matches IS NULL THEN RETURN cfg; END IF;
 IF jsonb_array_length(matches)<>1 THEN RETURN cfg||jsonb_build_object('_managed',true,'_allowed',false,'_compatibility_block','release_slot_ambiguous'); END IF;
 r:=matches->0;
 IF cfg->'_managed' IS DISTINCT FROM 'true'::jsonb OR cfg->>'_flow_key' IS DISTINCT FROM r->>'flow_key' OR cfg->>'key' IS DISTINCT FROM r->>'step_key' THEN
  RETURN cfg||jsonb_build_object('_managed',true,'_allowed',false,'_compatibility_block','release_slot_unavailable');
 END IF;
 selected:=jsonb_build_object('template_id',cfg->'template_id','template_name',cfg->'template_name','category',cfg->'category','signature',cfg->'signature');
 IF selected IS DISTINCT FROM r->'prior' AND selected IS DISTINCT FROM r->'target' THEN
  RETURN cfg||jsonb_build_object('_allowed',false,'_compatibility_block','release_selection_drift');
 END IF;
 IF p_runtime_contract IS DISTINCT FROM 'legacy' AND p_runtime_contract IS DISTINCT FROM 'wa-order-status-v1' THEN
  RETURN cfg||jsonb_build_object('_allowed',false,'_compatibility_block','runtime_contract_unknown');
 END IF;
 IF selected=r->'target' AND (coalesce((cfg->>'_version')::integer,0)<(r->>'source_version')::integer+1) THEN
  RETURN cfg||jsonb_build_object('_allowed',false,'_compatibility_block','release_version_not_published');
 END IF;
 -- Only identity/category/signature are pinned. Current enabled, _allowed,
 -- flow/piece/key, cadence and logical deduplication identities never change.
 IF p_runtime_contract='legacy' AND selected=r->'target' THEN
  RETURN cfg||(r->'prior')||jsonb_build_object('_runtime_contract','legacy','_runtime_content_version',r->'source_version','_runtime_release','wa-order-status-v1');
 END IF;
 RETURN cfg||jsonb_build_object('_runtime_contract',p_runtime_contract,'_runtime_content_version',cfg->'_version','_runtime_release','wa-order-status-v1');
END $function$
;

-- Production MD5 317826f7f346e13b4c0e4d8300cf8fb4; fixture only.
DROP FUNCTION shrigma_flow_slot(text,text,text,text,text,text);
CREATE OR REPLACE FUNCTION public.shrigma_flow_slot(p_brand text, p_channel text, p_flow text, p_piece text, p_variant text DEFAULT ''::text, p_source text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
 SELECT public.shrigma_flow_slot_wa_versioned_v1(p_brand,p_channel,p_flow,p_piece,p_variant,p_source,'legacy')
$function$
;

-- Production MD5 0f405a4db22f62ff515b8725d894baaa; fixture only.
DROP FUNCTION shrigma_email_claim_fish(jsonb,boolean);
CREATE OR REPLACE FUNCTION public.shrigma_email_claim_fish(p_body jsonb, p_test boolean DEFAULT false)
 RETURNS TABLE(should_send boolean, dispatch_id uuid, claim_token uuid, payload jsonb, reason text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE b jsonb=p_body; v_ref text; v_piece text; v_dedupe text; v_payload jsonb; v_hash text;
v_recipient text; v_key_version text; v_id uuid; v_claim uuid; d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR p_test IS NULL THEN RAISE EXCEPTION 'DISPATCH_BODY_INVALID'; END IF;
IF coalesce(b->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RAISE EXCEPTION 'DISPATCH_EMAIL_INVALID'; END IF;
IF coalesce(b->>'from_email','') !~* '(^|<)[^<>[:space:]@]+@fishermans\.com\.br>?$' THEN RAISE EXCEPTION 'DISPATCH_FROM_INVALID'; END IF;
IF coalesce(b->>'template_id','') !~ '^[0-9]+$' OR (b->>'template_id')::int<=0 OR coalesce(b->>'subject','')='' THEN RAISE EXCEPTION 'DISPATCH_TEMPLATE_INVALID'; END IF;
v_ref=nullif(b->>'order_id','');
IF v_ref IS NULL OR octet_length(v_ref)>256 THEN RAISE EXCEPTION 'DISPATCH_REF_REQUIRED'; END IF;
IF coalesce(b->>'event_type','') NOT IN ('recebido','confirmado','preparando','enviado','em_rota','entregue','cancelado') THEN RAISE EXCEPTION 'DISPATCH_EVENT_NOT_ALLOWED'; END IF;
IF p_test AND b->>'email' NOT IN ('success@simulator.amazonses.com','bounce@simulator.amazonses.com') THEN RAISE EXCEPTION 'DISPATCH_TEST_RECIPIENT_FORBIDDEN'; END IF;
IF NOT p_test AND lower(b->>'email') LIKE '%@simulator.amazonses.com' THEN RAISE EXCEPTION 'DISPATCH_COMMERCIAL_SIMULATOR_FORBIDDEN'; END IF;
v_piece='pedido-'||(b->>'event_type');
v_dedupe=jsonb_build_array('email',v_ref,0,p_test)::text;
-- Fingerprint only the transport contract, excluding nondeterministic tracking telemetry.
v_payload=jsonb_build_object('subscriber_mode','external','subscriber_email',b->>'email','from_email',b->>'from_email',
  'template_id',(b->>'template_id')::int,'subject',b->>'subject','content_type','html',
  'headers',jsonb_build_array(jsonb_build_object('Reply-To',b->>'reply_to')),'data',b);
v_hash=encode(digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
SELECT r.recipient_key,r.key_version INTO v_recipient,v_key_version FROM public.shrigma_email_recipient_key(b->>'email') r;
PERFORM pg_advisory_xact_lock(hashtextextended('r4-claim:fish:transacional:'||v_piece||':'||v_dedupe,0));
SELECT * INTO d FROM public.shrigma_email_dispatch x WHERE x.brand='fish' AND x.flow='transacional' AND x.piece=v_piece AND x.dedupe_key=v_dedupe FOR UPDATE;
IF FOUND THEN
 RETURN QUERY SELECT false,d.dispatch_id,NULL::uuid,NULL::jsonb,
 CASE WHEN d.payload_sha256<>v_hash THEN 'payload_conflict' ELSE d.transport_state END; RETURN;
END IF;
-- Never replay a previously accepted legacy order when introducing the outbox.
IF NOT p_test AND EXISTS(SELECT 1 FROM public.shrigma_send_log l WHERE l.brand='fish' AND l.flow='transacional' AND l.piece=v_piece AND l.ref=v_ref AND l.channel='email' AND coalesce(l.subscriber_id,0)=0) THEN
 RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,'legacy_already_accepted'; RETURN;
END IF;
v_id=gen_random_uuid();v_claim=gen_random_uuid();
INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
VALUES(v_id,'fish','transacional',v_piece,v_dedupe,v_hash,'000000000000','us-east-2','cs-fishermans-tx',v_recipient,v_key_version,p_test,'in_flight',clock_timestamp(),v_claim);
v_payload=jsonb_set(v_payload,'{headers}',(v_payload->'headers')||jsonb_build_array(
 jsonb_build_object('X-SES-CONFIGURATION-SET','cs-fishermans-tx'),
 jsonb_build_object('X-SES-MESSAGE-TAGS','crm_dispatch_id='||v_id::text||', crm_test='||p_test::text)));
RETURN QUERY SELECT true,v_id,v_claim,v_payload,'claimed';
END;$function$
;

-- Production MD5 133c671b20fb971651b7e8999908c246; fixture only.
DROP FUNCTION shrigma_email_claim_aristo(jsonb,boolean);
CREATE OR REPLACE FUNCTION public.shrigma_email_claim_aristo(p_body jsonb, p_test boolean DEFAULT false)
 RETURNS TABLE(should_send boolean, dispatch_id uuid, claim_token uuid, payload jsonb, reason text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE b jsonb=p_body; v_ref text; v_piece text; v_dedupe text; v_payload jsonb; v_hash text;
v_recipient text; v_key_version text; v_id uuid; v_claim uuid; d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR p_test IS NULL THEN RAISE EXCEPTION 'DISPATCH_BODY_INVALID'; END IF;
IF coalesce(b->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RAISE EXCEPTION 'DISPATCH_EMAIL_INVALID'; END IF;
IF coalesce(b->>'from_email','') !~* '(^|<)[^<>[:space:]@]+@oaristocrata\.com>?$' THEN RAISE EXCEPTION 'DISPATCH_FROM_INVALID'; END IF;
IF coalesce(b->>'template_id','') !~ '^[0-9]+$' OR (b->>'template_id')::int<=0 OR coalesce(b->>'subject','')='' THEN RAISE EXCEPTION 'DISPATCH_TEMPLATE_INVALID'; END IF;
v_ref=nullif(b->>'order_id','');
IF v_ref IS NULL OR octet_length(v_ref)>256 THEN RAISE EXCEPTION 'DISPATCH_REF_REQUIRED'; END IF;
IF coalesce(b->>'event_type','') NOT IN ('recebido','confirmado','preparando','enviado','em_rota','entregue','cancelado') THEN RAISE EXCEPTION 'DISPATCH_EVENT_NOT_ALLOWED'; END IF;
IF p_test AND b->>'email' NOT IN ('success@simulator.amazonses.com','bounce@simulator.amazonses.com') THEN RAISE EXCEPTION 'DISPATCH_TEST_RECIPIENT_FORBIDDEN'; END IF;
IF NOT p_test AND lower(b->>'email') LIKE '%@simulator.amazonses.com' THEN RAISE EXCEPTION 'DISPATCH_COMMERCIAL_SIMULATOR_FORBIDDEN'; END IF;
v_piece='pedido-'||(b->>'event_type');
v_dedupe=jsonb_build_array('email',v_ref,0,p_test)::text;
-- Fingerprint only the transport contract, excluding nondeterministic tracking telemetry.
v_payload=jsonb_build_object('subscriber_mode','external','subscriber_email',b->>'email','from_email',b->>'from_email',
  'template_id',(b->>'template_id')::int,'subject',b->>'subject','content_type','html',
  'headers',jsonb_build_array(jsonb_build_object('Reply-To',b->>'reply_to')),'data',b);
v_hash=encode(digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
SELECT r.recipient_key,r.key_version INTO v_recipient,v_key_version FROM public.shrigma_email_recipient_key(b->>'email') r;
PERFORM pg_advisory_xact_lock(hashtextextended('r4-claim:aristo:transacional:'||v_piece||':'||v_dedupe,0));
SELECT * INTO d FROM public.shrigma_email_dispatch x WHERE x.brand='aristo' AND x.flow='transacional' AND x.piece=v_piece AND x.dedupe_key=v_dedupe FOR UPDATE;
IF FOUND THEN
 RETURN QUERY SELECT false,d.dispatch_id,NULL::uuid,NULL::jsonb,
 CASE WHEN d.payload_sha256<>v_hash THEN 'payload_conflict' ELSE d.transport_state END; RETURN;
END IF;
-- Never replay a previously accepted legacy order when introducing the outbox.
IF NOT p_test AND EXISTS(SELECT 1 FROM public.shrigma_send_log l WHERE l.brand='aristo' AND l.flow='transacional' AND l.piece=v_piece AND l.ref=v_ref AND l.channel='email' AND coalesce(l.subscriber_id,0)=0) THEN
 RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,'legacy_already_accepted'; RETURN;
END IF;
v_id=gen_random_uuid();v_claim=gen_random_uuid();
INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
VALUES(v_id,'aristo','transacional',v_piece,v_dedupe,v_hash,'000000000000','us-east-2','cs-aristocrata-tx',v_recipient,v_key_version,p_test,'in_flight',clock_timestamp(),v_claim);
v_payload=jsonb_set(v_payload,'{headers}',(v_payload->'headers')||jsonb_build_array(
 jsonb_build_object('X-SES-CONFIGURATION-SET','cs-aristocrata-tx'),
 jsonb_build_object('X-SES-MESSAGE-TAGS','crm_dispatch_id='||v_id::text||', crm_test='||p_test::text)));
RETURN QUERY SELECT true,v_id,v_claim,v_payload,'claimed';
END;$function$
;

-- Production MD5 14f2403a6b069a21d995b424cd522f03; fixture only.
DROP FUNCTION shrigma_flow_email_claim_tx(text,jsonb);
CREATE OR REPLACE FUNCTION public.shrigma_flow_email_claim_tx(p_brand text, p_body jsonb)
 RETURNS TABLE(should_send boolean, dispatch_id uuid, claim_token uuid, payload jsonb, context jsonb, reason text)
 LANGUAGE plpgsql
AS $function$
DECLARE b jsonb:=p_body;s jsonb;r record;
BEGIN
 IF p_brand NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'FLOW_BRAND_INVALID';END IF;
 -- Listmonk transports external transactional addresses in lowercase. Capture
 -- that exact address before reserving; finish uses the returned context.
 IF jsonb_typeof(b->'email')='string' THEN b:=b||jsonb_build_object('email',lower(b->>'email'));END IF;
 s:=shrigma_flow_slot(p_brand,'email','transacional','pedido-'||(b->>'event_type'));
 IF (s->>'_managed')::boolean THEN
  IF NOT (s->>'_allowed')::boolean THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'flow_paused';RETURN;END IF;
  -- The captured body is returned as context, so a publication during HTTP cannot change the finish fingerprint.
  b:=b||jsonb_build_object('template_id',(s->>'template_id')::int);
  IF s->>'template_id' IS DISTINCT FROM p_body->>'template_id' THEN
   b:=b||jsonb_build_object('subject',(SELECT subject FROM templates WHERE id=(s->>'template_id')::int));END IF;
 END IF;
 IF p_brand='fish' THEN SELECT * INTO r FROM shrigma_email_claim_fish(b,false);
 ELSE SELECT * INTO r FROM shrigma_email_claim_aristo(b,false);END IF;
 RETURN QUERY SELECT r.should_send,r.dispatch_id,r.claim_token,r.payload,b,r.reason;
END $function$
;

-- Production MD5 305f4c630ce254776e07d7089482ddb4; fixture only.
DROP FUNCTION shrigma_email_finish_fish(uuid,uuid,text,jsonb);
CREATE OR REPLACE FUNCTION public.shrigma_email_finish_fish(p_id uuid, p_claim uuid, p_outcome text, p_body jsonb)
 RETURNS TABLE(dispatch_id uuid, transport_state text, send_log_id bigint, error_code text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE d public.shrigma_email_dispatch%ROWTYPE; v_log bigint; v_error text; v_hash text; v_payload jsonb;
BEGIN
IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','outcome_unknown') THEN RAISE EXCEPTION 'DISPATCH_OUTCOME_INVALID'; END IF;
SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id FOR UPDATE;
IF p_claim IS NULL OR d.claim_token IS DISTINCT FROM p_claim OR d.brand<>'fish' OR d.flow<>'transacional' THEN RAISE EXCEPTION 'DISPATCH_CLAIM_MISMATCH'; END IF;
v_payload=jsonb_build_object('subscriber_mode','external','subscriber_email',p_body->>'email','from_email',p_body->>'from_email',
 'template_id',(p_body->>'template_id')::int,'subject',p_body->>'subject','content_type','html',
 'headers',jsonb_build_array(jsonb_build_object('Reply-To',p_body->>'reply_to')),'data',p_body);
v_hash=encode(digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
IF v_hash IS DISTINCT FROM d.payload_sha256 THEN RAISE EXCEPTION 'DISPATCH_FINISH_PAYLOAD_MISMATCH'; END IF;
IF d.transport_state<>'in_flight' THEN
 IF d.transport_state<>p_outcome THEN RAISE EXCEPTION 'DISPATCH_OUTCOME_CONFLICT'; END IF;
 RETURN QUERY SELECT d.dispatch_id,d.transport_state,d.send_log_id,d.error_code; RETURN;
END IF;
IF p_outcome='accepted' AND NOT d.is_test THEN
 INSERT INTO public.shrigma_send_log(email,brand,kind,flow,channel,piece,template_id,ref)
 VALUES(p_body->>'email','fish','tx','transacional','email',d.piece,(p_body->>'template_id')::int,p_body->>'order_id')
 ON CONFLICT DO NOTHING RETURNING id INTO v_log;
 IF v_log IS NULL THEN v_error='LEGACY_LOG_CONFLICT_AFTER_ACCEPT'; END IF;
ELSIF p_outcome<>'accepted' THEN v_error='LISTMONK_'||upper(p_outcome); END IF;
UPDATE public.shrigma_email_dispatch x SET transport_state=p_outcome,outcome_at=clock_timestamp(),
 accepted_at=CASE WHEN p_outcome='accepted' THEN clock_timestamp() END,send_log_id=v_log,error_code=v_error WHERE x.dispatch_id=p_id;
RETURN QUERY SELECT p_id,p_outcome,v_log,v_error;
END;$function$
;

-- Production MD5 7b03014a9994e5e2963813f22d2cafae; fixture only.
DROP FUNCTION shrigma_email_finish_aristo(uuid,uuid,text,jsonb);
CREATE OR REPLACE FUNCTION public.shrigma_email_finish_aristo(p_id uuid, p_claim uuid, p_outcome text, p_body jsonb)
 RETURNS TABLE(dispatch_id uuid, transport_state text, send_log_id bigint, error_code text)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE d public.shrigma_email_dispatch%ROWTYPE; v_log bigint; v_error text; v_hash text; v_payload jsonb;
BEGIN
IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','outcome_unknown') THEN RAISE EXCEPTION 'DISPATCH_OUTCOME_INVALID'; END IF;
SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id FOR UPDATE;
IF p_claim IS NULL OR d.claim_token IS DISTINCT FROM p_claim OR d.brand<>'aristo' OR d.flow<>'transacional' THEN RAISE EXCEPTION 'DISPATCH_CLAIM_MISMATCH'; END IF;
v_payload=jsonb_build_object('subscriber_mode','external','subscriber_email',p_body->>'email','from_email',p_body->>'from_email',
 'template_id',(p_body->>'template_id')::int,'subject',p_body->>'subject','content_type','html',
 'headers',jsonb_build_array(jsonb_build_object('Reply-To',p_body->>'reply_to')),'data',p_body);
v_hash=encode(digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
IF v_hash IS DISTINCT FROM d.payload_sha256 THEN RAISE EXCEPTION 'DISPATCH_FINISH_PAYLOAD_MISMATCH'; END IF;
IF d.transport_state<>'in_flight' THEN
 IF d.transport_state<>p_outcome THEN RAISE EXCEPTION 'DISPATCH_OUTCOME_CONFLICT'; END IF;
 RETURN QUERY SELECT d.dispatch_id,d.transport_state,d.send_log_id,d.error_code; RETURN;
END IF;
IF p_outcome='accepted' AND NOT d.is_test THEN
 INSERT INTO public.shrigma_send_log(email,brand,kind,flow,channel,piece,template_id,ref)
 VALUES(p_body->>'email','aristo','tx','transacional','email',d.piece,(p_body->>'template_id')::int,p_body->>'order_id')
 ON CONFLICT DO NOTHING RETURNING id INTO v_log;
 IF v_log IS NULL THEN v_error='LEGACY_LOG_CONFLICT_AFTER_ACCEPT'; END IF;
ELSIF p_outcome<>'accepted' THEN v_error='LISTMONK_'||upper(p_outcome); END IF;
UPDATE public.shrigma_email_dispatch x SET transport_state=p_outcome,outcome_at=clock_timestamp(),
 accepted_at=CASE WHEN p_outcome='accepted' THEN clock_timestamp() END,send_log_id=v_log,error_code=v_error WHERE x.dispatch_id=p_id;
RETURN QUERY SELECT p_id,p_outcome,v_log,v_error;
END;$function$
;
