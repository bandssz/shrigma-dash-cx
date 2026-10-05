#!/usr/bin/env bash
# Prepared for disposable Linux CI only. Never run against an existing service.
set -euo pipefail
[[ "${CRM_MANAGER_WRITER_NATIVE_PROOF:-}" = '1' ]] || { printf '%s\n' 'Native writer fixture requires explicit opt-in.' >&2; exit 1; }
[[ "$(uname -s)" = 'Linux' ]] || { printf '%s\n' 'Use isolated Linux CI.' >&2; exit 1; }
[[ -x /usr/bin/docker && -S /var/run/docker.sock ]] || { printf '%s\n' 'Local fixture runtime unavailable.' >&2; exit 1; }
WRITER_NATIVE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WRITER_NATIVE_RUN_ID="${GITHUB_RUN_ID:-0}"
[[ "$WRITER_NATIVE_RUN_ID" =~ ^[0-9]+$ ]] || exit 1
WRITER_NATIVE_CONTAINER="shrigma-manager-writer-proof-$WRITER_NATIVE_RUN_ID-$$"
WRITER_NATIVE_STARTED=0
WRITER_NATIVE_CONTAINER_ID=
WRITER_NATIVE_OK=0
writer_native_cleanup() {
 if [[ "$WRITER_NATIVE_STARTED" = '1' ]]; then /usr/bin/docker --host unix:///var/run/docker.sock rm --force "$WRITER_NATIVE_CONTAINER_ID" >/dev/null 2>&1 || true; fi
 if [[ "$WRITER_NATIVE_OK" != '1' ]]; then printf '%s\n' 'Native writer proof did not finish; SQL and server logs were not printed.' >&2; fi
}
trap writer_native_cleanup EXIT
[[ "$(node -p 'process.versions.node.split(".")[0]')" = '22' ]] || exit 1
[[ "$(sha256sum "$WRITER_NATIVE_DIR/pg_hba.conf" | cut -d ' ' -f 1)" = 'a2501b162522dd9b062c5f85004e1c36ba6473ec2fa5c4c99ca8f922717266e3' ]] || exit 1
if /usr/bin/docker --host unix:///var/run/docker.sock container inspect "$WRITER_NATIVE_CONTAINER" >/dev/null 2>&1; then exit 1; fi
WRITER_NATIVE_CONTAINER_ID="$(/usr/bin/docker --host unix:///var/run/docker.sock create \
 --name "$WRITER_NATIVE_CONTAINER" --label com.shrigma.fixture=manager-writer-private \
 --network bridge --publish 127.0.0.1:5440:5432 \
 --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128 \
 --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=256m \
 --mount "type=bind,source=$WRITER_NATIVE_DIR/pg_hba.conf,target=/proof/pg_hba.conf,readonly" \
 --env POSTGRES_DB=crm_manager_writer_fixture --env POSTGRES_PASSWORD=synthetic-writer-native-only \
 --env 'POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=scram-sha-256' \
 postgres:17.10 \
 -c hba_file=/proof/pg_hba.conf -c ssl=off -c password_encryption=scram-sha-256 \
 -c cluster_name=shrigma-native-writer-disposable-only \
 -c log_statement=none -c log_min_error_statement=panic \
 -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 \
 -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 \
 -c log_transaction_sample_rate=0 2>/dev/null)"
[[ "$WRITER_NATIVE_CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
WRITER_NATIVE_STARTED=1
/usr/bin/docker --host unix:///var/run/docker.sock start "$WRITER_NATIVE_CONTAINER_ID" >/dev/null 2>&1
WRITER_NATIVE_READY=0
for WRITER_NATIVE_ATTEMPT in $(seq 1 45); do
 if /usr/bin/docker --host unix:///var/run/docker.sock exec "$WRITER_NATIVE_CONTAINER_ID" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h 127.0.0.1 -U postgres -d crm_manager_writer_fixture' >/dev/null 2>&1; then WRITER_NATIVE_READY=1; break; fi
 sleep 1
done
[[ "$WRITER_NATIVE_READY" = '1' ]] || exit 1
CRM_MANAGER_WRITER_CONTAINER="$WRITER_NATIVE_CONTAINER" node --test "$WRITER_NATIVE_DIR/native-writer.test.cjs"
WRITER_NATIVE_OK=1
