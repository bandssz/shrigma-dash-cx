-- Current collector query as a synthetic regression boundary. Parameters use fixture data only.
-- Upsert de carrinhos abandonados: cria/atualiza subscriber, grava o carrinho e garante Base Geral
-- NAO grava o flag cart_abandoned: ele e DERIVADO pela reconciliacao (fonte unica de verdade)
-- $1=batch jsonb - $2=brand - $3=list_base
WITH data AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
    email text, name text, first_name text, cart_abandoned_at text,
    cart_value numeric, cart_url text, cart_items jsonb, cart_id text, cart_phone text, mkt_consent text
  )
),
novo AS (
  SELECT d.*, jsonb_build_object(
    'cart_abandoned_at', d.cart_abandoned_at,
    'cart_value',        d.cart_value,
    'cart_url',          d.cart_url,
    'cart_items',        d.cart_items,
    'cart_id',           d.cart_id,
    'cart_phone',        d.cart_phone,
    'mkt_consent',       d.mkt_consent
  ) AS estado FROM data d
),
up AS (
  INSERT INTO subscribers (uuid, email, name, status, attribs, created_at, updated_at)
  SELECT gen_random_uuid(), n.email,
         COALESCE(NULLIF(btrim(n.name), ''), split_part(n.email, '@', 1)),
         'enabled',
         jsonb_build_object('origem', 'shopify-carrinho-abandonado')
           || CASE WHEN NULLIF(btrim(n.first_name), '') IS NULL THEN '{}'::jsonb
                   ELSE jsonb_build_object('first_name', btrim(n.first_name)) END
           || jsonb_build_object($2, n.estado),
         now(), now()
  FROM novo n
  ON CONFLICT (email) DO UPDATE SET
    attribs = COALESCE(subscribers.attribs, '{}'::jsonb)
              -- first_name: so preenche se estiver vazio (nao sobrescreve o que o sync noturno trouxe)
              || CASE WHEN COALESCE(NULLIF(btrim(subscribers.attribs->>'first_name'), ''), '') <> '' THEN '{}'::jsonb
                      WHEN EXCLUDED.attribs->>'first_name' IS NULL THEN '{}'::jsonb
                      ELSE jsonb_build_object('first_name', EXCLUDED.attribs->>'first_name') END
              -- carrinho: so sobrescreve se o novo for MAIS RECENTE que o gravado
              || jsonb_build_object($2,
                   COALESCE(subscribers.attribs->$2, '{}'::jsonb)
                   || CASE WHEN COALESCE(subscribers.attribs->$2->>'cart_abandoned_at', '')
                                >= COALESCE(EXCLUDED.attribs->$2->>'cart_abandoned_at', '')
                           THEN '{}'::jsonb
                           -- carrinho NOVO: zera as flags de toque da regua (elas sao por carrinho,
                           -- nao por pessoa) preservando as demais flags do namespace (ex.: x4_*)
                           ELSE (EXCLUDED.attribs->$2)
                                || jsonb_build_object('flows',
                                     COALESCE(subscribers.attribs->$2->'flows', '{}'::jsonb)
                                     - 'cart_t1_at' - 'cart_t24_at' - 'cart_t48_at'
                                     - 'cart_t05_at' - 'cart_t2_at'
                                     - 'wa_cart_t1_at' - 'wa_cart_t24_at') END
                 ),
    name = COALESCE(NULLIF(btrim(subscribers.name), ''), EXCLUDED.name),
    updated_at = now()
  WHERE subscribers.status <> 'blocklisted'   -- respeita opt-out: nem attribs sao tocados
  RETURNING id, status
),
base AS (
  INSERT INTO subscriber_lists (subscriber_id, list_id, meta, status, created_at, updated_at)
  SELECT id, $3::int, '{}', 'confirmed', now(), now() FROM up
  ON CONFLICT (subscriber_id, list_id) DO NOTHING
  RETURNING subscriber_id
)
SELECT (SELECT COUNT(*) FROM up)   AS carrinhos_gravados,
       (SELECT COUNT(*) FROM base) AS novos_na_base_geral;
