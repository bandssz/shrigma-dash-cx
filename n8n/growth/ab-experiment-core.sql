-- Growth A/B v2 core candidate. Apply with the transport adapter, not separately.
-- All recipient IDs stay inside PostgreSQL. No native campaign/list writes here.
BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE public.crm_ab_experiment_v2(
 test_id uuid PRIMARY KEY,brand text NOT NULL CHECK(brand IN ('fish','aristo')),
 protocol jsonb NOT NULL,seed uuid NOT NULL DEFAULT gen_random_uuid(),
 source_list_ids integer[] NOT NULL,state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','scheduled','cancelled','closed')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 window_start timestamptz,window_end timestamptz,transport_bound boolean NOT NULL DEFAULT false,
 tracking_continuous boolean NOT NULL DEFAULT false,source_complete boolean NOT NULL DEFAULT true,
 transport_interrupted_at timestamptz,transport_interruption text,
 CHECK((window_start IS NULL)=(window_end IS NULL)),CHECK(window_end>window_start)
);
CREATE UNIQUE INDEX crm_ab_one_active_brand_v2 ON public.crm_ab_experiment_v2(brand) WHERE state IN ('prepared','scheduled');
CREATE TABLE public.crm_ab_arm_v2(
 test_id uuid REFERENCES public.crm_ab_experiment_v2(test_id),arm text CHECK(arm IN ('a','b')),
 campaign_id integer NOT NULL UNIQUE,campaign_version text NOT NULL,list_id integer UNIQUE,allocated_count integer NOT NULL DEFAULT 0 CHECK(allocated_count>=0),
 finished_at timestamptz,transport_interrupted_at timestamptz,PRIMARY KEY(test_id,arm)
);
CREATE TABLE public.crm_ab_member_v2(
 test_id uuid NOT NULL,subscriber_id integer NOT NULL,arm text NOT NULL,
 revoked_at timestamptz,revoked_reason text,
 PRIMARY KEY(test_id,subscriber_id),FOREIGN KEY(test_id,arm) REFERENCES public.crm_ab_arm_v2(test_id,arm)
);
CREATE INDEX crm_ab_member_subscriber_v2 ON public.crm_ab_member_v2(subscriber_id,test_id);
CREATE TABLE public.crm_ab_action_v2(
 operation_id uuid PRIMARY KEY,actor text NOT NULL,request_payload jsonb NOT NULL,response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON public.crm_ab_experiment_v2,public.crm_ab_arm_v2,public.crm_ab_member_v2,public.crm_ab_action_v2 FROM PUBLIC;

CREATE FUNCTION public.crm_ab_protocol_valid_v2(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_typeof(p)='object' AND (p-ARRAY['contract','test_id','brand','channel','name','hypothesis','arms','allocation','rule'])='{}'::jsonb
 AND p->>'contract'='crm-ab-email-v2' AND p->>'test_id'~'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 AND p->>'brand' IN ('fish','aristo') AND p->>'channel'='email'
 AND jsonb_typeof(p->'name')='string' AND length(p->>'name') BETWEEN 1 AND 120 AND btrim(p->>'name')=p->>'name'
 AND jsonb_typeof(p->'hypothesis')='string' AND length(p->>'hypothesis') BETWEEN 1 AND 2000 AND btrim(p->>'hypothesis')=p->>'hypothesis'
 AND p->'allocation'='{"method":"random-permutation-v1","a_basis_points":5000}'::jsonb
 AND jsonb_typeof(p->'arms')='array' AND jsonb_array_length(p->'arms')=2
 AND p#>>'{arms,0,arm}'='a' AND p#>>'{arms,1,arm}'='b' AND p#>'{arms,0,campaign_id}'<>p#>'{arms,1,campaign_id}'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'arms') a WHERE
   (a-ARRAY['arm','campaign_id','expected_version'])<>'{}'::jsonb OR jsonb_typeof(a->'campaign_id') IS DISTINCT FROM 'number'
   OR coalesce(a->>'campaign_id','')!~'^[1-9][0-9]{0,9}$' OR (a->>'campaign_id')::numeric>2147483647 OR jsonb_typeof(a->'expected_version') IS DISTINCT FROM 'string'
   OR length(coalesce(a->>'expected_version','')) NOT BETWEEN 1 AND 128)
 AND jsonb_typeof(p->'rule')='object' AND ((p->'rule')-ARRAY['method','metric','window_hours','minimum_per_arm','minimum_effect_pp','alpha'])='{}'::jsonb
 AND p#>>'{rule,method}'='fisher-two-sided-fixed-window-v1' AND p#>>'{rule,metric}'='unique_tracked_click_per_allocated'
 AND jsonb_typeof(p#>'{rule,window_hours}')='number' AND p#>>'{rule,window_hours}'~'^[0-9]{1,3}$' AND (p#>>'{rule,window_hours}')::numeric BETWEEN 24 AND 168
 AND jsonb_typeof(p#>'{rule,minimum_per_arm}')='number' AND p#>>'{rule,minimum_per_arm}'~'^[0-9]{1,5}$' AND (p#>>'{rule,minimum_per_arm}')::numeric BETWEEN 1 AND 50000
 AND jsonb_typeof(p#>'{rule,minimum_effect_pp}')='number' AND (p#>>'{rule,minimum_effect_pp}')::numeric BETWEEN 0 AND 100
 AND p#>'{rule,alpha}'='0.05'::jsonb,false)
$$;

CREATE FUNCTION public.crm_ab_snapshot_v2(tid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('contract','crm-ab-email-v2','test_id',e.test_id,'brand',e.brand,'protocol',e.protocol,'version',e.version,
  'state',e.state,'prepared_at',e.prepared_at,'window_start',e.window_start,'window_end',e.window_end,
  'transport_bound',e.transport_bound,'arms',(SELECT jsonb_agg(jsonb_build_object('arm',a.arm,'campaign_id',a.campaign_id,
   'allocated',a.allocated_count,
   'revoked',(SELECT count(*) FROM public.crm_ab_member_v2 m WHERE m.test_id=a.test_id AND m.arm=a.arm AND m.revoked_at IS NOT NULL)) ORDER BY a.arm)
   FROM public.crm_ab_arm_v2 a WHERE a.test_id=e.test_id))
 FROM public.crm_ab_experiment_v2 e WHERE e.test_id=tid
$$;

CREATE FUNCTION public.crm_ab_prepare_v2(actor text,caps jsonb,oid uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $fn$
DECLARE prior public.crm_ab_action_v2%ROWTYPE;tid uuid;b text;c public.campaigns%ROWTYPE;arm jsonb;ids integer[];base_ids integer[];
 members integer[];n integer;disabled integer;result jsonb;seed_value uuid;expected text;
BEGIN
 IF coalesce(actor,'')='' OR NOT coalesce(caps ? 'draft',false) OR oid IS NULL THEN RAISE EXCEPTION 'AB_V2_ACCESS';END IF;
 IF NOT public.crm_ab_protocol_valid_v2(p) THEN RAISE EXCEPTION 'AB_V2_PROTOCOL';END IF;
 tid:=(p->>'test_id')::uuid;b:=p->>'brand';
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-ab-v2-operation:'||oid,0));
 SELECT * INTO prior FROM public.crm_ab_action_v2 WHERE operation_id=oid;
 IF FOUND THEN
  IF prior.actor IS DISTINCT FROM actor OR prior.request_payload IS DISTINCT FROM p THEN RAISE EXCEPTION 'AB_V2_IDENTITY';END IF;
  IF prior.response->>'status' IS DISTINCT FROM '200' THEN RAISE EXCEPTION 'AB_V2_RECORDED_REJECTION';END IF;
  RETURN prior.response#>'{body,experiment}';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-ab-v2-brand:'||b,0));
 IF EXISTS(SELECT 1 FROM public.crm_ab_experiment_v2 WHERE test_id=tid OR brand=b AND state IN ('prepared','scheduled')) THEN RAISE EXCEPTION 'AB_V2_ACTIVE_EXISTS';END IF;
 -- Campaigns and their catalogs are locked in stable numeric order.
 FOR c IN SELECT ca.* FROM public.campaigns ca WHERE ca.id IN ((p#>>'{arms,0,campaign_id}')::integer,(p#>>'{arms,1,campaign_id}')::integer) ORDER BY ca.id FOR UPDATE LOOP
  IF c.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1' OR c.attribs#>>'{crm,brand}' IS DISTINCT FROM b
   OR c.status::text<>'draft' OR c.sent IS DISTINCT FROM 0 OR c.started_at IS NOT NULL OR c.type::text<>'regular' OR c.messenger<>'email' THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_SCOPE';END IF;
  SELECT a->>'expected_version' INTO expected FROM jsonb_array_elements(p->'arms') a WHERE (a->>'campaign_id')::integer=c.id;
  IF public.shrigma_campaign_current(c.id)->>'version' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_VERSION';END IF;
  SELECT array_agg(cl.list_id ORDER BY cl.list_id) INTO ids FROM public.campaign_lists cl WHERE cl.campaign_id=c.id;
  IF ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'AB_V2_LIST_SCOPE';END IF;
  PERFORM l.id FROM public.lists l WHERE l.id=ANY(ids) ORDER BY l.id FOR SHARE;
  IF (SELECT count(*) FROM public.lists l WHERE l.id=ANY(ids) AND l.status::text='active' AND public.shrigma_campaign_list_brand(l)=b AND NOT ('crm-ab-v2'=ANY(coalesce(l.tags,'{}'))))<>cardinality(ids) THEN RAISE EXCEPTION 'AB_V2_LIST_SCOPE';END IF;
  IF base_ids IS NULL THEN base_ids:=ids;ELSIF base_ids IS DISTINCT FROM ids THEN RAISE EXCEPTION 'AB_V2_AUDIENCE_DIFFERS';END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.campaigns WHERE id IN ((p#>>'{arms,0,campaign_id}')::integer,(p#>>'{arms,1,campaign_id}')::integer))<>2 THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_MISSING';END IF;
 PERFORM t.id FROM public.templates t WHERE t.id IN (SELECT template_id FROM public.campaigns WHERE id IN ((p#>>'{arms,0,campaign_id}')::integer,(p#>>'{arms,1,campaign_id}')::integer)) ORDER BY t.id FOR SHARE;
 PERFORM m.id FROM public.media m WHERE m.id IN (SELECT cm.media_id FROM public.campaign_media cm WHERE cm.campaign_id IN ((p#>>'{arms,0,campaign_id}')::integer,(p#>>'{arms,1,campaign_id}')::integer)) ORDER BY m.id FOR SHARE;
 FOR arm IN SELECT a FROM jsonb_array_elements(p->'arms') a LOOP
  IF public.shrigma_campaign_current((arm->>'campaign_id')::integer)->>'version' IS DISTINCT FROM arm->>'expected_version' THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_VERSION';END IF;
 END LOOP;
 -- Bound work before locking/allocating. Oversize cohorts fail; never silently sample.
 SELECT count(*) INTO n FROM (SELECT DISTINCT sl.subscriber_id FROM public.subscriber_lists sl WHERE list_id=ANY(base_ids) LIMIT 100001) q;
 IF n>100000 THEN RAISE EXCEPTION 'AB_V2_COHORT_TOO_LARGE';END IF;
 PERFORM s.id FROM public.subscribers s WHERE EXISTS(SELECT 1 FROM public.subscriber_lists sl WHERE sl.subscriber_id=s.id AND sl.list_id=ANY(base_ids)) ORDER BY s.id FOR SHARE;
 PERFORM sl.subscriber_id FROM public.subscriber_lists sl WHERE sl.list_id=ANY(base_ids) ORDER BY sl.subscriber_id,sl.list_id FOR SHARE;
 WITH eligible AS (
  SELECT DISTINCT s.id,s.status::text status FROM public.subscribers s JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id JOIN public.lists l ON l.id=sl.list_id
  WHERE sl.list_id=ANY(base_ids) AND s.status::text<>'blocklisted'
   AND ((l.optin::text='double' AND sl.status::text='confirmed') OR (l.optin::text='single' AND sl.status::text IN ('confirmed','unconfirmed')))
 ) SELECT array_agg(id ORDER BY id),count(*) FILTER(WHERE status<>'enabled') INTO members,disabled FROM eligible;
 n:=coalesce(cardinality(members),0);
 IF n<2 OR n>100000 THEN RAISE EXCEPTION 'AB_V2_COHORT_SIZE';END IF;
 IF disabled>0 THEN RAISE EXCEPTION 'AB_V2_DISABLED_SUBSCRIBERS';END IF;
 IF floor(n/2.0)<(p#>>'{rule,minimum_per_arm}')::integer THEN RAISE EXCEPTION 'AB_V2_MINIMUM_NOT_REACHED';END IF;
 INSERT INTO public.crm_ab_experiment_v2(test_id,brand,protocol,source_list_ids) VALUES(tid,b,p,base_ids) RETURNING seed INTO seed_value;
 INSERT INTO public.crm_ab_arm_v2(test_id,arm,campaign_id,campaign_version) SELECT tid,a->>'arm',(a->>'campaign_id')::integer,a->>'expected_version' FROM jsonb_array_elements(p->'arms') a;
 INSERT INTO public.crm_ab_member_v2(test_id,subscriber_id,arm)
 SELECT tid,id,CASE WHEN row_number() OVER(ORDER BY sha256(convert_to(seed_value::text||':'||id::text,'UTF8')),id)<=floor(n/2.0) THEN 'a' ELSE 'b' END FROM unnest(members) id;
 UPDATE public.crm_ab_arm_v2 a SET allocated_count=(SELECT count(*) FROM public.crm_ab_member_v2 m WHERE m.test_id=a.test_id AND m.arm=a.arm) WHERE a.test_id=tid;
 result:=public.crm_ab_snapshot_v2(tid);
 INSERT INTO public.crm_ab_action_v2(operation_id,actor,request_payload,response) VALUES(oid,actor,p,jsonb_build_object('status',200,'body',jsonb_build_object('experiment',result)));
 RETURN result;
END $fn$;

CREATE FUNCTION public.crm_ab_operation_v2(actor text,oid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('contract','crm-ab-email-operation-v2','operation_id',$2,'actor',$1,
 'state',CASE WHEN o.operation_id IS NULL THEN 'missing' ELSE 'completed' END,'request_payload',o.request_payload,'response',o.response)
 FROM (SELECT 1) base LEFT JOIN public.crm_ab_action_v2 o ON o.operation_id=$2 AND o.actor=$1
$$;

CREATE FUNCTION public.crm_ab_measure_v2(tid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('contract','crm-ab-email-v2','test_id',e.test_id,'protocol',e.protocol,
 'as_of',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'window_start',to_char(e.window_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'window_end',to_char(e.window_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'integrity',jsonb_build_object('allocation_complete',(SELECT count(*)=2 FROM public.crm_ab_arm_v2 WHERE test_id=e.test_id),
 'assignment_disjoint',true,'transport_bound',e.transport_bound,'transport_continuous',e.transport_interrupted_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 a WHERE a.test_id=e.test_id AND a.transport_interrupted_at IS NOT NULL),'tracking_continuous',e.tracking_continuous,
 'source_complete',e.source_complete AND NOT EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 a WHERE a.test_id=e.test_id AND a.allocated_count<>(SELECT count(*) FROM public.crm_ab_member_v2 m WHERE m.test_id=a.test_id AND m.arm=a.arm)) AND NOT EXISTS(SELECT 1 FROM public.link_clicks lc JOIN public.crm_ab_arm_v2 a ON a.campaign_id=lc.campaign_id
   LEFT JOIN public.crm_ab_member_v2 m ON m.test_id=a.test_id AND m.subscriber_id=lc.subscriber_id AND m.arm=a.arm
   WHERE a.test_id=e.test_id AND lc.created_at>=e.window_start AND lc.created_at<e.window_end AND m.subscriber_id IS NULL)),
 'arms',(SELECT jsonb_agg(jsonb_build_object('arm',a.arm,'campaign_id',a.campaign_id,'native_sent',c.sent,
  'allocated',a.allocated_count,
  'revoked',(SELECT count(*) FROM public.crm_ab_member_v2 m WHERE m.test_id=a.test_id AND m.arm=a.arm AND m.revoked_at IS NOT NULL),
  'unknown',(SELECT count(*) FROM public.crm_ab_member_v2 m LEFT JOIN public.subscribers s ON s.id=m.subscriber_id WHERE m.test_id=a.test_id AND m.arm=a.arm AND s.id IS NULL),
  'finished_before_deadline',a.finished_at IS NOT NULL AND a.finished_at<=e.window_end AND c.status::text='finished',
  'unique_clickers',(SELECT count(DISTINCT lc.subscriber_id) FROM public.link_clicks lc JOIN public.crm_ab_member_v2 m ON m.test_id=a.test_id AND m.arm=a.arm AND m.subscriber_id=lc.subscriber_id
   WHERE lc.campaign_id=a.campaign_id AND lc.created_at>=e.window_start AND lc.created_at<e.window_end)) ORDER BY a.arm)
  FROM public.crm_ab_arm_v2 a LEFT JOIN public.campaigns c ON c.id=a.campaign_id WHERE a.test_id=e.test_id))
 FROM public.crm_ab_experiment_v2 e WHERE e.test_id=tid
$$;
REVOKE ALL ON FUNCTION public.crm_ab_protocol_valid_v2(jsonb),public.crm_ab_snapshot_v2(uuid),public.crm_ab_prepare_v2(text,jsonb,uuid,jsonb),public.crm_ab_operation_v2(text,uuid),public.crm_ab_measure_v2(uuid) FROM PUBLIC;
COMMIT;
