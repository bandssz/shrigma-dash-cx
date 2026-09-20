# Disabled native runtime candidate

This extends the existing `manual-decision.sql` / `manual-decision.cjs` ledger with a native n8n adapter. It does not install the SQL, publish a workflow, enable a brand, change any sample, or call TikTok. Generated workflow files contain existing server configuration and must remain private.

`manual-decision-runtime.cjs` supplies pure bridges between the controller and native nodes. `manual-decision-effect.cjs` keeps dispatch and transport within the same Code invocation. `manual-decision-workflow.cjs` requires a freshly reviewed version, selected-node fingerprint, matching saved/active snapshots and two explicit webhook UUIDs. It preserves the original POST path, write credential, Token Manager and PostgreSQL credential references. The rule branch retains its existing validator, parameterized SQL and response contract. The old manual HTTP implementation has no fallback path.

The graph is a bounded, single-operation sequence without a resume loop:

1. Authenticate and normalize one request; derive the principal from the validated shared credential and the owner from the n8n execution.
2. Commit `claim` through native parameterized PostgreSQL. A refused or repeated claim cannot reach tokens or HTTP.
3. Check the token and the explicit cutover/admission gates. Both gates are **false in every generated candidate**. A failed preflight keeps a terminal blocked reservation.
4. Inside one Code invocation, call the existing authenticated SQL utility with native parameters and commit `dispatch`. Bind the fresh witness to the operation, payload, owner and claim token.
5. In that same invocation, sign and issue the individual review request with a raw body, bounded timeout and redirects disabled. A repeated invocation must repeat dispatch CAS; persisted output from a preceding node never grants HTTP.
6. Classify the full provider response; persist `finish` through native PostgreSQL before responding. Empty/contradictory responses and errors remain uncertain. Missing PostgreSQL receipts do not become success.

Installing the original migration also leaves SQL controls false. Enabling only those controls would still leave these independent runtime gates closed. Do not change either gate until the existing emitters have been cut off and drained and the new admission evidence is proven. Local `first_seen` and an estimated application date do not prove native creation after a cutover.

## Existing endpoint, read-only additions

- `GET ?acao=capacidades` with `X-TTS-Write-Key` returns `contract: tts_manual_runtime_v1`, receipt lookup available, `write: false` and both gates false.
- `GET ?acao=operacao&operation_id=<UUID>&marca=<brand>&application_id=<decimal-string>` with the same header returns the exact `tts_manual_operation_v1` envelope for that principal and resource. It invokes only ledger `get` and never the Token Manager or provider. Missing is not permission to repeat.
- OPTIONS permits GET/POST/OPTIONS and the explicit header. An invalid read key is refused before PostgreSQL.
- A review POST keeps its existing fields but now requires a durable operation UUID and the strict PR45 payload. The old browser review path is not a compatible client; frontend publication must be coordinated separately and preserve uncertain legacy journals.

## Automatic transport removal

`patchAutomatic` replaces only the automatic review Code node and the log parameter binding. Collection and SQL classification are unchanged. The replacement contains no HTTP, signing secret or token. It reports `executadas: 0`; any row whose `dry_run` is not exactly true produces an explicit blocked diagnostic rather than a fabricated execution. It never marks a row as `review executado`. Log values use native PostgreSQL parameters.

A new workflow version cannot revoke an older execution that already has a decision/token in memory. This patch is only one part of the separate cutover and drain plan. Never retry an old execution to prove the patch, restore the unguarded emitter as rollback, clear an uncertain ledger, or use another UUID for the same sample.

## Tests and remaining evidence

`tests/tts-manual-runtime.test.cjs` executes the generated graph in a synthetic VM harness with an isolated PostgreSQL database and a provider stub. It covers disabled controls, independent closed gates, preserved rules, lost claim/dispatch/finish responses, timeout, empty/contradictory provider replies, token failures, exact GET recovery, no repeated transport, and automatic removal. Fixtures that exercise the full transport explicitly open both gates only in their in-memory synthetic graph; generated deployment candidates remain closed.

The repository's dashboard CI runs this test through `tests/*.test.cjs`; the existing manual decision CI separately exercises the PR45 controller and concurrent PostgreSQL contract. These are not hosted n8n or provider proofs. Native PG bindings, hosted node pairing, Code helper response shape, CORS, and worker recovery semantics still need a safe synthetic replica before enablement. The [effect contract](manual-decision-effect.README.md) describes the same-invocation CAS, reviewed utility binding and official helper options. Actual host compatibility must be verified. Repository/VM tests do not claim global exactly-once provider delivery.
