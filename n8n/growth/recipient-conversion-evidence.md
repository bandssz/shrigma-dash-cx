# Prospective recipient identity — shadow candidate, OFF

This is the first immutable link for a future buyer-per-recipient metric. It is
not installed, enabled, exposed through the API, or a completed conversion report.

The installed `ready` batch contract is exercised by three portable component
tests with the real saved-audience claim and finish functions. They cover OFF,
prospective identity capture, accepted outcome/replay, immutable evidence, and
explicit exclusion of a campaign registered in the actual A/B core tables.
Three additional portable installer tests cover raw-SQL refusal without the
compiler marker, exact source/snapshot pins, and rollback on metadata drift. The
sealed portable run passed all six cases. This is not a proof of native paired
A/B overlay concurrency. PGlite uses a limited digest compatibility function; it
is not a pgcrypto installation proof.

The separate shadow compiler `recipient-conversion-install.cjs` captures all
pinned source bytes once, verifies the loaded compiler's own hash, and snapshots
dependency definitions, ownership, table and column ACLs, RLS policies, roles,
triggers and supporting catalogs. It acquires bounded locks, checks expiry after
the locks and again after the DDL, and renders an OFF installation with exact
before/after checks. The raw SQL requires a PostgreSQL owner/session boundary and
an explicit compiler marker; execution without it rolls back and creates no
schema. The compiler only renders the plan. An approved external baseline and
review receipt remain mandatory before any operational installer may execute it.

The revision 3 native PostgreSQL 17.10 proof passed seven cases: raw refusal,
full OFF install with private ACLs and exact tracked snapshot, rollback for
function, column-ACL and RLS-policy drift, expiry after a lock wait, and bounded
`55P03` contention on `pg_type` without a residual schema. An independent root
reproduction passed the same seven cases. Both used synthetic databases, stopped
and removed their clusters, and made no production connection or send. These
results prove the guarded candidate boundary, not production readiness.

The existing native saved-audience claim inserts `shrigma_email_dispatch` while
holding the subscriber row and comparing its UUID/email/snapshot to the actual
envelope. An OFF-by-default AFTER INSERT hook can capture that dispatch's recipient
key, subscriber UUID and verified Shopify Customer GID in the same transaction.
It records the exact source operation, provenance, query, producer and expiry.
No recipient email is copied. Missing, stale, reassigned or mismatched identity
produces an explicit unknown; it never becomes an inferred Customer or zero.

The hook does not send, enroll, alter consent, change selection, or modify campaign
progress. It never reads a historical list to backfill a receipt. Once enabled in
a separate reviewed window, its coverage begins prospectively. An unknown SMTP
outcome cannot enter the accepted denominator. Native outcome reconciliation can
confirm the original dispatch; capture is not replayed.

The owner-only aggregate reports accepted unique recipient keys, mapped keys and
unknown keys. It checks the immutable claim hash against the accepted dispatch.
It does not claim conversions. The API role receives no schema, table, function,
recipient key or Customer GID access. Both brands default OFF. The current scope
is native regular saved-audience campaigns; legacy plain-list campaigns,
transactional messages and Olivas use other paths. Under the existing campaign
row lock, the hook rejects A/B registration and requires the effective binding.
The aggregate reports scope unavailable with null counts for an A/B or invalid
campaign. Native overlay and lock-race proofs remain release blockers. Do not
interpret these component tests as production recipient coverage.

Remaining before delivery: approved production baseline/review and an operational
installer; native paired A/B overlay concurrency coverage; explicit prospective
enablement; an internal versioned bridge from Listmonk evidence to the CRM
attribution database; immutable paid-order Customer GID reconciliation with its
time window and attribution model; coverage-aware unique buyer aggregation; and
panel/UI integration. Neither the synthetic proofs nor an OFF migration installs,
enables, backfills, exposes, or completes those steps.
