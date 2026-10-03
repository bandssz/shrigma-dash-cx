#!/usr/bin/env bash
# Provas NATIVAS descartáveis em PostgreSQL 17.10 — frente #220 (recuperação de
# tentativas pendentes: cerca/lease/lápide, instalador e gateway).
#
# Opt-in e só local: cria um cluster novo em /tmp POR TESTE (initdb, trust apenas
# em 127.0.0.1), cria o banco vazio exigido, roda o teste com ambiente limpo
# (env -i: nenhuma variável do shell chamador chega ao teste) e derruba/apaga.
# Nunca lê DATABASE_URL/PG*/segredos; recusa porta 5432/5433, porta ocupada e
# qualquer host que não seja 127.0.0.1. Gates continuam OFF fora da fixture.
#
# Uso:  CLAUDE_NATIVE_PROOFS=1 tools/claude-native-proofs/run-pg17.sh
# Opções (todas opcionais):
#   PROOF_PG_PORT=55440   porta do cluster descartável (>=1024, ≠5432/5433)
#   PGBIN=/usr/lib/postgresql/17/bin   binários do PostgreSQL 17.10
#   PG_NODE_MODULES=services/crm-campaign/node_modules   onde está pg@8.13.1
#                     (npm ci --prefix services/crm-campaign --ignore-scripts)
#   PROOF_KEEP=1          mantém o diretório temporário para inspeção
set -euo pipefail

[[ "${CLAUDE_NATIVE_PROOFS:-}" == 1 ]] || { echo "opt-in: defina CLAUDE_NATIVE_PROOFS=1" >&2; exit 2; }
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PGBIN=${PGBIN:-/usr/lib/postgresql/17/bin}
PORT=${PROOF_PG_PORT:-55440}
HOST=127.0.0.1
EXPECTED_NUM=170010
PG_NODE_MODULES=${PG_NODE_MODULES:-$ROOT/services/crm-campaign/node_modules}

# Testes desta frente: "banco|modo|flag de isolamento|arquivo"
TESTS=(
  "listmonk|test|CRM_PENDING_RECOVERY_TEST_ISOLATED|tests/claude-pending-recovery-pg16-postgres.cjs"
  "listmonk|test|CRM_PENDING_RECOVERY_TEST_ISOLATED|tests/claude-pending-recovery-install-pg16-postgres.cjs"
  "listmonk|test|CRM_CAMPAIGN_GATEWAY_TEST_ISOLATED|tests/crm-campaign-gateway-postgres.cjs"
  "segment_binding_test|script|SEGMENT_BINDING_TEST_DATABASE_ISOLATED|tests/segment-campaign-binding-postgres.cjs"
  "listmonk|script|CRM_AUDIENCE_TEST_ISOLATED|tests/segment-campaign-binding-release-postgres.cjs"
)

die(){ echo "RECUSADO: $*" >&2; exit 2; }
[[ -z "${PROOF_PG_HOST:-}" || "${PROOF_PG_HOST}" == 127.0.0.1 ]] || die "host não-loopback (${PROOF_PG_HOST})"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || die "porta inválida ($PORT)"
[[ "$PORT" != 5432 && "$PORT" != 5433 ]] || die "porta $PORT é de cluster do pacote"
"$PGBIN/postgres" -V | grep -q ' 17\.10' || die "esperado PostgreSQL 17.10 em $PGBIN ($("$PGBIN/postgres" -V))"
set +e; "$PGBIN/pg_isready" -q -h "$HOST" -p "$PORT"; ready=$?; set -e
[[ $ready == 2 ]] || die "já existe algo escutando em $HOST:$PORT"
[[ -f "$PG_NODE_MODULES/pg/package.json" ]] || die "pg ausente em $PG_NODE_MODULES (rode: npm ci --prefix services/crm-campaign --ignore-scripts)"
NODE=$(command -v node) || die "node ausente"

BASE=$(mktemp -d /tmp/claude-native-pg17.XXXXXX)
if [[ $(id -u) == 0 ]]; then chown postgres "$BASE"; as_pg(){ su postgres -s /bin/bash -c "$*"; }; else as_pg(){ bash -c "$*"; }; fi
DATA=""
stop_cluster(){ if [[ -n "$DATA" && -f "$DATA/postmaster.pid" ]]; then as_pg "'$PGBIN/pg_ctl' -D '$DATA' -m fast -w stop" >/dev/null || true; fi; DATA=""; }
cleanup(){ stop_cluster; if [[ "${PROOF_KEEP:-}" == 1 ]]; then echo "mantido: $BASE"; else rm -rf "$BASE" || echo "não apagado: $BASE" >&2; fi; }
trap cleanup EXIT

psql_(){ env -i PATH=/usr/bin:/bin "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$HOST" -p "$PORT" -U postgres "$@"; }
start_cluster(){
  DATA="$BASE/c$1/data"; mkdir -p "$BASE/c$1"; [[ $(id -u) == 0 ]] && chown postgres "$BASE/c$1"
  as_pg "'$PGBIN/initdb' -D '$DATA' -U postgres -A reject -E UTF8 --locale=C.UTF-8" >"$BASE/c$1/initdb.log"
  printf 'host all all 127.0.0.1/32 trust\n' >"$DATA/pg_hba.conf"
  as_pg "'$PGBIN/pg_ctl' -D '$DATA' -l '$BASE/c$1/pg.log' -w -o \"-p $PORT -c listen_addresses=$HOST -c unix_socket_directories='$BASE/c$1'\" start" >/dev/null
}

declare -a SUMMARY; fail=0; i=0
for entry in "${TESTS[@]}"; do
  IFS='|' read -r db mode flag file <<<"$entry"; i=$((i+1))
  start_cluster "$i"
  ver=$(psql_ -d postgres -Atc "SELECT version()"); num=$(psql_ -d postgres -Atc "SHOW server_version_num")
  [[ "$num" == "$EXPECTED_NUM" ]] || die "server_version_num=$num (esperado $EXPECTED_NUM)"
  psql_ -d postgres -c "CREATE DATABASE $db"
  echo "== [$i] $file  ($ver)"
  args=("$NODE"); [[ $mode == test ]] && args+=(--test --test-timeout=120000); args+=("$file")
  set +e
  (cd "$ROOT" && env -i PATH="$(dirname "$NODE"):/usr/bin:/bin" HOME="$BASE/home" TZ=UTC LANG=C.UTF-8 \
     NODE_PATH="$PG_NODE_MODULES" PG_MODULE="$PG_NODE_MODULES/pg" ${NODE_OPTIONS:+NODE_OPTIONS="$NODE_OPTIONS"} \
     TEST_DATABASE_URL="postgresql://postgres@$HOST:$PORT/$db" "$flag=1" CRM_PG_EXPECTED_VERSION_NUM="$EXPECTED_NUM" \
     "${args[@]}") 2>&1 | tee "$BASE/c$i/test.log"
  rc=${PIPESTATUS[0]}; set -e
  SUMMARY+=("$([[ $rc == 0 ]] && echo PASS || echo FAIL) $file")
  [[ $rc == 0 ]] || fail=1
  stop_cluster; [[ "${PROOF_KEEP:-}" == 1 ]] || rm -rf "$BASE/c$i"
done
echo "== resumo (PostgreSQL $EXPECTED_NUM, um cluster descartável por teste)"; printf '%s\n' "${SUMMARY[@]}"
exit $fail
