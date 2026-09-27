-- Candidate source bridge only. No enrollment, native writes, transport or flags.
-- Install exclusively: a homonymous source object must be reviewed, not adopted.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $$ BEGIN
 IF to_regnamespace('crm_graph_candidate') IS NULL THEN RAISE EXCEPTION 'GRAPH_STORE_REQUIRED';END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='crm_graph_candidate' AND c.relname IN ('source_event_v1','source_observation_v1','source_batch_v1'))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='crm_graph_candidate' AND p.proname LIKE 'source_%_v1') THEN RAISE EXCEPTION 'GRAPH_SOURCE_COLLISION';END IF;
END $$;
CREATE TABLE crm_graph_candidate.source_event_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 subscriber_id integer NOT NULL CHECK(subscriber_id>0),subject_id uuid NOT NULL,
 ref timestamptz NOT NULL,cart_hash text NOT NULL CHECK(cart_hash~'^[a-f0-9]{64}$'),
 revision text NOT NULL CHECK(revision~'^[a-f0-9]{64}$'),UNIQUE(brand,subscriber_id,ref)
);
CREATE TABLE crm_graph_candidate.source_observation_v1(
 source_ref uuid PRIMARY KEY REFERENCES crm_graph_candidate.source_event_v1(id),
 material_hash text NOT NULL CHECK(material_hash~'^[a-f0-9]{64}$'),observed_at timestamptz NOT NULL
);
CREATE TABLE crm_graph_candidate.source_batch_v1(
 receipt_id uuid PRIMARY KEY,brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),response jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER graph_source_identity_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.source_event_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();
CREATE TRIGGER graph_source_receipt_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.source_batch_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.immutable_row();
CREATE FUNCTION crm_graph_candidate.source_time_v1(t text) RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF t IS NULL OR t!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN NULL;END IF;
 RETURN t::timestamptz;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
CREATE FUNCTION crm_graph_candidate.source_material_v1(a jsonb,first_name text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('contact.first_name',first_name,'cart.checkout_url',a->'cart_url','cart.items',a->'cart_items','cart.total',a->'cart_value')
$$;
-- Called by the trusted collector after successful, complete list reconciliation.
-- Ref/cart/material hashes must come from that collector's RETURNING receipt.
CREATE FUNCTION crm_graph_candidate.source_capture_v1(b text,rid uuid,observed timestamptz,items jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public SET lock_timeout='3s' AS $$
DECLARE old crm_graph_candidate.source_batch_v1%ROWTYPE;e crm_graph_candidate.source_event_v1%ROWTYPE;
 row jsonb;s public.subscribers%ROWTYPE;a jsonb;at timestamptz;ch text;mh text;request_hash text;refs jsonb:='[]';rev text;
BEGIN
 IF b IS NULL OR b NOT IN ('fish','aristo') OR rid IS NULL OR observed IS NULL OR jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_array_length(items)>200 OR octet_length(items::text)>131072 THEN RAISE EXCEPTION 'GRAPH_SOURCE_RECEIPT';END IF;
 request_hash:=encode(sha256(convert_to(jsonb_build_object('brand',b,'observed_at',to_char(observed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'items',items)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('graph-source:'||rid::text,0));
 SELECT * INTO old FROM crm_graph_candidate.source_batch_v1 WHERE receipt_id=rid;
 IF FOUND THEN IF old.brand<>b OR old.request_hash<>request_hash THEN RAISE EXCEPTION 'GRAPH_SOURCE_REPLAY_MISMATCH';END IF;RETURN old.response;END IF;
 IF observed>clock_timestamp() OR observed<clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'GRAPH_SOURCE_OBSERVATION_EXPIRED';END IF;
 IF (SELECT count(DISTINCT x->>'subscriber_id') FROM jsonb_array_elements(items)x)<>jsonb_array_length(items) THEN RAISE EXCEPTION 'GRAPH_SOURCE_RECEIPT';END IF;
 FOR row IN SELECT x FROM jsonb_array_elements(items)x ORDER BY (x->>'subscriber_id')::integer LOOP
  IF row-ARRAY['subscriber_id','ref','cart_hash','material_hash']<>'{}' OR (SELECT count(*) FROM jsonb_object_keys(row))<>4 OR jsonb_typeof(row->'subscriber_id') IS DISTINCT FROM 'number' OR coalesce(row->>'subscriber_id','')!~'^[1-9][0-9]{0,8}$' OR coalesce(row->>'cart_hash','')!~'^[a-f0-9]{64}$' OR coalesce(row->>'material_hash','')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'GRAPH_SOURCE_RECEIPT';END IF;
  at:=crm_graph_candidate.source_time_v1(row->>'ref');IF at IS NULL OR at>observed THEN RAISE EXCEPTION 'GRAPH_SOURCE_RECEIPT';END IF;
  SELECT * INTO s FROM public.subscribers WHERE id=(row->>'subscriber_id')::integer FOR SHARE;
  a:=s.attribs->b;
  IF s.id IS NULL OR s.uuid IS NULL OR crm_graph_candidate.source_time_v1(a->>'cart_abandoned_at') IS DISTINCT FROM at OR coalesce(a->>'cart_id','')='' THEN RAISE EXCEPTION 'GRAPH_SOURCE_CHANGED';END IF;
  ch:=encode(sha256(convert_to(a->>'cart_id','UTF8')),'hex');mh:=encode(sha256(convert_to(crm_graph_candidate.source_material_v1(a,s.attribs->>'first_name')::text,'UTF8')),'hex');
  IF ch<>row->>'cart_hash' OR mh<>row->>'material_hash' THEN RAISE EXCEPTION 'GRAPH_SOURCE_CHANGED';END IF;
  rev:=encode(sha256(convert_to(jsonb_build_array(b,s.uuid,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),ch)::text,'UTF8')),'hex');
  INSERT INTO crm_graph_candidate.source_event_v1(brand,subscriber_id,subject_id,ref,cart_hash,revision) VALUES(b,s.id,s.uuid,at,ch,rev) ON CONFLICT(brand,subscriber_id,ref) DO NOTHING;
  SELECT * INTO STRICT e FROM crm_graph_candidate.source_event_v1 WHERE brand=b AND subscriber_id=s.id AND ref=at;
  IF e.revision<>rev OR e.subject_id<>s.uuid THEN RAISE EXCEPTION 'GRAPH_SOURCE_IDENTITY_CHANGED';END IF;
  INSERT INTO crm_graph_candidate.source_observation_v1(source_ref,material_hash,observed_at) VALUES(e.id,mh,observed)
  ON CONFLICT(source_ref) DO UPDATE SET material_hash=EXCLUDED.material_hash,observed_at=EXCLUDED.observed_at WHERE EXCLUDED.observed_at>source_observation_v1.observed_at;
  refs:=refs||jsonb_build_array(e.id);
 END LOOP;
 INSERT INTO crm_graph_candidate.source_batch_v1(receipt_id,brand,request_hash,response) VALUES(rid,b,request_hash,jsonb_build_object('source_refs',refs,'authorizes_enrollment',false,'authorizes_send',false));
 RETURN jsonb_build_object('source_refs',refs,'authorizes_enrollment',false,'authorizes_send',false);
END $$;
-- Native state is reread; reading it now never freshens the collector observation.
-- No absence-of-purchase assertion is made from a webhook-maintained last_order_at.
CREATE FUNCTION crm_graph_candidate.source_read_v1(b text,ref_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE e crm_graph_candidate.source_event_v1%ROWTYPE;s public.subscribers%ROWTYPE;o crm_graph_candidate.source_observation_v1%ROWTYPE;
 a jsonb;seen timestamptz:=statement_timestamp();live_ref timestamptz;purchased timestamptz;consent boolean;suppressed boolean;material jsonb;mh text;
BEGIN
 IF b IS NULL OR b NOT IN ('fish','aristo') OR ref_id IS NULL THEN RAISE EXCEPTION 'GRAPH_SOURCE_IDENTITY';END IF;
 SELECT * INTO e FROM crm_graph_candidate.source_event_v1 WHERE id=ref_id AND brand=b;
 IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_SOURCE_NOT_FOUND';END IF;
 SELECT * INTO o FROM crm_graph_candidate.source_observation_v1 WHERE source_ref=e.id;
 SELECT * INTO s FROM public.subscribers WHERE id=e.subscriber_id;
 a:=coalesce(s.attribs->b,'{}');live_ref:=crm_graph_candidate.source_time_v1(a->>'cart_abandoned_at');purchased:=crm_graph_candidate.source_time_v1(a->>'last_order_at');
 consent:=s.status::text='enabled' AND EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.subscriber_id=e.subscriber_id AND sl.list_id=CASE b WHEN 'fish' THEN 22 ELSE 21 END AND sl.status::text IN ('confirmed','unconfirmed'))
 AND NOT EXISTS(SELECT 1 FROM public.subscriber_lists sl JOIN public.lists l ON l.id=sl.list_id WHERE sl.subscriber_id=e.subscriber_id AND sl.status::text='unsubscribed' AND ((b='fish' AND (l.id IN (17,22) OR coalesce(l.tags,'{}')&&ARRAY['fish','fishermans']::varchar[])) OR (b='aristo' AND (l.id IN (16,21) OR coalesce(l.tags,'{}')&&ARRAY['aristo','aristocrata']::varchar[]))))
 AND lower(coalesce(a->>'mkt_consent','')) NOT IN ('not_subscribed','unsubscribed','false','denied','revoked');
 suppressed:=EXISTS(SELECT 1 FROM public.shrigma_email_dispatch d WHERE d.brand=b AND d.flow='carrinho' AND d.is_test=false AND d.dedupe_key=jsonb_build_array('email',to_char(e.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),e.subscriber_id,false)::text)
 OR EXISTS(SELECT 1 FROM public.shrigma_send_log l WHERE l.brand=b AND l.flow='carrinho' AND l.channel='email' AND l.subscriber_id=e.subscriber_id AND crm_graph_candidate.source_time_v1(l.ref)=e.ref)
 OR coalesce(a->'flows','{}') ?| ARRAY['cart_t05_at','cart_t1_at','cart_t2_at','cart_t24_at','cart_t48_at'];
 material:=crm_graph_candidate.source_material_v1(a,s.attribs->>'first_name');mh:=encode(sha256(convert_to(material::text,'UTF8')),'hex');
 RETURN jsonb_build_object('source_ref',e.id,'brand',e.brand,'subject_id',e.subject_id,'source_revision',e.revision,
 'occurred_at',to_char(e.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'observed_at',to_char(seen AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'eligible',coalesce(s.uuid=e.subject_id AND live_ref=e.ref AND encode(sha256(convert_to(a->>'cart_id','UTF8')),'hex')=e.cart_hash,false),
 'consent',coalesce(consent,false),'suppressed',coalesce(suppressed,false),
 'purchase_positive',purchased>=e.ref AND purchased<=seen,
 'material',CASE WHEN octet_length(material::text)<=65536 THEN material ELSE '{}'::jsonb END,'material_matches',mh=o.material_hash,'material_observed_at',to_char(o.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;
REVOKE ALL ON crm_graph_candidate.source_event_v1,crm_graph_candidate.source_observation_v1,crm_graph_candidate.source_batch_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_graph_candidate.source_time_v1(text),crm_graph_candidate.source_material_v1(jsonb,text),crm_graph_candidate.source_capture_v1(text,uuid,timestamptz,jsonb),crm_graph_candidate.source_read_v1(text,uuid) FROM PUBLIC;
COMMIT;
