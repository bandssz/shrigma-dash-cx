-- Preserve required NPS link variables when selecting an email template.
CREATE OR REPLACE FUNCTION public.shrigma_flow_validate(p jsonb, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE errors jsonb:='[]';s jsonb;slot jsonb;ids text[]:='{}';n numeric;t jsonb;v text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR length(btrim(coalesce(p->>'name',''))) NOT BETWEEN 1 AND 120 THEN
  RETURN jsonb_build_array('Informe o nome do fluxo.'); END IF;
 IF jsonb_typeof(p->'steps') IS DISTINCT FROM 'array' THEN
  RETURN jsonb_build_array('Etapas precisam ser uma lista.'); END IF;
 IF jsonb_array_length(p->'steps') NOT BETWEEN 1 AND 32 THEN
  RETURN jsonb_build_array('O fluxo precisa ter de uma a 32 etapas.'); END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'steps') LOOP
  SELECT value INTO slot FROM jsonb_array_elements(b->'steps') WHERE value->>'key'=s->>'key';
  IF slot IS NULL THEN errors:=errors||jsonb_build_array('Etapa sem conexão com o gatilho: '||coalesce(s->>'key','?'));CONTINUE;END IF;
  IF s->>'key'=ANY(ids) THEN errors:=errors||jsonb_build_array('Etapa repetida: '||(s->>'key'));END IF;
  ids:=array_append(ids,s->>'key');
  IF jsonb_typeof(s->'enabled') IS DISTINCT FROM 'boolean' THEN errors:=errors||jsonb_build_array('Informe se a etapa está ativa.');END IF;
  IF coalesce(s->>'wait_min','')!~'^[0-9]+([.][0-9]+)?$' THEN errors:=errors||jsonb_build_array('Espera inválida.');
  ELSE n:=(s->>'wait_min')::numeric;
   IF n<(slot->>'min_wait')::numeric OR n>(slot->>'max_wait')::numeric THEN
    errors:=errors||jsonb_build_array('Espera fora da janela do gatilho na etapa '||(slot->>'name'));END IF;
  END IF;
  IF s->>'channel' IS DISTINCT FROM slot->>'channel' OR s->>'piece' IS DISTINCT FROM slot->>'piece' THEN
   errors:=errors||jsonb_build_array('Canal ou identidade da etapa não correspondem ao gatilho.');END IF;
  IF slot->>'kind'='interactive' THEN
   IF length(coalesce(s->>'body','')) NOT BETWEEN 1 AND 1024 THEN errors:=errors||jsonb_build_array('Texto obrigatório, até 1024 caracteres.');END IF;
  ELSIF coalesce(s->>'template_id','')!~'^[0-9]+$' OR length(coalesce(s->>'template_name','')) NOT BETWEEN 1 AND 512 THEN
   errors:=errors||jsonb_build_array('Escolha um template para a etapa '||(slot->>'name'));
  ELSIF s->>'channel'='whatsapp' THEN
   SELECT data INTO t FROM shrigma_flow_template WHERE brand=b->>'brand' AND id=s->>'template_id';
   IF t IS NULL OR t->>'status' IS DISTINCT FROM 'APPROVED' OR t->>'name' IS DISTINCT FROM s->>'template_name'
      OR t->>'language' IS DISTINCT FROM 'pt_BR' OR shrigma_wa_signature(t->'components') IS DISTINCT FROM slot->'signature'
      OR (slot->>'category'='UTILITY' AND t->>'category' IS DISTINCT FROM 'UTILITY') THEN
    errors:=errors||jsonb_build_array('Template WhatsApp não aprovado ou incompatível com os dados desta etapa: '||(slot->>'name'));
   END IF;
  ELSIF s->>'channel'='email' THEN
   SELECT jsonb_build_object('name',x.name,'body',x.body,'subject',x.subject,'draft_id',r.draft_id) INTO t
    FROM templates x JOIN shrigma_template_email_registry r ON r.template_id=x.id
    WHERE x.id::text=s->>'template_id' AND r.brand=b->>'brand' AND x.type='tx';
   IF t IS NULL OR t->>'name' IS DISTINCT FROM s->>'template_name' THEN
    errors:=errors||jsonb_build_array('Template de e-mail não pertence à marca.');
   END IF;
   IF t IS NOT NULL THEN
    FOR v IN SELECT jsonb_array_elements_text(coalesce(slot->'required_variables','[]')) LOOP
     IF NOT EXISTS(SELECT 1 FROM regexp_matches(coalesce(t->>'body','')||coalesce(t->>'subject',''),'\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]*)','g') m WHERE m[1]=v) THEN
      errors:=errors||jsonb_build_array('Preserve o dado obrigatório da jornada: '||v);
     END IF;
    END LOOP;
   END IF;
   IF t IS NOT NULL AND s->>'template_id' IS DISTINCT FROM slot->>'template_id' THEN
    IF t->>'draft_id' IS NULL THEN errors:=errors||jsonb_build_array('Para trocar o e-mail, crie uma versão compatível no editor.');
    ELSE
     FOR v IN SELECT DISTINCT m[1] FROM regexp_matches(coalesce(t->>'body','')||coalesce(t->>'subject',''),'\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]*)','g') m LOOP
      IF NOT coalesce(slot->'variables','[]'::jsonb) ? v THEN errors:=errors||jsonb_build_array('Dado não disponível nesta etapa: '||v);END IF;
     END LOOP;
    END IF;
   END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'steps') x JOIN jsonb_array_elements(b->'steps') z ON z->>'key'=x->>'key'
   WHERE x->>'channel'='whatsapp' AND z->>'flow'='carrinho' GROUP BY x->>'piece' HAVING count(DISTINCT x->>'wait_min')>1) THEN
  errors:=errors||jsonb_build_array('As variantes A/B do mesmo toque precisam ter a mesma espera.');END IF;
 RETURN errors;
END $function$;
