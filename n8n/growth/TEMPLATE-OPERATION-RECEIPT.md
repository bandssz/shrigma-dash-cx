# Template operation receipt (read only)

`template-operation-patch.cjs` patches a **fresh, version-matched** export of the existing template workflow. It changes authentication, preparation, parameter binding, read formatting and response headers. Connections, write/claim/finish functions, provider calls and existing template content are preserved. There is no migration or new transport.

## Request

`GET ?acao=operacao&idempotency_key=<saved-key>&operacao=rascunho|validar|submeter`

Send the existing write credential in `X-Template-Key`. Do not put credentials or template content in the URL. The authenticated actor must have the respective `draft`, `validate` or `submit` capability. A read credential does not authorize this lookup. Other routes keep their existing authentication behavior.

A fixed PostgreSQL SELECT uses `$1` for the idempotency key and `$2` for the authenticated actor. Both the completed idempotency record and the durable submission claim are consulted. The query never reserves, executes, retries or polls a provider. Another actor's record is indistinguishable from a missing record.

## Response

HTTP 200 contains `{contract:'template_operation_v1', operation:{idempotency_key, acao, actor, request_payload, request_sha256, hash_schema:'json-stable-sha256-v1', state, response, claim_id}}`.

`request_payload` is the exact persisted five-field request:

```js
{ acao, rascunho: body.rascunho ?? null, draft_id: body.draft_id ?? null,
  expected_version: body.expected_version ?? null, confirm: body.confirm ?? null }
```

It excludes credentials and the idempotency key. `rascunho` is limited to the existing GR content fields, examples and buttons; incompatible/legacy payloads are not returned as verified evidence. SHA-256 uses UTF-8 bytes of `JSON.stringify(stable(payload))`, where `stable` recursively sorts object keys with `Object.keys(...).sort()` and preserves array order. Numeric object keys follow normal JavaScript JSON ordering. This is **not** PostgreSQL `jsonb::text` or FNV. Responses expose only operator-facing fields, without raw provider requests/headers or previews.

| State | Meaning |
|---|---|
| `completed` | A terminal stored receipt is available; examine its `response.status/body` to distinguish success and rejection. |
| `pending` | A durable submission claim remains reserved. Do not repeat. |
| `outcome_unknown` | The stored result is uncertain. Do not repeat. |
| `missing` | No own-actor record was visible. Does not prove the original request was never executed. |
| `legacy_unverifiable` | Full identity/content/revision evidence is unavailable or unsupported. Do not repeat. |
| `inconsistent` | Records or receipt identity disagree. Do not repeat. |

A missing result has null payload, hash, response and claim ID, but retains the lookup identity and authenticated actor. A new UUID may be preflighted before the first durable local reservation; a missing result **after** that reservation must not unlock it.

For submission, `claim_id` is a different identifier from `idempotency_key`. Completed submission receipts must agree between both tables, match actor, draft, expected revision and claim. Successful receipts also match `body.operation_id === claim_id` and `submission_id === 's_'+claim_id.replace(/-/g,'')`. Draft creation requires revision 1; updates require expected revision plus 1; validation requires the exact expected revision.

## Deployment checks

Install against a newly exported matching version, inspect the five-node diff and preserve unrelated changes. Read back the active workflow before enabling clients. Verify a known own-actor receipt, a nonexistent UUID, read-capability denial and wrong-actor isolation using only GETs. Verify the actual proxy/n8n `OPTIONS` response for `X-Template-Key` from the dashboard origin: response headers alone do not prove browser preflight works. Responses declare `Cache-Control: private, no-store`, `Vary: Origin, X-Template-Key`, and the permitted method/header names. No browser automatic retry is permitted.

The Node tests exercise the generated Code paths and run the fixed query in isolated PostgreSQL with `BEGIN READ ONLY`, synthetic records and unchanged-row assertions. They do not prove deployment, cross-origin routing or an actual provider receipt.
