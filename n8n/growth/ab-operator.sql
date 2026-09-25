-- Growth-only bridge. The existing operator authentication function is read, never changed.
-- Keep the legacy registry endpoint/principal available for its existing operation journal.
CREATE OR REPLACE FUNCTION public.crm_ab_operator_registry_v1(k text, p_mode text, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE identity jsonb; needed text; actor text; brand text; result jsonb;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('write','operation','record','capabilities')
   OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'AB_INVALID_REQUEST'; END IF;
 identity:=public.shrigma_crm_operator_auth_v1(k);
 IF jsonb_typeof(identity->'label') IS DISTINCT FROM 'string' OR coalesce(identity->>'label','')=''
   OR jsonb_typeof(identity->'caps') IS DISTINCT FROM 'array' THEN
  RETURN jsonb_build_object('status',401,'body',jsonb_build_object('ok',false,'code','operator_access_required'));
 END IF;
 needed:=CASE WHEN p_mode='write' THEN 'draft' ELSE 'read_content' END;
 IF NOT (identity->'caps' ? needed) THEN
  RETURN jsonb_build_object('status',403,'body',jsonb_build_object('ok',false,'code','capability_missing'));
 END IF;
 -- A rotated key for the same authenticated operator retains the same authorship.
 -- The prefix separates this identity from every legacy shared-key digest.
 actor:=encode(sha256(convert_to('ab-registry-operator-v1:'||(identity->>'label'),'UTF8')),'hex');
 IF p_mode='write' AND p->>'action'='criar' THEN brand:=p#>>'{request_payload,teste,marca}';
 ELSIF p_mode<>'capabilities' THEN SELECT marca INTO brand FROM public.crm_teste WHERE teste_id=p->>'teste_id'; END IF;
 IF brand IS NOT NULL AND brand NOT IN ('fish','aristo') THEN
  RETURN jsonb_build_object('status',403,'body',jsonb_build_object('ok',false,'code','brand_scope'));
 END IF;
 result:=public.crm_ab_registry_v1(p_mode,jsonb_set(p,'{actor_sha256}',to_jsonb(actor),true));
 IF p_mode='capabilities' THEN
  result:=jsonb_set(result,'{body}',result->'body'||jsonb_build_object('access','crm_operator',
   'write',identity->'caps' ? 'draft','brands',jsonb_build_array('fish','aristo')));
 END IF;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.crm_ab_operator_registry_v1(text,text,jsonb) FROM PUBLIC;
