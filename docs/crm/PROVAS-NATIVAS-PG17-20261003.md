# Provas nativas em PostgreSQL 17.10 — #219 (leitura de públicos e templates)

Data: 2026-10-03 · Branch: `claude/crm-read-templates-media-20261003` (base 4f94da5) · Agente P

Objetivo: repetir em **PostgreSQL 17.10 nativo** (versão do CI e da produção), com duas
sessões, as provas de leitura do portal que antes só tinham sido medidas em 16.15: papel
somente leitura (`crm_audience_reader` e o papel de templates), isolamento por marca
(fish/aristo), zero efeito, leitura sem esperar escritor, revogação vista por outra sessão.
Gates seguem **OFF** fora da fixture (o `LOGIN` do papel só existe no banco descartável).

## Versão medida

```
SELECT version();
PostgreSQL 17.10 (Ubuntu 17.10-1.pgdg24.04+1) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit
SHOW server_version_num; -- 170010
```

Cluster descartável por teste em `/tmp/claude-native-pg17.*` (initdb novo, `trust` só em
`127.0.0.1/32`, porta 55440), derrubado e apagado ao final. Cliente `pg@8.13.1` (mesma versão
de `services/crm-audience/package.json`). Node 22.22.0. Sem rede, sem Listmonk, sem envio.

## Resultados (PostgreSQL 17.10)

| Teste | Resultado | Evidência (linha JSON do teste) |
|---|---|---|
| `tests/claude-audience-read-pg16-postgres.cjs` | **pass** | `{"postgres":170010,"role":"crm_audience_reader","brands":["fish","aristo"],"zero_effect":true,"read_ms_under_writer":18,"legacy_lock_wait_ms":503,"revocation_two_sessions":true,"expiry":true,"stale_not_proof":true,"sends":0}` |
| `tests/claude-template-read-pg16-postgres.cjs` | **pass** | `{"server_version_num":170010,"install":"strict_file_ok_reinstall_refused","preexisting_public_execute_template_auth_v2":true,"brand_isolation":"ok","role_privileges":"only_three_functions","zero_effect":"ok","read_under_writer_lock_ms":11,"revocation_two_sessions":"ok","passed":true}` |

## Diferenças vs PostgreSQL 16.15

Nenhuma diferença de comportamento. O único bloqueio era a asserção fixa
`info.v>=160000&&info.v<170000`. Ajuste: os dois testes ganharam `assertPgVersion`:

- sem variável: mantém exatamente a prova original (exige 16.x);
- `CRM_PG_EXPECTED_VERSION_NUM=160015|170010`: exige **exatamente** a versão informada
  (qualquer outro valor da variável é recusado).

Nenhuma asserção de comportamento foi alterada. Regressão em 16.15 com
`CRM_PG_EXPECTED_VERSION_NUM=160015`: os dois passam (mesmos campos `true`/`ok`).

## Como rodar

```bash
npm ci --prefix services/crm-audience --ignore-scripts --no-audit --no-fund   # se faltar pg
CLAUDE_NATIVE_PROOFS=1 tools/claude-native-proofs/run-pg17.sh
# opções: PROOF_PG_PORT=55440 PGBIN=/usr/lib/postgresql/17/bin PG_NODE_MODULES=<…/node_modules> PROOF_KEEP=1
```

O script é opt-in, cria/derruba um cluster por teste, recusa portas 5432/5433, porta ocupada,
host não-loopback e binário que não seja 17.10, e roda cada teste com `env -i` (nenhum
`DATABASE_URL`/`PG*` do chamador chega ao teste). Saída desta medição:

```
== resumo (PostgreSQL 170010, um cluster descartável por teste)
PASS tests/claude-audience-read-pg16-postgres.cjs
PASS tests/claude-template-read-pg16-postgres.cjs
```

Equivalente manual:

```bash
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55440/listmonk CRM_AUDIENCE_TEST_ISOLATED=1 \
CRM_PG_EXPECTED_VERSION_NUM=170010 PG_MODULE=./services/crm-audience/node_modules/pg \
node tests/claude-audience-read-pg16-postgres.cjs
```

## Proposta de job CI (para o Codex integrar no workflow candidato)

Uma entrada de matriz por teste, cada uma com seu próprio serviço `postgres:17.10` (os papéis
`crm_audience_reader`/de templates são do cluster e o instalador recusa reinstalação, então
cada prova precisa de cluster novo). Sem segredos, só loopback.

```yaml
  crm-read-native-pg17:
    name: Provas nativas PG 17.10 (#219) · ${{ matrix.name }}
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    permissions:
      contents: read
    strategy:
      fail-fast: false
      matrix:
        include:
          - name: leitura de públicos
            flag: CRM_AUDIENCE_TEST_ISOLATED
            file: tests/claude-audience-read-pg16-postgres.cjs
          - name: leitura de templates
            flag: CRM_TEMPLATE_TEST_ISOLATED
            file: tests/claude-template-read-pg16-postgres.cjs
    services:
      postgres:
        image: postgres:17.10
        env:
          POSTGRES_DB: listmonk
          POSTGRES_USER: postgres
          POSTGRES_HOST_AUTH_METHOD: trust
        ports:
          - 127.0.0.1:55432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d listmonk"
          --health-interval 5s --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Instalar pg fixado (sem scripts)
        run: npm ci --prefix services/crm-audience --ignore-scripts --no-audit --no-fund
      - name: Prova nativa
        env:
          PG_MODULE: ${{ github.workspace }}/services/crm-audience/node_modules/pg
          NODE_PATH: ./services/crm-audience/node_modules
          TEST_DATABASE_URL: postgresql://postgres@127.0.0.1:55432/listmonk
          CRM_PG_EXPECTED_VERSION_NUM: '170010'
          TZ: UTC
        run: |
          export "${{ matrix.flag }}=1"
          node "${{ matrix.file }}"
```

## Pendências

- Os nomes dos arquivos mantêm o sufixo `pg16` por compatibilidade com referências existentes;
  a versão efetiva é controlada por `CRM_PG_EXPECTED_VERSION_NUM`.
- `services/crm-audience/package-lock.json` não foi conferido contra `npm ci` nesta medição
  (sem rede); o `pg` usado foi 8.13.1 de um diretório de ferramentas local.
