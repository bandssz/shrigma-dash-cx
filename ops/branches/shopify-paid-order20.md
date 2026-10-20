# Pedido pago — em branch, sem instalar
Admissão de `orders/paid`: HMAC sobre bytes originais antes do JSON, loja vinculada à marca, identidade de pedido/cliente consistente, valor decimal sem arredondamento, evento mínimo sem e-mail. A chave lógica é marca + ID real do pedido; o consumidor ainda precisa fazer upsert transacional. O horário observado não afirma o instante do pagamento. Pedidos de teste e convidados permanecem identificados.

O HMAC não assina o cabeçalho da loja. Esta preparação recusa segredo compartilhado entre marcas; a configuração real e um vínculo de loja comprovado ainda precisam ser definidos antes de conectar a rota. Nenhum segredo real foi lido ou alterado.

Destino existente: `public.crm_attribution_order_v2`, PK `(brand,order_id)`, em `n8n/growth/attribution-schema.sql`. A função existente `crm_attribution_ingest_v2` exige lote completo e também avança cobertura diária; um webhook unitário não pode chamá-la fingindo completude. Os agregados em `crm_audience_v2.shopify_customer_fact` não deduplicam por pedido.

Bloqueio: gravação do fato unitário ainda sem contrato e transporte de escrita comprovados no gateway.
Preservação: nenhuma rota ligada, tabela/função/worker/journal criado, segredo lido ou webhook registrado; não atualizar cobertura nem atribuição com informação ausente.
Quem destrava: Produto define o upsert no armazenamento existente e a projeção de compra; Infra confirma transporte/ACL existentes antes de qualquer instalação futura.

Referência primária: [Shopify — verificação de webhook e duplicatas](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries). O código desta branch não foi adicionado ao manifesto de produção e não representa entrega operacional.
