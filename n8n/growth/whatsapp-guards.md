# Guardas de resposta incerta e eventos transacionais

Os dois geradores recebem um export fresco e `expectedVersionId` correspondente. São funções puras: não acessam rede, não contêm credenciais, não enviam mensagens e não publicam o workflow. Falham se o formato do nó mudou. Aplicam alterações pontuais, preservando conexões, modos, templates, reservas e outras frentes.

`whatsapp-uncertain-patch.cjs` altera somente o intérprete de resposta. Aceite com identificador do provedor mantém o tratamento vigente. HTTP5xx, resposta sem status, resposta2xx sem recibo e erros transitórios conservam a reserva e registram `UNCERTAIN_META`. `terminal=true` impede nova tentativa automática; `incerto=true` significa resultado não esclarecido, não rejeição definitiva. A evidência de cobrança ligada à reserva também permanece. Uma chave nova não é mecanismo de recuperação de uma operação incerta.

`whatsapp-transaction-guard.cjs` acrescenta os campos necessários à consulta Shopify já existente e valida o pedido antes de montar o envio. Exige a identidade exata, estado de teste conhecido/falso e cancelamento conhecido/ausente. O aviso de pedido pago exige PAID e uma SALE/CAPTURE SUCCESS real com data válida, não futura. Rastreio também bloqueia cancelamentos, estorno total, void e expiração, sem introduzir uma regra histórica de corte nem uma exigência nova de pagamento para preparação. Falhas seguem o descarte existente, antes da reserva e do motor.

A consulta foi validada por leitura autenticada em um pedido pago e um pedido cancelado já existentes. Os campos exigidos estavam presentes; a guarda aceitou o pago e descartou o cancelado. Nenhum pedido, mensagem ou reserva foi criado por essa validação. Identificadores, conteúdo, métricas e comprovantes operacionais ficam no arquivo privado do integrador.

Os testes sintéticos verificam a reabertura de uma reserva pelo comportamento antigo, a preservação após o patch, o efeito de `ON DELETE CASCADE` sobre a evidência, o bloqueio de novo envio pela mesma referência e a conservação de um recibo posterior. Também verificam pagamento/identidade/cancelamento, datas inválidas/futuras, rejeição de respostas parciais e o caminho de descarte do workflow.

Essas verificações não tornam Shopify e o transporte uma transação única: permanece uma janela entre consulta e envio. Pagamento Shopify não prova pagamento da cobrança Appmax original, clique, atribuição ou incremento. A comprovação de publicação requer export posterior com versão ativa e comparação dos nós alterados; a comprovação operacional deve vir de eventos naturais, sem disparos criados para teste.

## Parâmetro de rastreio extraído do pedido

`whatsapp-tracking-link-patch.cjs` corrige somente o parâmetro do botão Melhor Envio já aprovado. O formato de origem Shopify é `/rastreio/<código>`; enviar só o código ao botão `https://melhorrastreio.com.br/{{1}}` omitia esse segmento. A função preserva o caminho recebido, validando o pedido exato, fulfillment bem-sucedido, código correspondente e domínio/caminho estritamente permitidos. Não usa a conta genérica como fallback. Cancelamento, teste, estado desconhecido, lista potencialmente parcial, código divergente ou URL ambígua resultam em descarte antes do motor.

O gerador exige export/versão fresca e catálogo atual com os templates esperados APPROVED e a mesma base aprovada do botão. Só modifica a consulta de origem e a montagem do componente, conservando templates, conexões e os demais caminhos. Loggi e Total Express constam da taxonomia de auditoria, mas não são alterados nesta etapa. A prova local inclui a fonte real e o código completo de ambas as marcas, sem publicar dados de cliente. As URLs identificáveis de rastreio não foram abertas, e não há prova de clique/entrega atribuída a esse patch.

Os templates atuais de pedido pago e rastreio genérico têm botões de conta estáticos. Eles não suportam `statusPageUrl` por simples parâmetro de envio. As leituras Shopify confirmaram a disponibilidade da URL específica do pedido; seu uso depende de um template compatível, aprovação e publicação controlada. Templates de PIX não devem ser reutilizados para contornar essa limitação em uma mensagem de pagamento confirmado.

## Novas versões de pedido específico, ainda desativadas

O arquivo privado `WORKSPACE/.private/runtime/wa-order-status-drafts-proposed.json` contém seis propostas locais, mantendo o conteúdo revisado e o suporte das duas marcas. Apenas o botão principal vira dinâmico no domínio próprio; os nomes v2 preservam os templates atuais. Todos os exemplos são sintéticos. O gerador recusa colisão de nomes ou mudança no conteúdo/base aprovado usado como origem.

O campo opcional `exemplo_url` aceita somente o exemplo reservado `0/orders/EXEMPLOPEDIDO/authenticate?key=EXEMPLOCHAVE`, em uma das bases próprias de pedido. Outros valores geram erro de validação e não são usados no payload; o fluxo pode salvar rascunho com erros, mas não submetê-lo. Ausência do campo mantém a regra anterior. `whatsapp-template-example-patch.cjs` altera somente as duas cópias WAT da API sobre versão fresca. Importação/exportação do painel preserva o campo opcional.

`whatsapp-order-status-proposal.cjs` resolve o caminho autenticado retornado para o pedido exato e preserva sua chave opaca, sem fabricar URL. A proposta de adaptador permanece `enabled=false` e sem ID aprovado. Depois de aprovação comprovada, template e componente devem ser selecionados juntos no motor; as guardas financeiras/cancelamento existentes permanecem no caller. O adaptador também bloqueia PIX como pedido pago, conteúdo divergente e status pendente. Esse artefato é uma proposta testada, não publicação/ativação de workflow.
