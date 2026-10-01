-- Candidate only. Adds a cache identity guard for graph-owned /api/tx sends.
-- Installs OFF and does not create an epoch, control, dispatch or send.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

DO $install$
BEGIN
  IF current_setting('server_version_num')::integer < 170000
     OR to_regclass('crm_graph_candidate.native_template_v1') IS NULL
     OR to_regclass('crm_graph_candidate.cart_delivery_v1') IS NULL
     OR to_regclass('public.templates') IS NULL
     OR to_regclass('public.shrigma_email_dispatch') IS NULL
     OR to_regprocedure('crm_graph_candidate.native_clone_check_v1(crm_graph_candidate.native_template_v1,integer)') IS NULL
  THEN
    RAISE EXCEPTION 'GRAPH_CACHE_IDENTITY_DEPENDENCY';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relnamespace = 'crm_graph_candidate'::regnamespace
      AND relname IN ('cache_identity_deployment_v1','cache_identity_lease_v1','cache_identity_snapshot_v1')
  ) OR EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'crm_graph_candidate'::regnamespace
      AND proname IN ('cache_identity_content_v1','cache_identity_expected_v1','cache_identity_heartbeat_v1',
                      'cache_identity_issue_v1','cache_identity_consume_v1','cache_identity_readiness_v1')
  ) THEN
    RAISE EXCEPTION 'GRAPH_CACHE_IDENTITY_COLLISION';
  END IF;
  IF (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc
      WHERE oid='crm_graph_candidate.cart_immutable_v1()'::regprocedure)
     IS DISTINCT FROM 'a03dc95d1acff46c78638c3f96f585bc'
  THEN
    RAISE EXCEPTION 'GRAPH_CACHE_IDENTITY_CART_DRIFT';
  END IF;
END
$install$;

CREATE TABLE crm_graph_candidate.cache_identity_deployment_v1 (
  cache_target text PRIMARY KEY CHECK (cache_target ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  enabled boolean NOT NULL DEFAULT false,
  executable_sha256 text NOT NULL CHECK (executable_sha256 ~ '^[a-f0-9]{64}$'),
  runtime_sha256 text NOT NULL CHECK (runtime_sha256 ~ '^[a-f0-9]{64}$'),
  expected_role text NOT NULL CHECK (expected_role ~ '^[a-z_][a-z0-9_]{0,62}$'),
  heartbeat_seconds integer NOT NULL DEFAULT 20 CHECK (heartbeat_seconds BETWEEN 5 AND 30),
  lease_seconds integer NOT NULL DEFAULT 60 CHECK (lease_seconds BETWEEN 15 AND 120),
  action_key uuid NOT NULL DEFAULT gen_random_uuid(),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (lease_seconds >= heartbeat_seconds * 2)
);

CREATE TABLE crm_graph_candidate.cache_identity_lease_v1 (
  cache_target text PRIMARY KEY REFERENCES crm_graph_candidate.cache_identity_deployment_v1(cache_target),
  instance_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  executable_sha256 text NOT NULL CHECK (executable_sha256 ~ '^[a-f0-9]{64}$'),
  runtime_sha256 text NOT NULL CHECK (runtime_sha256 ~ '^[a-f0-9]{64}$'),
  checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  suspended_at timestamptz,
  suspended_reason text CHECK (suspended_reason IS NULL OR suspended_reason IN ('concurrent_instance','identity_drift','cache_drift','template_set_drift')),
  CHECK ((suspended_at IS NULL) = (suspended_reason IS NULL)),
  CHECK (expires_at > checked_at)
);

CREATE TABLE crm_graph_candidate.cache_identity_snapshot_v1 (
  cache_target text NOT NULL REFERENCES crm_graph_candidate.cache_identity_deployment_v1(cache_target),
  template_id integer NOT NULL REFERENCES public.templates(id),
  instance_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  native_sha256 text NOT NULL CHECK (native_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  checked_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (cache_target, template_id),
  CHECK (expires_at > checked_at)
);

ALTER TABLE crm_graph_candidate.cart_delivery_v1
  ADD COLUMN cache_instance_id uuid,
  ADD COLUMN cache_snapshot_sha256 text CHECK (cache_snapshot_sha256 IS NULL OR cache_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN cache_action_token_sha256 text CHECK (cache_action_token_sha256 IS NULL OR cache_action_token_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN cache_action_expires_at timestamptz,
  ADD COLUMN cache_action_consumed_at timestamptz,
  ADD CONSTRAINT graph_cart_cache_action_shape CHECK (
    (cache_instance_id IS NULL AND cache_snapshot_sha256 IS NULL AND cache_action_token_sha256 IS NULL
      AND cache_action_expires_at IS NULL AND cache_action_consumed_at IS NULL)
    OR
    (cache_instance_id IS NOT NULL AND cache_snapshot_sha256 IS NOT NULL AND cache_action_token_sha256 IS NOT NULL
      AND cache_action_expires_at IS NOT NULL AND (cache_action_consumed_at IS NULL OR cache_action_consumed_at <= cache_action_expires_at))
  );

CREATE OR REPLACE FUNCTION crm_graph_candidate.cart_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $f$
BEGIN
  IF TG_TABLE_NAME='cart_epoch_v1' THEN
    IF TG_OP='UPDATE' AND OLD.ends_at IS NULL AND NEW.ends_at IS NOT NULL
       AND NEW.ends_at>=OLD.starts_at AND to_jsonb(NEW)-'ends_at'=to_jsonb(OLD)-'ends_at' THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME='cart_delivery_v1' AND TG_OP='UPDATE' THEN
    IF OLD.cache_action_token_sha256 IS NULL AND OLD.cache_action_consumed_at IS NULL
       AND NEW.cache_instance_id IS NOT NULL AND NEW.cache_snapshot_sha256 IS NOT NULL
       AND NEW.cache_action_token_sha256 IS NOT NULL AND NEW.cache_action_expires_at IS NOT NULL
       AND NEW.cache_action_consumed_at IS NULL
       AND to_jsonb(NEW)-ARRAY['cache_instance_id','cache_snapshot_sha256','cache_action_token_sha256','cache_action_expires_at','cache_action_consumed_at']
           =to_jsonb(OLD)-ARRAY['cache_instance_id','cache_snapshot_sha256','cache_action_token_sha256','cache_action_expires_at','cache_action_consumed_at']
    THEN RETURN NEW; END IF;
    IF OLD.cache_action_token_sha256 IS NOT NULL AND OLD.cache_action_consumed_at IS NULL
       AND NEW.cache_action_consumed_at IS NOT NULL
       AND to_jsonb(NEW)-'cache_action_consumed_at'=to_jsonb(OLD)-'cache_action_consumed_at'
    THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'GRAPH_CART_IMMUTABLE';
END
$f$;

CREATE FUNCTION crm_graph_candidate.cache_identity_content_v1(t text,s text,b text,bs text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $f$
  SELECT jsonb_build_object('type',t,'subject',s,'body',b,'body_source',to_jsonb(bs))
$f$;

CREATE FUNCTION crm_graph_candidate.cache_identity_expected_v1(target text) RETURNS TABLE(template_id integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,crm_graph_candidate AS $f$
  SELECT n.clone_template_id
  FROM crm_graph_candidate.cache_identity_deployment_v1 d
  JOIN crm_graph_candidate.native_template_v1 n ON n.cache_target=d.cache_target
  WHERE d.cache_target=target AND d.enabled AND n.state='ready' AND n.clone_template_id IS NOT NULL
  ORDER BY n.clone_template_id
$f$;

CREATE FUNCTION crm_graph_candidate.cache_identity_heartbeat_v1(
  target text, instance uuid, token uuid, executable_sha text, runtime_sha text, snapshots jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE d crm_graph_candidate.cache_identity_deployment_v1%ROWTYPE;
        l crm_graph_candidate.cache_identity_lease_v1%ROWTYPE;
        n crm_graph_candidate.native_template_v1%ROWTYPE;
        item jsonb; local_content jsonb; db_content jsonb; snap_sha text;
        now_at timestamptz:=clock_timestamp(); until_at timestamptz; expected_count integer; seen_count integer:=0;
        seen_templates integer[]:='{}'::integer[];
BEGIN
  IF target IS NULL OR instance IS NULL OR token IS NULL OR executable_sha !~ '^[a-f0-9]{64}$'
     OR runtime_sha !~ '^[a-f0-9]{64}$' OR jsonb_typeof(snapshots) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'GRAPH_CACHE_HEARTBEAT_INPUT';
  END IF;
  SELECT * INTO d FROM crm_graph_candidate.cache_identity_deployment_v1 WHERE cache_target=target FOR UPDATE;
  IF NOT FOUND OR NOT d.enabled OR session_user::text IS DISTINCT FROM d.expected_role THEN
    RAISE EXCEPTION 'GRAPH_CACHE_DEPLOYMENT_DISABLED';
  END IF;
  IF d.executable_sha256 IS DISTINCT FROM executable_sha OR d.runtime_sha256 IS DISTINCT FROM runtime_sha THEN
    INSERT INTO crm_graph_candidate.cache_identity_lease_v1(cache_target,instance_id,lease_token,executable_sha256,runtime_sha256,checked_at,expires_at,suspended_at,suspended_reason)
    VALUES(target,instance,token,executable_sha,runtime_sha,now_at,now_at+make_interval(secs=>d.lease_seconds),now_at,'identity_drift')
    ON CONFLICT(cache_target) DO UPDATE SET suspended_at=excluded.suspended_at,suspended_reason=excluded.suspended_reason,checked_at=excluded.checked_at;
    RETURN jsonb_build_object('ready',false,'code','identity_drift');
  END IF;
  SELECT * INTO l FROM crm_graph_candidate.cache_identity_lease_v1 WHERE cache_target=target FOR UPDATE;
  IF FOUND AND l.suspended_at IS NOT NULL THEN RETURN jsonb_build_object('ready',false,'code',l.suspended_reason);END IF;
  IF FOUND AND l.expires_at>now_at AND (l.instance_id<>instance OR l.lease_token<>token) THEN
    UPDATE crm_graph_candidate.cache_identity_lease_v1 SET suspended_at=now_at,suspended_reason='concurrent_instance',checked_at=now_at WHERE cache_target=target;
    DELETE FROM crm_graph_candidate.cache_identity_snapshot_v1 WHERE cache_target=target;
    RETURN jsonb_build_object('ready',false,'code','concurrent_instance');
  END IF;
  SELECT count(*) INTO expected_count FROM crm_graph_candidate.native_template_v1
   WHERE cache_target=target AND state='ready' AND clone_template_id IS NOT NULL;
  IF expected_count=0 OR jsonb_array_length(snapshots)<>expected_count THEN
    INSERT INTO crm_graph_candidate.cache_identity_lease_v1(cache_target,instance_id,lease_token,executable_sha256,runtime_sha256,checked_at,expires_at,suspended_at,suspended_reason)
    VALUES(target,instance,token,executable_sha,runtime_sha,now_at,now_at+make_interval(secs=>d.lease_seconds),now_at,'template_set_drift')
    ON CONFLICT(cache_target) DO UPDATE SET suspended_at=excluded.suspended_at,suspended_reason=excluded.suspended_reason,checked_at=excluded.checked_at;
    DELETE FROM crm_graph_candidate.cache_identity_snapshot_v1 WHERE cache_target=target;
    RETURN jsonb_build_object('ready',false,'code','template_set_drift');
  END IF;
  until_at:=now_at+make_interval(secs=>d.lease_seconds);
  FOR item IN SELECT value FROM jsonb_array_elements(snapshots) x(value) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['template_id','type','subject','body','body_source']<>'{}'::jsonb
       OR (SELECT count(*) FROM jsonb_object_keys(item))<>5 OR coalesce(item->>'template_id','')!~'^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'GRAPH_CACHE_HEARTBEAT_INPUT';
    END IF;
    IF (item->>'template_id')::integer=ANY(seen_templates) THEN
      INSERT INTO crm_graph_candidate.cache_identity_lease_v1(cache_target,instance_id,lease_token,executable_sha256,runtime_sha256,checked_at,expires_at,suspended_at,suspended_reason)
      VALUES(target,instance,token,executable_sha,runtime_sha,now_at,until_at,now_at,'template_set_drift')
      ON CONFLICT(cache_target) DO UPDATE SET instance_id=excluded.instance_id,lease_token=excluded.lease_token,
        executable_sha256=excluded.executable_sha256,runtime_sha256=excluded.runtime_sha256,checked_at=excluded.checked_at,
        expires_at=excluded.expires_at,suspended_at=excluded.suspended_at,suspended_reason=excluded.suspended_reason;
      DELETE FROM crm_graph_candidate.cache_identity_snapshot_v1 WHERE cache_target=target;
      RETURN jsonb_build_object('ready',false,'code','template_set_drift');
    END IF;
    seen_templates:=array_append(seen_templates,(item->>'template_id')::integer);
    SELECT * INTO n FROM crm_graph_candidate.native_template_v1
     WHERE cache_target=target AND state='ready' AND clone_template_id=(item->>'template_id')::integer;
    IF NOT FOUND THEN
      UPDATE crm_graph_candidate.cache_identity_lease_v1 SET suspended_at=now_at,suspended_reason='template_set_drift',checked_at=now_at WHERE cache_target=target;
      DELETE FROM crm_graph_candidate.cache_identity_snapshot_v1 WHERE cache_target=target;
      RETURN jsonb_build_object('ready',false,'code','template_set_drift');
    END IF;
    local_content:=crm_graph_candidate.cache_identity_content_v1(item->>'type',item->>'subject',item->>'body',item->>'body_source');
    SELECT crm_graph_candidate.cache_identity_content_v1(t.type::text,t.subject,t.body,t.body_source) INTO db_content FROM public.templates t WHERE t.id=n.clone_template_id;
    IF local_content IS DISTINCT FROM n.snapshot OR db_content IS DISTINCT FROM n.snapshot THEN
      INSERT INTO crm_graph_candidate.cache_identity_lease_v1(cache_target,instance_id,lease_token,executable_sha256,runtime_sha256,checked_at,expires_at,suspended_at,suspended_reason)
      VALUES(target,instance,token,executable_sha,runtime_sha,now_at,until_at,now_at,'cache_drift')
      ON CONFLICT(cache_target) DO UPDATE SET suspended_at=excluded.suspended_at,suspended_reason=excluded.suspended_reason,checked_at=excluded.checked_at;
      DELETE FROM crm_graph_candidate.cache_identity_snapshot_v1 WHERE cache_target=target;
      RETURN jsonb_build_object('ready',false,'code','cache_drift');
    END IF;
    snap_sha:=encode(digest(convert_to(local_content::text,'UTF8'),'sha256'),'hex');
    INSERT INTO crm_graph_candidate.cache_identity_snapshot_v1(cache_target,template_id,instance_id,lease_token,native_sha256,snapshot_sha256,checked_at,expires_at)
    VALUES(target,n.clone_template_id,instance,token,n.native_sha256,snap_sha,now_at,until_at)
    ON CONFLICT(cache_target,template_id) DO UPDATE SET instance_id=excluded.instance_id,lease_token=excluded.lease_token,
      native_sha256=excluded.native_sha256,snapshot_sha256=excluded.snapshot_sha256,checked_at=excluded.checked_at,expires_at=excluded.expires_at;
    seen_count:=seen_count+1;
  END LOOP;
  INSERT INTO crm_graph_candidate.cache_identity_lease_v1(cache_target,instance_id,lease_token,executable_sha256,runtime_sha256,checked_at,expires_at)
  VALUES(target,instance,token,executable_sha,runtime_sha,now_at,until_at)
  ON CONFLICT(cache_target) DO UPDATE SET instance_id=excluded.instance_id,lease_token=excluded.lease_token,
    executable_sha256=excluded.executable_sha256,runtime_sha256=excluded.runtime_sha256,checked_at=excluded.checked_at,
    expires_at=excluded.expires_at,suspended_at=NULL,suspended_reason=NULL;
  RETURN jsonb_build_object('ready',true,'template_count',seen_count,'expires_at',until_at,'snapshots',
    (SELECT coalesce(jsonb_agg(jsonb_build_object('template_id',s.template_id,'snapshot_sha256',s.snapshot_sha256) ORDER BY s.template_id),'[]'::jsonb)
     FROM crm_graph_candidate.cache_identity_snapshot_v1 s
     WHERE s.cache_target=target AND s.instance_id=instance AND s.lease_token=token));
END
$f$;

CREATE FUNCTION crm_graph_candidate.cache_identity_issue_v1(b text,iid uuid,did uuid,target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE d crm_graph_candidate.cache_identity_deployment_v1%ROWTYPE;l crm_graph_candidate.cache_identity_lease_v1%ROWTYPE;
        cd crm_graph_candidate.cart_delivery_v1%ROWTYPE;o crm_graph_candidate.cart_owner_v1%ROWTYPE;ep crm_graph_candidate.cart_epoch_v1%ROWTYPE;n crm_graph_candidate.native_template_v1%ROWTYPE;
        s crm_graph_candidate.cache_identity_snapshot_v1%ROWTYPE;dispatch public.shrigma_email_dispatch%ROWTYPE;
        expires timestamptz; raw_token text; token_sha text;
BEGIN
  SELECT * INTO d FROM crm_graph_candidate.cache_identity_deployment_v1 WHERE cache_target=target FOR SHARE;
  IF NOT FOUND OR NOT d.enabled THEN RAISE EXCEPTION 'GRAPH_CACHE_DISABLED';END IF;
  SELECT * INTO cd FROM crm_graph_candidate.cart_delivery_v1 WHERE intent_id=iid AND brand=b AND dispatch_id=did FOR UPDATE;
  SELECT * INTO dispatch FROM public.shrigma_email_dispatch WHERE dispatch_id=did AND brand=b FOR SHARE;
  IF NOT FOUND OR dispatch.transport_state<>'in_flight' OR dispatch.claim_token IS NULL THEN RAISE EXCEPTION 'GRAPH_CACHE_DISPATCH_MISMATCH';END IF;
  SELECT * INTO o FROM crm_graph_candidate.cart_owner_v1 WHERE source_ref=cd.source_ref AND brand=b;
  SELECT * INTO ep FROM crm_graph_candidate.cart_epoch_v1 WHERE id=o.epoch_id AND brand=o.brand;
  SELECT * INTO n FROM crm_graph_candidate.native_template_v1 WHERE id=ep.native_id AND cache_target=target AND state='ready';
  SELECT * INTO l FROM crm_graph_candidate.cache_identity_lease_v1 WHERE cache_target=target FOR SHARE;
  SELECT * INTO s FROM crm_graph_candidate.cache_identity_snapshot_v1 WHERE cache_target=target AND template_id=n.clone_template_id FOR SHARE;
  IF cd.intent_id IS NULL OR n.id IS NULL OR l.cache_target IS NULL OR s.cache_target IS NULL OR l.suspended_at IS NOT NULL
     OR l.instance_id<>s.instance_id OR l.lease_token<>s.lease_token OR s.native_sha256<>n.native_sha256
     OR least(l.expires_at,s.expires_at)<=clock_timestamp()+interval '3 seconds' THEN RAISE EXCEPTION 'GRAPH_CACHE_NOT_READY';END IF;
  expires:=least(l.expires_at,s.expires_at,clock_timestamp()+interval '10 seconds');
  raw_token:=encode(hmac(convert_to(concat_ws('|',did::text,dispatch.claim_token::text,o.subscriber_id::text,l.instance_id::text,n.clone_template_id::text,n.native_sha256,s.snapshot_sha256,to_char(expires AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'UTF8'),convert_to(d.action_key::text,'UTF8'),'sha256'),'hex');
  token_sha:=encode(digest(convert_to(raw_token,'UTF8'),'sha256'),'hex');
  IF cd.cache_action_token_sha256 IS NULL THEN
    UPDATE crm_graph_candidate.cart_delivery_v1 SET cache_instance_id=l.instance_id,cache_snapshot_sha256=s.snapshot_sha256,
      cache_action_token_sha256=token_sha,cache_action_expires_at=expires WHERE intent_id=iid RETURNING * INTO cd;
  ELSIF cd.cache_instance_id<>l.instance_id OR cd.cache_snapshot_sha256<>s.snapshot_sha256 OR cd.cache_action_token_sha256<>token_sha
        OR cd.cache_action_expires_at<>expires OR cd.cache_action_consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'GRAPH_CACHE_ACTION_REPLAY';
  END IF;
  RETURN jsonb_build_object('contract','journey_graph_cache_guard_v1','cache_target',target,'instance_id',l.instance_id,
    'template_id',n.clone_template_id,'subscriber_id',o.subscriber_id,'native_sha256',n.native_sha256,'snapshot_sha256',s.snapshot_sha256,
    'dispatch_id',did,'token',raw_token,'expires_at',to_char(expires AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END
$f$;

CREATE FUNCTION crm_graph_candidate.cache_identity_consume_v1(g jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $f$
DECLARE d crm_graph_candidate.cache_identity_deployment_v1%ROWTYPE;l crm_graph_candidate.cache_identity_lease_v1%ROWTYPE;
        cd crm_graph_candidate.cart_delivery_v1%ROWTYPE;o crm_graph_candidate.cart_owner_v1%ROWTYPE;s crm_graph_candidate.cache_identity_snapshot_v1%ROWTYPE;
        n crm_graph_candidate.native_template_v1%ROWTYPE;dispatch public.shrigma_email_dispatch%ROWTYPE;
        db_content jsonb; expected text; now_at timestamptz; affected integer;
BEGIN
  IF jsonb_typeof(g) IS DISTINCT FROM 'object' OR g-ARRAY['contract','cache_target','instance_id','template_id','subscriber_id','native_sha256','snapshot_sha256','dispatch_id','token','expires_at']<>'{}'::jsonb
     OR (SELECT count(*) FROM jsonb_object_keys(g))<>10
     OR jsonb_typeof(g->'contract') IS DISTINCT FROM 'string' OR g->>'contract' IS DISTINCT FROM 'journey_graph_cache_guard_v1'
     OR jsonb_typeof(g->'cache_target') IS DISTINCT FROM 'string' OR coalesce(g->>'cache_target','')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR jsonb_typeof(g->'instance_id') IS DISTINCT FROM 'string' OR coalesce(g->>'instance_id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(g->'template_id') IS DISTINCT FROM 'number' OR coalesce(g->>'template_id','')!~'^[1-9][0-9]*$'
     OR jsonb_typeof(g->'subscriber_id') IS DISTINCT FROM 'number' OR coalesce(g->>'subscriber_id','')!~'^[1-9][0-9]*$'
     OR jsonb_typeof(g->'native_sha256') IS DISTINCT FROM 'string' OR coalesce(g->>'native_sha256','')!~'^[a-f0-9]{64}$'
     OR jsonb_typeof(g->'snapshot_sha256') IS DISTINCT FROM 'string' OR coalesce(g->>'snapshot_sha256','')!~'^[a-f0-9]{64}$'
     OR jsonb_typeof(g->'dispatch_id') IS DISTINCT FROM 'string' OR coalesce(g->>'dispatch_id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(g->'token') IS DISTINCT FROM 'string' OR coalesce(g->>'token','')!~'^[a-f0-9]{64}$'
     OR jsonb_typeof(g->'expires_at') IS DISTINCT FROM 'string' OR coalesce(g->>'expires_at','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  THEN RETURN false;END IF;
  SELECT * INTO d FROM crm_graph_candidate.cache_identity_deployment_v1 WHERE cache_target=g->>'cache_target' FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO l FROM crm_graph_candidate.cache_identity_lease_v1 WHERE cache_target=g->>'cache_target' FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO s FROM crm_graph_candidate.cache_identity_snapshot_v1 WHERE cache_target=g->>'cache_target' AND template_id=(g->>'template_id')::integer FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO cd FROM crm_graph_candidate.cart_delivery_v1 WHERE dispatch_id=(g->>'dispatch_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO o FROM crm_graph_candidate.cart_owner_v1 WHERE source_ref=cd.source_ref AND brand=cd.brand;
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO dispatch FROM public.shrigma_email_dispatch WHERE dispatch_id=cd.dispatch_id FOR SHARE;
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT * INTO n FROM crm_graph_candidate.native_template_v1 WHERE clone_template_id=s.template_id AND cache_target=s.cache_target AND state='ready';
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT crm_graph_candidate.cache_identity_content_v1(t.type::text,t.subject,t.body,t.body_source) INTO db_content FROM public.templates t WHERE t.id=s.template_id;
  IF NOT FOUND THEN RETURN false;END IF;
  now_at:=clock_timestamp();
  IF NOT d.enabled OR session_user::text IS DISTINCT FROM d.expected_role OR l.suspended_at IS NOT NULL
     OR l.instance_id::text IS DISTINCT FROM g->>'instance_id' OR l.instance_id<>s.instance_id OR l.lease_token<>s.lease_token
     OR s.snapshot_sha256 IS DISTINCT FROM g->>'snapshot_sha256' OR s.native_sha256 IS DISTINCT FROM g->>'native_sha256'
     OR n.native_sha256 IS DISTINCT FROM s.native_sha256 OR encode(digest(convert_to(db_content::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM s.snapshot_sha256
     OR o.subscriber_id::text IS DISTINCT FROM g->>'subscriber_id'
     OR cd.cache_instance_id IS NULL OR cd.cache_snapshot_sha256 IS NULL OR cd.cache_action_token_sha256 IS NULL OR cd.cache_action_expires_at IS NULL
     OR cd.cache_instance_id IS DISTINCT FROM l.instance_id OR cd.cache_snapshot_sha256 IS DISTINCT FROM s.snapshot_sha256 OR cd.cache_action_consumed_at IS NOT NULL
     OR dispatch.dispatch_id IS DISTINCT FROM cd.dispatch_id OR dispatch.brand IS DISTINCT FROM cd.brand
     OR dispatch.transport_state IS DISTINCT FROM 'in_flight' OR dispatch.claim_token IS NULL OR cd.cache_action_expires_at<=now_at
     OR g->>'expires_at' IS DISTINCT FROM to_char(cd.cache_action_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     OR l.expires_at<=now_at+interval '2 seconds' OR s.expires_at<=now_at+interval '2 seconds' THEN RETURN false;END IF;
  expected:=encode(hmac(convert_to(concat_ws('|',dispatch.dispatch_id::text,dispatch.claim_token::text,o.subscriber_id::text,l.instance_id::text,s.template_id::text,n.native_sha256,s.snapshot_sha256,to_char(cd.cache_action_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'UTF8'),convert_to(d.action_key::text,'UTF8'),'sha256'),'hex');
  IF encode(digest(convert_to(g->>'token','UTF8'),'sha256'),'hex') IS DISTINCT FROM cd.cache_action_token_sha256 OR expected IS DISTINCT FROM g->>'token' THEN RETURN false;END IF;
  now_at:=clock_timestamp();
  IF cd.cache_action_expires_at<=now_at OR l.expires_at<=now_at+interval '2 seconds' OR s.expires_at<=now_at+interval '2 seconds' THEN RETURN false;END IF;
  UPDATE crm_graph_candidate.cart_delivery_v1 SET cache_action_consumed_at=now_at
   WHERE intent_id=cd.intent_id AND cache_action_consumed_at IS NULL AND cache_action_expires_at>now_at;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN false;
END
$f$;

CREATE FUNCTION crm_graph_candidate.cache_identity_readiness_v1(target text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,crm_graph_candidate AS $f$
  SELECT jsonb_build_object('contract','journey_graph_cache_readiness_v1','cache_target',target,
    'ready',coalesce(d.enabled AND l.suspended_at IS NULL AND l.expires_at>clock_timestamp()+interval '3 seconds'
      AND (SELECT count(*) FROM crm_graph_candidate.cache_identity_snapshot_v1 s WHERE s.cache_target=target AND s.instance_id=l.instance_id AND s.lease_token=l.lease_token AND s.expires_at>clock_timestamp()+interval '3 seconds')
          =(SELECT count(*) FROM crm_graph_candidate.native_template_v1 n WHERE n.cache_target=target AND n.state='ready'),false),
    'checked_at',l.checked_at,'expires_at',l.expires_at)
  FROM crm_graph_candidate.cache_identity_deployment_v1 d LEFT JOIN crm_graph_candidate.cache_identity_lease_v1 l USING(cache_target)
  WHERE d.cache_target=target
$f$;

REVOKE ALL ON crm_graph_candidate.cache_identity_deployment_v1,crm_graph_candidate.cache_identity_lease_v1,crm_graph_candidate.cache_identity_snapshot_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_graph_candidate.cache_identity_content_v1(text,text,text,text),
  crm_graph_candidate.cache_identity_expected_v1(text),crm_graph_candidate.cache_identity_heartbeat_v1(text,uuid,uuid,text,text,jsonb),
  crm_graph_candidate.cache_identity_issue_v1(text,uuid,uuid,text),crm_graph_candidate.cache_identity_consume_v1(jsonb),
  crm_graph_candidate.cache_identity_readiness_v1(text) FROM PUBLIC;
DO $grant$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_audience_api') THEN
    GRANT EXECUTE ON FUNCTION crm_graph_candidate.cache_identity_readiness_v1(text) TO crm_audience_api;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_graph_worker') THEN
    GRANT EXECUTE ON FUNCTION crm_graph_candidate.cache_identity_issue_v1(text,uuid,uuid,text) TO crm_graph_worker;
  END IF;
END $grant$;

COMMIT;
