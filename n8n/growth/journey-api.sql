-- Apply with the checked journey migration; archive controls preserve historical rows.
CREATE OR REPLACE FUNCTION public.shrigma_flow_api(actor text, caps jsonb, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET lock_timeout TO '3s'
AS $function$
DECLARE a text:=p->>'acao';f shrigma_flow_definition%ROWTYPE;i shrigma_flow_request%ROWTYPE;
 response jsonb;errors jsonb;nextdef jsonb;v_idem text:=p->>'idempotency_key';expected integer;needed text;
BEGIN
 needed:=CASE a WHEN 'fluxos_listar' THEN 'read_content' WHEN 'fluxo_salvar' THEN 'draft'
 WHEN 'fluxo_validar' THEN 'validate' WHEN 'fluxo_publicar' THEN 'submit' WHEN 'fluxo_estado' THEN 'submit' END;
 IF actor IS NULL OR needed IS NULL OR NOT (caps ? needed) THEN RETURN jsonb_build_object('_http',403,'_body',jsonb_build_object('erro','capability_missing'));END IF;
 IF a='fluxos_listar' THEN
  RETURN jsonb_build_object('_http',200,'_body',jsonb_build_object('flows',coalesce((SELECT jsonb_agg(shrigma_flow_public_row(d) ORDER BY brand,name) FROM shrigma_flow_definition d WHERE d.binding->>'merged_into' IS NULL AND (coalesce(p->>'marca','') IN ('','todas') OR d.brand=p->>'marca')),'[]'::jsonb),'checked_at',now()));END IF;
 IF coalesce(v_idem,'')!~'^[A-Za-z0-9_.:-]{8,128}$' OR coalesce(p->>'expected_version','')!~'^[1-9][0-9]{0,8}$' THEN
  RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('erro','versao_e_idempotencia_obrigatorias'));END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('flow-idem:'||v_idem,0));
 SELECT * INTO i FROM shrigma_flow_request WHERE shrigma_flow_request.idem=v_idem;
 IF FOUND THEN
  IF i.actor IS DISTINCT FROM actor OR i.payload IS DISTINCT FROM p THEN RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','idempotency_replay_mismatch'));END IF;
  RETURN i.response;END IF;
 SELECT * INTO f FROM shrigma_flow_definition WHERE key=p->>'key' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('_http',404,'_body',jsonb_build_object('erro','fluxo_nao_encontrado'));END IF;
 IF f.binding->>'merged_into' IS NOT NULL THEN RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','jornada_unificada','key',f.binding->>'merged_into'));END IF;
 expected:=(p->>'expected_version')::integer;
 IF f.version<>expected THEN RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','version_conflict','current_version',f.version,'changed_by',f.updated_by,'changed_at',f.updated_at));END IF;
 nextdef:=CASE WHEN a='fluxo_salvar' THEN p->'definition' ELSE f.draft END;
 errors:=shrigma_flow_validate(nextdef,f.binding);
 IF jsonb_array_length(errors)>0 THEN RETURN jsonb_build_object('_http',422,'_body',jsonb_build_object('erro','validation','messages',errors));END IF;
 IF a='fluxo_salvar' THEN
  UPDATE shrigma_flow_definition SET draft=nextdef,version=version+1,updated_by=actor,updated_at=now() WHERE key=f.key RETURNING * INTO f;
 ELSIF a='fluxo_publicar' THEN
  IF NOT f.runtime_ready THEN RETURN jsonb_build_object('_http',409,'_body',jsonb_build_object('erro','runtime_nao_conectado'));END IF;
  IF p->>'confirm' IS DISTINCT FROM 'publicar' THEN RETURN jsonb_build_object('_http',400,'_body',jsonb_build_object('erro','confirm_obrigatorio'));END IF;
  INSERT INTO shrigma_flow_revision(flow_key,version,definition,actor) VALUES(f.key,f.version,f.draft,actor) ON CONFLICT DO NOTHING;
  UPDATE shrigma_flow_definition SET name=draft->>'name',published=draft,published_version=version,updated_by=actor,updated_at=now() WHERE key=f.key RETURNING * INTO f;
 ELSIF a='fluxo_estado' THEN
  IF NOT f.runtime_ready OR jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean' THEN RETURN jsonb_build_object('_http',422,'_body',jsonb_build_object('erro','estado_indisponivel'));END IF;
  UPDATE shrigma_flow_definition SET enabled=(p->>'enabled')::boolean,version=version+1,published_version=CASE WHEN draft=published THEN version+1 ELSE published_version END,updated_by=actor,updated_at=now() WHERE key=f.key RETURNING * INTO f;
 END IF;
 INSERT INTO shrigma_flow_audit(flow_key,actor,action,version,detail) VALUES(f.key,actor,a,f.version,jsonb_build_object('enabled',f.enabled,'published_version',f.published_version));
 response:=jsonb_build_object('_http',200,'_body',jsonb_build_object('flow',shrigma_flow_public_row(f),'valid',true));
 INSERT INTO shrigma_flow_request(idem,actor,payload,response) VALUES(v_idem,actor,p,response);
 RETURN response;
END $function$;
CREATE OR REPLACE FUNCTION public.shrigma_flow_public_row(f shrigma_flow_definition)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
 SELECT jsonb_build_object('key',f.key,'brand',f.brand,'name',f.name,'trigger',f.trigger,
 'version',f.version,'published_version',f.published_version,'draft',f.draft,'published',f.published,
 'enabled',f.enabled,'runtime_ready',f.runtime_ready,'available_steps',f.binding->'steps','journey_kind',f.binding->>'journey_kind',
 'updated_at',f.updated_at,'updated_by',f.updated_by)
$function$;
