# CRM login incident — isolated reader

Status: local release candidate. The frontend must not publish until the new service passes its production canary. The n8n-only candidate is retained for traceability: its live canary failed and it is not the frontend target.

The HTTP service at `services/crm-panel-read` removes the CRM identity and cached Growth payload reads from n8n execution queues. Its only database operation is the parameterized `shrigma_crm_read_fast_v1` call. It never refreshes caches, starts campaigns or sends messages. Existing snapshots and write routes retain their current behavior.

`GET /read?action=identity&painel=growth` returns the existing authoritative identity. `action=cache_growth` returns only the Growth cache row. Authorization is a canonical Bearer header, never a query parameter. Origin is restricted to the published Pages origin; OPTIONS does not query the database. Fresh authentication preserves revocation, expiry and short keys. A master retains all four allowed panels and existing Growth/Influs capabilities.

The service defaults disabled, uses the dedicated `crm_panel_reader` role and at most four database connections. PostgreSQL stops a statement after eight seconds; the HTTP deadline is nine seconds. Admission remains occupied until an outstanding query really settles and the response is ready, preventing late queries from accumulating. Large JSON responses use gzip when accepted. Errors do not log credentials, SQL or payloads. The function is SECURITY DEFINER with a fixed search path and no PUBLIC execute grant; the new role starts NOLOGIN and receives only its required function grant. Production effective privileges must also be checked before enabling LOGIN.

The CRM entry has a twelve-second deadline including JSON parsing and cancels abandoned requests. The Growth cache preserves its twenty-minute freshness requirement. A missing/stale cache shows a retry message and never automatically launches the expensive live payload query. CSP changes affect only CRM/Growth. The other panel assets remain unchanged.

## Publication sequence

1. Obtain the specific publication authorization needed after the prior no-push instruction. Publish only this incident branch; unrelated CRM feature candidates stay in shadow.
2. Push the reviewed commit and open a draft PR. Build a new Easypanel app `comunicacao/crm-panel-read` from that exact revision using `services/crm-panel-read/Dockerfile`; do not restart an existing service. Its proposed HTTPS domain is `comunicacao-crm-panel-read.tazdb8.easypanel.host`, port 8080.
3. Create the role using `crm-panel-reader-role.sql`, verify its attributes, memberships and effective privileges, and set a generated password through a private channel. Provide PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD, CRM_READ_REVISION and explicit CRM_READ_ENABLED. Do not commit or print credentials. Keep the database reachable only on the internal service network.
4. Before merging the frontend, check health/revision, preflight/CORS, invalid key 401, manager and master identities, short-key behavior, fresh Growth cache scope, gzip and measured latency. A timeout/500, stale cache or identity mismatch blocks rollout.
5. Merge only after CI and the real endpoint canaries pass. Verify served Pages assets, route and response timing; then observe normal login plus scheduled snapshot/attribution behavior without sending campaigns.

## Rollback

Revert the frontend release if acceptance fails. The new service can be disabled via its own flag; changing or restarting pre-existing services remains outside this rollout. Preserve the snapshots, database function, evidence journals and candidate files. The old n8n read URL remains a rollback target, but its observed latency is unresolved and must not be described as a healthy fallback.
