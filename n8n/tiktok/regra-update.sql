-- Incremental, no seed/backfill/row mutation. The caller still authenticates at the server.
-- Pending sender safeguards make activation unavailable through this API.
BEGIN;
CREATE OR REPLACE FUNCTION public.crm_tts_regra_patch_v1(
 p_marca text, p_patch jsonb, p_autor text, p_esperado_atualizado_em text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
 atual public.crm_tts_regra%ROWTYPE;
 final public.crm_tts_regra%ROWTYPE;
 campo text; valor jsonb; numero numeric; minimo numeric; maximo numeric;
 codigo text; mensagem text; esperado timestamptz;
 campos text[] := ARRAY['gmv_auto','gmv_manual','fulfillment_min','teto_mensal','modo',
  'cobranca_modo','cobranca_max_dia','cobranca_max_tentativas','cobranca_dias_entre'];
BEGIN
 -- Serializes patch + complete validation + update; a waiter merges with the latest row.
 SELECT * INTO atual FROM public.crm_tts_regra WHERE marca=p_marca FOR UPDATE;
 IF NOT FOUND OR p_marca NOT IN ('fish','aristo') THEN
  RETURN jsonb_build_object('ok',false,'codigo','marca_invalida','mensagem','Regra da marca indisponível.',
   'erro','Regra da marca indisponível.','regra_atual',NULL,'linhas','[]'::jsonb);
 END IF;
 <<validar>> BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch)<>'object' OR p_patch='{}'::jsonb THEN
   codigo:='patch_invalido'; mensagem:='Informe os campos da regra que deseja alterar.'; EXIT validar;
  END IF;
  FOR campo,valor IN SELECT key,value FROM jsonb_each(p_patch) LOOP
   IF NOT campo=ANY(campos) THEN codigo:='campo_invalido'; mensagem:='Campo de regra não editável.'; EXIT validar; END IF;
   IF campo IN ('modo','cobranca_modo') THEN
    IF jsonb_typeof(valor)<>'string' OR valor#>>'{}' NOT IN ('dry_run','pausado','ativo') THEN
     codigo:='modo_invalido'; mensagem:='Modo inválido.'; EXIT validar;
    END IF;
    -- No activation, including a stale UI attempting to restore a previously active mode.
    IF valor#>>'{}'='ativo' THEN
     codigo:='ativacao_bloqueada'; mensagem:='Ativação indisponível: as guardas de envio e de concorrência ainda precisam ser integradas e comprovadas.'; EXIT validar;
    END IF;
   ELSE
    IF jsonb_typeof(valor)<>'number' THEN codigo:='tipo_invalido'; mensagem:='Os limites devem ser números, sem texto, booleanos ou nulos.'; EXIT validar; END IF;
    numero:=(valor#>>'{}')::numeric;
    minimo:=CASE WHEN campo IN ('cobranca_max_tentativas','cobranca_dias_entre') THEN 1 ELSE 0 END;
    maximo:=CASE campo WHEN 'gmv_auto' THEN 10000000 WHEN 'gmv_manual' THEN 10000000
     WHEN 'fulfillment_min' THEN 100 WHEN 'teto_mensal' THEN 10000 WHEN 'cobranca_max_dia' THEN 200
     WHEN 'cobranca_max_tentativas' THEN 20 WHEN 'cobranca_dias_entre' THEN 120 END;
    IF numero<minimo OR numero>maximo OR (campo IN ('teto_mensal','cobranca_max_dia','cobranca_max_tentativas','cobranca_dias_entre') AND numero<>trunc(numero)) THEN
     codigo:='faixa_invalida'; mensagem:='Limite fora da faixa permitida.'; EXIT validar;
    END IF;
   END IF;
  END LOOP;
  IF p_esperado_atualizado_em IS NOT NULL THEN
   BEGIN esperado:=p_esperado_atualizado_em::timestamptz;
   EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    codigo:='versao_invalida'; mensagem:='Recarregue a regra antes de salvar.'; EXIT validar;
   END;
   IF esperado IS DISTINCT FROM atual.atualizado_em THEN
    codigo:='regra_alterada'; mensagem:='A regra mudou desde a leitura. Confira a regra atual antes de salvar novamente.'; EXIT validar;
   END IF;
  ELSIF p_patch ? 'modo' OR p_patch ? 'cobranca_modo' THEN
   codigo:='versao_obrigatoria'; mensagem:='Recarregue a regra antes de alterar o modo.'; EXIT validar;
  END IF;
  final:=jsonb_populate_record(atual,p_patch);
  -- Validate the complete persisted precision, including an untouched counterpart.
  IF final.gmv_manual>final.gmv_auto THEN
   codigo:='gmv_incompativel'; mensagem:='O limite de revisão manual não pode ultrapassar o limite automático da regra atual.'; EXIT validar;
  END IF;
  IF final.gmv_auto IS NULL OR final.gmv_auto NOT BETWEEN 0 AND 10000000
   OR final.gmv_manual IS NULL OR final.gmv_manual NOT BETWEEN 0 AND 10000000
   OR final.fulfillment_min IS NULL OR final.fulfillment_min NOT BETWEEN 0 AND 100
   OR final.teto_mensal IS NULL OR final.teto_mensal NOT BETWEEN 0 AND 10000
   OR final.cobranca_max_dia IS NULL OR final.cobranca_max_dia NOT BETWEEN 0 AND 200
   OR final.cobranca_max_tentativas IS NULL OR final.cobranca_max_tentativas NOT BETWEEN 1 AND 20
   OR final.cobranca_dias_entre IS NULL OR final.cobranca_dias_entre NOT BETWEEN 1 AND 120
   OR final.modo IS NULL OR final.modo NOT IN ('dry_run','pausado','ativo')
   OR final.cobranca_modo IS NULL OR final.cobranca_modo NOT IN ('dry_run','pausado','ativo') THEN
   codigo:='regra_final_invalida'; mensagem:='A regra completa contém limites inválidos. Nenhum campo foi alterado.'; EXIT validar;
  END IF;
 END validar;
 IF codigo IS NOT NULL THEN
  RETURN jsonb_build_object('ok',false,'codigo',codigo,'mensagem',mensagem,'erro',mensagem,
   'regra_atual',to_jsonb(atual),'linhas',jsonb_build_array(to_jsonb(atual)));
 END IF;
 -- Exactly one UPDATE; unrelated fields and the other mode are never assigned.
 UPDATE public.crm_tts_regra SET
  gmv_auto=final.gmv_auto,gmv_manual=final.gmv_manual,fulfillment_min=final.fulfillment_min,
  teto_mensal=final.teto_mensal,modo=final.modo,cobranca_modo=final.cobranca_modo,
  cobranca_max_dia=final.cobranca_max_dia,cobranca_max_tentativas=final.cobranca_max_tentativas,
  cobranca_dias_entre=final.cobranca_dias_entre,
  atualizado_em=greatest(clock_timestamp(),atual.atualizado_em+interval '1 microsecond'),
  atualizado_por=left(coalesce(nullif(btrim(p_autor),''),'painel'),40)||' (painel)'
 WHERE marca=p_marca RETURNING * INTO final;
 RETURN jsonb_build_object('ok',true,'codigo','regra_atualizada','mensagem','Regra salva.',
  'regra_atual',to_jsonb(final),'linhas',jsonb_build_array(to_jsonb(final)));
END $$;
REVOKE ALL ON FUNCTION public.crm_tts_regra_patch_v1(text,jsonb,text,text) FROM PUBLIC;
-- Owner retains EXECUTE. If runtime uses a different role, grant only that verified role;
-- no broad role grant or table-permission change belongs in this migration.
COMMIT;
