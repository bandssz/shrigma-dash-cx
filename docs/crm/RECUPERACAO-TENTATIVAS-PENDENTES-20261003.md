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

- `n8n/growth/campaign-pending-recovery.sql` — colunas `lease_expires_at`/`abandoned_at` + CHECK, tabela de configuração, gatilho de cerca, `public.shrigma_campaign_abandon(jsonb)` (SECURITY INVOKER, `REVOKE ... FROM PUBLIC`). Uma transação; **recusa qualquer desvio antes de qualquer DDL**:
  - **Atestação exata das dependências** (comentário no corpo não conta como prova): `shrigma_campaign_store/provider/recovery` precisam bater em md5 do corpo (`b77d960a…`, `fe3a35e7…`, `1e2c0a2b…`, os mesmos pins de `crm-campaign-gateway-role.sql`), dono `postgres`, SECURITY INVOKER, VOLATILE, plpgsql, retorno, `proconfig` (`search_path=pg_catalog, public` + `lock_timeout=3s`) e ACL (só o dono com EXECUTE). Se o gateway já estiver instalado, `shrigma_crm_campaign_auth_v1`/`effect_v1` também (md5 `e2b117ec…`/`e4d3e314…`, SECURITY DEFINER, ACL dono + `crm_campaign_api`). Falha: `PENDING_RECOVERY_DEPENDENCY_DRIFT <assinatura>` ou `_MISSING`.
  - **Objetos próprios**: ou nenhum existe (instala) ou os sete existem exatamente como o arquivo cria (reinstalação = no-op: nada recriado, gate intocado). Gatilho/função/coluna/CHECK/tabela homônimos alheios ou divergentes (inclusive cerca desabilitada) → `PENDING_RECOVERY_OBJECT_COLLISION`; conjunto incompleto (ex.: gatilho removido) → `PENDING_RECOVERY_PARTIAL`. Nunca sobrescreve objeto não atestado (`CREATE` sem `OR REPLACE`; sem `DROP TRIGGER`). Depois de criar, reconfere tudo (`PENDING_RECOVERY_POSTCHECK`).
- `n8n/growth/crm-campaign-abandon-gateway.sql` — `public.shrigma_crm_campaign_abandon_v1(text,jsonb)` SECURITY DEFINER; `crm_campaign_api` recebe só EXECUTE nele. Mesma regra: atesta `auth_v1`, `effect_v1` e `shrigma_campaign_abandon` (`CRM_CAMPAIGN_ABANDON_DEPENDENCY_DRIFT`); wrapper homônimo alheio ou com dono/SECURITY/search_path/ACL divergente → `CRM_CAMPAIGN_ABANDON_OBJECT_COLLISION`; wrapper exato → no-op. Login restrito continua sem tabela e sem a função interna (provado).

## Sequência de instalação (para o Codex)

1. Integrar a fonte somente na candidata, com gates desligados, e aprovar revisão + CI PG17.10 em banco descartável. Executar `tests/claude-pending-recovery-pg16-postgres.cjs`, `tests/claude-pending-recovery-install-pg16-postgres.cjs` (banco novo) e a prova do gateway, com os opt-ins de isolamento próprios. CI deve preceder qualquer instalação SQL real; fonte integrada não equivale a merge/publicação em produção.
2. Obter aprovação explícita de Felipe para instalação/ativação no escopo concreto. Preparar janela sem agendar/cancelar em voo (consultar `pending` antes) e backup lógico de `shrigma_campaign_operation`, preservando os envios programados. Conferir imagem/contexto revisados com `abandon.cjs` presente.
3. Somente no escopo aprovado, como `postgres`: aplicar `campaign-pending-recovery.sql`; depois `crm-campaign-abandon-gateway.sql`. Qualquer `RAISE` = nada foi alterado; não contornar: investigar o desvio (a versão instalada não é a revisada). Conferir: colunas novas `NULL` em todas as linhas; `enabled=false`; md5 dos três corpos inalterados; rodar o inventário abaixo (só pode haver `pending_sem_lease`; nenhum lease nem lápide).
4. Registrar separadamente o resultado da fixture CI e a conferência real da instalação inativa. Não habilitar SQL, serviço ou capability por inferência da CI verde; a ativação depende de revisão e autorização próprias.
5. Ligar o gate SQL (`UPDATE ... SET enabled=true`). Só a partir daqui novos claims de agendar/cancelar recebem lease. Observar 1 ciclo (efeitos normais devem confirmar bem antes de 900 s; o limite HTTP é 85 s).
6. Publicar o serviço com `CRM_CAMPAIGN_ABANDON_ENABLED=true` (nova imagem; `*.cjs` já é copiado pelo Dockerfile).
7. Só então anunciar `abandon:true` + `abandon_policy` na capability do painel e, em PR própria, criar o botão (recompilar o bundle).

## Reversão: desligar protege, mas não é reversão completa

Ordem: desligar o anúncio da capability → `CRM_CAMPAIGN_ABANDON_ENABLED=false` → `UPDATE public.shrigma_campaign_pending_recovery_config SET enabled=false,updated_at=clock_timestamp()`.

O que `enabled=false` faz e o que **não** faz:

- Para de emitir lease em claims novos e a função de encerrar passa a responder `ABANDON_DISABLED`.
- **Não desfaz os leases já emitidos.** A cerca continua valendo para eles: um efeito de agendar/cancelar que chegue depois do prazo de um lease emitido com o gate ligado ainda recebe `OPERATION_LEASE_EXPIRED` e a transação inteira volta (status da campanha + recibo). Isso protege (nenhum efeito sem prova), mas **não é reversão completa**: essas tentativas ficam `pending` e cercadas, e com o gate desligado não há lápide para elas — voltam à conciliação técnica de hoje.
- Lápides existentes continuam válidas e imutáveis (histórico; POST atrasado com a chave continua recusado).

**Nunca remova o gatilho** `shrigma_campaign_operation_fence` (nem desabilite, nem edite `lease_expires_at`/`abandoned_at` à mão) para "liberar" uma tentativa por prazo. Sem o gatilho, um efeito tardio de um lease vencido voltaria a confirmar e a lápide deixaria de ser imutável — exatamente o que a cerca impede. Remover o gatilho também deixa a instalação parcial: o instalador passa a recusar (`PENDING_RECOVERY_PARTIAL`) até conciliação manual. Tempo decorrido não prova ausência; só a lápide prova.

Drenagem antes de considerar a reversão concluída (gate já desligado):

1. Rodar o inventário abaixo e guardar o resultado (antes de qualquer rollback, e de novo ao final).
2. `lease_ativo`: esperar o efeito terminar (normal: bem antes de 900 s) ou o prazo vencer. Não encurtar o prazo à mão.
3. `lease_vencido_cercado`: nenhum efeito pode mais confirmar com essa chave. Conciliar como hoje (consultar a campanha no Listmonk pelo `providerId`/id e a versão; nunca repetir POST). Se for preciso gravar lápide, religar o gate só para isso (`enabled=true`), encerrar pela rota/função e desligar de novo — nunca por UPDATE direto.
4. `pending_sem_lease`: fora deste mecanismo (anteriores ao gate ou com o gate desligado); conciliação técnica de sempre.
5. `lapide` e `final_com_lease`: históricos; não mexer.
6. Concluído quando `lease_ativo` = 0 e cada `lease_vencido_cercado` tiver conciliação registrada. Colunas, tabela, função e gatilho permanecem instalados (o gate desligado os deixa inertes para operações novas).

## Inventário antes de qualquer reversão

Somente leitura. Por operação:

```sql
SELECT o.id, o.actor, o.operation_key, o.brand, o.action, o.state, o.provider_id, o.lease_expires_at, o.abandoned_at, o.created_at,
 CASE WHEN o.abandoned_at IS NOT NULL THEN 'lapide'
      WHEN o.state='pending' AND o.lease_expires_at>clock_timestamp() THEN 'lease_ativo'
      WHEN o.state='pending' AND o.lease_expires_at IS NOT NULL THEN 'lease_vencido_cercado'
      WHEN o.state='pending' THEN 'pending_sem_lease'
      ELSE 'final_com_lease' END AS situacao
FROM public.shrigma_campaign_operation o
WHERE o.lease_expires_at IS NOT NULL OR o.abandoned_at IS NOT NULL OR o.state='pending'
ORDER BY situacao, o.created_at;
```

Resumo (com o estado do gate):

```sql
SELECT s.situacao, count(*) AS total, min(s.lease_expires_at) AS primeiro_prazo, max(s.lease_expires_at) AS ultimo_prazo,
 (SELECT enabled FROM public.shrigma_campaign_pending_recovery_config WHERE id) AS gate_ligado
FROM (SELECT o.lease_expires_at,
 CASE WHEN o.abandoned_at IS NOT NULL THEN 'lapide'
      WHEN o.state='pending' AND o.lease_expires_at>clock_timestamp() THEN 'lease_ativo'
      WHEN o.state='pending' AND o.lease_expires_at IS NOT NULL THEN 'lease_vencido_cercado'
      WHEN o.state='pending' THEN 'pending_sem_lease'
      ELSE 'final_com_lease' END AS situacao
 FROM public.shrigma_campaign_operation o
 WHERE o.lease_expires_at IS NOT NULL OR o.abandoned_at IS NOT NULL OR o.state='pending') s
GROUP BY s.situacao ORDER BY s.situacao;
```

## Provas

- `tests/claude-pending-recovery.test.cjs` (5): rota OFF idêntica, rota ON estrita, mapeamento do executor, cliente com/sem capability.
- `tests/claude-pending-recovery-postgres.cjs` (PGlite, QA_PG=1): gate off sem mudança (agendar/cancelar pelo serviço), lápide sem registro + POST atrasado `IDEMPOTENCY_CONFLICT`, lease válido recusa, cerca `OPERATION_LEASE_EXPIRED` desfaz o status, lápide de pending vencido + efeito/replay tardios recusados, cancelar idem, efeito que venceu devolve `succeeded`, identidade (marca/ação/ator), CREATE/validar/legado nunca por TTL, guardas diretas, desligar de novo.
- `tests/claude-pending-recovery-install-postgres.cjs` (PGlite, QA_PG=1) e `tests/claude-pending-recovery-install-pg16-postgres.cjs` (nativo, banco novo), casos em `tests/claude-pending-recovery-install-cases.cjs`: provider sem o recibo atômico de agendar com comentários preservados → recusado sem DDL; owner/SECURITY/volatilidade/search_path/ACL/ausência de dependência (e, no nativo, `effect_v1`/`auth_v1`) → recusado sem DDL; gatilho e função de cerca homônimos alheios → recusados e intactos; parcial → recusado; reinstalação exata → no-op (mesmos oid/xmin, gate preservado); cerca desabilitada/trocada depois → recusado; wrapper do gateway alheio/divergente → recusado; gate OFF com lease emitido → efeito tardio ainda `OPERATION_LEASE_EXPIRED`, sem lápide, e o inventário acima classifica a operação.
- `tests/claude-pending-recovery-pg16-postgres.cjs` (PostgreSQL nativo, **duas sessões**): corrida lápide × claim atrasado (claim bloqueado no advisory lock, conflito, zero efeito); corrida lápide × efeito tardio de agendar e de cancelar (provider bloqueado no FOR UPDATE, recusado); efeito em andamento × lápide (espera, lease vence durante a espera, vê `succeeded`); lease válido recusa; duplo encerramento concorrente → um registro; HTTP com login restrito (marca/ação/ator/capability errados, CREATE recusado, gate OFF igual a antes); sessão com funções em cache antes do `ADD COLUMN` continua funcionando. **Rodado em PostgreSQL 16.15** (porta 55434, cluster descartável); o CI dos vizinhos usa **17.10** — ainda não rodado em 17.

## Observações

- Com o gate ligado, um efeito que só chega depois do prazo vira `OPERATION_LEASE_EXPIRED`; o adaptador JS (`campaign-provider.js`, dentro do bundle do runtime) não conhece o código e o serviço grava `outcome_unknown`. Seguro (nada aplicado), mas a mensagem fica "incerto". Mapear o código exige mexer no bundle — PR separada.
- O recibo atômico compara `send_at` em milissegundos. No PG nativo, um `send_at` com microssegundos (gravado fora do painel) faz agendar/cancelar recusarem com `CAMPAIGN_RECEIPT_MISMATCH` (sem efeito). O painel grava no máximo milissegundos. Visto só no fixture nativo; não é defeito desta PR.
- `crm-campaign-gateway-role.sql` continua pinando os mesmos md5; esta migração não o invalida.
- O gatilho não impede que o dono (`postgres`) altere `lease_expires_at` por UPDATE direto (os testes usam isso para simular o prazo). Só o dono escreve na tabela; o procedimento proíbe editar essas colunas à mão (ver Reversão). Travar isso no gatilho exigiria mudar os fixtures de teste — fora desta correção.
- Os pins de `auth_v1`/`effect_v1` (`e2b117ec…`/`e4d3e314…`) e da cerca/encerrar/wrapper (`5b15a306…`/`72bd1f5e…`/`b5b4991a…`) foram medidos em PG 16.15 e PGlite; o `prosrc` não depende da versão, mas rodar o teste de instalação no 17.10 antes de aplicar.
