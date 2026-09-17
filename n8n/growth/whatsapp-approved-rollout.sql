-- Narrow rollout of the specifically reviewed 17 September templates.
-- A new approval never activates an arbitrary template or overwrites a later edit.
CREATE TABLE IF NOT EXISTS public.shrigma_wa_review_rollout (
 template_id text PRIMARY KEY,brand text NOT NULL,template_name text NOT NULL,
 flow_key text NOT NULL,step_key text NOT NULL,source_id text NOT NULL,
 expected_version bigint NOT NULL,expected_content jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending',provider_status text,checked_at timestamptz,activated_at timestamptz,reason text
);
CREATE OR REPLACE FUNCTION public.shrigma_wa_review_content(cs jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object(
 'body',(SELECT c->>'text' FROM jsonb_array_elements(cs)c WHERE c->>'type'='BODY'),
 'header',(SELECT jsonb_build_object('text',c->>'text','format',c->>'format') FROM jsonb_array_elements(cs)c WHERE c->>'type'='HEADER'),
 'footer',(SELECT c->>'text' FROM jsonb_array_elements(cs)c WHERE c->>'type'='FOOTER'),
 'buttons',(SELECT jsonb_agg(jsonb_build_object('type',b->>'type','text',b->>'text','url',b->>'url') ORDER BY ord)
 FROM jsonb_array_elements(cs)c CROSS JOIN LATERAL jsonb_array_elements(c->'buttons') WITH ORDINALITY x(b,ord) WHERE c->>'type'='BUTTONS'));
$$;
CREATE OR REPLACE FUNCTION public.shrigma_wa_review_activate(catalog jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE f public.shrigma_flow_definition%ROWTYPE;j public.shrigma_wa_review_rollout%ROWTYPE;
 t jsonb;b jsonb;d jsonb;p jsonb;fields jsonb;err jsonb;changed boolean;total int:=0;
BEGIN
 IF jsonb_typeof(catalog) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_CATALOG';END IF;
 FOR f IN SELECT x.* FROM public.shrigma_flow_definition x WHERE EXISTS(SELECT 1 FROM public.shrigma_wa_review_rollout job WHERE job.flow_key=x.key AND job.state='pending') ORDER BY x.key FOR UPDATE LOOP
  b:=f.binding;d:=f.draft;p:=f.published;changed:=false;
  IF EXISTS(SELECT 1 FROM public.shrigma_wa_review_rollout job WHERE job.flow_key=f.key AND job.state='pending' AND job.expected_version<>f.version) THEN
   UPDATE public.shrigma_wa_review_rollout SET state='blocked',reason='journey_changed',checked_at=now() WHERE flow_key=f.key AND state='pending';CONTINUE;
  END IF;
  FOR j IN SELECT * FROM public.shrigma_wa_review_rollout WHERE flow_key=f.key AND state='pending' ORDER BY template_id FOR UPDATE LOOP
   SELECT x INTO t FROM jsonb_array_elements(catalog)x WHERE x->>'id'=j.template_id AND x->>'brand'=j.brand LIMIT 1;
   UPDATE public.shrigma_wa_review_rollout SET provider_status=t->>'status',checked_at=now() WHERE template_id=j.template_id;
   IF t IS NULL OR t->>'status' IS DISTINCT FROM 'APPROVED' THEN CONTINUE;END IF;
   IF t->>'name' IS DISTINCT FROM j.template_name OR t->>'language' IS DISTINCT FROM 'pt_BR' OR t->>'category' IS DISTINCT FROM 'UTILITY' OR public.shrigma_wa_review_content(t->'components') IS DISTINCT FROM j.expected_content THEN
    UPDATE public.shrigma_wa_review_rollout SET state='blocked',reason='approved_content_differs' WHERE template_id=j.template_id;CONTINUE;
   END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'steps')s WHERE s->>'key'=j.step_key AND s->>'template_id'=j.source_id) THEN
    UPDATE public.shrigma_wa_review_rollout SET state='blocked',reason='source_template_changed' WHERE template_id=j.template_id;CONTINUE;
   END IF;
   INSERT INTO public.shrigma_flow_template(brand,id,data) VALUES(j.brand,j.template_id,t) ON CONFLICT(brand,id) DO UPDATE SET data=excluded.data;
   fields:=jsonb_build_object('template_id',j.template_id,'template_name',j.template_name,'category','UTILITY','signature',public.shrigma_wa_signature(t->'components'));
   SELECT jsonb_set(b,'{steps}',jsonb_agg(CASE WHEN s->>'key'=j.step_key THEN s||fields ELSE s END ORDER BY pos)) INTO b FROM jsonb_array_elements(b->'steps') WITH ORDINALITY x(s,pos);
   SELECT jsonb_set(d,'{steps}',jsonb_agg(CASE WHEN s->>'key'=j.step_key THEN s||fields ELSE s END ORDER BY pos)) INTO d FROM jsonb_array_elements(d->'steps') WITH ORDINALITY x(s,pos);
   SELECT jsonb_set(p,'{steps}',jsonb_agg(CASE WHEN s->>'key'=j.step_key THEN s||fields ELSE s END ORDER BY pos)) INTO p FROM jsonb_array_elements(p->'steps') WITH ORDINALITY x(s,pos);
   UPDATE public.shrigma_wa_review_rollout SET state='active',activated_at=now(),reason=NULL WHERE template_id=j.template_id;changed:=true;total:=total+1;
  END LOOP;
  IF changed THEN
   err:=public.shrigma_flow_validate(p,b);IF err<>'[]'::jsonb THEN RAISE EXCEPTION 'ROLLOUT_INVALID: %',err;END IF;
   UPDATE public.shrigma_flow_definition SET binding=b,draft=d,published=p,version=version+1,published_version=version+1,updated_at=now(),updated_by='revisao-aprovada-20260917' WHERE key=f.key;
   INSERT INTO public.shrigma_flow_revision(flow_key,version,definition,actor) VALUES(f.key,f.version+1,p,'revisao-aprovada-20260917');
   UPDATE public.shrigma_wa_review_rollout SET expected_version=f.version+1 WHERE flow_key=f.key AND state='pending';
  END IF;
 END LOOP;
 RETURN jsonb_build_object('activated',total,'pending',(SELECT count(*) FROM public.shrigma_wa_review_rollout WHERE state='pending'),'blocked',(SELECT count(*) FROM public.shrigma_wa_review_rollout WHERE state='blocked'));
END $$;
