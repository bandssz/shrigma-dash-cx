# Customer identity in attribution orders

The attribution collector can now record a canonical Shopify Customer GID for
Fish and Aristo. `customer_identity_state` is `confirmed`, `absent`, or `invalid`.
Missing customer data remains unknown. Malformed values are never retained.
Olivas keeps the previous query, transport, classified payload and attribution
model. Revenue and last-click/non-direct rules are unchanged.

`attribution-recipient-workflow.cjs` is a pure candidate builder. Its default
pins require the reviewed full production export and published version. It
changes only the two attribution query bodies (adding `customer{id}`) and the
classifier code. All 27 other nodes, settings, credentials, URLs and connections
are preserved. A caller may supply a separately reviewed source fingerprint;
the four pinned read/code nodes and candidate query/projection still have to
match. This does not grant permission to write or execute a workflow.

The portable fixture contains those four published nodes and 26 synthetic
placeholders. It contains no private export or credential value. Tests validate
the exact query delta, stale input rejection, the actual n8n classifier wrapper,
unchanged Olivas output, and persistence through the existing v2 ingest function.
Production rollout must separately compare the complete real workflow.

The full candidate query was validated against the official 2025-10 schema when
the candidate was prepared, then against 2026-01 before publication. A bounded
read on 2026-10-01 with each attribution node's own n8n credential returned
HTTP 200, an effective `X-Shopify-API-Version: 2025-10`, and a confirmed Customer
GID. Both apps have `read_orders` and `read_customers`. This proves the added
field on those actual endpoints; it is not a claim that the toolkit still
supports validating that older version. No query URL or app credential is
changed by this rollout. Shopify documents version fall-forward at
<https://shopify.dev/docs/api/usage/versioning> and the orders query at
<https://shopify.dev/docs/api/admin-graphql/2026-01/queries/orders>.

Publication only changes collection from that point onward. Old stored payloads
cannot acquire identity coverage without a new verified collection. Do not
manually run the full collector as a deployment test; observe its normal
schedule and distinguish publication from an observed ingestion receipt.

This change does **not** expose a recipient conversion rate. That rate still
requires an auditable, immutable link from `(brand, customer_gid)` to the
recipient of an accepted dispatch, deduplication per recipient/campaign, and
explicit coverage. Joining a current mutable identity mapping retroactively
does not establish that link. Until then, orders per 100 sends remains an order
ratio, and recipient conversion remains unmeasured.
