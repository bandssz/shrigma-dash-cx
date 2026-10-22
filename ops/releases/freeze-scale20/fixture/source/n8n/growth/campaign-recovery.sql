-- CRM21: bind an existing, unstarted draft to a separate durable recovery receipt.
-- This function never creates, updates, schedules, cancels or sends a campaign.
-- The original uncertain receipt remains immutable. Backend owner only.
CREATE TABLE public.shrigma_campaign_recovery_receipt (
 source_operation_id uuid PRIMARY KEY REFERENCES public.shrigma_campaign_operation(id),
 recovery_operation_id uuid NOT NULL UNIQUE REFERENCES public.shrigma_campaign_operation(id),
 provider_id integer NOT NULL REFERENCES public.campaigns(id),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[0-9a-f]{64}$'),
 campaign_version text NOT NULL CHECK(length(campaign_version)>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON public.shrigma_campaign_recovery_receipt FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.shrigma_campaign_recovery(a text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s'
AS $fn$
DECLARE source public.shrigma_campaign_operation%ROWTYPE; op public.shrigma_campaign_operation%ROWTYPE;
 c public.campaigns%ROWTYPE; current_row jsonb; result jsonb; source_id uuid; source_hash text; actor_name text;
BEGIN
 IF a NOT IN ('recovery_inspect','recover') OR jsonb_typeof(p) IS DISTINCT FROM 'object'
  OR coalesce(p->>'sourceOperationId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN RAISE EXCEPTION 'RECOVERY_INVALID'; END IF;
 source_id:=(p->>'sourceOperationId')::uuid;
 IF a='recover' THEN
  -- The same operation -> campaign order as the provider. Source is a terminal
  -- save, never another recovery, so concurrent recoveries cannot form a cycle.
  SELECT * INTO op FROM public.shrigma_campaign_operation WHERE id=(p->>'operationId')::uuid FOR UPDATE;
  IF NOT FOUND OR op.id=source_id OR op.action<>'recuperar' OR op.state<>'pending'
   OR coalesce(p->>'expectedVersion','')='' THEN RAISE EXCEPTION 'RECOVERY_INVALID'; END IF;
  actor_name:=op.actor;
  SELECT * INTO source FROM public.shrigma_campaign_operation WHERE id=source_id FOR UPDATE;
 ELSE
  actor_name:=p->>'actor';
  SELECT * INTO source FROM public.shrigma_campaign_operation WHERE id=source_id;
 END IF;
 IF source.id IS NULL OR source.actor IS DISTINCT FROM actor_name OR source.action<>'salvar'
  OR source.brand NOT IN ('aristo','fish') OR source.state<>'outcome_unknown' OR source.provider_id IS NULL
  OR source.response#>>'{body,error}' IS DISTINCT FROM 'OUTCOME_UNKNOWN'
  OR source.response#>>'{body,operation_id}' IS DISTINCT FROM source.id::text
  OR source.response#>>'{body,provider_id}' IS DISTINCT FROM source.provider_id::text THEN
  IF a='recovery_inspect' THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'RECOVERY_UNAVAILABLE';
 END IF;
 IF a='recover' AND (op.brand IS DISTINCT FROM source.brand OR (p->>'id')::integer IS DISTINCT FROM source.provider_id
  OR (op.provider_id IS NOT NULL AND op.provider_id<>source.provider_id)) THEN RAISE EXCEPTION 'RECOVERY_UNAVAILABLE'; END IF;
 IF EXISTS(SELECT 1 FROM public.shrigma_campaign_recovery_receipt WHERE source_operation_id=source.id) THEN
  IF a='recovery_inspect' THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'RECOVERY_ALREADY_CLAIMED';
 END IF;
 IF a='recover' THEN
  SELECT * INTO c FROM public.campaigns WHERE id=source.provider_id FOR UPDATE;
 ELSE SELECT * INTO c FROM public.campaigns WHERE id=source.provider_id;
 END IF;
 IF c.id IS NULL OR c.attribs#>>'{crm,policy}' IS DISTINCT FROM 'crm-campaign-v1'
  OR c.attribs#>>'{crm,brand}' IS DISTINCT FROM source.brand
  OR c.attribs#>>'{crm,created_operation_id}' IS DISTINCT FROM source.id::text
  OR c.status::text<>'draft' OR c.sent IS DISTINCT FROM 0 OR c.started_at IS NOT NULL
  OR c.type::text<>'regular' OR c.messenger<>'email' OR c.content_type::text<>'html' OR c.body_source IS NOT NULL
  OR (SELECT count(*) FROM public.campaigns same WHERE same.attribs#>>'{crm,created_operation_id}'=source.id::text)<>1 THEN
  IF a='recovery_inspect' THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'RECOVERY_UNAVAILABLE';
 END IF;
 IF a='recover' THEN
  -- Bind the same version snapshot as normal saves, including catalog dependencies.
  PERFORM l.id FROM public.lists l JOIN public.campaign_lists cl ON cl.list_id=l.id WHERE cl.campaign_id=c.id ORDER BY l.id FOR SHARE OF l;
  PERFORM t.id FROM public.templates t WHERE t.id=c.template_id FOR SHARE;
  PERFORM m.id FROM public.media m JOIN public.campaign_media cm ON cm.media_id=m.id WHERE cm.campaign_id=c.id ORDER BY m.id FOR SHARE OF m;
 END IF;
 current_row:=public.shrigma_campaign_current(c.id);
 IF current_row IS NULL THEN RAISE EXCEPTION 'RECOVERY_UNAVAILABLE'; END IF;
 IF a='recovery_inspect' THEN
  RETURN jsonb_build_object('policy','crm-campaign-recovery-v1','source_operation_id',source.id,'campaign',current_row,'frozen',false);
 END IF;
 IF current_row->>'version' IS DISTINCT FROM p->>'expectedVersion' THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
 source_hash:=encode(sha256(convert_to(to_jsonb(source)::text,'UTF8')),'hex');
 INSERT INTO public.shrigma_campaign_recovery_receipt(source_operation_id,recovery_operation_id,provider_id,source_fingerprint,campaign_version)
 VALUES(source.id,op.id,c.id,source_hash,current_row->>'version');
 result:=jsonb_build_object('campaign',current_row,'operation_id',op.id,'source_operation_id',source.id,'recovery_policy','crm-campaign-recovery-v1');
 -- Receipt and ownership are atomic; a lost HTTP response uses this same new key.
 UPDATE public.shrigma_campaign_operation SET state='succeeded',provider_id=c.id,
  response=jsonb_build_object('status',200,'body',result),updated_at=clock_timestamp() WHERE id=op.id;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_recovery(text,jsonb) FROM PUBLIC;
