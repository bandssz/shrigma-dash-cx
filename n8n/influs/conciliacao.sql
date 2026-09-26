-- Influs · conferência com a Shopify e saúde das fontes (26/09/2026).
-- Idempotente: pode ser aplicado de novo sem duplicar nada. Não apaga nem reescreve dado existente.
--
-- Por que existe: o relatório da Shopify ("Vendas por código de desconto") conta o pedido quando
-- ele é criado, inclusive PIX/boleto que expirou; o painel conta só pedido pago (base de comissão).
-- Em 1–25/09 o CAPIVARA dava 655 pedidos / R$ 105.382,03 na Shopify e 630 / R$ 103.231,84 no painel:
-- 24 EXPIRED + 1 PENDING explicam a diferença no centavo. Sem os dois lados na tela, a divergência
-- parece erro de coleta. Aqui ficam: o relatório Shopify por dia e cupom, a saúde de cada etapa por
-- marca com último sucesso, e as duas funções de leitura que o painel usa.
BEGIN;

-- 1) Saúde: último sucesso separado da última tentativa. Uma falha não apaga quando foi o último ok.
ALTER TABLE public.crm_influ_saude ADD COLUMN IF NOT EXISTS ultimo_ok_em timestamptz;
ALTER TABLE public.crm_influ_saude ADD COLUMN IF NOT EXISTS itens integer;
UPDATE public.crm_influ_saude SET ultimo_ok_em = em WHERE ok AND ultimo_ok_em IS NULL;

CREATE OR REPLACE FUNCTION public.crm_influ_saude_ultimo_ok()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ok THEN
    NEW.ultimo_ok_em := COALESCE(NEW.em, now());
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.ultimo_ok_em := OLD.ultimo_ok_em;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS crm_influ_saude_ultimo_ok ON public.crm_influ_saude;
CREATE TRIGGER crm_influ_saude_ultimo_ok BEFORE INSERT OR UPDATE ON public.crm_influ_saude
  FOR EACH ROW EXECUTE FUNCTION public.crm_influ_saude_ultimo_ok();

-- 2) Relatório da Shopify (ShopifyQL, dataset sales) por dia de Brasília e código.
-- Devolução é datada no dia em que acontece; por isso a soma de um período pode diferir do
-- subtotal atual dos pedidos criados nele. Pedido sem cupom não é gravado.
CREATE TABLE IF NOT EXISTS public.crm_influ_shopify_relatorio (
  marca text NOT NULL CHECK (marca IN ('aristo','fish','olivas')),
  dia date NOT NULL,
  codigo text NOT NULL CHECK (codigo = upper(codigo) AND codigo <> ''),
  pedidos integer,
  vendas_brutas numeric(14,2),
  descontos numeric(14,2),
  devolucoes numeric(14,2),
  vendas_liquidas numeric(14,2),
  coletado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, dia, codigo)
);
-- Quais dias a coleta do relatório cobriu, por marca. Dia coberto sem linha = zero medido;
-- dia não coberto = desconhecido.
CREATE TABLE IF NOT EXISTS public.crm_influ_shopify_relatorio_cobertura (
  marca text NOT NULL CHECK (marca IN ('aristo','fish','olivas')),
  dia date NOT NULL,
  coletado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (marca, dia)
);

-- 3) Conferência por cupom e período. Cada lado fica com o seu número: nada é somado entre fontes.
--   relatorio_*  = o que a Shopify mostra (pedidos criados, vendas líquidas, inclui não pagos)
--   pagos/receita_paga = o que o painel conta (pedido pago, subtotal atual, base de comissão)
--   nao_pagos/receita_nao_paga = pedidos com cupom que a Shopify conta e o painel não
--   diferenca = relatorio - (pago + não pago); só é calculada quando o relatório cobre todo o período
CREATE OR REPLACE FUNCTION public.crm_influ_conciliacao_v1(p_ini date, p_fim date)
RETURNS TABLE (
  marca text, codigo text, tipo text, influ text,
  relatorio_pedidos integer, relatorio_vendas_liquidas numeric, relatorio_coletado_em timestamptz,
  relatorio_cobertura text,
  pagos integer, receita_paga numeric, nao_pagos integer, receita_nao_paga numeric,
  status_nao_pagos jsonb, painel_atualizado_em timestamptz,
  diferenca numeric, situacao text)
LANGUAGE sql STABLE SET search_path TO 'pg_catalog','public' AS $$
  WITH dias AS (
    SELECT (p_fim - p_ini + 1) AS n
  ),
  cob AS (
    SELECT c.marca, count(*)::int AS dias, max(c.coletado_em) AS em
    FROM public.crm_influ_shopify_relatorio_cobertura c
    WHERE c.dia BETWEEN p_ini AND p_fim GROUP BY 1
  ),
  rel AS (
    SELECT r.marca, r.codigo, sum(r.pedidos)::int AS pedidos, sum(r.vendas_liquidas) AS liquidas
    FROM public.crm_influ_shopify_relatorio r
    WHERE r.dia BETWEEN p_ini AND p_fim GROUP BY 1,2
  ),
  led AS (
    SELECT p.marca, p.cupom_usado AS codigo,
           count(*) FILTER (WHERE p.pago)::int AS pagos,
           COALESCE(sum(p.receita_base) FILTER (WHERE p.pago), 0) AS receita_paga,
           count(*) FILTER (WHERE NOT p.pago)::int AS nao_pagos,
           COALESCE(sum(p.receita_base) FILTER (WHERE NOT p.pago), 0) AS receita_nao_paga,
           max(p.atualizado_em) AS atualizado_em
    FROM public.crm_influ_pedido p
    WHERE p.dia BETWEEN p_ini AND p_fim GROUP BY 1,2
  ),
  st AS (
    SELECT x.marca, x.codigo, jsonb_object_agg(x.status, x.n) AS status
    FROM (SELECT p.marca, p.cupom_usado AS codigo, p.status_financeiro AS status, count(*)::int AS n
          FROM public.crm_influ_pedido p
          WHERE NOT p.pago AND p.dia BETWEEN p_ini AND p_fim GROUP BY 1,2,3) x
    GROUP BY 1,2
  ),
  chaves AS (SELECT l.marca, l.codigo FROM led l UNION SELECT r.marca, r.codigo FROM rel r)
  SELECT k.marca, k.codigo, c.tipo, c.influ,
         r.pedidos, r.liquidas, cob.em,
         CASE WHEN cob.dias IS NULL THEN 'sem_coleta'
              WHEN cob.dias < (SELECT n FROM dias) THEN 'parcial'
              ELSE 'completa' END,
         COALESCE(l.pagos, 0), COALESCE(l.receita_paga, 0),
         COALESCE(l.nao_pagos, 0), COALESCE(l.receita_nao_paga, 0),
         COALESCE(st.status, '{}'::jsonb), l.atualizado_em,
         CASE WHEN cob.dias = (SELECT n FROM dias)
              THEN COALESCE(r.liquidas, 0) - COALESCE(l.receita_paga, 0) - COALESCE(l.receita_nao_paga, 0) END,
         CASE
           WHEN cob.dias IS NULL THEN 'relatorio_indisponivel'
           WHEN cob.dias < (SELECT n FROM dias) THEN 'relatorio_parcial'
           -- cupom classificado fora de creator (CRM, campanha, não-influ): o coletor não grava pedido novo dele;
           -- linhas antigas de antes da reclassificação continuam no ledger, mas não são perda
           WHEN c.tipo IS NOT NULL AND c.tipo NOT IN ('influ','pendente') THEN 'fora_da_lente'
           WHEN l.codigo IS NULL THEN 'ausente_no_painel'
           WHEN r.codigo IS NULL THEN 'ausente_no_relatorio'
           WHEN abs(COALESCE(r.liquidas,0) - l.receita_paga - l.receita_nao_paga) > 0.01 THEN 'diferenca_de_valor'
           WHEN l.nao_pagos > 0 THEN 'explicada_nao_pagos'
           ELSE 'igual'
         END
  FROM chaves k
  LEFT JOIN rel r ON r.marca = k.marca AND r.codigo = k.codigo
  LEFT JOIN led l ON l.marca = k.marca AND l.codigo = k.codigo
  LEFT JOIN st ON st.marca = k.marca AND st.codigo = k.codigo
  LEFT JOIN cob ON cob.marca = k.marca
  LEFT JOIN public.crm_cupom c ON c.marca = k.marca AND c.codigo = k.codigo
$$;

-- 4) Linhas por pedido para exportar a conferência. Sem nome, e-mail, telefone ou endereço:
-- só o id numérico, que abre o pedido no admin da Shopify.
CREATE OR REPLACE FUNCTION public.crm_influ_conciliacao_pedidos_v1(p_ini date, p_fim date, p_marca text)
RETURNS TABLE (
  marca text, order_id text, dia date, cupom_usado text, todos_cupons text, tipo text, influ text,
  status_financeiro text, pago boolean, receita_base numeric, frete numeric, reembolsado numeric,
  comissao numeric, atualizado_em timestamptz)
LANGUAGE sql STABLE SET search_path TO 'pg_catalog','public' AS $$
  SELECT p.marca, p.order_id, p.dia, p.cupom_usado, p.todos_cupons, c.tipo,
         NULLIF(p.influ, ''), p.status_financeiro, p.pago, p.receita_base, p.frete, p.reembolsado,
         p.comissao, p.atualizado_em
  FROM public.crm_influ_pedido p
  LEFT JOIN public.crm_cupom c ON c.marca = p.marca AND c.codigo = p.cupom_usado
  WHERE p.dia BETWEEN p_ini AND p_fim
    AND (p_marca IS NULL OR p_marca = 'todas' OR p.marca = p_marca)
  ORDER BY p.marca, p.dia, p.order_id
$$;

COMMIT;
