# Canal inteiro (ads + afiliados + lives + orgânico) — modelagem

A Marcela vai responder por 100% do TikTok, então o painel precisa fechar o canal, não só afiliados.
A modelagem abaixo **copia a taxonomia oficial da plataforma**, porque é a única que reconcilia com o
Seller Center — se inventarmos dimensão nossa, o número do painel nunca vai bater com o do TikTok e
a discussão vira sobre a planilha em vez de sobre o resultado.

## A referência

A própria TikTok Shop ("Sales Metrics Breakdown Logic", Seller University) quebra venda em três eixos:

- **tipo de conteúdo**: LIVE · vídeo curto · product card (vitrine/busca)
- **origem do pedido**: afiliado · próprio (seller)
- **atribuição**: GMV **direto** (comprou interagindo com o conteúdo) × **indireto** (viu e comprou depois),
  modelo *last-touch*, janela de 1 dia

E, por fora, separa **Ads Gross Revenue** de **Non-Ads Gross Revenue**. Ads Manager reporta por data de
*interação*; Seller Center por data de *transação* — por isso os dois nunca batem exatamente, e o que
vale como fonte de GMV para nós é o Seller Center (é o que a Shop API devolve).

Os dashboards de escala (Dataslayer, Saras, Eva, Dashboardly) usam exatamente esses eixos e recomendam
três cortes de leitura, não um dashboard único: **diário** (pulso: GMV, top SKU, conversão),
**semanal** (ROAS e performance de criador), **mensal** (coorte e categoria).

## O que mudei em relação ao que eu ia fazer

Eu ia criar três tabelas paralelas (`canal`, `video`, `live`). **Isso estava errado** e a referência
deixou claro: um mesmo pedido é live *e* afiliado ao mesmo tempo — três tabelas por superfície
duplicariam GMV e tornariam "conversão total do canal" impossível de fechar.

O certo é **uma tabela-fato com dimensões**:

```
crm_tts_canal_dia  →  grão (dia, marca, superficie, origem)
```

Somar tudo de um dia = GMV do canal, sem dupla contagem. Vídeo e live ganham tabela própria só no
grão de **entidade** (cada vídeo, cada transmissão), que é outra pergunta ("que criativo replicar"),
não outra fatia do mesmo bolo.

## As tabelas

| tabela | grão | responde |
|---|---|---|
| `crm_tts_canal_dia` | dia × marca × superfície × origem | quanto o canal fez e de onde veio |
| `crm_tts_video_dia` | dia × vídeo | que peça vendeu, de qual criador |
| `crm_tts_live_dia` | transmissão | que live vendeu (chave é a live, não o dia: live cruza meia-noite) |
| `crm_tts_canal_custo` | dia × marca | investimento em mídia — **entrada manual** |
| `crm_tts_canal_v` | dia × marca | a visão pronta: ticket, conversão, CTR, ROAS, % orgânico, % reembolso |

## O buraco conhecido: custo de mídia

A Shop API devolve **receita, nunca investimento**. Spend só existe na *TikTok Ads Business API*, que é
**outro app**, com outra autorização. Enquanto esse app não existir, `crm_tts_canal_custo` é digitada
(uma linha por dia por marca) — sem ela não há ROAS nem take rate real, só GMV.

Decisão do Felipe pendente: digitar diariamente (a Marcela, 30 s/dia) ou abrir o app de Ads agora.

O ROAS na view é **blended de propósito**: o custo é do canal, não da superfície. Ratear custo por
superfície seria inventar atribuição que a plataforma não entrega.

## Status

**Rodando desde 17/09/2026.** Escopo `data.shop_analytics.public.read` entrou nas duas lojas depois da
submissão do app (o gate real era a ficha "Teste de produtos" no Partner Center, não a reautorização).

### O que a API entrega de verdade (medido em 17/09)

- `GET /analytics/202509/shop/performance` com `granularity=1D`: 1 intervalo por dia (`start_date`,
  `end_date` exclusivo). Traz **GMV por tipo de conteúdo** (LIVE / VIDEO / PRODUCT_CARD), receita bruta
  com % GMV_MAX × NON_GMV_MAX, pedidos, sku_orders, itens, compradores, reembolso, visitantes, page views
  e conversão. **Não separa afiliado × próprio** — essa fatia sai de `crm_tts_pedido`, na view.
  Janela máxima ~30 dias por chamada; `latest_available_date` fica ~1 dia atrás, mas o dia anterior já
  vem com dado quase fechado.
- `GET /analytics/202509/shop_lives/performance`: **por sessão**, e inclui lives de afiliados vendendo a
  loja (username ≠ conta da loja). Venda (gmv, sku_orders, customers, avg_price, click_to_order_rate,
  24h_live_gmv = -1 enquanto não fecha) e interação (viewers, views, product_clicks, impressions, CTR,
  likes, comments, new_followers, avg_viewing_duration) — interação só vem para lives da própria loja.
  Ordenada por GMV desc; a cauda é dezenas de lives de afiliado com zero venda.
- `GET /analytics/202509/shop_videos/performance`: **acumulado da janela**, não por dia. ~940 vídeos em
  30 dias na Fishermans, ~400 no Aristocrata; guardamos o retrato diário do top 200 por GMV
  (`dia` = latest_available_date, `janela_dias` = 30). Traz gmv, gpm, sku_orders, views, CTR, duração,
  produtos e hashtags.

### Como ficou gravado (DDL v4)

- `crm_tts_canal_dia`: linhas do analytics têm `origem = 'todos'`. A linha `superficie = 'total'` carrega
  as métricas do dia inteiro; `live` / `video` / `vitrine` carregam **só o GMV da fatia**. A view
  `crm_tts_canal_v` lê cada coisa do lugar certo — somar `gmv` de todas as linhas dobraria o total.
  `gmv_ads` = receita bruta × % GMV Max.
- `crm_tts_live_dia` (PK marca, live_id) e `crm_tts_video_dia` (PK marca, dia, video_id): `origem`
  é `proprio` quando o username é a conta da loja (`oaristocrata.com`, `fishermans.com.br`), senão
  `afiliado`. `gmv_24h` só é sobrescrito quando a API já devolve valor (COALESCE no upsert).
- Coletor: workflow **"TikTok Shop - Coletor de canal"** (`ssS3VeOOGV80LkrX`), cron 04:10 BRT, janela
  rolante de 7 dias (o upsert corrige o dia anterior). Backfill: `POST /webhook/tts-canal-5e1b9c3a7f24`
  `{k, dias}` (fatias de 30 dias). Log em `crm_tts_coleta_log` com fonte `canal_dia` / `canal_live` /
  `canal_video`. Backfill de 90 dias feito em 17/09.
- Painel: aba **Canal** em influs.html (`TTS.canal` em influs-tts.js; payload `canal`, `canal_total`,
  `lives`, `videos` da API do painel).

### Primeira leitura (31 dias até 17/09)

Fishermans: R$ 14,5 mil de GMV, 52% via afiliado, 56% vídeo · 29% vitrine · 15% live, 20% GMV Max.
A live da loja em 16/09 (12:06–13:47, 1.305 espectadores, CTR 4,1%, clique→pedido 2,4%) fez R$ 762 —
o dia fechou em R$ 1.359, o melhor da janela, 78% via live. Aristocrata: R$ 5,5 mil, 23% via afiliado,
74% vitrine, sem GMV Max, conversão 0,15% sobre 37,7 mil visitantes (Fishermans: 1,55% sobre 8,3 mil).

### Live com "máxima realidade" (18/09)

Três diferenças entre "o que a equipe viu" e "o que o painel mostrava", todas medidas na live da
Fishermans de 16/09 e corrigidas:

1. **Sessão ≠ live.** A API devolve sessão; queda de sinal vira sessão nova. A live de 16/09 foram 3
   sessões (61 + 101 + 16 min, ~1 min entre elas). "Deu R$ 762" (maior sessão) e "deu R$ 1.064" (as
   três) eram a mesma live. O painel agrupa sessões da mesma conta com intervalo ≤ 30 min num evento
   (`TTS.agruparLives`) e mostra as sessões ao clicar.
2. **GMV é pago; o número se mexe.** `gmv` da sessão é GMV pago; `created_sku_orders` inclui pedido
   criado e não pago (COD/PayLater). Às 04:10 a API dizia R$ 840,72 (10 pagos); às 09:00, R$ 761,76
   (9 pagos + 1 pendente). Guardamos `pedidos_criados`; o painel mostra "+1" pendente e etiqueta
   "em fechamento" por 72 h após o fim.
3. **Produto por live.** `/analytics/202512/shop/{live_id}/products_performance` diz o que vendeu e o
   que só foi clicado em cada live (X8 Oceânica R$ 307 · X4 Amazônica R$ 303 · N40 R$ 152 = R$ 761,76,
   bate com a sessão). Tabela `crm_tts_live_produto`, coletada para toda live com venda. A API só
   devolve produto para live da própria loja — live de afiliado volta vazia.

Reconciliação que fecha: soma das sessões da loja em 16/09 = R$ 1.064,20 = fatia LIVE do dia em
`shop/performance`. Afiliado do dia (crm_tts_pedido) = R$ 299,52, nenhum via live. Então o dia de
R$ 1.358,72 foi 78% live própria, 22% vídeo de afiliado.

Ainda não coletado: `/analytics/202510/shop_lives/{live_id}/performance_per_minutes` (minuto a minuto:
espectadores, cliques, pedidos) — útil para ver em que momento da live a venda acontece; entra quando
houver pergunta que só ele responde.

### Pendências

- **Custo de ads continua fora** (`crm_tts_canal_custo` manual, vazio). ROAS blended só quando o app tiver
  a API de Ads ou alguém lançar o custo.
- `gmv_24h` das lives de 16/09 ainda -1 na API; o cron das 04:10 completa.
- `crm_tts_token.granted_scopes` da Fishermans ficou com 5 escopos na captura de 14:44 enquanto a API já
  devolvia 9 — por isso `escopos_faltando` na API do painel passou a ser **medido** (sonda `ok` ou coleta
  de canal OK depois da última autorização), não deduzido do array gravado.

## Fontes

- TikTok Seller University — Sales Metrics Breakdown Logic Upgrade
- Emplicit — Ultimate Guide to TikTok Shop Traffic Attribution
- Dataslayer — TikTok Shop Analytics 2026: KPIs, Attribution & Reporting
