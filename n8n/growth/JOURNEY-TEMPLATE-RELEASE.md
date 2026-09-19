# Immutable transactional template candidate

Implemented and tested locally; **not installed, connected to a scheduler, or activated**. This is the template layer of the bounded Fish initial-cart candidate, not an arbitrary journey graph. The editable source templates, current editor, active sender and existing dispatch ledger remain unchanged.

## Why the release is a native clone

Listmonk v6.1.0 ignores a JSON `body` on `/api/tx`: `TxMessage.Body` has `json:"-"`, and `Render` fills it from the cached template. A payload HTML snapshot therefore cannot pin the message. The API does accept subject and alternate-body overrides; the candidate rejects nonempty overrides because they have no separate pinned revision.

The template API compiles the submitted content, inserts the template, calls `CacheTpl`, then returns HTTP 200. The candidate uses that native creation path so the transactional template becomes available to the same process's cache. Direct SQL insertion alone is insufficient.

Primary sources: [transactional model and rendering](https://github.com/knadh/listmonk/blob/v6.1.0/models/messages.go), [native template handlers](https://github.com/knadh/listmonk/blob/v6.1.0/cmd/templates.go), [transactional endpoint](https://github.com/knadh/listmonk/blob/v6.1.0/cmd/tx.go), [in-process template cache](https://github.com/knadh/listmonk/blob/v6.1.0/internal/manager/manager.go), [API documentation](https://listmonk.app/docs/apis/transactional/).

## Backend contract

Install `journey-template-release.sql` before `journey-cart-entry.sql`, only after fresh schema, trigger and permission review. Neither installation enables the cohort. Keep authentication and capabilities outside these backend-only adapters.

1. `prepare(sourceId)` reads a Fish transactional template from the existing branded registry and stores a snapshot of type, subject, body and nullable body source. PostgreSQL computes the SHA-256 fingerprint. The release is unique for source, content and verified cache target. A changed source gets a different revision.
2. `create(releaseId)` atomically changes `reserved` to `creating`, retaining a claim token before the native call. It issues one `POST /api/templates` with the reserved technical name and snapshot. The injected adapter returns `{status, body}` from the native response.
3. A guard protects the technical namespace from INSERT onward. It requires the reserved content and blocks subsequent content, identity or name changes and deletion. The normal editor can still edit originals; default-template maintenance can still update metadata. A clone cannot become the default or enter the branded editor registry.
4. Only HTTP 200 with a matching template identity and complete content can confirm `ready`. SQL verifies the stored clone, active guard and registry isolation again. The acknowledgement is evidence for that configured cache process, not evidence of delivery.
5. Enrollment requires a ready release matching the current published source content and the cohort's cache target. It captures the source ID, release ID, fingerprint, clone ID, published definition and deadline. Later source edits leave that entry's clone unchanged; new source content without a prepared release cannot enroll.
6. The existing SES claim substitutes the pinned clone ID and preserves identity, sender checks, dedupe key, reservation and finish. Before returning `should_send`, the adapter rechecks the entry and requires the reserved dispatch, matching clone/cache target, `reason=claimed` and `transport_state=in_flight`. Purchase, opt-out, pause, expiry or superseded source observed at this last check prevents authorization without deleting the reservation.

`cacheTarget` is an operator-verified deployment identity, not a URL or a user-selected field. The future runtime must route native template creation and transactional sending to that same cache instance, or explicitly synchronize every serving instance before a release can be ready. A string in configuration alone does not prove topology.

## Uncertain creation and delivery

A timeout, empty/mismatched native response, or lost SQL confirmation leaves `creating` intact. Calling `create` again returns the existing state and makes no further POST. Do not generate another name or delete the orphan clone. Reconciliation must inspect the same reserved identity, verify exact stored content, refresh/confirm the correct native cache and finish the same release. This candidate deliberately has no automatic recovery route; that route must be completed before operational activation.

Dispatch uncertainty remains owned by the existing dispatch ledger. This template layer never reopens a reservation or retries an email. A signal after the final check and before the HTTP call remains a boundary to minimize and observe; no database read can atomically cancel an external provider acceptance. An accepted message is not proof of delivery.

## Activation gates

- Verify the real database role used by native Listmonk. The trigger is `SECURITY INVOKER`; its guarded INSERT needs access to the release row. Use explicit minimal permissions for the verified role, not broad public grants. A SQL utility test does not prove native API permission.
- Verify native creation/readback and compiled-cache behavior with a synthetic template only, and prove the serving topology. No subscriber send is necessary. Preserve the reserved technical clone and journal if the result is uncertain.
- Connect release preparation to publication/collection, with stale content checks, then connect enrollment and the bounded scanner to the existing payload builder and transport. An editor save that changes source content must prepare the next release before the new cohort can use it. Existing routes remain unchanged while disabled.
- Test cutover and lock contention with independent PostgreSQL sessions. Use a future cohort boundary; do not retroactively capture historical carts or overlap a legacy claim that already passed its ownership check.
- Expose uncertain release/dispatch reconciliation to the integrator and operator workflow. The operator should not edit n8n or improvise another key.
- Confirm installation, active workflow versions, deployed permissions and a naturally occurring entry separately. Local SQL and a fake native adapter are not live cache or delivery evidence.

## Scope and verification

The snapshot pins template bytes and subject. Personalization, subscriber data and current validated checkout data are still supplied by the existing payload builder. Remote images, destination pages and template functions depending on time are not frozen rendered output. Clones remain visible as technical objects in Listmonk administration, but are excluded from the dashboard's branded editable catalog.

Run the Node provider tests and `tests/journey-template-release-postgres.cjs`, then `tests/journey-cart-entry-postgres.cjs`. The latter also accepts a private fresh export through `JOURNEY_CART_FUNCTIONS_FILE`. Fixtures check source changes, clone immutability before and after claim, metadata/default compatibility, registry exclusion, uncertain creation, repeated installation, source/brand/cache mismatches, and interruptions after reservation. The fixture's digest stub validates equality only. PGlite uses one connection and is not proof of a multi-session race.
