BEGIN;SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='15s';SET LOCAL search_path=pg_catalog;DO $guard$ DECLARE p record;BEGIN IF current_user<>'postgres' OR current_database()<>'listmonk' OR(SELECT system_identifier::text FROM pg_control_system())<>'7641650273200603174' THEN RAISE EXCEPTION 'NATIVE_TAGS_TARGET_REFUSED';END IF;SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('public.shrigma_campaign_guard()');IF md5(p.prosrc)<>'ba6d44aa3ee1080165ff4015cc066710' OR pg_get_userbyid(p.proowner)<>'postgres' OR p.prosecdef OR p.provolatile<>'v' OR p.proacl::text<>'{postgres=X/postgres}' OR p.proconfig::text<>'{"search_path=pg_catalog, public"}' THEN RAISE EXCEPTION 'NATIVE_TAGS_BASE_DRIFT';END IF;END $guard$;CREATE OR REPLACE FUNCTION public.shrigma_campaign_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
 IF crm_audience_v2.native_internal_before_v1(OLD,NEW) THEN RETURN NEW;END IF;
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
END $function$
;DO $post$ BEGIN IF(SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.shrigma_campaign_guard()'))<>'372ba227490e7956b0c06366957e3249' THEN RAISE EXCEPTION 'NATIVE_TAGS_POST_DRIFT';END IF;END $post$;COMMIT;
