#!/usr/bin/env bash
# Linux CI only. No remote daemon, existing service, volume or database is used.
set -euo pipefail
[[ "${CRM_MANAGER_V3_NATIVE_PROOF:-}" = '1' ]] || { printf '%s\n' 'Isolated native proof requires explicit opt-in.' >&2; exit 1; }
[[ "$(uname -s)" = 'Linux' ]] || { printf '%s\n' 'Use the disposable Linux CI runner for this proof.' >&2; exit 1; }
[[ -x /usr/bin/docker && -S /var/run/docker.sock ]] || { printf '%s\n' 'Local Linux Docker runtime unavailable.' >&2; exit 1; }
NATIVE_V3_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NATIVE_V3_RUN_ID="${GITHUB_RUN_ID:-0}"
[[ "$NATIVE_V3_RUN_ID" =~ ^[0-9]+$ ]] || exit 1
NATIVE_V3_CONTAINER="shrigma-manager-v3-proof-$NATIVE_V3_RUN_ID-$$"
NATIVE_V3_STARTED=0
NATIVE_V3_CONTAINER_ID=
NATIVE_V3_OK=0
native_v3_cleanup() {
  if [[ "$NATIVE_V3_STARTED" = '1' ]]; then
    /usr/bin/docker --host unix:///var/run/docker.sock rm --force "$NATIVE_V3_CONTAINER_ID" >/dev/null 2>&1 || true
  fi
  if [[ "$NATIVE_V3_OK" != '1' ]]; then printf '%s\n' 'Native V3 proof did not complete; no server logs or SQL bodies were printed.' >&2; fi
}
trap native_v3_cleanup EXIT
# PG* variables cannot override the explicitly pinned client parameters. The
# process flag/container name authorize only this synthetic fixture. Docker is
# always pointed explicitly at the fresh runner's LOCAL Unix daemon.
[[ "$(node -p 'process.versions.node.split(".")[0]')" = '22' ]] || exit 1
[[ "$(sha256sum "$NATIVE_V3_DIR/pg_hba.conf" | cut -d ' ' -f 1)" = 'a2501b162522dd9b062c5f85004e1c36ba6473ec2fa5c4c99ca8f922717266e3' ]] || exit 1
# A random/new name is not enough: refuse any preexisting object with that name.
if /usr/bin/docker --host unix:///var/run/docker.sock container inspect "$NATIVE_V3_CONTAINER" >/dev/null 2>&1; then exit 1; fi
NATIVE_V3_CONTAINER_ID="$(/usr/bin/docker --host unix:///var/run/docker.sock create \
  --name "$NATIVE_V3_CONTAINER" --label com.shrigma.fixture=manager-v3-private \
  --network bridge --publish 127.0.0.1:5438:5432 \
  --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=256m \
  --mount "type=bind,source=$NATIVE_V3_DIR/pg_hba.conf,target=/proof/pg_hba.conf,readonly" \
  --env POSTGRES_DB=listmonk --env POSTGRES_PASSWORD=synthetic-native-v3-only \
  --env 'POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=scram-sha-256' \
  postgres:17.10 \
  -c hba_file=/proof/pg_hba.conf -c ssl=off -c password_encryption=scram-sha-256 \
  -c cluster_name=shrigma-native-v3-disposable-only \
  -c log_statement=none -c log_min_error_statement=panic \
  -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 \
  -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 \
  -c log_transaction_sample_rate=0 2>/dev/null)"
[[ "$NATIVE_V3_CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
NATIVE_V3_STARTED=1
/usr/bin/docker --host unix:///var/run/docker.sock start "$NATIVE_V3_CONTAINER_ID" >/dev/null 2>&1
NATIVE_V3_READY=0
for NATIVE_V3_ATTEMPT in $(seq 1 30); do
  if /usr/bin/docker --host unix:///var/run/docker.sock exec "$NATIVE_V3_CONTAINER" pg_isready -U postgres -d listmonk >/dev/null 2>&1; then NATIVE_V3_READY=1; break; fi
  sleep 1
done
[[ "$NATIVE_V3_READY" = '1' ]] || exit 1
# pg_isready inside the entrypoint can see its temporary initialization server.
# Wait for exec's PID1 to be the final postgres before the Node client connects.
NATIVE_V3_FINAL=0
for NATIVE_V3_ATTEMPT in $(seq 1 15); do
  if /usr/bin/docker --host unix:///var/run/docker.sock exec "$NATIVE_V3_CONTAINER" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h 127.0.0.1 -U postgres -d listmonk' >/dev/null 2>&1; then NATIVE_V3_FINAL=1; break; fi
  sleep 1
done
[[ "$NATIVE_V3_FINAL" = '1' ]] || exit 1
CRM_MANAGER_V3_CONTAINER="$NATIVE_V3_CONTAINER" node --test "$NATIVE_V3_DIR/native-v3-proof.test.cjs"
NATIVE_V3_OK=1
