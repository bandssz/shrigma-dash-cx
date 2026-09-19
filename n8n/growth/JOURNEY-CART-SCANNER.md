# Bounded cart scanner candidate

This backend scanner is implemented and tested locally. It has no deployment, schedule, browser endpoint, transport, native-template call or activation method. `dry_run` is the default. `capture` is an explicit internal mode that can only call the existing candidate's idempotent `enroll` and decision `check` operations. Neither mode calls `claim` or `/api/tx`.

## Input and result

```js
const scanner = createCartScanner({ query, entries });
const preview = await scanner.run({ sourceIds, mode: 'dry_run', limit: 100 });
// Only after backend authorization, completed list reconciliation and gates:
const captured = await scanner.run({ sourceIds, mode: 'capture', limit: 100 });
```

`query` must bind SQL parameters. `entries` is the backend cart-entry provider. Authentication/capabilities and a verified cache target remain outside this module; do not pass a caller-selected mode directly from a public webhook.

- Up to 200 source IDs, deduplicated and sorted, identify the records just collected. No full subscriber scan is performed. Only the existing Fish source reference is read; email, phone, name and checkout content are not returned by the scanner.
- The source reference is passed unchanged, including submillisecond precision. Database time and the configured cohort bound the attempt plan. Missing, invalid, historical or future references and a disabled cohort are explicit states.
- `would_capture` means that registration would be attempted. It does not prove eligibility, a new entry, a ready release, or permission to send. Enrollment rechecks current source, configuration and release in SQL and may return an existing entry or decline.
- Existing waiting entries are read in stable `due_at,id` order, capped at 200 per page. The opaque cursor retains the scan time and full timestamp precision. Continue the cursor to finish that cycle; start a fresh cycle without a cursor to observe entries inserted behind the previous position.
- Dry run performs only SELECTs. Capture invokes enrollment sequentially, then decision reconciliation, returning `sends:0`. A malformed/lost receipt stops further writes, keeps the same identities and does not advance a cursor. Inspect the same entry/reservation before continuing; no alternate key or automatic retry is created.
- Per-record identities in the result are operational data. Keep them in private operational storage; use counts/statuses in common reports.

## Connection to existing workflows

`journey-cart-runtime-patch.cjs` accepts a fresh workflow export plus its exact expected `versionId` and returns a copied export. It never publishes and rejects unknown/previously patched query anchors. Keep workflow exports private.

`patchCollector` adds `journey_source_ids` to the existing upsert receipt while preserving both original counters, source logic, credentials and connections. `collectorHandoff` validates that the IDs match the affected count and returns a Fish batch in `dry_run` mode. It does not infer successful list reconciliation from an upsert receipt.

Connect capture **after** the existing four-list reconciliation has completed; immediately checking a new subscriber before its cart-list membership is committed could cancel an otherwise valid entry. The current helper does not insert or wire n8n nodes. Deployment must connect that post-reconciliation boundary to the scanner and keep the separate due scanner scheduled only after its gates are met.

`patchLegacySelector` adds ownership exclusion for Fish `t05` only. It preserves other brands, later stages, ordering and limits. Install the candidate SQL before this selector references its ownership function. A captured entry remains owned when the cohort is paused; never release it back to the legacy sender. With a disabled cohort and no captured entries, the legacy selector behaves as before.

Activation also requires the immutable-release/cache/ACL gates in [JOURNEY-TEMPLATE-RELEASE.md](JOURNEY-TEMPLATE-RELEASE.md), a future cohort boundary and independent-session contention tests. The scanner closes the bounded registration/reconciliation adapter, not the whole deployment or general journey engine.

## Tests

`tests/journey-cart-scanner.test.cjs` verifies dry-run writes are absent; captures are sequential; invalid/outside-cohort inputs are explicit; uncertain receipts stop without another identity/cursor; timestamps and pagination retain precision; stale exports and query drift fail closed; and patches preserve unrelated workflow fields.

The isolated `journey-cart-entry-postgres.cjs` suite exercises the collector upsert with synthetic parameters before and after its additive receipt, checks original counters, captures the returned IDs, and proves dry run changes no entry, decision or dispatch. Capture changes entry/decision state with no transport reservation. Selector tests prove Fish `t05` exclusion and preservation of Fish later stages and Aristo. The raw PostgreSQL test boundary explicitly types the collector's brand parameter before its polymorphic JSON expression; live n8n parameter handling is a separate deployment check.
