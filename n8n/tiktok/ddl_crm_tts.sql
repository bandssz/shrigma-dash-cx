-- ============================================================
-- TikTok Shop · Afiliados — camada de dados (schema v1, 14/09/2026)
-- Mesmo banco dos crm_* (credencial n8n "Postgres account 2").
-- Convenção de marca: 'aristo' | 'fish' (igual crm_influ_pedido).
-- Dinheiro em BRL (numeric), tempos em timestamptz, epochs da API convertidos com to_timestamp().
-- ============================================================

-- 1) Criador × marca — snapshot mais recente do que a API entrega junto de cada pedido de amostra.
--    Decisão que ajuda: fila manual e ranking (quem vende, quem posta).
CREATE TABLE IF NOT EXISTS crm_tts_criador (
  marca            text NOT NULL,
  username         text NOT NULL,
  open_id          text,
  nickname         text,
  seguidores       integer,
  gmv_30d          numeric(12,2),          -- BRL, últimos 30 dias (vazio = criador não divulga)
  fulfillment_pct  numeric(5,2),           -- % de amostras postadas nos últimos 90 dias
  amostras_total   integer DEFAULT 0,      -- recalculado pelo coletor a partir de crm_tts_amostra
  amostras_completas integer DEFAULT 0,
  pedidos_90d      integer DEFAULT 0,      -- recalculado a partir de crm_tts_pedido
  gmv_90d_marca    numeric(12,2) DEFAULT 0,-- o que ELE vendeu DA MARCA (actual_commission_base)
  ultimo_pedido_amostra_em timestamptz,
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, username)
);

-- 2) Pedido de amostra — 1 linha por application_id. Fonte da métrica de perda operacional
--    (OVERDUE_CANCELLED + SELLER_NOT_SHIP_CANCELLED) e da fila manual.
CREATE TABLE IF NOT EXISTS crm_tts_amostra (
  marca              text NOT NULL,
  application_id     text NOT NULL,
  username           text,
  creator_open_id    text,
  product_id         text,
  product_title      text,
  sku_id             text,
  sku_name           text,
  status             text,                 -- enum da plataforma (PENDING, COMPLETED, OVERDUE_CANCELLED...)
  fulfillment_status text,                 -- PENDING/ONGOING/SUCCEED/FAILED/OVERDUE/...
  is_approvable      boolean,
  motivo_nao_aprovavel text,
  commission_rate    numeric(5,2),         -- % (API manda 0.15 → 15.00)
  order_id           text,
  tracking_number    text,
  approve_expira_em  timestamptz,
  envio_expira_em    timestamptz,
  pedido_em_estimado timestamptz,          -- approve_expira_em - 7 dias (API não devolve create_time)
  estoque_amostra    integer,              -- available_quantity
  -- snapshot do criador NO MOMENTO do pedido (auditoria da esteira; não muda depois)
  snap_seguidores    integer,
  snap_gmv_30d       numeric(12,2),
  snap_fulfillment_pct numeric(5,2),
  -- decisão da esteira (nossa camada, independente do status da plataforma)
  decisao            text,                 -- auto_aprovada | auto_rejeitada | fila_manual | manual_aprovada | manual_rejeitada | plataforma (já decidido antes da esteira)
  decisao_motivo     text,                 -- ex.: 'gmv 12.400 ≥ 10.000; sku permitido' / 'sku fora da lista'
  decisao_tier       text,                 -- comprovado | descoberta | fora
  decidido_em        timestamptz,
  decidido_por       text,                 -- esteira | marcela | felipe | plataforma
  dry_run            boolean DEFAULT true, -- true = só gravou a decisão, não chamou /review
  primeiro_visto_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, application_id)
);
CREATE INDEX IF NOT EXISTS crm_tts_amostra_status_idx ON crm_tts_amostra (marca, status);
CREATE INDEX IF NOT EXISTS crm_tts_amostra_user_idx   ON crm_tts_amostra (marca, username);

-- 3) Pedido de afiliado — 1 linha por SKU de pedido. Fonte de GMV/comissão por criador e por conteúdo.
CREATE TABLE IF NOT EXISTS crm_tts_pedido (
  marca              text NOT NULL,
  order_id           text NOT NULL,
  sku_id             text NOT NULL,
  content_id         text NOT NULL DEFAULT '',
  criado_em          timestamptz,
  dia                date,                 -- dia comercial em America/Sao_Paulo
  entregue_em        timestamptz,
  username           text,
  content_type       text,                 -- VIDEO | LIVE | SHOP | LINKSHARE | PRE_LIVE | PROMOTION_PAGE
  product_id         text,
  quantidade         integer,
  preco              numeric(12,2),
  settlement_status  text,                 -- AWAITING PAYMENT | To-SETTLE | SETTLED | INELIGIBLE
  commission_rate    numeric(5,2),         -- % (API manda 1550 → 15.50)
  base_estimada      numeric(12,2),
  comissao_estimada  numeric(12,2),
  base_real          numeric(12,2),        -- após reembolso
  comissao_real      numeric(12,2),
  open_collab_id     text,
  target_collab_id   text,
  shop_ads_rate      numeric(5,2),
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, order_id, sku_id, content_id)
);
CREATE INDEX IF NOT EXISTS crm_tts_pedido_dia_idx  ON crm_tts_pedido (marca, dia);
CREATE INDEX IF NOT EXISTS crm_tts_pedido_user_idx ON crm_tts_pedido (marca, username);

-- 4) Colaborações — open (1 linha por produto) e target (1 linha por target × produto, cabeçalho repetido).
CREATE TABLE IF NOT EXISTS crm_tts_colaboracao (
  marca              text NOT NULL,
  tipo               text NOT NULL,        -- open | target
  colab_id           text NOT NULL,
  product_id         text NOT NULL DEFAULT '',
  nome               text,                 -- target: nome da campanha; open: título do produto
  product_title      text,
  product_status     text,                 -- LIVE | OUT_OF_STOCK | SELLER_DEACTIVATE | PLATFORM_DEACTIVATE | ...
  status             text,                 -- open: NORMAL/TERMINATING; target: ONGOING/EXPIRING/VALID/...
  comissao_pct       numeric(5,2),
  inventario         integer,
  preco_min          numeric(12,2),
  preco_max          numeric(12,2),
  showcase_count     integer,
  content_creator_count integer,
  invited_count      integer,              -- só target
  product_count      integer,              -- só target
  has_free_sample    boolean,
  sample_approval_exempt boolean,
  inicio_em          timestamptz,
  fim_em             timestamptz,
  ativo              boolean NOT NULL DEFAULT true, -- false quando sumiu da busca (coletor marca)
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, tipo, colab_id, product_id)
);

-- 4b) Convidados de target collab — 1 linha por target × criador. Decisão: follow-up de quem foi convidado e não postou.
CREATE TABLE IF NOT EXISTS crm_tts_convite (
  marca              text NOT NULL,
  colab_id           text NOT NULL,
  username           text NOT NULL,
  creator_open_id    text,
  nickname           text,
  showcase_product_count integer,
  content_product_count  integer,
  collaboration_status   text,             -- NORMAL | ...
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, colab_id, username)
);

-- 5) Regras da esteira por marca — editáveis pelo painel.
CREATE TABLE IF NOT EXISTS crm_tts_regra (
  marca              text PRIMARY KEY,
  modo               text NOT NULL DEFAULT 'dry_run',   -- dry_run | ativo | pausado
  gmv_auto           numeric(12,2) NOT NULL,            -- ≥ → aprova automático
  gmv_manual         numeric(12,2) NOT NULL,            -- ≥ e < gmv_auto → fila manual
  fulfillment_min    numeric(5,2)  NOT NULL DEFAULT 86, -- abaixo disso (e > 0) → fora
  fulfillment_zero_ok boolean      NOT NULL DEFAULT true,-- 0% = sem histórico, não penaliza
  teto_mensal        integer NOT NULL,                  -- amostras aprovadas (auto+manual) por mês
  teto_escalonamento jsonb,                             -- ex.: [{"desde":"2026-10-01","teto":40}]
  skus_permitidos    text[] NOT NULL DEFAULT '{}',      -- sku_id que podem virar amostra (lista explícita)
  sku_regex          text,                              -- OU regex (Postgres ARE) sobre "titulo | sku_name"; casou = permitido
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_por     text
);
ALTER TABLE crm_tts_regra ADD COLUMN IF NOT EXISTS sku_regex text;

-- 6) Log de coleta — frescor no cabeçalho do painel.
CREATE TABLE IF NOT EXISTS crm_tts_coleta_log (
  id            bigserial PRIMARY KEY,
  marca         text,
  fonte         text NOT NULL,             -- amostras | pedidos | open | target | criadores
  iniciado_em   timestamptz NOT NULL DEFAULT now(),
  terminado_em  timestamptz,
  paginas       integer,
  linhas        integer,
  ok            boolean,
  erro          text
);

-- Seed das regras em dry_run (valores da proposta; Felipe ajusta pelo painel)
INSERT INTO crm_tts_regra (marca, modo, gmv_auto, gmv_manual, fulfillment_min, fulfillment_zero_ok, teto_mensal, skus_permitidos, atualizado_por)
VALUES
  ('fish',   'dry_run', 10000, 3000, 86, true, 30, '{}', 'seed 2026-09-14'),
  ('aristo', 'dry_run',  5000, 2000, 86, true, 15, '{}', 'seed 2026-09-14')
ON CONFLICT (marca) DO NOTHING;
-- Regra de SKU (14/09/2026, Felipe): Fishermans — multifilamento só 150 m, monofilamento só 300 m (menor variante);
-- Aristocrata — unitário ou kit de até 3 (misto incluso); fora: Kit/N Unidades com N ≥ 4. Casada contra "product_title | sku_name".
UPDATE crm_tts_regra SET sku_regex = '^(?!.*[Mm]onofilamento).*\|.*[^0-9]150 ?[Mm]|^(?=.*[Mm]onofilamento).*\|.*[^0-9]300 ?[Mm]', atualizado_em = now(), atualizado_por = 'regra de SKU 2026-09-14' WHERE marca = 'fish' AND sku_regex IS NULL;
UPDATE crm_tts_regra SET sku_regex = '^(?!.*(([Kk]it|-) ?([4-9]|[1-9][0-9]) ?([Uu]n|[Ss]abonete)|([4-9]|[1-9][0-9]) [Uu]nidades)).*', atualizado_em = now(), atualizado_por = 'regra de SKU 2026-09-14' WHERE marca = 'aristo' AND sku_regex IS NULL;

-- 7) Visão da fila: pedidos PENDING com o criador atual, a regra da marca e o tier sugerido.
--    Fonte única da lógica de tier — usada pela API do painel e pela esteira. Mudou a regra? Muda aqui.
CREATE OR REPLACE VIEW crm_tts_fila_v AS
SELECT a.marca, a.application_id, a.username, c.nickname, c.seguidores, c.gmv_30d, c.fulfillment_pct,
       a.product_title, a.sku_id, a.sku_name, a.approve_expira_em, a.is_approvable, a.motivo_nao_aprovavel,
       c.amostras_total, c.amostras_completas, c.pedidos_90d, c.gmv_90d_marca,
       a.decisao, a.decisao_motivo, a.decidido_em, a.dry_run,
       (a.sku_id = ANY(r.skus_permitidos))
         OR (r.sku_regex IS NOT NULL AND (a.product_title || ' | ' || COALESCE(a.sku_name,'')) ~ r.sku_regex) AS sku_ok,
       CASE
         WHEN r.marca IS NULL THEN 'sem_regra'
         -- SKU fora da regra: rejeita, MENOS quando o criador é comprovado (GMV 30d >= gmv_auto) — aí vai
         -- para a fila manual. Medido em 15/09: a esteira teria rejeitado @maykosantos_ia (R$ 24.514) por
         -- pedir 300 m, e a decisão humana foi aprovar e enviar.
         WHEN (cardinality(r.skus_permitidos) > 0 OR r.sku_regex IS NOT NULL)
              AND NOT (a.sku_id = ANY(r.skus_permitidos))
              AND NOT (r.sku_regex IS NOT NULL AND (a.product_title || ' | ' || COALESCE(a.sku_name,'')) ~ r.sku_regex)
           THEN CASE WHEN COALESCE(c.gmv_30d,0) >= r.gmv_auto THEN 'sku_fora_comprovado' ELSE 'fora_sku' END
         WHEN c.fulfillment_pct > 0 AND c.fulfillment_pct < r.fulfillment_min THEN 'fora_fulfillment'
         WHEN COALESCE(c.gmv_30d,0) >= r.gmv_auto THEN 'comprovado'
         WHEN COALESCE(c.gmv_30d,0) >= r.gmv_manual THEN 'descoberta'
         ELSE 'fora_gmv' END AS tier_sugerido,
       r.modo AS regra_modo, r.teto_mensal, r.gmv_auto, r.gmv_manual, r.fulfillment_min
FROM crm_tts_amostra a
LEFT JOIN crm_tts_criador c ON c.marca = a.marca AND c.username = a.username
LEFT JOIN crm_tts_regra r ON r.marca = a.marca
WHERE a.status = 'PENDING';

-- 8) Tokens de autorização por loja. Escrito pelo workflow "Captura de Autorização" a cada (re)autorização
--    e lido pelo Token Manager. Existe porque o pacote de ESCOPOS está amarrado à autorização: ligar um
--    escopo novo no Partner Center exige re-autorizar as lojas, e o refresh token novo tem que chegar ao
--    Token Manager sozinho — antes disso dependia de alguém editar a constante SEEDS no código.
CREATE TABLE IF NOT EXISTS crm_tts_token (
  loja               text PRIMARY KEY,   -- aristocrata | fishermans (nome usado pelo Token Manager)
  marca              text,               -- aristo | fish (slug das tabelas crm_*)
  shop_id            text,
  shop_cipher        text,
  refresh_token      text NOT NULL,
  refresh_expira_em  timestamptz,
  seller_name        text,
  open_id            text,
  autorizado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- v2 (15/09/2026) — CANAL INTEIRO, não só afiliados.
-- A Marcela vai responder por 100% do TikTok, então o painel precisa fechar o canal:
-- ads + afiliados + lives + orgânico. A modelagem abaixo copia a taxonomia OFICIAL da
-- plataforma (Seller University, "Sales Metrics Breakdown Logic"), que é a mesma que os
-- apps de analytics de TikTok Shop usam, porque é a única que reconcilia com o Seller Center:
--   · tipo de conteúdo  : LIVE | vídeo curto | product card (vitrine/busca)
--   · origem do pedido  : afiliado | próprio (seller)
--   · atribuição        : GMV direto (comprou dentro do conteúdo) x indireto (viu e comprou depois,
--                         last-touch, janela de 1 dia)
--   · ads x não-ads     : a plataforma separa "Ads Gross Revenue" de "Non-Ads Gross Revenue";
--                         o CUSTO de mídia NÃO vem da Shop API (é outro app, o TikTok Ads Business API),
--                         por isso entra por crm_tts_canal_custo até termos aquele app.
-- Decisão de modelagem: UMA tabela-fato com dimensões, não três tabelas paralelas por superfície.
-- Três tabelas separadas duplicariam GMV (um mesmo pedido é live E afiliado) e tornariam a
-- "conversão total do canal" impossível de fechar. Vídeo e live ganham tabela própria só no
-- grão de ENTIDADE (cada vídeo, cada transmissão), que é outro grão, não outra fatia do mesmo bolo.

-- 9) Fato diário do canal. Grão: (dia, marca, superficie, origem). Somar tudo de um dia = GMV do canal.
CREATE TABLE IF NOT EXISTS crm_tts_canal_dia (
  marca         text NOT NULL,
  dia           date NOT NULL,
  superficie    text NOT NULL,          -- live | video | vitrine | outros  (content type da plataforma)
  origem        text NOT NULL,          -- afiliado | proprio               (order source da plataforma)
  gmv           numeric(12,2) DEFAULT 0,
  gmv_direto    numeric(12,2) DEFAULT 0,-- comprou interagindo com o conteúdo
  gmv_indireto  numeric(12,2) DEFAULT 0,-- viu e comprou depois (last-touch, janela de 1 dia)
  gmv_ads       numeric(12,2) DEFAULT 0,-- parte do GMV acima que a plataforma marca como Ads Gross Revenue
  pedidos       integer DEFAULT 0,
  unidades      integer DEFAULT 0,
  compradores   integer DEFAULT 0,
  reembolso     numeric(12,2) DEFAULT 0,
  visualizacoes bigint  DEFAULT 0,      -- impressões do conteúdo (denominador da conversão)
  cliques       bigint  DEFAULT 0,      -- cliques no produto
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, dia, superficie, origem)
);
CREATE INDEX IF NOT EXISTS crm_tts_canal_dia_idx ON crm_tts_canal_dia (marca, dia);

-- 10) Vídeo × dia. Grão de ENTIDADE: qual peça vendeu. É o que responde "que criativo replicar".
CREATE TABLE IF NOT EXISTS crm_tts_video_dia (
  marca         text NOT NULL,
  dia           date NOT NULL,
  video_id      text NOT NULL,
  username      text,                   -- criador (nulo = conteúdo da própria loja)
  origem        text,                   -- afiliado | proprio
  titulo        text,
  publicado_em  timestamptz,
  gmv           numeric(12,2) DEFAULT 0,
  pedidos       integer DEFAULT 0,
  unidades      integer DEFAULT 0,
  visualizacoes bigint  DEFAULT 0,
  cliques       bigint  DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, dia, video_id)
);
CREATE INDEX IF NOT EXISTS crm_tts_video_dia_user_idx ON crm_tts_video_dia (marca, username, dia);

-- 11) Live × sessão. Grão de ENTIDADE: cada transmissão (não cada dia — uma live pode cruzar meia-noite).
CREATE TABLE IF NOT EXISTS crm_tts_live_dia (
  marca         text NOT NULL,
  live_id       text NOT NULL,
  dia           date NOT NULL,          -- dia de início, para juntar com o resto do painel
  username      text,
  origem        text,                   -- afiliado | proprio
  titulo        text,
  inicio_em     timestamptz,
  duracao_min   integer,
  gmv           numeric(12,2) DEFAULT 0,
  pedidos       integer DEFAULT 0,
  unidades      integer DEFAULT 0,
  visualizacoes bigint  DEFAULT 0,
  espectadores  integer DEFAULT 0,      -- únicos
  cliques       bigint  DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, live_id)
);
CREATE INDEX IF NOT EXISTS crm_tts_live_dia_idx ON crm_tts_live_dia (marca, dia);

-- 12) Custo de mídia por dia. Entrada MANUAL enquanto não existir o app do TikTok Ads Business API:
--     a Shop API não devolve investimento, só receita. Sem esta tabela não há ROAS nem take rate real.
CREATE TABLE IF NOT EXISTS crm_tts_canal_custo (
  marca         text NOT NULL,
  dia           date NOT NULL,
  custo_ads     numeric(12,2) DEFAULT 0,
  fonte         text DEFAULT 'manual',  -- manual | ads_api (quando o app existir, vira ads_api sozinho)
  observacao    text,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_por text,
  PRIMARY KEY (marca, dia)
);

-- 13) Visão do canal: as métricas que a Marcela vai olhar, já com os denominadores certos.
--     Conversão = pedidos / visualizações do conteúdo (a plataforma chama de CVR de conteúdo).
--     ROAS é BLENDED de propósito: o custo é do canal, não da superfície — dividir custo por
--     superfície seria inventar atribuição que a plataforma não dá.
CREATE OR REPLACE VIEW crm_tts_canal_v AS
WITH d AS (
  SELECT marca, dia,
         sum(gmv) AS gmv, sum(gmv_ads) AS gmv_ads, sum(gmv) - sum(gmv_ads) AS gmv_organico,
         sum(gmv) FILTER (WHERE origem = 'afiliado') AS gmv_afiliado,
         sum(gmv) FILTER (WHERE origem = 'proprio')  AS gmv_proprio,
         sum(gmv) FILTER (WHERE superficie = 'live')    AS gmv_live,
         sum(gmv) FILTER (WHERE superficie = 'video')   AS gmv_video,
         sum(gmv) FILTER (WHERE superficie = 'vitrine') AS gmv_vitrine,
         sum(gmv_direto) AS gmv_direto, sum(gmv_indireto) AS gmv_indireto,
         sum(pedidos) AS pedidos, sum(unidades) AS unidades, sum(reembolso) AS reembolso,
         sum(visualizacoes) AS visualizacoes, sum(cliques) AS cliques
  FROM crm_tts_canal_dia GROUP BY 1,2
)
SELECT d.*,
       COALESCE(c.custo_ads, 0) AS custo_ads,
       c.fonte AS custo_fonte,
       round(d.gmv / NULLIF(d.pedidos,0), 2)                         AS ticket_medio,
       round(100.0 * d.pedidos / NULLIF(d.visualizacoes,0), 3)       AS conversao_pct,
       round(100.0 * d.cliques / NULLIF(d.visualizacoes,0), 2)       AS ctr_pct,
       round(d.gmv / NULLIF(c.custo_ads,0), 2)                       AS roas_blended,
       round(100.0 * d.gmv_organico / NULLIF(d.gmv,0), 1)            AS pct_organico,
       round(100.0 * d.gmv_afiliado / NULLIF(d.gmv,0), 1)            AS pct_afiliado,
       round(100.0 * d.reembolso / NULLIF(d.gmv,0), 1)               AS pct_reembolso
FROM d LEFT JOIN crm_tts_canal_custo c ON c.marca = d.marca AND c.dia = d.dia;

-- 14) Estado de cada família de escopo, por loja. Preenchido pela "Sonda de escopos" (6h em 6h).
--     Existe porque o 105005 do TikTok tem dois significados e só a MENSAGEM os separa:
--     'falta_no_app' = a permissão não está no app (ou está em análise) -> não adianta reautorizar;
--     'reautorizar'  = está no app e não chegou no token -> reautorizar as lojas resolve AGORA;
--     'ok'           = passou da checagem de escopo.
--     mudou_em é o carimbo da virada — é assim que se descobre que a TikTok aprovou, sem ficar
--     abrindo o Partner Center todo dia.
CREATE TABLE IF NOT EXISTS crm_tts_escopo (
  marca         text NOT NULL,
  loja          text NOT NULL,
  familia       text NOT NULL,          -- analytics | order | product | finance | fulfillment | return | promotion
  rotulo        text,                   -- nome como aparece no Partner Center
  estado        text NOT NULL,          -- falta_no_app | reautorizar | ok
  mensagem      text,                   -- resposta crua da API, para auditoria
  verificado_em timestamptz NOT NULL DEFAULT now(),
  mudou_em      timestamptz,
  PRIMARY KEY (loja, familia)
);

-- ============================================================
-- v3 (16/09/2026) — COBRANÇA DE CONTEÚDO.
-- O gargalo de produção medido em 16/09 não é seleção de criador, é gente que aceitou e parou no meio:
--   Fish   375 convites -> 143 puseram na vitrine ->  83 postaram  (63 com vitrine e nenhum vídeo)
--   Aristo 301 convites ->  39 puseram na vitrine ->  21 postaram  (19 com vitrine e nenhum vídeo)
-- São 82 criadores que já aceitaram, já colocaram o produto na loja deles e nunca gravaram.
-- O canal para falar com eles já existe e o escopo já está concedido (seller.affiliate_messages.write):
--   POST /affiliate_seller/202412/conversations                    {creator_id}      -> abre o canal
--   POST /affiliate_seller/202412/conversations/{id}/messages      {msg_type,content} -> envia
-- (mapeado na unha em 16/09; a API valida que criador e vendedor têm relação antes de abrir a conversa)

-- 15) Modelo de mensagem por marca e etapa. Fica no BANCO, não no código, para a Marcela e o Felipe
--     ajustarem a copy sem mexer em workflow. {nome} e {produto} são trocados na hora do envio.
CREATE TABLE IF NOT EXISTS crm_tts_cobranca_modelo (
  marca         text NOT NULL,
  etapa         text NOT NULL,          -- vitrine_sem_video | amostra_sem_video
  texto         text NOT NULL,
  dias_min      integer NOT NULL DEFAULT 7,  -- só cobra depois de tantos dias parado
  ativo         boolean NOT NULL DEFAULT true,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_por text,
  PRIMARY KEY (marca, etapa)
);

-- 16) Log de cobrança. A CHAVE é (marca, etapa, username): o ON CONFLICT DO NOTHING é o que garante
--     que ninguém leva a mesma cobrança duas vezes, por mais que o workflow rode todo dia.
CREATE TABLE IF NOT EXISTS crm_tts_cobranca (
  marca           text NOT NULL,
  etapa           text NOT NULL,
  username        text NOT NULL,
  creator_open_id text,
  referencia      text,                 -- colab_id ou application_id que motivou a cobrança
  conversation_id text,
  texto           text,                 -- exatamente o que foi (ou seria) enviado
  dry_run         boolean NOT NULL DEFAULT true,
  ok              boolean,
  erro            text,
  enviado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, etapa, username)
);
CREATE INDEX IF NOT EXISTS crm_tts_cobranca_dia_idx ON crm_tts_cobranca (marca, enviado_em);

-- 17) Controles da cobrança na regra da marca. modo separado do da esteira de amostras de propósito:
--     mandar mensagem e decidir amostra são riscos diferentes e não devem ser ligados pela mesma chave.
ALTER TABLE crm_tts_regra ADD COLUMN IF NOT EXISTS cobranca_modo text NOT NULL DEFAULT 'dry_run';
ALTER TABLE crm_tts_regra ADD COLUMN IF NOT EXISTS cobranca_max_dia integer NOT NULL DEFAULT 15;
