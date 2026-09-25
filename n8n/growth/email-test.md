# CRM05 — teste de email para o próprio gestor

O candidato adiciona três ações no endpoint de templates do Growth e um cliente independente `GETest`. Nenhum teste automatizado realiza HTTP de email. A instalação e qualquer envio real dependem da integração do botão de confirmação no painel; este patch não publica workflow, instala SQL ou envia mensagens por conta própria.

## Contrato do painel

As três ações exigem `Authorization: Bearer <acesso atual de gestor Growth>`. Chave em URL/corpo e acesso legado de templates não autorizam estas ações. O cliente captura o acesso no início da ação e não o persiste. O envelope de resposta tem `contract: "crm_email_test_v1"`.

| Ação | Método | Campos além de `acao` |
| --- | --- | --- |
| `email_teste_previa` | GET | `draft_id`, `expected_version` |
| `email_teste` | POST | `draft_id`, `expected_version` numérico, `idempotency_key` UUIDv4, `confirm: "enviar_teste"` |
| `email_teste_operacao` | GET | `idempotency_key` UUIDv4 |

Campos adicionais são recusados. O servidor fixa `felipebandeira@oaristocrata.com`; não aceita destinatário, lista, CC, BCC, conteúdo ou remetente escolhidos pela requisição.

```js
const testClient = GETest.create({
  endpoint: templateEndpoint,
  key: () => currentManagerKey,
  storage: localStorage,
  locks: navigator.locks,
  crypto,
  fetch,
});
const preview = await testClient.preview({draft_id, expected_version});
// Somente depois da confirmação explícita apresentada na UI:
const result = await testClient.run({draft_id, expected_version, confirm: 'enviar_teste'});
// Consulta somente leitura, inclusive depois de resposta perdida/refresh:
const receipt = await testClient.reconcile(result.operation_id);
const journal = testClient.inspect();
```

O retorno da prévia tem `eligible` e `code`. Quando elegível, inclui `recipient`, `brand`, `draft_id`, `version`, `template_id`, `subject` (expressão enviada), `rendered_subject` (fictício), `from_email`, `reply_to`, `body_html`, `data`, `variables`, `differences`. A UI deve exibir o destinatário literal, remetente, reply-to, versão, assunto renderizado e diferenças antes de confirmar. O HTML deve usar a prévia isolada já existente; não executar HTML recebido na página principal.

`run` e `reconcile` retornam `{phase, operation_id, operation}`. `phase` é `confirmed`, `rejected` ou `unknown`; erro de rede/identidade/journal lança erro e conserva a tentativa. `confirmed` significa recibo HTTP ou evento SES conhecido, e **não significa necessariamente entrega**. A UI deve ler campos distintos:

- `operation.http_accepted`: somente resposta HTTP 200 com `{data: true}` registrada no backend.
- `operation.ses.delivery`: somente evento de entrega conciliado pelo dispatch e marcado como teste.
- `operation.ses.bounce`, `complaint`, `reject`, `rendering_failure`, `send`, `delivery_delay`: eventos separados; não são entrega.

O recibo não contém chave, claim token, HMAC do destinatário ou HTML. `state` pode ser `claimed`, `accepted`, `outcome_unknown` ou `rejected`; a consulta de UUID inexistente retorna `missing` com identidade do gestor. Reutilizar UUID com outro payload/gestor retorna 409. Nem `missing` após uma tentativa nem `unknown` autorizam reenvio.

Erros usuais de elegibilidade: `manager_required`, `draft_unavailable`, `version_conflict`, `published_validated_version_required`, `published_identity_ambiguous`, `published_content_mismatch`, `email_envelope_required`, `recipient_unavailable`, `recipient_disabled`, `recipient_opted_out`, `version_already_attempted`, `unsupported_template_expression`, `unsupported_test_variable`, `unsupported_variable_context`. A UI deve mostrar o motivo e permitir consultar a tentativa existente. Não deve criar uma nova identidade como recuperação de resultado incerto.

## Reserva e conteúdo

O SQL exige versão atual, salva, publicada e com evento de validação `ok` da mesma versão. A submissão Listmonk aprovada deve ser única e seu template nativo `tx` deve pertencer ao draft/marca. Assunto e corpo nativos devem coincidir com os componentes persistidos; o Code node também os compara ao renderer GEC de CRM04, inclusive preheader. A reserva repete essas verificações sob locks e vincula UUID, gestor, payload, versão, template nativo e hash do snapshot.

A reserva SQL do dispatch é durável **antes** do HTTP. A restrição única por draft/versão e os locks de operação/versão impedem que replay ou identidade nova obtenham um segundo transporte daquela versão. Um erro antes da reserva pode produzir uma recusa durável sem dispatch; a mesma identidade conserva essa recusa. Uma nova ação explícita após corrigir a causa pode usar identidade nova. Depois de reserva, não há retry automático nem manual no cliente, no workflow ou no SQL.

O journal local `shrigma_crm_email_tests_v1` grava a identidade antes do POST, usa Web Locks entre abas da mesma origem e recusa operar sem storage/locks válidos. Após o POST, inclusive resposta perdida, a decisão vem de GET com identidade, gestor, payload e versão exatos. Não há botão/API de limpar tentativa. O servidor continua garantindo envio único mesmo se outro navegador não tiver o journal local.

O prefixo é `✅ FINAL — `, aplicado uma única vez. A única diferença de conteúdo permitida, além do prefixo, é preencher expressões simples `.Tx.Data.<campo>` com dados fictícios explícitos: `first_name`, `name`, `nome` → Felipe; `brand`, `brand_name` → nome da marca; `store_url`, `shop_url` → domínio padrão da marca. Campos desconhecidos, lógica Go, campos de Subscriber e variáveis em atributos HTML/script/style são recusados. Esses dados são passados ao renderizador nativo; não há substituição por dados de cliente real.

O envio usa o mesmo ID nativo criado pela publicação versionada do painel. A API transacional do Listmonk 6.1 não aceita um body HTML direto: `TxMessage.Body` é excluído de JSON e `/api/tx` usa o template compilado por ID. Create/update nativos atualizam o cache antes de retornar. A comparação exata na reserva **não congela** o conteúdo contra uma edição direta concorrente no Listmonk depois do commit e antes do HTTP. Não foi introduzido clone, trigger global ou bloqueio de edição nativa. Evitar edição direta desse ID durante o teste; se esse requisito mudar, é necessária uma política específica de imutabilidade.

## Opt-out e métricas

`/api/tx` não aplica automaticamente o opt-out de campanhas; por isso o SQL exige exatamente um cadastro global do email literal, com status `enabled`, e recusa qualquer vínculo `unsubscribed` da marca. Para esta recusa, IDs base 16/17 e tags explícitas `aristo`/`aristocrata`/`fish`/`fishermans` continuam valendo inclusive em lista aposentada ou cross. A ausência de vínculo não cadastra ninguém nem representa consentimento genérico: foi autorizada especificamente para o teste do próprio Felipe. Opt-out exclusivo de outra marca não é convertido em autorização ou cadastro.

A guarda é verificada ao reservar, após aguardar locks de cadastro/vínculos existentes. Como qualquer fila de email, alterações de opt-out posteriores à reserva não conseguem retirar uma mensagem já aceita pelo transportador. O patch não implementa inscrição, confirmação, atualização de lista ou limpeza de opt-out.

O dispatch usa `is_test=true`, `flow=crm-test`, `piece=template`, `X-SES-CONFIGURATION-SET` da marca e `X-SES-MESSAGE-TAGS` com `crm_dispatch_id=<UUID>, crm_test=true`. Não grava sendlog promocional. Somente status SES com `is_test=true`, `reconciliation_status=matched` e dispatch exato entram no recibo. Falhas/timeouts de HTTP são conservadoramente `outcome_unknown`, nunca motivo para reenviar.

## Instalação e verificação

1. Aplicar a migração SQL uma única vez no banco de negócio Listmonk, após verificar nomes livres e dependências existentes. Ela cria apenas tabela/funções `crm_email_test_*`; não modifica tabelas de CX, assinantes, listas ou templates. O SQL usa transação e `lock_timeout=3s`; falha deve interromper a instalação.
2. Conferir CI PostgreSQL real `CRM email test isolation` antes de publicar. Ele usa banco vazio, sintético e local no serviço efêmero, com duas sessões disputando reserva/opt-out/conteúdo. Os testes PGlite locais não substituem essa prova.
3. Exportar workflow fresco. `patchWorkflow(fresh, {expectedVersionId: fresh.versionId})` exige os anchors conhecidos e cria candidato local; não chama n8n. Somente `Autenticação entrada`, `Prepara` e `Etapa` existentes são estendidos, além dos nós novos do teste. Credenciais existentes são referências, sem segredo embutido. Confirmar nenhum outro nó/conexão/configuração mudou.
4. Preservar retenção desativada (`saveDataErrorExecution`/`saveDataSuccessExecution=none`, `saveManualExecutions=false`, `saveExecutionProgress=false`). O export verificado já tinha esses campos; a função de patch não altera settings. Não persistir payload de claim com token ou headers de autenticação em novos logs.
5. Publicar em sequência coordenada com o root, conferir readback do workflow publicado e rotas de prévia/consulta com gestor. Nenhuma prova automatizada usa o endpoint transacional real. Primeiro envio real somente pela UI, após prévia e confirmação explícita para o destinatário literal.

Rollback desabilita a nova capacidade/rota conservando a tabela de operações e dispatches. Nunca apagar tentativas para permitir reenvio. Não aplicar downgrade de SQL se existir operação; o histórico continua necessário para conciliação.

Fontes verificadas: [API transacional](https://listmonk.app/docs/apis/transactional/), [tx.go v6.1.0](https://github.com/knadh/listmonk/blob/v6.1.0/cmd/tx.go), [mensagens v6.1.0](https://github.com/knadh/listmonk/blob/v6.1.0/models/messages.go), [templates v6.1.0](https://github.com/knadh/listmonk/blob/v6.1.0/cmd/templates.go), [cache manager v6.1.0](https://github.com/knadh/listmonk/blob/v6.1.0/internal/manager/manager.go).
