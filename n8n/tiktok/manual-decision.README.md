# Manual decision candidate

This is an isolated candidate, not an installed API or an enabled emitter. Installing `manual-decision.sql` creates controls with `enabled=false`. Reinstalling preserves controls, historical sample rows, logs and every reservation.

`manual-decision.cjs` contains a dependency-free controller and parameterized SQL contract. It authenticates nobody by itself: a trusted adapter must validate the existing server credential, derive its SHA256 principal and supply its own execution identity. A shared credential proves that principal, not the identity of the person typing the author label. Never accept `actor_sha256`, `owner` or claim tokens from a browser.

## State and identity

The operation UUID is generated and persisted by the client before its POST. The frozen request contains exactly `marca`, `application_id`, `resultado`, `motivo_rejeicao`, `observacao`, `autor`. IDs are decimal strings without leading zeros. An approval has a null rejection reason. Keys, access tokens and provider exception text are never part of the request snapshot or receipt.

The permanent uniqueness constraint is `(marca, application_id)`. Changing an operation UUID, principal, outcome, label or endpoint does not grant another decision. The first owner receives a claim token once; exact repeat claims return a receipt, not transport permission.

The sequence is `claim → explicit preflight → dispatch → one transport → finish`. Both reservation steps commit before HTTP. Missing preflight defaults to false. The controller does not retry any step. `reserved` and `in_flight` are unresolved states; `outcome_unknown` is retained indefinitely. Even a `blocked` reservation is retained. There is no TTL, deletion, reassignment or automatic recovery of transport permission.

Provider acceptance requires HTTP 2xx, numeric `code:0`, a nonempty request ID and no contradictory error. It proves API acceptance only. Other responses and transport errors remain uncertain. Successful sample mutation, log and durable response are stored in one transaction. A later status already collected from the platform is preserved instead of being replaced with the initial shipment status.

`get` only reads the exact UUID, brand, sample and authenticated principal. Missing or mismatched identity returns `missing`, which does not prove that an old operation had no effect. No claim token or owner is exposed in the public receipt.

## Activation gates

- The existing automated transports do not participate in this ledger. The locked rule read only protects a database statement; it ends before HTTP and cannot fence an older worker. Integration with automatic transports/rule activation, or a proven cutover and drained old workers, is required before enabling the control.
- The eligibility timestamp must follow the cutover and installation. Existing samples are excluded even when no old log exists. Previously attempted or ambiguous samples need separate evidence-based reconciliation; this candidate does not rewrite them.
- The service role needs explicit reviewed privileges. Functions use `SECURITY INVOKER` and a fixed search path; all new objects revoke `PUBLIC` access. The migration does not guess an existing role or grant broad permissions.
- The production workflow, native PostgreSQL bindings, transport response options, HTTP timeout/redirect policy, node pairing and frontend journal/receipt route still require wiring and isolated validation. The old review path must not remain an alternate entry.
- Credential rotation must preserve and explicitly reconcile prior principals; it cannot erase reservations or silently change ownership.

## Tests

`tests/tts-manual-decision.test.cjs` covers strict requests, VM execution without imports, lost receipts, ownership, default-deny preflight and a controller-to-SQL round trip. `tests/tts-manual-decision-postgres.cjs` uses isolated PGlite for migration, legacy boundary, rollback and state tests. `tests/tts-manual-concurrency-postgres.cjs` requires two real PostgreSQL sessions, an explicitly opted-in empty database named `tts_manual_test`, and synthetic fixtures only. The dedicated CI workflow provides that disposable database; a prepared test is not a passed concurrency proof.
