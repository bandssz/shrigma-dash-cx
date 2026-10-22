#!/usr/bin/env bash
set -euo pipefail
if [[ ${READ_MANUAL_RECONCILE_OCI_PROOF:-0} != 1 || ${CI:-false} != true ]]; then
  printf '%s\n' '{"state":"OFF","dockerCalls":0,"postgresCalls":0}'
  exit 0
fi
if [[ -z ${READ_RECONCILE_RUNTIME_DIRECTORY:-} ]]; then
  printf '%s\n' '{"state":"REFUSED","reason":"PUBLIC_RUNTIME_DIRECTORY_REQUIRED"}'
  exit 1
fi
task_oci_directory=$(cd -- "$(dirname -- "$0")" && pwd -P)
exec node "$task_oci_directory/oci-proof.cjs" --approved-ci-only "$READ_RECONCILE_RUNTIME_DIRECTORY"
