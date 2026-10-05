#!/usr/bin/env bash
# Candidate CI only. Starts the built WRITER image OFF, with no network or PG.
set +x
set -euo pipefail
[[ "${CRM_WRITER_IMAGE_OFF_PROOF:-}" = 1 && "$(uname -s)" = Linux ]] || exit 1
[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ && -x /usr/bin/docker && -S /var/run/docker.sock ]] || exit 1
WRITER_OFF_TEMP="$(mktemp -d)"
mkdir -m 700 "$WRITER_OFF_TEMP/docker-config"
WRITER_OFF_LABEL="writer-off-$(node -p 'require("node:crypto").randomBytes(8).toString("hex")')"
WRITER_OFF_ID= WRITER_OFF_OK=0
writer_off_docker(){ env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_CONFIG -u DOCKER_CUSTOM_HEADERS /usr/bin/docker --config "$WRITER_OFF_TEMP/docker-config" --host unix:///var/run/docker.sock "$@"; }
writer_off_cleanup(){
 local failed=0
 if [[ "$WRITER_OFF_ID" =~ ^[a-f0-9]{64}$ ]]; then
  if [[ "$(writer_off_docker container inspect --format '{{index .Config.Labels "com.shrigma.writer-off-proof"}}' "$WRITER_OFF_ID" 2>/dev/null)" = "$WRITER_OFF_LABEL" ]]; then
   writer_off_docker rm --force "$WRITER_OFF_ID" >/dev/null 2>&1 || failed=1
   if writer_off_docker container inspect "$WRITER_OFF_ID" >/dev/null 2>&1; then failed=1; fi
  else failed=1; fi
 fi
 rm -rf -- "$WRITER_OFF_TEMP"
 if [[ "$WRITER_OFF_OK" != 1 || "$failed" != 0 ]]; then printf '%s\n' WRITER_IMAGE_OFF_PROOF_FAILED >&2; trap - EXIT; exit 1; fi
}
trap writer_off_cleanup EXIT
trap 'exit 1' INT TERM
[[ "$(writer_off_docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{len .Config.Volumes}}|{{.Config.User}}' shrigma-crm-manager-writer:ci)" = "$GITHUB_SHA|0|1000:1000" ]] || exit 1
WRITER_OFF_ID="$(writer_off_docker create --name "$WRITER_OFF_LABEL" --label "com.shrigma.writer-off-proof=$WRITER_OFF_LABEL" --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777 --memory 128m --memory-swap 128m --cpus .25 --pids-limit 32 --no-healthcheck --log-driver none shrigma-crm-manager-writer:ci)"
[[ "$WRITER_OFF_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$(writer_off_docker container inspect --format '{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.PidsLimit}}' "$WRITER_OFF_ID")" = 'none|true|134217728|134217728|250000000|32' ]] || exit 1
writer_off_docker start "$WRITER_OFF_ID" >/dev/null
WRITER_OFF_HEALTH=0
for WRITER_OFF_WAIT in $(seq 1 30); do
 if writer_off_docker exec "$WRITER_OFF_ID" node -e 'fetch("http://127.0.0.1:8080/healthz",{signal:AbortSignal.timeout(2000)}).then(async r=>{const b=await r.json();if(r.status!==200||b.service!=="crm-manager-writer"||b.revision!==process.env.CRM_WRITER_REVISION||b.enabled!==false||b.ready!==false||b.policy.namespaceBound!==false)throw Error();}).catch(()=>process.exitCode=1);' >/dev/null 2>&1; then WRITER_OFF_HEALTH=1; break; fi
 [[ "$(writer_off_docker container inspect --format '{{.State.Running}}' "$WRITER_OFF_ID")" = true ]] || exit 1
 sleep 1
done
[[ "$WRITER_OFF_HEALTH" = 1 ]] || exit 1
writer_off_docker exec "$WRITER_OFF_ID" node -e 'const a=require("node:assert/strict"),fs=require("node:fs"),M=require("node:module"),load=M._load;a.equal(process.getuid(),1000);a.equal(process.getgid(),1000);a.deepEqual(fs.readdirSync("/app").sort(),["admission.cjs","node_modules","package-lock.json","package.json","server.cjs","wire.cjs"]);a.equal(require("/app/node_modules/pg/package.json").version,"8.13.1");M._load=function(id,...rest){if(id==="pg")throw Error("PG_LOAD_REFUSED");return Reflect.apply(load,this,[id,...rest]);};const s=require("/app/server.cjs"),c=s.config({...process.env}),app=s.createServer({revision:c.revision});a.equal(c.enabled,false);a.equal(app.server.listening,false);a.deepEqual(app.pending(),{active:0,queued:0,handling:0});' >/dev/null
WRITER_OFF_OK=1
printf '%s\n' 'WRITER image OFF: real CMD, loopback health, fixed revision, UID1000, closed files, no PG material, no network, bounded resources.'
