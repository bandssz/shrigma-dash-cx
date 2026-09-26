# Influs · conferência com a Shopify (26/09/2026)

## O que estava “não batendo”

O relatório da Shopify **Vendas por código de desconto** e o painel medem coisas diferentes:

| | Shopify (relatório) | Painel (Influs) |
|---|---|---|
| Pedido entra quando | é **criado**, inclusive PIX/boleto não pago ou expirado | está **pago** (PAID ou PARTIALLY_REFUNDED) |
| Valor | vendas líquidas (brutas − descontos − devoluções), devolução datada no dia em que acontece | subtotal atual após desconto, sem frete, já com estorno (`currentSubtotalPriceSet`) |
| Uso | leitura comercial | receita rastreada, ROI e **base de comissão** |

CAPIVARA / O Aristocrata, conferido pedido a pedido:

| Período | Shopify | Painel (pagos) | Não pagos | Sem explicação |
|---|---:|---:|---:|---:|
| 01–25/09 | 655 · R$ 105.382,03 | 630 · R$ 103.231,84 | 24 EXPIRED + 1 PENDING · R$ 2.150,19 | R$ 0,00 |
| agosto (filtro padrão “Mês passado”) | 1.256 · R$ 167.650,13 | 1.160 · R$ 155.135,41 | 96 · R$ 12.492,38 | R$ 22,34 (estorno registrado depois do período) |

Nos cupons de creator das duas lojas, todos os pedidos pagos coincidiram em ID e valor com a Shopify em 01–25/09 e em agosto. O subtotal (R$ 103.231,84) não é o total dos pedidos (R$ 106.470,04, com frete).

Fishermans: pedidos pagos batiam. O problema real era o **catálogo**. O token da loja não tinha `read_discounts`, e o sync diário gravava falha enquanto o workflow terminava em “success”. O escopo foi adicionado no app pelo dono da loja em 26/09, e a primeira rodada completa trouxe 20 cupons novos como *pendente*. Tipo e dono existentes ficaram preservados, conferido campo a campo.

## Peças

- `conciliacao.sql`: saúde com `ultimo_ok_em` (trigger), relatório Shopify por dia × cupom com cobertura, `crm_influ_conciliacao_v1(ini,fim)` e `crm_influ_conciliacao_pedidos_v1(ini,fim,marca)`. Idempotente.
- `relatorio-shopify-workflow.cjs`: workflow novo *CRM — Influs · Relatório Shopify por cupom*. Roda diário às 04:35, cobre 45 dias até ontem e aceita backfill por POST. Erro vira saúde `ok=false`, nunca zero.
- `coletor-pedidos-patch.cjs`: revisão do coletor `DVGW6ZSjTB3CO49k`.
  - guarda pedido não pago com `pago=false`;
  - usa janela em UTC explícito;
  - erro GraphQL vira saúde por loja;
  - aplica o % do termo vigente na data do pedido, porque antes a recoleta de 45 dias aplicava o % atual a meses anteriores.
- `api-conciliacao-patch.cjs`: a API `listar` passa a trazer `conciliacao`, `saude` e `coleta`, e `conciliacao_pedidos` quando pedido.
- `influs-conferencia.js`: tela “Conferência Shopify” com resumo por loja, tabela por cupom, saúde das fontes e exportação CSV por cupom e por pedido (só id numérico e link do admin, sem dado pessoal).

## Situações da conferência

`igual` · `explicada_nao_pagos` · `diferenca_de_valor` · `ausente_no_painel` · `ausente_no_relatorio` · `fora_da_lente` (cupom de CRM, campanha ou não-influ) · `relatorio_parcial` (período inclui hoje ou dia sem coleta) · `relatorio_indisponivel`.

A diferença só é calculada quando o relatório cobre todos os dias do período. Meta, TikTok e links de parceiros são outras fontes e não entram nessa soma.

## Operação

- Ordem diária: 03:50 catálogo → 04:10 pedidos → 04:35 relatório. “Hoje” é sempre parcial.
- Aplicar mudança em workflow: GET fresco, conferir `versionId == activeVersionId == revisado`, backup, PUT, `POST /activate`, GET e comparar nó a nó.
- Resposta incerta de backfill: não reenviar. Conferir a execução e a saúde antes de qualquer nova tentativa.
