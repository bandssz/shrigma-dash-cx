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
  skus_permitidos    text[] NOT NULL DEFAULT '{}',      -- sku_id que podem virar amostra
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_por     text
);

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
  ('aristo', 'dry_run', 10000, 3000, 86, true, 15, '{}', 'seed 2026-09-14')
ON CONFLICT (marca) DO NOTHING;
