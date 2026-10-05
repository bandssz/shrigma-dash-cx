#!/usr/bin/env bash
# Only opt-in candidate Linux CI; fresh public volumes and network-none probe.
set +x
set -euo pipefail
[[ "$READ_BOOTSTRAP_HANDOFF_OCI" = 1 && "$(uname -s)" = Linux ]] || exit 1
[[ -x /usr/bin/docker && -S /var/run/docker.sock && "$(node -p 'process.versions.node.split(".")[0]')" = 22 ]] || exit 1
READ_HANDOFF_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
exec node "$READ_HANDOFF_DIR/bootstrap-handoff-preflight.cjs" --oci
