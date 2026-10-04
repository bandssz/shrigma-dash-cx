#!/usr/bin/env bash
# Opt-in Linux CI only: fresh private Docker bridge/PG/volume, no real panel.
set +x
set -euo pipefail
[[ "${READ_RUNTIME_NATIVE_OCI_PROOF:-}" = 1 && "$(uname -s)" = Linux ]] || { printf '%s\n' 'READ_RUNTIME_NATIVE_OCI_REFUSED' >&2; exit 1; }
[[ -x /usr/bin/docker && -S /var/run/docker.sock && "$(node -p 'process.versions.node.split(".")[0]')" = 22 ]] || exit 1
READ_RUNTIME_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
READ_RUNTIME_INSTALL_DIR="$(cd -- "$READ_RUNTIME_DIR/../crm-manager-install-review" && pwd -P)"
READ_RUNTIME_TEMP="$(mktemp -d)"
READ_RUNTIME_DOCKER_CONFIG="$READ_RUNTIME_TEMP/docker-config"
mkdir -m 700 "$READ_RUNTIME_DOCKER_CONFIG"
READ_RUNTIME_NONCE="$(node -p 'require("node:crypto").randomBytes(8).toString("hex")')"
[[ "$READ_RUNTIME_NONCE" =~ ^[a-f0-9]{16}$ ]] || exit 1
READ_RUNTIME_LABEL="read-runtime-$READ_RUNTIME_NONCE"
READ_RUNTIME_CLUSTER="shrigma-read-runtime-$READ_RUNTIME_NONCE"
READ_RUNTIME_PG_NAME="$READ_RUNTIME_LABEL-pg"
READ_RUNTIME_INIT_NAME="$READ_RUNTIME_LABEL-init"
READ_RUNTIME_TEST_NAME="$READ_RUNTIME_LABEL-test"
READ_RUNTIME_NETWORK_NAME="$READ_RUNTIME_LABEL-network"
READ_RUNTIME_VOLUME_NAME="$READ_RUNTIME_LABEL-volume"
READ_RUNTIME_PG_ID= READ_RUNTIME_INIT_ID= READ_RUNTIME_TEST_ID= READ_RUNTIME_NETWORK_ID= READ_RUNTIME_VOLUME_ID=
READ_RUNTIME_OK=0
read_runtime_docker(){ env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_CONFIG -u DOCKER_CUSTOM_HEADERS /usr/bin/docker --config "$READ_RUNTIME_DOCKER_CONFIG" --host unix:///var/run/docker.sock "$@"; }
read_runtime_owned(){ [[ "$(read_runtime_docker "$1" inspect --format '{{ index .Labels "com.shrigma.read-runtime-proof" }}' "$2" 2>/dev/null)" = "$READ_RUNTIME_LABEL" ]]; }
read_runtime_cleanup(){
  # No prune, wildcards or names discovered from unrelated Docker resources.
  for READ_RUNTIME_ID in "$READ_RUNTIME_TEST_ID" "$READ_RUNTIME_INIT_ID" "$READ_RUNTIME_PG_ID"; do
    if [[ "$READ_RUNTIME_ID" =~ ^[a-f0-9]{64}$ ]] && [[ "$(read_runtime_docker container inspect --format '{{ index .Config.Labels "com.shrigma.read-runtime-proof" }}' "$READ_RUNTIME_ID" 2>/dev/null)" = "$READ_RUNTIME_LABEL" ]]; then read_runtime_docker rm --force "$READ_RUNTIME_ID" >/dev/null 2>&1 || true; fi
  done
  if [[ -n "$READ_RUNTIME_VOLUME_ID" ]] && read_runtime_owned volume "$READ_RUNTIME_VOLUME_ID"; then read_runtime_docker volume rm "$READ_RUNTIME_VOLUME_ID" >/dev/null 2>&1 || true; fi
  if [[ "$READ_RUNTIME_NETWORK_ID" =~ ^[a-f0-9]{64}$ ]] && read_runtime_owned network "$READ_RUNTIME_NETWORK_ID"; then read_runtime_docker network rm "$READ_RUNTIME_NETWORK_ID" >/dev/null 2>&1 || true; fi
  unset POSTGRES_PASSWORD PG_ADMIN_PASSWORD
  rm -rf -- "$READ_RUNTIME_TEMP"
  if [[ "$READ_RUNTIME_OK" != 1 ]]; then printf '%s\n' 'READ_RUNTIME_NATIVE_OCI_PROOF_FAILED; no Docker logs/config/env were printed.' >&2; fi
}
trap read_runtime_cleanup EXIT
trap 'exit 1' INT TERM
for READ_RUNTIME_NAME in "$READ_RUNTIME_PG_NAME" "$READ_RUNTIME_INIT_NAME" "$READ_RUNTIME_TEST_NAME"; do if read_runtime_docker container inspect "$READ_RUNTIME_NAME" >/dev/null 2>&1; then exit 1; fi; done
if read_runtime_docker network inspect "$READ_RUNTIME_NETWORK_NAME" >/dev/null 2>&1 || read_runtime_docker volume inspect "$READ_RUNTIME_VOLUME_NAME" >/dev/null 2>&1; then exit 1; fi
[[ "$(sha256sum "$READ_RUNTIME_INSTALL_DIR/pg_hba.conf" | cut -d ' ' -f 1)" = a2501b162522dd9b062c5f85004e1c36ba6473ec2fa5c4c99ca8f922717266e3 ]] || exit 1
[[ "$(sha256sum "$READ_RUNTIME_INSTALL_DIR/native-fixture.cjs" | cut -d ' ' -f 1)" = 3c1b80df92513767ed7ce7f1651adcf6919d56d00f5c9d3d3cf77b65fffa3e28 ]] || exit 1
# Mount ONLY reviewed public source copies, never checkout/.git/private data.
mkdir -p "$READ_RUNTIME_TEMP/source/tools/crm-manager-read-activation-review/runtime" "$READ_RUNTIME_TEMP/source/tools/crm-manager-install-review/sql"
for READ_RUNTIME_SOURCE in activation.cjs sources.cjs runtime.cjs journal.cjs cli.cjs supervisor.cjs read-proof.cjs health.cjs source-pins.cjs runtime.test.cjs supervisor.test.cjs oci-guard.cjs native-oci.test.cjs native-pure.test.cjs; do cp "$READ_RUNTIME_DIR/runtime/$READ_RUNTIME_SOURCE" "$READ_RUNTIME_TEMP/source/tools/crm-manager-read-activation-review/runtime/"; done
cp "$READ_RUNTIME_INSTALL_DIR/native-fixture.cjs" "$READ_RUNTIME_TEMP/source/tools/crm-manager-install-review/"
for READ_RUNTIME_SQL in installer.sql auth.sql operator.sql short.sql read.sql; do cp "$READ_RUNTIME_INSTALL_DIR/sql/$READ_RUNTIME_SQL" "$READ_RUNTIME_TEMP/source/tools/crm-manager-install-review/sql/"; done
find "$READ_RUNTIME_TEMP/source" -type d -exec chmod 755 {} +
find "$READ_RUNTIME_TEMP/source" -type f -exec chmod 444 {} +
chmod 755 "$READ_RUNTIME_TEMP"
READ_RUNTIME_IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815'
read_runtime_docker pull --quiet "$READ_RUNTIME_IMAGE" >/dev/null 2>&1
read_runtime_docker pull --quiet postgres:17.10 >/dev/null 2>&1
READ_RUNTIME_NETWORK_ID="$(read_runtime_docker network create --internal --driver bridge --label "com.shrigma.read-runtime-proof=$READ_RUNTIME_LABEL" "$READ_RUNTIME_NETWORK_NAME" 2>/dev/null)"
[[ "$READ_RUNTIME_NETWORK_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$(read_runtime_docker network inspect --format '{{.Driver}}|{{.Internal}}' "$READ_RUNTIME_NETWORK_ID")" = 'bridge|true' ]] || exit 1
READ_RUNTIME_VOLUME_ID="$(read_runtime_docker volume create --label "com.shrigma.read-runtime-proof=$READ_RUNTIME_LABEL" "$READ_RUNTIME_VOLUME_NAME" 2>/dev/null)"
[[ "$READ_RUNTIME_VOLUME_ID" = "$READ_RUNTIME_VOLUME_NAME" ]] || exit 1
# Root CHOWN-only initializer admits an empty NEW volume and changes no old file.
READ_RUNTIME_INIT_ID="$(read_runtime_docker create --name "$READ_RUNTIME_INIT_NAME" --label "com.shrigma.read-runtime-proof=$READ_RUNTIME_LABEL" --network none --user 0:0 --read-only --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges --cpus .1 --memory 64m --memory-swap 64m --pids-limit 16 --mount "type=volume,source=$READ_RUNTIME_VOLUME_ID,target=/runtime-proof" --entrypoint node "$READ_RUNTIME_IMAGE" --max-old-space-size=16 -e 'const fs=require("node:fs");try{if(process.getuid()!==0||process.getgid()!==0||JSON.stringify(fs.readdirSync("/sys/class/net").sort())!==JSON.stringify(["lo"]))throw 0;const p="/runtime-proof",s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&511)!==493||fs.readdirSync(p).length)throw 0;fs.chmodSync(p,448);fs.chownSync(p,1000,1000);const q=fs.lstatSync(p);if(q.uid!==1000||q.gid!==1000||(q.mode&511)!==448)throw 0;}catch{process.exitCode=1;}' 2>/dev/null)"
[[ "$READ_RUNTIME_INIT_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
read_runtime_docker start --attach "$READ_RUNTIME_INIT_ID" >/dev/null 2>&1
[[ "$(read_runtime_docker container inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$READ_RUNTIME_INIT_ID")" = 'exited|0' ]] || exit 1
# Secrets are CSPRNG RAM env entries, never CLI argument values or env files.
POSTGRES_PASSWORD="$(node -p 'require("node:crypto").randomBytes(32).toString("base64url")')"
PG_ADMIN_PASSWORD="$POSTGRES_PASSWORD"
export POSTGRES_PASSWORD PG_ADMIN_PASSWORD
READ_RUNTIME_PG_ID="$(read_runtime_docker create --name "$READ_RUNTIME_PG_NAME" --label "com.shrigma.read-runtime-proof=$READ_RUNTIME_LABEL" --network "$READ_RUNTIME_NETWORK_ID" --network-alias comunicacao_postgres --user postgres --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128 --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=256m,uid=999,gid=999,mode=700 --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m,uid=999,gid=999,mode=755 --tmpfs /tmp:rw,nosuid,nodev,size=16m --mount "type=bind,source=$READ_RUNTIME_INSTALL_DIR/pg_hba.conf,target=/proof/pg_hba.conf,readonly" --env POSTGRES_DB=listmonk --env POSTGRES_PASSWORD --env 'POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=scram-sha-256' postgres:17.10 -c hba_file=/proof/pg_hba.conf -c ssl=off -c password_encryption=scram-sha-256 -c "cluster_name=$READ_RUNTIME_CLUSTER" -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 -c log_transaction_sample_rate=0 2>/dev/null)"
[[ "$READ_RUNTIME_PG_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
read_runtime_docker start "$READ_RUNTIME_PG_ID" >/dev/null 2>&1
READ_RUNTIME_READY=0
for READ_RUNTIME_WAIT in $(seq 1 40); do if read_runtime_docker exec "$READ_RUNTIME_PG_ID" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h 127.0.0.1 -U postgres -d listmonk' >/dev/null 2>&1; then READ_RUNTIME_READY=1; break; fi; sleep 1; done
[[ "$READ_RUNTIME_READY" = 1 ]] || exit 1
READ_RUNTIME_TEST_ID="$(read_runtime_docker create --name "$READ_RUNTIME_TEST_NAME" --label "com.shrigma.read-runtime-proof=$READ_RUNTIME_LABEL" --network "$READ_RUNTIME_NETWORK_ID" --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --cpus .35 --memory 320m --memory-swap 320m --pids-limit 64 --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m --mount "type=bind,source=$READ_RUNTIME_TEMP/source,target=/proof,readonly" --mount "type=volume,source=$READ_RUNTIME_VOLUME_ID,target=/runtime-proof" --env NODE_PATH=/app/node_modules --env PG_ADMIN_PASSWORD --env READ_RUNTIME_NATIVE_OCI_PROOF=1 --env "READ_RUNTIME_CLUSTER=$READ_RUNTIME_CLUSTER" --entrypoint node "$READ_RUNTIME_IMAGE" --max-old-space-size=96 --test /proof/tools/crm-manager-read-activation-review/runtime/native-oci.test.cjs 2>/dev/null)"
[[ "$READ_RUNTIME_TEST_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$(read_runtime_docker container inspect --format '{{len .NetworkSettings.Networks}}|{{len .HostConfig.PortBindings}}' "$READ_RUNTIME_TEST_ID")" = '1|0' ]] || exit 1
unset POSTGRES_PASSWORD PG_ADMIN_PASSWORD
# TAP contains only fixed case names/counts/generic errors; never docker logs.
read_runtime_docker start --attach "$READ_RUNTIME_TEST_ID"
[[ "$(read_runtime_docker container inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$READ_RUNTIME_TEST_ID")" = 'exited|0' ]] || exit 1
READ_RUNTIME_OK=1
