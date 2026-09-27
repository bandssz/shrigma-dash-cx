# Listmonk 6.1.0 A/B — artifact for review, OFF

This produces a candidate executable and an exact upstream rollback archive in CI.
The packaging step does not start the executable or access a database. Separate
amd64 smoke and recovery steps start real workers **only in the disposable CI runner**,
with empty PostgreSQL databases, synthetic contacts and a loopback SMTP capturer.
A separate SQL load step compares native and modified selection. None accesses an
operational host or database, creates a release or pushes a registry image.
The workflow uploads GitHub Actions artifacts for 14 days with read-only repository
permission. The distributed artifact remains **OFF / not deployed**.

## Verified method

Listmonk [v6.1.0 Makefile](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/Makefile)
and [release configuration](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/.goreleaser.yml)
pack the executable using stuffbin. Its
[go.mod](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/go.mod)
pins stuffbin 1.3.0. Official
[`Stuff` / `GetFileID`](https://github.com/knadh/stuffbin/blob/v1.3.0/stuff.go)
and [`GetStuff`](https://github.com/knadh/stuffbin/blob/v1.3.0/unstuff.go)
support reading and replacing embedded assets while preserving the executable prefix.
No custom binary writer is used here: only the official CLI writes the candidate.
Python independently checks its documented footer and embedded ZIP before and after.

The official linux/amd64 and linux/arm64 releases were downloaded on 25/09/2026;
each archive matched the **published checksums file**, whose own hash is pinned too.
GitHub API `digest` agreed but is recorded as consistency metadata, not a detached
signature or an independent trust source. The exact source commit and all hashes are
in `upstream.lock.json`. Updates fail closed and require a reviewed lock change.

Both releases contain 130 identical assets (about 8.4 MB expanded), including the
expected upstream `/queries/campaigns.sql`. The existing pure patch changes exactly
`next-campaigns` and `next-campaign-subscribers`. CI compiles only stuffbin from pinned
Go/module versions and sums, then performs the official restuff. It preserves:

- the complete executable prefix, checked byte for byte and hashed;
- the same asset paths and permissions, with all **129 other asset contents unchanged**;
- upstream LICENSE and README;
- the **original release archive unchanged**, plus its published checksums file;
- the complete changed query, unified diff, pure patch and build source for review.

ZIP ordering/compression/timestamps and its footer are rebuilt. The assets' bytes and
permissions are compared; metadata timestamps are normalized for a repeatable package.
The embedded Listmonk version string remains the upstream value because the executable
is unchanged. Identify this candidate by its artifact/binary/query hashes, not `--version`.
The artifact includes AGPL licensing and links to the exact corresponding upstream
source; the supplied SQL diff is the complete change to that source.

## Run in an isolated checkout

Requires Python 3.9+, Node 22.14.0 and Go 1.26.1. None are installed by the Python script.

```sh
python3 -m unittest discover -s tools/listmonk-ab-build -p 'test_build.py'
cd tools/listmonk-ab-build
GOTOOLCHAIN=local GOFLAGS=-mod=readonly go mod download
GOTOOLCHAIN=local GOFLAGS=-mod=readonly go mod verify
GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -trimpath -o /tmp/stuffbin-ab github.com/knadh/stuffbin/stuffbin
cd ../..
python3 tools/listmonk-ab-build/build.py --target linux_amd64 \
  --stuffbin /tmp/stuffbin-ab --out /tmp/listmonk-ab-review-NEW
```

The output directory must not exist. `--downloads DIRECTORY` instead uses already
obtained exact locked files and performs no downloads. No credentials or configuration
file are accepted. Downloads are bounded to the known release sizes (under 10 MB each),
expanded binary/assets are bounded, and each final artifact is capped at 64 MiB.
The CLI receives explicit argument arrays; archive paths are never executed or extracted
unchecked. Only the isolated recovery step starts the verified original rollback
executable, after the candidate has exited, runtime is OFF and both A/B arms are terminal.

## Ephemeral worker smoke

The amd64 job uses the verified candidate, its embedded native `schema.sql`, the
current A/B core/selection SQL and a fixed synthetic fixture. The native schema and
`v6.1.0` migration marker follow upstream
[`installSchema`](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/cmd/install.go)
and the [migration list](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/cmd/upgrade.go).
It does not test the interactive installer or create its sample contacts/API users.

The runner accepts no connection URL or application configuration. It requires
GitHub Linux amd64 CI plus explicit isolation opt-in, refuses inherited PostgreSQL
or Listmonk environment overrides, and checks that the fixed local database
`ab_worker_smoke` has an empty public schema before initializing it. PostgreSQL 17.10
is a disposable workflow service; the existing Ubuntu runner `psql` and Python
standard library suffice. There are no added Python packages or service credentials.

The actual Listmonk process binds HTTP to loopback and uses one SMTP server on
`127.0.0.1`. The capture has **no forwarding implementation** and rejects sender or
recipient addresses outside `example.invalid`; every transaction has exactly one
recipient. It caps messages, bytes, commands, concurrent connections and timeouts.
Update checks, bounce collection, external messengers, opt-in notifications and
admin notification recipients are disabled. No production data is loaded.

The fixed cohort deliberately has gaps and overlapping original lists. Before the
worker starts, committed changes unsubscribe two contacts, globally block two,
disable two, revoke two A/B memberships and leave two double opt-ins unconfirmed.
Two further contacts are outside the frozen A/B cohort. With native batch size 1,
the worker must finish all three campaigns and the capturer must observe:

| Campaign | Exact SMTP captures | Required native behavior |
| --- | ---: | --- |
| A | 2 | Assigned recipients only; no B or suppressed contact |
| B | 2 | Assigned recipients only; disjoint from A |
| Ordinary control | 10 | Native list union/opt-out/blocklist semantics; no A/B restriction |

Listmonk natively includes `disabled` contacts in ordinary campaigns; the fixture
expects that behavior to remain unchanged. A/B explicitly excludes them. Every
capture must contain the rendered synthetic subscriber and native loopback
unsubscribe URL. Counters, completion and last-subscriber checkpoints must match;
duplicates, missing sends or unexpected SMTP errors fail the job. The worker has a
120-second deadline, is terminated in cleanup, and the disposable A/B runtime is
returned to OFF. `worker-smoke.json` accompanies the amd64 artifact with results and
source/binary hashes; it is not an operational activation receipt.

Membership is explicitly seeded so the expected envelopes are independent of the
allocator. This smoke therefore covers the real worker and patched query pairing,
**not** UI approval, coordinator authorization, statistical results, SMTP delivery to
real inboxes, mid-buffer opt-out races, interruption recovery or representative load.
Existing A/B contract/concurrency tests cover separate layers. No binary is executed
on the user's machine; arm64 is packaged and verified but not executed by this smoke.

## Ephemeral recovery and rollback

`worker_recovery.py` uses separate empty databases, the same verified amd64 candidate
and bounded loopback SMTP transport. It pauses the first SMTP transaction before
acceptance, commits an opt-out beyond the selected checkpoint, then verifies that a
later batch excludes that contact. This proves the exercised between-batch case;
it does not prove that an opt-out can retract a message already selected into memory.

A second scenario kills the worker before SMTP acceptance and restarts the same
candidate against its saved database. It compares actual captures with the persisted
checkpoints and checks that selected but unaccepted work is not replayed. This exposes
a native recovery limit: preserving a checkpoint does not preserve an in-memory batch.
The product result calculation must remain inconclusive when native `sent` is below
the original allocation; the test does not reduce that denominator or fabricate an
acceptance receipt. The opt-out scenario must also remain inconclusive with that deficit.

Only after the candidate has exited, runtime is OFF and both arms are `finished` or
`cancelled` does the runner start the verified upstream executable for a new ordinary
synthetic campaign. It checks that no A/B arm resumes. Paused arms or runtime OFF alone
are insufficient for this rollback. Cleanup stops the process and leaves runtime OFF.
`worker-recovery.json` accompanies the amd64 artifact and records these bounded cases.
Small deterministic batches and concurrency do not reproduce the host's worker settings,
process topology, abrupt infrastructure failures or delivery to real inboxes.

## Native schema and restricted roles

The separate `isolated-native-roles` job in `.github/workflows/ab-registry-tests.yml`
runs `tests/ab-native-roles.cjs` against a new disposable PostgreSQL database. It applies
the pinned native schema and required campaign/auth dependencies, then core → selection
→ coordinator → API. Restricted synthetic API and worker roles exercise authorization,
atomic prepare/schedule, replay, cancellation while OFF, the complete patched native
queries and writes of transport evidence. Negative grant cases must fail without false
success receipts. Runtime starts and ends OFF.

This is a database test, not a running Listmonk/n8n service or a full application grant
recipe. `SECURITY INVOKER` still requires privileges on underlying tables and row locks.
The tested API role is a trusted backend role, not a browser credential or a
function-only security boundary. Existing host roles, web/admin operations and other
Listmonk features need their own privilege review; do not replace them with fixture roles.

## Synthetic selection load

`selection_load.py` reads the verified upstream and candidate queries from the artifact
and runs them in another empty local PostgreSQL database. It compares counts, complete
pagination, exact recipient sets, overlap and checkpoints before and after synthetic
suppression. Bounded `EXPLAIN ANALYZE` samples cover A/B and ordinary campaigns. There is
no worker, SMTP, external service, recipient export or production connection in this step.

`selection-load.json` and `selection-load-plans.json.gz` accompany the amd64 artifact.
Functional equivalence and latency review are separate outcomes: a successful job can
still contain `review_signals` requiring review. Read the reports for the exact tested
revision and query hash; a query change requires new evidence. This is a synthetic SQL
comparison with a single client, not a throughput or capacity test of the host, its
concurrent workers, prepared-query plans or representative production data.

## Before any operational use

A green packaging step proves the transformation and preservation checks. The separate
worker, recovery, roles and load jobs add the bounded cases above, **not host compatibility,
throughput, operational readiness or zero impact**. Pin the final reviewed revision and
matching query/artifact hashes after any optimization, and review every report and latency
signal. The host must match the Listmonk version and target architecture; arm64 packaging
does not establish that its worker has been exercised.

Before planning a switch, identify the actual image/binary, entrypoint, configuration
mounts, database roles and number of sending processes. Preserve a verified backup of
the artifact actually in use and the database. The included upstream archive is not
proof of equivalence to that host artifact. Review the complete service and SQL/functions
installed **OFF**, actual grants and representative performance. Finish/drain ordinary
campaigns as well as A/B before stopping an emitter; a saved checkpoint alone is not
proof that its in-memory batch is empty. Do not run two emitters or infer safe rolling
deployment from these CI tests.

The authenticated native `GET /api/about` identifies version/build/architecture, but
not the running image digest or executable bytes: the candidate intentionally reports
the same upstream version. A host image recipe must pin the actual base digest, verify
its binary against the packaged upstream, and preserve its user, working directory,
entrypoint, command and mounts while replacing only the verified executable. An image
build must not run the service's install/upgrade startup command. Its eventual execution
and any migration require separate review. Keep the exact prior image available for
rollback; the release tar alone cannot recreate its OS, configuration or filesystem.

The source/checksum/manifest is not an activation receipt. Runtime stays OFF until the
actual worker and SQL pairing are proven and a separately authorized rollout occurs.
Rollback requires all A/B arms to be `finished`/`cancelled`, no pending buffered batch,
runtime OFF and the candidate process stopped before starting the verified prior artifact;
preserve all operation/evidence tables. Paused/OFF alone does not make rollback safe: an
upstream binary would read the full original lists if an A/B campaign could execute.

The tar contains an executable, upstream rollback archive and build/query sources. It
is not an image, host deployment package or complete SQL/API/panel installation bundle.
Coordinator/API SQL, workflow, runtime error mapping, UI modules and host-specific grants
must be reviewed and fixed to the corresponding repository revision separately. See
`n8n/growth/ab-experiment-RUNBOOK.md`; the real Fish/Aristo UI acceptance and any authorized
send remain separate from these synthetic CI proofs.
