-- Local shadow candidate. No campaign, list, subscriber or service is activated.
-- The additional campaign guard remains unconditional for every bound campaign.
DO $segment_campaign_binding_install$
BEGIN
 IF pg_catalog.to_regclass('crm_audience_v2.revision') IS NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.append_only()') IS NULL
 OR pg_catalog.to_regprocedure('public.shrigma_campaign_current(integer)') IS NULL
 OR pg_catalog.to_regprocedure('public.shrigma_campaign_provider(text,jsonb)') IS NULL
 OR pg_catalog.to_regprocedure('public.shrigma_campaign_guard()') IS NULL THEN
  RAISE EXCEPTION 'SEGMENT_BINDING_DEPENDENCY';
 END IF;
 IF pg_catalog.to_regclass('crm_audience_v2.campaign_binding') IS NOT NULL
 OR pg_catalog.to_regclass('crm_audience_v2.campaign_binding_revision') IS NOT NULL
 OR pg_catalog.to_regclass('crm_audience_v2.campaign_binding_request') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.campaign_send_guard()') IS NOT NULL
 OR pg_catalog.to_regprocedure('crm_audience_v2.campaign_binding_guard()') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.campaigns'::regclass AND tgname='shrigma_audience_campaign_send_guard_v1') THEN
  RAISE EXCEPTION 'SEGMENT_BINDING_INSTALL_COLLISION';
 END IF;
 PERFORM pg_catalog.set_config('lock_timeout','500ms',true);
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.campaign_snapshot(cid integer,writing boolean)
 RETURNS TABLE(native jsonb,row_version text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 BEGIN
  IF writing THEN
   RETURN QUERY SELECT to_jsonb(c),c.xmin::text FROM public.campaigns c WHERE c.id=cid AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}' IN ('fish','aristo') FOR UPDATE OF c;
  ELSE
   RETURN QUERY SELECT to_jsonb(c),c.xmin::text FROM public.campaigns c WHERE c.id=cid AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}' IN ('fish','aristo') FOR SHARE OF c;
  END IF;
 END $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.touch_campaign(cid integer)
 RETURNS TABLE(native jsonb,row_version text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 BEGIN
  RETURN QUERY UPDATE public.campaigns c SET updated_at=c.updated_at
   WHERE c.id=cid AND c.attribs#>>'{crm,policy}'='crm-campaign-v1' AND c.attribs#>>'{crm,brand}' IN ('fish','aristo')
   AND c.status::text='draft' AND c.sent=0 AND c.started_at IS NULL AND c.type::text='regular' AND c.messenger::text='email'
   RETURNING to_jsonb(c),c.xmin::text;
 END $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.lock_campaign_dependencies(cid integer)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE target public.campaigns%ROWTYPE;
 BEGIN
  SELECT * INTO target FROM public.campaigns WHERE id=cid FOR SHARE;
  IF NOT FOUND OR target.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
   OR target.attribs#>>'{crm,brand}' IS NULL OR target.attribs#>>'{crm,brand}' NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'SEGMENT_BINDING_CAMPAIGN_SCOPE'; END IF;
  PERFORM l.id FROM public.lists l JOIN public.campaign_lists cl ON cl.list_id=l.id WHERE cl.campaign_id=cid ORDER BY l.id FOR SHARE OF l;
  PERFORM id FROM public.templates WHERE id=target.template_id FOR SHARE;
  PERFORM m.id FROM public.media m JOIN public.campaign_media cm ON cm.media_id=m.id WHERE cm.campaign_id=cid ORDER BY m.id FOR SHARE OF m;
 END $fn$$ddl$;
 CREATE TABLE crm_audience_v2.campaign_binding (
  campaign_id integer PRIMARY KEY REFERENCES public.campaigns(id),
  brand text NOT NULL CHECK(brand IN('fish','aristo')),
  binding_version integer NOT NULL CHECK(binding_version BETWEEN 1 AND 999999999),
  campaign_version text NOT NULL CHECK(campaign_version ~ '^[0-9a-f]{32}$'),
  audience_id uuid NOT NULL,
  audience_revision integer NOT NULL CHECK(audience_revision BETWEEN 1 AND 999999999),
  definition_hash text NOT NULL CHECK(definition_hash ~ '^[0-9a-f]{64}$'),
  context_hash text NOT NULL CHECK(context_hash ~ '^[0-9a-f]{64}$'),
  base_list_id integer NOT NULL CHECK(base_list_id>0),
  catalog_hash text NOT NULL CHECK(catalog_hash ~ '^[0-9a-f]{64}$'),
  binding jsonb NOT NULL CHECK(pg_catalog.octet_length(binding::text)<=64000),
  binding_hash text NOT NULL CHECK(binding_hash ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  FOREIGN KEY(audience_id,audience_revision) REFERENCES crm_audience_v2.revision(audience_id,version)
 );
 CREATE TABLE crm_audience_v2.campaign_binding_revision (
  campaign_id integer NOT NULL REFERENCES crm_audience_v2.campaign_binding(campaign_id),
  binding_version integer NOT NULL,
  binding jsonb NOT NULL,
  binding_hash text NOT NULL CHECK(binding_hash ~ '^[0-9a-f]{64}$'),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(campaign_id,binding_version)
 );
 ALTER TABLE crm_audience_v2.campaign_binding ADD CONSTRAINT binding_current_revision_exists
  FOREIGN KEY(campaign_id,binding_version) REFERENCES crm_audience_v2.campaign_binding_revision(campaign_id,binding_version) DEFERRABLE INITIALLY DEFERRED;
 CREATE TABLE crm_audience_v2.campaign_binding_request (
  actor text NOT NULL CHECK(actor ~ '^panel:[A-Za-z0-9_.:-]{1,194}$'),
  operation_key text NOT NULL CHECK(operation_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  brand text NOT NULL CHECK(brand IN('fish','aristo')),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(actor,operation_key)
 );
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.campaign_send_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE bound_brand text;
 BEGIN
  SELECT b.brand INTO bound_brand FROM crm_audience_v2.campaign_binding b WHERE b.campaign_id=OLD.id;
  IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END IF;
  -- No GUC, role name, regular-campaign writer token or runtime flag bypass.
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SEGMENT_CAMPAIGN_SELECTOR_REQUIRED';END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.status::text IS DISTINCT FROM 'draft'
   OR NEW.sent IS DISTINCT FROM 0 OR NEW.started_at IS NOT NULL
   OR NEW.type::text IS DISTINCT FROM 'regular' OR NEW.messenger IS DISTINCT FROM 'email'
   OR NEW.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
   OR NEW.attribs#>>'{crm,brand}' IS DISTINCT FROM bound_brand THEN
   RAISE EXCEPTION 'SEGMENT_CAMPAIGN_SELECTOR_REQUIRED';
  END IF;
  RETURN NEW;
 END $fn$$ddl$;
 EXECUTE $ddl$CREATE FUNCTION crm_audience_v2.campaign_binding_guard() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 DECLARE c public.campaigns%ROWTYPE;r crm_audience_v2.revision%ROWTYPE;a crm_audience_v2.audience%ROWTYPE;
 BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SEGMENT_BINDING_UNLINK_UNAVAILABLE';END IF;
  IF TG_OP='INSERT' THEN IF NEW.binding_version<>1 THEN RAISE EXCEPTION 'SEGMENT_BINDING_VERSION';END IF;
  ELSIF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR NEW.brand IS DISTINCT FROM OLD.brand
   OR NEW.binding_version<>OLD.binding_version+1 THEN RAISE EXCEPTION 'SEGMENT_BINDING_VERSION';END IF;
  SELECT (pg_catalog.jsonb_populate_record(NULL::public.campaigns,s.native)).* INTO c
   FROM crm_audience_v2.campaign_snapshot(NEW.campaign_id,true) s;
  IF NOT FOUND OR c.status::text IS DISTINCT FROM 'draft' OR c.sent IS DISTINCT FROM 0
   OR c.started_at IS NOT NULL OR c.type::text IS DISTINCT FROM 'regular' OR c.messenger IS DISTINCT FROM 'email'
   OR c.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
   OR c.attribs#>>'{crm,brand}' IS DISTINCT FROM NEW.brand
   OR public.shrigma_campaign_current(c.id)->>'version' IS DISTINCT FROM NEW.campaign_version THEN
   RAISE EXCEPTION 'SEGMENT_BINDING_CAMPAIGN';
  END IF;
  SELECT * INTO a FROM crm_audience_v2.audience WHERE id=NEW.audience_id FOR SHARE;
  SELECT * INTO r FROM crm_audience_v2.revision WHERE audience_id=NEW.audience_id AND version=NEW.audience_revision;
  IF a.id IS NULL OR r.audience_id IS NULL OR a.brand IS DISTINCT FROM NEW.brand OR a.archived
   OR a.version IS DISTINCT FROM NEW.audience_revision OR r.archived
   OR r.definition_hash IS DISTINCT FROM NEW.definition_hash OR r.context_hash IS DISTINCT FROM NEW.context_hash
   OR r.context#>>'{base,id}' IS DISTINCT FROM NEW.base_list_id::text
   OR NEW.binding->'definition' IS DISTINCT FROM r.definition OR NEW.binding->'context' IS DISTINCT FROM r.context THEN
   RAISE EXCEPTION 'SEGMENT_BINDING_AUDIENCE';
  END IF;
  -- Native count/batch intersects campaign_lists before the additional v2
  -- predicate. Only the audience's original base may supply that outer scope.
  IF (SELECT pg_catalog.count(*) FROM public.campaign_lists WHERE campaign_id=NEW.campaign_id)<>1
   OR NOT EXISTS(SELECT 1 FROM public.campaign_lists cl JOIN public.lists l ON l.id=cl.list_id
    WHERE cl.campaign_id=NEW.campaign_id AND cl.list_id=NEW.base_list_id
    AND l.status::text='active' AND public.shrigma_campaign_list_brand(l)=NEW.brand
    AND l.optin::text=r.context#>>'{base,optin}') THEN
   RAISE EXCEPTION 'SEGMENT_BINDING_BASE_REQUIRED';
  END IF;
  IF NEW.binding->>'contract' IS DISTINCT FROM 'crm-audience-campaign-binding-v1'
   OR NEW.binding->>'brand' IS DISTINCT FROM NEW.brand
   OR NEW.binding->>'campaign_id' IS DISTINCT FROM NEW.campaign_id::text
   OR NEW.binding->>'binding_version' IS DISTINCT FROM NEW.binding_version::text
   OR NEW.binding->>'campaign_version' IS DISTINCT FROM NEW.campaign_version
   OR NEW.binding->>'audience_id' IS DISTINCT FROM NEW.audience_id::text
   OR NEW.binding->>'audience_revision' IS DISTINCT FROM NEW.audience_revision::text
   OR NEW.binding->>'definition_hash' IS DISTINCT FROM NEW.definition_hash
   OR NEW.binding->>'context_hash' IS DISTINCT FROM NEW.context_hash
   OR NEW.binding->>'base_list_id' IS DISTINCT FROM NEW.base_list_id::text
   OR NEW.binding->>'catalog_hash' IS DISTINCT FROM NEW.catalog_hash
   OR NEW.binding->'authorizes_selection' IS DISTINCT FROM 'false'::jsonb
   OR NEW.binding->'authorizes_send' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'SEGMENT_BINDING_SHAPE';END IF;
  RETURN NEW;
 END $fn$$ddl$;
 CREATE TRIGGER shrigma_audience_campaign_send_guard_v1 BEFORE UPDATE OR DELETE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.campaign_send_guard();
 CREATE TRIGGER binding_head_guard BEFORE INSERT OR UPDATE OR DELETE ON crm_audience_v2.campaign_binding
  FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.campaign_binding_guard();
 CREATE TRIGGER binding_revision_append_only BEFORE UPDATE OR DELETE ON crm_audience_v2.campaign_binding_revision
  FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
 CREATE TRIGGER binding_request_append_only BEFORE UPDATE OR DELETE ON crm_audience_v2.campaign_binding_request
  FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.append_only();
 REVOKE ALL ON crm_audience_v2.campaign_binding,crm_audience_v2.campaign_binding_revision,crm_audience_v2.campaign_binding_request FROM PUBLIC;
 REVOKE ALL ON FUNCTION crm_audience_v2.campaign_send_guard(),crm_audience_v2.campaign_binding_guard() FROM PUBLIC;
 REVOKE ALL ON FUNCTION crm_audience_v2.lock_campaign_dependencies(integer) FROM PUBLIC;
 REVOKE ALL ON FUNCTION crm_audience_v2.campaign_snapshot(integer,boolean),crm_audience_v2.touch_campaign(integer) FROM PUBLIC;
END $segment_campaign_binding_install$;
