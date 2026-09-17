# Atribuição de Growth por pedido

Versão 2, setembro de 2026. Escopo ativo: Fishermans, O Aristocrata e Olivas do Campo. Cada marca conserva sua cobertura efetivamente observada.

## Regra de crédito

O painel oferece dois modelos com janela de 30 dias antes da criação do pedido:

- **Último clique — padrão desde 16/09/2026:** última visita informada pela Shopify, inclusive retorno direto. Se ela não for do e-mail, a receita não recebe crédito final de e-mail.
- **Último clique não direto:** visita identificada mais recente; retornos diretos e referências internas da própria loja e retornos do modal PIX (`pix-on-site.appmax.com.br`) não substituem esse crédito.

Uma compra recebe um crédito final. E-mail exige UTM de origem reconhecida (`email`/`listmonk`); WhatsApp exige `whatsapp` ou a origem histórica reconhecida da Reportana. Receber, abrir ou ler uma mensagem não comprova clique nem atribui uma venda. A jornada depende do rastreamento disponível à Shopify e não resolve perda de cookies ou troca de dispositivo.

Só entram pedidos reais, não cancelados, pagos ou parcialmente reembolsados, em BRL, com saldo líquido recebido positivo. O valor é `netPaymentSet.shopMoney.amount` (recebido menos reembolsado), e a data é a de criação do pedido em Brasília. Não é faturamento contábil pelo dia da liquidação.

O tipo de cliente usa a posição daquele pedido na jornada, não a contagem atual de compras do cliente.

A referência de último clique é a [última sessão anterior ao pedido registrada pela Shopify](https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerJourneySummary#field-CustomerJourneySummary.fields.lastVisit). É atribuição observada; não comprova causalidade incremental. Pedidos sem última sessão confirmada ficam fora do crédito estrito. Trocar o modelo padrão não altera pedidos, pagamentos, UTMs ou resultados já calculados em cada modelo; o não direto continua disponível para comparação explícita.

## Conciliação e cobertura

Cada registro tem chave loja + ID do pedido. Reprocessar atualiza o mesmo registro; correções de origem, cancelamentos e reembolsos removem o crédito anterior dos agregados. Leituras antigas não sobrescrevem dados mais recentes. A coleta regular usa pedidos atualizados; o histórico usa intervalos de criação explícitos.

Todas as páginas de pedidos devem terminar antes de registrar cobertura das duas marcas. A jornada consulta os 50 momentos mais recentes e inclui a última visita. Jornadas truncadas sem um último toque não direto comprovado permanecem desconhecidas; a primeira visita não preenche uma lacuna da paginação. Assistências podem estar incompletas quando a jornada está truncada. Pedidos cuja jornada ainda não está pronta ficam pendentes, visíveis no indicador de qualidade.

Cobertura identifica dias e marcas efetivamente lidos. Datas fora da cobertura não recebem os antigos totais agregados como se estivessem conciliadas. Hoje é parcial até a última leitura. O indicador de coleta usa a leitura registrada, não apenas a hora da consulta do painel.

O alerta do Growth respeita a marca selecionada. Atribuição v2 usa as confirmações por marca/dia, mesmo sem conversões novas. A coleta legada registra `crm_collection_receipt_v1` após ler todas as páginas e gravar os agregados; ela não rejuvenesce a data de uma venda antiga. A ausência de confirmação e uma coleta antiga continuam visíveis. `collection-evidence.js` valida a prova e `collection-receipt.sql` impede confirmação parcial e sobrescrita por execução antiga.

## Campanhas comerciais

A iniciativa comercial reúne disparos e canais. A Semana do Cliente 2026 reúne `aristo-semana-cliente`; o lançamento Desodorante Frescor reúne `aristo-desodorante` e `desodorante-lancamento`. A Campanha do Copo reúne também os aliases de texto `copo_s1_quentes`, `copo_s2_multi`, `copo_s3_carrinho` e `copo_s4_adormecidos`, conferidos nos mesmos cinco disparos que usam `fish-copo` no HTML. O envio cruzado Fishermans → Aristocrata preserva a marca emissora, mas a conversão pertence à loja onde a compra ocorreu.

Cada iniciativa abre os canais, disparos e listas/segmentos do Listmonk. Receita segue a data da compra; o total de envios segue a data do disparo. Detalhes mostram também disparos anteriores da mesma iniciativa, com a data explícita. Agendamentos não entram em resultados.

A receita por disparo exige correspondência de origem, meio, campanha, conteúdo e termo. Links do HTML e da versão em texto são considerados. URLs de redirecionamento/cupom percentualmente codificadas são decodificadas antes de extrair o rastreamento. Aliases antigos do snapshot só complementam o corpo atual quando possuem clique registrado ou quando nenhum link atual foi identificado; alterações de rastreamento antes do envio não conservam aliases obsoletos sem clique. Se mais de um disparo enviado usa a mesma tupla, não se divide a receita entre suas bases. Links exclusivos continuam mostrando sua parcela identificada; a parte compartilhada não é distribuída entre bases. A iniciativa conserva seu total deduplicado. Disparos sem UTM mantêm as métricas de envio, com receita individual não identificável. Para os próximos disparos, termos de rastreamento próprios por base permitem separar os resultados.

Envios e pessoas que clicaram são contagens por disparo, não audiência única da campanha inteira. Aberturas também podem incluir ações automáticas de provedores.

## Preparação dos próximos disparos

`campaign-tracking.js` prepara, sem enviar, links comerciais de um rascunho ou agendamento ainda não iniciado. O `utm_term` recebe um identificador estável de disparo + lista (`lm-ID-lLISTA`), mantendo qualquer termo anterior como prefixo. O identificador não contém dados de assinantes. Uma união de listas identifica o conjunto, não cada pessoa ou lista individual.

O preparo inclui HTML, texto e destino interno de cupom; preserva produto, variante, desconto e texto. Links legais, imagens, cancelamento e destinos externos ficam intactos. Disparos iniciados, agendamentos a menos de 15 minutos, redirecionamentos externos e UTMs conflitantes são recusados. Alterações devem ser conferidas contra a versão atual antes da atualização pela API do Listmonk; não há disparo, pausa ou reagendamento automático.

O painel mostra links identificados exclusivos, reutilizados ou ausência de rastreamento por disparo. Reutilização com um próximo agendamento é sinalizada antecipadamente, mas apenas disparos já enviados disputam o crédito histórico. A função de preparo é uma ferramenta operacional; não intercepta automaticamente campanhas criadas fora deste fluxo.

## Assistências

O crédito assistido é calculado por pedido e dimensão: canal, iniciativa, campanha ou peça. Repetir um toque não repete uma compra dentro da mesma dimensão. Uma iniciativa não recebe assistência por uma compra em que já teve o crédito final.

A mesma compra pode assistir iniciativas diferentes. **Não somar assistência à receita atribuída, nem somar assistências entre iniciativas como compradores únicos.** O total geral de CRM deduplica a assistência e exclui compras cujo crédito final já é de CRM. No filtro de canal, a assistência é relativa ao canal selecionado.

## Referências

- [Shopify CustomerJourneySummary](https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerJourneySummary)
- [Shopify CustomerVisit](https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerVisit)
- [Shopify Order e netPaymentSet](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order)

Os modelos acima são definidos explicitamente pelo painel; não se presume igualdade com todos os relatórios nativos de aquisição da Shopify.


## Olivas do Campo — escopo ativo em 16/09/2026

A coleta e o classificador v2 passam a incluir `olivas`, com as mesmas regras de pagamento, janela de 30 dias, último clique estrito padrão, assistência e deduplicação. A cobertura consolidada exige as três marcas; falta de histórico não pode ser preenchida com agregados legados. `attribution-olivas.sql` estende a restrição de marca, o escopo da ingestão e a identificação dos disparos comerciais. O banco aceita o escopo histórico Fish/Aristo, o escopo completo das três marcas e o escopo Olivas isolado para conciliação. Só as marcas declaradas e completas recebem cobertura.

Identidade confirmada na Shopify existente: loja `olivasdocampo.com.br`, domínio Shopify `6r9bqn-ic.myshopify.com`. Remetente existente usa `olivasdocampo.com`; contrato distingue domínio de e-mail e domínio comercial dos links. Preparador local e regras de UTM aceitam Olivas. Isso não habilita cadastro/agendamento remoto por si só.

O inventário `olivas-operations.json` contém os quatro fluxos já existentes incluídos no monitoramento. Coleta de carrinho não é prova de entrega. Monitoramento não transforma automaticamente esses fluxos em jornadas editáveis, não adiciona WhatsApp e não dá cobertura SES a envios legados. Essas integrações precisam de seus próprios vínculos, guardas e provas.

## Qualidade e testes de 17/09

O painel separa cobertura de leitura de disponibilidade da última sessão. A ausência de sessão de um pedido pago não é conversão zero nem origem direta: é rastreamento não disponível para o modelo estrito. A migração `attribution-integrity.sql` adiciona à API as quantidades com/sem última sessão e o valor sem sessão. A sessão Shopify com UTM é a evidência observada; não se afirma identificar todos os cliques humanos ou toda troca de dispositivo.

O provedor de pagamentos das marcas é Appmax. A origem de leitura varia: eventos Appmax em Aristo e dados de pagamento Shopify em Fishermans. Isso não significa provedores comerciais diferentes. A tabela PIX associa pagamento ao mesmo pedido em até sete dias; não confirma, por si só, a mesma cobrança enviada ou um clique no botão nativo. Coortes abertas permanecem provisórias. Uma coorte com janela encerrada e fonte não reconsultada após o encerramento também não oferece taxa final confiável.

A/B deve registrar variante e versão antes do envio, conservar a unidade de sorteio, contar todas as unidades elegíveis atribuídas a cada braço e acompanhar resultado independente de clique. As variantes atuais de carrinho usam hash do carrinho e etapa, sem registro versionado de experimento; isso não equivale a um teste consolidado de toda a jornada. Sem grupo sem mensagem não se estima o efeito incremental da automação; A/B entre duas mensagens estima a diferença entre elas. Pedido pago e rastreio não podem receber crédito por causar a compra que já aconteceu. NPS deve priorizar resposta válida, e não a receita do pedido pesquisado.

A nova taxa de janela encerrada exige snapshots financeiros reconsultados depois de sete dias. Eventos Appmax Aristo não são tratados como reconsulta de estado e não habilitam essa taxa final. `fonte_pagamento` diferencia eventos Appmax de transações Shopify; ambos representam pagamentos do provedor Appmax. A migração também filtra snapshots Fish pela marca antes da junção por ID.

## Evidência por disparo e cobrança — 17/09/2026

`attribution-dispatch-evidence.sql` resolve o vínculo por pedido antes de agregar: as cinco UTMs devem coincidir e o início do disparo deve anteceder a visita vencedora. Mais de um candidato anterior mantém a receita sem divisão por disparo; candidatos posteriores são excluídos. A receita total de CRM, a elegibilidade financeira e os modelos de último clique permanecem os mesmos. A conciliação separa pagos com crédito CRM, diretos/outros e origem desconhecida. Vínculo temporal por UTM não comprova identidade do destinatário nem causalidade.

`pix-charge-evidence.sql` e `.js` registram, atomicamente com a reserva real do WhatsApp, a impressão SHA-256 do código do cartão, valor, validade e template. Não armazenam o código completo nessa tabela. A confirmação de aceite recebe horário próprio depois da resposta da Meta. Tentativas internas/sombra, opt-outs e reservas duplicadas ficam fora; exclusão da reserva por falha transitória remove sua evidência por cascade.

Um evento Appmax comprova pagamento da cobrança enviada somente se marca, impressão exata do código e valor corresponderem, existir identificação bancária end-to-end e o pagamento ocorrer depois do aceite e antes do vencimento. Para Aristo, o ID do pedido Appmax também deve corresponder. Eventos de estorno/contestação/cancelamento invalidam o resultado. Falta de evento continua desconhecida; não há taxa final nem promessa de conciliação de todos os estornos. Fishermans só terá prova da cobrança original quando um evento Appmax correspondente estiver disponível; a transação Shopify permanece como medição separada do mesmo pedido.

O painel apresenta essa evidência somente para novos envios instrumentados. Não reconstruir o código enviado historicamente a partir do estado atual do pedido. O indicador não se soma à atribuição por clique e não equivale a incremento causado pela mensagem. Experimentos A/B ainda exigem registro, alocação persistente e análise da coorte completa.

Referência do significado da última sessão e do processamento da jornada: https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerJourneySummary . Consulta atual de pedido Appmax (distinta do webhook): https://docs.appmax.com.br/api-reference/orders/consultar-pedido .

O vínculo temporal é calculado em uma projeção materializada com atualização a cada cinco minutos e trava contra execução concorrente. A API lê o relatório completo de atribuição previamente calculado, incluindo os agregados dessa projeção. O cálculo e os vínculos exibem horários próprios, diferentes do horário da consulta e da coleta Shopify. As duas projeções são renovadas na mesma transação; falha conserva a última versão boa. Um novo pedido pode aparecer no cálculo seguinte. A atualização da página a cada 60 segundos não significa nova coleta ou cálculo. Aplicar attribution-dispatch-payload.sql depois de attribution-dispatch-evidence.sql; essa ordem instala a função que renova ambas as projeções.
