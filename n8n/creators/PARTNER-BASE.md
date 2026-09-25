# Base financeira de parceiros — coleta Growth

O coletor lê apenas pedidos atribuídos a links registrados de parceiros de Aristo/Fish e snapshots desses pedidos que já existem na base. Não cria pagamentos: `commission_payable` permanece `false`. Nenhuma interface de Influs, workflow de CX, tabela `cx_*` ou peça compartilhada é alterada.

## Arquivos e instalação

- `partner-base-collector.cjs`: consultas GraphQL, paginação, conferência e normalização; não conhece credenciais.
- `partner-base-workflow.cjs`: gera um workflow isolado com HTTP Request autenticado pelo cofre do n8n e consultas Postgres parametrizadas.
- `partner-commission-base.sql`: migração aditiva/idempotente da base existente, fila de pedidos e registro mínimo de tentativas. Aplicar depois de `pilot.sql` e `partner-link.sql`, que já existem no runtime. Reaplicar `partner-link.sql` depois desta migração substitui a função de leitura; reaplique esta migração nesse caso.

Antes da instalação, conferir export atual, referências das credenciais, hosts das duas lojas e definições SQL existentes. `build` recebe `shops` (marca, origin HTTPS `*.myshopify.com`, referência de credencial `httpHeaderAuth`), `postgresCredential` e `apiVersion` (padrão `2026-07`). O parâmetro opcional `maintenanceTrigger` recebe `path` e referência `credential`; gera somente POST com autenticação no cofre. Não passar valor de chave ao builder nem ao código de um node.

O workflow não altera os coletores ou utilitários existentes. Agendamento: **06:27, America/Sao_Paulo**. Entrada interna e manutenção autenticada aceitam `since`/`until` (`YYYY-MM-DD`, até 367 dias); sem parâmetros, usam os últimos 367 dias. O webhook espera a conclusão e o ramo vazio responde `{ok:true,pedidos:0,commission_payable:false}`. Uma execução com muitos pedidos pode ultrapassar o tempo de resposta HTTP; conferir então o estado final no n8n. Retenção de dados de execuções manuais, sucesso e erro fica desligada.

## O que a leitura comprova

As seis consultas somente leitura foram aprovadas pelo validador oficial da Shopify em 24/09/2026. O coletor busca o resumo do pedido, todos os itens, fretes, itens reembolsados, fretes reembolsados e transações de cada reembolso. Cada conexão tem paginação independente de 100 registros, com teto de 100 páginas, detecção de cursor repetido e duplicidade. Não há campos de cliente, endereço, contatos ou detalhes do meio de pagamento.

A revisão `updatedAt` é lida novamente ao final. Se mudar, se faltar uma página, se houver erro GraphQL/HTTP ou se o pedido não existir no escopo da credencial, nenhuma nova base desse pedido é gravada. Erros HTTP são retentados até três vezes. O pedido com falha registra somente marca, ID, horário e estado; o lote segue e a conclusão falha explicitamente. Erros GraphQL, incluindo `THROTTLED`, aguardam a próxima execução; não há loop ilimitado de retentativas.

A cada execução entram até 200 pedidos. Leituras existentes voltam após 24h para capturar reembolsos tardios. Pedidos que saíram da atribuição corrente por cancelamento ou reembolso continuam sendo atualizados a partir do snapshot registrado. O dono é preservado. O histórico financeiro **não** é reinserido em `partner_orders`: pedidos/receita desse retorno continuam refletindo apenas a atribuição corrente. Tentativas são ordenadas depois de pedidos nunca tentados, evitando que um lote inacessível impeça a coleta dos seguintes.

Os escopos foram conferidos em leitura real: Aristo tem `read_orders` e `read_all_orders`; Fish tem `read_orders`, mas **não tem `read_all_orders`**. Portanto, a cobertura histórica completa de Fish não está comprovada: o acesso padrão é limitado aos últimos 60 dias e pode impedir atualizar reembolsos de pedidos antigos. Ausência do escopo não é interpretada como pedido zero nem como coleta concluída. A configuração de janela permite uma recuperação limitada enquanto o acesso é corrigido.

## Cálculo e limites

A base parte do subtotal após descontos, sem acrescentar frete. Descontos de código e de pedido são conferidos usando alocações reais de cada item, sem assumir que `discountedTotalSet` contém todos eles. Reembolsos de frete e impostos precisam estar explicitados. Parte desconhecida reduz a base provisória de produtos; **o frete original não serve como prova de frete reembolsado**.

`base_exata` exige detalhes completos, soma dos itens igual ao subtotal e composição de cada reembolso igual às transações confirmadas, além da reconciliação do total do pedido. Impostos inclusos no subtotal são tratados na mesma base. Ajustes não itemizados, transações falhas/pendentes e discrepâncias permanecem estimados. Pedidos de teste, cancelados ou fora de `PAID`/`PARTIALLY_REFUNDED` têm base zero. Isso não habilita pagamento.

`comissao`/`comissao_fechada` só aparecem como fechadas se todos os snapshots forem completos, exatos e tiverem menos de 24h. O SQL recalcula a base e recusa duplicatas, moedas fora de BRL, valores ausentes/inválidos, pedidos novos fora do recorte e troca de dono. `fonte_atualizada_em` prevalece sobre a ordem de chegada: snapshot antigo não restaura uma comissão anterior ao reembolso.

As fixtures financeiras históricas de 21/09 não têm fretes reembolsados, transações e páginas completas. Continuam demonstrando base zero nos pedidos integralmente reembolsados/cancelados; não são promovidas a prova de reconciliação completa.

## Verificação

Executar `node --test tests/partner-*.test.cjs`, com `CAMPAIGN_PGLITE_MODULE` apontando para a dependência PGlite instalada. A suíte cobre a aritmética, fixtures reais anonimizadas, paginação, troca de revisão durante a leitura, simulação dos nodes de código/loop, isolamento por marca/dono, idempotência da migração, snapshots fora de ordem, exclusão da atribuição após reembolso e progresso além de 200 falhas.

O grafo simulado não substitui a execução no n8n para verificar HTTP Request e item linking. Em 24/09, a conferência anterior à instalação encontrou base legada com 15 colunas, **zero links, zero snapshots e zero pedidos de parceiro pendentes**.

## Estado publicado em 24/09/2026

A migração foi aplicada em produção: 14 instruções, base com 27 colunas e as quatro funções conferidas por igualdade do corpo após a instalação. O workflow **`RAJ2HxVhJFfpTpqO` está ativo**, versão `600aa10e-7848-4261-ad9d-f75dde5d8632`, com 20 nodes e leitura posterior igual ao candidato publicado. Mantém agendamento às **06:27 BRT**, autenticação de manutenção no cofre e retenção de dados de execução desligada.

A execução de verificação comprovou autenticação e o caminho vazio: sem cabeçalho ou com valor incorreto, HTTP 403; com autenticação correta, resposta `{ok:true,pedidos:0,commission_payable:false}`. Após essa execução, a base continuava com zero snapshots e o registro de tentativas com zero linhas.

### Prova financeira real, sem ingestão

Um workflow temporário autenticado executou o mesmo estado e grafo de leitura do coletor com quatro pedidos reais já existentes, sem nenhum node SQL, criação de parceiro ou alteração de pedido. A execução retornou HTTP 200, quatro leituras concluídas e zero falhas. Uma conexão de itens foi reduzida a uma linha por página apenas nessa prova: duas páginas e uma continuação real confirmaram cursor e item linking no n8n.

| Loja | Pedidos lidos | Reconciliação exata | Base estimada |
| --- | ---: | ---: | ---: |
| Aristo | 2: um pago e um reembolsado/cancelado | 2 | 0 |
| Fish | 2: um pago e um reembolsado/cancelado | 1 | 1, reembolso sem linhas financeiras |

Os valores financeiros individuais ficam somente no recibo privado. A prova confirmou que os pedidos reembolsados/cancelados não deixam base elegível e que um reembolso não itemizado permanece marcado como estimado.

O temporário `2Ml1z0pbxsS0ZO21` foi desativado e removido após a prova, com backup. O coletor principal permaneceu ativo, com versão, nodes, conexões e configurações iguais ao export anterior. Nenhum snapshot foi fabricado para a prova.

**Ainda não comprovados:** execução do agendamento, ingestão de um pedido legitimamente atribuído a parceiro e cobertura histórica de Fish sem `read_all_orders`. O caminho financeiro real e sua paginação foram exercidos, mas ainda não havia parceiro para comprovar a integração completa com a base de comissão. `commission_payable` segue `false`.

Os recibos ficam no diretório privado `.private/runtime/growth-audit-20260924/`: `partner-sql-install-journal.json`, `partner-sql-install-after.json`, `partner-sql-functions-readback.json`, `partner-workflow-published.json` e `partner-live-smoke.json`. Não publicar arquivos de manutenção, credenciais ou exports privados junto da documentação.

Os recibos da prova real ficam em `bloco2-shopify/`, dentro desse diretório: `probe-result-20260925T010850Z.json` (horário UTC; ainda 24/09 BRT), `probe-auth-noheader.json`, `probe-inactive-backup.json`, `probe-lifecycle.json` e `collector-after-probe.json`. A resposta financeira contém apenas agregados, contagens e escopos, sem IDs ou nomes de pedidos.

## Referências Shopify

- [Order: valores financeiros, updatedAt e acesso a pedidos antigos](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order)
- [LineItem: alocações e limites dos totais descontados](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/LineItem)
- [Refund: presença do reembolso não comprova transação concluída](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Refund)
- [RefundLineItem](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/RefundLineItem), [RefundShippingLine](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/RefundShippingLine)
