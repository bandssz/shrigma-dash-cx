# Inventário de e-mail e frescor do Growth

O painel separa **etapas de e-mail configuradas**, vindas da versão publicada das jornadas, de **serviços acompanhados**, vindos da inspeção dos workflows. Uma etapa habilitada não comprova execução ou entrega. Resultados continuam no quadro SES, com cobertura parcial e sem somar testes.

Em consulta somente leitura de 25/09/2026 às 00:25 BRT, Fish e Aristo tinham 14 etapas publicadas cada: cinco de carrinho, duas de NPS, uma de boas-vindas e seis de acompanhamento de pedido. A contagem é dinâmica; não existe número fixo no painel. Jornadas mescladas/arquivadas e etapas marcadas como teste ficam fora. Etapas pausadas permanecem no inventário, identificadas como pausadas.

`email-inventory-query.sql` lê somente configuração. `email-inventory.cjs` valida e projeta uma lista limitada a 200 etapas, sem conteúdo de mensagens, destinatários, credenciais ou códigos de workflow. `crm_operacao.email_steps` é um campo aditivo; consumidores antigos continuam lendo workflows/templates. A tela nova explica quando o campo ainda não chegou, sem apresentar os serviços compartilhados como catálogo completo de e-mail.

## Atualização controlada do coletor

`email-inventory-patch.cjs` é uma transformação local, sem chamadas de rede. Recebe o export **fresco** do coletor exclusivo Growth `3p35uZWGCZJEigiv` e `expectedVersionId`. Exige a mesma versão publicada e hashes exatos dos dois trechos anteriores. Recusa outra versão, outro workflow, fonte modificada ou reaplicação.

Só altera `Previous snapshot.parameters.query` e `Build snapshot.parameters.jsCode`. Acrescenta a projeção sanitizada ao snapshot; não modifica nenhum workflow observado, modo, credencial, agendamento, retenção, conexão ou API compartilhada.

Ordem de publicação: revisar o diff fresco, publicar os dois trechos no coletor, conferir a versão ativa e uma coleta com `email_steps`, aguardar a renovação normal dos dados do Growth e então conferir o painel. Se a fonte mudou, revisar o export e as guardas; não removê-las. O rollback restaura os dois trechos do backup fresco. Nenhuma migração de tabela ou alteração de cache/login é necessária.

## Horários e saúde SES

Os horários exibem dia, mês, ano e hora de Brasília, inclusive no cabeçalho e na faixa de fontes. A hora da consulta do painel não substitui a hora de coleta de cada fonte.

O diagnóstico de heartbeat/fila compara os eventos com `health.checked_at`, a hora da própria consulta de saúde. Assim, uma consulta renovada a cada dez minutos não produz um alarme falso aos cinco minutos. A consulta com mais de quinze minutos recebe aviso próprio e perde a indicação de saúde atual. As pendências e falhas observadas continuam visíveis, identificadas como informação da última consulta. Uma interrupção que já existia na consulta continua sendo alerta.

O resumo de e-mail aponta entregas/falhas com cobertura parcial; abertura e clique das automações continuam indisponíveis. As taxas de campanhas não incluem métricas SES. O frontend também ignora linhas/intervalos explicitamente marcados `is_test=true`; a exclusão principal continua nas views SES. A tabela legada `shrigma_send_log` não tem esse campo e não deve receber envios de teste como envios operacionais.

O aviso `openai_sentimento` é filtrado somente na chamada do painel Growth. A biblioteca compartilhada de alertas e os demais painéis permanecem iguais.

## Evidência local e limites

990 testes sintéticos passaram, incluindo projeção SQL em PostgreSQL isolado, preservação do grafo, configuração pausada/desatualizada, filtros de marca/período, relógio do snapshot e exclusão de testes. Os totais de campanha de 18–24/09 foram conferidos por SQL: Aristo 52.416 e Fish 36.127. O aceite operacional SES no mesmo período foi 41.637 e 7.013, igual ao agregado dos dispatches operacionais na leitura correspondente. Entregas, falhas e ausência de confirmação não devem ser somadas: um envio pode acumular resultados posteriores.

Recibos privados: `.private/runtime/crm-audit-20260924/metrics-fix-20260925/`. Nesta revisão não houve publicação em produção nem prova visual no navegador. A confirmação do novo inventário no payload servido e a CI da PR são etapas de publicação, não fatos já observados.
