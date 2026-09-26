# Revisão de uso do CRM — 26/09/2026

Candidato de frontend iniciado sobre `af77d7a` e integrado com `fa1e224`, restrito ao Growth. A varredura cobriu **Início, Campanhas, Automações, Templates, Público e Resultados**, além da troca de marca, período e respostas atrasadas. Os cenários usam Fish e Aristo; não houve alteração em CX, Orgânico ou Influs.

A evidência desta revisão é local: código, DOM e contratos de API exercitados com respostas simuladas/interceptadas. **Não é aceite visual em navegador nem confirmação de publicação.** A aprovação final depende da CI do commit integrado e da conferência da interface publicada. As referências abaixo identificam os cenários, sem substituir o resultado da CI.

| Aba | O que permanece útil | Decisão de organização |
| --- | --- | --- |
| Início | Resumo da marca, atualização e atalhos para operar. | Preservar resumo; detalhes da infraestrutura continuam restritos à visão do dono. |
| Campanhas | Preparação, público, agenda, histórico e UTMs. | Manter testes A/B em subaba; consultar tentativa só fica disponível quando existe uma. Aviso de cobertura acompanha os números. |
| Automações | Editor, etapas, prévias e histórico. | Preservar editor e histórico como funções distintas; eliminar reapresentação de outra marca e perda de digitação. |
| Templates | Rascunhos e catálogo publicado. | Não são duplicatas: publicar e editar têm estados diferentes. Unificar criação em um menu e reduzir a competição entre salvar, exportar e publicar. |
| Público | Segmentos, listas, filtros e ordenação. | Mostrar listas confirmadas sem inventar tamanho; retirar orientação que prometia carregar listas pelo botão geral de atualização. |
| Resultados | Entregas/engajamento, atribuição e conversões. | Manter análises separadas por finalidade; remover o vazio causado pela ocultação indevida da tabela de e-mail. |

| ID | Prioridade | Problema e ajuste do candidato | Evidência local |
| --- | --- | --- | --- |
| CRM28 | Atrapalha | Criação de WhatsApp/e-mail tinha destaque estático. Um menu apresenta os dois canais e identifica o canal do editor aberto. | `tests/growth-drafts-ui-actions.test.cjs`: menu e indicação de canal nas duas marcas. |
| CRM29 | Atrapalha | Salvar, exportar e ações seguintes competiam; a linguagem confundia cópia local com versão no CRM. O próximo passo recebe destaque, opções locais ficam separadas e o estado de salvamento é explícito. | Mesmo arquivo: destaque por estágio, salvamento local sem escrita remota, reabertura limpa e preservação da revisão. |
| CRM30 | Quebra operação | Criar, trocar, importar ou fechar podia perder edição. Confirmação HTML protege conteúdo alterado; criação ainda vazia não exige descarte. Pendências e operações ativas continuam protegidas. | Mesmo arquivo: Escape, clique duplicado, conteúdo digitado/importado, contexto alterado, confirmação e tentativa incerta. |
| CRM31 | Quebra operação | Resultados → Campanhas de e-mail ficava oculto com atribuição v2. A tabela permanece disponível; filtro exclusivo de WhatsApp oferece a ação de voltar ao e-mail. | `tests/growth-render.test.cjs`: `CRM sweep: email results…`, nas duas marcas. |
| CRM32 | Quebra operação | Datas inválidas permaneciam nos campos enquanto as métricas usavam outro período. O painel restaura o período aplicado e explica a recusa; datas válidas e atalhos removem o aviso. | Mesmo arquivo: `CRM sweep: invalid dates…`; período, métricas e número de requisições preservados após recusa. |
| CRM33 | Quebra operação | Atualização da jornada podia perder texto ainda sem sair do campo. O rascunho acompanha a digitação; foco e seleção são restaurados apenas na mesma jornada/revisão. | `tests/growth-editor-refresh.test.cjs`: texto, espera, nome e inspetor visual durante atualização. |
| CRM34 | Quebra operação | Respostas tardias de catálogo/histórico podiam repintar a marca anterior. A leitura fica vinculada à marca, origem e acesso que a iniciaram; respostas superadas são descartadas. | Mesmo arquivo: catálogo e histórico atrasados, nova requisição e troca de acesso/origem, inclusive erro. |
| CRM35 | Quebra operação | Marca sem jornadas podia manter a jornada anterior na tela. Seleção limpa é removida; rascunho alterado e pendência permanecem conservados, sem apresentar editor da outra marca. | Mesmo arquivo: marca vazia, rascunho alterado e registro pendente. |
| CRM36 | Quebra operação | O histórico de campanhas não mostrava a cobertura parcial; fonte ausente deixava um vazio sem orientação. Aviso compacto acompanha o histórico; ausência oferece atualizar. Resultados mantém seus detalhes. | `tests/growth-attribution-status.test.cjs`: parcial, fonte ausente, botão e transições de `hidden` partindo do DOM oculto. Sem aviso, o bloco fica vazio e oculto. |
| CRM37 | Quebra operação | Listas já confirmadas no catálogo não chegavam a Público. `GCE.catalogs()` fornece cópia do catálogo corrente e `onCatalog` atualiza somente Público, sem nova consulta. Identidade da lista não vira contagem de pessoas. | `tests/growth-campaign-catalog-ui.test.cjs`: duas marcas, cópia isolada, contagem/data `null`, invalidação por marca/acesso/origem/capacidade, atraso e falha. |
| CRM38 | Atrapalha | “Consultar tentativa registrada” de A/B ficava habilitado sem tentativa. O botão acompanha a existência de pendência e a consulta em andamento, preservando a recuperação existente. | `tests/growth-render.test.cjs`: `CRM sweep: attempt lookup…`; indisponível sem pendência e disponível para recuperação. |
| CRM39 | Quebra operação | A fila usava o fuso do dispositivo apesar de o painel anunciar Brasília. Horário e rótulo agora fixam Brasília. | Mesmo arquivo: `CRM sweep: scheduled campaign time…`; instante UTC exibido às 18h de Brasília. |

## Limites e reversão

As correções mantêm os contratos existentes de confirmação, revisão, permissão e registro de tentativa. Não tornam o A/B completo operacional, não instalam o construtor adicional e não encerram dependências de backend. Consultar uma tentativa continua sendo leitura; ausência de recibo não autoriza repetir uma gravação.

Os testes de atribuição e catálogo reproduziram as falhas antes da correção. A verificação de visibilidade inclui o atributo `hidden`, não apenas o texto inserido no DOM. Testes de atualização verificam preservação de conteúdo e contexto; aparência, foco real do navegador e responsividade ainda precisam de aceite visual.

Rollback: **reverter o commit de frontend**, regenerar somente os artefatos Growth e seguir a CI/publicação normal. Não há migração SQL ou mudança de workflow para desfazer nesta revisão; não limpar rascunhos nem registros locais de tentativas.
