# Versioned descriptive A/B registry

This slice creates or closes a descriptive registry entry. It does not allocate a cohort, create campaigns, send messages, estimate incrementality, select a causal winner or execute a journey.

`ab-registry.sql` adds a version column and an atomic operation ledger while preserving historical rows and arms. A create requires an unused ID and version zero. Closing requires the exact current version, a running record and the existing UI contract (`inconclusivo`, no winner). Historical winner annotations remain unchanged by installation. Arms become immutable after creation. An existing ID is never an upsert target.

The operation UUID, authenticated principal, action, registry ID and full request payload identify one operation. A successful write or definitive registry conflict and its receipt commit in the same transaction. Replay with the same identity returns the existing receipt; another principal or payload cannot reuse it. The principal describes the existing shared write credential, not a person. Rotating that credential requires a plan for reconciling its outstanding receipts.

The pure validation in `../../growth-ab-protocol.js` is shared by the browser and the n8n Code adapter. PostgreSQL remains authoritative. The workflow adapter binds native `$1/$2` parameters, preserves the existing credential and webhook path, disables retries, rejects saved/active version drift and returns uncertainty for missing PostgreSQL receipts. Generated workflow exports contain the original credential declaration and must stay outside the repository.

The same existing route gains authenticated read-only `capacidades`, `registro` and `operacao` GET actions, with `X-AB-Write-Key`. Lookup binds UUID, action, registry ID and principal; a missing receipt is not evidence that an operation never happened. OPTIONS allows the explicit header. Browser requests prohibit redirects and caching. The browser persists before its single POST, serializes tabs with Web Locks and never automatically replays POST. Only an exact durable GET receipt releases a new reservation. Legacy uncertain browser entries have no such server identity and remain blocked for reconciliation. New credentials remain in page memory; existing legacy storage can still be read.

## Installation and rollback

The root integrator must first read the current schema, ACLs, writers and saved/active workflow. The migration verifies the known table shapes, constraints, ownership and trigger contract. The SQL bridge and endpoint must be installed as a coordinated cutover before publishing the browser assets. The guarded tables reject legacy direct DML after cutover. A transaction that already holds table locks finishes before the migration can acquire its lock; migration lock timeouts require read-only reconciliation, never an assumed success or blind retry.

A failed cutover may leave the old endpoint unable to write. This is an explicit fail-closed state, not permission to remove the guard. Rollback preserves the version column, ledger, receipts and guards and disables writes while the integration is repaired. Do not restore the legacy destructive upsert, delete reservations or use a new UUID to repeat an uncertain write.

## Verification

The Node tests cover protocol/adapter sandbox execution, browser persistence and exact receipts, legacy uncertainty and shared validation. PGlite tests install the migration twice, preserve history, verify CAS, rollback record/arms/receipt together and reject schema/ACL/trigger drift. `tests/ab-registry-concurrency-postgres.cjs` uses two independent connections to a disposable PostgreSQL database to test the cutover and competing identities. The dedicated CI workflow supplies that database; never run the concurrency fixture against production.

Tests and a prepared patch do not prove that the endpoint is installed or that the browser works in production. Publication requires the fresh workflow/version readback, SQL/schema/ACL readback, authenticated GET/OPTIONS checks, asset hashes and a separate UI acceptance record. This slice is independent of the later allocation and causal-analysis engine.
