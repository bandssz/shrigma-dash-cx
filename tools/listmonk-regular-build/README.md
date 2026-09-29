# Guarded regular e-mail candidate (local only)

This directory adds a separate, additive send API to the exact Listmonk 6.1.0
and `smtppool` 2.0.2 sources pinned in `upstream.lock.json`. It does not edit the
upstream `Emailer.Push` or `Pool.Send` methods, start a worker, access a database,
or contact an SMTP server outside the loopback tests. It is a candidate for
review and disposable proof only; it is not deployed or enabled.

## Contract

The public candidate methods are:

```go
type GuardedEnvelope struct {
    From          string
    To            string
    PayloadSHA256 string
}

type GuardedAuthorize func(GuardedEnvelope) error

func (p *Pool) SendGuarded(email Email, authorize GuardedAuthorize) (GuardedSendResult, error)
func (e *Emailer) PushRegularGuarded(message models.Message, authorize smtppool.GuardedAuthorize) (smtppool.GuardedSendResult, error)
```

`GuardedSendResult.Outcome` is one of `not_started`, `accepted`, or
`outcome_unknown`. Code must branch on that phase result, never on error text.

The guarded path accepts exactly one `To` recipient and refuses `Cc` and `Bcc`.
It constructs and validates the envelope and complete MIME byte slice, borrows
one SMTP connection, then calls `authorize` exactly once immediately before the
first `MAIL` command. `GuardedEnvelope` contains the parsed envelope sender,
the single parsed recipient, and lowercase hexadecimal SHA-256 of the exact
byte slice subsequently passed to `Write`; it exposes no body or credential.

Failure before `MAIL`, including connection acquisition, message construction,
or authorization failure, is `not_started`. Authorization rejection returns an
unused connection to the pool without issuing `RSET`, `MAIL`, or `DATA`. Once
`MAIL` is invoked, every error is `outcome_unknown`; the connection is closed,
the DATA writer is not closed after a body write failure, and there is no second
attempt. Only a positive reply from closing DATA is `accepted`. Greeting,
TLS/auth negotiation, pool wait, the SMTP transaction, final ACK, and post-ACK
`RSET` have socket deadlines derived from `PoolWaitTimeout`. A silent greeting
is `not_started`; a silent final ACK is `outcome_unknown`. A failed or timed-out
`RSET` cannot change `accepted` and only discards the connection. The
synchronous authorization callback must enforce its own database timeout.
Legacy retry settings do not affect this path, and no failure calls the legacy
methods.

The worker overlay integrates that callback with the candidate receipt store in
`n8n/growth/segment-regular-delivery.sql`. It checks binding/control before
selection, selects one bound recipient at a time, carries the raw subscriber
snapshot, creates a fresh dispatch UUID before MIME construction, and adds the
reserved SES tags `crm_dispatch_id` and `crm_test=false`. For bound messages it
removes every campaign-supplied spelling of `X-SES-Configuration-Set`, inserts
exactly one value read from the private delivery control, and passes that
effective value to `regular_delivery_claim_live(instance,cid,sid,did,worker,
runtime,from,to,payload_sha,snapshot,configuration_set)`. The SQL wrapper must
compare that value with the locked control after the inner claim and roll back
the whole claim on mismatch. Unbound messages retain their original headers.
The callback claims
only after SMTP connection acquisition and validates the committed database TTL
against all local transaction time. Accepted and unknown outcomes require a
durable matching finish. Unknown, in-flight, render failure, missing context,
and uncertain database acknowledgements stop the pipe without legacy cursor or
sent-count updates. An empty bound batch is finalized only after locking the
campaign, checking unresolved receipts, and rerunning the selector in the same
transaction.

The source remains an OFF-by-default candidate. Production retains its existing
draft-only guard until the separately reviewed SQL and service deployment. The
candidate admission API validates and schedules a bound campaign only against an
approved live lease, sender policy, current audience and immutable review. This
worker heartbeats its actual executable/runtime identity and refreshes only the
native catalog; it cannot approve identities or enable deployment or sender
policy. Deployment must also prove the number of campaign-emitting processes;
one observed container does not establish a single emitter. Durable recovery of
`outcome_unknown` remains an external administrative action and never resumes
a suspended campaign automatically.

## Deterministic overlay

Apply only to disposable copies of both complete source trees:

```sh
python3 tools/listmonk-regular-build/build.py \
  --listmonk-root /tmp/listmonk-6.1.0-copy \
  --smtppool-root /tmp/smtppool-2.0.2-copy
```

The generator verifies all pinned upstream and overlay hashes before changing a
file, refuses symlinks and differing pre-existing outputs, writes atomically,
and is idempotent for identical outputs. It adds these files:

- `internal/messenger/email/regular_guarded.go`
- `internal/messenger/email/regular_guarded_test.go`
- `guarded.go`
- `guardedproof/guarded_test.go`

It also performs one exact, hash-pinned transformation of `smtppool/pool.go`:
the private pooled connection retains its underlying `net.Conn`, and both the
legacy constructor and the guarded constructor populate that field. This does
not change `Pool.Send`, its retry rules, or its I/O behavior. The guarded
methods alone use the retained connection to set and clear deadlines.

Apply the worker integration, after the SMTP overlay, to the same disposable
Listmonk copy:

```sh
python3 tools/listmonk-regular-build/worker_patch.py \
  --listmonk-root /tmp/listmonk-6.1.0-copy \
  --repo-root /path/to/this/repository
```

This second generator verifies the official Manager, pipe, subscriber model,
and campaign-query hashes. Its query output is exactly the final output of
`patchRegularWorkerSource`; it performs no SQL transformation after the pinned
query hash. It adds the Manager and Store overlays and tests, refuses differing
outputs, writes atomically, and is idempotent.

To compile Listmonk against the copied dependency without changing either
`go.mod`, create a temporary Go workspace containing both copied module roots.
Run `go test ./guardedproof` in the copied `smtppool` root and
`go test ./internal/messenger/email` in the copied Listmonk root with that
workspace selected. The SMTP proof binds the callback digest to captured bytes
and covers denial, consent revoked while waiting for the sole connection, DATA
rejection, body-connection loss, final ACK loss, silent greeting/ACK/RSET, and
recipient rejection. Its
server listens only on an ephemeral loopback port and cannot forward mail.

`python3 -m unittest tools/listmonk-regular-build/test_build.py` checks generator
idempotence and fail-closed drift/conflict behavior without requiring upstream
source or network access.

The candidate also exposes `--crm-regular-identity`. This diagnostic path exits
before media, core, postback, importer, auth, notifications, cron, workers and
HTTP initialization. It requires exactly one enabled SMTP configuration, builds
the real Emailer and Manager without opening an SMTP connection, suppresses
configuration logs, and prints only `worker_sha256` and `runtime_sha256`.

`native_proof.py` installs the official schema in disposable PostgreSQL 17.10
and runs the stuffed native binary against a synthetic loopback SMTP server.
`--pg-bin`, `--source-dir`, `--runtime-dir`, and `--node-path` make the same
harness usable by Linux CI with externally prepared, pinned inputs; local
cache paths remain defaults. The harness never uses port 5432, requires the
explicit isolated opt-in, and records whether the disposable cluster stopped.
The completed local proof covers an accepted Fish delivery, an Aristo final-ACK
loss recorded as `outcome_unknown`, restart without replay, a bound campaign
quarantined without blocking the shared scanner, and an unbound campaign that
retains the legacy path without receipt or guarded headers. It verifies the
digest of the exact captured bytes, durable counters/cursors and shutdown of
the disposable cluster. Candidate 7 additionally installs the operational
guard while every bound campaign is draft and every gate is OFF, applies a
synthetic administrative approval, waits for the committed heartbeat and real
Fish/Aristo catalog refresh, and only then schedules through the guard. It also
proves takeover of an expired nonsuspended lease by a new process UUID. This
proof remains synthetic, OFF, local-only and is not admission, deployment or
evidence about production topology.

The worker candidate also implements the private lease contract in
`segment-regular-worker-lease.sql`. A scanning process generates one UUID and
hashes its executable once. Before starting the shared scanner it runs a
READ COMMITTED heartbeat transaction and requires a confirmed COMMIT. It then
renews every 20 seconds. The effective Manager and SMTP runtime fingerprint is
recomputed at every heartbeat and every claim. Bound delivery additionally
requires the confirmed local lease deadline (kept as a conservative monotonic
deadline); the database remains the authority through
`regular_delivery_claim_live`. A failed, timed-out or commit-uncertain
heartbeat clears only local bound authority. A valid `ready:false` response is
committed because it can contain a durable suspension; legacy campaigns keep
using the original scanner and sender path.

An expired nonsuspended lease can be acquired by a replacement process.
`competing_instance`, `identity_changed` and `deployment_off` suspensions are
durable and require explicit administrative review and clearing. The worker
does not approve its own hashes, enable a deployment or campaign, renew a
catalog from an external source, or recover one of those suspensions. The
heartbeat goroutine has its own stop channel and wait boundary, and repeated
Manager Close calls are safe; the upstream scanner's pre-existing lifecycle is
outside this additive candidate. Stop does not cancel an already running SQL
transaction; it waits for that call's existing 12-second context deadline.
Managers with `ScanCampaigns=false` never acquire or renew a lease, and that
flag is part of the runtime fingerprint, so a passive identity cannot renew the
approved scanning runtime.

The v2 runtime fingerprint covers the effective Manager and guarded SMTP
configuration plus a render identity. The render identity hashes the fully
merged `i18n.I18n.JSON()` map and language code, the effective local timezone
name/TZ value and sampled rules, and the sorted bound-template policy. This
pins external `i18n-dir` contents by their effective merged values rather than
by a path. The executable hash continues to pin the Go/template implementation
and embedded assets.

Bound campaign material must contain no media/attachments because their bytes
can come from a filesystem or remote media store after the database snapshot.
Its subject, campaign body, base template and alternate body must not invoke
any of these identifiers:

`Date`, `L`, `ago`, `date`, `date_in_zone`, `date_modify`, `now`,
`htmlDate`, `htmlDateInZone`, `dateInZone`, `dateModify`, `randAlphaNum`,
`randAlpha`, `randAscii`, `randNumeric`, `randBytes`, `randInt`, `shuffle`,
`uuidv4`, `bcrypt`, `htpasswd`, `genPrivateKey`, `genCA`, `genCAWithKey`,
`genSelfSignedCert`, `genSelfSignedCertWithKey`, `genSignedCert`,
`genSignedCertWithKey`, `encryptAES`.

`L` is rejected because its exported `Load` method can mutate the shared
language map during rendering. The remaining entries depend on wall clock or
random/global state. Listmonk already
removes Sprig's `env`, `expandenv` and `getHostByName`, so they fail template
compilation. A bound compile or policy failure pauses the campaign through the
existing status path; unbound campaigns retain the upstream function map and
media behavior. The panel admission must apply this same attachment rule and
identifier set to the exact campaign/template material before enabling its
control row; worker validation remains the final fail-closed check.

`TrackLink` remains supported because it is part of the dashboard's real
campaign contract. Listmonk's `links.url` uniqueness makes registration
idempotent for the prepared destination, and the guarded claim records the hash
of the final bytes after link expansion. This does not make the link registry
part of campaign material: changing a stored tracking destination later can
change post-send routing without changing the email bytes. Operational access
to link mutation therefore remains an external integrity dependency.
