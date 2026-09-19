-- B06.1 candidate only: new Fish/email/30-minute entries. Transport stays in the
-- existing SES claim/finish. Disabled on install; no history is adopted or replayed.
BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS public.shrigma_journey_cart_control_v1 (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 starts_at timestamptz,
 template_cache_target text,
 CHECK(NOT enabled OR (starts_at IS NOT NULL AND length(btrim(template_cache_target)) BETWEEN 1 AND 128 AND template_cache_target IS NOT NULL))
);
INSERT INTO public.shrigma_journey_cart_control_v1(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.shrigma_journey_cart_entry_v1 (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 brand text NOT NULL CHECK(brand='fish'),
 flow_key text NOT NULL CHECK(flow_key='fish:carrinho'),
 subscriber_id integer NOT NULL CHECK(subscriber_id>0),
 ref timestamptz NOT NULL,
 published_version integer NOT NULL CHECK(published_version>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 slot jsonb NOT NULL CHECK(slot->>'key'='email:carrinho-30min' AND slot->>'channel'='email' AND slot->>'piece'='carrinho-30min'),
 template_hash text NOT NULL,
 source_template_id integer NOT NULL,
 template_release_id uuid NOT NULL REFERENCES public.shrigma_journey_template_release_v1(id),
 template_cache_target text NOT NULL,
 due_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','reserved','cancelled','expired','blocked')),
 reason text NOT NULL DEFAULT 'captured',
 dispatch_id uuid UNIQUE REFERENCES public.shrigma_email_dispatch(dispatch_id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(brand,subscriber_id,ref),
 CHECK(due_at>=ref AND expires_at>due_at),
 CHECK((state='reserved')=(dispatch_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS shrigma_journey_cart_due_v1 ON public.shrigma_journey_cart_entry_v1(due_at,id) WHERE state='waiting';
CREATE TABLE IF NOT EXISTS public.shrigma_journey_cart_decision_v1 (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 entry_id uuid NOT NULL REFERENCES public.shrigma_journey_cart_entry_v1(id),
 state text NOT NULL,reason text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.shrigma_journey_cart_owned_v1(b jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE sid integer;at timestamptz;
BEGIN
 IF b->>'brand' IS DISTINCT FROM 'fish' OR b->>'toque' IS DISTINCT FROM 't05' THEN RETURN false;END IF;
 IF coalesce(b->>'subscriber_id','')!~'^[1-9][0-9]*$' OR coalesce(b->>'ref','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN RETURN false;END IF;
 sid:=(b->>'subscriber_id')::integer;at:=(b->>'ref')::timestamptz;
 RETURN EXISTS(SELECT 1 FROM public.shrigma_journey_cart_entry_v1 WHERE subscriber_id=sid AND ref=at)
 OR EXISTS(SELECT 1 FROM public.shrigma_journey_cart_control_v1 WHERE enabled AND at>=starts_at);
END $f$;

CREATE OR REPLACE FUNCTION public.shrigma_journey_cart_enroll_v1(p_subscriber integer,p_ref timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $f$
DECLARE ctl public.shrigma_journey_cart_control_v1%ROWTYPE;e public.shrigma_journey_cart_entry_v1%ROWTYPE;
 f public.shrigma_flow_definition%ROWTYPE;s public.subscribers%ROWTYPE;slot jsonb;tpl jsonb;wait_minutes numeric;
 release public.shrigma_journey_template_release_v1%ROWTYPE;source_id integer;
BEGIN
 IF p_subscriber IS NULL OR p_subscriber<=0 OR p_ref IS NULL THEN RAISE EXCEPTION 'JOURNEY_ENTRY_IDENTITY';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('journey-cart:'||p_subscriber||':'||extract(epoch FROM p_ref)::text,0));
 SELECT * INTO e FROM public.shrigma_journey_cart_entry_v1 WHERE subscriber_id=p_subscriber AND ref=p_ref;
 IF FOUND THEN RETURN jsonb_build_object('entry_id',e.id,'created',false,'state',e.state);END IF;
 SELECT * INTO STRICT ctl FROM public.shrigma_journey_cart_control_v1 WHERE singleton FOR SHARE;
 IF NOT ctl.enabled OR p_ref<ctl.starts_at OR p_ref>clock_timestamp() THEN RETURN jsonb_build_object('created',false,'reason','outside_cohort');END IF;
 SELECT * INTO s FROM public.subscribers WHERE id=p_subscriber FOR UPDATE;
 IF NOT FOUND OR (s.attribs#>>'{fish,cart_abandoned_at}')::timestamptz IS DISTINCT FROM p_ref THEN RETURN jsonb_build_object('created',false,'reason','source_changed');END IF;
 SELECT * INTO STRICT f FROM public.shrigma_flow_definition WHERE key='fish:carrinho' FOR SHARE;
 IF f.brand IS DISTINCT FROM 'fish' OR NOT f.runtime_ready OR f.binding->>'merged_into' IS NOT NULL OR f.published_version IS NULL THEN RAISE EXCEPTION 'JOURNEY_DEFINITION_UNAVAILABLE';END IF;
 SELECT x INTO slot FROM jsonb_array_elements(f.published->'steps') x WHERE x->>'key'='email:carrinho-30min';
 IF slot IS NULL OR slot->>'channel' IS DISTINCT FROM 'email' OR slot->>'piece' IS DISTINCT FROM 'carrinho-30min' OR slot->>'flow' IS DISTINCT FROM 'carrinho'
 OR jsonb_typeof(slot->'enabled') IS DISTINCT FROM 'boolean'
 OR coalesce(slot->>'wait_min','')!~'^[0-9]+([.][0-9]+)?$' OR coalesce(slot->>'template_id','')!~'^[1-9][0-9]*$'
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f.binding->'steps') x WHERE x->>'key'=slot->>'key' AND x->>'channel'='email' AND x->>'piece'='carrinho-30min') THEN RAISE EXCEPTION 'JOURNEY_SLOT_UNAVAILABLE';END IF;
 wait_minutes:=(slot->>'wait_min')::numeric;
 IF wait_minutes<30 OR wait_minutes>45 THEN RAISE EXCEPTION 'JOURNEY_WAIT_UNSUPPORTED';END IF;
 SELECT to_jsonb(t) INTO tpl FROM public.templates t WHERE t.id=(slot->>'template_id')::integer AND t.type::text='tx' FOR SHARE;
 IF tpl IS NULL THEN RAISE EXCEPTION 'JOURNEY_TEMPLATE_UNAVAILABLE';END IF;
 source_id:=(slot->>'template_id')::integer;
 SELECT * INTO release FROM public.shrigma_journey_template_release_v1 WHERE brand='fish' AND source_template_id=source_id
  AND content_hash=encode(public.digest(convert_to(public.shrigma_journey_template_content_v1(tpl)::text,'UTF8'),'sha256'),'hex')
  AND state='ready' AND cache_target=ctl.template_cache_target FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'JOURNEY_TEMPLATE_RELEASE_UNAVAILABLE';END IF;
 slot:=slot||jsonb_build_object('template_id',release.clone_template_id::text,'template_name',release.clone_name);
 INSERT INTO public.shrigma_journey_cart_entry_v1(brand,flow_key,subscriber_id,ref,published_version,definition,slot,template_hash,source_template_id,template_release_id,template_cache_target,due_at,expires_at,state,reason)
 VALUES('fish',f.key,p_subscriber,p_ref,f.published_version,f.published,slot,release.content_hash,source_id,release.id,release.cache_target,p_ref+make_interval(secs=>60*wait_minutes::double precision),p_ref+interval '1 hour',
 CASE WHEN slot->'enabled'='true'::jsonb THEN 'waiting' ELSE 'cancelled' END,CASE WHEN slot->'enabled'='true'::jsonb THEN 'captured' ELSE 'stage_disabled_at_entry' END) RETURNING * INTO e;
 INSERT INTO public.shrigma_journey_cart_decision_v1(entry_id,state,reason) VALUES(e.id,e.state,e.reason);
 RETURN jsonb_build_object('entry_id',e.id,'created',true,'state',e.state);
END $f$;

-- Called only inside the existing claim after its global published-pause check.
-- Returning an allowed slot is not a transport authorization outside that claim.
CREATE OR REPLACE FUNCTION public.shrigma_journey_cart_slot_v1(b jsonb,live_slot jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $f$
DECLARE e public.shrigma_journey_cart_entry_v1%ROWTYPE;s public.subscribers%ROWTYPE;
 d public.shrigma_email_dispatch%ROWTYPE;why text;next_state text;tpl jsonb;list_ok boolean;at timestamptz;sid integer;dedupe text;
BEGIN
 IF NOT (b?'journey_entry_id') THEN RETURN jsonb_build_object('_allowed',false,'reason','journey_entry_required');END IF;
 IF b->>'brand' IS DISTINCT FROM 'fish' OR b->>'toque' IS DISTINCT FROM 't05' OR b->>'piece' IS DISTINCT FROM 'carrinho-30min' THEN RAISE EXCEPTION 'JOURNEY_SCOPE';END IF;
 -- /api/tx accepts subject/altbody overrides, but this candidate has no separate
 -- pinned revision for them. Never silently replace the immutable template.
 IF coalesce(b#>>'{tx,subject}','')<>'' OR coalesce(b#>>'{tx,altbody}','')<>'' THEN RAISE EXCEPTION 'JOURNEY_TEMPLATE_OVERRIDE_UNSUPPORTED';END IF;
 sid:=(b->>'subscriber_id')::integer;at:=(b->>'ref')::timestamptz;
 SELECT * INTO e FROM public.shrigma_journey_cart_entry_v1 WHERE id=(b->>'journey_entry_id')::uuid FOR UPDATE;
 IF NOT FOUND OR e.subscriber_id<>sid OR e.ref<>at THEN RAISE EXCEPTION 'JOURNEY_ENTRY_MISMATCH';END IF;
 IF e.state<>'waiting' THEN RETURN jsonb_build_object('_allowed',false,'reason',e.reason);END IF;
 next_state:='waiting';
 IF NOT EXISTS(SELECT 1 FROM public.shrigma_journey_cart_control_v1 WHERE enabled) THEN why:='journey_paused';
 ELSIF live_slot->'_managed' IS DISTINCT FROM 'true'::jsonb OR live_slot->'_allowed' IS DISTINCT FROM 'true'::jsonb THEN why:='flow_paused';
 END IF;
 SELECT * INTO s FROM public.subscribers WHERE id=sid FOR UPDATE;
 PERFORM 1 FROM public.subscriber_lists WHERE subscriber_id=sid AND list_id=22 FOR SHARE;
 SELECT EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.subscriber_id=sid AND sl.list_id=22 AND sl.status::text<>'unsubscribed') INTO list_ok;
 IF s.id IS NULL OR s.status::text<>'enabled' OR NOT list_ok THEN why:='opt_out_or_unavailable';next_state:='cancelled';
 ELSIF (s.attribs#>>'{fish,cart_abandoned_at}')::timestamptz IS DISTINCT FROM e.ref THEN why:='source_superseded';next_state:='cancelled';
 ELSIF (CASE WHEN s.attribs#>>'{fish,last_order_at}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (s.attribs#>>'{fish,last_order_at}')::timestamptz END)>=e.ref THEN why:='purchase_observed';next_state:='cancelled';
 END IF;
 -- Existing reservations dominate timing/config changes and are never reopened.
 dedupe:=jsonb_build_array('email',to_char(e.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),sid,false)::text;
 SELECT * INTO d FROM public.shrigma_email_dispatch x WHERE x.brand='fish' AND x.flow='carrinho' AND x.piece='carrinho-30min' AND x.dedupe_key=dedupe;
 IF FOUND THEN
  UPDATE public.shrigma_journey_cart_entry_v1 SET state='reserved',reason='existing_reservation',dispatch_id=d.dispatch_id,updated_at=clock_timestamp() WHERE id=e.id;
  INSERT INTO public.shrigma_journey_cart_decision_v1(entry_id,state,reason) VALUES(e.id,'reserved','existing_reservation');
  RETURN jsonb_build_object('_allowed',false,'reason','existing_reservation');
 END IF;
 IF next_state='waiting' AND clock_timestamp()>=e.expires_at THEN why:='window_expired';next_state:='expired';END IF;
 IF why IS NULL AND clock_timestamp()<e.due_at THEN why:='not_due';END IF;
 SELECT to_jsonb(t) INTO tpl FROM public.templates t WHERE t.id=(e.slot->>'template_id')::integer FOR SHARE;
 IF why IS NULL AND (tpl IS NULL
  OR encode(public.digest(convert_to(public.shrigma_journey_template_content_v1(tpl)::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM e.template_hash
  OR NOT EXISTS(SELECT 1 FROM public.shrigma_journey_template_release_v1 r WHERE r.id=e.template_release_id AND r.state='ready'
   AND r.clone_template_id=(e.slot->>'template_id')::integer AND r.content_hash=e.template_hash AND r.cache_target=e.template_cache_target)
  OR NOT EXISTS(SELECT 1 FROM public.shrigma_journey_cart_control_v1 WHERE template_cache_target=e.template_cache_target)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.templates'::regclass AND tgname='shrigma_journey_template_guard_v1'
   AND tgfoid='public.shrigma_journey_template_guard_v1()'::regprocedure AND tgenabled='O'))
  THEN why:='template_release_unavailable';next_state:='blocked';END IF;
 IF why IS NOT NULL THEN
  IF e.state<>next_state OR e.reason<>why THEN
   UPDATE public.shrigma_journey_cart_entry_v1 SET state=next_state,reason=why,updated_at=clock_timestamp() WHERE id=e.id;
   INSERT INTO public.shrigma_journey_cart_decision_v1(entry_id,state,reason) VALUES(e.id,next_state,why);
  END IF;
  RETURN jsonb_build_object('_allowed',false,'reason',why);
 END IF;
 RETURN e.slot||jsonb_build_object('_managed',true,'_allowed',true,'_flow_key',e.flow_key,'_version',e.published_version);
END $f$;

CREATE OR REPLACE FUNCTION public.shrigma_journey_cart_attach_v1(b jsonb,p_dispatch uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE e public.shrigma_journey_cart_entry_v1%ROWTYPE;d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
 IF NOT b?'journey_entry_id' THEN RETURN;END IF;
 SELECT * INTO STRICT e FROM public.shrigma_journey_cart_entry_v1 WHERE id=(b->>'journey_entry_id')::uuid FOR UPDATE;
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE dispatch_id=p_dispatch;
 IF e.state<>'waiting' OR e.subscriber_id IS DISTINCT FROM (b->>'subscriber_id')::integer OR e.ref IS DISTINCT FROM (b->>'ref')::timestamptz
 OR d.brand<>'fish' OR d.flow<>'carrinho' OR d.piece<>'carrinho-30min' OR d.transport_state<>'in_flight'
 OR d.dedupe_key IS DISTINCT FROM jsonb_build_array('email',to_char(e.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),e.subscriber_id,false)::text THEN RAISE EXCEPTION 'JOURNEY_ATTACH_MISMATCH';END IF;
 UPDATE public.shrigma_journey_cart_entry_v1 SET state='reserved',reason='claimed',dispatch_id=p_dispatch,updated_at=clock_timestamp() WHERE id=e.id;
 INSERT INTO public.shrigma_journey_cart_decision_v1(entry_id,state,reason) VALUES(e.id,'reserved','claimed');
END $f$;

CREATE OR REPLACE FUNCTION public.shrigma_journey_cart_get_v1(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
 SELECT jsonb_build_object('entry_id',e.id,'flow_key',e.flow_key,'published_version',e.published_version,'subscriber_id',e.subscriber_id,
 'template_id',(e.slot->>'template_id')::integer,'source_template_id',e.source_template_id,'template_release_id',e.template_release_id,'template_cache_target',e.template_cache_target,
 'ref',e.ref,'due_at',e.due_at,'expires_at',e.expires_at,'state',e.state,'reason',e.reason,'dispatch_id',e.dispatch_id,
 'transport_state',d.transport_state,'send_log_id',d.send_log_id,'created_at',e.created_at,'updated_at',e.updated_at)
 FROM public.shrigma_journey_cart_entry_v1 e LEFT JOIN public.shrigma_email_dispatch d ON d.dispatch_id=e.dispatch_id WHERE e.id=p_id
$f$;

-- Reconcile durable waiting decisions without producing a send intent. The claim
-- repeats every guard. A signal after reservation is recorded, never a resend.
CREATE OR REPLACE FUNCTION public.shrigma_journey_cart_check_v1(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $f$
DECLARE e public.shrigma_journey_cart_entry_v1%ROWTYPE;s public.subscribers%ROWTYPE;r jsonb;why text;
BEGIN
 SELECT * INTO STRICT e FROM public.shrigma_journey_cart_entry_v1 WHERE id=p_id FOR UPDATE;
 IF e.state='waiting' THEN
  r:=public.shrigma_journey_cart_slot_v1(jsonb_build_object('journey_entry_id',e.id,'brand','fish','toque','t05','piece','carrinho-30min','subscriber_id',e.subscriber_id,'ref',e.ref),public.shrigma_flow_slot('fish','email','carrinho','carrinho-30min'));
  IF r->'_allowed'='true'::jsonb AND e.reason<>'due' THEN
   UPDATE public.shrigma_journey_cart_entry_v1 SET reason='due',updated_at=clock_timestamp() WHERE id=e.id;
   INSERT INTO public.shrigma_journey_cart_decision_v1(entry_id,state,reason) VALUES(e.id,'waiting','due');
  END IF;
 ELSIF e.state='reserved' THEN
  SELECT * INTO s FROM public.subscribers WHERE id=e.subscriber_id FOR UPDATE;
  IF s.id IS NULL OR s.status::text<>'enabled' OR NOT EXISTS(SELECT 1 FROM public.subscriber_lists WHERE subscriber_id=e.subscriber_id AND list_id=22 AND status::text<>'unsubscribed') THEN why:='opt_out_after_reservation';
  ELSIF (s.attribs#>>'{fish,cart_abandoned_at}')::timestamptz IS DISTINCT FROM e.ref THEN why:='source_superseded_after_reservation';
  ELSIF (CASE WHEN s.attribs#>>'{fish,last_order_at}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (s.attribs#>>'{fish,last_order_at}')::timestamptz END)>=e.ref THEN why:='purchase_after_reservation';
  ELSIF NOT EXISTS(SELECT 1 FROM public.shrigma_journey_cart_control_v1 WHERE enabled AND template_cache_target=e.template_cache_target) THEN why:='journey_paused_after_reservation';
  ELSIF public.shrigma_flow_slot('fish','email','carrinho','carrinho-30min')->'_allowed' IS DISTINCT FROM 'true'::jsonb THEN why:='flow_paused_after_reservation';
  ELSIF clock_timestamp()>=e.expires_at THEN why:='window_expired_after_reservation';
  ELSIF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.templates'::regclass AND tgname='shrigma_journey_template_guard_v1'
   AND tgfoid='public.shrigma_journey_template_guard_v1()'::regprocedure AND tgenabled='O') THEN why:='template_guard_unavailable_after_reservation';END IF;
  IF why IS NOT NULL AND e.reason IS DISTINCT FROM why THEN
   UPDATE public.shrigma_journey_cart_entry_v1 SET reason=why,updated_at=clock_timestamp() WHERE id=e.id;
   INSERT INTO public.shrigma_journey_cart_decision_v1(entry_id,state,reason) VALUES(e.id,'reserved',why);
  END IF;
 END IF;
 RETURN public.shrigma_journey_cart_get_v1(p_id);
END $f$;

-- Pin only the opted-in initial touch. Keep all original identity, global pause,
-- email/list/order/cadence checks, unique reservation, context and finish logic.
DO $patch$
DECLARE body text;anchor text;replacement text;
BEGIN
 SELECT pg_get_functiondef('public.shrigma_email_claim_cart(jsonb)'::regprocedure) INTO body;
 IF strpos(body,'IF NOT (stage_config->>''_allowed'')::boolean THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,''flow_paused'';RETURN;END IF;')=0 THEN RAISE EXCEPTION 'JOURNEY_GLOBAL_GUARD_DRIFT';END IF;
 IF strpos(body,'-- JOURNEY_CART_ENTRY_V1')>0 THEN
  IF strpos(body,'public.shrigma_journey_cart_attach_v1(b,v_dispatch)')=0 OR strpos(body,'public.shrigma_journey_cart_slot_v1(b,stage_config)')=0 THEN RAISE EXCEPTION 'JOURNEY_CLAIM_DRIFT';END IF;
 ELSE
  anchor:='IF coalesce(b->>''subscriber_id'','''') !~ ''^[1-9][0-9]*$'' OR coalesce(b->>''ref'','''') !~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}T'' THEN RAISE EXCEPTION ''CART_IDENTITY_INVALID''; END IF;';
  replacement:='-- JOURNEY_CART_ENTRY_V1: the original global pause guard above is preserved.
IF b ? ''journey_entry_id'' OR public.shrigma_journey_cart_owned_v1(b) THEN
 stage_config=public.shrigma_journey_cart_slot_v1(b,stage_config);
 IF stage_config->''_allowed'' IS DISTINCT FROM ''true''::jsonb THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,stage_config->>''reason'';RETURN;END IF;
 v_template=(stage_config->>''template_id'')::int;v_tx=jsonb_set(v_tx,''{template_id}'',to_jsonb(v_template));b=b||jsonb_build_object(''template_id'',v_template,''tx'',v_tx);
END IF;
'||anchor;
  IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'JOURNEY_CLAIM_IDENTITY_DRIFT';END IF;
  body:=replace(body,anchor,replacement);
  anchor:='age>=shrigma_flow_wait(v_brand,''email'',''carrinho-30min'',30)';
  replacement:='age>=CASE WHEN b ? ''journey_entry_id'' THEN make_interval(secs=>60*(stage_config->>''wait_min'')::double precision) ELSE shrigma_flow_wait(v_brand,''email'',''carrinho-30min'',30) END';
  IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'JOURNEY_CLAIM_WAIT_DRIFT';END IF;
  body:=replace(body,anchor,replacement);
  anchor:='v_tx=jsonb_set(v_tx,''{headers}'',(v_tx->''headers'')||jsonb_build_array';
  IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'JOURNEY_CLAIM_ATTACH_DRIFT';END IF;
  body:=replace(body,anchor,'PERFORM public.shrigma_journey_cart_attach_v1(b,v_dispatch);
'||anchor);
  EXECUTE body;
 END IF;
END $patch$;
REVOKE ALL ON public.shrigma_journey_cart_control_v1,public.shrigma_journey_cart_entry_v1,public.shrigma_journey_cart_decision_v1 FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.shrigma_journey_cart_decision_v1_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shrigma_journey_cart_owned_v1(jsonb),public.shrigma_journey_cart_enroll_v1(integer,timestamptz),
 public.shrigma_journey_cart_slot_v1(jsonb,jsonb),public.shrigma_journey_cart_attach_v1(jsonb,uuid),public.shrigma_journey_cart_get_v1(uuid),public.shrigma_journey_cart_check_v1(uuid) FROM PUBLIC;
COMMIT;
