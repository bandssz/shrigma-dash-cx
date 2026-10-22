#!/usr/bin/env bash
# Opt-in Linux candidate CI only. No PG, application runtime or private env.
set +x
set -euo pipefail
[[ "${READ_COMPOSE_OCI_PREFLIGHT:-}" = 1 && "$(uname -s)" = Linux ]] || { printf '%s\n' 'READ_COMPOSE_OCI_PREFLIGHT_REFUSED' >&2; exit 1; }
[[ -x /usr/bin/docker && -S /var/run/docker.sock && "$(node -p 'process.versions.node.split(".")[0]')" = 22 ]] || { printf '%s\n' 'READ_COMPOSE_OCI_PREFLIGHT_REFUSED' >&2; exit 1; }
READ_COMPOSE_PREFLIGHT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec node "$READ_COMPOSE_PREFLIGHT_DIR/oci-preflight.cjs" --oci
