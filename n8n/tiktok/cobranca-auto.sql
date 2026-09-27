-- Cobrança automática com modelo aprovado (26/09/2026, decisão do Felipe: "modelo aprovado, envio sozinho").
-- Roda DEPOIS de cobranca-safety.sql e nunca com uma marca em modo 'ativo'. Idempotente.
--
-- A Marcela aprova o texto de cada toque (marca × etapa × tentativa) uma vez, no painel. A partir daí o
-- robô gera a revisão individual de cada pessoa com aquele texto e passa pelas guardas v2 de sempre
-- (reserva, teto diário, intervalo, sequência, conversa lida antes, sem repetir incerto).
-- Mudou o texto ou revogou a aprovação: nada mais sai com o texto antigo (motivo 'modelo_nao_aprovado').
--
-- O que se acrescenta aqui:
--  * aprovação no próprio crm_tts_cobranca_modelo (aprovado_texto/por/em);
--  * crm_tts_cobranca_motivo_v2 redefinida: igual à v2 + exige o modelo aprovado com o texto exato;
--  * crm_tts_cobranca_prepara_v2: fila do dia + revisões geradas do modelo aprovado;
--  * crm_tts_cobranca_conclui_v2: finish_v2 + trecho da conversa para a lista "Responderam";
--  * resolução auditável de bloqueado/incerto (crm_tts_cobranca_resolucao_v2): o que parou por motivo
--    técnico e NUNCA chegou ao transporte volta sozinho para a régua; o resto é decisão da Marcela;
--  * crm_tts_cobranca_painel_v1: leitura e ações do painel, com a chave do painel de Influs;
--  * crm_tts_cobranca_pronta_v2: condição para o painel aceitar cobranca_modo = 'ativo'.
BEGIN;
SET LOCAL search_path=public,pg_temp;
DO $$ BEGIN
 IF to_regclass('public.crm_tts_cobranca_intencao_v2') IS NULL THEN
  RAISE EXCEPTION 'Instale cobranca-safety.sql antes desta migração';
 END IF;
 IF EXISTS (SELECT 1 FROM crm_tts_regra WHERE cobranca_modo='ativo') THEN
  RAISE EXCEPTION 'Nenhuma marca pode estar com a cobrança ativa durante a instalação';
 END IF;
END $$;

ALTER TABLE crm_tts_cobranca_modelo ADD COLUMN IF NOT EXISTS aprovado_texto text;
ALTER TABLE crm_tts_cobranca_modelo ADD COLUMN IF NOT EXISTS aprovado_por text;
ALTER TABLE crm_tts_cobranca_modelo ADD COLUMN IF NOT EXISTS aprovado_em timestamptz;

-- Mensagens do criador até `ate` já foram tratadas por gente (a Marcela respondeu e devolveu a pessoa à régua).
CREATE TABLE IF NOT EXISTS crm_tts_cobranca_ciente_v2 (
 marca text NOT NULL REFERENCES crm_tts_regra(marca),
 creator_open_id text NOT NULL,
 ate timestamptz NOT NULL,
 por text NOT NULL CHECK (btrim(por)<>''),
 em timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (marca,creator_open_id)
);
-- Toda saída de uma reserva que não seja o fluxo normal fica aqui, com a reserva inteira como estava.
CREATE TABLE IF NOT EXISTS crm_tts_cobranca_resolucao_v2 (
 id bigserial PRIMARY KEY,
 marca text NOT NULL,
 etapa text,
 username text,
 creator_open_id text,
 tentativa integer,
 estado_antes text,
 motivo_antes text,
 decisao text NOT NULL CHECK (decisao IN ('liberar','chegou','nao_chegou','suprimir','reativar','auto_liberar')),
 por text NOT NULL CHECK (btrim(por)<>''),
 obs text NOT NULL DEFAULT '',
 intencao jsonb,
 em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_tts_cobranca_resolucao_v2_em ON crm_tts_cobranca_resolucao_v2(marca,em DESC);
-- Sender v2 publicado e conferido. Sem esta linha o painel não liga a cobrança.
CREATE TABLE IF NOT EXISTS crm_tts_cobranca_config_v2 (
 id integer PRIMARY KEY CHECK (id=1),
 sender_workflow text NOT NULL,
 sender_versao text NOT NULL,
 verificado_em timestamptz NOT NULL,
 verificado_por text NOT NULL
);
REVOKE ALL ON TABLE crm_tts_cobranca_ciente_v2,crm_tts_cobranca_resolucao_v2,crm_tts_cobranca_config_v2 FROM PUBLIC;
REVOKE ALL ON SEQUENCE crm_tts_cobranca_resolucao_v2_id_seq FROM PUBLIC;

-- Mesmo encurtamento de título e mesmo filtro de apelido do sender legado (cobranca_alvos.js).
CREATE OR REPLACE FUNCTION crm_tts_cobranca_produto_v2(titulo text,padrao text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(nullif(regexp_replace(substring(
   regexp_replace(titulo,'\s*[0-9.,]+\s*(estrelas?|mil\s*avalia|avalia).*$','','i')
   from '^.{1,42}(?=\s|$)'),
   '\s+(da|de|do|das|dos|e|com|para|pra|em|no|na)$','','i'),''),padrao)
$$;
CREATE OR REPLACE FUNCTION crm_tts_cobranca_nome_v2(apelido text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN COALESCE(apelido,'') ~ '^[A-ZÀ-Þ][a-zà-ÿ]{1,13}($|\s)'
   AND lower(split_part(apelido,' ',1)) NOT IN ('dicas','loja','shop','achados','cantinho','clube','grupo','canal','oficial',
    'mundo','casa','espaco','espaço','atelie','ateliê','top','mega','super','style','moda','store','universo','reino','arte',
    'arteira','liga','time')
   AND lower(split_part(apelido,' ',1)) !~ '(box|viral|shop|store|promo|ofert|achad|pesca|fish|tiktok|ofc|oficial|brasil|digital|online)'
  THEN ', '||split_part(apelido,' ',1) ELSE '' END
$$;

-- Motivos que pedem gente (a Marcela decide no painel). Os demais são técnicos e passageiros.
CREATE OR REPLACE FUNCTION crm_tts_cobranca_motivo_humano_v2(m text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(m,'') IN ('im_resposta_criador','im_nao_lidas','im_identidade_divergente','im_identidade_incompleta',
  'identidade_ambigua','supressao','historico_legado_requer_conciliacao','im_mensagem_desconhecida','im_historico_ausente',
  'im_data_invalida')
$$;
-- Técnicos que só fazem sentido tentar de novo depois do intervalo da régua (conversa em andamento etc.).
CREATE OR REPLACE FUNCTION crm_tts_cobranca_motivo_espera_v2(m text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(m,'') IN ('im_conversa_recente','im_historico_incompleto','im_leitura_invalida','im_abertura_invalida',
  'im_nao_lidas_desconhecido','preflight_resultado_incerto')
$$;

-- Igual à v2 de cobranca-safety.sql, com uma condição a mais: o modelo vigente tem de estar aprovado
-- com exatamente o texto usado na revisão.
CREATE OR REPLACE FUNCTION crm_tts_cobranca_motivo_v2(p_revisao text)
RETURNS text LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r crm_tts_cobranca_revisao_v2%ROWTYPE; source_time timestamptz; template text; aprovado text;
BEGIN
 SELECT * INTO r FROM crm_tts_cobranca_revisao_v2 WHERE id=p_revisao;
 IF NOT FOUND THEN RETURN 'revisao_ausente'; END IF;
 IF EXISTS (SELECT 1 FROM crm_tts_cobranca_intencao_v2 i WHERE i.revisao_id=r.id AND i.revisao_snapshot IS DISTINCT FROM to_jsonb(r)) THEN RETURN 'revisao_alterada'; END IF;
 IF r.revogado_em IS NOT NULL OR r.valido_ate <= now() OR r.revisado_em > now() THEN RETURN 'revisao_invalida'; END IF;
 IF EXISTS (SELECT 1 FROM crm_tts_cobranca_supressao_v2 s WHERE s.marca=r.marca AND s.creator_open_id=r.creator_open_id) THEN RETURN 'supressao'; END IF;
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
 SELECT texto,aprovado_texto INTO template,aprovado FROM crm_tts_cobranca_modelo
  WHERE marca=r.marca AND etapa=r.etapa AND ativo AND tentativa<=r.tentativa ORDER BY tentativa DESC LIMIT 1;
 IF template IS NULL OR template IS DISTINCT FROM r.modelo_texto THEN RETURN 'modelo_alterado'; END IF;
 IF aprovado IS DISTINCT FROM template THEN RETURN 'modelo_nao_aprovado'; END IF;
 IF EXISTS (SELECT 1 FROM crm_tts_cobranca h WHERE h.marca=r.marca AND NOT h.dry_run
   AND (h.username=r.username OR h.creator_open_id=r.creator_open_id)) THEN RETURN 'historico_legado_requer_conciliacao'; END IF;
 RETURN NULL;
END $$;

-- Tira uma reserva do ledger guardando-a inteira na resolução. Só para o que nunca chegou ao transporte
-- ou para o que a Marcela conferiu no Seller Center que não chegou.
CREATE OR REPLACE FUNCTION crm_tts_cobranca_arquiva_v2(i crm_tts_cobranca_intencao_v2,p_decisao text,p_por text,p_obs text)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO crm_tts_cobranca_resolucao_v2(marca,etapa,username,creator_open_id,tentativa,estado_antes,motivo_antes,decisao,por,obs,intencao)
  VALUES(i.marca,i.etapa,i.username,i.creator_open_id,i.tentativa,i.estado,i.motivo,p_decisao,p_por,left(coalesce(p_obs,''),300),to_jsonb(i));
 DELETE FROM crm_tts_cobranca_intencao_v2 WHERE revisao_id=i.revisao_id AND estado=i.estado AND dono=i.dono;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reserva mudou durante a resolução'; END IF;
END $$;

-- Fila do dia. Gera (ou reaproveita) a revisão de cada pessoa a partir do modelo; em 'ativo' só modelo aprovado.
-- Não reserva nada: a reserva continua sendo o claim_v2, pessoa a pessoa.
CREATE OR REPLACE FUNCTION crm_tts_cobranca_prepara_v2(p_dono uuid)
RETURNS TABLE(review_id text,dono uuid,marca text,etapa text,username text,tentativa integer,simular boolean,ciente_ate timestamptz)
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE hoje date:=(now() AT TIME ZONE 'America/Sao_Paulo')::date; fim timestamptz; x crm_tts_cobranca_intencao_v2%ROWTYPE;
BEGIN
 IF p_dono IS NULL THEN RAISE EXCEPTION 'Dono da execução obrigatório'; END IF;
 fim:=((hoje+1)::timestamp AT TIME ZONE 'America/Sao_Paulo');
 -- 1) O que parou por motivo técnico e nunca começou transporte volta para a régua (auditado).
 FOR x IN SELECT i.* FROM crm_tts_cobranca_intencao_v2 i JOIN crm_tts_regra g ON g.marca=i.marca
   WHERE i.transporte_em IS NULL AND (
    (i.estado='bloqueado' AND NOT crm_tts_cobranca_motivo_humano_v2(i.motivo)
      AND (NOT crm_tts_cobranca_motivo_espera_v2(i.motivo) OR i.concluido_em < now()-make_interval(days=>g.cobranca_dias_entre)))
    OR (i.estado='incerto' AND crm_tts_cobranca_motivo_espera_v2(i.motivo) AND i.concluido_em < now()-make_interval(days=>g.cobranca_dias_entre))
    OR (i.estado='reservado' AND i.reservado_em < now()-interval '2 hours'))
   ORDER BY i.reservado_em FOR UPDATE OF i SKIP LOCKED
 LOOP
  PERFORM crm_tts_cobranca_arquiva_v2(x,'auto_liberar','automático','motivo técnico, sem transporte');
 END LOOP;
 -- 2) Fila: uma etapa por pessoa, quem está no meio da régua primeiro, amostra antes de vitrine, até o teto.
 RETURN QUERY
 WITH g AS (SELECT * FROM crm_tts_regra WHERE cobranca_modo IN ('dry_run','ativo')),
 vit AS (
  SELECT DISTINCT ON (c.marca,c.username) c.marca,'vitrine_sem_video'::text AS etapa,c.username,c.creator_open_id,
   c.colab_id AS referencia,c.atualizado_em AS fonte,crm_tts_cobranca_produto_v2(co.product_title,'nossos produtos') AS produto,
   crm_tts_cobranca_nome_v2(c.nickname) AS nome
  FROM crm_tts_convite c LEFT JOIN crm_tts_colaboracao co ON co.marca=c.marca AND co.colab_id=c.colab_id
  WHERE c.showcase_product_count>0 AND c.content_product_count=0 AND coalesce(c.creator_open_id,'')<>''
  ORDER BY c.marca,c.username,c.atualizado_em DESC),
 amo AS (
  SELECT DISTINCT ON (a.marca,a.username) a.marca,'amostra_sem_video'::text AS etapa,a.username,a.creator_open_id,
   a.application_id AS referencia,a.atualizado_em AS fonte,crm_tts_cobranca_produto_v2(a.product_title,'o produto') AS produto,
   crm_tts_cobranca_nome_v2(cr.nickname) AS nome
  FROM crm_tts_amostra a LEFT JOIN crm_tts_criador cr ON cr.marca=a.marca AND cr.username=a.username
  WHERE a.status IN ('SHIPPED','CONTENT_PENDING') AND coalesce(a.creator_open_id,'')<>'' AND coalesce(a.username,'')<>''
  ORDER BY a.marca,a.username,a.atualizado_em DESC),
 alvo AS (SELECT * FROM vit UNION ALL SELECT * FROM amo),
 prox AS (
  SELECT a.*,g.cobranca_modo AS modo,g.cobranca_max_dia,g.cobranca_max_tentativas,
   coalesce((SELECT max(i.tentativa) FROM crm_tts_cobranca_intencao_v2 i WHERE i.marca=a.marca AND i.etapa=a.etapa
    AND i.creator_open_id=a.creator_open_id AND i.estado='aceito'),0)+1 AS prox_tentativa
  FROM alvo a JOIN g ON g.marca=a.marca
  WHERE NOT EXISTS (SELECT 1 FROM crm_tts_cobranca_supressao_v2 s WHERE s.marca=a.marca AND s.creator_open_id=a.creator_open_id)
   AND NOT EXISTS (SELECT 1 FROM crm_tts_cobranca_intencao_v2 i WHERE i.marca=a.marca AND i.creator_open_id=a.creator_open_id
    AND (i.estado IN ('reservado','em_transporte','incerto','bloqueado') OR i.reservado_em > now()-make_interval(days=>g.cobranca_dias_entre)))
   AND NOT EXISTS (SELECT 1 FROM crm_tts_cobranca h WHERE h.marca=a.marca AND NOT h.dry_run
    AND (h.username=a.username OR h.creator_open_id=a.creator_open_id))),
 com_modelo AS (
  SELECT p.*,m.texto AS modelo,m.aprovado_texto,m.aprovado_por,m.aprovado_em
  FROM prox p JOIN LATERAL (SELECT mm.* FROM crm_tts_cobranca_modelo mm WHERE mm.marca=p.marca AND mm.etapa=p.etapa
   AND mm.ativo AND mm.tentativa<=p.prox_tentativa ORDER BY mm.tentativa DESC LIMIT 1) m ON true
  WHERE p.prox_tentativa<=p.cobranca_max_tentativas AND (p.modo='dry_run' OR m.aprovado_texto IS NOT DISTINCT FROM m.texto)),
 pessoa AS (SELECT DISTINCT ON (cm.marca,cm.creator_open_id) cm.* FROM com_modelo cm
  ORDER BY cm.marca,cm.creator_open_id,cm.prox_tentativa DESC,(cm.etapa='amostra_sem_video') DESC,cm.etapa),
 fila AS (SELECT pe.*,row_number() OVER (PARTITION BY pe.marca ORDER BY pe.prox_tentativa DESC,(pe.etapa='amostra_sem_video') DESC,pe.username) AS pos,
   pe.cobranca_max_dia-(SELECT count(*) FROM crm_tts_cobranca_intencao_v2 i WHERE i.marca=pe.marca AND i.dia_reserva=hoje) AS vagas
  FROM pessoa pe),
 escolhidos AS (
  SELECT f.*,replace(replace(f.modelo,'{nome}',f.nome),'{produto}',f.produto) AS texto,
   'r2-'||md5(concat_ws('|',f.marca,f.etapa,f.username,f.creator_open_id,f.prox_tentativa,f.referencia,f.fonte,f.modelo,
    f.aprovado_texto IS NOT DISTINCT FROM f.modelo,f.aprovado_em,f.nome,f.produto,hoje)) AS rid
  FROM fila f WHERE f.pos<=greatest(f.vagas,0)),
 gravadas AS (
  INSERT INTO crm_tts_cobranca_revisao_v2(id,marca,etapa,username,creator_open_id,referencia,tentativa,texto,modelo_texto,
   fonte_atualizada_em,revisado_por,revisado_em,valido_ate)
  SELECT e.rid,e.marca,e.etapa,e.username,e.creator_open_id,e.referencia,e.prox_tentativa,e.texto,e.modelo,e.fonte,
   CASE WHEN e.aprovado_texto IS NOT DISTINCT FROM e.modelo THEN left('modelo aprovado por '||coalesce(e.aprovado_por,'?'),120)
    ELSE 'simulação: modelo ainda sem aprovação' END,now(),fim
  FROM escolhidos e ON CONFLICT (id) DO NOTHING RETURNING id)
 SELECT e.rid,p_dono,e.marca,e.etapa,e.username,e.prox_tentativa::integer,(e.modo='dry_run'),
  (SELECT c.ate FROM crm_tts_cobranca_ciente_v2 c WHERE c.marca=e.marca AND c.creator_open_id=e.creator_open_id)
 FROM escolhidos e ORDER BY e.marca,e.pos;
END $$;

-- finish_v2 + o trecho da conversa quando o robô parou por resposta/conversa (lista "Responderam" do painel).
CREATE OR REPLACE FUNCTION crm_tts_cobranca_conclui_v2(p_revisao text,p_dono uuid,p_estado text,p_motivo text,p_message_id text,p_detalhe jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE res jsonb; i crm_tts_cobranca_intencao_v2%ROWTYPE; quando timestamptz;
BEGIN
 res:=crm_tts_cobranca_finish_v2(p_revisao,p_dono,p_estado,p_motivo,p_message_id);
 IF (res->>'recorded')::boolean IS NOT TRUE THEN RETURN res; END IF;
 SELECT * INTO i FROM crm_tts_cobranca_intencao_v2 WHERE revisao_id=p_revisao;
 IF p_estado='aceito' THEN
  DELETE FROM crm_tts_cobranca_pulo WHERE marca=i.marca AND etapa=i.etapa AND username=i.username;
 ELSIF p_estado='bloqueado' AND p_motivo IN ('im_resposta_criador','im_nao_lidas','im_conversa_recente') AND jsonb_typeof(p_detalhe)='object' THEN
  quando:=CASE WHEN coalesce(p_detalhe->>'ultima_msg_em','') ~ '^\d{9,11}(\.\d+)?$' THEN to_timestamp((p_detalhe->>'ultima_msg_em')::numeric) END;
  INSERT INTO crm_tts_cobranca_pulo(marca,etapa,username,tentativa,motivo,conversation_id,creator_im_id,nao_lidas,ultima_msg_em,ultima_msg_de,ultimo_texto,visto_em)
  VALUES(i.marca,i.etapa,i.username,i.tentativa,CASE WHEN p_motivo='im_conversa_recente' THEN 'conversa_ativa' ELSE 'respondeu' END,
   left(p_detalhe->>'conversation_id',80),left(p_detalhe->>'creator_im_id',80),
   CASE WHEN coalesce(p_detalhe->>'nao_lidas','') ~ '^\d{1,6}$' THEN (p_detalhe->>'nao_lidas')::int ELSE 0 END,quando,
   CASE WHEN p_detalhe->>'ultima_msg_de' IN ('criador','loja') THEN p_detalhe->>'ultima_msg_de' END,left(p_detalhe->>'ultimo_texto',160),now())
  ON CONFLICT (marca,etapa,username) DO UPDATE SET tentativa=EXCLUDED.tentativa,motivo=EXCLUDED.motivo,conversation_id=EXCLUDED.conversation_id,
   creator_im_id=EXCLUDED.creator_im_id,nao_lidas=EXCLUDED.nao_lidas,ultima_msg_em=EXCLUDED.ultima_msg_em,ultima_msg_de=EXCLUDED.ultima_msg_de,
   ultimo_texto=EXCLUDED.ultimo_texto,visto_em=now();
 END IF;
 RETURN res;
END $$;

-- Reserva usada pelo sender: claim_v2, com um disjuntor por marca. Enquanto houver envio que começou e não teve
-- aceite confirmado (em_transporte/incerto com transporte), a marca não reserva mais ninguém: a Marcela confere no
-- Seller Center ("chegou"/"não chegou") e a régua volta. Evita repetir em série um envio de resultado incerto.
CREATE OR REPLACE FUNCTION crm_tts_cobranca_reserva_v2(p_revisao text,p_dono uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE b text;
BEGIN
 SELECT marca INTO b FROM crm_tts_cobranca_revisao_v2 WHERE id=p_revisao;
 IF b IS NOT NULL AND EXISTS (SELECT 1 FROM crm_tts_cobranca_intencao_v2 i WHERE i.marca=b AND i.transporte_em IS NOT NULL
   AND i.estado IN ('em_transporte','incerto')) THEN
  RETURN jsonb_build_object('allowed',false,'reason','marca_parada_envio_incerto');
 END IF;
 RETURN crm_tts_cobranca_claim_v2(p_revisao,p_dono);
END $$;

CREATE OR REPLACE FUNCTION crm_tts_cobranca_pronta_v2(p_marca text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM crm_tts_cobranca_config_v2 WHERE id=1)
  AND EXISTS (SELECT 1 FROM crm_tts_cobranca_modelo WHERE marca=p_marca AND ativo AND aprovado_texto IS NOT DISTINCT FROM texto)
$$;

-- Painel (chave de Influs; gravar exige creators_edit). Nunca devolve a chave nem o identificador interno do acesso.
CREATE OR REPLACE FUNCTION crm_tts_cobranca_painel_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE op jsonb; escreve boolean; quem text; acao text:=p->>'acao'; d jsonb:=coalesce(p->'data','{}'::jsonb);
 m crm_tts_cobranca_modelo%ROWTYPE; i crm_tts_cobranca_intencao_v2%ROWTYPE; txt text; resto text; dec text; obs text;
BEGIN
 op:=shrigma_panel_operator_v1(p->>'k','influs');
 IF op IS NULL THEN RETURN jsonb_build_object('erro','Entre com a chave do painel de Influs.'); END IF;
 escreve:=coalesce(op->'caps' ? 'creators_edit',false);
 quem:=left(coalesce(nullif(btrim(op->>'label'),''),'painel'),40);
 IF acao='ler' THEN
  RETURN jsonb_build_object('ok',true,'pode_escrever',escreve,'autor',quem,
   'modelos',(SELECT coalesce(jsonb_agg(jsonb_build_object('marca',x.marca,'etapa',x.etapa,'tentativa',x.tentativa,'texto',x.texto,'ativo',x.ativo,
     'aprovado',x.aprovado_texto IS NOT DISTINCT FROM x.texto,'aprovado_por',CASE WHEN x.aprovado_texto IS NOT DISTINCT FROM x.texto THEN x.aprovado_por END,
     'aprovado_em',CASE WHEN x.aprovado_texto IS NOT DISTINCT FROM x.texto THEN x.aprovado_em END,
     'atualizado_em',x.atualizado_em::text,'atualizado_por',x.atualizado_por) ORDER BY x.marca,x.etapa,x.tentativa),'[]')
    FROM crm_tts_cobranca_modelo x),
   'regras',(SELECT coalesce(jsonb_agg(jsonb_build_object('marca',g.marca,'cobranca_modo',g.cobranca_modo,'pronta',crm_tts_cobranca_pronta_v2(g.marca),
     'hoje',(SELECT count(*) FROM crm_tts_cobranca_intencao_v2 i2 WHERE i2.marca=g.marca AND i2.dia_reserva=(now() AT TIME ZONE 'America/Sao_Paulo')::date),
     'max_dia',g.cobranca_max_dia,
     'parada',EXISTS (SELECT 1 FROM crm_tts_cobranca_intencao_v2 i3 WHERE i3.marca=g.marca AND i3.transporte_em IS NOT NULL AND i3.estado IN ('em_transporte','incerto')))
     ORDER BY g.marca),'[]') FROM crm_tts_regra g),
   'sender',(SELECT jsonb_build_object('versao',c.sender_versao,'verificado_em',c.verificado_em) FROM crm_tts_cobranca_config_v2 c WHERE c.id=1),
   'envios',(SELECT coalesce(jsonb_agg(jsonb_build_object('marca',x.marca,'etapa',x.etapa,'username',x.username,'tentativa',x.tentativa,
     'estado',x.estado,'motivo',x.motivo,'texto',x.texto,'reservado_em',x.reservado_em,'transporte_em',x.transporte_em,'concluido_em',x.concluido_em,
     'humano',(x.estado='bloqueado' AND crm_tts_cobranca_motivo_humano_v2(x.motivo)) OR (x.estado IN ('incerto','em_transporte') AND x.transporte_em IS NOT NULL),
     'suprimido',EXISTS (SELECT 1 FROM crm_tts_cobranca_supressao_v2 s WHERE s.marca=x.marca AND s.creator_open_id=x.creator_open_id))
     ORDER BY x.reservado_em DESC),'[]')
    FROM (SELECT * FROM crm_tts_cobranca_intencao_v2 WHERE reservado_em>now()-interval '45 days' OR estado IN ('reservado','em_transporte','incerto','bloqueado')
     ORDER BY reservado_em DESC LIMIT 400) x),
   'simulacoes',(SELECT coalesce(jsonb_agg(jsonb_build_object('marca',y.marca,'etapa',y.etapa,'username',y.username,'tentativa',y.tentativa,
     'texto',y.texto,'simulado_em',y.simulado_em,'aprovado',y.revisado_por LIKE 'modelo aprovado%') ORDER BY y.marca,y.simulado_em DESC),'[]')
    FROM (SELECT DISTINCT ON (r.id) r.marca,r.etapa,r.username,r.tentativa,s.texto,s.simulado_em,r.revisado_por
     FROM crm_tts_cobranca_simulacao_v2 s JOIN crm_tts_cobranca_revisao_v2 r ON r.id=s.revisao_id
     WHERE s.simulado_em>=(SELECT max(s2.simulado_em)-interval '2 hours' FROM crm_tts_cobranca_simulacao_v2 s2)
     ORDER BY r.id,s.simulado_em DESC) y),
   'supressoes',(SELECT coalesce(jsonb_agg(jsonb_build_object('marca',s.marca,'creator_open_id',s.creator_open_id,'motivo',s.motivo,'registrado_em',s.registrado_em,
     'username',(SELECT u.username FROM (SELECT username,creator_open_id,marca FROM crm_tts_convite UNION SELECT username,creator_open_id,marca FROM crm_tts_amostra) u
       WHERE u.marca=s.marca AND u.creator_open_id=s.creator_open_id LIMIT 1)) ORDER BY s.registrado_em DESC),'[]') FROM crm_tts_cobranca_supressao_v2 s),
   'resolucoes',(SELECT coalesce(jsonb_agg(jsonb_build_object('marca',z.marca,'username',z.username,'etapa',z.etapa,'tentativa',z.tentativa,'decisao',z.decisao,
     'estado_antes',z.estado_antes,'motivo_antes',z.motivo_antes,'por',z.por,'obs',z.obs,'em',z.em) ORDER BY z.em DESC),'[]')
    FROM (SELECT * FROM crm_tts_cobranca_resolucao_v2 ORDER BY em DESC LIMIT 60) z));
 END IF;
 IF NOT escreve THEN RETURN jsonb_build_object('erro','Esta chave só lê. Aprovar e resolver pedem a chave de gestão de Influs.'); END IF;
 IF d->>'marca' NOT IN ('aristo','fish') THEN RETURN jsonb_build_object('erro','Marca inválida.'); END IF;
 IF acao IN ('modelo_salvar','modelo_revogar') THEN
  IF d->>'etapa' NOT IN ('vitrine_sem_video','amostra_sem_video') OR coalesce(d->>'tentativa','') !~ '^\d{1,2}$' THEN RETURN jsonb_build_object('erro','Modelo inválido.'); END IF;
  SELECT * INTO m FROM crm_tts_cobranca_modelo WHERE marca=d->>'marca' AND etapa=d->>'etapa' AND tentativa=(d->>'tentativa')::int FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','Modelo não encontrado.'); END IF;
  IF d->>'esperado' IS DISTINCT FROM m.atualizado_em::text THEN RETURN jsonb_build_object('erro','O modelo mudou desde a leitura. Recarregue antes de salvar.'); END IF;
  IF acao='modelo_revogar' THEN
   UPDATE crm_tts_cobranca_modelo SET aprovado_texto=NULL,aprovado_por=NULL,aprovado_em=NULL,
    atualizado_em=greatest(clock_timestamp(),m.atualizado_em+interval '1 microsecond'),atualizado_por=quem||' (painel)'
    WHERE marca=m.marca AND etapa=m.etapa AND tentativa=m.tentativa;
   RETURN jsonb_build_object('ok',true,'mensagem','Aprovação retirada. Este toque não sai até ser aprovado de novo.');
  END IF;
  txt:=btrim(replace(coalesce(d->>'texto',''),E'\r',''));
  resto:=replace(replace(txt,'{nome}',''),'{produto}','');
  IF length(txt)<20 OR length(txt)>700 THEN RETURN jsonb_build_object('erro','A mensagem precisa ter entre 20 e 700 caracteres.'); END IF;
  IF resto ~ '[{}]' THEN RETURN jsonb_build_object('erro','Só {nome} e {produto} podem ficar entre chaves.'); END IF;
  UPDATE crm_tts_cobranca_modelo SET texto=txt,aprovado_texto=txt,aprovado_por=quem,aprovado_em=now(),
   atualizado_em=greatest(clock_timestamp(),m.atualizado_em+interval '1 microsecond'),atualizado_por=quem||' (painel)'
   WHERE marca=m.marca AND etapa=m.etapa AND tentativa=m.tentativa;
  RETURN jsonb_build_object('ok',true,'mensagem','Modelo aprovado.');
 END IF;
 IF acao='resolver' THEN
  dec:=d->>'decisao'; obs:=left(btrim(coalesce(d->>'obs','')),300);
  IF dec NOT IN ('liberar','chegou','nao_chegou','suprimir') OR coalesce(d->>'tentativa','') !~ '^\d{1,2}$' THEN RETURN jsonb_build_object('erro','Decisão inválida.'); END IF;
  SELECT * INTO i FROM crm_tts_cobranca_intencao_v2 WHERE marca=d->>'marca' AND etapa=d->>'etapa' AND username=d->>'username' AND tentativa=(d->>'tentativa')::int FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','Esse toque não está mais pendente. Recarregue.'); END IF;
  IF d->>'estado' IS DISTINCT FROM i.estado THEN RETURN jsonb_build_object('erro','O estado mudou desde a leitura. Recarregue.'); END IF;
  IF dec='liberar' THEN
   IF NOT (i.estado='bloqueado' OR (i.estado='incerto' AND i.transporte_em IS NULL) OR (i.estado='reservado' AND i.reservado_em<now()-interval '1 hour')) THEN
    RETURN jsonb_build_object('erro','Só dá para devolver à régua o que não chegou a ser enviado.');
   END IF;
   IF i.motivo IN ('im_resposta_criador','im_nao_lidas','im_conversa_recente','im_historico_ausente') THEN
    INSERT INTO crm_tts_cobranca_ciente_v2(marca,creator_open_id,ate,por) VALUES(i.marca,i.creator_open_id,now(),quem)
    ON CONFLICT (marca,creator_open_id) DO UPDATE SET ate=now(),por=EXCLUDED.por,em=now();
   END IF;
   PERFORM crm_tts_cobranca_arquiva_v2(i,'liberar',quem,obs);
   DELETE FROM crm_tts_cobranca_pulo WHERE marca=i.marca AND username=i.username;
   RETURN jsonb_build_object('ok',true,'mensagem','Voltou para a régua. As mensagens dela até agora contam como vistas.');
  END IF;
  IF dec IN ('chegou','nao_chegou') THEN
   IF NOT (i.estado IN ('incerto','em_transporte') AND i.transporte_em IS NOT NULL) THEN
    RETURN jsonb_build_object('erro','Só se confere no Seller Center o que chegou a ser enviado sem confirmação.');
   END IF;
   IF dec='chegou' THEN
    INSERT INTO crm_tts_cobranca_resolucao_v2(marca,etapa,username,creator_open_id,tentativa,estado_antes,motivo_antes,decisao,por,obs,intencao)
     VALUES(i.marca,i.etapa,i.username,i.creator_open_id,i.tentativa,i.estado,i.motivo,'chegou',quem,obs,to_jsonb(i));
    UPDATE crm_tts_cobranca_intencao_v2 SET estado='aceito',motivo='confirmado_no_seller_center',concluido_em=coalesce(concluido_em,now())
     WHERE revisao_id=i.revisao_id;
    RETURN jsonb_build_object('ok',true,'mensagem','Marcado como entregue. A régua segue a partir deste toque.');
   END IF;
   PERFORM crm_tts_cobranca_arquiva_v2(i,'nao_chegou',quem,obs);
   RETURN jsonb_build_object('ok',true,'mensagem','Marcado como não entregue. O toque volta para a fila.');
  END IF;
  INSERT INTO crm_tts_cobranca_supressao_v2(marca,creator_open_id,motivo) VALUES(i.marca,i.creator_open_id,left('painel: '||coalesce(nullif(obs,''),'tirado da régua'),200))
   ON CONFLICT DO NOTHING;
  IF i.estado='bloqueado' OR (i.estado='incerto' AND i.transporte_em IS NULL) THEN
   PERFORM crm_tts_cobranca_arquiva_v2(i,'suprimir',quem,obs);
  ELSE
   INSERT INTO crm_tts_cobranca_resolucao_v2(marca,etapa,username,creator_open_id,tentativa,estado_antes,motivo_antes,decisao,por,obs,intencao)
    VALUES(i.marca,i.etapa,i.username,i.creator_open_id,i.tentativa,i.estado,i.motivo,'suprimir',quem,obs,to_jsonb(i));
  END IF;
  DELETE FROM crm_tts_cobranca_pulo WHERE marca=i.marca AND username=i.username;
  RETURN jsonb_build_object('ok',true,'mensagem','Tirado da régua. O robô não fala mais com essa pessoa.');
 END IF;
 IF acao='reativar' THEN
  DELETE FROM crm_tts_cobranca_supressao_v2 WHERE marca=d->>'marca' AND creator_open_id=d->>'creator_open_id';
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','Essa pessoa não está fora da régua.'); END IF;
  INSERT INTO crm_tts_cobranca_resolucao_v2(marca,creator_open_id,decisao,por,obs) VALUES(d->>'marca',d->>'creator_open_id','reativar',quem,left(coalesce(d->>'obs',''),300));
  RETURN jsonb_build_object('ok',true,'mensagem','Voltou a poder receber a régua.');
 END IF;
 RETURN jsonb_build_object('erro','Ação inválida.');
END $$;

REVOKE ALL ON FUNCTION crm_tts_cobranca_produto_v2(text,text),crm_tts_cobranca_nome_v2(text),crm_tts_cobranca_motivo_humano_v2(text),
 crm_tts_cobranca_motivo_espera_v2(text),crm_tts_cobranca_motivo_v2(text),crm_tts_cobranca_arquiva_v2(crm_tts_cobranca_intencao_v2,text,text,text),
 crm_tts_cobranca_prepara_v2(uuid),crm_tts_cobranca_reserva_v2(text,uuid),crm_tts_cobranca_conclui_v2(text,uuid,text,text,text,jsonb),crm_tts_cobranca_pronta_v2(text),
 crm_tts_cobranca_painel_v1(jsonb) FROM PUBLIC;
COMMIT;
