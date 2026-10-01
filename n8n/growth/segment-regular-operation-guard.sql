-- Private candidate. Replace only the exact draft-only guard, while every
-- bound campaign is still a draft and both deployment/control gates are OFF.
-- This file approves no deployment/campaign, adds no grants and schedules none.
DO $install$
BEGIN
 IF to_regprocedure('crm_audience_v2.regular_delivery_claim_live(uuid,integer,integer,uuid,text,text,text,text,text,jsonb,text)') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('crm_audience_v2.campaign_send_guard()')
  AND md5(prosrc)='9500dc7c5de39c3a3e9f9542c1e36b65' AND prosecdef AND provolatile='v'
  AND proconfig=ARRAY['search_path=pg_catalog'])
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.campaigns'::regclass
  AND tgname='shrigma_audience_campaign_send_guard_v1' AND tgenabled='O' AND tgtype=27
  AND tgfoid='crm_audience_v2.campaign_send_guard()'::regprocedure)
 OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_deployment WHERE enabled)
 OR EXISTS(SELECT 1 FROM crm_audience_v2.regular_delivery_campaign WHERE enabled)
 OR EXISTS(SELECT 1 FROM public.campaigns c JOIN LATERAL crm_audience_v2.campaign_binding_effective(c.id) b ON true
  WHERE c.status::text<>'draft' OR c.sent<>0 OR c.started_at IS NOT NULL OR c.last_subscriber_id<>0) THEN
  RAISE EXCEPTION 'SEGMENT_OPERATION_GUARD_INSTALL_UNAVAILABLE';
 END IF;
 EXECUTE $ddl$CREATE OR REPLACE FUNCTION crm_audience_v2.campaign_send_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE brand text;ctl crm_audience_v2.regular_delivery_campaign%ROWTYPE;
 deployment crm_audience_v2.regular_worker_deployment%ROWTYPE;lease crm_audience_v2.regular_worker_lease%ROWTYPE;
 ctx jsonb;at timestamptz;
 progress text[]:=ARRAY['status','sent','to_send','max_subscriber_id','last_subscriber_id','started_at','updated_at'];
 BEGIN
  SELECT b.brand INTO brand FROM crm_audience_v2.campaign_binding_effective(OLD.id) b;
  IF NOT FOUND THEN
   IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding WHERE campaign_id=OLD.id) THEN
    RAISE EXCEPTION 'SEGMENT_CAMPAIGN_HISTORY_RETAINED';
   END IF;
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
  END IF;
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
   OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding_effective(OLD.id) b
    WHERE b.binding_version=ctl.binding_version AND b.binding_hash=ctl.binding_hash) THEN
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
 $fn$$ddl$;
END
$install$;
