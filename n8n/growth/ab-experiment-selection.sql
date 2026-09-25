-- Growth-only native-selection dependency. Activation deliberately starts OFF.
-- This does not patch/restart Listmonk, schedule a campaign, or grant browser DML.
BEGIN;
CREATE TABLE public.crm_ab_runtime_v2(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),enabled boolean NOT NULL DEFAULT false,
 native_query_sha256 text CHECK(native_query_sha256~'^[a-f0-9]{64}$'),verified_at timestamptz,
 CHECK(NOT enabled OR (native_query_sha256 IS NOT NULL AND verified_at IS NOT NULL))
);
INSERT INTO public.crm_ab_runtime_v2(singleton) VALUES(true);
REVOKE ALL ON public.crm_ab_runtime_v2 FROM PUBLIC;
CREATE FUNCTION public.crm_ab_delivery_allowed_v2(cid integer,sid integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 WHERE campaign_id=cid) OR EXISTS(
  SELECT 1 FROM public.crm_ab_arm_v2 a JOIN public.crm_ab_experiment_v2 e ON e.test_id=a.test_id
  JOIN public.crm_ab_member_v2 m ON m.test_id=a.test_id AND m.arm=a.arm AND m.subscriber_id=sid
  JOIN public.crm_ab_runtime_v2 r ON r.singleton
  WHERE a.campaign_id=cid AND e.state='scheduled' AND e.transport_bound AND e.tracking_continuous AND e.source_complete
   AND r.enabled AND m.revoked_at IS NULL AND statement_timestamp()<e.window_end)
$$;
CREATE FUNCTION public.crm_ab_campaign_guard_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE e public.crm_ab_experiment_v2%ROWTYPE;allowed boolean;
 runtime_fields text[]:=ARRAY['status','sent','to_send','last_subscriber_id','max_subscriber_id','started_at','updated_at'];
BEGIN
 SELECT x.* INTO e FROM public.crm_ab_experiment_v2 x JOIN public.crm_ab_arm_v2 a ON a.test_id=x.test_id WHERE a.campaign_id=OLD.id;
 IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AB_V2_CAMPAIGN_FROZEN';END IF;
 -- Only the atomic A/B scheduler may change draft->scheduled. Its operation and
 -- native-build receipt are separate prerequisites, never a campaign-editor marker.
 allowed:=current_setting('shrigma.ab_schedule_v2',true)=e.test_id::text AND
  EXISTS(SELECT 1 FROM public.crm_ab_runtime_v2 WHERE singleton AND enabled);
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
 RETURN NEW;
END $$;
CREATE FUNCTION public.crm_ab_relation_guard_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.crm_ab_arm_v2 WHERE campaign_id IN (
  CASE WHEN TG_OP<>'INSERT' THEN OLD.campaign_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.campaign_id END)) THEN
  RAISE EXCEPTION 'AB_V2_CAMPAIGN_FROZEN';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
CREATE TRIGGER crm_ab_campaign_guard_v2 BEFORE UPDATE OR DELETE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.crm_ab_campaign_guard_v2();
CREATE TRIGGER crm_ab_lists_guard_v2 BEFORE INSERT OR UPDATE OR DELETE ON public.campaign_lists FOR EACH ROW EXECUTE FUNCTION public.crm_ab_relation_guard_v2();
CREATE TRIGGER crm_ab_media_guard_v2 BEFORE INSERT OR UPDATE OR DELETE ON public.campaign_media FOR EACH ROW EXECUTE FUNCTION public.crm_ab_relation_guard_v2();
CREATE FUNCTION public.crm_ab_click_evidence_guard_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 -- Deletion/anonymization cannot turn observed engagement into a measured zero.
 UPDATE public.crm_ab_experiment_v2 e SET source_complete=false FROM public.crm_ab_arm_v2 a
 WHERE a.test_id=e.test_id AND a.campaign_id=OLD.campaign_id AND e.source_complete
  AND OLD.created_at>=e.window_start AND OLD.created_at<e.window_end;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
CREATE TRIGGER crm_ab_click_evidence_guard_v2 AFTER UPDATE OR DELETE ON public.link_clicks FOR EACH ROW EXECUTE FUNCTION public.crm_ab_click_evidence_guard_v2();
CREATE FUNCTION public.crm_ab_tracking_evidence_guard_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.value IS DISTINCT FROM OLD.value THEN
  UPDATE public.crm_ab_experiment_v2 SET tracking_continuous=false WHERE state='scheduled' AND tracking_continuous;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
CREATE TRIGGER crm_ab_tracking_evidence_guard_v2 AFTER UPDATE OR DELETE ON public.settings
 FOR EACH ROW WHEN (OLD.key IN ('privacy.disable_tracking','privacy.individual_tracking')) EXECUTE FUNCTION public.crm_ab_tracking_evidence_guard_v2();
REVOKE ALL ON FUNCTION public.crm_ab_delivery_allowed_v2(integer,integer),public.crm_ab_campaign_guard_v2(),public.crm_ab_relation_guard_v2() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_ab_click_evidence_guard_v2(),public.crm_ab_tracking_evidence_guard_v2() FROM PUBLIC;
COMMIT;
