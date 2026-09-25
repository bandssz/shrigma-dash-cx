INSERT INTO crm_campanha (marca,canal,campanha_id,nome,utm_campaign,utm_content,tipo,enviado_em,publico,enviados,entregues,aberturas,abriram,cliques,clicaram,hard,soft,complaints,descadastros,truncado,aberturas_provedor,cliques_provedor,cliques_link,congelado,coletas_ok,coletas_total,coletado_em)
WITH camp AS (
  -- c.tags precisa estar AQUI: o SELECT externo le do CTE, nao de campaigns. Faltou em
  -- 22/08 e a query quebrou calada por 12 dias ('column c.tags does not exist').
  SELECT c.id, c.name, c.from_email, c.status, c.to_send, c.sent, c.started_at, c.tags,
         -- agendada ainda nao tem started_at: mostra a data PREVISTA (send_at), nao a de criacao
         COALESCE(c.started_at, c.send_at, c.created_at) AS enviado_em,
         CASE
           WHEN c.from_email ILIKE '%oaristocrata.com%'   THEN 'aristo'
           WHEN c.from_email ILIKE '%fishermans.com.br%'  THEN 'fish'
           WHEN c.from_email ILIKE '%olivasdocampo.com%'  THEN 'olivas'
           ELSE (SELECT CASE
                   WHEN bool_or(cl.list_id IN (16,7,10,19,20,21,30,31,32,33,34,35,36,37,38,39)) THEN 'aristo'
                   WHEN bool_or(cl.list_id IN (17,3,9,22))    THEN 'fish'
                   WHEN bool_or(cl.list_id IN (40,41,42,43))  THEN 'olivas' END
                 FROM campaign_lists cl WHERE cl.campaign_id = c.id)
         END AS marca
  FROM campaigns c
  WHERE c.status <> 'draft'
    AND COALESCE(c.started_at, c.send_at, c.created_at) >= now() - interval '120 days'
),
utm AS (
  SELECT lc.campaign_id,
         (regexp_match(l.url,'utm_campaign=([^&]+)'))[1] AS utm_campaign,
         (regexp_match(l.url,'utm_content=([^&]+)'))[1]  AS utm_content,
         count(*) AS n
  FROM link_clicks lc JOIN links l ON l.id = lc.link_id
  WHERE l.url LIKE '%utm_campaign=%'
  GROUP BY 1,2,3
),
utm_top AS (
  SELECT DISTINCT ON (campaign_id) campaign_id, utm_campaign, utm_content
  FROM utm ORDER BY campaign_id, n DESC
),
prov AS (
  SELECT s.id AS sid,
    CASE WHEN s.email ~* '@(gmail|googlemail)\.'          THEN 'gmail'
         WHEN s.email ~* '@(hotmail|outlook|live|msn)\.'  THEN 'outlook'
         WHEN s.email ~* '@(yahoo|ymail)\.'               THEN 'yahoo'
         WHEN s.email ~* '@(icloud|me|mac)\.com'          THEN 'icloud'
         WHEN s.email ~* '@(bol|uol|terra|ig|globo)\.com' THEN 'brasileiro'
         ELSE 'outro' END AS p
  FROM subscribers s
),
ab AS (
  SELECT v.campaign_id, pr.p, count(DISTINCT v.subscriber_id) AS n
  FROM campaign_views v JOIN prov pr ON pr.sid = v.subscriber_id
  WHERE v.campaign_id IN (SELECT id FROM camp) GROUP BY 1,2
),
cl AS (
  SELECT k.campaign_id, pr.p, count(DISTINCT k.subscriber_id) AS n
  FROM link_clicks k JOIN prov pr ON pr.sid = k.subscriber_id
  WHERE k.campaign_id IN (SELECT id FROM camp) GROUP BY 1,2
),
links_camp AS (
  SELECT lc.campaign_id, jsonb_agg(jsonb_build_object('link_id',l.id,'url',left(l.url,180),'cliques',n)
         ORDER BY n DESC) AS j
  FROM (SELECT campaign_id, link_id, count(*) AS n FROM link_clicks GROUP BY 1,2) lc
  JOIN links l ON l.id = lc.link_id GROUP BY 1
)
SELECT
  c.marca, 'email' AS canal, c.id AS campanha_id, c.name AS nome,
  ut.utm_campaign, ut.utm_content,
  CASE
    -- sem started_at = nao saiu ainda. Fica na FILA, nunca na lista de resultado:
    -- 0 enviados dividido por 0 entregues nao e taxa, e ruido.
    WHEN c.started_at IS NULL AND c.status IN ('scheduled','paused') THEN 'agendada'
    -- Regua automatica nasce do n8n e sempre tem tag propria; campanha manual do
    -- Listmonk nao tem. A regra antiga casava o NOME e classificava errado toda
    -- campanha com 'carrinho' no titulo (ex: 'FISH COPO - S3 Carrinho nao-comprador').
    WHEN c.tags::text[] && ARRAY['fluxo','regua','automatico','transacional']
      OR c.name ~* '^(welcome|nps|transacional)\M'
      OR c.name ~* '(regua|r[eé]gua) de (carrinho|abandono)' THEN 'fluxo'
    ELSE 'campanha' END AS tipo,
  c.enviado_em, c.to_send AS publico, c.sent AS enviados,
  c.sent
    - (SELECT count(*) FROM bounces b WHERE b.campaign_id=c.id AND b.type='hard')
    - (SELECT count(*) FROM bounces b WHERE b.campaign_id=c.id AND b.type='soft') AS entregues,
  CASE WHEN c.enviado_em >= '2026-07-19' THEN (SELECT count(*) FROM campaign_views v WHERE v.campaign_id=c.id) END AS aberturas,
  CASE WHEN c.enviado_em >= '2026-07-19' THEN (SELECT count(DISTINCT subscriber_id) FROM campaign_views v WHERE v.campaign_id=c.id) END AS abriram,
  CASE WHEN c.enviado_em >= '2026-07-19' THEN (SELECT count(*) FROM link_clicks k WHERE k.campaign_id=c.id) END AS cliques,
  CASE WHEN c.enviado_em >= '2026-07-19' THEN (SELECT count(DISTINCT subscriber_id) FROM link_clicks k WHERE k.campaign_id=c.id) END AS clicaram,
  (SELECT count(*) FROM bounces b WHERE b.campaign_id=c.id AND b.type='hard')      AS hard,
  (SELECT count(*) FROM bounces b WHERE b.campaign_id=c.id AND b.type='soft')      AS soft,
  (SELECT count(*) FROM bounces b WHERE b.campaign_id=c.id AND b.type='complaint') AS complaints,
  NULL::integer AS descadastros,
  (c.sent < c.to_send * 0.98) AS truncado,
  (SELECT jsonb_object_agg(p,n) FROM ab WHERE ab.campaign_id=c.id) AS aberturas_provedor,
  (SELECT jsonb_object_agg(p,n) FROM cl WHERE cl.campaign_id=c.id) AS cliques_provedor,
  (SELECT j FROM links_camp WHERE links_camp.campaign_id=c.id)     AS cliques_link,
  (now() - c.enviado_em > interval '7 days') AS congelado,
  CASE WHEN c.enviado_em >= '2026-07-19' THEN 2 ELSE 1 END AS coletas_ok, 2 AS coletas_total, now() AS coletado_em
FROM camp c LEFT JOIN utm_top ut ON ut.campaign_id = c.id

WHERE c.marca IS NOT NULL
ON CONFLICT (marca,canal,campanha_id) DO UPDATE SET nome=EXCLUDED.nome, utm_campaign=EXCLUDED.utm_campaign, utm_content=EXCLUDED.utm_content, tipo=EXCLUDED.tipo, enviado_em=EXCLUDED.enviado_em, publico=EXCLUDED.publico, enviados=EXCLUDED.enviados, entregues=EXCLUDED.entregues, aberturas=EXCLUDED.aberturas, abriram=EXCLUDED.abriram, cliques=EXCLUDED.cliques, clicaram=EXCLUDED.clicaram, hard=EXCLUDED.hard, soft=EXCLUDED.soft, complaints=EXCLUDED.complaints, descadastros=EXCLUDED.descadastros, truncado=EXCLUDED.truncado, aberturas_provedor=EXCLUDED.aberturas_provedor, cliques_provedor=EXCLUDED.cliques_provedor, cliques_link=EXCLUDED.cliques_link, congelado=EXCLUDED.congelado, coletas_ok=EXCLUDED.coletas_ok, coletas_total=EXCLUDED.coletas_total, coletado_em=EXCLUDED.coletado_em
WHERE crm_campanha.congelado IS NOT TRUE
