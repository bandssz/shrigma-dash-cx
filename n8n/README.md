# Workflows do painel de CX (importar no n8n)

Três coletores prontos para importar (`Workflows → Import from file`). Nenhum contém segredo:
as chaves ficam em credenciais do n8n.

| Arquivo | O que faz | Estado em 12/09 |
|---|---|---|
| `cx-ra-coletor.json` | 06:00 — lê as metatags `meta-reclameaqui:*` das páginas das marcas e grava `cx_ra_dia` | **já criado no n8n** (id `ppiBwg7zMjssMIlV`, inativo) — falta executar uma vez e ativar |
| `cx-pedidos-coletor.json` | 01:20 — `ordersCount` por dia (criados e pagos) via GraphQL Admin nas duas lojas, grava `cx_pedido_dia` | importar; para o backfill desde 13/07 rodar uma vez com `dias = 62` |
| `cx-ticket-coletor.json` | 30 min (06–23h) + 01:30 — lista `/tickets` do Gleap (45 dias à noite) e as notas por `conversationRating`, upsert em `cx_ticket` | importar; precisa de duas credenciais Header Auth |

## Antes de ativar

1. **Credenciais Header Auth** (Credentials → New → Header Auth): `Gleap · Aristocrata (Bearer)` e
   `Gleap · Fishermans (Bearer)`, nome do header `Authorization`, valor `Bearer <secret api key da API v3>`.
   O header `Project` já está no nó. Depois de importar `cx-ticket-coletor.json`, abrir os dois nós HTTP
   e selecionar a credencial correspondente.
2. **Shopify**: os nós usam as credenciais existentes `Shopify Admin — Aristocrata` (`CkOtCPF6b7FIyTjx`) e
   `— Fishermans` (`Xv9XgNyJ1wyJFCTJ`) como *Shopify Access Token*. Se o tipo não bater, trocar o nó para
   Header Auth com `X-Shopify-Access-Token`.
3. **Executar manualmente uma vez** cada um e conferir no banco (`select * from cx_ra_dia`, `cx_pedido_dia`,
   `select max(atualizado_em) from cx_ticket`). Só depois ativar — configuração lida por API não é
   comportamento verificado.
4. ~~API de leitura~~ — feito em 13/09: SQL dos três blocos e whitelist do painel `cx` publicados e verificados.

## Regras que os coletores respeitam

- Falha de chamada não grava zero: ausência de linha é ausência, e o painel diz "sem dado".
- `rating` só assume 2/6/10; `escalado` = transferência real; `motivo` por precedência; e-mail sem tag.
- Gleap: operador no **nome** do parâmetro (`createdAt%3E=`), `:` da data sem encode, `limit=500`, `skip`
  para paginar, 200 req/min nos endpoints de ticket.
- RA: se a página vier bloqueada (sem metatags), o workflow falha em vez de gravar — fallback é o bookmarklet
  semanal com `fonte='bookmarklet'`.
