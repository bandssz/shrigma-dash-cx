# Atualização do carrinho após espera — candidato OFF

`createShopifySource` compõe a fonte SQL existente com duas consultas confiáveis de servidor: material atual do checkout e observação de compras. Não é endpoint do painel, não tem agendamento, não publica fluxo e não envia. O construtor público continua limitado a rascunhos.

## Regra e contrato

`createMaterialProvider({query,graphql,stores,clock})` recebe os domínios Shopify de Fish/Aristo da configuração revisada. `materialFor` resolve evento, UUID Listmonk, referência e hash do checkout pelo SQL existente. O ID exato é consultado na loja configurada; loja, checkout, criação, cliente e e-mail precisam corresponder. Correção de typo não comprova identidade: qualquer divergência bloqueia.

O material fica apenas em memória. O início da leitura confiável fornece a data conservadora dos fatos; `source_observation_v1` não é renovada por uma leitura. Itens precisam estar completos na primeira página (até 100); release e materialização mantêm seus próprios limites mais estritos. Preço e total exigem BRL e preservam zero explícito. IDs de itens são opacos e podem conter parâmetros: são usados apenas para deduplicação, nunca concatenados em SQL ou consulta. `variantTitle:null` significa ausência de variante distinta conforme a API; imagem ausente continua ausente e pode bloquear um template que a exija.

Somente consentimento Shopify `SUBSCRIBED` permite material de envio; descadastro nativo/global/da marca continua sendo rechecado. Checkout concluído prova compra; `completedAt:null` não prova ausência de outro pedido. O provedor de compra está descrito em [journey-graph-purchase.md](journey-graph-purchase.md): positivo pode bloquear; ausência observada permanece desconhecida.

As duas chamadas externas compartilham um orçamento de 4,5 s e sinal de cancelamento. Sem retry. Erro não cai silenciosamente no material antigo. Após a rede, o adaptador relê identidade/carrinho/e-mail; a fonte relê consentimento, supressão e elegibilidade, inclusive quando usados dentro da transação do executor.

## Composição e limites

`createShopifySource({query,request,shops,clock,collectorWorkflowIds})` fixa lojas `{id,myshopifyDomain}`, resolver SQL e consultas GraphQL. `request` é dependência de servidor: respeita abort, restringe domínio/versão/credencial e limita 256 KiB antes de parsear; não deve registrar corpos. O navegador não fornece configuração, destinatário, fatos ou credenciais.

Não foram instalados schema de fonte/release, consumidor ou transporte neste PR. Ainda faltam cobertura de ausência de compra com a semântica exigida, reserva compartilhada com legado, vínculo de cache nativo e recibo de transporte. Nenhuma ausência observada é convertida em Não para viabilizar a ativação.

Não há migração nem alteração de workflow para implantar neste delta. Uso futuro exige revisão de credenciais/lojas reais, banco de fonte/release instalado com guardas, integração no executor e aceite antes de qualquer capability operacional. Rollback deste código OFF é remover sua composição; não reexecutar nem apagar recibos/eventos.

## Evidência

- Consulta validada no schema oficial, artefato `crm-cart-refresh-20260927`, revisão 1. `Customer.email` e `emailMarketingConsent` ainda são aceitos, mas estão depreciados; migração desses campos deve preservar o contrato.
- Leitura real em 26/09 às 23h04 BRT: um carrinho consentido por marca, material validado localmente; Fish com um item, Aristo com dois, consultas de 0,384 s e 0,412 s. Identidade nativa conferida antes/depois. Recusa de consentimento também comprovada nas duas marcas.
- A prova é leitura Shopify real + replay local do provider. O ledger candidato não estava instalado; não é aceite de executor, claim ou envio. Não foram salvos corpos, contatos ou tokens no recibo. Provas privadas: `crm-graph-live-source-20260927/refresh-live-consented-fixed-safe.json` e `refresh-live-diagnostic-safe.json`.
- Regressão sintética cobre marcas, consulta parcial, mudança durante I/O, dados incompletos, cancelamento e ausência de escrita. CI PostgreSQL 17.10 usa duas conexões para alterar opt-out/e-mail durante a consulta e provar que a resposta antiga não libera envio. O resultado da CI deve constar no PR antes do merge.

Fontes oficiais: [AbandonedCheckout](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/AbandonedCheckout), [itens e variante ausente](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/AbandonedCheckoutLineItem), [IDs globais e parametrizados](https://shopify.dev/docs/api/usage/gids).
