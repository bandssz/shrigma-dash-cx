# Prepared API and worker

Status: code and queue contract only. No real job, producer, database connection,
schema installation, schedule or cutover is enabled by this package.

Use the single canonical Dockerfile:
`ops/releases/crm-native-connection-20261007/Dockerfile`, repository root context.
The same image contains the API, worker, existing PostgreSQL driver and both
health commands. The production envelope is added later; these commands do not
depend on its launcher. Current Compose command and health overrides stay valid.

| Service | Required environment | Command | Health |
| --- | --- | --- | --- |
| API | `SHRIGMA_PROCESS_ROLE=api` (image default), existing admitted operational API configuration and identity | `node /app/prepared-worker/command.cjs api` | `node /app/prepared-worker/command.cjs health-api` |
| Worker | `SHRIGMA_PROCESS_ROLE=worker`, `SHRIGMA_WORKER_EXECUTION=disabled` | `node /app/prepared-worker/command.cjs worker` | `node /app/prepared-worker/command.cjs health-worker` |

API initialization requires the existing admitted operational/corporate profile;
a generic synthetic configuration is intentionally refused by the native helper.
Image tests use a fresh disposable identity and generated credentials with that
profile, without production identity, database or network.

Docker defaults `start` and `health` dispatch by the validated process role.
Configure the worker role **and explicit worker command** before any replica.
The present `shrigma-dash-cx` API/worker services remain at zero replicas with
auto deploy disabled. This document does not authorize their activation.

Worker health binds only `127.0.0.1:8081`; health runs inside the same container.
It reports `prepared`, the source revision and both manifest hashes, zero
handlers, `executionEnabled:false`, `databaseConnected:false` and
`queueSchemaApplied:false`. It proves preparation, not an operating queue.
SIGTERM/SIGINT close the local server. No polling or execution loop exists.

`queue.sql` is an uninstalled PostgreSQL contract. Admission still needs a
dedicated database/schema binding, credentials and custody; never use Listmonk.
Do not put credentials or message/customer content in `payload_ref`; use a fixed
internal reference to the immutable published version. Publication never changes
the revision already recorded on a task.

The future executor role may update only state, owner, ownership_token, acquired_at,
attempt_count, updated_at and finished_at. The producer may insert and read; neither
role receives UPDATE on event identity, execution_revision or payload_ref. No role
or grant is installed by this contract.

The unique event identity is `(brand,kind,event_id)`, excluding revision: a new
release does not permit replay. Ownership, attempt counter and attempt history
remain in this same PostgreSQL queue. A future handler must atomically select a
due pending task for its exact execution revision using `FOR UPDATE SKIP LOCKED`,
assign owner/token, increment its bounded attempt count and insert the matching
attempt in one transaction. Completion must condition both updates on task,
revision, owner/token and attempt number; zero affected rows rolls back. This
contract supplies no automatic retry, takeover, external lock or side journal.

No function, trigger, source-table change or automatic SQL installer is included.
The schema must be backed up and its return proved before a later application.
Real handlers require their own admission and source-preserving migration.
The legacy TEST guard in branch `codex/crm-legacy-test-control8c-20261023` remains
uninstalled; this prepared worker does not claim that migration is complete.

Domain cutover is a separate slice: first prove main equals production, have
Infrastructure preserve the full before configuration, and obtain Felipe's
specific approval. Return means restoring the domains to the current portal.
