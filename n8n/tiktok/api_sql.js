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
esc AS (  -- Estado de cada família de escopo (Sonda, 6h) cruzado com a data da última autorização.
          -- A verdade é granted_scopes, não a mensagem de erro: medido em 16/09, a mensagem
          -- "the access token does not include" NÃO garante que a permissão já esteja aprovada —
          -- reautorizamos as duas lojas às 13h41 com essas 4 famílias nesse estado e nada entrou.
          -- Então só vale mandar reautorizar quando a família MUDOU de estado depois da última
          -- autorização; caso contrário reautorizar é trabalho à toa e a faixa tem que dizer isso.
  SELECT e.marca,
         array_agg(e.rotulo ORDER BY e.rotulo) FILTER (
           WHERE e.estado <> 'ok' AND e.mudou_em IS NOT NULL AND e.mudou_em > t.autorizado_em) AS mudou_desde_autorizacao,
         array_agg(e.rotulo ORDER BY e.rotulo) FILTER (
           WHERE e.estado <> 'ok' AND NOT (e.mudou_em IS NOT NULL AND e.mudou_em > t.autorizado_em)) AS aguardando_tiktok,
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
         ARRAY(SELECT s FROM unnest(ARRAY['seller.data.read','seller.order.read','seller.product.read']) s
                WHERE NOT (s = ANY(COALESCE(t.granted_scopes, '{}')))) AS escopos_faltando,
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
  'kpis', COALESCE((SELECT jsonb_agg(to_jsonb(k)) FROM kpi k), '[]'),
  'amostras', COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM amo a), '[]'),
  'regra', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM regra r), '[]'),
  'fila', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.approve_expira_em) FROM fila f), '[]'),
  'envio', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.envio_expira_em) FROM envio e), '[]'),
  'criadores', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.gmv DESC) FROM (SELECT * FROM cri ORDER BY gmv DESC LIMIT 300) c), '[]'),
  'open', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.marca, o.showcase_count DESC) FROM colab_open o), '[]'),
  'target', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.marca, t.fim_em DESC NULLS LAST) FROM colab_target t), '[]'),
  'serie', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.marca, s.dia) FROM serie s), '[]')
) AS payload`;
return [{ json: { sql } }];
