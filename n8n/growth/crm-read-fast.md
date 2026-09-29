# CRM read fast candidate

This additive candidate removes Code nodes from the CRM login/cache critical path. It does not replace, edit, activate or disable the shared CX workflows.

`GET /webhook/crm-panel-read-v1?action=identity&painel=growth` returns the existing access identity. `action=cache_growth` authenticates in the same authoritative function and reads only `dash_payload_cache.painel='growth'`. Both require a canonical `Authorization: Bearer …` header. The database function rejects extra/missing query fields, foreign origins, other panels and query-string credentials.

The identity shape stays compatible with the current CRM entry: a master retains all four `allowedPanels`; `permissions.growth` and `permissions.influs` come from the existing operator helper. Authentication still calls `shrigma_panel_auth_v1`, including its usage update. A valid credential with no usable Growth cache gets 503 rather than an empty payload. Error bodies never distinguish an unknown, expired or unauthorized key.

The SQL pins the reviewed authentication/operator bodies and metadata and the required cache column types before creating the reader. It grants nothing. Deployment still needs a fresh readback against the target database and an explicit, reviewed `EXECUTE` grant to the workflow role. The workflow builder requires an existing Postgres credential reference, emits an inactive workflow, has only Webhook, Postgres and Respond nodes, and stores no executions. OPTIONS is static and never authenticates.

This is not evidence that n8n Code queueing caused the observed latency. It only makes the new route independent of Code runners. It does not build or refresh the cache, change CX, expose the live payload query, alter front-end URLs, or enable itself.


The CRM entry uses this isolated route for identity, with a 12-second total deadline including JSON and immediate cancellation. Growth uses the same endpoint for its authenticated cache and retains the 20-minute freshness limit. Missing/stale data shows an explicit retry message; it never starts the expensive shared live query automatically. Existing business journals, other area entries and key scope remain unchanged.

Installation is one atomic DO (guard, CREATE, REVOKE); it cannot replace an existing function. The reviewed live helpers are the short-key versions in `n8n/access/panel-short-keys.sql`. The existing workflow Postgres credential remains the caller; no public execution grant or new key is introduced. Backend invalid-key, manager identity, cache scope/freshness and CORS canaries are required before publishing the front-end assets. Roll back the CRM front-end revision to restore the old URLs; disable only the new read workflow if needed, leaving all snapshots and source tables intact.
