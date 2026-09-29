# Products in reusable audiences

This extension uses the existing Fishermans and Aristocrata nightly Customer
export. Installation and publication keep the source OFF. A completed export,
the matching API service and a Gestor readback are required before availability.
There is no manual bulk, customer send or native contact update in this release.

## Meaning shown to the analyst

“Produto nos pedidos” checks an exact Shopify Product GID in the orders of the
resolved Customer. The export has no payment filter. A positive item quantity
includes refunded and removed items, following Shopify's `LineItem.quantity`.
Deleted orders and orders under another Customer identity are outside this
history. A missing Customer, changed identity or expired source is unknown.

An identified product proves presence even when another item has `product:null`.
Absence requires every line item of that Customer to have an identified product.
The same predicate serves panel counts and native campaign selection. Opt-out,
base membership, double opt-in and final consent checks remain mandatory.

Sources: [Customer orders](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Customer),
[LineItem quantity and product](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/LineItem),
and [bulk JSONL and connection restrictions](https://shopify.dev/docs/apps/build/apis/graphql-admin/bulk-operations/queries).

## Complete evidence and atomic ingestion

The new query uses Customer → Order → LineItem connections. V2 requires
`read_customers`, `read_orders`, `read_all_orders` and `read_products`, exact shop
identity, a completed operation, no partial data, matching bytes and all node
counts, unique GIDs and previously seen parents. The full JSONL supplies the
source hash. The original scalar projection validator remains unchanged.

Each Customer has distinct identified products, an exact count of unresolved
items and a derived completeness flag. Final ingestion reconciles both the sum
of unresolved items and the number of incomplete Customers. Conflicting product
titles or more than 1,000 distinct products reject the export. Other bounds are
128 MiB, 250,000 Customers and 1,000,000 total connection nodes.

The additive wrapper calls the existing scalar ingestion in the same transaction.
It records the original V2 metadata, immutable chunk hashes and private product
facts. The scalar projection's operation counts are explicitly recorded alongside
the original full export counts; its hash is never presented as the full source
hash. A duplicate requires identical metadata and product payload. Failed final
reconciliation rolls back the last chunk and pointer together. No staged source
becomes current. Old product facts follow the existing seven-day pruning of
individual Customer facts; aggregate product catalogs remain as provenance.

## Catalog and permissions

Aggregate field pins keep their original projection and meaning; product rules
have a separate semantic pin. The actual producer query remains independently
pinned in the source and batch. Nightly product additions or title changes can
refresh the catalog only from a completed, retained producer receipt. Unrelated
changes to native lists, base rules or engagement sources remain rejected.

The API role gets no new table or ingestion privileges. Its existing boolean
matcher and aggregate count expose no Customer GID, contact email or product
history. Catalog entries contain only product GIDs and names. Source expiry also
disables product conditions; it does not turn them into zero or disable lists.

## Release sequence

Apply `segment-shopify-products.sql` atomically after the installed V1 Shopify
integration, while Shopify sources and workers are OFF. It requires exact bodies
of nine functions, preserves their ACLs and creates three private tables plus two
functions with PUBLIC execution revoked. Do not reinstall the V1 migrations.

The product workflow patch requires the reviewed 21-node producer. It replaces
only the Customer bulk query, evidence code and ingestion function. Orders,
legacy attributes, schedule, graph, credentials and native consent are preserved.
Configure its exact query/revision pins, then let the normal nightly execution
complete. Update the existing API service in Felipe's service window and enable
one source only after aggregate reconciliation and a Gestor readback. The regular
campaign worker's separate deployment and sender checks remain required.
