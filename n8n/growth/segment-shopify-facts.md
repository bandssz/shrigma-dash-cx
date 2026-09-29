# Shopify customer facts in reusable audiences

Candidate integration for the existing Fishermans and Aristocrata nightly syncs.
No source is enabled by installation. Publication of this code does not establish
that a workflow, database migration, API service or campaign worker is deployed.

## What the analyst can express

The existing audience contract uses Customer `numberOfOrders`, `amountSpent` and
`lastOrder.createdAt`. These are lifetime customer aggregates, not a paid-order
filter, and do not establish purchases made under another customer identity.
`purchase.count = 0` requires an explicit zero on a resolved Customer from a
complete export. Missing customers, incomplete exports, changed or ambiguous
identities and stale sources never mean zero. Last-order dates use the verified
shop timezone; numeric values use exact PostgreSQL decimals, including Uint64.
The [Shopify Customer reference](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Customer)
documents the three source fields.

The panel shows the export start, observation and expiry. Facts expire 26 hours
after export start. Nightly facts can lag later orders; this interval is visible.
Source age is independent of native list/engagement catalog freshness. Expired
Shopify conditions are unavailable while native conditions remain usable. A
saved audience retains its definition and requires current matching semantic pins.
Products and signup origins remain unavailable until their own provenance exists.

## Existing workflow, complete export

`segment-shopify-sync-patch.cjs` checks the reviewed workflow IDs, versions, node
hashes and graph before generating a patch. Customer Start/Poll alone move from
2025-01 to the validated 2026-07 documents. Orders, legacy PostgreSQL statements,
consent, native lists and legacy attributes remain unchanged. Facts are ingested
after the existing missing-contact insert has committed. Empty exports and empty
legacy batches follow explicit mutually exclusive paths with no invented contact.

The Code node uses the same serialized `segment-shopify-bulk-evidence.cjs`
validator tested locally. It checks shop identity, scope, operation ID, COMPLETED
status, null error/partial data, exact byte/root/object counts, JSONL shape, unique
GIDs, exact numbers and timestamps. Streaming SHA-256 avoids a second full byte
array. Chunks contain at most 5,000 records. Empty exports have one empty chunk.

The private ingestion function accepts only the configured workflow, producer
revision, query hash and shop metadata. A source pointer changes only after all
chunks reconcile. Replays require identical source/content pins and chunk hashes;
a later re-observation can reuse the same operation without changing its first
observation. An older operation cannot displace a newer snapshot. No automatic
retry can overwrite a committed chunk. Obsolete individual payloads/chunks older
than seven days are removed when the next complete batch commits; aggregate
batch provenance and identity history remain. The current source is never pruned.

## Identity and common predicate

Initial association requires a unique normalized ASCII email on both Customer
and native contacts. The resulting Customer GID → native ID + UUID link is
recorded permanently per brand. This is contact association, not proof of a
person's identity across accounts. A later GID/UUID reassignment is unresolved.
Readers also require the current native UUID and email to agree. International
addresses stay in evidence as unsupported identity; no full export is discarded
merely for containing one. No source ingestion enrolls or unblocks anyone.

Count and regular selection use `shopify_customer_match`. Unknown facts remain
SQL NULL; AND/OR preserve three-valued logic. Native final unknowns raise and
cannot be committed as an empty campaign. Source readiness is checked even for
an empty eligible base. Consent and global suppression remain native predicates.
Before the durable send claim, the source row is locked against pointer changes
and its expiry bounds `valid_until`; wall-clock expiry is rechecked after waits
and receipt insertion. The existing worker checks the resulting lifetime before
MAIL, and retains its single-attempt/unknown-outcome behavior.

## Installation and privilege boundary

Install `segment-shopify-facts.sql` and `segment-shopify-selection.sql` atomically,
after the regular schema. Do not reinstall any base SQL. The additive selection
migration requires the worker OFF, checks the exact base bodies of six existing
functions, and uses CREATE OR REPLACE to preserve their ACLs. Its new functions
start with PUBLIC execution revoked. Source rows default ingestion OFF/source OFF.
Existing regular deployment, sender policy and binding gates remain independent.

The API role can execute source status and typed boolean predicates, as it already
reads native IDs/status/membership/events for aggregation. It receives no SELECT
on Shopify facts, identity, batches or chunks, no ingestion grant, and no access
to contact email or GID. The trusted service compiles parameterized count SQL;
the HTTP contract offers no SQL or per-customer query, and returns aggregate
counts plus timestamps only. This role is not a database aggregation boundary.

Configure server-owned shop/workflow/producer/query/semantic pins, install the
reviewed workflow patch against a fresh version, ingest a completed source and
reconcile aggregate counts. Keep source OFF until the matching API service is
updated in Felipe's existing-service window. Enable one brand only after those
checks, then read back through the actual Gestor endpoint. No customer send is
needed to establish source availability. The worker deployment window and its
separate identity/SMTP checks remain required for campaign execution.
