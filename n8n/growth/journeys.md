# Unified operational journeys

A journey groups one objective for one brand. Email and WhatsApp are stages of that journey. Dispatch identities (`brand`, `flow`, `piece`, variant, source template and reference) remain unchanged.

`journey-merge.js` combines NPS initial/reminder and the six order-event definitions. The first source key survives; other definitions retain their history with `binding.merged_into`, disabled runtime and an archive constraint. Never run the old engagement seeder/enable script over archived rows. Migration refuses pending drafts or unavailable runtimes and compares all runtime bindings before/after in a rolled-back database test.

`journey-api.sql` hides archives from current listings and rejects writes to them with `jornada_unificada`. `journey_kind` selects a canvas projection. NPS supports existing surveys alongside new entrants; order events remain independent triggers, so delivery does not require traversing payment first. The cart canvas preserves each offset from abandonment and alternative WhatsApp arms. Moving a block only changes its saved position.

The new NPS initial-confirmation helper must be applied before the updated claim function and candidate query. It requires an initial log for the same brand/order/contact and rejects contradictory outbox states and matched definitive failures. Both selection and claim enforce it. Existing cadence (daily 19:00 America/Sao_Paulo, maximum 200) and timing origin (initial marker) remain unchanged. Outcomes are never replayed merely because confirmation is missing.

## Validation and release

- Test `mergeJourneys` with independent pauses, missing steps, unpublished work and repeated migration.
- In a database transaction, snapshot all runtime slots, apply the migration, compare identities/templates/waits, validate all targets, verify global NPS pause and rejection of archive writes, then roll back.
- Test initial confirmation with isolated records and exercise the full engagement claim/finish regression without transport; roll back all fixtures.
- Save fresh workflow/function/row versions, reject concurrent changes and apply atomically. Publish the candidate workflow with its original credentials/settings and verify the active version.
- Verify live API counts and runtime slots; run desktop/mobile canvas checks. Existing sends provide operational evidence separately from these tests.

## Explicit limits

This is consolidation of connected journeys, not a general graph interpreter. Users can edit stage templates, supported timing windows, stage enablement, journey pause and layout. Conditions shown here represent actual checks; arbitrary condition/trigger creation remains future work. A new graph engine will need durable per-entry versions, waits, decisions and cancellation records. Global pause now groups controls, but resumption still follows existing eligibility rules; no new backlog release policy is introduced.

A response after transport commitment cannot cancel a message already accepted. Initial confirmation does not change the historical start of the reminder clock. Report accepted, delivered, failed and unknown separately; a configured/active workflow alone is not execution proof.
