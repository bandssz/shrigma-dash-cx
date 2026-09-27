-- Growth Aristo VIP only. No transport, dispatch, replay policy or PUBLIC grant.
-- Trusted server caller must already have validated the actual form and MX.
BEGIN;
CREATE OR REPLACE FUNCTION public.shrigma_crm_vip_subscribe_v1(
 p_email text,p_origem text,p_corrigido boolean,p_source text
) RETURNS TABLE(eligible boolean,reason text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='500ms' AS $vip$
DECLARE
 sid integer; subscriber_status text; membership_status text; lid integer;
 created boolean:=false; refusal text; flag jsonb;
BEGIN
 IF p_source IS NULL OR p_source NOT IN ('alma','desodorante') THEN
  RETURN QUERY SELECT false,'invalid_source'::text;RETURN;
 END IF;
 -- Preserve upstream normalization; never correct or infer another address here.
 IF p_email IS NULL OR octet_length(p_email)>254 OR p_email<>lower(btrim(p_email))
  OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}$'
  OR p_origem IS NULL OR char_length(p_origem) NOT BETWEEN 1 AND 64
  OR p_origem ~ '[[:cntrl:]]' OR p_corrigido IS NULL THEN
  RETURN QUERY SELECT false,'invalid_input'::text;RETURN;
 END IF;
 flag:=CASE WHEN p_source='desodorante' OR p_origem='lp-desodorante-frescor'
  THEN jsonb_build_object('vip_desodorante',true)
  ELSE jsonb_build_object('vip_alma_da_roca',true) END;
 BEGIN
  INSERT INTO public.subscribers(uuid,email,name,status,attribs)
  VALUES(gen_random_uuid(),p_email,split_part(p_email,'@',1),'enabled',
   jsonb_build_object('origem',p_origem,'email_corrigido',p_corrigido)||flag)
  ON CONFLICT(email) DO NOTHING RETURNING id INTO sid;
  created:=FOUND;
  -- Separate statements under READ COMMITTED see committed opt-out after waits.
  SELECT s.id,s.status::text INTO sid,subscriber_status
   FROM public.subscribers s WHERE s.email=p_email FOR UPDATE;
  IF NOT FOUND OR subscriber_status IS DISTINCT FROM 'enabled' THEN
   refusal:='subscriber_unavailable';RAISE EXCEPTION USING ERRCODE='PV001',MESSAGE='VIP_CONSENT_DENIED';
  END IF;
  -- Native bulk blocklist can hold lists before subscriber. Yield instead of
  -- waiting in the opposite order; never reconfirm or send on uncertain consent.
  FOREACH lid IN ARRAY ARRAY[16,19] LOOP
   SELECT sl.status::text INTO membership_status FROM public.subscriber_lists sl
    WHERE sl.subscriber_id=sid AND sl.list_id=lid FOR UPDATE NOWAIT;
   IF NOT FOUND THEN
    INSERT INTO public.subscriber_lists(subscriber_id,list_id,meta,status,created_at,updated_at)
     VALUES(sid,lid,'{}','confirmed',now(),now())
     ON CONFLICT(subscriber_id,list_id) DO NOTHING;
    -- A native insert can win while the unique check waits. Read its status.
    SELECT sl.status::text INTO membership_status FROM public.subscriber_lists sl
     WHERE sl.subscriber_id=sid AND sl.list_id=lid FOR UPDATE NOWAIT;
   END IF;
   IF NOT FOUND OR membership_status IS DISTINCT FROM 'confirmed' THEN
    refusal:=CASE membership_status WHEN 'unsubscribed' THEN 'list_unsubscribed'
      WHEN 'unconfirmed' THEN 'list_unconfirmed' ELSE 'membership_unavailable' END;
    RAISE EXCEPTION USING ERRCODE='PV001',MESSAGE='VIP_CONSENT_DENIED';
   END IF;
  END LOOP;
  -- Only after both consents are proven. Blocked subscribers keep all attributes.
  IF NOT created THEN
   UPDATE public.subscribers s SET attribs=coalesce(s.attribs,'{}'::jsonb)||flag,updated_at=now()
    WHERE s.id=sid;
  END IF;
 EXCEPTION WHEN lock_not_available THEN
  -- Includes bounded unique/FK waits on missing links. Roll back every local
  -- write and let native opt-out complete; this result never authorizes sending.
  RETURN QUERY SELECT false,'consent_busy'::text;RETURN;
 WHEN SQLSTATE 'PV001' THEN
  -- Revert this call's new subscriber/list rows and flags, not the native opt-out.
  IF refusal IS NULL OR SQLERRM<>'VIP_CONSENT_DENIED' THEN RAISE;END IF;
  RETURN QUERY SELECT false,refusal;RETURN;
 END;
 RETURN QUERY SELECT true,CASE WHEN created THEN 'created' ELSE 'eligible' END;
END $vip$;
REVOKE ALL ON FUNCTION public.shrigma_crm_vip_subscribe_v1(text,text,boolean,text) FROM PUBLIC;
COMMIT;
