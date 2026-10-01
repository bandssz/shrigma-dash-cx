-- Private candidate: no grants, no policy activation and no scheduling at install.
-- API role is allowed only reviewed functions/table operations in a later grant.
CREATE TABLE crm_audience_v2.regular_sender_policy(
 brand text PRIMARY KEY CHECK(brand IN('fish','aristo')),
 envelope_from text NOT NULL CHECK(envelope_from ~ '^[^ <>@[:cntrl:]]+@[^ <>@[:cntrl:]]+$'),
 account_id text NOT NULL CHECK(account_id ~ '^[0-9]{12}$'),
 region text NOT NULL CHECK(region ~ '^[a-z0-9-]+$'),
 configuration_set text NOT NULL CHECK(configuration_set ~ '^[A-Za-z0-9_-]+$'),
 enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE crm_audience_v2.regular_admission_review(
 id uuid PRIMARY KEY,actor text NOT NULL,brand text NOT NULL CHECK(brand IN('fish','aristo')),
 campaign_id integer NOT NULL REFERENCES public.campaigns(id),campaign_version text NOT NULL,
 binding_version integer NOT NULL,binding_hash text NOT NULL,
 material jsonb NOT NULL,material_hash text NOT NULL CHECK(material_hash ~ '^[0-9a-f]{64}$'),
 runtime jsonb NOT NULL,eligible_count integer NOT NULL CHECK(eligible_count>0),
 checked_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 CHECK(expires_at>checked_at AND expires_at<=checked_at+interval '60 seconds')
);
CREATE TABLE crm_audience_v2.regular_admission_request(
 actor text NOT NULL,operation_key text NOT NULL,brand text NOT NULL,
 payload jsonb NOT NULL,payload_hash text NOT NULL,response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor,operation_key)
);
REVOKE ALL ON crm_audience_v2.regular_sender_policy,crm_audience_v2.regular_admission_review,crm_audience_v2.regular_admission_request FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.regular_admission_runtime(b text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE d crm_audience_v2.regular_worker_deployment%ROWTYPE;l crm_audience_v2.regular_worker_lease%ROWTYPE;
 p crm_audience_v2.regular_sender_policy%ROWTYPE;at timestamptz;
 BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
   OR NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout' AND setting::integer BETWEEN 1 AND 30000) THEN RAISE EXCEPTION 'REGULAR_ADMISSION_BOUNDARY'; END IF;
  SELECT * INTO d FROM crm_audience_v2.regular_worker_deployment WHERE singleton FOR SHARE;
  SELECT * INTO l FROM crm_audience_v2.regular_worker_lease WHERE singleton FOR SHARE;
  SELECT * INTO p FROM crm_audience_v2.regular_sender_policy WHERE brand=b FOR SHARE;
  at:=clock_timestamp();
  IF d.singleton IS NULL OR NOT d.enabled OR d.approved_at>at OR l.instance_id IS NULL OR l.suspended
   OR l.heartbeat_at>at OR l.expires_at<=at OR l.worker_sha256 IS DISTINCT FROM d.worker_sha256
   OR l.runtime_sha256 IS DISTINCT FROM d.runtime_sha256 OR l.database_role IS DISTINCT FROM d.database_role
   OR p.brand IS NULL OR NOT p.enabled THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='REGULAR_ADMISSION_WORKER_UNAVAILABLE'; END IF;
  RETURN jsonb_build_object('worker_sha256',d.worker_sha256,'runtime_sha256',d.runtime_sha256,'query_sha256',d.query_sha256,
   'envelope_from',p.envelope_from,'account_id',p.account_id,'region',p.region,'configuration_set',p.configuration_set);
 END
$fn$;

CREATE FUNCTION crm_audience_v2.regular_admission_snapshot(cid integer) RETURNS text
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO, YMD' SET lock_timeout='500ms' AS $fn$
 DECLARE c public.campaigns%ROWTYPE;doc jsonb;child regclass;
 BEGIN
  SELECT * INTO c FROM public.campaigns WHERE id=cid FOR UPDATE;
  IF NOT FOUND OR c.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
   OR c.attribs#>>'{crm,brand}' IS NULL OR c.attribs#>>'{crm,brand}' NOT IN('fish','aristo') OR c.status::text<>'draft'
   OR c.sent<>0 OR c.last_subscriber_id<>0 OR c.started_at IS NOT NULL THEN RAISE EXCEPTION 'REGULAR_ADMISSION_CAMPAIGN'; END IF;
  -- Immediate, validated FKs ensure that the campaign lock also fences new
  -- relation rows. Existing relations and complete dependencies are locked.
  FOREACH child IN ARRAY ARRAY['public.campaign_lists'::regclass,'public.campaign_media'::regclass] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=child AND k.confrelid='public.campaigns'::regclass
    AND k.contype='f' AND k.convalidated AND NOT k.condeferrable
    AND k.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=child AND attname='campaign_id')]::smallint[]
    AND k.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.campaigns'::regclass AND attname='id')]::smallint[]
    AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgconstraint=k.oid AND t.tgenabled NOT IN('O','A'))
    AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgconstraint=k.oid AND t.tgrelid=child AND t.tgisinternal AND (t.tgtype & 4)=4 AND t.tgenabled IN('O','A'))
    AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgconstraint=k.oid AND t.tgrelid=child AND t.tgisinternal AND (t.tgtype & 16)=16 AND t.tgenabled IN('O','A'))) THEN
    RAISE EXCEPTION 'REGULAR_ADMISSION_FOREIGN_KEYS';
   END IF;
  END LOOP;
  PERFORM 1 FROM public.campaign_lists WHERE campaign_id=cid ORDER BY list_id FOR SHARE;
  PERFORM 1 FROM public.campaign_media WHERE campaign_id=cid ORDER BY media_id FOR SHARE;
  PERFORM crm_audience_v2.lock_campaign_dependencies(cid);
  doc:=crm_audience_v2.regular_delivery_material(cid);
  doc:=jsonb_set(doc,'{campaign}',to_jsonb(c));
  IF octet_length(doc::text)>8388608 THEN RAISE EXCEPTION 'REGULAR_ADMISSION_SIZE'; END IF;
  RETURN doc::text;
 END
$fn$;

CREATE FUNCTION crm_audience_v2.regular_admission_schedule(rid uuid,actor_id text) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
 DECLARE r crm_audience_v2.regular_admission_review%ROWTYPE;c public.campaigns%ROWTYPE;
 rt jsonb;ctx jsonb;prior_writer text;
 BEGIN
  SELECT * INTO STRICT r FROM crm_audience_v2.regular_admission_review WHERE id=rid AND actor=actor_id;
  rt:=crm_audience_v2.regular_admission_runtime(r.brand);
  SELECT * INTO STRICT c FROM public.campaigns WHERE id=r.campaign_id FOR UPDATE;
  PERFORM crm_audience_v2.regular_admission_snapshot(c.id);
  PERFORM 1 FROM crm_audience_v2.campaign_binding_effective(c.id);
  PERFORM 1 FROM crm_audience_v2.config WHERE brand=r.brand FOR SHARE;
  PERFORM 1 FROM crm_audience_v2.audience a JOIN LATERAL crm_audience_v2.campaign_binding_effective(c.id) b ON b.audience_id=a.id FOR SHARE OF a;
  IF r.expires_at<=clock_timestamp() OR r.checked_at>clock_timestamp() OR rt IS DISTINCT FROM r.runtime
   OR r.material IS DISTINCT FROM crm_audience_v2.regular_delivery_material(c.id)
   OR public.shrigma_campaign_current(c.id)->>'version' IS DISTINCT FROM r.campaign_version
   OR c.send_at IS NULL OR c.send_at<clock_timestamp()+interval '15 minutes'
   OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding_effective(c.id) b WHERE b.brand=r.brand
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
$fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.regular_admission_runtime(text),crm_audience_v2.regular_admission_snapshot(integer),crm_audience_v2.regular_admission_schedule(uuid,text) FROM PUBLIC;
