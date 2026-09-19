# Initial cart entry candidate

This is an incomplete B06.1 backend candidate for newly captured Fish initial cart email entries. It is **disabled on installation**, has no scheduler deployment or transport, and does not implement an arbitrary graph or migrate existing journeys.

`journey-cart-entry.sql` adds a control row, entry snapshot, durable deadline and decision ledger. Install the companion [template-release candidate](JOURNEY-TEMPLATE-RELEASE.md) first. Enrollment requires a ready, guarded native clone of the published source content and a verified cache target. `journey-cart-provider.cjs` exposes fixed, parameterized backend calls for enrollment, bounded due reads, reconciliation, lookup and the existing SES claim. It is not a browser-authorized endpoint. Keep the current authentication/capability boundary outside this adapter.

The incremental claim patch checks recognized source anchors and requires the original global pause guard. It preserves the existing sender, subscriber/list/purchase/cadence checks, identity, dedupe key, reservation and finalization. Only an opted-in initial Fish entry can use a pinned wait/template. The stage is linked to the existing dispatch in the same transaction as reservation; attachment failure rolls back both. In-flight and unknown reservations are never reopened. The finish function is untouched.

Entry time is the existing Shopify-created cart timestamp as stored by the collector; capture time determines which published configuration is pinned. A missed capture cannot reconstruct an earlier configuration. The original initial-touch expiry remains one hour after that source time. The editor's maximum configurable wait is not interpreted as expiry.

The global published pause continues to veto a pinned active stage. The separate candidate control also pauses entry execution. Purchase or opt-out observed before reservation closes the entry; resubscription does not reopen it. The provider checks again after reservation and requires the matching clone/dispatch/cache target, `claimed` reason and `in_flight` transport. Purchase, opt-out, pause, expiry or a superseded cart observed there prevents transport authorization and preserves the reservation. A later signal cannot revoke an accepted external transport or create another attempt. `get` projects the existing dispatch outcome; accepted still does not mean delivered.

## Required before activation

- Verify the native template-release route, database permissions and cache topology. `/api/tx` does not accept inline body content. The integrated local candidate uses a native clone protected from creation, preserves source edits and blocks unpinned subject/altbody overrides. The remaining blocker is proof and deployment of this route, not reliance on a mutable template fingerprint at claim time. See the companion contract for uncertain creation and publication requirements.
- Connect enrollment to fresh source collection and the bounded due scanner to the existing payload builder/claim/transport. Do not activate the control before that route is present. The backend provider itself sends nothing.
- Make selector ownership explicit. The claim blocks a legacy request for an opted-in cohort without an entry ID; the selector should also exclude those initial-touch candidates. Other stages and brands remain in their existing routes.
- Establish the cutover for new source timestamps and test rollback. Captured entries remain owned even if the control is disabled. Preserve the ledger and all dispatches; do not automatically release captured entries through the legacy selector.
- Test contention with independent PostgreSQL connections and purchase/opt-out around the reservation boundary. PGlite verifies transactions and logic on one connection, not a multi-session worker race.
- Resolve the separate order timestamp monotonicity patch, then verify publication with fresh exports and explicit active-version readback. Do not generate sends to prove readiness.

## Local checks

Run `tests/journey-cart-provider.test.cjs` and `tests/journey-cart-entry-postgres.cjs` with `CAMPAIGN_PGLITE_MODULE` pointing to an installed PGlite module. The latter uses a public synthetic schema/boundary fixture. `JOURNEY_CART_FUNCTIONS_FILE` can additionally point to a private fresh function-definition export for regression against the complete current claim/finish; never commit that export. The isolated fixture substitutes digest only for binding-equality checks; it does not validate the cryptographic primitive.

Tests cover disabled/idempotent installation, preservation of the finish function and prior reservation, publication/source changes after enrollment, persistent wait, pinned clone content before and after reservation, global/cohort pause, expiry, purchase, opt-out, superseding cart, missing release/guard, uncertain outcome, interruptions between reservation and final authorization, and rollback if durable entry attachment fails. Review this as implemented and locally tested; deployment and natural execution proof remain separate.

## Independent order-event correction

`cart-order-monotonic-patch.cjs` changes only the recognized order resolver timestamp assignment in a fresh workflow export. It requires an expected version, retains the later existing timestamp, and treats equal instants in different timezones as the same order marker. It preserves the existing list/flag behavior and every other workflow field. Unit and isolated full-query tests cover out-of-order events. This marker represents the existing order event; it is not renamed to payment confirmation.
