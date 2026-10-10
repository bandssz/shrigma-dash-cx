-- The signing configuration is provisioned privately from the existing workflow.
-- Never rotate the signing secret as part of this migration: mailed links must work.
CREATE TABLE IF NOT EXISTS public.shrigma_nps_config (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), config jsonb NOT NULL
);
REVOKE ALL ON public.shrigma_nps_config FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.shrigma_nps_vote_sync (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subscriber_id integer NOT NULL REFERENCES subscribers(id),
 brand text NOT NULL CHECK(brand IN ('fish','aristo')), order_ref text NOT NULL,
 vote_date text NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','in_flight','synced','outcome_unknown','superseded')),
 task_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.shrigma_nps_vote_sync FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.shrigma_nps_sign(p text,e text) RETURNS text
LANGUAGE sql STABLE AS $$
 SELECT left(encode(hmac(convert_to(p||'|'||e,'UTF8'),convert_to(config->>'SECRET','UTF8'),'sha256'),'hex'),16)
 FROM public.shrigma_nps_config WHERE singleton
$$;

CREATE OR REPLACE FUNCTION public.shrigma_nps_prepare(b jsonb,piece_arg text)
RETURNS TABLE(brand text,email text,ref text,piece text,tx jsonb)
LANGUAGE plpgsql AS $$
DECLARE c jsonb;
BEGIN
 SELECT config INTO STRICT c FROM public.shrigma_nps_config WHERE singleton;
 brand=lower(coalesce(b->>'brand',''));email=lower(btrim(coalesce(b->>'email','')));
 ref=btrim(coalesce(nullif(b->>'order_number',''),b->>'ref',''));piece=piece_arg;
 IF brand NOT IN ('fish','aristo') OR piece NOT IN ('nps-d0','nps-d3') OR email='' OR ref='' THEN RAISE EXCEPTION 'NPS_INPUT_INVALID';END IF;
 tx=jsonb_build_object('subscriber_mode','external','subscriber_email',email,
  'template_id',CASE WHEN brand='fish' THEN CASE WHEN piece='nps-d0' THEN 29 ELSE 31 END ELSE CASE WHEN piece='nps-d0' THEN 28 ELSE 30 END END,
  'from_email',c->'FROM'->>brand,'content_type','html',
  'data',jsonb_build_object('first_name',coalesce(b->>'first_name',''),'order_number',ref,'nps_url',c->'LP'->>brand,'p',ref,'e',email,'s',public.shrigma_nps_sign(ref,email)));
 RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION public.shrigma_nps_record_vote(b jsonb)
RETURNS TABLE(response jsonb,sync_id uuid)
LANGUAGE plpgsql AS $$
DECLARE n int;p text=coalesce(b->>'p','');e text=lower(coalesce(b->>'e',''));
 m text=CASE WHEN b->>'m'='aristo' THEN 'aristo' ELSE 'fish' END;
 sub subscribers%ROWTYPE;prev jsonb;v jsonb;stamp text;bucket text;action text='novo';task text;days int;
BEGIN
 response=jsonb_build_object('ok',false,'error','assinatura inválida');
 -- The score contract is an integer 0..10. A malformed value must never be a vote.
 IF coalesce(b->>'n','') !~ '^(10|[0-9])$' THEN RETURN NEXT;RETURN;END IF;
 n=(b->>'n')::int;
 IF p='' OR e='' OR nullif(b->>'s','') IS NULL OR public.shrigma_nps_sign(p,e) IS NULL OR b->>'s' IS DISTINCT FROM public.shrigma_nps_sign(p,e) THEN RETURN NEXT;RETURN;END IF;
 SELECT * INTO sub FROM subscribers WHERE email=e FOR UPDATE;
 IF NOT FOUND THEN response=jsonb_build_object('ok',false,'error','subscriber não encontrado');RETURN NEXT;RETURN;END IF;
 prev=sub.attribs->'nps';
 SELECT (config->>'JANELA_DIAS')::int INTO STRICT days FROM public.shrigma_nps_config WHERE singleton;
 IF prev->>'order'=p THEN
  IF coalesce(prev->>'date','')<>'' AND now()>(prev->>'date')::timestamptz+make_interval(days=>days) THEN
   response=jsonb_build_object('ok',true,'locked',true,'motivo','janela de alteração expirada');RETURN NEXT;RETURN;
  END IF;
  IF prev->>'score'=n::text THEN response=jsonb_build_object('ok',true,'repetido',true);RETURN NEXT;RETURN;END IF;
  action='revoto';task=prev->>'task_id';
 END IF;
 stamp=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 bucket=CASE WHEN n<=6 THEN 'detrator' WHEN n<=8 THEN 'passivo' ELSE 'promotor' END;
 v=jsonb_build_object('order',p,'score',n,'bucket',bucket,'brand',m,'date',stamp,'task_id',task,
  'comment',CASE WHEN prev->>'order'=p THEN prev->'comment' ELSE 'null'::jsonb END,
  'area',CASE WHEN prev->>'order'=p THEN prev->'area' ELSE 'null'::jsonb END);
 UPDATE subscribers SET attribs=coalesce(attribs,'{}'::jsonb)||jsonb_build_object('nps',v),updated_at=now() WHERE id=sub.id;
 UPDATE public.shrigma_nps_vote_sync SET state='superseded',updated_at=now()
 WHERE subscriber_id=sub.id AND brand=m AND order_ref=p AND state='pending';
 INSERT INTO public.shrigma_nps_vote_sync(subscriber_id,brand,order_ref,vote_date,payload,task_id)
 VALUES(sub.id,m,p,stamp,v||jsonb_build_object('email',e),task) RETURNING id INTO sync_id;
 response=jsonb_build_object('ok',true,'acao',action,'nota',n,'bucket',bucket,'task_id',task);
 RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION public.shrigma_nps_claim_vote_sync(job uuid)
RETURNS TABLE(sync_id uuid,payload jsonb)
LANGUAGE plpgsql AS $$
DECLARE j public.shrigma_nps_vote_sync%ROWTYPE;
BEGIN
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job;
 IF NOT FOUND THEN RETURN;END IF;
 PERFORM 1 FROM subscribers WHERE id=j.subscriber_id FOR UPDATE;
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job FOR UPDATE;
 IF NOT FOUND OR j.state<>'pending' THEN RETURN;END IF;
 -- Serialize side effects for the same subscriber, including concurrent revotes.
 IF EXISTS(SELECT 1 FROM public.shrigma_nps_vote_sync WHERE subscriber_id=j.subscriber_id AND id<>j.id AND state IN ('in_flight','outcome_unknown')) THEN RETURN;END IF;
 UPDATE public.shrigma_nps_vote_sync SET state='in_flight',updated_at=now() WHERE id=j.id;
 sync_id=j.id;payload=j.payload;
 SELECT payload||jsonb_build_object('task_id',coalesce(attribs->'nps'->>'task_id',j.task_id)) INTO payload FROM subscribers
 WHERE id=j.subscriber_id AND attribs->'nps'->>'order'=j.order_ref;
 IF payload IS NULL THEN payload=j.payload;END IF;
 RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION public.shrigma_nps_finish_vote_sync(job uuid,result jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j public.shrigma_nps_vote_sync%ROWTYPE;t text=nullif(result->>'task_id','');
BEGIN
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM 1 FROM subscribers WHERE id=j.subscriber_id FOR UPDATE;
 SELECT * INTO j FROM public.shrigma_nps_vote_sync WHERE id=job FOR UPDATE;
 IF NOT FOUND OR j.state<>'in_flight' THEN RETURN false;END IF;
 UPDATE public.shrigma_nps_vote_sync SET state=CASE WHEN result->>'ok'='true' AND t IS NOT NULL THEN 'synced' ELSE 'outcome_unknown' END,
 task_id=coalesce(t,task_id),updated_at=now() WHERE id=job;
 IF t IS NOT NULL THEN
  -- Only attach the external ID; never rewrite a newer score or a concurrent comment.
  UPDATE subscribers SET attribs=jsonb_set(attribs,'{nps,task_id}',to_jsonb(t)),updated_at=now()
  WHERE id=j.subscriber_id AND attribs->'nps'->>'order'=j.order_ref AND attribs->'nps'->>'brand'=j.brand;
 END IF;
 RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.shrigma_nps_sign(text,text), public.shrigma_nps_prepare(jsonb,text),
 public.shrigma_nps_record_vote(jsonb), public.shrigma_nps_claim_vote_sync(uuid),
 public.shrigma_nps_finish_vote_sync(uuid,jsonb) FROM PUBLIC;
