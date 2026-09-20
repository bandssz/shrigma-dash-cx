# Pedido específico: contrato de preparação e ativação

Este bloco prepara a troca de seis templates WhatsApp em quatro fluxos existentes. Código e testes não representam aprovação, instalação, ativação, envio ou entrega. Os templates atuais permanecem selecionados até a ativação transacional. Não há novo gatilho, destinatário, backfill ou alteração de cadência.

## Escopo fixo

| Runtime | ID | Nós que o gerador pode alterar |
|---|---|---|
| Caller Aristo | `54waQbYEjCHDLwgA` | `Roteia evento → peça`, `Monta componentes` |
| Caller Fish | `EfSf4rTJb3krbBV2` | `Roteia evento → peça`, `Monta componentes` |
| Motor WhatsApp | `xobYQ1VfScmUHVeV` | `Aplica fluxo publicado`, `Valida template UTILITY` |

Os registros SQL são `aristo:pedido-recebido`, `aristo:rastreio`, `fish:pedido-recebido` e `fish:rastreio`. Os alvos permitidos são as versões `aristocrata_pedido_pago_claro_v2`, `aristocrata_rastreio_claro_v2`, `aristocrata_rastreio_criado_claro_v2`, `fishermans_pedido_pago_claro_v2`, `fishermans_rastreio_claro_v2` e `fishermans_rastreio_criado_claro_v2`. IDs reais de templates, texto revisado e dados de pedidos permanecem nos artefatos operacionais privados.

A única mudança de conteúdo é o primeiro botão de URL, de conta genérica para a página do pedido exato. O host fixo aprovado é `oaristocrata.com` ou `fishermans.com.br`, conforme a marca; o caminho dinâmico vem do `statusPageUrl` do mesmo pedido Shopify. A relação com o pedido, domínio, cancelamento, teste e formato é validada antes da reserva. O token opaco da URL nunca deve aparecer em exemplos, commits ou relatórios públicos.

PIX, cobrança Appmax, fontes de confirmação de pagamento, guardas já existentes, deduplicação e resultado incerto são preservados. Pedido-pago continua exigindo o estado financeiro previsto. Botões diretos de transportadoras e etapas de outros canais não mudam.

## Interfaces e acesso

`whatsapp-order-status-integration.cjs` exporta:

- `buildContracts(proposals, catalog, flows)`: compila somente alvos APPROVED/UTILITY/pt_BR com conteúdo revisado igual e fonte/seletores publicados íntegros.
- `patchCaller(fresh, { expectedVersionId, brand })` e `patchMotor(fresh, { expectedVersionId, contracts })`: geradores puros, limitados aos nós acima e à versão fresca informada. Não publicam.
- `planStageSwitch(flows, contracts)`: snapshots completos `expected` e mudanças propostas `next`, com `activation_ready:false`.

`whatsapp-order-status-activation.cjs` exporta:

- `runtimeReceipt(role, expectedWorkflow, readback, checkedAt)`: exige workflow ativo, IDs/versões coerentes, conteúdo de `activeVersion`, igualdade dos nós/conexões/settings com o candidato e contrato igual nos dois nós do motor. O recibo contém digests e evidência do contrato, sem chave de acesso.
- `buildActivationRequest({ operationKey, proposals, catalog, flows, runtimeReceipts, catalogCheckedAt })`: prepara o pedido único e privado; remove exemplos do catálogo.
- `QUERY`: chamada SQL fixa abaixo. Não há transporte, endpoint HTTP novo ou SQL fornecido pelo browser neste módulo.

```sql
SELECT public.shrigma_wa_order_status_activate_v1($1::text,$2::jsonb) AS result
```

`$1` é a chave de publicação existente, resolvida apenas no servidor/operador autorizado. `$2` é o pedido JSON persistido antes da tentativa. Utilizar parâmetros nativos, por exemplo `queryReplacement` como array na conexão PostgreSQL existente. Nunca interpolar chave/JSON em SQL, criar proxy de SQL arbitrário ou devolver a chave ao frontend.

Os exports/readbacks vêm da API administrativa n8n já existente, no recurso `GET /api/v1/workflows/{id}`, com a credencial administrativa existente. Origem, autenticação e exports completos permanecem privados. Os snapshots preservados dos três workflows incluem `activeVersion` com `nodes`, `connections`, `versionId` e `workflowId`, além de `activeVersionId`; isso comprova a forma disponível naquele checkpoint, não o estado atual. Na publicação, reler os três workflows e verificar novamente. Se o recurso passar a omitir esse objeto, bloquear a ativação até obter uma leitura autenticada da versão ativa por endpoint confirmado; não substituir a prova por `active:true` ou somente pelo ID de versão. Não há endpoint alternativo presumido neste contrato.

A leitura/submissão de templates continua na API existente de templates, com autenticação, revisão, expected_version e idempotência já instaladas. Esta fatia não cria, submete nem envia templates; requer aprovação real atual antes de compilar e ativar.

## Migração e transação

`whatsapp-order-status-cas.sql` contém `BEGIN` e `COMMIT` explícitos envolvendo criação da função e `REVOKE ... FROM PUBLIC`. Executar o arquivo inteiro na mesma conexão/transação. Um executor que separa comandos em requisições com commit automático ou conexões distintas não é compatível: deve ser ajustado antes da instalação. Assim a função nova não fica publicamente executável entre CREATE e REVOKE. A migração instala somente código; não invoca a ativação. `SECURITY INVOKER` não concede privilégios adicionais. Grants específicos exigem revisão separada.

A função reaproveita `shrigma_template_auth_v2` e exige capacidade `submit`. Aceita somente `idempotency_key`, `catalog_checked_at`, `catalog`, `contracts`, `updates` e `runtime`, com limite de 2 MiB. O escopo é exatamente quatro registros, seis contratos, doze entradas de catálogo fonte/alvo e três comprovantes ativos. Catálogo e readbacks precisam de leitura bem-sucedida nos 15 minutos anteriores, com tolerância futura de 30 segundos.

O bloqueio da operação usa o mesmo namespace de idempotência da API de jornadas. Um recibo existente exige mesmo ator e JSON integral; retorna o resultado original antes de verificar a idade das provas. Chave igual com conteúdo/ator diferente retorna conflito. As quatro linhas são bloqueadas em ordem estável e comparadas integralmente a `expected`, inclusive campos alheios aos estágios e metadados de alteração. Draft deve ser igual ao publicado, versões iguais e runtime pronto.

O SQL reconstrói `next` a partir das linhas bloqueadas. Permite apenas identidade/categoria/assinatura dos seis templates e uma revisão adicional por fluxo; compara a reconstrução integral ao pedido. Preserva seletor do caller, enabled, esperas, demais etapas, marca, gatilho e histórico. Fonte e alvo devem ter IDs/nomes/status/categoria/idioma/conteúdo coerentes; somente a primeira URL pode diferir. O contrato compilado no motor deve ser igual ao pedido.

Os seis registros de catálogo são atualizados dentro de uma subtransação, para que o validador existente enxergue os novos templates. Uma rejeição do validador desfaz esses registros antes da resposta 422. Depois de validar os quatro fluxos, atualiza definições, grava quatro revisões, quatro auditorias e um recibo. Erro SQL posterior aborta toda a chamada. Reservas e transportes não são modificados.

O banco verifica a consistência do catálogo e dos comprovantes fornecidos pelo operador autenticado; não autentica diretamente respostas externas Meta/n8n. A guarda do motor continua verificando status/conteúdo na Meta antes da reserva, protegendo contra mudança posterior ao checkpoint. Isso não é uma transação distribuída com Shopify/Meta.

## Ordem de implantação

1. Resolver execuções pendentes e obter novas leituras bem-sucedidas. Timeout de leitura significa ausência de leitura nova, não aprovação, rejeição ou objeto inexistente.
2. Conferir seis aprovações e conteúdo exato; reler workflows, quatro linhas e dependências SQL. Validar schema/constraints/funções reais, inclusive assinatura, antes de instalar. Snapshots antigos e testes locais não substituem essa inspeção.
3. Instalar somente a função CAS como transação única. Conferir definição e ACL. Não chamar a função de rollout antiga nem modificar fila de outra revisão.
4. Preparar/publicar os callers sobre exports frescos e reler conteúdo ativo. Os templates antigos continuam selecionados. Na sequência, preparar/publicar o motor aprovado e conferir seu conteúdo ativo. Não disparar mensagem de teste.
5. Atualizar catálogo e comprovantes; persistir pedido exato, chave de operação e estado da tentativa em manifesto privado. Revisar o diff dos quatro registros. Executar uma vez a chamada parametrizada.
6. Após 200, reler recibo, quatro versões e seis seletores. Conferir PIX, transportadoras, e-mails, enabled, cadência e guardas. Só registrar ativo após essa prova.
7. Observar evento natural. Aceite de envio, entrega, formação do botão e experiência do cliente são estados distintos.

Preparação parcial dos runtimes permanece compatível com seleção antiga. Uma execução anterior sem a fonte adicional, ao alcançar seleção nova, falha antes da reserva; não recebe fallback para conta genérica. Isso permite preparar dados/guardas primeiro e selecionar novos templates por último.

## Falhas, incerteza e reversão

- Falha/timeout ao publicar workflow: interromper a sequência e reler execução e versão ativa antes de repetir. Não restaurar um export inteiro antigo sobre mudanças alheias.
- Conflito ou 422 confirmado na ativação: a tentativa não alterou os registros. Revisar a causa, refazer leituras e revisar novo plano antes de outra operação.
- Timeout/desconexão após enviar a ativação: manter chave e payload congelados; conferir execução e recibo. Recibo ausente enquanto a execução está pendente não prova rollback. Não trocar chave para contornar incerteza. Recuperação utiliza o mesmo ator e JSON.
- Reversão após ativação confirmada: selecionar a configuração anterior em nova revisão monotônica sob CAS, conferir seleção e só então avaliar retirar código preparado. Nunca reduzir versão, apagar reserva/recibo/histórico ou mudar ref para repetir envio incerto. A função desta fatia é específica para ida v1→v2; não oferece rollback genérico automático.

## Verificação local e limites

Os testes usam somente dados sintéticos e PGlite. Cobrem snapshots completos, estado pausado preservado, recibo idempotente, autorização, escopo, drift de aprovação/conteúdo, alteração indevida de campos, código ativo divergente, validação existente, falha tardia com rollback completo e falha da migração durante REVOKE. A suíte conjunta também cobre rastreio, pagamento/cancelamento e retenção de reservas incertas.

O validador SQL é o arquivo real do repositório. A assinatura do fixture representa apenas o formato observado TEXT/BODY/URL; produção reaproveita a função instalada e exige conferência fresca. Não se alegam aprovação real, instalação, corrida simultânea entre sessões de produção ou entrega a partir dessas provas locais. Artefatos operacionais, payloads, exports, copy revisada, chaves e dados de clientes permanecem privados.

## Transporte parametrizado na utility existente

`sql-utility-parameters-patch.cjs` prepara uma única alteração em `ygVyBPjJqGqt2V5E`: o campo `SQL.parameters.options.queryReplacement`. A consulta continua sendo `={{ $json.body.q }}` e a rota Webhook POST → autenticação → SQL/401 é preservada integralmente, assim como credencial e conexão. O gerador exige versão fresca e a forma conhecida dos nós/conexões; não publica.

O campo opcional `body.args` deve ser um array de até 128 valores escalares (string, número finito, boolean ou null). JSON do pedido deve ser serializado como string em um parâmetro. Campo ausente resulta em `[]`, preservando consultas sem parâmetros; forma inválida falha antes do PostgreSQL. A expressão não concatena valores ao SQL. O patch continua exigindo publicação/releitura do runtime e roundtrip literal nativo comprovado antes do CAS; teste de VM/PGlite não substitui essa prova.

## Executor privado e quiescência

O executor operacional permanece privado, separado dos módulos públicos. `prepare` pode retomar somente preparação nunca tentada, ainda sem payload congelado, mantendo a mesma UUID. Uma atualização explícita de preparação (`refresh`) só é admitida antes de qualquer tentativa; arquiva o payload anterior e mantém a UUID. Se a leitura nova falhar, o payload anterior permanece preservado. Estado attempted, incerto ou confirmado não admite essas operações nem outro POST CAS.

Antes de congelar o pedido e antes do único CAS, a leitura de execuções percorre integralmente `GET /api/v1/executions` por workflow, com `limit=250` e sem filtro de status, até não existir `nextCursor`. Cursor deve ser codificado na query. Não se corta por idade ou primeira página. Qualquer paginação incompleta, erro, limite de páginas, identidade divergente, estado desconhecido/pendente ou terminal sem término comprovado bloqueia. Um estado desconhecido antigo não é dispensado por ser histórico.

A reconciliação consulta o recibo por chave e ator com agregação JSON para produzir uma linha mesmo quando não há recibo. Confere também o payload integral congelado. Ausência de recibo não torna uma execução pendente revertida nem libera nova tentativa. Commit confirmado seguido de timeout de leitura permanece confirmado, com readback pendente. A configuração só recebe a marca de verificada após conferir quatro registros, seis seletores e os três runtimes ativos novamente.


A expressão opcional evita acesso a `Object.prototype`, que não é compatível com o motor restrito. Como o corpo chega por JSON, `body.args === undefined` representa campo ausente; null ou outro tipo explícito continua inválido. O gerador reconhece exclusivamente a expressão anterior exata para permitir essa correção em um campo. Testes reproduzem a restrição, mas publicação ainda requer smoke real. Referências: [motor de expressões](https://github.com/n8n-io/n8n/blob/master/packages/workflow/src/expression.ts) e [parâmetros PostgreSQL](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/Postgres/v2/actions/database/executeQuery.operation.ts).

O mesmo nó interpreta delimitadores de expressão encontrados dentro do texto SQL, inclusive dentro de uma string SQL. A migração monta o marcador de URL com caracteres para que a fonte transportada não seja reinterpretada. Conferir o corpo completo da função após instalar é obrigatório; sucesso do nó sem essa comparação não comprova a instalação correta.
