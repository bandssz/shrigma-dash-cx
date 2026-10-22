#!/usr/bin/env bash
# Only future opt-in Linux CI. Fresh isolated resources; no panel/production.
set +x
set -euo pipefail
[[ "${CRM_WRITER_BROKER_NATIVE_PROOF:-}" = 1 && "$(uname -s)" = Linux ]] || { printf '%s\n' WRITER_BROKER_NATIVE_REFUSED >&2; exit 1; }
[[ -x /usr/bin/docker && -S /var/run/docker.sock && "$(node -p 'process.versions.node.split(".")[0]')" = 22 ]] || exit 1
WRITER_BROKER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WRITER_BROKER_REPO="$(cd -- "$WRITER_BROKER_DIR/../../.." && pwd -P)"
WRITER_BROKER_TEMP="$(mktemp -d)"
WRITER_BROKER_DOCKER_CONFIG="$WRITER_BROKER_TEMP/docker-config"
mkdir -m 700 "$WRITER_BROKER_DOCKER_CONFIG"
WRITER_BROKER_NONCE="$(node -p 'require("node:crypto").randomBytes(8).toString("hex")')"
[[ "$WRITER_BROKER_NONCE" =~ ^[a-f0-9]{16}$ ]] || exit 1
WRITER_BROKER_LABEL="writer-broker-$WRITER_BROKER_NONCE"
WRITER_BROKER_CLUSTER="shrigma-writer-broker-$WRITER_BROKER_NONCE"
WRITER_BROKER_PG_NAME="$WRITER_BROKER_LABEL-pg"
WRITER_BROKER_CLIENT_NAME="$WRITER_BROKER_LABEL-client"
WRITER_BROKER_NETWORK_NAME="$WRITER_BROKER_LABEL-network"
WRITER_BROKER_PG_ID= WRITER_BROKER_CLIENT_ID= WRITER_BROKER_NETWORK_ID=
WRITER_BROKER_OK=0
writer_broker_docker(){ env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_CONFIG -u DOCKER_CUSTOM_HEADERS /usr/bin/docker --config "$WRITER_BROKER_DOCKER_CONFIG" --host unix:///var/run/docker.sock "$@"; }
writer_broker_cleanup(){
 local failed=0 id
 for id in "$WRITER_BROKER_CLIENT_ID" "$WRITER_BROKER_PG_ID"; do
  if [[ "$id" =~ ^[a-f0-9]{64}$ ]]; then
   if [[ "$(writer_broker_docker container inspect --format '{{ index .Config.Labels "com.shrigma.writer-broker-proof" }}' "$id" 2>/dev/null)" = "$WRITER_BROKER_LABEL" ]]; then
    writer_broker_docker rm --force --volumes "$id" >/dev/null 2>&1 || failed=1
    if writer_broker_docker container inspect "$id" >/dev/null 2>&1; then failed=1; fi
   else failed=1; fi
  fi
 done
 if [[ "$WRITER_BROKER_NETWORK_ID" =~ ^[a-f0-9]{64}$ ]]; then
  if [[ "$(writer_broker_docker network inspect --format '{{ index .Labels "com.shrigma.writer-broker-proof" }}' "$WRITER_BROKER_NETWORK_ID" 2>/dev/null)" = "$WRITER_BROKER_LABEL" ]]; then
   writer_broker_docker network rm "$WRITER_BROKER_NETWORK_ID" >/dev/null 2>&1 || failed=1
   if writer_broker_docker network inspect "$WRITER_BROKER_NETWORK_ID" >/dev/null 2>&1; then failed=1; fi
  else failed=1; fi
 fi
 unset POSTGRES_PASSWORD PG_ADMIN_PASSWORD
 rm -rf -- "$WRITER_BROKER_TEMP"
 if [[ "$WRITER_BROKER_OK" != 1 || "$failed" != 0 ]]; then printf '%s\n' WRITER_BROKER_NATIVE_FAILED >&2; trap - EXIT; exit 1; fi
}
trap writer_broker_cleanup EXIT
trap 'exit 1' INT TERM
for WRITER_BROKER_NAME in "$WRITER_BROKER_PG_NAME" "$WRITER_BROKER_CLIENT_NAME"; do if writer_broker_docker container inspect "$WRITER_BROKER_NAME" >/dev/null 2>&1; then exit 1; fi; done
if writer_broker_docker network inspect "$WRITER_BROKER_NETWORK_NAME" >/dev/null 2>&1; then exit 1; fi
# Exact public source admission happens before copying. No checkout/.git/env mount.
node -e 'require(process.argv[1]).checkedSources(process.argv[2])' "$WRITER_BROKER_DIR/native-broker.test.cjs" "$WRITER_BROKER_REPO" >/dev/null 2>&1
mkdir -p "$WRITER_BROKER_TEMP/source"
while IFS= read -r WRITER_BROKER_FILE; do
 [[ "$WRITER_BROKER_FILE" != *..* && "$WRITER_BROKER_FILE" != /* ]] || exit 1
 mkdir -p "$WRITER_BROKER_TEMP/source/$(dirname -- "$WRITER_BROKER_FILE")"
 cp -- "$WRITER_BROKER_REPO/$WRITER_BROKER_FILE" "$WRITER_BROKER_TEMP/source/$WRITER_BROKER_FILE"
done < <(node -e 'for(const p of Object.keys(require(process.argv[1]).PINS))process.stdout.write(p+"\n")' "$WRITER_BROKER_DIR/native-broker.test.cjs")
mkdir -p "$WRITER_BROKER_TEMP/source/tools/crm-manager-writer-review/broker"
cp -- "$WRITER_BROKER_DIR/native-broker.test.cjs" "$WRITER_BROKER_TEMP/source/tools/crm-manager-writer-review/broker/"
[[ "$(sha256sum "$WRITER_BROKER_REPO/tools/crm-manager-install-review/pg_hba.conf" | cut -d ' ' -f 1)" = a2501b162522dd9b062c5f85004e1c36ba6473ec2fa5c4c99ca8f922717266e3 ]] || exit 1
cp -- "$WRITER_BROKER_REPO/tools/crm-manager-install-review/pg_hba.conf" "$WRITER_BROKER_TEMP/pg_hba.conf"
find "$WRITER_BROKER_TEMP/source" -type d -exec chmod 755 {} +
find "$WRITER_BROKER_TEMP/source" -type f -exec chmod 444 {} +
chmod 444 "$WRITER_BROKER_TEMP/pg_hba.conf"
chmod 755 "$WRITER_BROKER_TEMP"
WRITER_BROKER_IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815'
WRITER_BROKER_PG_IMAGE='postgres:17.10@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
writer_broker_docker pull --quiet "$WRITER_BROKER_IMAGE" >/dev/null 2>&1
writer_broker_docker pull --quiet "$WRITER_BROKER_PG_IMAGE" >/dev/null 2>&1
[[ "$(writer_broker_docker image inspect --format '{{len .Config.Volumes}}|{{.Config.User}}' "$WRITER_BROKER_IMAGE")" = '0|1000:1000' ]] || exit 1
WRITER_BROKER_NETWORK_ID="$(writer_broker_docker network create --internal --driver bridge --label "com.shrigma.writer-broker-proof=$WRITER_BROKER_LABEL" "$WRITER_BROKER_NETWORK_NAME" 2>/dev/null)"
[[ "$WRITER_BROKER_NETWORK_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$(writer_broker_docker network inspect --format '{{.Driver}}|{{.Internal}}' "$WRITER_BROKER_NETWORK_ID")" = 'bridge|true' ]] || exit 1
# Synthetic CSPRNG credentials exist only in RAM/env; no values in argv/files/logs.
POSTGRES_PASSWORD="$(node -p 'require("node:crypto").randomBytes(32).toString("base64url")')"
PG_ADMIN_PASSWORD="$POSTGRES_PASSWORD"
export POSTGRES_PASSWORD PG_ADMIN_PASSWORD
WRITER_BROKER_PG_ID="$(writer_broker_docker create --name "$WRITER_BROKER_PG_NAME" --label "com.shrigma.writer-broker-proof=$WRITER_BROKER_LABEL" --log-driver none --network "$WRITER_BROKER_NETWORK_ID" --network-alias comunicacao_postgres --user postgres --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128 --no-healthcheck --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=256m,uid=999,gid=999,mode=700 --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m,uid=999,gid=999,mode=755 --tmpfs /tmp:rw,nosuid,nodev,size=16m --mount "type=bind,source=$WRITER_BROKER_TEMP/pg_hba.conf,target=/proof/pg_hba.conf,readonly" --env POSTGRES_DB=listmonk --env POSTGRES_PASSWORD --env 'POSTGRES_INITDB_ARGS=--auth-local=trust --auth-host=scram-sha-256' "$WRITER_BROKER_PG_IMAGE" -c hba_file=/proof/pg_hba.conf -c ssl=off -c password_encryption=scram-sha-256 -c "cluster_name=$WRITER_BROKER_CLUSTER" -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 -c log_min_duration_statement=-1 -c log_min_duration_sample=-1 -c log_transaction_sample_rate=0 2>/dev/null)"
[[ "$WRITER_BROKER_PG_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
writer_broker_docker start "$WRITER_BROKER_PG_ID" >/dev/null 2>&1
WRITER_BROKER_READY=0
for WRITER_BROKER_WAIT in $(seq 1 40); do if writer_broker_docker exec "$WRITER_BROKER_PG_ID" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -h 127.0.0.1 -U postgres -d listmonk' >/dev/null 2>&1; then WRITER_BROKER_READY=1; break; fi; sleep 1; done
[[ "$WRITER_BROKER_READY" = 1 ]] || exit 1
WRITER_BROKER_CLIENT_ID="$(writer_broker_docker create --name "$WRITER_BROKER_CLIENT_NAME" --label "com.shrigma.writer-broker-proof=$WRITER_BROKER_LABEL" --log-driver none --network "$WRITER_BROKER_NETWORK_ID" --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --cpus .35 --memory 320m --memory-swap 320m --pids-limit 64 --no-healthcheck --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777 --mount "type=bind,source=$WRITER_BROKER_TEMP/source,target=/proof,readonly" --env NODE_PATH=/app/node_modules --env PG_ADMIN_PASSWORD --env CRM_WRITER_BROKER_NATIVE_PROOF=1 --env "CRM_WRITER_BROKER_CLUSTER=$WRITER_BROKER_CLUSTER" --entrypoint node "$WRITER_BROKER_IMAGE" --max-old-space-size=96 --test /proof/tools/crm-manager-writer-review/broker/native-broker.test.cjs 2>/dev/null)"
[[ "$WRITER_BROKER_CLIENT_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
for WRITER_BROKER_ID in "$WRITER_BROKER_PG_ID" "$WRITER_BROKER_CLIENT_ID"; do
 [[ "$(writer_broker_docker container inspect --format '{{len .NetworkSettings.Networks}}|{{len .HostConfig.PortBindings}}|{{.HostConfig.ReadonlyRootfs}}' "$WRITER_BROKER_ID")" = '1|0|true' ]] || exit 1
done
unset POSTGRES_PASSWORD PG_ADMIN_PASSWORD
# Only closed fixed TAP case names/generic errors/proof JSON are streamed.
writer_broker_docker start --attach "$WRITER_BROKER_CLIENT_ID"
[[ "$(writer_broker_docker container inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$WRITER_BROKER_CLIENT_ID")" = 'exited|0' ]] || exit 1
WRITER_BROKER_OK=1
