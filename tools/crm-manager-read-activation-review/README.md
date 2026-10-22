# READ activation proposal — inert, not approved or executed

Six public-source files: `activation.cjs`, `sources.cjs`, `activation.test.cjs`, `native.test.cjs`, `run-native-proof.sh`, this README. Importing the activation builder does not read environment variables, construct a client, open a socket, start a scheduler or execute SQL. Native tests run only in the disposable CI fixture. No production PG object, credential or deployed flag is changed by this proposal. The existing V3 production installer is not repeated.

The installed core must retain catalog profile `4f5b8bdec729d2924c043da6bd3c0f8f2ce01a82af614187cefa1322ecef11c9`. This is a structure/body/owner/ACL/dependency fingerprint; LOGIN/password/issuer rows are independently checked. `sources.cjs` copies the exact public V3 runtime queries: profile `a20c51e1`, objects `00ebc821`, empty `a55f9a2f`; full SHA-256 constants are in the module, and all three are checked before building a plan. Canonical installer source is `33a412f3` (full pin in `PINS`).

## Fixed approval scope and API

The proposal reserves public UUIDs issuer `b2dc78c6-5f5c-4a7d-b8c8-1dc8bea378d3`, namespace `80e261a9-37b5-45cf-b7aa-374c0d4dfe4b`; login role `crm_manager_provisioner`, domain exactly `oaristocrata.com`. These IDs are not credentials. Change/review source if a different reservation is wanted. Master identity `felipebandeira@oaristocrata.com` and pilot email/password are not provisioned/reset here; pilot email still needs human selection.

`buildPlan('stage')` returns a frozen sequence for one PG17 transaction: exact empty installed4f preflight (4tables/13relations/2indexes/7functions/8types/2roles, 2NOLOGIN, no passwords/memberships), existing advisory lock and table locks, session/log guards, then inactive issuer INSERT and existing provisioner LOGIN with dedicated SCRAM. Owner always NOLOGIN/password absent; role attributes, limit2, owners/core ACL remain unchanged. No new grants/membership/PUBLIC/HBA/global configuration change. The broker remains disabled at this stage. This LOGIN itself requires specific human approval; inactive issuer does not remove inherited PUBLIC privileges.

`buildPlan('activate')` is a separate explicitly approved transaction: same core/role/domain/issuer gates, staged issuer and zero subject/operation/generation/key rows; only that issuer becomes active. It never issues a manager key. Four wrappers stay READ with exact caps `read_content,list_history,submission`; no writer/edit/send capability is added.

`buildPlan('disable',{fromPhase:'active'|'staged'})` is restricted deactivation, not empty rollback. Before it: stop new portal intents, reconcile/revoke all controlled generations while issuer is still active, confirm those receipts/status, then stop broker/pool and verify zero role sessions. Its same-transaction guard refuses remaining prepared/active generations or physical keys still active/not revoked. It makes only the fixed issuer inactive and only the fixed role NOLOGIN. It keeps its verifier, issuer, subject/generation/operation rows and historical receipts; no DROP, key DELETE, master or legacy changes. V3 empty rollback is consequently still inapplicable.

## Execution contract for a future reviewed privileged runner

No runner is shipped. These descriptors are inert; never send them before explicit scope approval and native proof. Use one dedicated PG17 administrative connection to `listmonk` as current_user/session_user postgres. Keep the immutable approved spec and candidate source pins in the durable intent. Persist/fsync phase intent **before BEGIN**, so filesystem work does not consume the 500ms transaction budget.

Execute each plan's commands sequentially: session `transaction_timeout=500ms`, BEGIN SERIALIZABLE, bounded local settings, scope IDs as parameters, full same-transaction preflight/locks/log policy. Only after guard succeeds may stage call `passwordQuery(verifier)` and send its `.text/.values` using pg8.13.1. Its return is one boolean, not the GUC/verifier. Then send the single `.mutating` DO and COMMIT, once. It repeats context/core/state gates and verifies postconditions inside that same transaction. No retry loop. A known refusal rolls back; loss/timeout after mutation dispatch or COMMIT is **outcome_unknown**, not success or an assumed rollback. Stop/discard that private connection; use a fresh READ ONLY readback to reconcile exact state, preserving the same spec/password intention. Do not blindly rerun stage or replace IDs/password to recover.

For readback: set session budget500, use `readOnlyBegin`, bound `scopeQuery`, `readback`, ROLLBACK; rows are profile digest, closed object counts, boolean/count state. Feed their exact typed values to `admitSnapshot(snapshot,phase)`. The admission never selects/returns a verifier, password, key, manager row or raw ACL. Owner/service role flags are individually checked, so aggregate LOGIN counts cannot mask drift. It requires zero service sessions at activation/deactivation admission; it is not a live gateway health or manager-ready test. After startup, authenticated STATUS found:false is the broker/RPC check; it does not prove configured domains by itself and does not create credentials. Do not grant registry SELECT to the broker.

## Secret and environment boundary

SCRAM is runtime-only, exactly SCRAM-SHA-256/4096 with canonical16byte salt and32byte stored/server keys. No plaintext password enters this builder. The verifier is a pg parameter to a transaction-local GUC; descriptor values are nonenumerable to reduce accidental inspection, but `.values` must never be logged/stringified. Driver notices/errors/causes/stacks/query params and raw PG responses must not be published.

ALTER ROLE does not support a PASSWORD $1 directly. Its fixed DO uses `EXECUTE format(...%L,secret)`, so server-side dynamic SQL still contains sensitive authentication material. Before binding: local statement/duration/sample/parameter logging off, error statement threshold panic and verbosity terse (no internal-query context). No global setting changes. Unknown preloads/extensions/observers refuse. `POLICY_QUERY` + `admitPolicy` produce only closed flags/categories and phase: logging refusal, observer refusal, extension-review refusal, supported.

Current policy permits only plpgsql1.0 and optional pgcrypto1.3 on PG17; every other extension/version, observer/preload or audit setting refuses. Root's closed READ ONLY classification (2026-10-03T12:27:15.924Z) found exactly pgcrypto1.3, no vector/pgstat/unknown extension and three empty preloads; role/SQL remain inactive. Root verified the official PG17 pgcrypto control1.3 and absence of startup/executor/utility hooks before authorizing this narrow source policy. No real extension is changed. PGlite lacks pgcrypto binaries: local classification/version tests are not installed-extension proof. Native17 must install pgcrypto1.3 in the disposable fixture and retain exact core4f. Refusal is not authority to disable shared audit or alter global HBA/PUBLIC settings.

PUBLIC legacy EXECUTE/TEMP and local/loopback TRUST remain inherited/shared residual risks. This role is not privilege-isolated to four DB functions; only the broker HTTP surface is. Human approval must explicitly accept the demonstrated isolation/risk boundary, or activation stays blocked. The actual Easypanel external network is shared; it does not establish BFF-only ingress or PG-only egress firewall isolation. The demonstrable boundary is fixed HTTPS hostname/Host + required BFF service token + closed schema/RPC, fixed private PG destination, and no published PG port. The NEW broker endpoint is reachable through public Traefik HTTPS; do not describe it as a source-isolated private endpoint. Broker holds PG secret, BFF only broker token; no shared PG socket/volume/PID/netns is proposed. Shared-network and inherited DB risks require an explicit decision, not an unavailable new firewall promise. PG TLS/admission belongs to the parallel gateway proposal; pg8.13.1 DNS host and certificate SAN must match, with no certificate bypass.

## Tests and remaining native gate

Author local proof: **14 distinct tests PASS, 0fail/0skip**, Node22.23.3, env-i, external-network guard. Four tests use disposable PGlite from the existing public READ fixture: full production guard refuses divergent context before secret binding; exact catalog readback/body parses and refuses divergent profile; isolated exact mutation fragments stage/activate plus restricted STATUS preserve admin; actual READ prepare→refused disable with live key→revoke→disable preserves historical receipts. Fragment positive tests deliberately do not claim installed4f/PG17 admission or native500ms execution.

`activation.test.cjs` also exports inert `proveNativeActivation(t,{db,fixture})` for the existing guarded `tools/crm-manager-install-review/native-fixture.cjs` on its disposable cluster. It will run canonical33a install, exact full stage/activate/disable SQL and READ ONLY admission under500ms, prove restricted STATUS/no registry SELECT, core4f and preserved legacy baseline. **Not executed here**; native PG17 PASS is mandatory before proposing real activation. No OCI/DB/server was started by this package.

Local command (paths may be supplied by the parent; no real env):

```sh
env -i PATH=/usr/bin:/bin NODE_PATH='<workspace>/.private/test-tools/node_modules' \
  '<workspace>/.private/test-tools/node22-rfm-proof/node' \
  --require /private/tmp/dashboard-v22-intent-20261002/manual-renewal-network-guard.cjs \
  --test tools/crm-manager-read-activation-review/activation.test.cjs
```

Remaining release gates: environment policy/proof; independent source review and native exact500ms proof; explicit LOGIN/issuer activation approval; private runner/closed durable outcomes; fixed broker TLS/network admission; new canary READ flag and human master+pilot E2E/revoke. No production login/issuer/manager key/SQL/flag activation is implied by these synthetic tests.


## Portable candidate CI hook (proposal only)

`native.test.cjs` is the authoritative full native entry point for this patch. It uses the guarded existing native fixture and an additional NEW container from `run-native-proof.sh`, after the V3 install/empty-rollback script has cleaned its container. Existing `native-fixture.cjs`, canonical SQL, runtime/bootstrap/HBA, production flags and other workflows are not edited. The script retains the exact local daemon/HBA hash/cluster context/PG17.10/loopback5438/memory512MiB/CPU1/tmpfs/cleanup constraints. Each suite starts from its own empty DB; no restore or adoption of previous fixture state.

In `native-postgres-v3-install-rollback-proof`, append exactly this one line after the existing `bash tools/crm-manager-install-review/run-native-v3-proof.sh` (that step already supplies V3 opt-in and pg8.13.1 NODE_PATH):

```sh
CRM_MANAGER_READ_ACTIVATION_NATIVE_PROOF=1 bash tools/crm-manager-read-activation-review/run-native-proof.sh
```

No publisher marker or production setting changes. Missing opt-in fails rather than passing with a skipped native test. The native suite reuses the existing actual25P04/lock-release proof, creates pgcrypto1.3 in the disposable DB, installs exact33a and demands exact4f before/after. It executes full stage/inactive/noPREP/LOG_GUARD/500ms SQL; an actual pgClient's wrong password must fail28P01 and the correct dedicated password must authenticate. Inactive issuer STATUS is correctly ISSUER_DENIED; found:false is proved only after explicit activation.

The broker's exact `admissionSql(false)` is embedded with SHA256 `061b26a7034191e0c79c6980e7afdb79e114d2e0c1cf5c859ecde23c943a656b`: all nine booleans must be true on the actual service-authenticated connection. A role switch with SET SESSION AUTHORIZATION is not used for this transport proof. Loopback127.0.0.1:5438 is strictly the synthetic fixture; it does NOT claim the deployed broker's fixed comunicacao_postgres:5432 connection, HTTPS ingress, health or private-network guarantees. Native PG is plaintextsslfalse matching the observed server mode, never asserted TLS. No HTTP server is opened.

READcaps3 prepare is an isolated SQL fixture write; disable must refuse a live key, then actual revoke permits disable while keeping receipts and the one new revoked key. The legacy snapshot excludes only that one newly introduced principal; all existing key/permission/PW-independent metadata/defaults/roles remain equal. Actual passwords/verifiers are random in RAM, never written or printed; errors/events are consumed and reported with a generic fixture failure.

Native suite has NOT run here. Only author PGlite/pure tests and syntax/hook checks are local evidence. The full exact PG17/pgcrypto/500ms/SCRAM/metadata pass must come from candidate CI before any human LOGIN/issuer activation request.
