# Preserve existing schema privileges and retire an uncertain graph plan

This is an offline, one-shot administrative migration. It has no endpoint,
credentials, transport, service operation or automatic retry. It does not install
or activate the graph worker, send messages, change workflow versions, or alter
any role or membership. Production use requires a separately reviewed fresh plan
and an isolated administrative connection whose server `statement_timeout` is
already positive and at most 30 seconds when the single `DO` begins. The migration
connection must use READ COMMITTED; a frozen older snapshot could otherwise omit
roles created before the catalog locks were acquired. Metadata, preparation and
the first DO guard reject other isolation levels.

The problem is an existing `PUBLIC CREATE` grant on schema `public`. Every role,
including `central_leitor`, currently has that privilege. Simply revoking it would
change existing applications' permissions. Preserving login roles only would also
break existing `SET ROLE` targets or NOLOGIN groups. This migration preserves all
current roles, including predefined NOLOGIN roles and identities that can only be
reached through `SET ROLE`.

## Exact scope and preservation

The fresh metadata records every role's attributes (no passwords or configuration
values), membership edges including INHERIT/SET/ADMIN options, hashed role
settings, default ACLs, database identity, schema owner/comment/ACL and every
role's effective CREATE/USAGE with and without grant option. The only accepted
PUBLIC CREATE entry is a non-grantable entry issued by the current schema owner;
the connection must be that owner and a superuser. The graph worker must not
already exist. The whole graph must still be the supported seven-table base, OFF,
with the valid installed CART retention seal and open v2 control.

For each existing role that currently depends on PUBLIC for CREATE, the DO first
grants CREATE directly, without grant option. Existing direct grants and inherited
grants, their original grantors and grant options, USAGE, memberships, roles,
existing tables and schema comments are left intact. It then removes only CREATE
from PUBLIC. The complete effective privilege matrix must be identical before and
after, or the transaction aborts. Existing SET ROLE edges and their targets retain
their abilities; a new unrelated role receives no CREATE. A future role explicitly
made a member of an existing CREATE-capable role may still inherit CREATE. That is
a deliberately preserved administrative capability, not a claim that every
future role is restricted.

There is intentionally no attempt to reinterpret an identity's purpose from its
name. An existing role named `central_leitor` continues to be able to perform DDL
in public, exactly as it could through PUBLIC before this migration. This change
is not a general database privilege cleanup.

## Retire the old uncertain attempt atomically

Removing PUBLIC CREATE could otherwise make a previously submitted graph
installation eligible to run later. The migration therefore requires an explicit
`retired` reference with the SHA-256 of the old reviewed plan and compiled SQL,
and its original graph shape. The original plan and intent are never modified.

Under the same `maintenance-cart-install` then `crm-graph-install` advisory locks
used by the graph installer, the DO adds the named constraint
`crm_graph_retired_install_v1 CHECK (true) NOT VALID` to the OFF graph control
table. This permits every existing and future control row and scans no rows.
The same transaction also performs `UPDATE control SET enabled=enabled` under
the table lock. No stored value changes, but the control row receives a new MVCC
version, and the receipt proves that its `xmin` changed. This update is allowed
only for a plain nonpartitioned control table without triggers, rules, RLS,
inheritance or generated columns. Its only columns must be the two expected
built-in booleans with their original defaults; the only constraints and index
must be the known PK/BTREE(singleton) and CHECK(singleton), plus this migration’s
precisely verified CHECK(true). Extra CHECK functions, expression/partial indexes
and foreign keys are rejected. A fresh metadata guard checks that condition
again while holding the table lock. The CHECK changes the exact structure
fingerprint used by the old installation. Old SQL compiled against that fingerprint now fails before any
installation effect. An older REPEATABLE READ snapshot could still see an old
explicit catalog snapshot, so the row version change also forces its original
`SELECT ... FOR SHARE` to fail with a serialization error. It does not rely only
on catalog visibility. If the old installer is already in its protected section,
this migration refuses with BUSY; if it has committed, the changed graph/role
state refuses before the barrier or ACL writes.

The postcheck proves the new constraint's exact definition and NOT VALID state,
that the complete graph fingerprint changed, and that a fingerprint excluding
only this one named constraint is exactly the original fingerprint. Thus another
structural change cannot be silently bundled into the barrier. Seven base tables,
OFF control, maintenance state, legacy helpers and all other graph metadata must
stay identical. A fresh graph installation must use a newly read shape and a new
reviewed plan. It does not reuse or replay the old intent.

## Atomicity, lock budget and transport

`atomicInstall(before, nonce, retired)` returns exactly one top-level DO. There is
no outer SET, BEGIN, COMMIT or retry. The server timeout must already be configured
on the isolated session before the DO starts; setting it inside the DO would not
bound the active statement. A client's HTTP timeout alone does not bound server
execution and does not prove rollback.

The DO sets transaction-local `lock_timeout=500ms` for each individual lock wait,
then takes nonblocking advisory locks. SHARE locks on the role, membership,
database, namespace, default-ACL and role-setting catalogs freeze the permission
snapshot. They allow ordinary catalog reads and existing application DML, but can
briefly delay concurrent administrative DDL. The graph control table receives an
ACCESS EXCLUSIVE lock for the barrier, so a concurrent reader of that specific
control may briefly wait. The maintenance control row is locked FOR SHARE.
The already-active statement timeout bounds total server execution; 500ms alone
is not a total-duration guarantee. Any error, stale snapshot, timeout, ACL drift,
active graph or failed postcheck rolls back all changes and leaves the connection
healthy without explicit recovery commands.

The receipt lives in its own `crm_schema_acl_migration_v1` schema, not in the graph
schema. It records the before and after metadata, retirement reference and nonce.
PUBLIC has no permission on the receipt schema or table. Readback must run through an independent connection to prove the changes were
committed; a session can see its own uncommitted receipt. No contact or message
content is read or stored. Existing non-PUBLIC default grants are not claimed to
be globally secret: metadata about roles and privileges is not a credential.
The receipt is an administrative audit record; like every database record, a
superuser can change it. Readback independently compares the current ACL and graph
state, not just an HTTP acceptance or receipt existence.

## Local protocol

Inject `io.metadata()`, `io.identity()`, `io.sql(sql)` and `io.receipt()` into
`Installer({root, io, store})`. `identity()` must identify the stable database/service and reviewed isolated
transport/runtime contract without secrets. Verify each physical session and
its settings inside the adapter and record its ephemeral PID separately: a new
connection must be able to reconcile the same stable target after a lost session. A shared
stateful database browser connection is unsuitable. `metadata()` and `receipt()`
return one decoded row from `METADATA_SQL` and `RECEIPT_SQL` respectively.

1. Read and review `snapshot()`, including identity and retirement source proof.
2. Call `prepare({snapshot_sha256: sha(reviewedSnapshot), retired})` in a new private
   evidence directory. FileStore uses exclusive mode-0600 files and fsyncs the
   file and directory. Preparation creates no database changes.
3. Review the concrete plan, SQL hash, existing-role inventory and direct grants.
4. `install(plan_hash)` checks source and plan hashes and a fresh exact snapshot,
   persists the one-shot intent durably, then submits one SQL call.
5. Success requires the exact fresh after-state and durable receipt with the same
   nonce, old plan/SQL hashes and before-state. A null HTTP body is not success by
   itself. The receipt captures the new graph shape for subsequent fresh plans.
6. After any lost or ambiguous response, only `reconcile()` is allowed. It reads
   state and receipt; it never submits SQL. Even unchanged metadata does not permit
   retry. A new manually reviewed recovery decision is outside this module.

Once a subsequent graph installation legitimately changes structure and creates
its worker, this migration's exact after-state check will no longer pass. Keep the
verified boundary receipt as historical evidence and use the next installer's
own readback and seal; do not re-run or rewrite this migration.

## Verification

Local tests execute the exact compiled one-DO payload on PGlite, including late
failure rollback, healthy connection, every-role preservation, grant options,
existing SET ROLE targets, new-role denial, fresh drift, unsafe update-trigger refusal and timeout refusal. They
prove a pre-barrier compiled graph install is refused by its structure guard,
while a fresh composed graph install remains OFF and legacy CART works. Protocol
tests cover fsynced intent, exact readback, missing/mutated receipt, lost response
with and without application, and no automatic retry.

`tests/graph-acl-postgres.cjs` repeats the core execution on PostgreSQL 17.10 with
separate connections, a frozen pre-barrier REPEATABLE READ snapshot, real login
SET ROLE, advisory and catalog contention, and
both brands' synthetic CART claim/finish. It only accepts the isolated CI database
`graph_acl_migration_test`, user `synthetic`, localhost port 5432 and an explicit
isolation flag. No production endpoint or real recipient is used. The dedicated
workflow runs this test; a syntax check alone is not PostgreSQL execution proof.

The row-version retirement follows PostgreSQL 17 [catalog snapshot caveats](https://www.postgresql.org/docs/17/mvcc-caveats.html) and [locking behavior under Repeatable Read](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-REPEATABLE-READ). No automatic retry is allowed for the retired attempt, including after a serialization error.
