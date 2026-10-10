-- PUBLIC SYNTHETIC FIXTURE ONLY. Install AFTER own rows seed; never original.
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
CREATE TRIGGER shrigma_campaign_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.campaigns
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_guard();
REVOKE ALL ON FUNCTION public.shrigma_campaign_is_managed(public.campaigns),public.shrigma_campaign_guard() FROM PUBLIC;
