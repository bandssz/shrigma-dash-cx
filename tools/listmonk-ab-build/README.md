# Listmonk 6.1.0 A/B — artifact for review, OFF

This produces a candidate executable and an exact upstream rollback archive in CI.
The packaging step does not start the executable or access a database. A separate
amd64 smoke step starts the real worker **only in the disposable CI runner**, with an
empty PostgreSQL service, synthetic contacts and a loopback SMTP capturer. It accesses
no operational host or database, creates no release and pushes no registry image.
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
unchecked. The original rollback executable is never run by this workflow.

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

## Before any operational use

A green packaging step proves the transformation and preservation checks. A green
worker smoke adds only the bounded synthetic cases above, **not host compatibility,
throughput, operational readiness or zero impact**. The host must first
be verified as the same Listmonk version and target architecture. A separately reviewed
rehearsal must cover the complete service, schema/functions installed **OFF**, opt-outs,
native checkpoints/pagination, worker interruption/restart, rollback and performance of
both A/B and ordinary campaigns on representative volume. Do not run two emitters.

The source/checksum/manifest is not an activation receipt. Runtime stays OFF until the
actual worker and SQL pairing are proven and a separately authorized rollout occurs.
Rollback requires stopping/canceling A/B and confirming that no buffered batch or
campaign can execute before returning to a binary without the filter; preserve all
operation/evidence tables. An upstream binary would otherwise read the full original
lists. The candidate is not an image or host deployment package.
