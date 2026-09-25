-- SELECT-only receipt lookup. Missing never proves that an in-flight request failed.
-- Authentication supplies actor/caps; callers cannot choose another actor's receipt.
CREATE OR REPLACE FUNCTION public.shrigma_flow_operation_v1(actor text,caps jsonb,p jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $function$
DECLARE i public.shrigma_flow_request%ROWTYPE; a text:=p->>'operation_action';
 needed text; operation jsonb; v_idem text:=p->>'idempotency_key';
BEGIN
 needed:=CASE a WHEN 'fluxo_salvar' THEN 'draft' WHEN 'fluxo_publicar' THEN 'submit' WHEN 'fluxo_estado' THEN 'submit' END;
 IF coalesce(actor,'')='' OR needed IS NULL OR NOT coalesce(caps ? needed,false) THEN
  RETURN jsonb_build_object('_http',403,'_body',jsonb_build_object('erro','capability_missing'));END IF;
 IF coalesce(v_idem,'')!~'^[A-Za-z0-9_.:-]{8,128}$' THEN
  RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('erro','idempotency_key_obrigatoria'));END IF;
 operation:=jsonb_build_object('actor',actor,'idempotency_key',v_idem,'acao',a,'state','missing','request_payload',NULL,'response',NULL);
 SELECT * INTO i FROM public.shrigma_flow_request WHERE idem=v_idem;
 IF FOUND THEN
  IF i.actor IS DISTINCT FROM actor OR i.payload->>'acao' IS DISTINCT FROM a THEN
   RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','operation_identity_mismatch'));END IF;
  operation:=operation||jsonb_build_object('state','completed','request_payload',i.payload,'response',i.response);
 END IF;
 RETURN jsonb_build_object('_http',200,'_body',jsonb_build_object('contract','flow_operation_v1','operation',operation));
END $function$;
