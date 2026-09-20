# Cart handoff candidate

`journey-cart-wiring.cjs` prepares an additive, terminal dry-run branch after the existing four-list reconciliation. It preserves the original summary and verifies the source workflow version, known list bindings and ordering. It does not install, enroll, claim, activate or send.

The collector can return 2,000 source IDs per receipt; the scanner accepts at most 200. `collectorBatches` validates all receipts and reconciliation counters before splitting the complete identity set into sorted batches. Duplicate identities, missing counters, mismatched cardinality and binding drift fail closed. Empty confirmed input produces no batches.

Build output contains the original private runtime export and must never be committed. `buildCartAdapterBundle` is a build-time helper that embeds the current scanner/provider sources for execution in Code without `require`. SQL still needs a trusted parameterized native-node receipt bridge; this bundle does not supply database or transport access.

Before emission wiring, verify the Listmonk cache target, native immutable template release and database privileges; preserve the existing SES claim/finish and final purchase/opt-out check. Test receipt pairing with synthetic data before any deployment. A disabled cohort, preserved reservations and a non-retroactive cutover are mandatory. The handoff candidate is not an executable free-form journey graph.

Run `node --test tests/journey-cart-wiring.test.cjs tests/journey-cart-scanner.test.cjs tests/journey-cart-provider.test.cjs` from the repository root. Tests are synthetic and make no HTTP requests.
