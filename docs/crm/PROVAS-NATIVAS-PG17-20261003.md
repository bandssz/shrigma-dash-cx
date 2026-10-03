# Provas nativas em PostgreSQL 17.10 — #220 (recuperação de tentativas pendentes)

Data: 2026-10-03 · Branch: `claude/crm-pending-recovery-20261003` (base e6ecabf) · Agente P

Objetivo: provar em **PostgreSQL 17.10 nativo** (a versão do CI e da produção), com duas
sessões concorrentes, a cerca/lease/lápide da recuperação pendente, o instalador recusando
schema inesperado e a reversão sem apagar leases/recibos existentes — e que #220 não quebra o
gateway `crm-campaign` nem o vínculo segmento × campanha. Gates seguem **OFF** fora da fixture
(o único `enabled=true` é dentro do banco descartável do teste de corrida).

## Versão medida

```
SELECT version();
PostgreSQL 17.10 (Ubuntu 17.10-1.pgdg24.04+1) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit
SHOW server_version_num; -- 170010
```

Cluster descartável por teste em `/tmp/claude-native-pg17.*` (initdb novo, `trust` só em
`127.0.0.1/32`, socket no diretório temporário, porta 55440), derrubado e apagado ao final.
Cliente `pg@8.13.1` (mesma versão fixada em `services/crm-campaign/package-lock.json`).
Node 22.22.0. Sem rede (preload que recusa saída não-loopback), sem Listmonk, sem envio.

## Resultados (PostgreSQL 17.10)

| Teste | Modo | Resultado | Evidência (linha JSON do teste) |
|---|---|---|---|
| `tests/claude-pending-recovery-pg16-postgres.cjs` | `node --test` | **5/5 pass** | `{"postgres":"170010","sessions":2,"native_calls":0,"sends":0}` |
| `tests/claude-pending-recovery-install-pg16-postgres.cjs` | `node --test` | **1/1 pass** | `{"postgres":"170010","cases":6,"native_calls":0,"sends":0}` |
| `tests/crm-campaign-gateway-postgres.cjs` | `node --test` | **1/1 pass** | `http, restricted_login, recovery, legacy_inflight_shared_claim, revocation, direct_denied: true; native_creates:4, previews:7, sends:0` |
| `tests/segment-campaign-binding-postgres.cjs` | `node` | **ok** | `postgres_version:170010, parallel_replay, binding_cas, legacy_schedule_blocked_both_brands, reauthorization_after_lock: true` |
| `tests/segment-campaign-binding-release-postgres.cjs` | `node` | **ok** | `postgres:"17.10 …", release_append_only, rr_barrier, rebind_monotonic, public_acl_denied: true, sends:0` |

Cenários cobertos pelos dois testes desta frente:

- corrida lápide × POST atrasado (chave sem registro): o claim espera o lock e recebe conflito, zero efeito;
- corrida lápide × efeito tardio (pending com lease vencido): o provider espera o `FOR UPDATE` e é recusado;
- efeito em andamento segura o lock: a lápide espera e vê `succeeded`, mesmo com o lease vencendo na espera;
- lease ainda válido recusa; duplo encerramento concorrente grava um único registro;
- rota HTTP com login restrito: marca/ator/capability errados recusam; CREATE recusa por TTL; gate desligado mantém o contrato;
- instalador (6 blocos de casos): (1) provider sem o recibo atômico de agendar é recusado; (2) dependência com owner/SECURITY/volatilidade/search_path/ACL divergentes ou ausente é recusada **antes** do DDL (inclui `effect_v1`/`auth_v1` do gateway); (3) gatilho/função homônimos alheios recusados, objeto alheio intacto; (4) instalação limpa e reinstalação exata no-op (mesmos oid/xmin, gate preservado); (5) wrapper do gateway: objeto alheio recusado, reinstalação no-op; (6) gate desligado com lease já emitido: a cerca continua — a reversão documentada não remove o gatilho nem apaga leases/recibos, e o inventário antes de qualquer reversão enxerga a operação;
- sessão aquecida antes da migração continua funcionando depois dela (teste de corrida, `before`).

### Pins de md5 do instalador em 17.10

`md5(prosrc)` é calculado sobre o texto do corpo e não depende da versão. Conferido no banco
17.10 após instalar a cadeia: todos os pins batem com os valores fixados nos instaladores.

| Função | md5(prosrc) em 17.10 | Pin |
|---|---|---|
| `shrigma_campaign_store(text,jsonb)` | `b77d960aca32c2c93dfe15e82922d7ff` | igual |
| `shrigma_campaign_provider(text,jsonb)` | `fe3a35e75c8d0830f1b289fa806e52fc` | igual |
| `shrigma_campaign_recovery(text,jsonb)` | `1e2c0a2bacd82f4dcf8d6797cbf1842c` | igual |
| `shrigma_crm_campaign_auth_v1(text)` | `e2b117ecf6a640a6272fdb8005895c31` | igual |
| `shrigma_crm_campaign_effect_v1(text,jsonb,jsonb)` | `e4d3e3143e26cd186a31e8d21ed5b473` | igual |
| `shrigma_campaign_operation_fence()` | `5b15a30623151649574bb4b9de1453c8` | igual |
| `shrigma_campaign_abandon(jsonb)` | `72bd1f5ec9aba153f1bbc0b5848fb362` | igual |
| `shrigma_crm_campaign_abandon_v1(text,jsonb)` | `b5b4991afb08240100670188b5009a33` | igual |

`proconfig` (`search_path=pg_catalog, public`, `lock_timeout=3s`) e o formato da ACL também
são idênticos em 16.15 e 17.10.

## Diferenças vs PostgreSQL 16.15

Nenhuma diferença de comportamento observada. Os dois testes desta frente já aceitavam 16 e 17;
ganharam apenas a asserção opcional de versão exata (`CRM_PG_EXPECTED_VERSION_NUM=160015|170010`).
Regressão em 16.15 com `CRM_PG_EXPECTED_VERSION_NUM=160015`: 5/5 e 1/1 pass.

## Como rodar

Script opt-in (cria/derruba um cluster por teste; recusa portas 5432/5433, porta ocupada, host
não-loopback e binário que não seja 17.10; roda cada teste com `env -i`, sem `DATABASE_URL`/`PG*`
do chamador):

```bash
npm ci --prefix services/crm-campaign --ignore-scripts --no-audit --no-fund   # se faltar pg
CLAUDE_NATIVE_PROOFS=1 tools/claude-native-proofs/run-pg17.sh
# opções: PROOF_PG_PORT=55440 PGBIN=/usr/lib/postgresql/17/bin PG_NODE_MODULES=<…/node_modules> PROOF_KEEP=1
```

Execução desta medição (dentro do ambiente de QA sem rede; `pg` de um diretório de ferramentas
com a mesma versão 8.13.1, por isso sem `npm ci`):

```bash
QA_REPO=<cópia> run-in.sh env CLAUDE_NATIVE_PROOFS=1 PG_NODE_MODULES=<postgres-test-tools>/node_modules \
  bash tools/claude-native-proofs/run-pg17.sh
# == resumo (PostgreSQL 170010, um cluster descartável por teste)
# PASS tests/claude-pending-recovery-pg16-postgres.cjs
# PASS tests/claude-pending-recovery-install-pg16-postgres.cjs
# PASS tests/crm-campaign-gateway-postgres.cjs
# PASS tests/segment-campaign-binding-postgres.cjs
# PASS tests/segment-campaign-binding-release-postgres.cjs
```

Equivalente manual de um teste:

```bash
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55440/listmonk \
CRM_PENDING_RECOVERY_TEST_ISOLATED=1 CRM_PG_EXPECTED_VERSION_NUM=170010 \
NODE_PATH=./services/crm-campaign/node_modules \
node --test --test-timeout=120000 tests/claude-pending-recovery-pg16-postgres.cjs
```

## Proposta de job CI (para o Codex integrar no workflow candidato)

Uma entrada de matriz por teste, cada uma com seu **próprio** serviço `postgres:17.10` (banco
novo e papéis de cluster limpos: `crm_campaign_api` recebe LOGIN dentro das fixtures). Nenhum
segredo, nenhum `DATABASE_URL` de ambiente, só loopback.

```yaml
  pending-recovery-native-pg17:
    name: Provas nativas PG 17.10 (#220) · ${{ matrix.name }}
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    permissions:
      contents: read
    strategy:
      fail-fast: false
      matrix:
        include:
          - name: recuperação pendente (duas sessões)
            db: listmonk
            flag: CRM_PENDING_RECOVERY_TEST_ISOLATED
            run: node --test --test-timeout=120000 tests/claude-pending-recovery-pg16-postgres.cjs
          - name: instalador recusa desvio
            db: listmonk
            flag: CRM_PENDING_RECOVERY_TEST_ISOLATED
            run: node --test --test-timeout=120000 tests/claude-pending-recovery-install-pg16-postgres.cjs
          - name: gateway crm-campaign
            db: listmonk
            flag: CRM_CAMPAIGN_GATEWAY_TEST_ISOLATED
            run: node --test --test-timeout=120000 tests/crm-campaign-gateway-postgres.cjs
          - name: vínculo segmento × campanha
            db: segment_binding_test
            flag: SEGMENT_BINDING_TEST_DATABASE_ISOLATED
            run: node tests/segment-campaign-binding-postgres.cjs
          - name: liberação do vínculo
            db: listmonk
            flag: CRM_AUDIENCE_TEST_ISOLATED
            run: node tests/segment-campaign-binding-release-postgres.cjs
    services:
      postgres:
        image: postgres:17.10
        env:
          POSTGRES_DB: ${{ matrix.db }}
          POSTGRES_USER: postgres
          POSTGRES_HOST_AUTH_METHOD: trust
        ports:
          - 127.0.0.1:55432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d ${{ matrix.db }}"
          --health-interval 5s --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Instalar pg fixado (sem scripts)
        run: npm ci --prefix services/crm-campaign --ignore-scripts --no-audit --no-fund
      - name: Prova nativa
        env:
          NODE_PATH: ./services/crm-campaign/node_modules
          TEST_DATABASE_URL: postgresql://postgres@127.0.0.1:55432/${{ matrix.db }}
          CRM_PG_EXPECTED_VERSION_NUM: '170010'
          TZ: UTC
        run: |
          export "${{ matrix.flag }}=1"
          ${{ matrix.run }}
```

Observação: `tests/crm-campaign-gateway-postgres.cjs` já roda em `crm-campaign-service.yml`
contra 17.10; repeti-lo aqui é opcional (mantido para a frente ter prova de não-regressão
própria). Os dois `segment-campaign-binding-*` exigem `server_version_num=170010` por conta
própria.

## Pendências

- O instalador continua sem prova em cluster com dados reais de produção (fora do escopo:
  nada de produção).
- Os nomes dos arquivos mantêm o sufixo `pg16` por compatibilidade com referências existentes;
  a versão efetiva é controlada por `CRM_PG_EXPECTED_VERSION_NUM`.
