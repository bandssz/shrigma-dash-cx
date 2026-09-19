-- Apply together with campaign-provider.sql in one transaction, after compatibility tests.
-- Only crm-campaign-v1 Aristo/Fish campaigns are owned by the dashboard.
-- These guards arbitrate application writers, not a database owner who can disable triggers.
CREATE OR REPLACE FUNCTION public.shrigma_campaign_is_managed(c public.campaigns) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}' IN ('aristo','fish'),false)
$$;

CREATE OR REPLACE FUNCTION public.shrigma_campaign_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE managed boolean; writer boolean; o jsonb; n jsonb;
 runtime_fields text[]:=ARRAY['status','sent','to_send','last_subscriber_id','max_subscriber_id','started_at','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF public.shrigma_campaign_is_managed(NEW) AND
    (NEW.status::text<>'draft' OR NEW.send_at IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.sent<>0) THEN
   RAISE EXCEPTION 'CAMPAIGN_CREATE_DRAFT_ONLY';
  END IF;
  IF public.shrigma_campaign_is_managed(NEW) THEN
   PERFORM set_config('shrigma.campaign_created',
    (coalesce(nullif(current_setting('shrigma.campaign_created',true),''),'[]')::jsonb||to_jsonb(NEW.id))::text,true);
  END IF;
  RETURN NEW;
 END IF;
 managed:=public.shrigma_campaign_is_managed(OLD);
 IF TG_OP='DELETE' THEN
  IF managed THEN RAISE EXCEPTION 'CAMPAIGN_EDITOR_REQUIRED'; END IF;
  RETURN OLD;
 END IF;
 IF NOT managed THEN
  IF public.shrigma_campaign_is_managed(NEW) THEN RAISE EXCEPTION 'CAMPAIGN_ADOPTION_REQUIRED'; END IF;
  RETURN NEW;
 END IF;
 writer:=current_setting('shrigma.campaign_writer',true)=OLD.id::text;
 IF writer THEN RETURN NEW; END IF;
 o:=to_jsonb(OLD);n:=to_jsonb(NEW);
 IF (o-runtime_fields) IS DISTINCT FROM (n-runtime_fields) THEN RAISE EXCEPTION 'CAMPAIGN_EDITOR_REQUIRED'; END IF;
 -- The native worker may count deliveries and advance a due schedule. Operators
 -- retain stop/pause/resume. A draft cannot bypass review through native Send.
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
   (OLD.status::text='scheduled' AND NEW.status::text='running' AND OLD.send_at<=clock_timestamp()) OR
   (OLD.status::text IN ('scheduled','running') AND NEW.status::text IN ('paused','cancelled')) OR
   (OLD.status::text='paused' AND NEW.status::text IN ('scheduled','cancelled')) OR
   (OLD.status::text='paused' AND NEW.status::text='running' AND OLD.send_at<=clock_timestamp()) OR
   (OLD.status::text='running' AND NEW.status::text='finished')) THEN
  RAISE EXCEPTION 'CAMPAIGN_REVIEW_REQUIRED';
 END IF;
 IF OLD.status::text='draft' AND (o-ARRAY['updated_at']) IS DISTINCT FROM (n-ARRAY['updated_at']) THEN
  RAISE EXCEPTION 'CAMPAIGN_REVIEW_REQUIRED';
 END IF;
 RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.shrigma_campaign_relation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE pid integer;c public.campaigns%ROWTYPE; created_here boolean;
BEGIN
 -- Check both parents: moving a relation must not remove an owned audience/media.
 FOR pid IN SELECT DISTINCT x FROM unnest(ARRAY[
   CASE WHEN TG_OP<>'INSERT' THEN OLD.campaign_id END,
   CASE WHEN TG_OP<>'DELETE' THEN NEW.campaign_id END]) x WHERE x IS NOT NULL ORDER BY x LOOP
  SELECT ca.* INTO c FROM public.campaigns ca WHERE ca.id=pid FOR UPDATE;
  IF NOT FOUND OR NOT public.shrigma_campaign_is_managed(c) THEN CONTINUE; END IF;
  IF current_setting('shrigma.campaign_writer',true)=pid::text THEN CONTINUE; END IF;
  -- Native create uses one SQL CTE for the draft and its initial relations.
  created_here:=coalesce(nullif(current_setting('shrigma.campaign_created',true),''),'[]')::jsonb @> to_jsonb(pid);
  IF TG_OP='INSERT' AND created_here AND c.status::text='draft' AND c.send_at IS NULL THEN CONTINUE; END IF;
  RAISE EXCEPTION 'CAMPAIGN_EDITOR_REQUIRED';
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.shrigma_campaign_dependency_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE c public.campaigns%ROWTYPE;
BEGIN
 -- Drafts may observe shared catalog edits: their revision changes and review
 -- becomes stale. Once scheduled, preserve dependencies until completion/stop.
 FOR c IN SELECT ca.* FROM public.campaigns ca WHERE public.shrigma_campaign_is_managed(ca)
  AND ca.status::text IN ('scheduled','running','paused') AND (
   (TG_TABLE_NAME='templates' AND ca.template_id=OLD.id) OR
   (TG_TABLE_NAME='lists' AND EXISTS(SELECT 1 FROM public.campaign_lists cl WHERE cl.campaign_id=ca.id AND cl.list_id=OLD.id)) OR
   (TG_TABLE_NAME='media' AND EXISTS(SELECT 1 FROM public.campaign_media cm WHERE cm.campaign_id=ca.id AND cm.media_id=OLD.id)))
  ORDER BY ca.id FOR SHARE LOOP
  RAISE EXCEPTION 'CAMPAIGN_DEPENDENCY_IN_USE';
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $fn$;

CREATE TRIGGER shrigma_campaign_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.campaigns
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_guard();
CREATE TRIGGER shrigma_campaign_lists_guard BEFORE INSERT OR UPDATE OR DELETE ON public.campaign_lists
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_relation_guard();
CREATE TRIGGER shrigma_campaign_media_guard BEFORE INSERT OR UPDATE OR DELETE ON public.campaign_media
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_relation_guard();
CREATE TRIGGER shrigma_campaign_template_guard BEFORE UPDATE OR DELETE ON public.templates
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_dependency_guard();
CREATE TRIGGER shrigma_campaign_list_guard BEFORE UPDATE OR DELETE ON public.lists
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_dependency_guard();
CREATE TRIGGER shrigma_campaign_media_asset_guard BEFORE UPDATE OR DELETE ON public.media
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_dependency_guard();
REVOKE ALL ON FUNCTION public.shrigma_campaign_is_managed(public.campaigns),public.shrigma_campaign_guard(),
 public.shrigma_campaign_relation_guard(),public.shrigma_campaign_dependency_guard() FROM PUBLIC;
