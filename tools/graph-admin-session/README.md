# Dedicated CRM administrative session

`dbgate-6.cjs` is an operator-side adapter for the audited DbGate **6.0.0**, build `2024-12-05T11:13:04.194Z`. It creates and closes its own PostgreSQL session through an existing DbGate service. It does not manage services, edit saved connections, activate workers or send messages.

```js
const { createDbGateSession } = require('./dbgate-6.cjs');
const session = createDbGateSession({
  origin,                        // HTTPS origin, from private configuration
  accessToken,                   // Easypanel token, memory only
  connection: { id, server },    // Expected saved PostgreSQL connection
  reads: [
    { sql: reviewedMetadataSql, columns: ['metadata'], maxRows: 1 },
  ],
  authorizeWrite: async ({ sql, sha256, session: identity }) => {
    // Caller must match the exact reviewed plan, pinned identity and hash,
    // then durably record intent BEFORE returning true. No SQL retry.
    return authorizeExactPlanAndPersistIntent(sql, sha256, identity);
  },
});
try {
  const proof = await session.open();
  const stableIdentity = await session.identity();
  const rows = await session.sql(reviewedMetadataSql);
  // Only after review, durable intent and independent deployment safeguards:
  // await session.sql(exactReviewedSingleDo);
} finally {
  await session.close();
}
```

`open()` authenticates only when the server advertises exactly its configured anonymous provider. Easypanel bootstrap accepts only a same-origin root redirect and a host-only, HttpOnly root cookie. Redirects are never followed automatically. Requests and credentials stay on the HTTPS origin. Runtime version, connection identity, PostgreSQL driver and database-URL mode are checked before session creation. The database is `listmonk`, user `postgres` and configured TCP port is 5432. Credentials are never accepted in SQL or emitted by this adapter.

The session has a generated application name and `statement_timeout = 20000`. `identity()` returns `{version, sessionid, database, role, pid, statement_timeout_ms, application_name, transaction_isolation, transaction_read_only, autocommit}`. It requires READ COMMITTED, writable mode, the original backend PID and two consecutive independently dispatched `txid_current()` values that differ. Those read-only probes allocate transaction IDs but write no application tables; changing IDs are excluded from the stable identity. Automatic pings every ten seconds keep the owned session alive during plan review. `close()` requests termination of only that session and requires its close event.

`sql()` accepts exact SELECT strings declared by trusted operator code, plus one reviewed `DO $graph_install$…$graph_install$;` or `DO $acl_preservation$…$acl_preservation$;`. The read allowlist is not a general SQL sandbox: audit those constants for side effects and sensitive output. Writes require the authorization callback and are attempted at most once per session, including uncertain outcomes. A false callback sends nothing; an uncertain callback consumes the write attempt. No raw upstream error, connection definition or SQL result outside the declared columns is logged or returned.

Completion requires the execution acknowledgement, this session's SSE completion without an error event, and—for SELECTs—a finished result file with exact declared columns and bounded rows. Events belonging to other sessions are discarded before their JSON is parsed. HTTP bodies have a total deadline and size limit. Lost transport or SSE makes the session unusable for further SQL; there is no reconnect or retry. Independent readback through another connection remains required to establish that a migration committed. A same-session receipt alone is insufficient.

The adapter uses the following official sources at tag `v6.0.0` (`3b91d921e847592ab2062e4b5598ee210bca66c5`):

- [Session API and dedicated child process](https://github.com/dbgate/dbgate/blob/v6.0.0/packages/api/src/controllers/sessions.js).
- [Connection wait, statement splitting and asynchronous result files](https://github.com/dbgate/dbgate/blob/v6.0.0/packages/api/src/proc/sessionProcess.js).
- [PostgreSQL client and query execution, without a BEGIN wrapper](https://github.com/dbgate/dbgate/blob/v6.0.0/plugins/dbgate-plugin-postgres/src/backend/drivers.js).
- [SSE event encoding](https://github.com/dbgate/dbgate/blob/v6.0.0/packages/api/src/utility/socket.js) and [result access](https://github.com/dbgate/dbgate/blob/v6.0.0/packages/api/src/controllers/jsldata.js).
- [Authentication routes](https://github.com/dbgate/dbgate/blob/v6.0.0/packages/api/src/controllers/auth.js).

DbGate logs submitted SQL on its server. Use only reviewed migration/metadata SQL without credentials, DSNs, contact data or secret literals. The adapter performs no log collection. Mock protocol checks run with `node --test tests/journey-graph-admin-session.test.cjs`; they are not evidence of a production installation.
