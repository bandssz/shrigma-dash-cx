# CRM Shopify sync

Runs the pinned Customer/Order/LineItem bulk query outside n8n and writes only through the existing `shopify_ingest_product_chunk` contract. The HTTP response is a small operation receipt; customer data, Shopify tokens and signed download URLs are never journaled or logged.

Install `segment-shopify-sync-runtime.sql` as `postgres`, deploy this image with a private network and bearer key, then patch each pinned n8n workflow with `segment-shopify-service-patch.cjs`. Configure each brand's app client id and client secret; the short-lived Admin token is obtained with `client_credentials`, retained only in memory and never logged. Keep `CRM_SHOPIFY_SYNC_ENABLED=false` until SQL, credentials, readback and recovery checks pass.

The service serializes all brands, records start intent before Shopify mutation, blocks ambiguous starts, and reconciles every chunk against its durable hash before retry. `/v1/recover` accepts a completed bulk id and resumes already committed chunks; it does not assume chunk zero.

Production sizing must include the whole service and the exact export shape. The proven Fish export (31,605,786 bytes) reached about 436 MiB RSS with a 256 MiB V8 heap, so its profile uses a 1 GiB container. Exports above 40 MiB must first pass a parse-only run of the same completed bulk, with no database writes, under the proposed heap and container limits. Record bytes, object and customer counts, source hash, download and parse durations, peak RSS and largest serialized chunk in the receipt before changing the running service. The 128 MiB input ceiling is a guard, not a sizing claim.

For a profiled large recovery, set `CRM_SHOPIFY_LEASE_SECONDS=300` and require the measured poll, download, synchronous parse and chunk-size scan to finish within 150 seconds, leaving half the lease for scheduling and the first durable write. The current transport also has a 60 second download deadline. Do not raise `CRM_SHOPIFY_MAX_BYTES`, V8 old space or the container limit until the parse-only receipt passes; apply the measured profile as one deployment and recover the already completed bulk with a new idempotency key. Keep one replica, one process and one operation at a time. If the profile exceeds either deadline or leaves insufficient memory margin, change and re-prove the runtime rather than starting another bulk operation.

The last chunk also finalizes the full snapshot's customer identities and product facts atomically. `CRM_SHOPIFY_INGEST_TIMEOUT_MS` defaults to 30000 and may be set to at most 180000 after a disposable database proof at the snapshot's customer and native-contact cardinality. An increased deadline requires a lease at least 30 seconds longer. Only the `ingest` action receives this deadline, through a transaction-local PostgreSQL setting and a client timeout two seconds longer; reads, claims and reconciliation retain their 30 second server / 32 second client limits. The setting is restored at commit, and failed or uncertain connections are discarded. Do not change shared role defaults, API timeouts or identity semantics to complete a large snapshot.

If the final chunk is uncertain, first reconcile its durable receipt and the pending journal. After proving the chunk absent and the old lease expired, deploy the corrected collector once and let startup recovery reclaim the same idempotency key and bulk. It preserves `observed_at`, exact evidence and committed chunk hashes. Do not repeat the HTTP POST, start another bulk or manually replay an uncertain chunk.

Credentials may instead come from `CRM_SHOPIFY_SYNC_SECRETS_FILE`: a regular private JSON file mounted for the `node` user, maximum 4096 bytes, with no group/other permissions or symlink. Its exact six keys are `PGPASSWORD`, `CRM_SHOPIFY_SYNC_KEY` and the client id/secret pair for each brand. Public environment settings retain all activation, lease and memory controls; duplicate credentials in environment and file are rejected. Deploy the bind mount through Easypanel without returning credential values through tool outputs.

## Product-history semantic mode

`CRM_SHOPIFY_PRODUCT_SEMANTICS` accepts exactly `v1` or `v2` and defaults to
`v1`. The worker captures the selected parser when it is created; existing v1
exports retain their original behavior. In v2, a Customer's product history is
complete only when unresolved line items are zero and the exported Order-node
count equals `Customer.numberOfOrders`. The service rejects v2 unless
`CRM_SHOPIFY_PRODUCER_REVISION` equals the full
`CRM_SHOPIFY_SYNC_REVISION`, and `/healthz` reports `product_semantics`.

Do not enable v2 merely because the image contains both parsers. Verify every
compatible audience API replica in v1 and an idle journal/mutex with delivery
gates OFF. Stage this collector image OFF in v2, with producer revision equal to
its image revision, and read back its health. Install the guarded v2 database
graph, derive attestations for the frozen snapshots and refresh the catalog
while the source producer revision remains unchanged. Then move every audience
API replica to v2 and prove its counts. Prepare the exact old-to-new producer
transition in the ledger only after those checks; enable this collector last.
The committed ledger does not lock the scheduler, so the service must remain
OFF until preparation is complete. Do not start another Bulk or replay the
current frozen exports. Historical chunks and their provenance remain
immutable.
