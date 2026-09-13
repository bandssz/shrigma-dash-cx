# Workflows do painel de CX (n8n)

Exportados do n8n em 13/09/2026 (`Workflows → Import from file` recria qualquer um). Nenhum arquivo contém
segredo: as chaves ficam em credenciais do n8n; os caminhos dos webhooks "Forçar (GET)" ficam só no n8n.

| Arquivo | n8n (id) | O que faz | Estado |
|---|---|---|---|
| `cx-ticket-coletor.json` | `gWr4rt2qpESG89Tz` | 30 min (06–23h): `/tickets` do Gleap criados hoje; 01:30: janela de 45 dias + notas (`conversationRating` 2/6/10). Upsert em `cx_ticket`. | **ativo**; 1ª execução 13/09 14:00 (9.839 Aris + 3.139 Fish atualizados) |
| `cx-pedidos-coletor.json` | `zpSak3vkYTd7DYMW` | 01:20: `ordersCount` por dia (criados e pagos) via GraphQL Admin nas duas lojas, em lotes de 7 dias (custo de query). Upsert em `cx_pedido_dia`. | **ativo**; backfill 14/07→13/09 feito (62 dias) |
| `cx-ra-bookmarklet-recepcao.json` | `Ki5WNbHHJQ4mmVb4` | `POST /webhook/cx-ra-metatags?k=<chave cx>`: recebe as metatags lidas pelo bookmarklet e grava `cx_ra_dia` (fonte `bookmarklet`). Chave validada no SQL contra `crm_dash_chave`. | **ativo**; testado com chave certa e errada |
| `cx-ra-coletor.json` | `ppiBwg7zMjssMIlV` | 06:00: fetch direto da página do RA. | **inativo** — RA devolve 403 para n8n e curl (anti-bot). Fica como registro; se um dia liberarem, é só ativar. |
| `ra-bookmarklet.js` | — | Favorito que o N2 clica na página da marca no RA. Lê `meta-reclameaqui:*` e envia ao receptor acima. | instalar no navegador de quem cuida do RA (trocar `CHAVE`) |

Credenciais criadas em 13/09: `Gleap · Aristocrata (Bearer)` (`14wgbRC7dvtvMCZF`) e `Gleap · Fishermans (Bearer)` (`tTiPiZLO71IAjjyp`),
tipo Header Auth (`Authorization: Bearer <secret api key v3>`); o header `Project` vai no nó. Shopify usa as Header Auth já
existentes (`X-Shopify-Access-Token`).

## Execução manual

Os coletores têm um nó "Forçar (GET)": `GET /webhook/<caminho>` responde na hora e o resultado aparece em *Executions*.
Parâmetros: `?modo=noturno` (ticket: 45 dias + notas) e `?dias=62` (pedidos: backfill). Sem parâmetro, faz o mesmo que o agendamento.

## Regras que os coletores respeitam

- Falha de chamada não grava zero: ausência de linha é ausência, e o painel diz "sem dado".
- `rating` só assume 2/6/10; `escalado` = transferência real; `motivo` por precedência; e-mail sem tag.
- Gleap: operador no **nome** do parâmetro (`createdAt%3E=`), `:` da data sem encode, `limit=500`, `skip`
  para paginar, 200 req/min nos endpoints de ticket.
- Shopify: `ordersCount` custa caro — no máximo 7 dias (14 contagens) por chamada, com 600 ms entre chamadas.
- RA: só um navegador de verdade passa pelo anti-bot. Sem clique no bookmarklet, a leitura envelhece e o painel
  mostra "coleta há N d" no cartão.

## Linha de base real (13/09, com pedidos da Shopify)

| Quinzena | Aris contatos/100 ped. | Aris WISMO/ped. | Fish contatos/100 ped. | Fish WISMO/ped. |
|---|---|---|---|---|
| jul 16–31 | 15,8 | 5,5% | 47,7 | 4,6% |
| **ago 1–15 (base)** | **20,0** | **7,8%** | **42,2** | **5,3%** |
| ago 16–31 (J&T) | 39,4 | 21,5% | 64,5 | 17,8% |
| set 1–12 | 37,7 | 10,1% | 49,8 | 4,8% |

A base do Aristocrata bate com o handoff (20 / 8%). A da Fishermans **não**: o handoff dizia 17 / 2%, o dado real é 42 / 5%
(a estimativa de pedidos estava alta). Setembro no Aristocrata: pedidos +5% vs ago 1–15, contatos ×2 — o volume não é venda.
