-- A reminder requires a confirmed initial message for the same brand, order and contact.
-- Historical initial messages use the durable send log; conflicting outbox states block.
CREATE OR REPLACE FUNCTION public.shrigma_nps_initial_confirmed(p_brand text,p_ref text,p_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
 SELECT p_brand IN ('fish','aristo') AND EXISTS(
  SELECT 1 FROM public.shrigma_send_log l
  WHERE l.brand=p_brand AND l.flow='nps' AND l.channel='email' AND l.piece='nps-d0'
   AND l.ref=p_ref AND lower(l.email)=lower(p_email) AND l.erro IS NULL
 ) AND NOT EXISTS(
  SELECT 1 FROM public.shrigma_email_dispatch d
  WHERE d.brand=p_brand AND d.flow='nps' AND d.piece='nps-d0' AND NOT d.is_test
   AND d.dedupe_key=jsonb_build_array('email',p_ref,'order',false)::text
   AND (d.transport_state<>'accepted' OR EXISTS(
    SELECT 1 FROM public.shrigma_email_status s WHERE s.dispatch_id=d.dispatch_id
     AND s.reconciliation_status='matched' AND NOT s.is_test
     AND s.status IN ('bounce','complaint','reject','rendering_failure')
   ))
 );
$f$;
REVOKE ALL ON FUNCTION public.shrigma_nps_initial_confirmed(text,text,text) FROM PUBLIC;
