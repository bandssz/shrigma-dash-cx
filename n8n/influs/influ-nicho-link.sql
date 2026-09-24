-- Nicho manual do influenciador + link de UTM gerado no cadastro + lente de receita por link.
-- Aplicado em produção em 24/09/2026, uma instrução por chamada (o utilitário SQL não aplica lote).
--
-- Por que existe: nos 90 dias até 24/09, 100% da atribuição de influ veio por cupom (5.862 pedidos)
-- e zero pedidos pagos do ledger tinham utm_content igual a um slug de influ. O link não estava
-- sendo distribuído. Este arquivo dá ao time o link pronto e faz a venda dele aparecer no painel.

-- 1. Nicho: texto livre do time, sem taxonomia inventada. Normalizado para agrupar sem fragmentar
--    ("Pesca  Esportiva" e "pesca esportiva" são o mesmo nicho).
ALTER TABLE crm_influ ADD COLUMN IF NOT EXISTS nicho text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_influ_nicho_normalizado') THEN
    ALTER TABLE crm_influ ADD CONSTRAINT crm_influ_nicho_normalizado
      CHECK (nicho IS NULL OR (nicho = lower(btrim(regexp_replace(nicho, '\s+', ' ', 'g')))
                               AND length(nicho) BETWEEN 2 AND 40));
  END IF;
END $$;

-- 2. Link do influ. Taxonomia espelha a do link de parceiro (persistência medida: 78–82% dos
--    pedidos com link marcado chegam com utm_content intacto). O portão é o utm_medium, que só
--    nós escrevemos: 'influs' não aparecia em nenhum pedido do ledger antes desta data.
CREATE OR REPLACE FUNCTION crm_influ_link_v1(p_marca text, p_slug text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE p_marca
           WHEN 'aristo' THEN 'https://oaristocrata.com/'
           WHEN 'fish'   THEN 'https://fishermans.com.br/'
           WHEN 'olivas' THEN 'https://olivasdocampo.com.br/'
         END
         || '?utm_source=influenciador&utm_medium=influs&utm_campaign=' || p_marca || '-influs'
         || '&utm_content=' || p_slug
  WHERE p_marca IN ('aristo','fish','olivas') AND p_slug ~ '^[a-z0-9][a-z0-9_-]{1,39}$'
$fn$;

-- 3. Lente de link. SEPARADA da de cupom: a mesma venda pode estar nas duas.
--    pedidos_sem_cupom é a única parte que soma com cupom sem contar a venda duas vezes.
--    Base: receita_liquida do ledger (recebido menos reembolsado, com frete). Não é base de comissão.
--    order_id: o ledger guarda o GID da Shopify e crm_influ_pedido o número puro.
CREATE OR REPLACE FUNCTION crm_influ_link_receita_v1(p_ini date, p_fim date)
RETURNS TABLE(marca text, influ text, pedidos integer, receita numeric,
              pedidos_sem_cupom integer, receita_sem_cupom numeric)
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog','public'
AS $fn$
  SELECT a.marca, i.influ,
         count(*)::int,
         round(sum(a.receita_liquida)::numeric, 2),
         count(*) FILTER (WHERE p.order_id IS NULL)::int,
         round(coalesce(sum(a.receita_liquida) FILTER (WHERE p.order_id IS NULL), 0)::numeric, 2)
  FROM public.crm_organico_attribution_order_v2 a
  JOIN public.crm_influ i
    ON i.marca = a.marca AND i.influ = lower(a.utm_content)
  LEFT JOIN public.crm_influ_pedido p
    ON p.marca = a.marca AND p.order_id = regexp_replace(a.order_id, '^gid://shopify/Order/', '')
  WHERE a.model = 'last_click'
    AND lower(a.utm_medium) = 'influs'
    AND a.dia BETWEEN p_ini AND p_fim
  GROUP BY 1, 2
$fn$;
