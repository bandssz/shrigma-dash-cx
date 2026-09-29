-- Integrated candidate. Install with the reviewed A/B scope and regular worker
-- while OFF. No grants, activation, native schedule or customer send at install.
DO $install$
BEGIN
 IF to_regclass('crm_audience_v2.ab_review') IS NULL
  OR to_regprocedure('crm_audience_v2.regular_admission_runtime(text)') IS NULL
  OR to_regprocedure('crm_audience_v2.shopify_snapshot(text)') IS NULL
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
  OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign)
  OR EXISTS(SELECT 1 FROM public.crm_ab_experiment_v2 WHERE state='scheduled') THEN
  RAISE EXCEPTION 'AB_REGULAR_INSTALL_UNAVAILABLE';
 END IF;
END $install$;

CREATE TABLE crm_audience_v2.ab_regular_review(
 id uuid PRIMARY KEY,actor text NOT NULL,brand text NOT NULL CHECK(brand IN('fish','aristo')),
 test_id uuid NOT NULL REFERENCES crm_audience_v2.ab_scope(test_id),
 experiment_version integer NOT NULL CHECK(experiment_version>0),scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 audience_review_id uuid NOT NULL REFERENCES crm_audience_v2.ab_review(review_id),
 inspection jsonb NOT NULL CHECK(jsonb_typeof(inspection)='object'),materials jsonb NOT NULL,runtime jsonb NOT NULL CHECK(jsonb_typeof(runtime)='object'),
 checked_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 CHECK(isfinite(checked_at) AND expires_at>checked_at AND expires_at<=checked_at+interval '60 seconds'),
 CHECK(jsonb_typeof(materials)='array' AND jsonb_array_length(materials)=2)
);
CREATE TABLE crm_audience_v2.ab_regular_request(
 actor text NOT NULL,operation_key text NOT NULL,brand text NOT NULL CHECK(brand IN('fish','aristo')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor,operation_key)
);
CREATE TABLE crm_audience_v2.ab_regular_pair(
 test_id uuid PRIMARY KEY REFERENCES crm_audience_v2.ab_scope(test_id),
 brand text NOT NULL CHECK(brand IN('fish','aristo')),
 campaign_a integer NOT NULL UNIQUE REFERENCES public.campaigns(id),
 campaign_b integer NOT NULL UNIQUE REFERENCES public.campaigns(id),
 scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),review_id uuid NOT NULL UNIQUE REFERENCES crm_audience_v2.ab_regular_review(id),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 admitted_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),CHECK(campaign_a<>campaign_b)
);
CREATE TRIGGER ab_regular_pair_immutable BEFORE UPDATE OR DELETE ON crm_audience_v2.ab_regular_pair
 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
CREATE TRIGGER ab_regular_review_immutable BEFORE UPDATE OR DELETE ON crm_audience_v2.ab_regular_review
 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
CREATE TRIGGER ab_regular_request_immutable BEFORE UPDATE OR DELETE ON crm_audience_v2.ab_regular_request
 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
REVOKE ALL ON crm_audience_v2.ab_regular_review,crm_audience_v2.ab_regular_request,crm_audience_v2.ab_regular_pair FROM PUBLIC;

-- The pair is immutable. Claims/finishes lock both campaigns and controls in
-- numeric order; they never acquire the experiment after a campaign lock.
CREATE FUNCTION crm_audience_v2.ab_regular_fence(cid integer,sid integer DEFAULT NULL) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE p crm_audience_v2.ab_regular_pair%ROWTYPE;
 BEGIN
  SELECT * INTO p FROM crm_audience_v2.ab_regular_pair WHERE cid IN(campaign_a,campaign_b);
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM public.campaigns WHERE id IN(p.campaign_a,p.campaign_b) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id IN(p.campaign_a,p.campaign_b) ORDER BY campaign_id FOR UPDATE;
  IF sid IS NOT NULL THEN
   PERFORM 1 FROM public.crm_ab_member_v2 WHERE test_id=p.test_id AND subscriber_id=sid FOR SHARE;
  END IF;
 END $fn$;

CREATE FUNCTION crm_audience_v2.ab_regular_context(cid integer,ctx jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE p crm_audience_v2.ab_regular_pair%ROWTYPE;e public.crm_ab_experiment_v2%ROWTYPE;
  a public.crm_ab_arm_v2%ROWTYPE;s crm_audience_v2.ab_scope%ROWTYPE;
 BEGIN
  SELECT * INTO a FROM public.crm_ab_arm_v2 WHERE campaign_id=cid;
  IF NOT FOUND THEN RETURN ctx; END IF;
  SELECT * INTO s FROM crm_audience_v2.ab_scope WHERE test_id=a.test_id;
  -- A legacy A/B campaign must never fall through to this different emitter.
  IF NOT FOUND OR ctx->'bound' IS DISTINCT FROM 'true'::jsonb THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AB_REGULAR_SCOPE_UNAVAILABLE';
  END IF;
  SELECT * INTO p FROM crm_audience_v2.ab_regular_pair WHERE test_id=a.test_id;
  SELECT * INTO e FROM public.crm_ab_experiment_v2 WHERE test_id=a.test_id;
  IF p.test_id IS NULL OR p.brand IS DISTINCT FROM ctx->>'brand' OR p.scope_hash IS DISTINCT FROM s.scope_hash
   OR (a.arm='a' AND p.campaign_a<>cid) OR (a.arm='b' AND p.campaign_b<>cid)
   OR NOT(e.state='scheduled' AND e.transport_bound OR e.state='prepared' AND p.admitted_xid=pg_current_xact_id())
   OR (SELECT count(*) FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id IN(p.campaign_a,p.campaign_b) AND enabled AND NOT suspended)<>2
   OR EXISTS(SELECT 1 FROM public.campaigns WHERE id IN(p.campaign_a,p.campaign_b) AND status::text IN('paused','cancelled'))
   OR EXISTS(SELECT 1 FROM public.shrigma_email_dispatch WHERE flow='campaign'
    AND piece IN('audience-regular-v1:'||p.campaign_a::text,'audience-regular-v1:'||p.campaign_b::text) AND transport_state='outcome_unknown') THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='AB_REGULAR_PAIR_UNAVAILABLE';
  END IF;
  RETURN ctx||jsonb_build_object('ab_test_id',p.test_id,'ab_arm',a.arm,'ab_scope_hash',p.scope_hash);
 END $fn$;

-- Lock tracking before the experiment/campaign locks. A concurrent settings
-- change cannot be hidden by setting tracking_continuous=true at admission.
CREATE FUNCTION crm_audience_v2.ab_regular_tracking() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
DECLARE valid boolean;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'AB_REGULAR_BOUNDARY'; END IF;
 PERFORM key FROM public.settings WHERE key IN ('privacy.disable_tracking','privacy.individual_tracking') ORDER BY key FOR SHARE;
 SELECT EXISTS(SELECT 1 FROM public.settings WHERE key='privacy.disable_tracking' AND value='false'::jsonb)
  AND EXISTS(SELECT 1 FROM public.settings WHERE key='privacy.individual_tracking' AND value='true'::jsonb) INTO valid;
 RETURN valid;
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_regular_tracking() FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.ab_regular_schedule(rid uuid,actor_id text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE r crm_audience_v2.ab_regular_review%ROWTYPE;e public.crm_ab_experiment_v2%ROWTYPE;
  s crm_audience_v2.ab_scope%ROWTYPE;v crm_audience_v2.ab_review%ROWTYPE;
  c public.campaigns%ROWTYPE;b crm_audience_v2.campaign_binding%ROWTYPE;
  rt jsonb;pin jsonb;material jsonb;ctx jsonb;eligible jsonb:='{}';members jsonb;
  ids integer[];send_at timestamptz;prior_writer text;counted integer;result jsonb;
 BEGIN
  SELECT * INTO STRICT r FROM crm_audience_v2.ab_regular_review WHERE id=rid AND actor=actor_id;
  IF NOT crm_audience_v2.ab_regular_tracking() THEN RAISE EXCEPTION 'AB_REGULAR_TRACKING_UNAVAILABLE'; END IF;
  rt:=crm_audience_v2.regular_admission_runtime(r.brand);
  SELECT * INTO STRICT e FROM public.crm_ab_experiment_v2 WHERE test_id=r.test_id AND brand=r.brand FOR UPDATE;
  SELECT * INTO STRICT s FROM crm_audience_v2.ab_scope WHERE test_id=e.test_id AND brand=r.brand FOR SHARE;
  SELECT * INTO v FROM crm_audience_v2.ab_review WHERE test_id=e.test_id AND brand=r.brand ORDER BY review_sequence DESC LIMIT 1;
  IF e.state<>'prepared' OR e.transport_bound OR e.source_complete OR e.version<>r.experiment_version
   OR s.scope_hash IS DISTINCT FROM r.scope_hash OR r.runtime IS DISTINCT FROM rt
   OR r.checked_at>clock_timestamp() OR r.expires_at<=clock_timestamp()
   OR v.review_id IS DISTINCT FROM r.audience_review_id OR v.actor IS DISTINCT FROM actor_id
   OR v.evidence#>>'{review,status}' IS DISTINCT FROM 'confirmed'
   OR (v.evidence#>>'{review,expires_at}')::timestamptz<=clock_timestamp()
   OR r.inspection->>'review_id' IS DISTINCT FROM v.review_id::text
   OR r.inspection->>'test_id' IS DISTINCT FROM e.test_id::text
   OR r.inspection->>'scope_hash' IS DISTINCT FROM s.scope_hash
   OR r.inspection#>>'{audience,eligible_fingerprint}' IS DISTINCT FROM v.evidence#>>'{review,eligible_fingerprint}'
   OR NOT public.crm_ab_protocol_valid_v2(e.protocol)
   OR NOT EXISTS(SELECT 1 FROM public.settings WHERE key='privacy.disable_tracking' AND value='false'::jsonb)
   OR NOT EXISTS(SELECT 1 FROM public.settings WHERE key='privacy.individual_tracking' AND value='true'::jsonb) THEN
   RAISE EXCEPTION 'AB_REGULAR_REVIEW_CHANGED';
  END IF;
  SELECT array_agg(campaign_id ORDER BY campaign_id) INTO ids FROM public.crm_ab_arm_v2 WHERE test_id=e.test_id;
  IF cardinality(ids) IS DISTINCT FROM 2 OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=ANY(ids))
   OR EXISTS(SELECT 1 FROM public.shrigma_email_dispatch WHERE flow='campaign' AND piece=ANY(ARRAY['audience-regular-v1:'||ids[1]::text,'audience-regular-v1:'||ids[2]::text])) THEN
   RAISE EXCEPTION 'AB_REGULAR_CAMPAIGN_CHANGED';
  END IF;
  PERFORM 1 FROM public.campaigns WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=ANY(ids))
   OR EXISTS(SELECT 1 FROM public.shrigma_email_dispatch WHERE flow='campaign' AND piece=ANY(ARRAY['audience-regular-v1:'||ids[1]::text,'audience-regular-v1:'||ids[2]::text])) THEN
   RAISE EXCEPTION 'AB_REGULAR_CAMPAIGN_CHANGED';
  END IF;
  PERFORM 1 FROM crm_audience_v2.campaign_binding WHERE campaign_id=ANY(ids) ORDER BY campaign_id FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.config WHERE brand=r.brand FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.shopify_source WHERE brand=r.brand FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.audience WHERE id=(s.scope->>'audience_id')::uuid FOR SHARE;
  PERFORM 1 FROM public.crm_ab_member_v2 WHERE test_id=e.test_id ORDER BY subscriber_id FOR SHARE;
  PERFORM 1 FROM public.subscribers WHERE id IN(SELECT subscriber_id FROM public.crm_ab_member_v2 WHERE test_id=e.test_id) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.subscriber_lists WHERE subscriber_id IN(SELECT subscriber_id FROM public.crm_ab_member_v2 WHERE test_id=e.test_id) ORDER BY subscriber_id,list_id FOR SHARE;
  FOR c IN SELECT * FROM public.campaigns WHERE id=ANY(ids) ORDER BY id LOOP
   PERFORM crm_audience_v2.regular_admission_snapshot(c.id);
   SELECT * INTO STRICT b FROM crm_audience_v2.campaign_binding WHERE campaign_id=c.id;
   SELECT value INTO pin FROM jsonb_array_elements(s.scope->'bindings') WHERE (value->>'campaign_id')::integer=c.id;
   SELECT value INTO material FROM jsonb_array_elements(r.materials) WHERE (value#>>'{campaign,id}')::integer=c.id;
   IF pin IS NULL OR material IS NULL OR material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(c.id)
    OR c.attribs#>>'{crm,brand}' IS DISTINCT FROM r.brand OR b.brand IS DISTINCT FROM r.brand
    OR b.binding_hash IS DISTINCT FROM pin->>'binding_hash' OR b.binding_version IS DISTINCT FROM (pin->>'binding_version')::integer
    OR public.shrigma_campaign_current(c.id)->>'version' IS DISTINCT FROM pin->>'campaign_version'
    OR c.send_at IS NULL OR c.send_at<clock_timestamp()+interval '15 minutes'
    OR send_at IS NOT NULL AND send_at IS DISTINCT FROM c.send_at THEN RAISE EXCEPTION 'AB_REGULAR_CAMPAIGN_CHANGED'; END IF;
   send_at:=c.send_at;
   INSERT INTO crm_audience_v2.regular_delivery_campaign(campaign_id,binding_version,binding_hash,material,worker_sha256,runtime_sha256,envelope_from,account_id,region,configuration_set,enabled)
    VALUES(c.id,b.binding_version,b.binding_hash,material,rt->>'worker_sha256',rt->>'runtime_sha256',rt->>'envelope_from',rt->>'account_id',rt->>'region',rt->>'configuration_set',true);
  END LOOP;
  INSERT INTO crm_audience_v2.ab_regular_pair(test_id,brand,campaign_a,campaign_b,scope_hash,review_id)
   SELECT e.test_id,r.brand,
    (SELECT (value->>'campaign_id')::integer FROM jsonb_array_elements(s.scope->'bindings') WHERE value->>'arm'='a'),
    (SELECT (value->>'campaign_id')::integer FROM jsonb_array_elements(s.scope->'bindings') WHERE value->>'arm'='b'),s.scope_hash,rid;
  FOR pin IN SELECT value FROM jsonb_array_elements(s.scope->'bindings') LOOP
   ctx:=crm_audience_v2.selection_worker_context((pin->>'campaign_id')::integer);
   SELECT coalesce(jsonb_agg(m.subscriber_id ORDER BY m.subscriber_id),'[]'),count(*)::integer INTO members,counted
    FROM public.crm_ab_member_v2 m WHERE m.test_id=e.test_id AND m.arm=pin->>'arm'
     AND crm_audience_v2.selection_regular_matches(ctx,m.subscriber_id);
   IF counted<(e.protocol#>>'{rule,minimum_per_arm}')::integer THEN RAISE EXCEPTION 'AB_REGULAR_MINIMUM'; END IF;
   eligible:=eligible||jsonb_build_object(pin->>'arm',members);
  END LOOP;
  IF crm_audience_v2.selection_hash(eligible||jsonb_build_object('test_id',e.test_id,'scope_hash',s.scope_hash))
   IS DISTINCT FROM r.inspection#>>'{audience,eligible_fingerprint}' THEN RAISE EXCEPTION 'AB_REGULAR_AUDIENCE_CHANGED'; END IF;
  prior_writer:=current_setting('shrigma.campaign_writer',true);
  FOREACH counted IN ARRAY ids LOOP
   PERFORM set_config('shrigma.campaign_writer',counted::text,true);
   UPDATE public.campaigns SET status='scheduled',updated_at=clock_timestamp() WHERE id=counted;
  END LOOP;
  PERFORM set_config('shrigma.campaign_writer',coalesce(prior_writer,''),true);
  UPDATE public.crm_ab_experiment_v2 SET state='scheduled',version=version+1,transport_bound=true,tracking_continuous=true,source_complete=true,
   window_start=send_at,window_end=send_at+make_interval(hours=>(protocol#>>'{rule,window_hours}')::integer) WHERE test_id=e.test_id;
  PERFORM crm_audience_v2.regular_admission_runtime(r.brand);
  IF r.expires_at<=clock_timestamp() OR (v.evidence#>>'{review,expires_at}')::timestamptz<=clock_timestamp()
   OR send_at<clock_timestamp()+interval '15 minutes' THEN RAISE EXCEPTION 'AB_REGULAR_EXPIRED'; END IF;
  -- Wall-clock source validation is repeated after all waits and mutations.
  FOREACH counted IN ARRAY ids LOOP
   ctx:=crm_audience_v2.selection_worker_context(counted);
   IF (ctx->>'shopify_expires_at')::timestamptz<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.config WHERE brand=r.brand AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'AB_REGULAR_SOURCE_EXPIRED'; END IF;
  END LOOP;
  SELECT jsonb_build_object('test_id',e.test_id,'brand',r.brand,'state','scheduled','version',e.version+1,
   'campaigns',jsonb_agg(public.shrigma_campaign_current(id) ORDER BY id)) INTO result FROM unnest(ids) id;
  RETURN result;
 END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_regular_fence(integer,integer),crm_audience_v2.ab_regular_context(integer,jsonb),crm_audience_v2.ab_regular_schedule(uuid,text) FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.ab_regular_pause(cid integer) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE p crm_audience_v2.ab_regular_pair%ROWTYPE;
 BEGIN
  SELECT * INTO p FROM crm_audience_v2.ab_regular_pair WHERE cid IN(campaign_a,campaign_b);
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM crm_audience_v2.ab_regular_fence(cid,NULL);
  UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=true WHERE campaign_id IN(p.campaign_a,p.campaign_b);
  UPDATE public.campaigns SET status='paused',updated_at=clock_timestamp()
   WHERE id IN(p.campaign_a,p.campaign_b) AND status::text IN('scheduled','running');
 END $fn$;

-- Native scans quarantine pairs before touching individual campaigns. A pair
-- with an active local pipe or busy row is left to its owning claim/finish.
CREATE FUNCTION crm_audience_v2.ab_regular_quarantine(current_ids integer[]) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE p crm_audience_v2.ab_regular_pair%ROWTYPE;c public.campaigns%ROWTYPE;
  ctl crm_audience_v2.regular_delivery_campaign%ROWTYPE;ctx jsonb;reason text;result jsonb:='[]';
 BEGIN
  FOR p IN SELECT pair.* FROM crm_audience_v2.ab_regular_pair pair
   WHERE NOT(pair.campaign_a=ANY(current_ids) OR pair.campaign_b=ANY(current_ids))
    AND EXISTS(SELECT 1 FROM public.campaigns candidate WHERE candidate.id IN(pair.campaign_a,pair.campaign_b)
     AND (candidate.status::text='running' OR candidate.status::text='scheduled' AND candidate.send_at<=clock_timestamp()))
   ORDER BY least(pair.campaign_a,pair.campaign_b)
  LOOP
   BEGIN
    PERFORM 1 FROM public.campaigns WHERE id IN(p.campaign_a,p.campaign_b) ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id IN(p.campaign_a,p.campaign_b) ORDER BY campaign_id FOR UPDATE NOWAIT;
    reason:=NULL;
    FOR c IN SELECT * FROM public.campaigns WHERE id IN(p.campaign_a,p.campaign_b) ORDER BY id LOOP
     SELECT * INTO ctl FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=c.id;
     IF NOT FOUND OR NOT ctl.enabled OR ctl.suspended OR ctl.material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(c.id) THEN
      reason:='pair_control_unavailable';
     ELSE
      BEGIN
       ctx:=crm_audience_v2.selection_worker_context(c.id);
       IF ctx->'bound' IS DISTINCT FROM 'true'::jsonb THEN reason:='pair_source_unavailable'; END IF;
      EXCEPTION WHEN SQLSTATE '55000' THEN reason:='pair_source_unavailable'; END;
     END IF;
    END LOOP;
    IF reason IS NOT NULL THEN
     PERFORM crm_audience_v2.ab_regular_pause(p.campaign_a);
     result:=result||jsonb_build_array(jsonb_build_object('campaign_id',p.campaign_a,'reason',reason),jsonb_build_object('campaign_id',p.campaign_b,'reason',reason));
    END IF;
   EXCEPTION WHEN lock_not_available THEN NULL;
   END;
  END LOOP;
  RETURN result;
 END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_regular_pause(integer),crm_audience_v2.ab_regular_quarantine(integer[]) FROM PUBLIC;

CREATE TABLE crm_audience_v2.ab_panel_request(
 actor text NOT NULL,operation_id uuid NOT NULL,brand text NOT NULL CHECK(brand IN('fish','aristo')),
 action text NOT NULL CHECK(action IN('prepare','review','schedule','cancel','close')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor,operation_id)
);
CREATE TABLE crm_audience_v2.ab_regular_lifecycle_intent(
 test_id uuid NOT NULL REFERENCES crm_audience_v2.ab_scope(test_id),
 action text NOT NULL CHECK(action IN('cancel','close')),version integer NOT NULL CHECK(version>0),
 actor text NOT NULL,created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(test_id,action,version)
);
CREATE TRIGGER ab_panel_request_immutable BEFORE UPDATE OR DELETE ON crm_audience_v2.ab_panel_request
 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
CREATE TRIGGER ab_regular_lifecycle_immutable BEFORE UPDATE OR DELETE ON crm_audience_v2.ab_regular_lifecycle_intent
 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
REVOKE ALL ON crm_audience_v2.ab_panel_request,crm_audience_v2.ab_regular_lifecycle_intent FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.ab_regular_lifecycle(tid uuid,expected_version integer,action_name text,actor_id text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE e public.crm_ab_experiment_v2%ROWTYPE;cid integer;ids integer[];prior_writer text;reason text;
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000)
   OR actor_id IS NULL OR actor_id !~ '^panel:[A-Za-z0-9_.:-]{1,194}$'
   OR action_name IS NULL OR action_name NOT IN('cancel','close') THEN RAISE EXCEPTION 'AB_REGULAR_LIFECYCLE_BOUNDARY'; END IF;
  BEGIN
   SELECT * INTO e FROM public.crm_ab_experiment_v2 WHERE test_id=tid FOR UPDATE;
   IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.ab_scope WHERE test_id=tid) THEN RAISE EXCEPTION 'AB_V2_NOT_FOUND'; END IF;
   IF e.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'AB_V2_VERSION'; END IF;
   SELECT array_agg(campaign_id ORDER BY campaign_id) INTO ids FROM public.crm_ab_arm_v2 WHERE test_id=tid;
   IF cardinality(ids) IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'AB_REGULAR_LIFECYCLE_BOUNDARY'; END IF;
   PERFORM 1 FROM public.campaigns WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
   PERFORM 1 FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=ANY(ids) ORDER BY campaign_id FOR UPDATE;
   IF action_name='cancel' THEN
    IF e.state NOT IN('prepared','scheduled') THEN RAISE EXCEPTION 'AB_V2_STATE'; END IF;
    IF (SELECT count(*) FROM public.campaigns WHERE id=ANY(ids) AND sent=0 AND started_at IS NULL
     AND (status::text='draft' OR status::text='scheduled' AND send_at>clock_timestamp()))<>2
     OR EXISTS(SELECT 1 FROM public.shrigma_email_dispatch WHERE flow='campaign' AND piece=ANY(ARRAY['audience-regular-v1:'||ids[1]::text,'audience-regular-v1:'||ids[2]::text])) THEN RAISE EXCEPTION 'AB_V2_ALREADY_STARTED'; END IF;
   ELSE
    IF e.state<>'scheduled' OR e.window_end IS NULL OR e.window_end>clock_timestamp() THEN RAISE EXCEPTION 'AB_V2_WINDOW_OPEN'; END IF;
    IF (SELECT count(*) FROM public.campaigns c JOIN public.crm_ab_arm_v2 a ON a.campaign_id=c.id WHERE a.test_id=tid AND c.status::text='finished' AND a.finished_at IS NOT NULL)<>2
     OR EXISTS(SELECT 1 FROM public.shrigma_email_dispatch WHERE flow='campaign' AND piece=ANY(ARRAY['audience-regular-v1:'||ids[1]::text,'audience-regular-v1:'||ids[2]::text]) AND transport_state IN('in_flight','outcome_unknown')) THEN RAISE EXCEPTION 'AB_V2_DELIVERY_UNCONFIRMED'; END IF;
   END IF;
   INSERT INTO crm_audience_v2.ab_regular_lifecycle_intent(test_id,action,version,actor) VALUES(tid,action_name,e.version,actor_id);
   IF action_name='cancel' THEN
    prior_writer:=current_setting('shrigma.campaign_writer',true);
    FOREACH cid IN ARRAY ids LOOP
     PERFORM set_config('shrigma.campaign_writer',cid::text,true);
     UPDATE public.campaigns SET status='cancelled',updated_at=clock_timestamp() WHERE id=cid;
    END LOOP;
    PERFORM set_config('shrigma.campaign_writer',coalesce(prior_writer,''),true);
    UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=true WHERE campaign_id=ANY(ids);
   END IF;
   UPDATE public.crm_ab_experiment_v2 SET state=CASE action_name WHEN 'cancel' THEN 'cancelled' ELSE 'closed' END,version=version+1 WHERE test_id=tid;
   RETURN public.crm_ab_snapshot_v2(tid);
  EXCEPTION WHEN raise_exception THEN
   GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
   IF reason !~ '^AB_V2_[A-Z_]+$' THEN RAISE; END IF;
   RETURN jsonb_build_object('_error',reason);
  END;
 END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_regular_lifecycle(uuid,integer,text,text) FROM PUBLIC;

-- Aggregate readiness only; worker hashes and policy details stay private.
CREATE FUNCTION crm_audience_v2.ab_regular_ready(b text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT b IN ('fish','aristo') AND coalesce((SELECT d.enabled AND d.approved_at<=clock_timestamp() AND NOT l.suspended
  AND l.heartbeat_at<=clock_timestamp() AND l.expires_at>clock_timestamp()
  AND d.worker_sha256=l.worker_sha256 AND d.runtime_sha256=l.runtime_sha256 AND d.database_role=l.database_role
  AND p.enabled FROM crm_audience_v2.regular_worker_deployment d CROSS JOIN crm_audience_v2.regular_worker_lease l
  JOIN crm_audience_v2.regular_sender_policy p ON p.brand=b WHERE d.singleton AND l.singleton),false)
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.ab_regular_ready(text) FROM PUBLIC;

-- Exact reviewed function extensions. Fail on dependency drift; retain ACLs.
DO $extend$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_worker_context(integer)')) IS DISTINCT FROM '6dda8e57d4468f8c859b076eac1cff29' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.selection_regular_matches(jsonb,integer)')) IS DISTINCT FROM 'bec9897a1b8ed1601afd67e73bb79df2' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.regular_delivery_claim(integer,integer,uuid,text,text,text,text,text,jsonb)')) IS DISTINCT FROM '93ac37b8dda33b3700e92ff2c25950ea' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.regular_delivery_finish(integer,integer,uuid,uuid,text)')) IS DISTINCT FROM '6fc3493c29d54df85692e672a7bdbc4b' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.regular_delivery_quarantine(integer[])')) IS DISTINCT FROM 'd4439b911f2a27ee439ecddc0b455458' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.regular_delivery_recover(integer,integer,uuid,boolean)')) IS DISTINCT FROM '4d413875f179c714f16695d8028441cb' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.regular_admission_schedule(uuid,text)')) IS DISTINCT FROM 'c13fe0ec14a4dde2f95dee7d49ba1174' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.ab_assignment_guard()')) IS DISTINCT FROM '9791a27e9ed040c114df9f7500c6cb5c' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.ab_experiment_guard()')) IS DISTINCT FROM 'f9f10c9d3dceb3358ac72cd751ff1f74' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.crm_ab_campaign_guard_v2()')) IS DISTINCT FROM '6d1d65be352afdba9adbd1e0cda0c828' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.campaign_send_guard()')) IS DISTINCT FROM '8e7096ecbd7d7165ea3e4de41417222e' THEN RAISE EXCEPTION 'AB_REGULAR_FUNCTION_DRIFT'; END IF;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION crm_audience_v2.selection_worker_context(cid integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE ctx jsonb;
 BEGIN
  ctx:=crm_audience_v2.selection_context(cid,'3dc9433187c4ee16f0516503c6cc3efae63e9a607f9a15748e52a43217c6f7de',true);
  IF ctx IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
  IF ctx->'bound'='true'::jsonb THEN
   SELECT ctx||jsonb_build_object('list_ids',jsonb_agg(DISTINCT pin->'list_id'),
    'single_list_ids',coalesce(jsonb_agg(DISTINCT pin->'list_id') FILTER(WHERE pin->>'optin'='single'),'[]'::jsonb))
   INTO ctx FROM jsonb_array_elements(ctx->'list_pins') pin;
  END IF;
  RETURN crm_audience_v2.ab_regular_context(cid,ctx);
 END $fn$$replacement$;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION crm_audience_v2.selection_regular_matches(ctx jsonb,sid integer) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE consented integer[]; matched boolean;
 BEGIN
  IF ctx IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
  IF ctx->'bound'='false'::jsonb THEN RETURN true; END IF;
  IF ctx ? 'ab_test_id' AND NOT EXISTS(SELECT 1 FROM public.crm_ab_member_v2
   WHERE test_id=(ctx->>'ab_test_id')::uuid AND arm=ctx->>'ab_arm' AND subscriber_id=sid AND revoked_at IS NULL) THEN RETURN false; END IF;
  -- A real opt-out, disabled contact or expression non-match is ineligible;
  -- source/runtime/context failure above must never be represented as zero.
  IF NOT EXISTS(SELECT 1 FROM public.subscribers s WHERE s.id=sid AND s.status::text='enabled') THEN RETURN false; END IF;
  SELECT coalesce(array_agg(sl.list_id),ARRAY[]::integer[]) INTO consented FROM public.subscriber_lists sl
   WHERE sl.subscriber_id=sid AND ctx->'list_ids' @> to_jsonb(sl.list_id)
    AND (sl.status::text='confirmed' OR (sl.status::text='unconfirmed' AND ctx->'single_list_ids' @> to_jsonb(sl.list_id)));
  IF NOT (ctx->>'base_list_id')::integer=ANY(consented) THEN RETURN false; END IF;
  matched:=crm_audience_v2.selection_regular_rule_match(ctx#>'{definition,rule}',consented,sid,ctx->>'brand');
  IF matched IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_SELECTION_UNAVAILABLE'; END IF;
  RETURN matched;
 END $fn$$replacement$;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION crm_audience_v2.regular_delivery_claim(
 cid integer,sid integer,did uuid,worker_sha text,runtime_sha text,
 envelope_from text,envelope_to text,payload_sha text,subscriber_snapshot jsonb)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
 SET search_path=pg_catalog SET TimeZone='UTC' SET lock_timeout='500ms' AS $fn$
 #variable_conflict use_variable
 DECLARE c public.campaigns%ROWTYPE;e crm_audience_v2.regular_delivery_campaign%ROWTYPE;
 b crm_audience_v2.campaign_binding%ROWTYPE;s public.subscribers%ROWTYPE;
 ctx jsonb;d public.shrigma_email_dispatch%ROWTYPE;k text;piece text;token uuid;first_id integer;live_at timestamptz;valid_until timestamptz;
 timestamp_pattern text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?([+-][0-9]{2}:[0-9]{2}|Z)$';
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_DELIVERY_BOUNDARY';
  END IF;
  IF cid IS NULL OR cid<=0 OR sid IS NULL OR sid<=0 OR did IS NULL
   OR worker_sha IS NULL OR worker_sha !~ '^[0-9a-f]{64}$'
   OR runtime_sha IS NULL OR runtime_sha !~ '^[0-9a-f]{64}$'
   OR payload_sha IS NULL OR payload_sha !~ '^[0-9a-f]{64}$'
   OR nullif(envelope_from,'') IS NULL OR nullif(envelope_to,'') IS NULL
   OR jsonb_typeof(subscriber_snapshot) IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'SEGMENT_DELIVERY_INPUT';
  END IF;
  PERFORM crm_audience_v2.ab_regular_fence(cid,sid);
  -- One campaign lock serializes attempts across processes as well as workers.
  SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
  SELECT * INTO STRICT e FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=cid FOR UPDATE;
  SELECT * INTO STRICT b FROM crm_audience_v2.campaign_binding WHERE campaign_id=cid FOR SHARE;
  IF NOT e.enabled OR e.suspended OR c.status::text<>'running'
   OR c.sent IS DISTINCT FROM e.acknowledged_sent OR c.last_subscriber_id IS DISTINCT FROM e.acknowledged_subscriber_id
   OR e.binding_version IS DISTINCT FROM b.binding_version OR e.binding_hash IS DISTINCT FROM b.binding_hash
   OR e.worker_sha256 IS DISTINCT FROM worker_sha OR e.runtime_sha256 IS DISTINCT FROM runtime_sha
   OR e.envelope_from IS DISTINCT FROM envelope_from THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_UNAVAILABLE';
  END IF;
  -- Stabilize every declared dependency and the live selector before comparing.
  PERFORM 1 FROM crm_audience_v2.selection_runtime FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.config WHERE brand=b.brand FOR SHARE;
  -- Freeze the source pointer until the durable claim commits.
  PERFORM 1 FROM crm_audience_v2.shopify_source WHERE brand=b.brand FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.audience WHERE id=b.audience_id FOR SHARE;
  PERFORM 1 FROM public.campaign_lists WHERE campaign_id=cid ORDER BY list_id FOR SHARE;
  PERFORM 1 FROM public.campaign_media WHERE campaign_id=cid ORDER BY media_id FOR SHARE;
  PERFORM 1 FROM public.templates WHERE id=c.template_id FOR SHARE;
  PERFORM 1 FROM public.lists WHERE id IN(SELECT list_id FROM public.campaign_lists WHERE campaign_id=cid) ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.media WHERE id IN(SELECT media_id FROM public.campaign_media WHERE campaign_id=cid) ORDER BY id FOR SHARE;
  ctx:=crm_audience_v2.selection_worker_context(cid);
  PERFORM 1 FROM public.lists WHERE id IN(SELECT (value->>'list_id')::integer FROM jsonb_array_elements(ctx->'list_pins')) ORDER BY id FOR SHARE;
  -- The leaf locks may wait. Read the context again under a fresh READ COMMITTED
  -- command snapshot before treating the earlier source/pin check as current.
  ctx:=crm_audience_v2.selection_worker_context(cid);
  IF ctx->'bound' IS DISTINCT FROM 'true'::jsonb
   OR e.material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(cid) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_MATERIAL_DRIFT';
  END IF;
  piece:='audience-regular-v1:'||cid::text;
  k:=jsonb_build_array(cid,b.binding_version,sid)::text;
  SELECT * INTO d FROM public.shrigma_email_dispatch x
   WHERE x.brand=b.brand AND x.flow='campaign' AND x.piece=piece AND x.dedupe_key=k FOR UPDATE;
  IF FOUND THEN
   RETURN jsonb_build_object('should_send',false,'reason',d.transport_state,'dispatch_id',d.dispatch_id,'claim_token',NULL);
  END IF;
  IF EXISTS(SELECT 1 FROM public.shrigma_email_dispatch x WHERE x.brand=b.brand
   AND x.flow='campaign' AND x.piece=piece AND x.transport_state IN('in_flight','outcome_unknown')) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_RECONCILIATION_REQUIRED';
  END IF;
  IF sid<=c.last_subscriber_id THEN
   RETURN jsonb_build_object('should_send',false,'reason','already_checkpointed','dispatch_id',NULL,'claim_token',NULL);
  END IF;
  IF sid>c.max_subscriber_id THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_CURSOR'; END IF;
  SELECT * INTO STRICT s FROM public.subscribers WHERE id=sid FOR UPDATE;
  PERFORM 1 FROM public.subscriber_lists WHERE subscriber_id=sid ORDER BY list_id FOR SHARE;
  ctx:=crm_audience_v2.selection_worker_context(cid);
  -- Never jump over another currently eligible recipient; a mutex alone cannot
  -- guarantee ordering when several native workers dequeue concurrently.
  SELECT min(sl.subscriber_id) INTO first_id FROM public.subscriber_lists sl
   WHERE sl.list_id=b.base_list_id AND sl.subscriber_id>c.last_subscriber_id AND sl.subscriber_id<=sid
    AND crm_audience_v2.selection_regular_matches(ctx,sl.subscriber_id);
  IF first_id IS NOT NULL AND first_id<>sid THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_ORDER'; END IF;
  ctx:=crm_audience_v2.selection_worker_context(cid);
  -- Selector snapshots intentionally use statement_timestamp for count/batch
  -- consistency. Delivery must additionally recheck the wall clock after waits.
  live_at:=clock_timestamp();
  SELECT least(cfg.expires_at,rt.verified_at+interval '5 minutes',(ctx->>'shopify_expires_at')::timestamptz) INTO valid_until
   FROM crm_audience_v2.config cfg CROSS JOIN crm_audience_v2.selection_runtime rt
   WHERE cfg.brand=b.brand AND cfg.enabled AND rt.enabled;
  IF valid_until IS NULL OR NOT isfinite(valid_until) OR valid_until<=live_at THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SOURCE_EXPIRED';
  END IF;
  IF NOT crm_audience_v2.selection_regular_matches(ctx,sid) THEN
   UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_subscriber_id=sid WHERE campaign_id=cid;
   UPDATE public.campaigns SET last_subscriber_id=sid,updated_at=clock_timestamp() WHERE id=cid;
   RETURN jsonb_build_object('should_send',false,'reason','ineligible','dispatch_id',NULL,'claim_token',NULL);
  END IF;
  -- The native batch may use a different session timezone. Preserve every
  -- other raw field exactly, but compare the two native timestamptz columns
  -- as instants (including microseconds), never as formatted JSON strings.
  IF (to_jsonb(s)-ARRAY['created_at','updated_at']) IS DISTINCT FROM (subscriber_snapshot-ARRAY['created_at','updated_at'])
   OR NOT(subscriber_snapshot ?& ARRAY['created_at','updated_at'])
   OR jsonb_typeof(subscriber_snapshot->'created_at') NOT IN('string','null')
   OR jsonb_typeof(subscriber_snapshot->'updated_at') NOT IN('string','null')
   OR lower(s.email) IS DISTINCT FROM lower(envelope_to) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SUBSCRIBER_DRIFT';
  END IF;
  BEGIN
   IF (subscriber_snapshot->>'created_at') !~ timestamp_pattern
    OR (subscriber_snapshot->>'updated_at') !~ timestamp_pattern
    OR (subscriber_snapshot->>'created_at')::timestamptz IS DISTINCT FROM s.created_at
    OR (subscriber_snapshot->>'updated_at')::timestamptz IS DISTINCT FROM s.updated_at THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SUBSCRIBER_DRIFT';
   END IF;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SUBSCRIBER_DRIFT';
  END;
  token:=gen_random_uuid();
  INSERT INTO public.shrigma_email_dispatch(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,
   account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token)
  SELECT did,b.brand,'campaign',piece,k,payload_sha,e.account_id,e.region,e.configuration_set,
   r.recipient_key,r.key_version,false,'in_flight',clock_timestamp(),token FROM public.shrigma_email_recipient_key(envelope_to) r;
  IF NOT FOUND THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_RECIPIENT_KEY'; END IF;
  live_at:=clock_timestamp();
  IF valid_until<=live_at THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SEGMENT_DELIVERY_SOURCE_EXPIRED'; END IF;
  RETURN jsonb_build_object('should_send',true,'reason','claimed','dispatch_id',did,'claim_token',token,
   'checked_at',live_at,'valid_until',valid_until);
 END
$fn$$replacement$;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION crm_audience_v2.regular_delivery_finish(cid integer,sid integer,did uuid,token uuid,outcome text)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE c public.campaigns%ROWTYPE;e crm_audience_v2.regular_delivery_campaign%ROWTYPE;d public.shrigma_email_dispatch%ROWTYPE;
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_DELIVERY_BOUNDARY';
  END IF;
  IF outcome IS NULL OR outcome NOT IN('accepted','outcome_unknown') OR token IS NULL THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_FINISH_INPUT'; END IF;
  PERFORM crm_audience_v2.ab_regular_fence(cid,sid);
  SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
  SELECT * INTO STRICT e FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=cid FOR UPDATE;
  SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE dispatch_id=did FOR UPDATE;
  IF d.claim_token IS DISTINCT FROM token OR d.flow<>'campaign' OR d.brand IS DISTINCT FROM c.attribs#>>'{crm,brand}'
   OR d.piece IS DISTINCT FROM 'audience-regular-v1:'||cid::text
   OR d.dedupe_key IS DISTINCT FROM jsonb_build_array(cid,e.binding_version,sid)::text OR d.is_test THEN
   RAISE EXCEPTION 'SEGMENT_DELIVERY_FINISH_MISMATCH';
  END IF;
  IF d.transport_state<>'in_flight' THEN
   IF d.transport_state IS DISTINCT FROM outcome THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_OUTCOME_CONFLICT'; END IF;
   RETURN jsonb_build_object('dispatch_id',did,'outcome',d.transport_state);
  END IF;
  UPDATE public.shrigma_email_dispatch SET transport_state=outcome,outcome_at=clock_timestamp(),
   accepted_at=CASE WHEN outcome='accepted' THEN clock_timestamp() END,
   error_code=CASE WHEN outcome='outcome_unknown' THEN 'NATIVE_REGULAR_OUTCOME_UNKNOWN' END WHERE dispatch_id=did;
  IF outcome='accepted' THEN
   IF c.last_subscriber_id>=sid THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_FINISH_CURSOR'; END IF;
   IF c.sent IS DISTINCT FROM e.acknowledged_sent OR c.last_subscriber_id IS DISTINCT FROM e.acknowledged_subscriber_id THEN RAISE EXCEPTION 'SEGMENT_DELIVERY_FINISH_PROGRESS'; END IF;
   UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_sent=c.sent+1,acknowledged_subscriber_id=sid WHERE campaign_id=cid;
   UPDATE public.campaigns SET sent=sent+1,last_subscriber_id=sid,updated_at=clock_timestamp() WHERE id=cid;
  ELSE
   UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=true WHERE campaign_id=cid;
   PERFORM crm_audience_v2.ab_regular_pause(cid);
  END IF;
  RETURN jsonb_build_object('dispatch_id',did,'outcome',outcome);
 END
$fn$$replacement$;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION crm_audience_v2.regular_delivery_quarantine(current_ids integer[])
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
 SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE cid integer;e crm_audience_v2.regular_delivery_campaign%ROWTYPE;ctx jsonb;
 reason text;result jsonb:='[]'::jsonb;
 BEGIN
  IF current_ids IS NULL OR current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_QUARANTINE_BOUNDARY';
  END IF;
  result:=crm_audience_v2.ab_regular_quarantine(current_ids);
  FOR cid IN SELECT c.id FROM public.campaigns c
   JOIN crm_audience_v2.campaign_binding b ON b.campaign_id=c.id
   WHERE NOT(c.id=ANY(current_ids))
    AND NOT EXISTS(SELECT 1 FROM crm_audience_v2.ab_regular_pair WHERE c.id IN(campaign_a,campaign_b))
    AND (c.status::text='running' OR (c.status::text='scheduled' AND c.send_at<=clock_timestamp()))
   ORDER BY c.id FOR UPDATE OF c SKIP LOCKED
  LOOP
   reason:=NULL;
   SELECT * INTO e FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=cid FOR UPDATE;
   IF NOT FOUND OR NOT e.enabled OR e.suspended THEN
    reason:='control_unavailable';
   ELSE
    BEGIN
     ctx:=crm_audience_v2.selection_worker_context(cid);
     IF ctx->'bound' IS DISTINCT FROM 'true'::jsonb
      OR e.material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(cid) THEN
      reason:='material_unavailable';
     END IF;
    EXCEPTION WHEN SQLSTATE '55000' THEN reason:='source_unavailable'; END;
   END IF;
   IF reason IS NOT NULL THEN
    UPDATE public.campaigns SET status='paused',updated_at=clock_timestamp() WHERE id=cid;
    UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=true WHERE campaign_id=cid;
    result:=result||jsonb_build_array(jsonb_build_object('campaign_id',cid,'reason',reason));
   END IF;
  END LOOP;
  RETURN result;
 END
$fn$$replacement$;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION crm_audience_v2.regular_delivery_recover(cid integer,sid integer,did uuid,dry_run boolean DEFAULT true)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
 SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE c public.campaigns%ROWTYPE;ctl crm_audience_v2.regular_delivery_campaign%ROWTYPE;
 d public.shrigma_email_dispatch%ROWTYPE;a crm_audience_v2.regular_delivery_recovery%ROWTYPE;
 e record;q record;envelope jsonb;verified boolean;recipient text;key text;key_version text;
 message text;sent_at timestamptz;delivered_at timestamptz;statuses text[]='{}';evidence jsonb='[]';
 result text;
 BEGIN
  IF cid IS NULL OR sid IS NULL OR did IS NULL OR dry_run IS NULL
   OR current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN
   RAISE EXCEPTION 'SEGMENT_RECOVERY_BOUNDARY';
  END IF;
  BEGIN
   PERFORM crm_audience_v2.ab_regular_fence(cid,sid);
   SELECT * INTO STRICT c FROM public.campaigns WHERE id=cid FOR UPDATE;
   SELECT * INTO STRICT ctl FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=cid FOR UPDATE;
   SELECT * INTO STRICT d FROM public.shrigma_email_dispatch WHERE dispatch_id=did FOR UPDATE;
   IF d.flow IS DISTINCT FROM 'campaign' OR d.brand NOT IN('fish','aristo') OR d.brand IS NULL
    OR d.brand IS DISTINCT FROM c.attribs#>>'{crm,brand}'
    OR d.piece IS DISTINCT FROM 'audience-regular-v1:'||cid::text
    OR d.dedupe_key IS DISTINCT FROM jsonb_build_array(cid,ctl.binding_version,sid)::text
    OR d.is_test IS DISTINCT FROM false OR d.claim_token IS NULL THEN
    RAISE EXCEPTION 'SEGMENT_RECOVERY_SCOPE';
   END IF;
   SELECT * INTO a FROM crm_audience_v2.regular_delivery_recovery WHERE dispatch_id=did;
   IF FOUND THEN
    IF a.campaign_id IS DISTINCT FROM cid OR a.subscriber_id IS DISTINCT FROM sid
     OR d.transport_state IS DISTINCT FROM 'accepted' OR c.last_subscriber_id<sid
     OR d.error_code IS DISTINCT FROM 'REGULAR_RECONCILED_SES_DELIVERY'
     OR d.accepted_at IS DISTINCT FROM (a.evidence->0->>'send_at')::timestamptz
     OR (to_jsonb(d)-ARRAY['transport_state','outcome_at','accepted_at','error_code'])
      IS DISTINCT FROM (a.before_state-ARRAY['transport_state','outcome_at','accepted_at','error_code']) THEN
     RAISE EXCEPTION 'SEGMENT_RECOVERY_AUDIT_DRIFT';
    END IF;
   ELSIF d.transport_state NOT IN('in_flight','outcome_unknown') OR d.transport_state IS NULL
    OR d.started_at IS NULL OR d.started_at>clock_timestamp()-interval '15 minutes'
    OR d.send_log_id IS NOT NULL OR d.payload_sha256 !~ '^[0-9a-f]{64}$' OR d.payload_sha256 IS NULL
    OR d.account_id IS DISTINCT FROM ctl.account_id OR d.region IS DISTINCT FROM ctl.region
    OR d.configuration_set IS DISTINCT FROM ctl.configuration_set
    OR c.last_subscriber_id>=sid THEN
    RAISE EXCEPTION 'SEGMENT_RECOVERY_STATE';
   END IF;
   -- Lock and check the ingest, normalized event and original archived SNS body.
   -- Other event types are allowed, but conflicts and multiple message identities
   -- attached to this dispatch are never ignored on first reconciliation.
   IF a.dispatch_id IS NULL AND EXISTS(SELECT 1 FROM public.shrigma_email_status s
    WHERE (s.dispatch_id=did OR s.dispatch_id_claim=did)
     AND (s.reconciliation_status IS DISTINCT FROM 'matched' OR s.dispatch_id IS DISTINCT FROM did
      OR s.dispatch_id_claim IS DISTINCT FROM did OR s.is_test IS DISTINCT FROM false OR s.is_test_claim IS DISTINCT FROM false)) THEN
    RAISE EXCEPTION 'SEGMENT_RECOVERY_CONFLICT';
   END IF;
   FOR e IN SELECT s.*,i.event_payload,i.message_sha256,i.sns_message_id,i.topic_arn,i.result AS ingest_result
    FROM public.shrigma_email_status s JOIN public.shrigma_email_event_ingest i ON i.ingest_id=s.first_ingest_id
    WHERE (a.dispatch_id IS NULL AND (s.dispatch_id=did OR s.dispatch_id_claim=did) AND s.status IN('send','delivery'))
     OR (a.dispatch_id IS NOT NULL AND s.event_key IN(SELECT value->>'event_key' FROM jsonb_array_elements(a.evidence)))
    ORDER BY s.event_key FOR SHARE OF s,i NOWAIT
   LOOP
    IF e.status NOT IN('send','delivery') OR e.status=ANY(statuses)
     OR e.reconciliation_status IS DISTINCT FROM 'matched' OR e.dispatch_id IS DISTINCT FROM did OR e.dispatch_id_claim IS DISTINCT FROM did
     OR e.is_test IS DISTINCT FROM false OR e.is_test_claim IS DISTINCT FROM false
     OR e.account_id IS DISTINCT FROM d.account_id OR e.region IS DISTINCT FROM d.region
     OR e.recipient_key IS DISTINCT FROM d.recipient_key OR e.recipient_key_version IS DISTINCT FROM d.recipient_key_version
     OR e.ingest_result IS DISTINCT FROM 'processed'
     OR e.topic_arn IS DISTINCT FROM 'arn:aws:sns:'||d.region||':'||d.account_id||':shrigma-ses-events'
     OR e.event_payload->>'eventType' IS DISTINCT FROM (CASE e.status WHEN 'send' THEN 'Send' ELSE 'Delivery' END)
     OR e.event_payload#>>'{mail,sendingAccountId}' IS DISTINCT FROM d.account_id
     OR e.event_payload#>'{mail,tags,crm_dispatch_id}' IS DISTINCT FROM jsonb_build_array(did::text)
     OR e.event_payload#>'{mail,tags,crm_test}' IS DISTINCT FROM '["false"]'::jsonb
     OR e.event_payload#>'{mail,tags,ses:configuration-set}' IS DISTINCT FROM jsonb_build_array(d.configuration_set)
     OR e.event_payload#>>'{mail,messageId}' IS DISTINCT FROM e.message_id
     OR jsonb_typeof(e.event_payload#>'{mail,destination}') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'SEGMENT_RECOVERY_PROOF';
    END IF;
    IF jsonb_array_length(e.event_payload#>'{mail,destination}')<>1 THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_RECIPIENT'; END IF;
    IF recipient IS NULL THEN
     recipient:=e.event_payload#>>'{mail,destination,0}';
     IF recipient IS NULL OR recipient='' OR recipient<>btrim(recipient) THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_RECIPIENT'; END IF;
     IF a.dispatch_id IS NULL THEN
      SELECT r.recipient_key,r.key_version INTO STRICT key,key_version FROM public.shrigma_email_recipient_key(recipient) r;
      IF key IS DISTINCT FROM d.recipient_key OR key_version IS DISTINCT FROM d.recipient_key_version THEN
       RAISE EXCEPTION 'SEGMENT_RECOVERY_RECIPIENT';
      END IF;
     END IF;
    ELSIF e.event_payload#>'{mail,destination}' IS DISTINCT FROM jsonb_build_array(recipient) THEN
     RAISE EXCEPTION 'SEGMENT_RECOVERY_RECIPIENT';
    END IF;
    PERFORM 1 FROM public.shrigma_email_message_link m WHERE m.dispatch_id=did
     AND m.account_id=d.account_id AND m.region=d.region AND m.message_id=e.message_id FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_MESSAGE_LINK'; END IF;
    verified:=false;
    FOR q IN SELECT * FROM public.shrigma_email_queue_receipt WHERE ingest_id=e.first_ingest_id FOR SHARE NOWAIT LOOP
     BEGIN
      envelope:=q.body_raw::jsonb;
      IF q.body_sha256=encode(public.digest(convert_to(q.body_raw,'UTF8'),'sha256'),'hex')
       AND q.body_sha256=e.message_sha256 AND envelope->>'TopicArn'=e.topic_arn
       AND envelope->>'MessageId'=e.sns_message_id AND (envelope->>'Message')::jsonb=e.event_payload THEN
       verified:=true;
      END IF;
     EXCEPTION WHEN invalid_text_representation THEN NULL; END;
    END LOOP;
    IF NOT verified THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_ARCHIVE'; END IF;
    IF message IS NULL THEN
     message:=e.message_id;sent_at:=(e.event_payload#>>'{mail,timestamp}')::timestamptz;
     IF message IS NULL OR sent_at IS NULL OR sent_at<d.started_at OR sent_at>d.started_at+interval '5 minutes'
      OR sent_at>clock_timestamp() THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_TIME'; END IF;
    ELSIF e.message_id IS DISTINCT FROM message OR (e.event_payload#>>'{mail,timestamp}')::timestamptz IS DISTINCT FROM sent_at THEN
     RAISE EXCEPTION 'SEGMENT_RECOVERY_MESSAGE_CONFLICT';
    END IF;
    IF e.status='delivery' THEN
     delivered_at:=(e.event_payload#>>'{delivery,timestamp}')::timestamptz;
     IF delivered_at IS NULL OR delivered_at<sent_at OR delivered_at>clock_timestamp()
      OR e.event_payload#>'{delivery,recipients}' IS DISTINCT FROM jsonb_build_array(recipient) THEN
      RAISE EXCEPTION 'SEGMENT_RECOVERY_DELIVERY';
     END IF;
    END IF;
    statuses:=array_append(statuses,e.status);
    evidence:=evidence||jsonb_build_array(jsonb_build_object('event_key',e.event_key,'status',e.status,
     'ingest_id',e.first_ingest_id,'message_id',e.message_id,'message_sha256',e.message_sha256,
     'send_at',sent_at,'delivery_at',CASE WHEN e.status='delivery' THEN delivered_at END));
   END LOOP;
   IF cardinality(statuses)<>2 OR NOT statuses @> ARRAY['send','delivery'] OR delivered_at IS NULL THEN
    RAISE EXCEPTION 'SEGMENT_RECOVERY_SEND_AND_DELIVERY_REQUIRED';
   END IF;
   IF a.dispatch_id IS NOT NULL THEN
    IF evidence IS DISTINCT FROM a.evidence THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_AUDIT_PROOF_DRIFT'; END IF;
    result:='already_reconciled';
   ELSE
    IF EXISTS(SELECT 1 FROM public.shrigma_email_status s WHERE (s.dispatch_id=did OR s.dispatch_id_claim=did)
     AND s.message_id IS DISTINCT FROM message) THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_MESSAGE_CONFLICT'; END IF;
    INSERT INTO crm_audience_v2.regular_delivery_recovery(dispatch_id,campaign_id,subscriber_id,before_state,evidence)
     VALUES(did,cid,sid,to_jsonb(d),evidence);
    UPDATE public.shrigma_email_dispatch SET transport_state='accepted',accepted_at=sent_at,
     outcome_at=clock_timestamp(),error_code='REGULAR_RECONCILED_SES_DELIVERY' WHERE dispatch_id=did;
    IF c.sent IS DISTINCT FROM ctl.acknowledged_sent OR c.last_subscriber_id IS DISTINCT FROM ctl.acknowledged_subscriber_id THEN RAISE EXCEPTION 'SEGMENT_RECOVERY_PROGRESS'; END IF;
    UPDATE crm_audience_v2.regular_delivery_campaign SET acknowledged_sent=c.sent+1,acknowledged_subscriber_id=sid WHERE campaign_id=cid;
    UPDATE public.campaigns SET sent=sent+1,last_subscriber_id=sid,updated_at=clock_timestamp() WHERE id=cid;
    UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=true WHERE campaign_id=cid;
    result:='reconciled';
    IF dry_run THEN RAISE EXCEPTION USING ERRCODE='Z9918',MESSAGE='SEGMENT_RECOVERY_DRY_ROLLBACK'; END IF;
   END IF;
  EXCEPTION WHEN SQLSTATE 'Z9918' THEN result:='would_reconcile'; END;
  RETURN jsonb_build_object('dispatch_id',did,'result',result,'authorizes_send',false,'authorizes_resume',false);
 END
$fn$$replacement$;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION crm_audience_v2.regular_admission_schedule(rid uuid,actor_id text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE r crm_audience_v2.regular_admission_review%ROWTYPE;c public.campaigns%ROWTYPE;
 rt jsonb;ctx jsonb;prior_writer text;
 BEGIN
  SELECT * INTO STRICT r FROM crm_audience_v2.regular_admission_review WHERE id=rid AND actor=actor_id;
  IF EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 WHERE campaign_id=r.campaign_id) THEN RAISE EXCEPTION 'AB_REGULAR_PAIR_ADMISSION_REQUIRED'; END IF;
  IF NOT crm_audience_v2.ab_regular_tracking() THEN RAISE EXCEPTION 'AB_REGULAR_TRACKING_UNAVAILABLE'; END IF;
  rt:=crm_audience_v2.regular_admission_runtime(r.brand);
  SELECT * INTO STRICT c FROM public.campaigns WHERE id=r.campaign_id FOR UPDATE;
  PERFORM crm_audience_v2.regular_admission_snapshot(c.id);
  PERFORM 1 FROM crm_audience_v2.campaign_binding WHERE campaign_id=c.id FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.config WHERE brand=r.brand FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.audience a JOIN crm_audience_v2.campaign_binding b ON b.audience_id=a.id WHERE b.campaign_id=c.id FOR SHARE OF a;
  IF r.expires_at<=clock_timestamp() OR r.checked_at>clock_timestamp() OR rt IS DISTINCT FROM r.runtime
   OR r.material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(c.id)
   OR public.shrigma_campaign_current(c.id)->>'version' IS DISTINCT FROM r.campaign_version
   OR c.send_at IS NULL OR c.send_at<clock_timestamp()+interval '15 minutes'
   OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding b WHERE b.campaign_id=c.id AND b.brand=r.brand
    AND b.binding_version=r.binding_version AND b.binding_hash=r.binding_hash)
   OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=c.id)
   OR EXISTS(SELECT 1 FROM public.shrigma_email_dispatch WHERE flow='campaign' AND piece='audience-regular-v1:'||c.id::text) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='REGULAR_ADMISSION_CHANGED';
  END IF;
  ctx:=crm_audience_v2.selection_worker_context(c.id);
  IF ctx->'bound' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'REGULAR_ADMISSION_SOURCE'; END IF;
  INSERT INTO crm_audience_v2.regular_delivery_campaign(campaign_id,binding_version,binding_hash,material,worker_sha256,runtime_sha256,envelope_from,account_id,region,configuration_set,enabled)
   VALUES(c.id,r.binding_version,r.binding_hash,r.material,rt->>'worker_sha256',rt->>'runtime_sha256',rt->>'envelope_from',rt->>'account_id',rt->>'region',rt->>'configuration_set',true);
  prior_writer:=current_setting('shrigma.campaign_writer',true);
  PERFORM set_config('shrigma.campaign_writer',c.id::text,true);
  UPDATE public.campaigns SET status='scheduled',updated_at=clock_timestamp() WHERE id=c.id;
  PERFORM set_config('shrigma.campaign_writer',coalesce(prior_writer,''),true);
  -- Recheck wall-clock lease/review expiry after every lock and mutation. Failure
  -- rolls back the control and schedule, never leaves an orphan approval.
  PERFORM crm_audience_v2.regular_admission_runtime(r.brand);
  IF r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'REGULAR_ADMISSION_EXPIRED'; END IF;
  RETURN public.shrigma_campaign_current(c.id);
 END
$fn$$replacement$;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION crm_audience_v2.ab_assignment_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE s crm_audience_v2.ab_scope%ROWTYPE;tid uuid;old_scoped boolean:=false;pin jsonb;
 BEGIN
  -- A stale RR snapshot must never treat newly scoped assignments as legacy.
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'AB_AUDIENCE_ISOLATION';END IF;
  IF TG_OP<>'INSERT' THEN SELECT EXISTS(SELECT 1 FROM crm_audience_v2.ab_scope WHERE test_id=OLD.test_id) INTO old_scoped;END IF;
  tid:=CASE WHEN TG_OP='DELETE' THEN OLD.test_id ELSE NEW.test_id END;
  SELECT * INTO s FROM crm_audience_v2.ab_scope WHERE test_id=tid;
  IF TG_TABLE_NAME='crm_ab_arm_v2' THEN
   IF TG_OP='INSERT' AND s.test_id IS NULL
    AND EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding WHERE campaign_id=NEW.campaign_id)
   THEN RAISE EXCEPTION 'AB_AUDIENCE_SCOPE_REQUIRED';END IF;
  END IF;
  IF s.test_id IS NULL AND NOT old_scoped THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
  IF TG_OP='DELETE' OR s.test_id IS NULL THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT_IMMUTABLE';END IF;
  IF TG_TABLE_NAME='crm_ab_arm_v2' THEN
  IF TG_OP='UPDATE' AND pg_trigger_depth()>1
   AND EXISTS(SELECT 1 FROM crm_audience_v2.ab_regular_pair WHERE test_id=NEW.test_id)
   AND (to_jsonb(OLD)-ARRAY['finished_at','transport_interrupted_at'])=(to_jsonb(NEW)-ARRAY['finished_at','transport_interrupted_at'])
   AND (OLD.finished_at IS NULL OR NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at)
   AND (OLD.transport_interrupted_at IS NULL OR NEW.transport_interrupted_at IS NOT DISTINCT FROM OLD.transport_interrupted_at)
   AND (NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at OR OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL AND NEW.finished_at<=clock_timestamp())
   AND (NEW.transport_interrupted_at IS NOT DISTINCT FROM OLD.transport_interrupted_at OR OLD.transport_interrupted_at IS NULL AND NEW.transport_interrupted_at IS NOT NULL AND NEW.transport_interrupted_at<=clock_timestamp())
  THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='crm_ab_arm_v2' THEN
   IF s.created_xid<>pg_current_xact_id() THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT_IMMUTABLE';END IF;
   IF TG_OP='UPDATE' AND (to_jsonb(OLD)-'allocated_count') IS DISTINCT FROM (to_jsonb(NEW)-'allocated_count') THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT_IMMUTABLE';END IF;
   SELECT value INTO pin FROM jsonb_array_elements(s.scope->'bindings') WHERE value->>'arm'=NEW.arm;
   IF pin IS NULL OR pin->'campaign_id' IS DISTINCT FROM to_jsonb(NEW.campaign_id) OR pin->>'campaign_version' IS DISTINCT FROM NEW.campaign_version
    OR NEW.list_id IS NOT NULL OR NEW.finished_at IS NOT NULL OR NEW.transport_interrupted_at IS NOT NULL
   THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT';END IF;
  ELSE
   IF TG_OP='INSERT' THEN
    IF s.created_xid<>pg_current_xact_id() OR NEW.revoked_at IS NOT NULL OR NEW.revoked_reason IS NOT NULL THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT_IMMUTABLE';END IF;
   ELSE
    IF (to_jsonb(OLD)-ARRAY['revoked_at','revoked_reason']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['revoked_at','revoked_reason'])
     OR NEW.revoked_at IS NULL OR OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason)
    THEN RAISE EXCEPTION 'AB_AUDIENCE_ASSIGNMENT_IMMUTABLE';END IF;
   END IF;
  END IF;
  RETURN NEW;
 END $fn$$replacement$;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION crm_audience_v2.ab_experiment_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.ab_scope WHERE test_id=OLD.test_id) THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AB_AUDIENCE_SCOPE_IMMUTABLE';END IF;

  IF (to_jsonb(NEW)-ARRAY['state','version','window_start','window_end','transport_bound','tracking_continuous','source_complete','transport_interrupted_at','transport_interruption'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','window_start','window_end','transport_bound','tracking_continuous','source_complete','transport_interrupted_at','transport_interruption'])
  THEN RAISE EXCEPTION 'AB_AUDIENCE_SCOPE_IMMUTABLE';END IF;
  IF NEW.state='scheduled' OR NEW.transport_bound THEN
   IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.ab_regular_pair WHERE test_id=NEW.test_id) THEN RAISE EXCEPTION 'AB_AUDIENCE_SHADOW_ONLY'; END IF;
   IF OLD.state='prepared' AND NEW.state='scheduled' THEN
    IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.ab_regular_pair p WHERE p.test_id=NEW.test_id AND p.admitted_xid=pg_current_xact_id()
      AND (SELECT count(*) FROM public.campaigns WHERE id IN(p.campaign_a,p.campaign_b) AND status::text='scheduled' AND sent=0 AND started_at IS NULL)=2)
     OR NEW.version<>OLD.version+1 OR NOT NEW.transport_bound OR NOT NEW.source_complete OR NOT NEW.tracking_continuous THEN
     RAISE EXCEPTION 'AB_REGULAR_SCHEDULE_REQUIRED'; END IF;
   ELSE
    IF OLD.state<>'scheduled' OR NOT OLD.transport_bound OR NOT NEW.transport_bound
     OR NEW.window_start IS DISTINCT FROM OLD.window_start OR NEW.window_end IS DISTINCT FROM OLD.window_end
     OR NOT OLD.tracking_continuous AND NEW.tracking_continuous OR NOT OLD.source_complete AND NEW.source_complete
     OR OLD.transport_interrupted_at IS NOT NULL AND (NEW.transport_interrupted_at IS DISTINCT FROM OLD.transport_interrupted_at OR NEW.transport_interruption IS DISTINCT FROM OLD.transport_interruption)
     OR NEW.state NOT IN('scheduled','cancelled','closed') THEN RAISE EXCEPTION 'AB_REGULAR_STATE'; END IF;
    IF NEW.state='scheduled' AND NEW.version<>OLD.version OR NEW.state<>OLD.state AND NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'AB_REGULAR_VERSION'; END IF;
    IF NEW.state='cancelled' AND (SELECT count(*) FROM public.campaigns c JOIN public.crm_ab_arm_v2 a ON a.campaign_id=c.id WHERE a.test_id=NEW.test_id AND c.status::text='cancelled' AND c.sent=0 AND c.started_at IS NULL)<>2 THEN RAISE EXCEPTION 'AB_REGULAR_CANCEL_REQUIRED'; END IF;
    IF NEW.state='closed' AND (NEW.window_end>clock_timestamp()
     OR (SELECT count(*) FROM public.campaigns c JOIN public.crm_ab_arm_v2 a ON a.campaign_id=c.id WHERE a.test_id=NEW.test_id AND c.status::text='finished' AND a.finished_at IS NOT NULL)<>2
     OR EXISTS(SELECT 1 FROM public.shrigma_email_dispatch d JOIN public.crm_ab_arm_v2 a ON d.piece='audience-regular-v1:'||a.campaign_id::text WHERE a.test_id=NEW.test_id AND d.flow='campaign' AND d.transport_state IN('in_flight','outcome_unknown'))) THEN RAISE EXCEPTION 'AB_REGULAR_CLOSE_UNAVAILABLE'; END IF;
   END IF;
  END IF;
  RETURN NEW;
 END $fn$$replacement$;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION public.crm_ab_campaign_guard_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE e public.crm_ab_experiment_v2%ROWTYPE;allowed boolean;
 runtime_fields text[]:=ARRAY['status','sent','to_send','last_subscriber_id','max_subscriber_id','started_at','updated_at'];
BEGIN
 SELECT x.* INTO e FROM public.crm_ab_experiment_v2 x JOIN public.crm_ab_arm_v2 a ON a.test_id=x.test_id WHERE a.campaign_id=OLD.id;
 IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_FROZEN';END IF;
 IF EXISTS(SELECT 1 FROM crm_audience_v2.ab_scope WHERE test_id=e.test_id) THEN
  IF (to_jsonb(OLD)-runtime_fields) IS DISTINCT FROM (to_jsonb(NEW)-runtime_fields) THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_FROZEN'; END IF;
  IF OLD.status::text='draft' AND NEW.status::text='scheduled' THEN
   IF NOT EXISTS(SELECT 1 FROM crm_audience_v2.ab_regular_pair p WHERE p.test_id=e.test_id AND p.admitted_xid=pg_current_xact_id()
    AND (SELECT count(*) FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id IN(p.campaign_a,p.campaign_b) AND enabled AND NOT suspended)=2) THEN RAISE EXCEPTION 'AB_REGULAR_PAIR_ADMISSION_REQUIRED'; END IF;
   RETURN NEW;
  END IF;
  -- Preserve cancellation of a prepared pair through the existing coordinator.
  IF e.state='prepared' AND OLD.status::text='draft' AND NEW.status::text='cancelled'
   AND EXISTS(SELECT 1 FROM crm_audience_v2.ab_regular_lifecycle_intent WHERE test_id=e.test_id AND action='cancel' AND version=e.version AND created_xid=pg_current_xact_id())
   AND OLD.sent=0 AND OLD.started_at IS NULL THEN RETURN NEW; END IF;
  IF e.state='prepared' AND (to_jsonb(OLD)-'updated_at') IS DISTINCT FROM (to_jsonb(NEW)-'updated_at') THEN RAISE EXCEPTION 'AB_V2_SCHEDULE_REQUIRED'; END IF;
  IF e.state<>'prepared' AND NOT EXISTS(SELECT 1 FROM crm_audience_v2.ab_regular_pair WHERE test_id=e.test_id) THEN RAISE EXCEPTION 'AB_REGULAR_PAIR_ADMISSION_REQUIRED'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    OLD.status::text='scheduled' AND NEW.status::text='running' AND e.state='scheduled' AND OLD.send_at<=clock_timestamp()
    OR OLD.status::text IN('scheduled','running','paused') AND NEW.status::text IN('paused','cancelled')
    OR OLD.status::text='running' AND NEW.status::text='finished') THEN RAISE EXCEPTION 'AB_V2_SCHEDULE_REQUIRED'; END IF;
  IF NEW.status::text='finished' AND OLD.status::text<>'finished' THEN
   UPDATE public.crm_ab_arm_v2 SET finished_at=clock_timestamp() WHERE campaign_id=OLD.id AND finished_at IS NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status::text IN('paused','cancelled') AND e.state='scheduled' THEN
   UPDATE public.crm_ab_arm_v2 SET transport_interrupted_at=clock_timestamp() WHERE campaign_id=OLD.id AND transport_interrupted_at IS NULL;
  END IF;
  RETURN NEW;
 END IF;
 -- Only the atomic A/B scheduler may change draft->scheduled. Its operation and
 -- native-build receipt are separate prerequisites, never a campaign-editor marker.
 allowed:=current_setting('shrigma.ab_schedule_v2',true)=e.test_id::text AND (
  EXISTS(SELECT 1 FROM public.crm_ab_runtime_v2 WHERE singleton AND enabled) OR
  (NEW.status::text='cancelled' AND OLD.sent=0 AND OLD.started_at IS NULL AND
   (OLD.status::text='draft' OR OLD.status::text='scheduled' AND OLD.send_at>clock_timestamp())));
 IF allowed THEN RETURN NEW;END IF;
 IF (to_jsonb(OLD)-runtime_fields) IS DISTINCT FROM (to_jsonb(NEW)-runtime_fields) THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_FROZEN';END IF;
 IF e.state='prepared' AND (to_jsonb(OLD)-'updated_at') IS DISTINCT FROM (to_jsonb(NEW)-'updated_at') THEN RAISE EXCEPTION 'AB_V2_SCHEDULE_REQUIRED';END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  (OLD.status::text='scheduled' AND NEW.status::text='running' AND e.state='scheduled' AND OLD.send_at<=clock_timestamp()) OR
  (OLD.status::text IN ('running','scheduled','paused') AND NEW.status::text IN ('paused','cancelled')) OR
  (OLD.status::text='paused' AND NEW.status::text IN ('running','scheduled') AND e.state='scheduled' AND OLD.send_at<=clock_timestamp()) OR
  (OLD.status::text='running' AND NEW.status::text='finished')) THEN RAISE EXCEPTION 'AB_V2_SCHEDULE_REQUIRED';END IF;
 IF NEW.status::text='finished' AND OLD.status::text<>'finished' THEN
  UPDATE public.crm_ab_arm_v2 SET finished_at=clock_timestamp() WHERE campaign_id=OLD.id;
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status::text IN ('paused','cancelled') AND e.state='scheduled' THEN
  -- The worker already holds its campaign row. Write arm evidence rather than
  -- acquiring the experiment row in the reverse order of the coordinator.
  UPDATE public.crm_ab_arm_v2 SET transport_interrupted_at=clock_timestamp()
   WHERE campaign_id=OLD.id AND transport_interrupted_at IS NULL AND e.window_end>clock_timestamp();
 END IF;
 RETURN NEW;
END $$$replacement$;
 EXECUTE $replacement$CREATE OR REPLACE FUNCTION crm_audience_v2.campaign_send_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE brand text;ctl crm_audience_v2.regular_delivery_campaign%ROWTYPE;
 deployment crm_audience_v2.regular_worker_deployment%ROWTYPE;lease crm_audience_v2.regular_worker_lease%ROWTYPE;
 ctx jsonb;at timestamptz;
 progress text[]:=ARRAY['status','sent','to_send','max_subscriber_id','last_subscriber_id','started_at','updated_at'];
 BEGIN
  SELECT b.brand INTO brand FROM crm_audience_v2.campaign_binding b WHERE b.campaign_id=OLD.id;
  IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW; END IF;
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id
   OR NEW.type::text IS DISTINCT FROM 'regular' OR NEW.messenger IS DISTINCT FROM 'email'
   OR NEW.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
   OR NEW.attribs#>>'{crm,brand}' IS DISTINCT FROM brand THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_OPERATION_REQUIRED';
  END IF;
  -- Preserve draft editing under the existing campaign editor guard. A change
  -- invalidates any previously captured material; it never refreshes approval.
  IF OLD.status::text='draft' AND NEW.status::text='draft' THEN
   IF NEW.sent IS DISTINCT FROM 0 OR NEW.started_at IS NOT NULL
    OR NEW.last_subscriber_id IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'SEGMENT_CAMPAIGN_OPERATION_REQUIRED'; END IF;
   RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-progress) IS DISTINCT FROM (to_jsonb(OLD)-progress) THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_MATERIAL_LOCKED';
  END IF;
  IF OLD.status::text='draft' AND NEW.status::text='cancelled'
   AND (to_jsonb(NEW)-ARRAY['status','updated_at'])=(to_jsonb(OLD)-ARRAY['status','updated_at'])
   AND EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 a JOIN public.crm_ab_experiment_v2 x ON x.test_id=a.test_id
    JOIN crm_audience_v2.ab_regular_lifecycle_intent i ON i.test_id=x.test_id AND i.version=x.version
    WHERE a.campaign_id=OLD.id AND x.state='prepared' AND i.action='cancel' AND i.created_xid=pg_current_xact_id()) THEN RETURN NEW; END IF;
  -- Halt is always possible, including when source, lease or control is lost.
  -- It cannot acknowledge recipients or alter count/max/start metadata.
  IF OLD.status::text IN('scheduled','running','paused') AND NEW.status::text IN('paused','cancelled')
   AND (to_jsonb(NEW)-ARRAY['status','updated_at'])=(to_jsonb(OLD)-ARRAY['status','updated_at']) THEN
   UPDATE crm_audience_v2.regular_delivery_campaign SET suspended=true WHERE campaign_id=OLD.id;
   RETURN NEW;
  END IF;
  SELECT * INTO ctl FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=OLD.id;
  IF NOT FOUND OR NEW.sent IS DISTINCT FROM ctl.acknowledged_sent
   OR NEW.last_subscriber_id IS DISTINCT FROM ctl.acknowledged_subscriber_id THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_RECEIPT_REQUIRED';
  END IF;
  -- Only private claim/finish/recovery can move that checkpoint. Legacy batch
  -- and cleanup updates cannot create progress by assigning native counters.
  -- Record completed history even after OFF/pause without creating authority.
  IF NEW.status=OLD.status AND NEW.to_send IS NOT DISTINCT FROM OLD.to_send
   AND NEW.max_subscriber_id IS NOT DISTINCT FROM OLD.max_subscriber_id
   AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at THEN RETURN NEW; END IF;
  IF NOT ctl.enabled OR ctl.suspended OR ctl.material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(OLD.id)
   OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding b WHERE b.campaign_id=OLD.id
    AND b.binding_version=ctl.binding_version AND b.binding_hash=ctl.binding_hash) THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_OPERATION_UNAVAILABLE';
  END IF;
  -- Do not acquire deployment/lease row locks after the native campaign lock.
  -- The admission and SMTP paths own their stronger, ordered transaction locks.
  -- This trigger checks lifecycle state; it never authorizes transport.
  SELECT * INTO deployment FROM crm_audience_v2.regular_worker_deployment WHERE singleton;
  SELECT * INTO lease FROM crm_audience_v2.regular_worker_lease WHERE singleton;
  at:=clock_timestamp();
  IF deployment.singleton IS NULL OR NOT deployment.enabled OR deployment.approved_at>at
   OR deployment.worker_sha256 IS DISTINCT FROM ctl.worker_sha256
   OR deployment.runtime_sha256 IS DISTINCT FROM ctl.runtime_sha256
   OR lease.instance_id IS NULL OR lease.suspended OR lease.heartbeat_at>at OR lease.expires_at<=at
   OR lease.worker_sha256 IS DISTINCT FROM ctl.worker_sha256 OR lease.runtime_sha256 IS DISTINCT FROM ctl.runtime_sha256
   OR lease.database_role IS DISTINCT FROM deployment.database_role THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_WORKER_UNAVAILABLE';
  END IF;
  ctx:=crm_audience_v2.selection_worker_context(OLD.id);
  IF ctx->'bound' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'SEGMENT_CAMPAIGN_OPERATION_UNAVAILABLE'; END IF;
  IF OLD.status::text='draft' AND NEW.status::text='scheduled'
   AND NEW.sent=0 AND NEW.last_subscriber_id=0 AND NEW.started_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.status::text IN('scheduled','running') AND NEW.status::text='running' AND OLD.send_at<=at THEN RETURN NEW; END IF;
  IF OLD.status::text='paused' AND NEW.status::text='scheduled' THEN RETURN NEW; END IF;
  IF OLD.status::text='running' AND NEW.status::text='finished' THEN
   IF EXISTS(SELECT 1 FROM public.shrigma_email_dispatch d WHERE d.flow='campaign'
    AND d.piece='audience-regular-v1:'||OLD.id::text AND d.transport_state IN('in_flight','outcome_unknown'))
    OR EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.list_id=(ctx->>'base_list_id')::integer
     AND sl.subscriber_id>NEW.last_subscriber_id AND sl.subscriber_id<=NEW.max_subscriber_id
     AND crm_audience_v2.selection_regular_matches(ctx,sl.subscriber_id)) THEN
    RAISE EXCEPTION 'SEGMENT_CAMPAIGN_FINALIZE_UNAVAILABLE';
   END IF;
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SEGMENT_CAMPAIGN_OPERATION_REQUIRED';
 END
 $fn$$replacement$;
END $extend$;
