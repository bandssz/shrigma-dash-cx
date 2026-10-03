#!/usr/bin/env bash
# Opt-in isolated Linux Docker smoke. No DB client/SQL/production service.
set -euo pipefail
if [[ "${SHRIGMA_NATIVE_PREFLIGHT_CI:-}" != "1" ]]; then
  printf '%s\n' '{"schema":"crm-manager-native-preflight-ci-v1","phase":"skipped","reason":"explicit_opt_in_required"}'
  exit 0
fi
BASE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME="${2:-${BASE}/../runtime}"
if [[ "${1:-}" != "--inner" ]]; then
  if [[ $# -gt 1 ]]; then exit 1; fi
  RUNTIME="${1:-${BASE}/../runtime}"
  # Parent kill bounds native work independently of a stuck synchronous fsync.
  exec timeout --signal=TERM --kill-after=45s 270s bash "${BASE}/run-preflight-ci.sh" --inner "${RUNTIME}"
fi
if [[ $# != 2 || $(uname -s) != Linux || ! -S /var/run/docker.sock ]]; then
  printf '%s\n' '{"schema":"crm-manager-native-preflight-ci-v1","phase":"refused","reason":"isolated_linux_socket_required"}'
  exit 1
fi
for name in node docker timeout; do command -v "${name}" >/dev/null 2>&1 || exit 1; done
# --config empty prevents use of any login or registry credential on the host.
TASK_DIR="$(mktemp -d /tmp/shrigma-native-preflight-ci.XXXXXXXX)"; chmod 700 "${TASK_DIR}"
mkdir -m 700 "${TASK_DIR}/docker-config"
D_PATH="${PATH}"; PHASE='preflight'; RESULT=1; OWN=0; PROJECT=''; VOLUME=''; META=''; PLAN='';
CANONICAL_CONFIG=false; CANONICAL_HEALTH=false; PIDSLIMIT_CONFIG=false; PIDSLIMIT_HEALTH=false
D(){ env -i PATH="${D_PATH}" timeout --signal=TERM --kill-after=2s 12s docker --host unix:///var/run/docker.sock --config "${TASK_DIR}/docker-config" "$@" 2>/dev/null; }
DC(){ D compose --project-name "${PROJECT}" --file "${PLAN}" "$@"; }
INSPECT='{"id":"{{.Id}}","project":"{{index .Config.Labels "com.docker.compose.project"}}","service":"{{index .Config.Labels "com.docker.compose.service"}}","image":"{{.Config.Image}}","state":"{{.State.Status}}","exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},"health":"{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}","memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"pidsLimit":{{.HostConfig.PidsLimit}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"capDrop":{{json .HostConfig.CapDrop}},"capAdd":{{json .HostConfig.CapAdd}},"securityOpt":{{json .HostConfig.SecurityOpt}},"networkMode":"{{.HostConfig.NetworkMode}}","user":"{{.Config.User}}","init":{{.HostConfig.Init}},"proofVolume":"{{range .Mounts}}{{if eq .Destination "/manager-install-proof"}}{{.Name}}{{end}}{{end}}","portBindingsCount":{{len .HostConfig.PortBindings}},"mountCount":{{len .Mounts}}}'
VINSPECT='{"name":"{{.Name}}","purpose":"{{index .Labels "com.shrigma.purpose"}}","exclusive":"{{index .Labels "com.shrigma.exclusive-service"}}","project":"{{index .Labels "com.docker.compose.project"}}"}'
cleanup_own(){
  [[ ${OWN} == 1 ]] || return 0
  local ids id role safe=true
  if ! ids="$(D ps -aq --filter "label=com.docker.compose.project=${PROJECT}")"; then return 1; fi
  while IFS= read -r id; do
    [[ -n "${id}" ]] || continue
    [[ "${id}" =~ ^[a-f0-9]{12,64}$ ]] || { safe=false; continue; }
    role="$(D inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "${id}" || true)"
    [[ "${role}" == installer || "${role}" == prepare_volume ]] || { safe=false; continue; }
    if D inspect --format "${INSPECT}" "${id}" | node "${BASE}/observe.cjs" owned "${META}" "${role}" >/dev/null 2>&1; then
      D rm --force "${id}" >/dev/null || safe=false
    else safe=false; fi
  done <<< "${ids}"
  if D volume inspect --format "${VINSPECT}" "${VOLUME}" | node "${BASE}/observe.cjs" volume "${META}" >/dev/null 2>&1; then
    D volume rm "${VOLUME}" >/dev/null || safe=false
  else
    local volumes
    if ! volumes="$(D volume ls --filter "name=^${VOLUME}$" --format '{{.Name}}')"; then safe=false;
    elif [[ -n "${volumes}" ]]; then safe=false; fi
  fi
  if [[ "${safe}" != true ]]; then return 1; fi
  OWN=0
}
finish(){
  local code=$?; trap - EXIT TERM INT
  if ! cleanup_own; then PHASE='cleanup_refused'; RESULT=1; fi
  # Only typed booleans are public. No Docker logs/config/argv/SQL/raw errors.
  printf '{"schema":"crm-manager-native-preflight-ci-v1","phase":"%s","canonicalConfigAccepted":%s,"canonicalHealthy":%s,"pidsLimitOnlyConfigAccepted":%s,"pidsLimitOnlyHealthy":%s,"databaseClientLoaded":false,"sqlExecuted":false,"containerExternalNetwork":false}\n' "${PHASE}" "${CANONICAL_CONFIG}" "${CANONICAL_HEALTH}" "${PIDSLIMIT_CONFIG}" "${PIDSLIMIT_HEALTH}"
  rm -rf -- "${TASK_DIR}"
  [[ ${RESULT} == 0 && ${code} == 0 ]] && exit 0
  exit 1
}
trap finish EXIT
trap 'PHASE=deadline; RESULT=1; exit 1' TERM INT
PHASE='image_pull'
IMAGE='ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815'
if ! D image inspect --format '{{.Id}}' "${IMAGE}" >/dev/null; then
  if ! env -i PATH="${D_PATH}" timeout --signal=TERM --kill-after=3s 90s docker --host unix:///var/run/docker.sock --config "${TASK_DIR}/docker-config" pull "${IMAGE}" >/dev/null 2>&1; then exit 1; fi
fi
for profile in canonical pids_limit_only; do
  PHASE='plan'; suffix="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')"; folder="${TASK_DIR}/${profile}"; mkdir -m 700 "${folder}"
  node "${BASE}/build-preflight.cjs" "${suffix}" "${folder}" "${RUNTIME}" "${profile}" >/dev/null 2>&1 || exit 1
  PROJECT="shrigma-native-preflight-${suffix}"; VOLUME="shrigma-native-preflight-volume-${suffix}"; META="${folder}/plan.metadata.json"; PLAN="${folder}/compose.preflight.json"
  PHASE='fresh_resources'
  if ! existing_containers="$(D ps -aq --filter "label=com.docker.compose.project=${PROJECT}")"; then exit 1; fi
  [[ -z "${existing_containers}" ]] || exit 1
  existing_volume="$(D volume ls --filter "name=^${VOLUME}$" --format '{{.Name}}')"
  [[ -z "${existing_volume}" ]] || exit 1
  PHASE='compose_config'
  if ! DC config --format json | node "${BASE}/observe.cjs" config "${META}" "${PLAN}" >/dev/null 2>&1; then continue; fi
  if [[ ${profile} == canonical ]]; then CANONICAL_CONFIG=true; else PIDSLIMIT_CONFIG=true; fi
  PHASE='compose_up'; OWN=1
  if ! DC up --detach >/dev/null; then cleanup_own || exit 1; continue; fi
  PHASE='healthy'; success=false; end=$((SECONDS+70))
  while ((SECONDS<end)); do
    initid="$(DC ps --all --quiet prepare_volume || true)"; runtimeid="$(DC ps --all --quiet installer || true)"
    if [[ "${initid}" =~ ^[a-f0-9]{12,64}$ && "${runtimeid}" =~ ^[a-f0-9]{12,64}$ ]]; then
      a="$(D inspect --format "${INSPECT}" "${initid}" | node "${BASE}/observe.cjs" state "${META}" prepare_volume 2>/dev/null || true)"
      b="$(D inspect --format "${INSPECT}" "${runtimeid}" | node "${BASE}/observe.cjs" state "${META}" installer 2>/dev/null || true)"
      if [[ "${a}" == ready && "${b}" == ready ]]; then success=true; break; fi
      if [[ "${a}" == failed || "${b}" == failed || "${a}" == refused || "${b}" == refused ]]; then break; fi
    fi
    sleep 2
  done
  if [[ ${profile} == canonical ]]; then CANONICAL_HEALTH="${success}"; else PIDSLIMIT_HEALTH="${success}"; fi
  PHASE='cleanup'; cleanup_own || exit 1
 done
if [[ ${CANONICAL_CONFIG} == true && ${CANONICAL_HEALTH} == true && ${PIDSLIMIT_CONFIG} == true && ${PIDSLIMIT_HEALTH} == true ]]; then PHASE='passed'; RESULT=0; else PHASE='compatibility_or_runtime_refused'; RESULT=1; fi
[[ ${RESULT} == 0 ]]
