# Consulta de compra Shopify — candidata, OFF

`createPurchaseProvider` é somente leitura. Não inscreve participantes, cria contatos, altera listas ou envia. Não está ligado à produção. O contrato antigo continua sem fornecer ausência autoritativa; a política observacional abaixo é separada e exige opção explícita do servidor. Uma compra encontrada bloqueia conservadoramente a recuperação de carrinho, inclusive se o pedido foi posteriormente cancelado/reembolsado, como no marcador legado de compra.

## Integração de servidor

Dependências: `resolveIdentity`, `request`, `shops` e `clock`. O relógio, configuração de loja e resolução vêm do servidor, nunca do editor/body. `shops[fish|aristo]` fixa `{id: Shop GID, myshopifyDomain}`; cada resposta confere os dois. Credenciais permanecem no adaptador HTTP/n8n existente, fora do módulo.

`purchaseFor({source_ref,subject_id,brand,occurred_at,now,query,signal?})` usa `subject_id` **UUID Listmonk**, não ID Shopify. `resolveIdentity` recebe esses argumentos e `signal`, e devolve `{version:'journey_shopify_identity_v1',source_ref,subject_id,brand,occurred_at,checkout_id,email}`. Deve reler a identidade nativa/evento na transação fornecida. Não basta repassar campos do chamador. O provedor relê o checkout exato, exige `createdAt` igual à referência e compara o e-mail do cliente associado com o nativo, sem corrigir typos ou pesquisar por texto. Repete a resolução SQL após a rede antes de devolver positivo/ausência observada; mudança do carrinho ou e-mail invalida a observação. Ausência ou vínculo ambíguo fica desconhecido. Abort externo cancela o controller de todas as dependências; sinal já abortado impede inclusive o resolver.

`request({brand,shop,apiVersion,document,variables,signal,maxResponseBytes})` deve usar apenas a loja/credencial configurada e retornar `{status,body}`. Deve respeitar abort/timeout e limitar **bytes antes de parsear** a 256 KiB; a guarda posterior do módulo também rejeita corpo excessivo. Erros/corpos, e-mails e IDs Shopify não são retornados pelo provedor. O transporte não deve registrar payloads.

Resultado `journey_purchase_observation_v1` conserva identidade do evento, `observed_at`, `basis`, `code`, `purchased:true|null`, `complete` e `query_complete`. Compra comprovada traz `purchase_at`; pedido identificado traz somente `order_ref_hash`. `complete:true` significa prova de **existência**, não cobertura histórica. `coverage` registra intervalo solicitado, início/fim locais, páginas/itens, janela de acesso e esgotamento. Não inventa `covered_through`.

**É um contrato novo:** o `journey_purchase_evidence_v1` antigo exige cobertura negativa até `now`; não adaptar estes resultados acrescentando esse campo. A integração de fonte deve aceitar apenas o positivo vinculado, com data de compra entre abandono e observação confiável. Nenhum resultado deste módulo fornece `purchased:false`.

## Política observacional opcional

O servidor pode configurar `observationPolicy:'cart_customer_order_observation_v1'`. A opção omitida preserva o comportamento anterior e o payload do chamador não pode ativá-la. Política desconhecida é recusada. Quando a prova é válida, o resultado acrescenta:

```text
observation: {
  policy: 'cart_customer_order_observation_v1', found: boolean,
  brand, source_ref, subject_id, occurred_at, check_at,
  shop_ref_hash, customer_ref_hash, checkout_ref_hash,
  enumerated, checkout_rechecked, head_rechecked
}
```

`found` significa **pedido encontrado após a referência para o cliente ligado ao carrinho no instante da última conferência**. `check_at` vem do relógio de servidor após a última resolução nativa, não é watermark Shopify. Os três hashes SHA256 são separados por tipo e vinculados à política, marca e loja. Nenhum ID Shopify/e-mail é exposto. Fonte/evento/assinante permanecem vinculados pelos identificadores nativos e referência imutável.

Para `found:false`, a enumeração precisa esgotar os pedidos acessíveis, com escopos e janela suficientes para o intervalo solicitado. Em seguida o módulo relê o checkout, sua associação ao cliente/e-mail, referência e escopos; relê a primeira página de pedidos; exige a mesma primeira página sem compra; e repete a resolução SQL da identidade. Os três indicadores de conferência precisam ser verdadeiros. Se a primeira página mudar sem uma compra positiva, retorna `GRAPH_PURCHASE_HEAD_CHANGED`, sem observação. Falha, limite, timeout, cobertura insuficiente ou vínculo alterado também não emitem `observation`.

Compra positiva em qualquer página ou na conferência final prevalece: `found:true` e `purchased:true`. Checkout concluído também é positivo, sem fingir que os demais pedidos foram enumerados/reconferidos. Os indicadores continuam registrando somente as etapas realmente realizadas.

Mesmo com `found:false`, **`purchased:null` e `complete:false` permanecem intactos**. Esta observação não garante ausência em outra identidade, visibilidade instantânea, snapshot atômico nem ausência de compra após a leitura. A integração deve criar o fato separado `purchase.observed_for_cart`, sob política imutável própria; não reescrever `purchase.confirmed` nem liberar contratos antigos. Consentimento/opt-out, frescor e nova conferência antes do futuro transporte continuam obrigatórios fora deste provedor.

## Consulta e limites

Consultas fixas Admin GraphQL **2026-07**: checkout pelo GID, escopos e loja; depois `Customer.orders` por GID, ordenado por criação, sem filtro de e-mail, pagamento ou status. Checkout concluído ou pedido do mesmo cliente posterior ao abandono prova compra. A enumeração segue cursores até esgotar; erro parcial, duplicação, mudança de identidade, ordenação inválida ou limite mantém desconhecido.

Padrão: até cinco páginas de 100 pedidos, mais a consulta de identidade, em 4 s totais; limite configurável máximo 10 páginas/4,5 s. A política observacional acrescenta, dentro do **mesmo orçamento total**, uma releitura de checkout e uma da primeira página. `coverage.pages/orders` inclui essa página repetida; não é contagem de pedidos únicos. Sem retry. O abort inclui o resolver e as conferências finais. Sem `read_all_orders`, a janela usual é 60 dias; margem conservadora de um dia impede declarar o intervalo consultável na borda. `read_customers` também é exigido para enumerar o cliente.

Esgotamento válido retorna `query_complete:true`, `basis:'absence_observed'`, **`purchased:null/complete:false`**. A documentação não estabelece snapshot transacional/watermark causal: não exclui um pedido ainda não visível nem uma compra vinculada a outro cliente. Sem a política observacional explícita, isso permanece apenas diagnóstico e nunca autoriza Não. O futuro consumidor ainda deve repetir compra/opt-out e claim legado antes do envio.

## Provas e referências

30 testes sintéticos cobrem as duas marcas, associação exata, compra positiva, ausência, paginação/cursor/limites, histórico restrito, mudança de cliente/identidade durante I/O, relógio, erro parcial, tamanho em bytes e timeout/cancelamento sem retry. A política observacional acrescenta provas de pedido surgindo entre páginas/na última consulta, checkout concluído na releitura, alteração de escopos/head, opt-in e orçamento total sem renovação. As duas queries permanecem idênticas às validadas oficialmente, artefato Shopify `3124d384-4e13-48b0-922c-04747829b1f7`, revisão 1; as consultas da política também foram verificadas com o provedor real, conforme abaixo.

Prova limitada em 27/09/2026 UTC: consultas exatas em um carrinho nativo de cada marca, com igualdade de cliente/e-mail/referência; ambas conexões retornaram zero pedidos e `hasNextPage=false`. Escopos `read_orders`, `read_customers` e `read_all_orders` presentes nas credenciais atuais das duas lojas; duas consultas/loja, aproximadamente 0,8 s. Recibo privado `crm-graph-live-source-20260927/purchase-query-proof-safe.json`. Não invocou o runtime, não comprovou paginação real não vazia nem compra positiva real e não transformou vazio em Não. A prova antiga de outra credencial Fish sem `read_all_orders` não deve ser aplicada à configuração atual.

Referências oficiais: [AbandonedCheckout](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/AbandonedCheckout), [Customer/orders](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Customer), [escopos e janela de 60 dias](https://shopify.dev/docs/api/usage/access-scopes), [paginação](https://shopify.dev/docs/api/usage/pagination-graphql). A prova de leitura real, quando executada, fica somente em recibo privado agregado; não equivale a ativação do provedor nem teste de transporte.


Prova adicional somente leitura em 27/09, 12:28 UTC: o próprio provider com a política observacional foi executado nas duas lojas. Fish: 1.294 ms; Aristo: 1.346 ms, dentro do teto global de 5 s do ensaio. Enumeração esgotada, checkout final, primeira página final e duas resoluções SQL confirmaram a identidade. Fish retornou zero pedidos; Aristo retornou um pedido anterior ao abandono, relido na conferência final. Ambos produziram `observation.found:false`, mantendo `purchased:null/complete:false`. Descoberta inicial da loja foi medida separadamente (422/423 ms). Recibo privado agregado: `crm-observed-purchase-20260927/observational-live-safe-20260927T122817Z.json`.

Limitação: o ledger candidato não está instalado; o ensaio usa referência efêmera em memória e resolução nativa somente leitura. Não prova inscrição/execução do runtime, envio, paginação real múltipla nem concorrência com compra real. Nenhuma escrita foi feita.
