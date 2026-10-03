# CRM manager provisioner — dormant internal candidate

This service is not installed, built, deployed, enabled, or connected to a real database. It is separate from `crm-panel-read` and the portal. The first administrative credential and all unmanaged identities stay outside its namespace. Edition is unavailable; every issued credential is a manager with Growth/read capabilities only.

`server.cjs` exports `createServer({pool,issuerId,namespaceId,allowedEmailDomains,provisionerToken,revision,enabled:false,...})`. Requiring the file does not read environment, import pg, start a socket or connect a database. Tests inject a pool and IncomingMessage/ServerResponse fixtures; they use no sockets. `enabled` is false by default.

The BFF alone calls the exact HTTPS hostname `comunicacao-crm-manager-provisioner.tazdb8.easypanel.host`, with no query/trailing slash, using `Authorization: CRM-Provisioner <separate service token>`. Browser Origin requests, CORS/preflight, wrong Host, duplicate authentication, manager Bearer, arbitrary SQL and extra fields are rejected before SQL. TLS terminates at the internal ingress; direct application port must not be exposed publicly. Restrict network ingress to the BFF and egress to this service's dedicated PostgreSQL connection. A new registry row must bind `session_user=crm_manager_provisioner` to the configured issuer/namespace; the SQL functions recheck both values independently.

POST routes and fixed queries:

| Path | Action | PostgreSQL function |
| --- | --- | --- |
| `/internal/v1/crm-managers/prepare` | `prepare_read`, `renew_read` | `public.shrigma_crm_manager_prepare_v1(jsonb)` |
| `/internal/v1/crm-managers/commit` | `commit_read` | `public.shrigma_crm_manager_commit_v1(jsonb)` |
| `/internal/v1/crm-managers/revoke` | `revoke_read` | `public.shrigma_crm_manager_revoke_v1(jsonb)` |
| `/internal/v1/crm-managers/status` | `status` | `public.shrigma_crm_manager_status_v1(jsonb)` |

Each query is exactly `SELECT public.<fixed function>($1::jsonb) AS body`, with one bound canonical JSON parameter. One autocommit SELECT runs one PostgreSQL transaction containing the entire function; no transaction is split across HTTP calls. Functions return one jsonb value. SQL error-schema codes map to the same status codes as the closed BFF client. Response schema, scope, operation fingerprint, identity, policy, generation, predecessor and dates are checked before replying. Unknown rows/errors/data are replaced with `UNAVAILABLE`, never SQL errors or raw bodies.

Wire compatibility is with `services/dashboard-operational/crm-manager-provisioning.cjs` pin `723bca94435efe08bea98fdd3ceec450264b7e7001d57c42f7a427384ec087a5`. Body must be the client's canonical JSON: lexically sorted object keys, compact JSON, exact read caps, candidate TTL 600000 ms and final lifetime 1209600000 ms anchored to original prepare. Canonical form also rejects duplicate keys/ambiguous representations. The only manager material accepted is `keySha256`, computed in the BFF; a 64-hex digest cannot mathematically prove its preimage, so the journal must perform SHA-256 before passing it. No manager bearer/password/ciphertext reaches this gateway.

Authenticated, valid commands return full bound receipts. Early transport/auth/body errors return a minimal fixed error schema without request bindings; the client rejects these generically. No headers, body, digest, owner, service token, SQL exception or pg connection options are logged. Startup/pool errors have fixed messages only. Health contains only service revision, enabled/stopping flags and the fixed role/read/namespace policy; it neither queries pg nor reveals issuer/namespace IDs or credentials.

Limits: request headers 8 KiB, body 4 KiB incremental, strict final UTF-8 decoding, JSON response 8 KiB, one active SQL query, at most two queued handlers, body deadline 1 s, total application deadline 4 s, PostgreSQL statement timeout 3 s/query timeout 3.5 s. HTTP expiry/peer disconnect does not free the SQL admission slot until the query promise settles. Queued requests that expire/disconnect never reach PostgreSQL. Pool max=1, connection timeout 1 s. Responses are private/no-store, without CORS. No automatic HTTP or SQL retry occurs.

Runtime configuration is loaded only by explicit startup: `PGHOST`, `PGPORT`, `PGDATABASE=listmonk`, `PGUSER=crm_manager_provisioner`, `PGPASSWORD`, `CRM_MANAGER_ISSUER_ID`, `CRM_MANAGER_NAMESPACE_ID`, `CRM_MANAGER_ALLOWED_EMAIL_DOMAINS` (JSON array), `CRM_MANAGER_PROVISIONER_TOKEN`, `CRM_MANAGER_REVISION` (40-hex source revision), and optional `CRM_MANAGER_ENABLED=true`/`PORT=8080`. Keep these server-side, outside images/browser/assets/repository. The role must have no memberships, no direct table privileges, no CREATE/ALTER, and EXECUTE only on the four reviewed functions; never use postgres, the master key, or `crm_panel_reader`.

Deployment policy, not executed here: one replica, 128 MiB memory, 0.25 CPU, UID/GID 1000, read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, no Docker socket/mounts and no privileged mode. Allow small private tmpfs only if needed by the platform. Use the pinned Node22 base and pg 8.13.1 matching neighboring services. The lockfile fixes all 13 public npm packages with SHA-512 integrity, reusing the reviewed neighboring service's dependency entries. An isolated offline `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` verified all cached tarballs and installed versions; none has install lifecycle hooks. This proves dependency installation, without building an image or opening a connection.

Build context must be this service directory, not the repository root. Its `.dockerignore` denies everything except the exact `package.json`, `package-lock.json`, `server.cjs` and `Dockerfile` names; tests, other JSON files, private directories, environment files and symlinks from outside the context are excluded. Docker consumes its ignore metadata implicitly. The Dockerfile copies only the two manifests and server source, uses `npm ci`, and requires a 40-hex `GIT_SHA` image revision. From the repository root, the future CI command is:

```sh
docker build --file services/crm-manager-provisioner/Dockerfile --build-arg GIT_SHA="$GITHUB_SHA" --tag shrigma-crm-manager-provisioner:ci services/crm-manager-provisioner
```

No secrets are required for a build. Docker build, database migration, service registry/role creation, ingress/TLS/auth config and real ACL/restore tests have not run. A pushed candidate image must be recorded by its resulting registry digest; no image digest is claimed by this offline dependency proof.

Run `node --test services/crm-manager-provisioner/server.test.cjs` on Node22 from the repository root. The suite needs the local PGlite test dependency available to the SQL owner's fixture; it is not a production dependency or included in the Docker image. The 19 author tests cover the injected HTTP/pool boundary and the pinned BFF client → gateway → exact SQL in disposable PGlite, entirely in process. The joint fixture proves prepare/replay/commit/status/renew/revoke, predecessor deactivation, terminal status errors, editing refusal before transport and unchanged legacy administrator/grants. It also recovers a lost prepare ACK through the original immutable status receipt after expiry/replacement; the recovered candidate retains its dates and cannot be committed. SQL proposal pin: `be6d670b90cd30977bc0ad2ffd8e7bd2e1d67d58727ef9fa616c2d07c2b813b4`. Independent gateway review passed 19 adversarial groups against the same source.

Before enabling, prove the BFF journal/client + gateway lifecycle across retries/crashes using native PostgreSQL with restricted role ACLs, then verify real registry/ingress/TLS and preserve all legacy/admin baseline rows. PGlite provides offline function/wire evidence; native PostgreSQL concurrency and deployed ACL/TLS have not been exercised here.
