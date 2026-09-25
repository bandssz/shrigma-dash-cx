# Growth — investigação do n8n e avaliação PostgreSQL, 24/09/2026

A investigação confirmou a recorrência em 24/09: **214 registros iniciados entre 20:03:31 e 20:05:16 BRT continuavam `running` às 22:05**, dos quais 191 pertencem a Growth. O início coincide com o lote recorrente de e-mails de atualização de entrega. API, banco de negócio e consumo SES respondiam durante a leitura posterior; isso não resolve os registros sem conclusão. **A causa ainda não está demonstrada:** faltam logs e métricas do processo, disco e SQLite durante a janela. Migrar para PostgreSQL é uma hipótese de melhoria de capacidade, não uma correção comprovada para toda a cadeia de falha.

Somente leitura em produção. Nenhum workflow, execução, banco, variável do serviço ou item de CX foi alterado nesta investigação. A amostra da API contém metadados operacionais gerais; a análise de configuração e efeitos de negócio ficou em Growth. As 35 exclusões de CX foram respeitadas; NPS foi excluído das consultas do log de envios. Os relatos anteriores são evidência histórica, não autorização para executar suas recomendações.

## Estado medido hoje

Às 19:23 BRT, quatro consultas da API pública responderam em **0,14–0,22 s**:

- `running`: 3, todos do consumidor SES `qBC4HJC4qKSLkBBf`, iniciados nos dez segundos anteriores. A paginação terminou; não havia outras execuções nesse filtro.
- `waiting`: 0, sem próxima página.
- `error`: 44 registros retidos, todos iniciados hoje. Não equivalem à taxa de falha de todos os workflows.
- `success`: amostra limitada aos 250 mais recentes, cobrindo aproximadamente dez minutos. Havia próxima página; não foi percorrida.

Às 19:27 BRT, uma nova consulta de `running` respondeu em 0,29 s: somente uma execução transacional de Growth, recém-iniciada. Os três IDs anteriores do SES não estavam mais na lista. Isso não prova sua conclusão com sucesso: tanto o consumidor SES quanto o transacional de e-mail salvam **nem sucesso nem erro** (`saveDataSuccessExecution: none`, `saveDataErrorExecution: none`).

A versão instalada rejeitou com HTTP 400 os filtros `status=crashed` e `status=new`, embora a documentação pública atual os liste. Esses grupos **não foram medidos**. A versão do binário precisa ser confirmada no host antes de aplicar recomendações da documentação atual. Não houve tentativa por API interna ou contorno da limitação.

Às 19:25 BRT, três consultas agregadas no banco de negócio responderam em **0,22–0,24 s**:

- SES: última consulta bem-sucedida há 3 segundos, `queue_visible=0`, `queue_inflight=0`, `queue_delayed=0`; medição da fila há 26 segundos.
- Último erro registrado pelo coletor: 10:50 BRT do mesmo dia; não é erro corrente.
- Reservas de e-mail Growth sem conclusão: 35 `in_flight` e 5 `outcome_unknown`, todas de 14 ou 18/09; nenhuma mais recente nessa consulta. Não foram reprocessadas.

Não há evidência de incidente ativo nesse retrato anterior às 20h. A ausência atual do backlog histórico não identifica quem o removeu nem qual mecanismo o corrigiu. O handoff relata reinício feito por Felipe na manhã de 24/09; isso não foi reexecutado.

## Atualização após o pico de 24/09, 22:01–22:07 BRT

Às 22:01, a API retornou **219 `running`**, sem próxima página. Desses, 214 haviam começado entre 20:03:31 e 20:05:16, e cinco eram recentes. Às 22:05, havia 221 no total, novamente sem próxima página: **os mesmos 214 IDs antigos permaneciam**, junto com sete execuções recentes. Assim, não se trata apenas da sobreposição normal de poucos segundos do consumidor SES vista antes das 20h.

Os registros antigos de Growth se distribuem assim:

| Workflow | Registros `running` do intervalo |
|---|---:|
| `ecK2wke9fKnO3mfy` — e-mail transacional | 184 |
| `54waQbYEjCHDLwgA` — WhatsApp transacional Aristo | 3 |
| `qBC4HJC4qKSLkBBf` — consumidor SES | 3 |
| `Ue4I5Fgc9lAk3n5O` — receptor Appmax | 1 |
| **Total Growth** | **191** |

Os outros 23 pertencem ao inventário excluído de CX. Foram somente contabilizados nos metadados gerais; não houve inspeção de conteúdo nem ação nessa frente. Nenhuma execução antiga identificada nesta amostra era do categorizador SharePoint; isso não exclui sua contribuição para carga no processo compartilhado.

Três amostras pequenas de Growth foram lidas às 22:07 com limite de 2 MiB por resposta, sem guardar o conteúdo bruto:

| Execução | Workflow | Início BRT | Bytes da resposta |
|---|---|---|---:|
| `1714410` | E-mail transacional | 20:03:31 | 40.746 |
| `1714932` | WhatsApp Aristo | 20:04:32 | 22.874 |
| `1714486` | SES | 20:03:33 | 14.369 |

Todas tinham `status=running`, `finished=false`, `stoppedAt=null`, `waitTill=null`, `runData` vazio e nenhum `lastNodeExecuted` ou erro persistido. Portanto, a API **não localiza um nó travado nem demonstra que o processo continua executando esses IDs**. A ausência de resultados intermediários também não prova ausência de envio: a configuração de retenção/progresso pode impedir sua persistência. Não houve retry, cancelamento, exclusão ou leitura de detalhes SharePoint/CX.

O estado corrente coexistia com a anomalia:

- API às 22:01: consultas em 0,20–1,33 s; `running` em 0,83 s. A repetição de `running` às 22:05 levou 4,19 s. Não há série contínua que caracterize a latência durante o pico.
- `waiting=0`; 60 erros retidos, sem paginação; amostra de 250 sucessos com próxima página. A página geral mais recente continha 245 sucessos e cinco erros. Isso não mede todos os estados `new`, cuja filtragem não é suportada pela instalação.
- SQL do banco de negócio: ping 0,22 s, saúde SES 0,15–0,17 s e agregado de envios 0,36 s. Essas respostas não medem o SQLite interno do n8n.
- SES às 22:01 e 22:05: `queue_visible=0`, `queue_inflight=0`, `queue_delayed=0`, com medições de fila recentes e poll bem-sucedido há menos de um segundo. O último erro registrado continuava sendo de 10:50 BRT.
- Busca limitada e apoiada no índice parcial de `result='pending'`: zero registros pendentes às 22:05. Isso não mede mensagens anteriores ao arquivo, redelivery ou efeitos ainda não conciliados.
- Às 22:08:43 BRT, a frente principal leu os endpoints oficiais sem credenciais: `/healthz` e `/healthz/readiness` devolveram HTTP 200/`ok` em 0,095/0,092 s; `/metrics` devolveu 404. É uma verificação de saúde naquele instante, não de uptime, ausência de restart/OOM ou histórico da janela. O 404 não identifica a configuração de métricas nem oferece telemetria substituta. [n8n — Monitoring](https://docs.n8n.io/hosting/logging-monitoring/monitoring/).

**Conclusão desse retrato:** não foi observada indisponibilidade geral nem backlog SES corrente, mas a recorrência dos registros sem conclusão está confirmada. Não há base para limpar os IDs nem pedir restart preventivo; primeiro preservar e correlacionar a evidência do host.

## O que se repete às 20h

Consultas em `shrigma_send_log`, Fish/Aristo, sem NPS, em 21–24/09:

| Dia | E-mail 19h | E-mail 20h | E-mail 21h | WhatsApp 19h / 20h / 21h |
|---|---:|---:|---:|---:|
| 21/09 | 206 | 449 | 206 | 89 / 94 / 93 |
| 22/09 | 210 | 1.026 | 258 | 63 / 81 / 113 |
| 23/09 | 199 | 906 | 227 | 73 / 75 / 90 |
| 24/09 | 168 | 934 | 206 | 74 / 80 / 71 |

O excesso de e-mails se concentra nas peças transacionais abaixo:

| Dia | `pedido-entregue` | `pedido-em_rota` | Total do lote | Janela BRT dos registros |
|---|---:|---:|---:|---|
| 21/09 | 146 | 63 | 209 | 20:03:29–20:10:56 |
| 22/09 | 563 | 239 | 802 | 20:03:31–20:11:39 |
| 23/09 | 456 | 243 | 699 | 20:03:33–20:11:35 |
| 24/09 | 181 | 542 | 723 | 20:03:28–20:09:59 |

As consultas não encontraram `erro` preenchido nessas faixas de 19h–21h em 21–23/09. Em 24/09, houve um erro de WhatsApp às 19h e nenhum erro de e-mail nas três horas; os demais 224 registros WhatsApp tinham `wamid`. Os registros mostram atividade, não atestam entrega final de todos os e-mails nem ausência de perda anterior à gravação. O mesmo vale para `wamid`: é comprovante de aceite, não de entrega final.

Em 24/09, 665 dos 723 registros do lote foram gravados entre 20:05 e 20:10. O primeiro e-mail do lote (20:03:28) antecede em três segundos o primeiro `running` antigo identificado (20:03:31). A coincidência temporal é forte; não estabelece qual evento bloqueou a conclusão nem permite conciliar efeitos de cada execução individual.

O workflow `ecK2wke9fKnO3mfy` recebe o transacional por webhook. Não foi encontrado nele um cron diário às 20h; o lote chega pela entrada. Ainda falta identificar, no sistema emissor, quem produz as atualizações em bloco. Não se deve atribuir isso à Shopify, transportadora ou serviço específico sem a evidência da origem.

A hipótese a testar é: lote de atualizações transacionais → aumento de execuções e eventos SES → contenção no processo/armazenamento → degradação e execuções persistidas sem conclusão. A coincidência de horário e o lote estão demonstrados; as setas de causalidade restantes não estão.

## Consumidor SES: capacidade e sobreposição

O workflow `qBC4HJC4qKSLkBBf` tem um único caminho de consumo, sem retorno para `ReceiveMessage` e sem laço de drenagem. A configuração lida em 24/09:

- Trigger efetivo a cada **5 segundos**, apesar do nome do nó dizer “A cada minuto”.
- Uma fila SQS no caminho de consumo; `MaxNumberOfMessages=10`, `WaitTimeSeconds=10`, `VisibilityTimeout=300`.
- Timeout HTTP de 25 segundos, sem retry automático no recebimento nem na remoção.
- Arquiva e exige confirmação do commit antes de remover a mensagem da fila.
- Um segundo trigger consulta o tamanho da fila uma vez por minuto.
- Não há caminho de DLQ no grafo. A política `RedrivePolicy`, a retenção da fila e eventuais consumidores externos não foram verificadas; ausência no workflow não prova ausência de DLQ na AWS.

Com fila vazia, o long polling de dez segundos explica sobreposição de duas ou três execuções curtas. O retrato de três `running` não é um vazamento por si só. Por hora, o agendamento atual gera 720 tentativas de consumo mais 60 medições de fila.

| Intervalo de consumo | Tentativas/h | Teto aritmético de mensagens/h | Teto/min |
|---|---:|---:|---:|
| 5 s, atual | 720 | 7.200 | 120 |
| 15 s | 240 | 2.400 | 40 |
| 30 s | 120 | 1.200 | 20 |

Esses tetos assumem dez mensagens em toda chamada e disponibilidade total do executor. São limites superiores, não garantias: a AWS pode devolver menos que o máximo e um e-mail pode produzir vários eventos. [AWS ReceiveMessage](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html).

Uma consulta agregada de `shrigma_email_event_ingest`, de 21 a 23/09, encontrou:

| Hora BRT | Registros de ingestão na hora | Maior minuto da hora |
|---|---:|---:|
| 23/09 19h | 7.184 | 130 |
| 23/09 20h | 6.300 | 250 |
| 23/09 21h | 7.200 | 130 |
| 23/09 22h | 7.135 | 130 |
| 22/09 20h | 2.991 | 238 |
| 21/09 20h | 2.688 | 292 |

Esses são eventos **já gravados** no horário de ingestão, não medição da taxa de chegada original da AWS, do backlog histórico nem da latência evento→arquivo. A concentração por minuto pode incluir trabalho admitido antes ou outros consumidores não inventariados; não se deve ler 292 registros/min como capacidade sustentável do trigger de 5 s. Mesmo assim, a demanda observada não demonstra a folga necessária para cortar a capacidade. A consulta levou 31,84 s; não foi repetido o scan amplo.

Na leitura posterior ao pico de 24/09, a consulta foi limitada aos **10 mil maiores IDs**, usando a chave primária e somente colunas de data/resultado. A amostra vai de 08:06 a 22:07 BRT e contém 742 eventos das 19h, 2.250 das 20h e 435 das 21h, todos `processed`. Entre 20:05 e 20:20, foram 1.788, sendo 610 em cada uma das duas primeiras faixas de cinco minutos e 568 na seguinte. A consulta levou 3,31 s. Não há índice geral em `received_at`; o índice de data existente é parcial para `pending`, motivo para evitar novo scan amplo. Os números desta leitura são agregados da amostra limitada por ID, não medição direta da chegada/idade da fila durante o pico.

**Não reduzir para 15/30 segundos nas condições verificadas.** A mudança reduz a capacidade máxima em 67%/83%, respectivamente, abaixo de horas com mais de 7 mil registros de ingestão. É necessário medir a idade da mensagem mais antiga durante o pico, considerar retries/redelivery e confirmar retenção/DLQ antes de redesenhar o consumidor. Medir somente e-mails enviados não o dimensiona. Uma melhoria futura deve reduzir execuções vazias preservando drenagem suficiente sob carga; não basta trocar o intervalo.

## Outro produtor de carga no mesmo n8n

A frente de inventário de credenciais desta retomada encontrou cinco execuções recentes de `KVZebbMZ0zcslZne`, categorização de arquivos SharePoint/GPT, iniciadas a cada 15 minutos entre 18:15 e 19:15 BRT. Cada execução durou aproximadamente 6,5–7,5 minutos e terminou com HTTP 429 por falta de cota, conforme o inventário de impacto OpenAI.

O agregado sanitizado preservado tem **83,95 MB de JSON compacto de `runData` por execução**; o export indentado completo tinha cerca de 168,31 MB. Os quatro maiores nós são separação de arquivos (21,68 MB), busca de filhos (20,70 MB em 41 rodadas), montagem do resultado (20,59 MB) e filtragem de arquivos (19,47 MB). Isso aponta para volume de dados intermediários de arquivos, não principalmente para a imagem enviada ao GPT.

Quatro execuções desse tamanho por hora representam cerca de **336 MB/h de representação JSON de resultados**, caso o padrão se mantenha. Esse cálculo **não é medida de escrita física no SQLite, tamanho de WAL, heap nem vazamento**: armazenamento, deduplicação de representação e retenção podem mudar esses valores. É um candidato adicional a pressão de memória/persistência, que deve entrar na correlação com o host. Não houve novo download de detalhes por esta investigação; os exports grandes já foram removidos pela frente que os coletou, após preservar o agregado seguro.

Esse workflow não foi alterado, desativado nem classificado como causa definitiva. A presença de um produtor pesado contínuo também impede atribuir todo o incidente exclusivamente ao lote transacional das 20h.

## Correções às conclusões do handoff anterior

1. **“Sem `EXECUTIONS_DATA_PRUNE`, não há limpeza” não é conclusão válida.** A documentação atual informa pruning habilitado por padrão. A configuração efetiva e a versão instalada precisam ser lidas. O pruning também exclui estados `new`, `running` e `waiting`; portanto, ligá-lo ou encurtar a retenção não limpa órfãs nesses estados. [n8n — Manage execution data](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data).
2. **Um `running` persistido não demonstra memória ocupada no processo atual.** Após um reinício, estado em disco e atividade em memória podem divergir. É preciso correlacionar PID/start time, logs e métricas.
3. **`Workflow did not finish, possible out-of-memory issue` não prova OOM.** Para afirmar OOM, buscar evento do runtime/contêiner, código de saída e evidência do sistema. A melhora após restart mostra mitigação; não identifica sozinha a causa.
4. **O relato de `SqliteWriteConnectionMutex` é compatível com contenção de escrita, mas não isola a causa.** Falta revalidar, na mesma janela, latência de disco, tamanho/WAL/checkpoint do SQLite, CPU/event loop, concorrência, reinícios e jobs de backup. Não foi lido diretamente o banco interno do n8n nesta rodada.
5. **Limite global de concorrência não é ajuste isolado de Growth.** No modo regular, o n8n não limita concorrência por padrão; excesso pode degradar o event loop. O limite global enfileira produção, não abrange todos os tipos de execução e também afeta CX. Exige coordenação de infraestrutura. [n8n — Control concurrency](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/control-concurrency).

## O que falta para fechar a causa

Pedir ao operador do Easypanel somente o retrato e os logs de **19:50–20:30 BRT (22:50–23:30 UTC)**, com segredos e payloads removidos:

- versão e imagem exatas do n8n; hora do último start, reinícios, exit code e marcação OOM;
- CPU, RSS/heap, event loop se disponível, disco livre, IOPS/latência e uso do volume;
- tipo de banco e configuração efetiva de concorrência, timeout, retenção e SQLite pool, sem valores de credenciais;
- tamanho do banco/WAL, checkpoints, lock timeouts; jobs agendados de backup/compactação às 20h;
- origem e taxa de recebimento dos webhooks do lote, em comparação com a taxa de conclusão;
- SES: entradas/saídas e idade da mensagem mais antiga, não apenas fila vazia antes/depois.

Com a recorrência de 24/09 documentada, começar pela janela curta **20:02–20:07 BRT (23:02–23:07 UTC de 24/09)** e procurar os IDs `1714410`, `1714932` e `1714486`. O conjunto mais útil é o log do serviço n8n junto dos eventos do contêiner nessa mesma janela: admissão/início/conclusão, mensagens de mutex/`SQLITE_BUSY`/timeout, perda de conexão e saída/reinício do processo. Um evento explícito `OOMKilled` junto do aumento de memória sustentaria OOM; somente exit 137, mensagem genérica de memória ou ausência de conclusão não basta. Bloqueios de escrita devem ser correlacionados com latência de disco/WAL e concorrência antes de atribuir causa ao SQLite. Se essa janela não contiver a transição, ampliar para 19:50–20:30. Felipe preferiu não consultar esses logs agora; a análise segue com essa limitação, sem atribuir causa nem executar mudança de infraestrutura.

Se houver degradação, preservar esse retrato antes do reinício que Felipe eventualmente executar. Não apagar execuções nem habilitar retenção agressiva antes de preservar a evidência. A resposta corrente do serviço não elimina o estado anômalo persistido; tampouco justifica, isoladamente, um reinício preventivo.

## Avaliação da migração para PostgreSQL

**Recomendação: preparar e ensaiar a migração; não publicar a troca de banco durante esta investigação.** Ela remove a dependência de SQLite para persistência, mas não resolve automaticamente excesso de paralelismo, código bloqueante, instabilidade externa ou falta de memória. O banco interno do n8n é distinto do PostgreSQL que já armazena os dados de negócio do Growth.

O caminho oficial atual é `export:entities` / `import:entities`, permitindo transferir entidades de SQLite para PostgreSQL. O destino deve estar vazio e histórico de execução fica fora do export por padrão. Primeiro confirmar que **a versão instalada** suporta esses comandos e suas opções. [n8n — Server CLI](https://docs.n8n.io/deploy/host-n8n/configure-n8n/use-the-command-line).

Plano de mudança para revisão pelo operador:

1. Fixar a imagem/versão atual. Não combinar troca de banco com upgrade, queue mode ou mudanças funcionais.
2. Preservar backup consistente do volume `.n8n`, configuração, chave de criptografia, dados binários e extensões. A cópia simples do SQLite em uso pode ser inconsistente; a chave atual é necessária para ler as credenciais. Nunca exportar segredos em claro para este repositório. [n8n — Back up and restore](https://docs.n8n.io/deploy/host-n8n/keep-n8n-running/backup-and-restore).
3. Ensaiar export/import em PostgreSQL dedicado e vazio, com mesma versão e chave. Isolar triggers/webhooks e saída de rede de produção no ensaio, para não gerar duplicidade de comunicações.
4. Definir explicitamente o tratamento das execuções em espera/ativas e do histórico. Não presumir que um export padrão preserva toda execução em andamento; validar na versão instalada.
5. Comparar identidades, credenciais criptografadas, versões/publicação dos workflows, projetos/usuários, webhooks e registros de espera. O responsável por CX valida sua própria frente; esta tarefa não executa testes de CX.
6. Preparar janela coordenada de corte, entrada represada/repetível, drain das execuções e ponto de rollback. Usar um único ambiente que possa enviar mensagens. Guardar o SQLite original intacto.
7. Cortar para `DB_TYPE=postgresdb` e conexão dedicada com credencial restrita e TLS conforme infraestrutura; dimensionar pool a partir de métricas. Não reaproveitar indiscriminadamente permissões do banco de negócio. [n8n — Database configuration](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/database).
8. Validar latência e efeito de Growth antes/durante/depois da janela de 20h, conciliar eventos sem reenviar em massa e verificar painel/credenciais. O rollback posterior a novas escritas exige reconciliação; voltar ao SQLite antigo às cegas pode reexecutar efeitos.

Adicionar Redis e workers é uma mudança posterior, se as métricas justificarem. Queue mode requer coordenação da chave entre processos e muda execução/armazenamento; a documentação não suporta uma instalação distribuída desse modo sobre SQLite. [n8n — Enable queue mode](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/enable-queue-mode).

## Evidências privadas e limites de coleta

Arquivos locais em `.private/runtime/`, fora do versionamento:

- `growth-n8n-incident-metadata-20260924.json`: quatro consultas de metadados às 19:23 BRT.
- `growth-n8n-incident-followup-20260924.json`: atualização às 19:27 BRT e limitações HTTP 400.
- `growth-n8n-incident-sql-20260924.json`: volumes horários, saúde SES e reservas antigas.
- `growth-n8n-incident-peak-20260924.json`: agregado por peça identificando o lote de entrega.
- `growth-ses-capacity-20260924.json`: taxas de ingestão registradas, sem conteúdo das mensagens.
- `growth-audit-20260924/openai-execution-size-safe.json`: tamanhos e metadados sanitizados de cinco execuções do categorizador; produção de JSON não equivale a bytes físicos no SQLite.
- `growth-audit-20260924/inventory-private.json`: inventário contemporâneo reutilizado, sem nova coleta em massa.
- `growth-audit-20260924/bl2/n8n-incident/current-snapshot.json`: metadados e agregados às 22:01, preservando os arquivos anteriores.
- `growth-audit-20260924/bl2/n8n-incident/followup-snapshot.json` e `followup-safe.json`: segunda leitura às 22:05 e comparação dos mesmos 214 IDs.
- `growth-audit-20260924/bl2/n8n-incident/cohort-safe.json`: agrupamento por workflow e limites temporais do conjunto antigo.
- `growth-audit-20260924/bl2/n8n-incident/ses-sample-safe.json`: agregado limitado aos 10 mil IDs mais recentes, sem corpos de eventos.
- `growth-audit-20260924/bl2/n8n-incident/small-details-safe.json`: somente status, tempos, tamanhos e ausência de resultados dos três exemplos Growth; nenhum detalhe bruto foi preservado.
- `growth-audit-20260924/bloco2-health-endpoints.json`: leituras oficiais de saúde/readiness da frente principal às 22:08:43 BRT.

Nenhum segredo, corpo de mensagem, e-mail, telefone ou pedido individual consta neste relatório. As consultas não medem perda silenciosa nem representam um teste de carga. Resultado atual: recorrência dos registros sem conclusão confirmada em 24/09, coincidente com o lote de entrega, com serviço respondendo antes e depois da janela; **causa-raiz e solução definitiva ainda pendentes da correlação com a evidência do host**.
