// Monta o payload da aba "Afiliados TikTok Shop" do influs.html numa consulta só (jsonb).
// Janela (ini/fim) vale para PEDIDOS. Amostras não têm data na API → blocos de amostra são "histórico/agora".
const b = $json.body || {};
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const hoje = new Date().toISOString().slice(0, 10);
const d30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
const ini = DATA.test(String(b.ini || '')) ? b.ini : d30;
const fim = DATA.test(String(b.fim || '')) ? b.fim : hoje;

const sql = `
WITH j AS (SELECT '${ini}'::date AS ini, '${fim}'::date AS fim),
ped AS (  -- pedidos de afiliado na janela; reembolso/cancelado (INELIGIBLE) fica fora do GMV
  SELECT p.*, COALESCE(p.base_real, p.base_estimada, 0) AS gmv, COALESCE(p.comissao_real, p.comissao_estimada, 0) AS com
  FROM crm_tts_pedido p, j WHERE p.dia BETWEEN j.ini AND j.fim AND COALESCE(p.settlement_status,'') <> 'INELIGIBLE'
),
kpi AS (
  SELECT marca, count(DISTINCT order_id)::int AS pedidos, round(sum(gmv),2) AS gmv, round(sum(com),2) AS comissao,
         count(DISTINCT username)::int AS criadores,
         round(100.0 * sum(gmv) FILTER (WHERE content_type='VIDEO') / NULLIF(sum(gmv),0), 1) AS pct_video,
         round(100.0 * sum(gmv) FILTER (WHERE content_type='LIVE')  / NULLIF(sum(gmv),0), 1) AS pct_live
  FROM ped GROUP BY 1
),
amo AS (
  SELECT marca,
    count(*)::int AS total,
    count(*) FILTER (WHERE status='PENDING')::int AS pendentes,
    count(*) FILTER (WHERE status='AWAITING_SHIPMENT')::int AS aguardando_envio,
    count(*) FILTER (WHERE status IN ('SHIPPED','CONTENT_PENDING'))::int AS em_transito_ou_conteudo,
    count(*) FILTER (WHERE status IN ('COMPLETED','OPS_COMPLETED'))::int AS completas,
    count(*) FILTER (WHERE status='OVERDUE_CANCELLED')::int AS venceu_sem_decisao,
    count(*) FILTER (WHERE status='SELLER_NOT_SHIP_CANCELLED')::int AS aprovada_nao_enviada,
    count(*) FILTER (WHERE status='REJECT_CANCELLED')::int AS rejeitadas,
    count(*) FILTER (WHERE status IN ('UNFULFILL_CANCELLED'))::int AS criador_nao_postou,
    min(approve_expira_em) FILTER (WHERE status='PENDING') AS pendente_mais_urgente
  FROM crm_tts_amostra GROUP BY 1
),
regra AS (SELECT * FROM crm_tts_regra),
fila AS (SELECT * FROM crm_tts_fila_v),  -- tier vem da VIEW (fonte única com a esteira)
envio AS (
  SELECT a.marca, a.application_id, a.username, a.product_title, a.sku_name, a.envio_expira_em, a.order_id
  FROM crm_tts_amostra a WHERE a.status='AWAITING_SHIPMENT'
),
cri AS (  -- ranking de criadores na janela (quem vendeu) + saúde de amostra
  SELECT p.marca, p.username, c.nickname, c.seguidores, c.gmv_30d, c.fulfillment_pct,
         count(DISTINCT p.order_id)::int AS pedidos, round(sum(p.gmv),2) AS gmv, round(sum(p.com),2) AS comissao,
         round(100.0 * sum(p.gmv) FILTER (WHERE p.content_type='VIDEO') / NULLIF(sum(p.gmv),0)) AS pct_video,
         c.amostras_total, c.amostras_completas
  FROM ped p LEFT JOIN crm_tts_criador c ON c.marca=p.marca AND c.username=p.username
  WHERE p.username IS NOT NULL GROUP BY 1,2,3,4,5,6,11,12
),
colab_open AS (
  SELECT marca, colab_id, product_id, product_title, product_status, comissao_pct, inventario, preco_min, preco_max,
         showcase_count, content_creator_count
  FROM crm_tts_colaboracao WHERE ativo AND tipo='open'
),
colab_target AS (
  SELECT marca, colab_id, nome, status, invited_count, showcase_count, content_creator_count, product_count,
         round(avg(comissao_pct),1) AS comissao_pct, min(inicio_em) AS inicio_em, max(fim_em) AS fim_em,
         bool_or(has_free_sample) AS has_free_sample,
         count(*) FILTER (WHERE product_status <> 'LIVE')::int AS produtos_fora_do_ar,
         jsonb_agg(DISTINCT product_title) FILTER (WHERE product_title IS NOT NULL) AS produtos
  FROM crm_tts_colaboracao WHERE ativo AND tipo='target' GROUP BY 1,2,3,4,5,6,7,8
),
serie AS (SELECT marca, dia, round(sum(gmv),2) AS gmv, count(DISTINCT order_id)::int AS pedidos FROM ped GROUP BY 1,2),
canal AS (  -- Canal (Shop Analytics) na janela: total da loja por dia, fatia por superfície e por origem
  SELECT v.marca, v.dia, v.gmv, v.gmv_live, v.gmv_video, v.gmv_vitrine, v.gmv_afiliado, v.gmv_proprio, v.gmv_ads, v.pedidos, v.visitantes, v.reembolso
  FROM crm_tts_canal_v v, j WHERE v.dia BETWEEN j.ini AND j.fim
),
canal_tot AS (  -- resumo da janela por marca (o que vai nos cartões da aba Canal)
  SELECT marca, count(*)::int AS dias, round(sum(gmv),2) AS gmv, round(sum(gmv_live),2) AS gmv_live, round(sum(gmv_video),2) AS gmv_video,
         round(sum(gmv_vitrine),2) AS gmv_vitrine, round(sum(gmv_afiliado),2) AS gmv_afiliado, round(sum(gmv_proprio),2) AS gmv_proprio,
         round(sum(gmv_ads),2) AS gmv_ads, sum(pedidos)::int AS pedidos, sum(visitantes)::bigint AS visitantes, round(sum(reembolso),2) AS reembolso,
         round(100.0 * sum(gmv_afiliado) / NULLIF(sum(gmv),0), 1) AS pct_afiliado,
         round(100.0 * sum(gmv_live) / NULLIF(sum(gmv),0), 1) AS pct_live,
         round(100.0 * sum(gmv_video) / NULLIF(sum(gmv),0), 1) AS pct_video,
         round(100.0 * sum(gmv_vitrine) / NULLIF(sum(gmv),0), 1) AS pct_vitrine,
         round(100.0 * sum(gmv_ads) / NULLIF(sum(gmv),0), 1) AS pct_gmv_max,
         round(100.0 * sum(pedidos) / NULLIF(sum(visitantes),0), 2) AS conversao_pct,
         round(sum(gmv) / NULLIF(sum(pedidos),0), 2) AS ticket_medio,
         max(dia) AS ultimo_dia
  FROM canal GROUP BY 1
),
lives AS (  -- sessões de live na janela (loja e afiliados), com venda e interação
  SELECT marca, live_id, dia, username, origem, left(titulo, 60) AS titulo, inicio_em, fim_em, duracao_min, gmv, gmv_24h, pedidos, pedidos_criados, compradores,
         espectadores, cliques, impressoes_produto, ctr_pct, clique_pedido_pct, novos_seguidores, atualizado_em
  FROM crm_tts_live_dia l, j WHERE l.dia BETWEEN j.ini AND j.fim
),
live_prod AS (  -- o que vendeu em cada live da janela (só lives com venda; a API só devolve produto para live da própria loja)
  SELECT p.marca, p.live_id, p.product_id, left(p.nome, 80) AS nome, p.gmv_direto, p.pedidos, p.pedidos_criados, p.compradores, p.impressoes, p.cliques, p.ctr_pct, p.clique_pedido_pct, p.gpm
  FROM crm_tts_live_produto p JOIN lives l ON l.marca = p.marca AND l.live_id = p.live_id
  WHERE p.gmv_direto > 0 OR p.cliques >= 10
),
videos AS (  -- retrato mais recente dos vídeos (30 dias acumulados, top por GMV) — não é por dia
  -- só o que a tela mostra: título cortado, sem produtos/hashtags (ficam no banco para análise)
  SELECT marca, dia AS retrato_em, video_id, username, origem, left(titulo, 90) AS titulo, publicado_em, gmv, gpm, pedidos, visualizacoes, ctr_pct, duracao_s
  FROM crm_tts_video_dia v WHERE v.dia = (SELECT max(dia) FROM crm_tts_video_dia x WHERE x.marca = v.marca)
),
cob AS (  -- Cobrança de conteúdo: o que já saiu e o que está na fila de simulação.
  SELECT marca,
         count(*) FILTER (WHERE NOT dry_run AND ok)::int  AS enviadas,
         count(*) FILTER (WHERE NOT dry_run AND NOT ok)::int AS falhas,
         count(*) FILTER (WHERE dry_run)::int              AS simuladas,
         max(enviado_em) AS ultima
  FROM crm_tts_cobranca GROUP BY 1
),
cob_fila AS (  -- as mensagens em si, para a Marcela ler antes de qualquer criador receber
  SELECT marca, etapa, username, tentativa, dry_run, ok, erro, texto, enviado_em
  FROM crm_tts_cobranca ORDER BY dry_run DESC, enviado_em DESC LIMIT 200
),
cob_regra AS (SELECT marca, cobranca_modo, cobranca_max_dia, cobranca_max_tentativas, cobranca_dias_entre FROM crm_tts_regra),
cob_pulo AS (  -- quem o robô NÃO cobrou porque a conversa está viva: respondeu (bola com a Marcela) ou alguém falou há pouco
  SELECT marca, etapa, username, tentativa, motivo, nao_lidas, ultima_msg_em, ultima_msg_de, ultimo_texto, visto_em
  FROM crm_tts_cobranca_pulo WHERE visto_em > now() - interval '30 days'
  ORDER BY (motivo = 'respondeu') DESC, nao_lidas DESC, ultima_msg_em DESC LIMIT 200
),
cob_pend AS (  -- quantos ainda faltam no total, independente do teto diário
  SELECT marca, count(*)::int AS pendentes FROM (
    SELECT marca, username FROM crm_tts_convite
     WHERE showcase_product_count > 0 AND content_product_count = 0
    UNION
    SELECT marca, username FROM crm_tts_amostra WHERE status IN ('SHIPPED','CONTENT_PENDING')
  ) x GROUP BY 1
),
-- PROVA DE NÍVEL DE APP: se uma loja já usa a família, então o app TEM a permissão, e a outra loja
-- que ainda responde 'reautorizar' precisa mesmo é de uma autorização nova. Isso resolve a ambiguidade
-- que me enganou em 16/09: a mensagem de erro sozinha não distingue "em análise" de "falta reautorizar".
-- Medido em 17/09: o Aristo foi reautorizado depois da submissão do app e as 4 famílias viraram 'ok';
-- a Fishermans continuou em 'reautorizar' — e ali a palavra passou a valer literalmente.
app_tem AS (
  SELECT familia FROM crm_tts_escopo GROUP BY familia HAVING bool_or(estado = 'ok')
),
esc AS (  -- Estado de cada família de escopo (Sonda, 6h) cruzado com a data da última autorização.
          -- A verdade é granted_scopes, não a mensagem de erro: medido em 16/09, a mensagem
          -- "the access token does not include" NÃO garante que a permissão já esteja aprovada —
          -- reautorizamos as duas lojas às 13h41 com essas 4 famílias nesse estado e nada entrou.
          -- Então só vale mandar reautorizar quando a família MUDOU de estado depois da última
          -- autorização; caso contrário reautorizar é trabalho à toa e a faixa tem que dizer isso.
  SELECT e.marca,
         -- pede reautorização quando a família mudou depois da última autorização OU quando a outra
         -- loja já prova que o app tem a permissão
         array_agg(e.rotulo ORDER BY e.rotulo) FILTER (
           WHERE e.estado <> 'ok'
             AND ((e.mudou_em IS NOT NULL AND e.mudou_em > t.autorizado_em)
                  OR e.familia IN (SELECT familia FROM app_tem))) AS mudou_desde_autorizacao,
         array_agg(e.rotulo ORDER BY e.rotulo) FILTER (
           WHERE e.estado <> 'ok'
             AND NOT (e.mudou_em IS NOT NULL AND e.mudou_em > t.autorizado_em)
             AND e.familia NOT IN (SELECT familia FROM app_tem)) AS aguardando_tiktok,
         array_agg(e.rotulo ORDER BY e.rotulo) FILTER (WHERE e.estado = 'desconhecido') AS nao_medido,
         max(e.verificado_em) AS verificado_em,
         max(t.autorizado_em) AS autorizado_em,
         -- a última autorização já foi conferida pela sonda e não trouxe nada? então não peça outra.
         bool_or(e.verificado_em > t.autorizado_em) AS conferido_apos_autorizar
  FROM crm_tts_escopo e
  JOIN crm_tts_token t ON t.loja = e.loja
  GROUP BY 1
),
aut AS (  -- saúde da autorização por loja: sem isto, um escopo faltando vira tabela vazia sem explicação
  SELECT t.marca, t.loja, t.seller_name, t.autorizado_em, t.refresh_expira_em,
         (t.refresh_expira_em IS NOT NULL AND t.refresh_expira_em < now() + interval '14 days') AS expira_em_breve,
         t.granted_scopes,
         -- escopos que o canal exige e a autorização NÃO tem. Vazio = dá para coletar o canal.
         -- escopo que o canal exige e que a loja NÃO tem. Medido, não deduzido: a Sonda diz 'ok' para a
         -- família analytics OU uma coleta de canal já passou depois da última autorização. (granted_scopes
         -- gravado na captura pode vir incompleto: em 17/09 a Fishermans gravou 5 e a API já devolvia 9.)
         CASE WHEN EXISTS (SELECT 1 FROM crm_tts_escopo e WHERE e.loja = t.loja AND e.familia = 'analytics' AND e.estado = 'ok')
                OR EXISTS (SELECT 1 FROM crm_tts_coleta_log l WHERE l.marca = t.marca AND l.fonte LIKE 'canal%' AND l.ok AND l.terminado_em > t.autorizado_em)
              THEN '{}'::text[] ELSE ARRAY['data.shop_analytics.public.read'] END AS escopos_faltando,
         (SELECT l.erro FROM crm_tts_coleta_log l
           WHERE l.marca = t.marca AND l.fonte LIKE 'canal%' AND NOT l.ok
           ORDER BY l.terminado_em DESC LIMIT 1) AS ultimo_erro_canal
  FROM crm_tts_token t
),
frescor AS (  -- por marca: última coleta OK, última tentativa e se a ÚLTIMA execução de cada fonte deu certo
  SELECT marca, max(terminado_em) FILTER (WHERE ok) AS ultima_ok, max(terminado_em) AS ultima,
         bool_and(ok) FILTER (WHERE rn = 1) AS ultima_ok_todas,
         string_agg(fonte || ': ' || COALESCE(erro,'?'), ' · ') FILTER (WHERE rn = 1 AND NOT ok) AS erros
  FROM (SELECT *, row_number() OVER (PARTITION BY marca, fonte ORDER BY terminado_em DESC) AS rn
          FROM crm_tts_coleta_log WHERE fonte IN ('pedidos','amostras','open','target')) x
  GROUP BY 1
)
SELECT jsonb_build_object(
  'gerado_em', now(),
  'janela', jsonb_build_object('ini','${ini}','fim','${fim}'),
  'frescor', COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM frescor f), '[]'),
  'autorizacao', COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM aut a), '[]'),
  'escopos', COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM esc e), '[]'),
  'cobranca', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM cob c), '[]'),
  'cobranca_fila', COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM cob_fila f), '[]'),
  'cobranca_regra', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM cob_regra r), '[]'),
  'cobranca_pendentes', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM cob_pend p), '[]'),
  'cobranca_pulos', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM cob_pulo p), '[]'),
  'kpis', COALESCE((SELECT jsonb_agg(to_jsonb(k)) FROM kpi k), '[]'),
  'amostras', COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM amo a), '[]'),
  'regra', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM regra r), '[]'),
  'fila', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.approve_expira_em) FROM fila f), '[]'),
  'envio', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.envio_expira_em) FROM envio e), '[]'),
  'criadores', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.gmv DESC) FROM (SELECT * FROM cri ORDER BY gmv DESC LIMIT 300) c), '[]'),
  'open', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.marca, o.showcase_count DESC) FROM colab_open o), '[]'),
  'target', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.marca, t.fim_em DESC NULLS LAST) FROM colab_target t), '[]'),
  'serie', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.marca, s.dia) FROM serie s), '[]'),
  'canal', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.marca, c.dia) FROM canal c), '[]'),
  'canal_total', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM canal_tot c), '[]'),
  'lives', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.gmv DESC, l.inicio_em DESC) FROM (SELECT * FROM lives ORDER BY gmv DESC, inicio_em DESC LIMIT 60) l), '[]'),
  'videos', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.gmv DESC) FROM (SELECT * FROM videos WHERE gmv > 0 ORDER BY gmv DESC LIMIT 30) v), '[]'),
  'live_produtos', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.live_id, p.gmv_direto DESC) FROM (SELECT * FROM live_prod ORDER BY gmv_direto DESC LIMIT 400) p), '[]')
) AS payload`;
return [{ json: { sql } }];
