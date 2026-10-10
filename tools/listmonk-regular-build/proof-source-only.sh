#!/usr/bin/env bash
# Disposable functional CI: synthetic running campaigns and loopback SMTP only. No original calls, OCI or deploy.
set -euo pipefail
node -e "if(process.version!=='v22.23.3'||process.getuid()!==1000)process.exit(1)"
test "${REGULAR_NATIVE_PROOF_ISOLATED:-}" = 1
"$GO_BINARY" version
"$PG_BINARY_DIR/postgres" --version
node tools/listmonk-regular-build/materialize_batch_profile.cjs \
  --profile "$PROFILE_INPUT" --sha256 "$PROFILE_DIGEST" \
  --out "$TASK_OUTPUT/profile" > "$TASK_OUTPUT/profile-receipt.json"
SOURCE_PROFILE="$TASK_OUTPUT/profile/PROFILE.json"
SOURCE_DIGEST="$(sha256sum "$SOURCE_PROFILE" | cut -d ' ' -f1)"
python3 tools/listmonk-regular-package/build.py \
  --source-archive "$REVIEWED_INPUTS/listmonk-upstream.tar.gz" \
  --smtp-archive "$REVIEWED_INPUTS/smtppool.zip" \
  --release-cache "$REVIEWED_INPUTS" --go "$GO_BINARY" \
  --target linux_amd64 --out "$TASK_OUTPUT/package" \
  --batch-profile "$SOURCE_PROFILE" --batch-profile-sha256 "$SOURCE_DIGEST"
(
  cd "$TASK_OUTPUT/package/source/listmonk"
  GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off "$GO_BINARY" test \
    ./cmd/manager_store_batch_jit.go ./cmd/manager_store_batch_jit_test.go
)
mkdir "$TASK_OUTPUT/runtime"
python3 tools/listmonk-regular-build/dependencies_proof.py \
  --profile "$SOURCE_PROFILE" --profile-sha256 "$SOURCE_DIGEST" \
  --pg-bin "$PG_BINARY_DIR" --source-dir "$REVIEWED_INPUTS/source" \
  --runtime-dir "$TASK_OUTPUT/runtime" --node-path "$NODE_PATH" \
  --report "$TASK_OUTPUT/dependency-proof.json"
node tools/listmonk-regular-build/materialize_batch_profile.cjs \
  --profile "$SOURCE_PROFILE" --sha256 "$SOURCE_DIGEST" \
  --build-manifest "$TASK_OUTPUT/package/manifest.json" \
  --out "$TASK_OUTPUT/profile-with-binary"

BINARY_PROFILE="$TASK_OUTPUT/profile-with-binary/PROFILE.json"
BINARY_PROFILE_DIGEST="$(sha256sum "$BINARY_PROFILE" | cut -d ' ' -f1)"
python3 tools/listmonk-regular-build/native_proof.py \
  --binary "$TASK_OUTPUT/package/candidate/listmonk" \
  --source-dir "$TASK_OUTPUT/package/source/listmonk" \
  --pg-bin "$PG_BINARY_DIR" --runtime-dir "$TASK_OUTPUT/runtime" --node-path "$NODE_PATH" \
  --batch-profile "$BINARY_PROFILE" --batch-profile-sha256 "$BINARY_PROFILE_DIGEST" \
  --isolated-source-proof --report "$TASK_OUTPUT/native-functional-proof.json"
python3 - "$TASK_OUTPUT/native-functional-proof.json" <<'CHECK'
import json,sys
r=json.load(open(sys.argv[1]));p=r.get('isolated_source_proof',{})
assert r['status']=='PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED' and r['cluster_stopped'] is True
assert p.get('accepted') is True and p.get('loopbackSMTPAccepted') is True
assert all(p.get(k) is False for k in ('originalPerformanceAccepted','originalOperational','originalDispatchProved'))
CHECK
