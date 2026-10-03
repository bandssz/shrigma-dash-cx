# Recuperação segura de tentativas pendentes de campanha (DESLIGADA)

Data: 2026-10-03. Branch: `claude/crm-pending-recovery-20261003` (base a19555c, PR #218).
Estado: **proposta, tudo desligado**. O SQL foi aplicado apenas em bancos de teste
(PGlite e um cluster PostgreSQL 16.15 descartável). Nada foi executado em produção.

## Problema

Uma tentativa de `agendar`/`cancelar` pode ficar presa em `pending` (worker
morreu entre o claim e o provider) ou sem registro (o POST se perdeu antes do
claim). Hoje o painel trava o diário e manda pedir conciliação, porque **tempo
decorrido e 404 não provam ausência**: um POST ou efeito atrasado ainda pode
chegar com a mesma chave.

A prova proposta é outra: uma **lápide terminal gravada sob o mesmo lock** que o
claim e o provider usam, mais uma **cerca (fencing)** no recibo: depois da lápide,
nenhum efeito com aquela chave consegue confirmar.

## Contrato da rota

`POST <caminho atual de campanhas>` (mesma URL; nenhuma rota nova), corpo JSON exato:

```json
{"k":"<chave de escrita>","acao":"campanha_operacao_abandonar","brand":"fish|aristo",
 "idempotency_key":"<chave da tentativa original>","operation_action":"agendar|cancelar",
 "confirm":"abandonar"}
```

- Ator vem da chave (`shrigma_crm_campaign_auth_v1`), nunca do corpo. Capability: `submit`.
- Mesmo ator + mesma chave + mesma marca + mesma ação da tentativa original.
- Repetir é seguro (idempotente): devolve a mesma lápide. Timeout/502 → repetir com a mesma chave.
- Sucesso `200`: `{policy:"crm-campaign-abandon-v1", abandoned, created, operation:{id, operation_key, brand, action, state, providerId, response, abandoned_at, created_at, updated_at}}` (sem token de lease).
  - `abandoned:true` → lápide (nova ou já existente).
  - `abandoned:false` → a operação já era final (`succeeded`, `rejected`, `outcome_unknown`): devolvida como está. O painel segue pela consulta normal.
- Recusas (nada gravado):

| Código SQL | HTTP | Quando |
|---|---|---|
| `ABANDON_LEASE_ACTIVE` | 409 | `pending` ainda no prazo |
| `ABANDON_LEASE_UNKNOWN` | 409 | `pending` sem lease (criada antes do gate) |
| `ABANDON_IDENTITY_MISMATCH` | 409 | marca/ação diferentes, ou a chave é de outro ator |
| `ABANDON_ACTION_UNSUPPORTED` | 422 | salvar (CREATE nativo), validar, recuperar |
| `ABANDON_DISABLED` | 503 | gate SQL desligado |
| `CRM_CAMPAIGN_GATEWAY_FORBIDDEN` / `_UNAUTHORIZED` | 403 / 401 | sem `submit` / chave inválida |
| lock timeout `55P03` | 409 `OPERATION_BUSY` | efeito concluindo agora; consultar |

## Estados

```
(sem registro) --abandonar--> rejected + abandoned_at   [request_hash sentinela]
pending (lease vencido) --abandonar--> rejected + abandoned_at
pending (lease válido) --abandonar--> recusa ABANDON_LEASE_ACTIVE
pending (sem lease) --abandonar--> recusa ABANDON_LEASE_UNKNOWN
succeeded | rejected | outcome_unknown --abandonar--> devolvido sem mudança
```

A lápide usa o estado existente `rejected` (sem novo valor no CHECK) com
`response.body.error = "OPERATION_ABANDONED"` e `abandoned_at` preenchido. O
painel atual já trata `rejected` sem `provider_id` como final e destrava.

## Lock e fencing

- **Mesmo advisory lock do claim**: `pg_advisory_xact_lock(hashtextextended('campaign-operation:'||[actor,key],0))`. Um claim atrasado espera a lápide e a encontra.
- **Mesmo `FOR UPDATE` da linha** que `shrigma_campaign_provider` segura do início ao fim de agendar/cancelar. Um efeito em andamento termina antes da leitura da lápide (e então ela vê `succeeded` e não abandona).
- **POST atrasado, chave sem registro**: a lápide tem `request_hash` sentinela (`sha256('crm-campaign-abandon-v1:'||[actor,key])`), que nenhum pedido real produz → o serviço responde `409 IDEMPOTENCY_CONFLICT` antes de qualquer efeito.
- **POST atrasado, pending abandonado**: o hash é o original → o serviço devolve o recibo gravado (`409 OPERATION_ABANDONED`), sem efeito.
- **Worker antigo ainda vivo**: provider exige `op.state='pending'` sob `FOR UPDATE` → `CAMPAIGN_OPERATION_INVALID`; `finish` recusa (`CAMPAIGN_STORE_FINALIZED`); gateway recusa efeitos de operação não pendente.
- **Cerca no recibo** (gatilho `shrigma_campaign_operation_fence`): a transição `pending→succeeded` com lease vencido levanta `OPERATION_LEASE_EXPIRED`. Como agendar/cancelar gravam status da campanha e recibo na mesma transação (atomic receipt), o status também é desfeito. Depois do prazo, nenhuma tentativa confirma efeito, com ou sem lápide.
- A lápide é imutável (`OPERATION_ABANDONED` em qualquer UPDATE) e só nasce pela função (`shrigma.campaign_abandon` de transação + checagem de lease vencido no gatilho).
- O chamador nunca escolhe o lease: o gatilho zera `lease_expires_at` no INSERT e só o emite para `agendar`/`cancelar` novos com o gate ligado.

Por que só agendar/cancelar: são os únicos com efeito SQL atômico (o recibo
`succeeded` nasce na mesma transação do efeito). `pending` nesses dois implica
"nenhum efeito confirmado".

## O que NÃO cobre (continua em conciliação própria)

- **CREATE de rascunho nativo (`salvar` sem id)**: o efeito é HTTP no Listmonk; um rascunho pode existir sem recibo. Nunca liberado por TTL. Segue `campanha_recuperar` / conciliação técnica.
- **salvar com id / validar**: o recibo não é atômico com o efeito (provider grava, `finish` depois). Uma lápide entre os dois mentiria. Recusado.
- **`outcome_unknown`**: estado final; segue a liberação por versão já existente (`releaseUnapplied`, política `crm-campaign-absence-v1`).
- **`pending` sem lease** (anterior ao gate ou do caminho n8n legado com o gate desligado): recusado; conciliação.
- **Mídia** (`/media`): fora do escopo.

## Flags (todas `false` por padrão)

1. SQL: `shrigma_campaign_pending_recovery_config.enabled` (nasce `false`, `lease_seconds=900`, 300–3600). Desligado: nenhum lease emitido, cerca inerte (só age com lease), função de encerrar responde `ABANDON_DISABLED`.
2. Serviço: `CRM_CAMPAIGN_ABANDON_ENABLED` (`''|true|false`; outro valor aborta a inicialização). Desligado: a ação não existe; o corpo cai em `parse()` e recebe exatamente a resposta de antes (`422 REQUEST_FIELD_INVALID`; sem `operation_action`, `400 ACTION_INVALID`). `/healthz` não mudou.
3. Painel: `capabilities.campaigns.abandon===true` **e** `abandon_policy==="crm-campaign-abandon-v1"` **e** `operation===true`. Nenhum servidor anuncia isso hoje. `GCA.createClient` expõe `canAbandon()`/`abandon('abandonar')`, sem UI.

## SQL proposto (arquivos, não executados fora de testes)

- `n8n/growth/campaign-pending-recovery.sql` — colunas `lease_expires_at`/`abandoned_at` + CHECK, tabela de configuração, gatilho de cerca, `public.shrigma_campaign_abandon(jsonb)` (SECURITY INVOKER, `REVOKE ... FROM PUBLIC`). Idempotente, em transação, aborta com `PENDING_RECOVERY_*_DRIFT` se o provider não tiver os recibos atômicos ou o claim não usar o advisory lock. **Não altera** o corpo de `shrigma_campaign_store/provider/recovery` (md5 `b77d960a…`, `fe3a35e7…`, `1e2c0a2b…` conferidos antes/depois nos testes) nem `shrigma_crm_campaign_effect_v1`.
- `n8n/growth/crm-campaign-abandon-gateway.sql` — `public.shrigma_crm_campaign_abandon_v1(text,jsonb)` SECURITY DEFINER; `crm_campaign_api` recebe só EXECUTE nele. Login restrito continua sem tabela e sem a função interna (provado).

## Sequência de instalação (para o Codex)

1. Mesclar esta PR com tudo desligado (código Node inerte; SQL só arquivo).
2. Janela sem agendar/cancelar em voo (consultar `pending` antes). Backup lógico de `shrigma_campaign_operation`.
3. Como `postgres`: aplicar `campaign-pending-recovery.sql`; depois `crm-campaign-abandon-gateway.sql`. Conferir: colunas novas `NULL` em todas as linhas; `enabled=false`; md5 dos três corpos inalterados.
4. Rodar no CI (PG 17.10) `tests/claude-pending-recovery-pg16-postgres.cjs` com `CRM_PENDING_RECOVERY_TEST_ISOLATED=1` e banco descartável.
5. Ligar o gate SQL (`UPDATE ... SET enabled=true`). Só a partir daqui novos claims de agendar/cancelar recebem lease. Observar 1 ciclo (efeitos normais devem confirmar bem antes de 900 s; o limite HTTP é 85 s).
6. Publicar o serviço com `CRM_CAMPAIGN_ABANDON_ENABLED=true` (nova imagem; `*.cjs` já é copiado pelo Dockerfile).
7. Só então anunciar `abandon:true` + `abandon_policy` na capability do painel e, em PR própria, criar o botão (recompilar o bundle).

Reverter: desligar o anúncio → `CRM_CAMPAIGN_ABANDON_ENABLED=false` → `enabled=false`. Lápides e colunas ficam (são histórico); remover o gatilho só depois de `enabled=false`.

## Provas

- `tests/claude-pending-recovery.test.cjs` (5): rota OFF idêntica, rota ON estrita, mapeamento do executor, cliente com/sem capability.
- `tests/claude-pending-recovery-postgres.cjs` (PGlite, QA_PG=1): gate off sem mudança (agendar/cancelar pelo serviço), lápide sem registro + POST atrasado `IDEMPOTENCY_CONFLICT`, lease válido recusa, cerca `OPERATION_LEASE_EXPIRED` desfaz o status, lápide de pending vencido + efeito/replay tardios recusados, cancelar idem, efeito que venceu devolve `succeeded`, identidade (marca/ação/ator), CREATE/validar/legado nunca por TTL, guardas diretas, desligar de novo.
- `tests/claude-pending-recovery-pg16-postgres.cjs` (PostgreSQL nativo, **duas sessões**): corrida lápide × claim atrasado (claim bloqueado no advisory lock, conflito, zero efeito); corrida lápide × efeito tardio de agendar e de cancelar (provider bloqueado no FOR UPDATE, recusado); efeito em andamento × lápide (espera, lease vence durante a espera, vê `succeeded`); lease válido recusa; duplo encerramento concorrente → um registro; HTTP com login restrito (marca/ação/ator/capability errados, CREATE recusado, gate OFF igual a antes); sessão com funções em cache antes do `ADD COLUMN` continua funcionando. **Rodado em PostgreSQL 16.15** (porta 55434, cluster descartável); o CI dos vizinhos usa **17.10** — ainda não rodado em 17.

## Observações

- Com o gate ligado, um efeito que só chega depois do prazo vira `OPERATION_LEASE_EXPIRED`; o adaptador JS (`campaign-provider.js`, dentro do bundle do runtime) não conhece o código e o serviço grava `outcome_unknown`. Seguro (nada aplicado), mas a mensagem fica "incerto". Mapear o código exige mexer no bundle — PR separada.
- O recibo atômico compara `send_at` em milissegundos. No PG nativo, um `send_at` com microssegundos (gravado fora do painel) faz agendar/cancelar recusarem com `CAMPAIGN_RECEIPT_MISMATCH` (sem efeito). O painel grava no máximo milissegundos. Visto só no fixture nativo; não é defeito desta PR.
- `crm-campaign-gateway-role.sql` continua pinando os mesmos md5; esta migração não o invalida.
