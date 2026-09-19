-- Additive guard ledger. Run as one transaction while every brand is paused.
-- Existing logs, primary keys and reservations are neither changed nor deleted.
BEGIN;
SET LOCAL search_path=public,pg_temp;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM crm_tts_regra WHERE cobranca_modo IS DISTINCT FROM 'pausado') THEN
  RAISE EXCEPTION 'Cobrança deve estar pausada em todas as marcas antes da instalação';
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS crm_tts_cobranca_revisao_v2 (
 id text PRIMARY KEY,
 marca text NOT NULL REFERENCES crm_tts_regra(marca),
 etapa text NOT NULL CHECK (etapa IN ('vitrine_sem_video','amostra_sem_video')),
 username text NOT NULL CHECK (btrim(username) <> ''),
 creator_open_id text NOT NULL CHECK (btrim(creator_open_id) <> ''),
 referencia text NOT NULL CHECK (btrim(referencia) <> ''),
 tentativa integer NOT NULL CHECK (tentativa > 0),
 texto text NOT NULL CHECK (btrim(texto) <> ''),
 modelo_texto text NOT NULL,
 fonte_atualizada_em timestamptz NOT NULL,
 revisado_por text NOT NULL CHECK (btrim(revisado_por) <> ''),
 revisado_em timestamptz NOT NULL DEFAULT now(),
 valido_ate timestamptz NOT NULL,
 revogado_em timestamptz,
 CHECK (valido_ate > revisado_em)
);
CREATE TABLE IF NOT EXISTS crm_tts_cobranca_supressao_v2 (
 marca text NOT NULL REFERENCES crm_tts_regra(marca),
 creator_open_id text NOT NULL,
 motivo text NOT NULL CHECK (btrim(motivo) <> ''),
 registrado_em timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (marca,creator_open_id)
);
CREATE TABLE IF NOT EXISTS crm_tts_cobranca_intencao_v2 (
 marca text NOT NULL,
 etapa text NOT NULL,
 username text NOT NULL,
 tentativa integer NOT NULL,
 creator_open_id text NOT NULL,
 referencia text NOT NULL,
 revisao_id text NOT NULL UNIQUE REFERENCES crm_tts_cobranca_revisao_v2(id),
 dono uuid NOT NULL,
 revisao_snapshot jsonb NOT NULL,
 estado text NOT NULL CHECK (estado IN ('reservado','em_transporte','aceito','incerto','bloqueado')),
 texto text NOT NULL,
 dia_reserva date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
 reservado_em timestamptz NOT NULL DEFAULT now(),
 transporte_em timestamptz,
 concluido_em timestamptz,
 motivo text,
 provider_message_id text,
 PRIMARY KEY (marca,etapa,username,tentativa),
 UNIQUE (marca,etapa,creator_open_id,tentativa)
);
CREATE INDEX IF NOT EXISTS crm_tts_cobranca_intencao_v2_pessoa
 ON crm_tts_cobranca_intencao_v2(marca,creator_open_id,estado,reservado_em);
CREATE INDEX IF NOT EXISTS crm_tts_cobranca_intencao_v2_teto
 ON crm_tts_cobranca_intencao_v2(marca,dia_reserva);
CREATE TABLE IF NOT EXISTS crm_tts_cobranca_simulacao_v2 (
 id bigserial PRIMARY KEY,
 revisao_id text NOT NULL REFERENCES crm_tts_cobranca_revisao_v2(id),
 texto text NOT NULL,
 simulado_em timestamptz NOT NULL DEFAULT now()
);

-- Returns NULL only for a reviewed, unambiguous and still eligible snapshot.
-- No assumption that SHIPPED proves delivery; these are the existing eligibility statuses.
CREATE OR REPLACE FUNCTION crm_tts_cobranca_motivo_v2(p_revisao text)
RETURNS text LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r crm_tts_cobranca_revisao_v2%ROWTYPE; source_time timestamptz; template text;
BEGIN
 SELECT * INTO r FROM crm_tts_cobranca_revisao_v2 WHERE id=p_revisao;
 IF NOT FOUND THEN RETURN 'revisao_ausente'; END IF;
 IF EXISTS (SELECT 1 FROM crm_tts_cobranca_intencao_v2 i WHERE i.revisao_id=r.id AND i.revisao_snapshot IS DISTINCT FROM to_jsonb(r)) THEN RETURN 'revisao_alterada'; END IF;
 IF r.revogado_em IS NOT NULL OR r.valido_ate <= now() OR r.revisado_em > now() THEN RETURN 'revisao_invalida'; END IF;
 IF EXISTS (SELECT 1 FROM crm_tts_cobranca_supressao_v2 s WHERE s.marca=r.marca AND s.creator_open_id=r.creator_open_id) THEN RETURN 'supressao'; END IF;
 -- A username pointing to multiple open IDs (or the reverse) is not silently rebound.
 IF EXISTS (SELECT 1 FROM (
   SELECT marca,username,creator_open_id FROM crm_tts_convite
   UNION SELECT marca,username,creator_open_id FROM crm_tts_amostra
  ) x WHERE x.marca=r.marca AND
   ((x.username=r.username AND x.creator_open_id IS DISTINCT FROM r.creator_open_id)
    OR (x.creator_open_id=r.creator_open_id AND x.username IS DISTINCT FROM r.username))) THEN RETURN 'identidade_ambigua'; END IF;
 IF r.etapa='amostra_sem_video' THEN
  SELECT atualizado_em INTO source_time FROM crm_tts_amostra
   WHERE marca=r.marca AND application_id=r.referencia AND username=r.username AND creator_open_id=r.creator_open_id
    AND status IN ('SHIPPED','CONTENT_PENDING');
 ELSE
  SELECT atualizado_em INTO source_time FROM crm_tts_convite
   WHERE marca=r.marca AND colab_id=r.referencia AND username=r.username AND creator_open_id=r.creator_open_id
    AND showcase_product_count>0 AND content_product_count=0;
 END IF;
 IF source_time IS NULL THEN RETURN 'fonte_nao_elegivel'; END IF;
 IF source_time IS DISTINCT FROM r.fonte_atualizada_em THEN RETURN 'fonte_alterada'; END IF;
 SELECT texto INTO template FROM crm_tts_cobranca_modelo
  WHERE marca=r.marca AND etapa=r.etapa AND ativo AND tentativa<=r.tentativa ORDER BY tentativa DESC LIMIT 1;
 IF template IS NULL OR template IS DISTINCT FROM r.modelo_texto THEN RETURN 'modelo_alterado'; END IF;
 -- Legacy failures may have reached the provider. No automatic reinterpretation or deletion.
 IF EXISTS (SELECT 1 FROM crm_tts_cobranca h WHERE h.marca=r.marca AND NOT h.dry_run
   AND (h.username=r.username OR h.creator_open_id=r.creator_open_id)) THEN RETURN 'historico_legado_requer_conciliacao'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION crm_tts_cobranca_claim_v2(p_revisao text,p_dono uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r crm_tts_cobranca_revisao_v2%ROWTYPE; rule crm_tts_regra%ROWTYPE; reason text; last_attempt integer; n integer;
BEGIN
 IF p_dono IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','dono_ausente'); END IF;
 SELECT * INTO r FROM crm_tts_cobranca_revisao_v2 WHERE id=p_revisao;
 IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','revisao_ausente'); END IF;
 -- Serializes recipient fences and the daily budget together for this brand.
 SELECT * INTO rule FROM crm_tts_regra WHERE marca=r.marca FOR UPDATE;
 IF NOT FOUND OR rule.cobranca_modo IS DISTINCT FROM 'ativo' THEN RETURN jsonb_build_object('allowed',false,'reason','modo_nao_ativo'); END IF;
 SELECT * INTO r FROM crm_tts_cobranca_revisao_v2 WHERE id=p_revisao FOR UPDATE;
 IF NOT FOUND OR r.marca IS DISTINCT FROM rule.marca THEN RETURN jsonb_build_object('allowed',false,'reason','revisao_alterada'); END IF;
 IF rule.cobranca_dias_entre<1 OR rule.cobranca_max_tentativas<1 OR rule.cobranca_max_dia<0 THEN RETURN jsonb_build_object('allowed',false,'reason','regra_invalida'); END IF;
 reason:=crm_tts_cobranca_motivo_v2(p_revisao);
 IF reason IS NOT NULL THEN RETURN jsonb_build_object('allowed',false,'reason',reason); END IF;
 IF EXISTS (SELECT 1 FROM crm_tts_cobranca_intencao_v2 i WHERE i.marca=r.marca AND
   ((i.username=r.username AND i.etapa=r.etapa AND i.tentativa=r.tentativa)
    OR (i.creator_open_id=r.creator_open_id AND i.etapa=r.etapa AND i.tentativa=r.tentativa))) THEN
  RETURN jsonb_build_object('allowed',false,'reason','tentativa_ja_reservada');
 END IF;
 IF EXISTS (SELECT 1 FROM crm_tts_cobranca_intencao_v2 i WHERE i.marca=r.marca AND i.creator_open_id=r.creator_open_id
   AND i.estado IN ('reservado','em_transporte','incerto')) THEN RETURN jsonb_build_object('allowed',false,'reason','pessoa_com_reserva_ou_incerto'); END IF;
 IF EXISTS (SELECT 1 FROM crm_tts_cobranca_intencao_v2 i WHERE i.marca=r.marca AND i.creator_open_id=r.creator_open_id
   AND i.reservado_em > now()-make_interval(days=>rule.cobranca_dias_entre)) THEN RETURN jsonb_build_object('allowed',false,'reason','intervalo_pessoa'); END IF;
 SELECT COALESCE(max(tentativa),0) INTO last_attempt FROM crm_tts_cobranca_intencao_v2
  WHERE marca=r.marca AND etapa=r.etapa AND creator_open_id=r.creator_open_id AND estado='aceito';
 IF r.tentativa<>last_attempt+1 OR r.tentativa>rule.cobranca_max_tentativas THEN RETURN jsonb_build_object('allowed',false,'reason','sequencia_ou_teto_tentativas'); END IF;
 SELECT count(*) INTO n FROM crm_tts_cobranca_intencao_v2 WHERE marca=r.marca AND dia_reserva=(now() AT TIME ZONE 'America/Sao_Paulo')::date;
 SELECT n+count(*) INTO n FROM crm_tts_cobranca WHERE marca=r.marca AND NOT dry_run
  AND (enviado_em AT TIME ZONE 'America/Sao_Paulo')::date=(now() AT TIME ZONE 'America/Sao_Paulo')::date;
 IF n>=rule.cobranca_max_dia THEN RETURN jsonb_build_object('allowed',false,'reason','teto_diario'); END IF;
 INSERT INTO crm_tts_cobranca_intencao_v2(marca,etapa,username,tentativa,creator_open_id,referencia,revisao_id,dono,revisao_snapshot,estado,texto)
  VALUES(r.marca,r.etapa,r.username,r.tentativa,r.creator_open_id,r.referencia,r.id,p_dono,to_jsonb(r),'reservado',r.texto)
  ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','tentativa_ja_reservada'); END IF;
 RETURN jsonb_build_object('allowed',true,'review_id',r.id,'owner',p_dono,'brand',r.marca,'username',r.username,
  'creator_open_id',r.creator_open_id,'stage',r.etapa,'attempt',r.tentativa,'reference',r.referencia,'text',r.texto,'state','reservado');
END $$;

CREATE OR REPLACE FUNCTION crm_tts_cobranca_dispatch_v2(p_revisao text,p_dono uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE i crm_tts_cobranca_intencao_v2%ROWTYPE; mode text; reason text;
BEGIN
 SELECT * INTO i FROM crm_tts_cobranca_intencao_v2 WHERE revisao_id=p_revisao;
 IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','reserva_ausente'); END IF;
 SELECT cobranca_modo INTO mode FROM crm_tts_regra WHERE marca=i.marca FOR UPDATE;
 SELECT * INTO i FROM crm_tts_cobranca_intencao_v2 WHERE revisao_id=p_revisao FOR UPDATE;
 IF i.dono IS DISTINCT FROM p_dono OR i.estado<>'reservado' THEN RETURN jsonb_build_object('allowed',false,'reason','reserva_nao_disponivel'); END IF;
 PERFORM 1 FROM crm_tts_cobranca_revisao_v2 WHERE id=p_revisao FOR SHARE;
 reason:=crm_tts_cobranca_motivo_v2(p_revisao);
 IF mode IS DISTINCT FROM 'ativo' THEN reason:='modo_nao_ativo'; END IF;
 IF reason IS NOT NULL THEN
  UPDATE crm_tts_cobranca_intencao_v2 SET estado='bloqueado',motivo=reason,concluido_em=now() WHERE revisao_id=p_revisao;
  RETURN jsonb_build_object('allowed',false,'reason',reason);
 END IF;
 UPDATE crm_tts_cobranca_intencao_v2 SET estado='em_transporte',transporte_em=now() WHERE revisao_id=p_revisao;
 RETURN jsonb_build_object('allowed',true,'state','em_transporte','review_id',p_revisao,'owner',p_dono);
END $$;

CREATE OR REPLACE FUNCTION crm_tts_cobranca_finish_v2(p_revisao text,p_dono uuid,p_estado text,p_motivo text,p_message_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE i crm_tts_cobranca_intencao_v2%ROWTYPE;
BEGIN
 IF p_estado IS NULL OR p_estado NOT IN ('aceito','incerto','bloqueado') THEN RAISE EXCEPTION 'Estado final não permitido'; END IF;
 SELECT * INTO i FROM crm_tts_cobranca_intencao_v2 WHERE revisao_id=p_revisao FOR UPDATE;
 IF NOT FOUND OR i.dono IS DISTINCT FROM p_dono THEN RETURN jsonb_build_object('recorded',false,'reason','reserva_nao_disponivel'); END IF;
 IF i.estado IN ('aceito','incerto','bloqueado') THEN
  RETURN jsonb_build_object('recorded',i.estado=p_estado,'state',i.estado,'reason','estado_terminal_preservado');
 END IF;
 IF (p_estado='aceito' AND i.estado<>'em_transporte') OR (p_estado='bloqueado' AND i.estado<>'reservado') THEN
  RETURN jsonb_build_object('recorded',false,'reason','transicao_nao_permitida');
 END IF;
 UPDATE crm_tts_cobranca_intencao_v2 SET estado=p_estado,motivo=p_motivo,provider_message_id=p_message_id,concluido_em=now()
  WHERE revisao_id=p_revisao;
 RETURN jsonb_build_object('recorded',true,'state',p_estado);
END $$;

CREATE OR REPLACE FUNCTION crm_tts_cobranca_simulate_v2(p_revisao text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_text text; v_id bigint;
BEGIN
 SELECT texto INTO v_text FROM crm_tts_cobranca_revisao_v2 WHERE id=p_revisao;
 IF NOT FOUND THEN RETURN jsonb_build_object('simulated',false,'reason','revisao_ausente'); END IF;
 INSERT INTO crm_tts_cobranca_simulacao_v2(revisao_id,texto) VALUES(p_revisao,v_text) RETURNING id INTO v_id;
 RETURN jsonb_build_object('simulated',true,'simulation_id',v_id);
END $$;
REVOKE ALL ON TABLE crm_tts_cobranca_revisao_v2,crm_tts_cobranca_supressao_v2,crm_tts_cobranca_intencao_v2,crm_tts_cobranca_simulacao_v2 FROM PUBLIC;
REVOKE ALL ON SEQUENCE crm_tts_cobranca_simulacao_v2_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_tts_cobranca_motivo_v2(text),crm_tts_cobranca_claim_v2(text,uuid),crm_tts_cobranca_dispatch_v2(text,uuid),crm_tts_cobranca_finish_v2(text,uuid,text,text,text),crm_tts_cobranca_simulate_v2(text) FROM PUBLIC;
COMMIT;
