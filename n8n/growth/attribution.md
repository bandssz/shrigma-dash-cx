# Atribuição de Growth por pedido

Versão 2, setembro de 2026. Escopo conciliado: Fishermans e O Aristocrata. Olivas permanece fora desta etapa.

## Regra de crédito

O painel oferece dois modelos com janela de 30 dias antes da criação do pedido:

- **Último clique:** última visita informada pela Shopify, inclusive retorno direto.
- **Último clique não direto:** visita identificada mais recente; retornos diretos e referências internas da própria loja e retornos do modal PIX (`pix-on-site.appmax.com.br`) não substituem esse crédito.

Uma compra recebe um crédito final. E-mail exige UTM de origem reconhecida (`email`/`listmonk`); WhatsApp exige `whatsapp` ou a origem histórica reconhecida da Reportana. Receber, abrir ou ler uma mensagem não comprova clique nem atribui uma venda. A jornada depende do rastreamento disponível à Shopify e não resolve perda de cookies ou troca de dispositivo.

Só entram pedidos reais, não cancelados, pagos ou parcialmente reembolsados, em BRL, com saldo líquido recebido positivo. O valor é `netPaymentSet.shopMoney.amount` (recebido menos reembolsado), e a data é a de criação do pedido em Brasília. Não é faturamento contábil pelo dia da liquidação.

O tipo de cliente usa a posição daquele pedido na jornada, não a contagem atual de compras do cliente.

## Conciliação e cobertura

Cada registro tem chave loja + ID do pedido. Reprocessar atualiza o mesmo registro; correções de origem, cancelamentos e reembolsos removem o crédito anterior dos agregados. Leituras antigas não sobrescrevem dados mais recentes. A coleta regular usa pedidos atualizados; o histórico usa intervalos de criação explícitos.

Todas as páginas de pedidos devem terminar antes de registrar cobertura das duas marcas. A jornada consulta os 50 momentos mais recentes e inclui a última visita. Jornadas truncadas sem um último toque não direto comprovado permanecem desconhecidas; a primeira visita não preenche uma lacuna da paginação. Assistências podem estar incompletas quando a jornada está truncada. Pedidos cuja jornada ainda não está pronta ficam pendentes, visíveis no indicador de qualidade.

Cobertura identifica dias e marcas efetivamente lidos. Datas fora da cobertura não recebem os antigos totais agregados como se estivessem conciliadas. Hoje é parcial até a última leitura. O indicador de coleta usa a leitura registrada, não apenas a hora da consulta do painel.

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
