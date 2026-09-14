-- Explicit, audited repair of the prior Listmonk lowercase transport mismatch.
-- Does not infer recipients, resend emails, or alter archived SNS payloads.
CREATE TABLE public.shrigma_email_address_correction (
 dispatch_id uuid PRIMARY KEY REFERENCES public.shrigma_email_dispatch(dispatch_id),
 reason text NOT NULL CHECK(reason='listmonk_external_lowercase_contract'),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 canonical_key text NOT NULL,
 original_dispatch jsonb NOT NULL,
 original_statuses jsonb NOT NULL,
 original_ingest_states jsonb NOT NULL
);
REVOKE ALL ON public.shrigma_email_address_correction FROM PUBLIC;
CREATE FUNCTION public.shrigma_email_reconcile_address_case(p_id uuid)
RETURNS TABLE(result text,events integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE d public.shrigma_email_dispatch%ROWTYPE;l public.shrigma_send_log%ROWTYPE;
 canonical text;original text;version text;ids bigint[];keys text[];n int;valid boolean;
BEGIN
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.shrigma_email_address_correction a WHERE a.dispatch_id=p_id) THEN
  IF NOT EXISTS(SELECT 1 FROM public.shrigma_email_address_correction a WHERE a.dispatch_id=p_id AND a.canonical_key=d.recipient_key) THEN RAISE EXCEPTION 'ADDRESS_REPAIR_AUDIT_MISMATCH';END IF;
  RETURN QUERY SELECT 'already_applied'::text,0;RETURN;
 END IF;
 IF d.brand NOT IN ('fish','aristo') OR d.flow<>'transacional' OR d.transport_state<>'accepted' OR d.is_test OR d.send_log_id IS NULL THEN RAISE EXCEPTION 'ADDRESS_REPAIR_SCOPE_INVALID';END IF;
 SELECT * INTO STRICT l FROM public.shrigma_send_log WHERE id=d.send_log_id;
 SELECT r.recipient_key,r.key_version INTO original,version FROM public.shrigma_email_recipient_key(l.email) r;
 SELECT r.recipient_key INTO canonical FROM public.shrigma_email_recipient_key(lower(l.email)) r;
 IF original IS DISTINCT FROM d.recipient_key OR canonical=original OR version<>d.recipient_key_version OR l.brand<>d.brand OR l.flow<>d.flow OR l.piece<>d.piece OR l.channel<>'email' THEN RAISE EXCEPTION 'ADDRESS_REPAIR_LOG_MISMATCH';END IF;
 PERFORM 1 FROM public.shrigma_email_status s WHERE s.dispatch_id_claim=p_id FOR UPDATE;
 SELECT count(*)::int,array_agg(s.first_ingest_id),array_agg(s.event_key),bool_and(
  s.reconciliation_status='conflict' AND s.dispatch_id IS NULL AND s.is_test IS NULL AND s.is_test_claim=false
  AND s.recipient_key=canonical AND s.recipient_key_version=version AND s.account_id=d.account_id AND s.region=d.region
  AND (i.event_payload#>>'{mail,destination,0}')=lower(l.email)
  AND (i.event_payload#>>'{mail,tags,ses:configuration-set,0}')=d.configuration_set
  AND (i.event_payload#>>'{mail,tags,crm_dispatch_id,0}')=p_id::text
  AND (i.event_payload#>>'{mail,tags,crm_test,0}')='false'
  AND NOT EXISTS(SELECT 1 FROM public.shrigma_email_message_link m WHERE m.account_id=s.account_id AND m.region=s.region AND m.message_id=s.message_id AND m.dispatch_id<>p_id)
 ) INTO n,ids,keys,valid
 FROM public.shrigma_email_status s JOIN public.shrigma_email_event_ingest i ON i.ingest_id=s.first_ingest_id WHERE s.dispatch_id_claim=p_id;
 IF n=0 OR valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'ADDRESS_REPAIR_EVENT_MISMATCH';END IF;
 INSERT INTO public.shrigma_email_address_correction(dispatch_id,reason,canonical_key,original_dispatch,original_statuses,original_ingest_states)
 SELECT p_id,'listmonk_external_lowercase_contract',canonical,to_jsonb(d),
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.event_key) FROM public.shrigma_email_status s WHERE s.event_key=ANY(keys)),
  (SELECT jsonb_agg(jsonb_build_object('ingest_id',i.ingest_id,'result',i.result,'error_code',i.error_code) ORDER BY i.ingest_id) FROM public.shrigma_email_event_ingest i WHERE i.ingest_id=ANY(ids));
 UPDATE public.shrigma_email_dispatch x SET recipient_key=canonical WHERE x.dispatch_id=p_id;
 INSERT INTO public.shrigma_email_message_link(account_id,region,message_id,dispatch_id)
 SELECT DISTINCT s.account_id,s.region,s.message_id,p_id FROM public.shrigma_email_status s WHERE s.event_key=ANY(keys) ON CONFLICT DO NOTHING;
 UPDATE public.shrigma_email_status s SET dispatch_id=p_id,is_test=false,reconciliation_status='matched' WHERE s.event_key=ANY(keys);
 UPDATE public.shrigma_email_event_ingest i SET result='processed',error_code=NULL WHERE i.ingest_id=ANY(ids);
 RETURN QUERY SELECT 'reconciled'::text,n;
END;$f$;
REVOKE ALL ON FUNCTION public.shrigma_email_reconcile_address_case(uuid) FROM PUBLIC;
