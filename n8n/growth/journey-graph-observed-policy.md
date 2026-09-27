# Condição de pedido observado — candidata, OFF

Regra operacional: **pedido encontrado após o abandono para o cliente vinculado ao carrinho, na última conferência**. Não é ausência universal de compra. `purchase.observed_for_cart` é um fato separado; `purchase.confirmed` e releases antigos mantêm seu contrato. A política não é selecionável pelo body do editor.

## Contrato

O worker confiável configura `observationPolicy: 'cart_customer_order_observation_v1'` em `createShopifySource`. A fonte aceita a identidade/intervalo da observação e exige enumeração completa, checkout e primeira página reconferidos para `false`. Compra positiva nativa prevalece. Nenhum fato é produzido para resposta incompleta, identidade alterada ou falha. Os dados da consulta não entram no catálogo/recibo.

A preparação confiável recebe `purchase_policy` com a mesma versão. Isso produz material `journey_graph_release_v2`; a política inteira `{version, field: 'purchase.observed_for_cart', max_age_seconds: 5}` entra no hash e no recibo imutáveis. Omitir a opção preserva `journey_graph_release_v1`. Reutilizar a mesma operação com outra política é recusado. O SQL exige correspondência entre opção e material; leitores também reconstruem e validam o material.

`withObservedPurchase` amplia somente a composição do catálogo do worker, antes de `bindCatalog`. O descritor `cart_email_material_v2` torna obrigatórios consentimento e observação negativa com até cinco segundos, mesmo se o operador retirar a condição explícita do desenho. Positivo conflitante sempre bloqueia. Materialização repete as guardas; participantes existentes continuam presos ao catálogo/release publicado originalmente.

## Implantação e limites

Código candidato: não instala SQL em produção, não modifica coletores/emissores, não concede capacidade de ativação, não cria participantes e não envia. O catálogo público continua somente para rascunhos. O pacote Growth compartilha o validador novo sem ativar a funcionalidade.

O futuro transporte deverá conferir novamente compra/opt-out e executar a reserva idempotente vigente imediatamente antes de enviar; o prazo da simulação não autoriza envio posterior. Ainda faltam integração de fonte/worker, material imutável no transporte, recibo/reconciliação e publicação ponta a ponta. Não usar intenção de simulação como permissão de disparo.

`journey-graph-release.sql` permanece instalação transacional em namespace candidato, com recusa de colisão. Como source/release ainda não foram instalados em produção, isto não é migração de releases existentes. Se houver uma instalação divergente, parar e preparar migração específica; não apagar/adotar tabelas. Implantação futura exige export e guarda de versão dos workflows, ensaio isolado e confirmação da versão ativa.

Rollback desta entrega: reverter o commit/bundle Growth. Não há estado novo de produção a desfazer. Em ambiente de teste com v2, não reabrir worker antigo sobre esses releases; manter OFF e preservar histórico.

## Verificação

- Testes locais: 172 casos de graph, source, catálogo, release, runtime e editor; ambas as marcas, opt-out, identidade, frescor, condições omitidas, positivo conflitante, replay com outra política e entrada antiga com catálogo atual alterado.
- PostgreSQL real na CI: preparação concorrente da mesma política, separação dos hashes legado/observado, rejeição de downgrade por replay, bloqueio de fonte alterada e rollback de recibo.
- Produção: somente a leitura Shopify documentada em `journey-graph-purchase.md`; nenhuma ativação ou transporte. A leitura não substitui teste ponta a ponta do futuro worker.
