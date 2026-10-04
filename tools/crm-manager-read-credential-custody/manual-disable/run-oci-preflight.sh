#!/usr/bin/env bash
set -euo pipefail
if [[ ${MANUAL_DISABLE_OCI_PROOF:-0} != 1 || ${CI:-false} != true ]]; then
  printf '%s\n' '{"state":"OFF","dockerCalls":0,"postgresCalls":0}'
  exit 0
fi
task_script_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
exec node "$task_script_dir/oci-preflight.cjs" --approved-ci-only
