# CRM campaign HTTP service

Bounded transport for the existing `campaign-runtime.js`. The business engine,
durable PostgreSQL claims, campaign versions, opt-out checks, explicit schedule
confirmation, native draft creation and no-send content previews are reused.
There is no queue, sender, automatic retry, or customer-send endpoint here.

The deployed browser contract stays at
`/webhook/crm-campanhas-api-a40da4ef222efba3f7278e35` on its current host. Preserve
that URL during cutover: operation journals are bound to it. Route only this
path to the new service; keep the original n8n host/root and other webhooks.
Do not disable the legacy workflow while an existing execution may still run.
Both transports share the durable operation claim, so an uncertain request
must continue using its original idempotency key.

A future media rollout must also route the exact `<campaign path>/media`
subpath to this same service. The base campaign path and every unrelated n8n
path remain unchanged. Keep `CRM_CAMPAIGN_MEDIA_ENABLED=false` until that
mapping, the new image and the read-only library checks are verified; this
candidate does not assert that the media route has been published.

GET accepts the published Bearer header, with legacy query `k` only when no
header was provided. POST preserves `body.k`. Origin is restricted to
`https://bandssz.github.io` when present. Keys, server contexts, leases, SQL,
native credentials and exception details never appear in service logs or HTTP
responses. All database calls are fixed parameterized wrapper calls.

`crm_campaign_api` has only EXECUTE on the two gateway wrappers. The wrappers
recheck authentication, capability, actor, brand and the durable operation for
each effect. Native create/preview must receive a confirmed SQL guard before
HTTP. No direct table privilege or owner credential belongs in the service.

The pool has four connections and twelve admitted requests. A read has a
16-second HTTP deadline; a write has 85 seconds, below the existing browser's
90-second deadline. A deadline or disconnected client prevents the next
business effect. Only finalizing a previously claimed operation may continue.
The admission slot remains occupied until that reconciliation actually ends.
SQL has a 12-second statement limit; native HTTP has a 20-second limit, no
redirects, and a bounded response. An uncertain remote outcome remains
uncertain and is reconciled through the existing operation endpoint.

Configuration: `CRM_CAMPAIGN_REVISION` (40-character source commit),
`CRM_CAMPAIGN_ENABLED=true`, `PORT=8080`, `PGHOST`, `PGPORT=5432`,
`PGDATABASE=listmonk`, `PGUSER=crm_campaign_api`, `PGPASSWORD`,
`LISTMONK_ORIGIN`, `LISTMONK_USERNAME`, `LISTMONK_TOKEN`. Provision secrets
directly in the service environment. Startup defaults to disabled.

The same service can expose `GET|POST <campaign path>/media` when
`CRM_CAMPAIGN_MEDIA_ENABLED=true`; it is off by default. `GET` requires the
existing `read_content` capability. `POST` requires `edit_content`, checks the
same actor again immediately before the native request, and accepts only PNG,
JPEG or GIF files up to 2 MB and 4 megapixels. Filenames contain the brand, a
new operation UUID and the content hash, never the browser filename. Existing
unsupported Listmonk media are filtered from a page rather than making the
whole library fail.

An upload uses one native POST and no automatic retry. The browser records the
operation in session storage before sending and reconciles an uncertain result
with an exact filename lookup. A manual retry is offered only after that lookup
reports the file missing, with an explicit duplicate warning. This reduces
duplicates but is not durable idempotency across browsers or cleared sessions.

`GET /healthz` reports process/configuration state, media flag and revision. It does not
prove database or Listmonk availability. Before cutover, verify authenticated
GETs for both brands on the new service domain. Prove writes only against the
isolated PostgreSQL/native fixture; do not create or schedule real campaigns
as a deployment check. Verify the routed revision header, CORS, both brands,
and an unaffected n8n health route after cutover. Rollback removes only the
new domain mapping, retaining the new service and all operation records.

Engine review for this incident: the active n8n bundle SHA-256 was
`54a866c0d0a6c3fdbe0a0a2f64c30d2dbf4c6b4d9e0684423137e60148d87eb2`.
The reused source produces
`7618064730ff974c98d286faab689b51cb1d15988cac4623912161d638abecde`.
This is an explicit upgrade, not byte parity: only the deterministic errors
`AB_V2_CAMPAIGN_FROZEN` and `AB_V2_SCHEDULE_REQUIRED` and their messages were
added. Effects, SQL, hashing, payloads and business flow are unchanged.
