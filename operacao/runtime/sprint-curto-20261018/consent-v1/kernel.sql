-- PREPARATION ONLY: isolated native PG algorithm, not a production installer.
-- Actual custody/ACLs, v3 freezer/DTO and production relation proofs remain gates.
BEGIN;
DO $$BEGIN IF current_database()<>'consent_fixture' THEN RAISE EXCEPTION 'FIXTURE_DATABASE_REQUIRED';END IF;END$$;
ALTER TABLE crm_audience_v2.request ADD COLUMN crm_native_consent jsonb;

-- Original receipts remain immutable. Metadata is admitted only through a
-- nested native trigger and only an initial verified pin / append-only backup.
CREATE FUNCTION crm_audience_v2.consent_request_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE oldm jsonb:=OLD.crm_native_consent;newm jsonb;item record;
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'AUDIENCE_HISTORY_IMMUTABLE';END IF;
 newm:=NEW.crm_native_consent;
 IF pg_trigger_depth()<>2 OR oldm IS NULL OR newm IS NULL
  OR to_jsonb(NEW)-'crm_native_consent' IS DISTINCT FROM to_jsonb(OLD)-'crm_native_consent'
  OR oldm->>'schema' IS DISTINCT FROM 'crm-native-consent-v1'
  OR newm-ARRAY['pin','events'] IS DISTINCT FROM oldm-ARRAY['pin','events']
  OR jsonb_typeof(newm->'events') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'AUDIENCE_HISTORY_IMMUTABLE';END IF;
 IF oldm->'pin'<>'null'::jsonb AND newm->'pin' IS DISTINCT FROM oldm->'pin'
 THEN RAISE EXCEPTION 'CONSENT_PIN_IMMUTABLE';END IF;
 FOR item IN SELECT * FROM jsonb_each(oldm->'events') LOOP
  IF newm#>ARRAY['events',item.key] IS DISTINCT FROM item.value THEN RAISE EXCEPTION 'CONSENT_BACKUP_IMMUTABLE';END IF;
 END LOOP;
 RETURN NEW;
END$$;
DROP TRIGGER request_append_only ON crm_audience_v2.request;
CREATE TRIGGER request_append_only BEFORE UPDATE OR DELETE ON crm_audience_v2.request FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.consent_request_guard_v1();

CREATE FUNCTION crm_audience_v2.consent_member_state_sha256_v1(lid integer) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('id',subscriber_id,'status',status::text,'meta',meta) ORDER BY subscriber_id),'[]'::jsonb)::text,'UTF8')),'hex') FROM public.subscriber_lists WHERE list_id=lid
$$;

-- Fixture counterpart of the retained native campaign/operation/list proof.
-- Production must use attribs.crm.created_operation_id + exact native receipts.
CREATE FUNCTION crm_audience_v2.consent_owned_v1()
RETURNS TABLE(actor text,operation_key text,brand text,list_id integer,list_uuid uuid,campaign_id integer,origins jsonb,request_hash text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.actor,r.operation_key,r.brand,l.id,l.uuid,c.id,m.v#>'{freeze,origins}',r.payload_hash
 FROM crm_audience_v2.request r CROSS JOIN LATERAL(SELECT r.crm_native_consent v)m
 JOIN public.campaigns c ON c.id=(m.v#>>'{pin,campaign_id}')::integer
 JOIN public.shrigma_campaign_operation o ON o.id=c.created_operation_id
 JOIN public.campaign_lists cl ON cl.campaign_id=c.id
 JOIN public.lists l ON l.id=cl.list_id
 WHERE m.v->>'schema'='crm-native-consent-v1' AND r.brand=c.brand AND o.brand=r.brand
  AND o.actor=r.actor AND o.action='salvar' AND o.state='succeeded' AND o.provider_id=c.id
  AND o.id::text=m.v#>>'{pin,created_operation_id}'
  AND l.id::text=m.v#>>'{freeze,list_id}' AND l.uuid::text=m.v#>>'{freeze,list_uuid}'
  AND l.brand=r.brand AND l.type='private'
  AND r.response#>>'{_body,contract}'='crm-native-frozen-list-v3'
  AND r.payload_hash=m.v#>>'{freeze,request_hash}'
  AND (SELECT count(*) FROM public.campaign_lists x WHERE x.campaign_id=c.id)=1
  AND (SELECT count(*) FROM public.campaign_lists x WHERE x.list_id=l.id)=1
$$;

-- Pin during the original successful create finish, never a separate intent.
CREATE FUNCTION crm_audience_v2.consent_pin_after_finish_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r record;c public.campaigns%ROWTYPE;n integer;frozen_row public.lists%ROWTYPE;
BEGIN
 IF NEW.action<>'salvar' OR NEW.state<>'succeeded' OR OLD.state='succeeded' THEN RETURN NEW;END IF;
 SELECT * INTO c FROM public.campaigns WHERE id=NEW.provider_id AND created_operation_id=NEW.id;
 IF NOT FOUND THEN RETURN NEW;END IF;
 FOR r IN SELECT q.* FROM crm_audience_v2.request q JOIN public.campaign_lists cl ON cl.campaign_id=c.id
  JOIN public.lists l ON l.id=cl.list_id
  WHERE q.actor=NEW.actor AND q.brand=NEW.brand AND q.brand=c.brand
   AND q.crm_native_consent->>'schema'='crm-native-consent-v1'
   AND q.crm_native_consent#>>'{freeze,list_id}'=l.id::text
   AND q.crm_native_consent#>>'{freeze,list_uuid}'=l.uuid::text
   AND q.crm_native_consent#>>'{freeze,request_hash}'=q.payload_hash
   AND q.response#>>'{_body,contract}'='crm-native-frozen-list-v3'
  FOR UPDATE OF q LOOP
  SELECT count(*) INTO n FROM public.campaign_lists WHERE list_id=(r.crm_native_consent#>>'{freeze,list_id}')::integer;
  SELECT * INTO STRICT frozen_row FROM public.lists WHERE id=(r.crm_native_consent#>>'{freeze,list_id}')::integer;
  IF n<>1 OR (SELECT count(*) FROM public.campaign_lists WHERE campaign_id=c.id)<>1
   OR r.crm_native_consent->'pin'<>'null'::jsonb THEN RAISE EXCEPTION 'CONSENT_PIN_REFUSED';END IF;
  IF frozen_row.optin IS DISTINCT FROM r.crm_native_consent#>>'{freeze,optin}'
   OR frozen_row.status IS DISTINCT FROM r.crm_native_consent#>>'{freeze,list_status}'
   OR crm_audience_v2.consent_member_state_sha256_v1(frozen_row.id) IS DISTINCT FROM r.crm_native_consent#>>'{freeze,member_state_sha256}'
  THEN RAISE EXCEPTION 'CONSENT_PREPIN_STATE_CHANGED';END IF;
  UPDATE crm_audience_v2.request SET crm_native_consent=jsonb_set(crm_native_consent,'{pin}',jsonb_build_object('campaign_id',c.id,'created_operation_id',NEW.id)) WHERE actor=r.actor AND operation_key=r.operation_key;
 END LOOP;
 RETURN NEW;
END$$;
CREATE TRIGGER crm_native_consent_pin_v1 AFTER UPDATE ON public.shrigma_campaign_operation FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.consent_pin_after_finish_v1();

-- BEFORE STATEMENT obtains the order before native row locks. The freezer
-- must take this same transaction lock before reading native memberships.
CREATE FUNCTION crm_audience_v2.consent_membership_statement_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM crm_audience_v2.consent_owned_v1()) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('crm-native-consent-v1',0));
 END IF;
 RETURN NULL;
END$$;
CREATE TRIGGER crm_native_consent_order_v1 BEFORE UPDATE OR DELETE ON public.subscriber_lists FOR EACH STATEMENT EXECUTE FUNCTION crm_audience_v2.consent_membership_statement_v1();

CREATE FUNCTION crm_audience_v2.consent_frozen_membership_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE frozen integer;
BEGIN
 IF TG_OP='UPDATE' AND NEW.list_id IS DISTINCT FROM OLD.list_id AND EXISTS(SELECT 1 FROM crm_audience_v2.consent_owned_v1()o WHERE o.list_id=OLD.list_id)
 THEN RAISE EXCEPTION 'CONSENT_FROZEN_STATE_PROMOTION_DENIED';END IF;
 SELECT list_id INTO frozen FROM crm_audience_v2.consent_owned_v1()o WHERE o.list_id=NEW.list_id;
 IF frozen IS NULL THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' THEN RAISE EXCEPTION 'CONSENT_FROZEN_MEMBER_APPEND_DENIED';END IF;
 IF NEW.list_id IS DISTINCT FROM OLD.list_id OR NEW.subscriber_id IS DISTINCT FROM OLD.subscriber_id
  OR NEW.meta IS DISTINCT FROM OLD.meta
  OR NEW.status IS DISTINCT FROM OLD.status AND NEW.status::text<>'unsubscribed'
 THEN RAISE EXCEPTION 'CONSENT_FROZEN_STATE_PROMOTION_DENIED';END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER crm_native_consent_frozen_guard_v1 BEFORE INSERT OR UPDATE ON public.subscriber_lists FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.consent_frozen_membership_guard_v1();

CREATE FUNCTION crm_audience_v2.consent_membership_after_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original record;r record;t record;origin_ids integer[];frozen_ids integer[];target_ids integer[];
 event_key text;backups jsonb:='[]'::jsonb;images jsonb:='[]'::jsonb;source_kind text:='origin';effect_at timestamptz;image jsonb;before_image jsonb;
BEGIN
 IF pg_trigger_depth()>1 OR OLD.status::text NOT IN('confirmed','unconfirmed') THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND NEW.status::text<>'unsubscribed' THEN RETURN NULL;END IF;
 -- A native list/subscriber cascade must never become an opt-out fan-out.
 IF NOT EXISTS(SELECT 1 FROM public.lists WHERE id=OLD.list_id)
  OR NOT EXISTS(SELECT 1 FROM public.subscribers WHERE id=OLD.subscriber_id) THEN RETURN NULL;END IF;
 SELECT * INTO original FROM crm_audience_v2.consent_owned_v1() o WHERE o.list_id=OLD.list_id
  AND o.request_hash=OLD.meta->>'crm_frozen_request_hash';
 IF FOUND THEN
  source_kind:='frozen';
  SELECT array_agg((x->>'id')::integer ORDER BY (x->>'id')::integer) INTO origin_ids FROM jsonb_array_elements(original.origins)x
   JOIN public.lists l ON l.id=(x->>'id')::integer AND l.uuid::text=x->>'uuid' AND l.brand=original.brand;
  IF coalesce(cardinality(origin_ids),0)<>jsonb_array_length(original.origins) THEN RAISE EXCEPTION 'CONSENT_ORIGIN_CHANGED';END IF;
 ELSE origin_ids:=ARRAY[OLD.list_id];END IF;
 -- Close the target set ONCE. Derived frozen removals do not add their origins.
 SELECT array_agg(DISTINCT o.list_id ORDER BY o.list_id) INTO frozen_ids
 FROM crm_audience_v2.consent_owned_v1()o
 JOIN public.subscriber_lists sl ON sl.list_id=o.list_id AND sl.subscriber_id=OLD.subscriber_id
  AND sl.meta->>'crm_frozen_request_hash'=o.request_hash
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(o.origins)x JOIN public.lists l
  ON l.id=(x->>'id')::integer AND l.uuid::text=x->>'uuid' AND l.brand=o.brand
  WHERE l.id=ANY(origin_ids));
 IF source_kind='frozen' THEN frozen_ids:=coalesce(frozen_ids,'{}')||OLD.list_id;END IF;
 IF coalesce(cardinality(frozen_ids),0)=0 THEN RETURN NULL;END IF;
 SELECT array_agg(DISTINCT v ORDER BY v) INTO target_ids FROM unnest(coalesce(frozen_ids,'{}')||CASE WHEN source_kind='frozen' THEN origin_ids ELSE '{}'::integer[] END)u(v);
 -- Back up only native membership identity/status/time, no email/attributes.
 backups:=jsonb_build_array(jsonb_build_object('list_id',OLD.list_id,'before',OLD.status::text,'before_updated_at',OLD.updated_at));
 FOR t IN SELECT * FROM public.subscriber_lists WHERE subscriber_id=OLD.subscriber_id AND list_id=ANY(target_ids) ORDER BY list_id FOR UPDATE LOOP
  IF t.list_id<>OLD.list_id AND t.status::text<>'unsubscribed' THEN
   backups:=backups||jsonb_build_array(jsonb_build_object('list_id',t.list_id,'before',t.status::text,'before_updated_at',t.updated_at));
  END IF;
 END LOOP;
 event_key:=pg_current_xact_id()::text||':'||OLD.subscriber_id::text||':'||OLD.list_id::text||':'||TG_OP;
 effect_at:=clock_timestamp();
 UPDATE public.subscriber_lists SET status='unsubscribed',updated_at=effect_at
 WHERE subscriber_id=OLD.subscriber_id AND list_id=ANY(target_ids) AND status<>'unsubscribed';
 FOR before_image IN SELECT * FROM jsonb_array_elements(backups) LOOP
  SELECT jsonb_build_object('subscriber_id',sl.subscriber_id,'list_id',sl.list_id,'status',sl.status::text,'updated_at',sl.updated_at,'meta',sl.meta) INTO image FROM public.subscriber_lists sl WHERE sl.subscriber_id=OLD.subscriber_id AND sl.list_id=(before_image->>'list_id')::integer;
  IF image IS NULL THEN image:=jsonb_build_object('subscriber_id',OLD.subscriber_id,'list_id',(before_image->>'list_id')::integer,'absent',true);END IF;
  images:=images||jsonb_build_array(before_image||jsonb_build_object('after_image',image,'after_sha256',encode(sha256(convert_to(image::text,'UTF8')),'hex')));
 END LOOP;
 -- Durable backup on every affected original freeze request; hashed receipts untouched.
 FOR r IN SELECT * FROM crm_audience_v2.consent_owned_v1() o WHERE o.list_id=ANY(frozen_ids) ORDER BY o.actor,o.operation_key LOOP
  UPDATE crm_audience_v2.request SET crm_native_consent=jsonb_set(crm_native_consent,ARRAY['events',event_key],jsonb_build_object('campaign_id',r.campaign_id,'subscriber_id',OLD.subscriber_id,'cause_list_id',OLD.list_id,'cause',source_kind,'native_operation',TG_OP,'at',effect_at,'restoration_scope','whole-original-cause-only','original_optout_must_remain',true,'memberships',images)) WHERE actor=r.actor AND operation_key=r.operation_key AND NOT((crm_native_consent->'events')?event_key);
 END LOOP;
 RETURN NULL;
END$$;
CREATE TRIGGER crm_native_consent_withdrawal_v1 AFTER UPDATE OR DELETE ON public.subscriber_lists FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.consent_membership_after_v1();

-- Read-only prerequisite for any separately authorized correction. This does
-- not restore a status, recreate a membership or undo the original opt-out.
CREATE FUNCTION crm_audience_v2.consent_event_matches_v1(a text,k text,e text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE event jsonb;m jsonb;image jsonb;sid integer;
BEGIN
 SELECT crm_native_consent#>ARRAY['events',e] INTO event FROM crm_audience_v2.request WHERE actor=a AND operation_key=k;
 IF event IS NULL OR event->>'restoration_scope'<>'whole-original-cause-only' OR event->'original_optout_must_remain'<>'true'::jsonb THEN RETURN false;END IF;
 sid:=(event->>'subscriber_id')::integer;
 FOR m IN SELECT * FROM jsonb_array_elements(event->'memberships') LOOP
  SELECT jsonb_build_object('subscriber_id',sl.subscriber_id,'list_id',sl.list_id,'status',sl.status::text,'updated_at',sl.updated_at,'meta',sl.meta) INTO image FROM public.subscriber_lists sl WHERE sl.subscriber_id=sid AND sl.list_id=(m->>'list_id')::integer;
  IF image IS NULL THEN image:=jsonb_build_object('subscriber_id',sid,'list_id',(m->>'list_id')::integer,'absent',true);END IF;
  IF m->>'after_sha256' IS DISTINCT FROM encode(sha256(convert_to(image::text,'UTF8')),'hex') THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_audience_v2 FROM PUBLIC;
COMMIT;
