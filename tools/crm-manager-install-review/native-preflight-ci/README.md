# Isolated OCI preflight; no SQL or database client

Validation tools for the candidate branch only. The reviewed correction is also present in `../runtime/compose/bootstrap.cjs`; the eight staged sources and SQL are unchanged. The workflow runs this isolated proof in its own validation job. Preparing and testing these files does not run Docker, Easypanel, remote HTTP, credentials, SQL or production operations.

## Minimal initializer correction

`bootstrap.fixed.cjs` (0292fb5e…) differs from the frozen 804e bootstrap only in its final initializer check. After `chmod(0700)` and `chown(1000:1000)`, root with CHOWN as its only capability can inspect metadata but cannot enumerate the directory. The corrected final check uses `lstat` only. It verifies directory type, absence of symlink, owner and mode. Root proves emptiness before transfer; the exact runtime guard independently proves emptiness again as UID1000 before staging. There are no new capabilities and no weaker modes or volume guards. `bootstrap.original.cjs` is the unchanged public 804e source retained solely to reproduce this Linux DAC failure in a synthetic filesystem. It is never used for the OCI smoke.

## What the CI smoke proves

The immutable image is `ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815`. Native guards require Node22 and package metadata `pg`8.13.1, but the smoke never imports `pg`, constructs a client/pool, loads the executor/supervisor, invokes runner.run, or executes SQL. It stages and hashes the same eight public source files into read-only tmpfs files; SQL is treated exclusively as inert bytes.

The initializer runs as root with CHOWN only, 64MiB memory/swap, 0.1CPU, 16PIDs and heap16. The runtime runs as UID/GID1000 with no capabilities, 256MiB memory/swap, 0.25CPU, 32PIDs and heap96. Root filesystem is read-only, no-new-privileges and init are enabled, restart is disabled, the runtime review tmpfs has size64MiB and nosuid/nodev/noexec flags, and both containers use `network_mode: none`. No ports, external network, env_file, database settings or caller secrets exist. A fixed noncredential marker exists briefly in runtime memory to exercise the unchanged guard; it is deleted before proof staging.

A new proof volume is admitted only if empty and root-owned. The runtime writes a closed, public proof with mode0600/O_EXCL/O_NOFOLLOW and fsyncs file and directory. Independent descriptor/inode/owner/mode and file/directory fsync checks precede local HTTP Health, and repeat for every Health request. The Health endpoint binds only to loopback inside the networkless container. Docker Healthy therefore provides indirect evidence of this fixed guard/barrier; the job does not expose raw proof contents, logs, environment, command arguments, SQL, or raw errors.

The no-SQL OCI job runs the canonical Compose profile only, which is also the profile used by the isolated server smoke. Its configuration must pass the existing observer, and the bounded runtime must become Healthy with all resource and ownership checks intact. The optional `pids_limit_only` normalization remains covered by pure tests; it is not exercised against Docker or the server. The closed job summary marks it with `pidsLimitOnlyAttempted:false`, and the two older optional-variant result fields remain false. They do not prevent a positive canonical result.

This change neither accepts zero PID limits nor changes kernel guards, capabilities, memory, swap, source pins, image digest, exclusive cleanup or deadlines. A successful no-SQL smoke remains distinct from approval to install database objects, activate credentials or direct production traffic.

## Commands after integration

Pure fixtures, no Docker or real filesystem/kernel reads:

```sh
node tools/crm-manager-install-review/native-preflight-ci/preflight.test.cjs
node tools/crm-manager-install-review/native-preflight-ci/observe.test.cjs
```

Opt-in OCI smoke on a disposable Linux CI VM:

```sh
SHRIGMA_NATIVE_PREFLIGHT_CI=1 bash tools/crm-manager-install-review/native-preflight-ci/run-preflight-ci.sh
```

The script requires the local Unix socket `/var/run/docker.sock`. Docker receives an empty, task-specific config and an empty environment apart from PATH; it cannot reuse host registry credentials or remote Docker contexts. An already-cached exact immutable image can be used; otherwise the pull is anonymous. If GHCR is private, the job refuses without pulling. Any separate CI mechanism that preloads this immutable image requires its own review; this package includes no registry login or secret.

The canonical profile uses random new project and volume names and refuses existing resources. Only its containers, verified through exact Compose project/service labels, and its volume, verified through exact purpose/project/exclusive labels, can be removed. There is no prune, blind compose down, host bind, existing-volume adoption, or unrelated resource deletion. Cleanup remains subject to a Docker-daemon failure; the outer timeout bounds work to 270seconds plus a maximum45second termination allowance. The disposable CI host is the final isolation boundary. The configured peak is 320MiB, 0.35CPU and 48PIDs.

## Evidence and limits

Preparation proved the old initializer fails at the post-chown enumeration in a CHOWN-only DAC model and the corrected initializer passes. Runtime fixtures reject an already-consumed volume, wrong owner/mode, capability drift and fsync failure. Entry-point VM fixtures stage eight pinned sources without database imports or SQL execution. Closed observer fixtures reject extra fields, foreign resource ownership, unbounded resources and an unhealthy/partial state.

Actual positive OCI execution must be confirmed in the check for the exact commit. This smoke does not establish Easypanel's native Compose compatibility, database authentication, TLS, installation/rollback success, issuer readiness, login, or production publication. It supplies no authorization for any database DDL, LOGIN, password, issuer, service activation, domain, route, traffic or legacy ACL changes. The SQL V3/rollback and their pins remain untouched.

Outputs contain only a closed phase enum and booleans for the canonical config/Health results, plus explicit false fields for the omitted optional variant. Original Docker error bodies and container logs are deliberately discarded. A refusal therefore identifies a failed stage without exposing raw diagnostic content; any further debugging must remain within this isolated CI and use a reviewed metadata-only projection.

O bootstrap atual `3edd7e68` também atualiza somente os pins do executor/supervisor para o orçamento transacional privado de 500ms. O bootstrap original804e continua congelado como reprodução histórica do problema de DAC. Os guards de volume, capacidades, imagem e recursos permanecem iguais.
