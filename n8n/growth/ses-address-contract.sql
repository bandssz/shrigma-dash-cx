CREATE OR REPLACE FUNCTION public.shrigma_flow_email_claim_tx(p_brand text, p_body jsonb)
 RETURNS TABLE(should_send boolean, dispatch_id uuid, claim_token uuid, payload jsonb, context jsonb, reason text)
 LANGUAGE plpgsql
AS $function$
DECLARE b jsonb:=p_body;s jsonb;r record;
BEGIN
 IF p_brand NOT IN ('fish','aristo') THEN RAISE EXCEPTION 'FLOW_BRAND_INVALID';END IF;
 -- Listmonk transports external transactional addresses in lowercase. Capture
 -- that exact address before reserving; finish uses the returned context.
 IF jsonb_typeof(b->'email')='string' THEN b:=b||jsonb_build_object('email',lower(b->>'email'));END IF;
 s:=shrigma_flow_slot(p_brand,'email','transacional','pedido-'||(b->>'event_type'));
 IF (s->>'_managed')::boolean THEN
  IF NOT (s->>'_allowed')::boolean THEN RETURN QUERY SELECT false,NULL::uuid,NULL::uuid,NULL::jsonb,NULL::jsonb,'flow_paused';RETURN;END IF;
  -- The captured body is returned as context, so a publication during HTTP cannot change the finish fingerprint.
  b:=b||jsonb_build_object('template_id',(s->>'template_id')::int);
  IF s->>'template_id' IS DISTINCT FROM p_body->>'template_id' THEN
   b:=b||jsonb_build_object('subject',(SELECT subject FROM templates WHERE id=(s->>'template_id')::int));END IF;
 END IF;
 IF p_brand='fish' THEN SELECT * INTO r FROM shrigma_email_claim_fish(b,false);
 ELSE SELECT * INTO r FROM shrigma_email_claim_aristo(b,false);END IF;
 RETURN QUERY SELECT r.should_send,r.dispatch_id,r.claim_token,r.payload,b,r.reason;
END $function$;
