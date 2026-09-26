-- Durable server-side operations. No campaigns are created or sent by this migration.
-- Apply as the backend owner. Functions are SECURITY INVOKER, never public RPCs.
CREATE TABLE public.shrigma_campaign_operation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
 operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9_-]{16,100}$'),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 brand text NOT NULL CHECK (brand IN ('aristo','fish')),
 action text NOT NULL CHECK (action IN ('salvar','validar','agendar','cancelar')),
 lease uuid NOT NULL DEFAULT gen_random_uuid(),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','succeeded','rejected','outcome_unknown')),
 provider_id integer CHECK (provider_id > 0),
 response jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor,operation_key),
 CHECK ((state='pending' AND response IS NULL) OR
        (state<>'pending' AND response IS NOT NULL AND jsonb_typeof(response)='object'))
);
CREATE TABLE public.shrigma_campaign_validation (
 provider_id integer PRIMARY KEY CHECK (provider_id > 0),
 validation jsonb NOT NULL CHECK (jsonb_typeof(validation)='object'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON public.shrigma_campaign_operation,public.shrigma_campaign_validation FROM PUBLIC;

CREATE FUNCTION public.shrigma_campaign_store(p_action text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s'
AS $fn$
DECLARE r public.shrigma_campaign_operation%ROWTYPE; got boolean; v jsonb; pid integer;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object' THEN RAISE EXCEPTION 'CAMPAIGN_STORE_INPUT'; END IF;
 IF p_action IN ('claim','get') THEN
  IF coalesce(p->>'actor','')='' OR length(p->>'actor')>200 OR
     coalesce(p->>'key','') !~ '^[A-Za-z0-9_-]{16,100}$' THEN
   RAISE EXCEPTION 'CAMPAIGN_STORE_IDENTITY';
  END IF;
 END IF;
 IF p_action='claim' THEN
  IF coalesce(p->>'hash','') !~ '^[0-9a-f]{64}$' OR
     coalesce(p->>'brand','') NOT IN ('aristo','fish') OR
     coalesce(p->>'action','') NOT IN ('salvar','validar','agendar','cancelar') THEN
   RAISE EXCEPTION 'CAMPAIGN_STORE_CLAIM';
  END IF;
  -- Serialize exactly one actor/key, including concurrent insertion. Never reclaim
  -- an old operation by time: its remote side effect may already have happened.
  PERFORM pg_advisory_xact_lock(hashtextextended('campaign-operation:'||jsonb_build_array(p->>'actor',p->>'key')::text,0));
  INSERT INTO public.shrigma_campaign_operation(actor,operation_key,request_hash,brand,action)
  VALUES(p->>'actor',p->>'key',p->>'hash',p->>'brand',p->>'action')
  ON CONFLICT(actor,operation_key) DO NOTHING RETURNING * INTO r;
  got:=FOUND;
  IF NOT got THEN
   SELECT * INTO STRICT r FROM public.shrigma_campaign_operation WHERE actor=p->>'actor' AND operation_key=p->>'key';
  END IF;
  RETURN jsonb_build_object('id',r.id,'lease',CASE WHEN got THEN r.lease ELSE NULL END,
   'hash',r.request_hash,'brand',r.brand,'action',r.action,'acquired',got,
   'state',r.state,'providerId',r.provider_id,'response',r.response);
 ELSIF p_action='get' THEN
  SELECT * INTO r FROM public.shrigma_campaign_operation WHERE actor=p->>'actor' AND operation_key=p->>'key';
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  -- Never expose the mutation token through operation polling.
  RETURN jsonb_build_object('id',r.id,'brand',r.brand,'action',r.action,'state',r.state,
    'providerId',r.provider_id,'response',r.response,'created_at',r.created_at,'updated_at',r.updated_at);
 ELSIF p_action IN ('provider','finish') THEN
  SELECT * INTO r FROM public.shrigma_campaign_operation WHERE id=(p->>'id')::uuid FOR UPDATE;
  IF NOT FOUND OR r.lease IS DISTINCT FROM (p->>'lease')::uuid THEN RAISE EXCEPTION 'CAMPAIGN_STORE_LEASE'; END IF;
  pid:=nullif(p->>'providerId','')::integer;
  IF pid IS NOT NULL AND pid<=0 THEN RAISE EXCEPTION 'CAMPAIGN_STORE_PROVIDER'; END IF;
  IF r.provider_id IS NOT NULL AND pid IS NOT NULL AND r.provider_id<>pid THEN RAISE EXCEPTION 'CAMPAIGN_STORE_PROVIDER_CONFLICT'; END IF;
  IF p_action='provider' THEN
   IF pid IS NULL OR r.state<>'pending' THEN RAISE EXCEPTION 'CAMPAIGN_STORE_STATE'; END IF;
   UPDATE public.shrigma_campaign_operation SET provider_id=pid,updated_at=clock_timestamp() WHERE id=r.id;
  ELSE
   IF coalesce(p->>'state','') NOT IN ('succeeded','rejected','outcome_unknown') OR
      jsonb_typeof(p->'response') IS DISTINCT FROM 'object' OR
      jsonb_typeof(p#>'{response,body}') IS DISTINCT FROM 'object' OR
      coalesce(p#>>'{response,status}','') !~ '^[1-5][0-9]{2}$' THEN
    RAISE EXCEPTION 'CAMPAIGN_STORE_RESULT';
   END IF;
   IF r.state<>'pending' THEN
    IF r.state=p->>'state' AND r.response=p->'response' AND r.provider_id IS NOT DISTINCT FROM coalesce(pid,r.provider_id) THEN RETURN '{"ok":true}'::jsonb; END IF;
    -- A late worker cannot overwrite an uncertain or completed result.
    RAISE EXCEPTION 'CAMPAIGN_STORE_FINALIZED';
   END IF;
   UPDATE public.shrigma_campaign_operation SET state=p->>'state',response=p->'response',
    provider_id=coalesce(pid,provider_id),updated_at=clock_timestamp() WHERE id=r.id;
  END IF;
  RETURN '{"ok":true}'::jsonb;
 ELSIF p_action IN ('validation_get','validation_set','validation_invalidate') THEN
  pid:=(p->>'providerId')::integer;
  IF pid IS NULL OR pid<=0 THEN RAISE EXCEPTION 'CAMPAIGN_STORE_PROVIDER'; END IF;
  IF p_action='validation_get' THEN
   SELECT validation INTO v FROM public.shrigma_campaign_validation WHERE provider_id=pid;
   RETURN coalesce(v-'_audience_fingerprint','null'::jsonb);
  ELSIF p_action='validation_invalidate' THEN
   DELETE FROM public.shrigma_campaign_validation WHERE provider_id=pid;
  ELSE
   v:=p->'validation';
   IF v ? 'audience' OR v ? '_audience_fingerprint' THEN RAISE EXCEPTION 'CAMPAIGN_STORE_VALIDATION'; END IF;
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR v->>'policy' IS DISTINCT FROM 'crm-campaign-v1' OR
      v->'ok' IS DISTINCT FROM 'true'::jsonb OR coalesce(v->>'version','')='' OR
      coalesce(v->>'validated_at','')='' THEN RAISE EXCEPTION 'CAMPAIGN_STORE_VALIDATION'; END IF;
   INSERT INTO public.shrigma_campaign_validation(provider_id,validation) VALUES(pid,v)
    ON CONFLICT(provider_id) DO UPDATE SET validation=excluded.validation,updated_at=clock_timestamp();
  END IF;
  RETURN '{"ok":true}'::jsonb;
 ELSE RAISE EXCEPTION 'CAMPAIGN_STORE_ACTION';
 END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_store(text,jsonb) FROM PUBLIC;
