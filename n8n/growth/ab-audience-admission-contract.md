# A/B admission inspection DTO — shadow candidate

`ab-audience-admission-contract.cjs` defines the small, public inspection DTO for
`crm-ab-audience-admission-inspect-v1`. It is disabled (`ENABLED=false`) and has
no database, HTTP, credentials, storage, admission, recipient selection, or send
implementation. Schema validation and a deterministic digest do not establish
that an inspection came from an authenticated server or verified sources.

The request action is `ab_publico_admissao_inspecionar`, with exactly `acao`,
`brand`, `test_id`, `expected_version`, `expected_scope_hash`, and `review_id`.
Brands are `fish` and `aristo`; identities are lowercase UUID v4; versions are
positive integers up to 999999999; scope hashes are lowercase SHA-256 hex.
Additional fields, including SQL, credentials, recipients and material bodies,
are rejected. The trusted server must independently authenticate and authorize
the caller and resolve every requested identity within that brand.

The inspection contains exactly:

- `test_id`, `brand`, `experiment_version`, `scope_hash`, `review_id`.
- Canonical UTC `checked_at`, `expires_at`, and `send_at` timestamps, with
  milliseconds. Expiry is after the check and within five minutes. Send time is
  at least fifteen minutes after the check. These are relative consistency
  checks; this pure contract does not read a clock or establish current freshness.
- `audience`: `audience_id`, `audience_revision`, `cohort_hash`,
  `eligible_fingerprint`, `arms`, `minimum_reached=true`, `checked_at`, and
  `snapshot_only=true`.
- `materials`: exactly arms `a` and `b`, each with `arm`, `campaign_id`, the
  legacy MD5 `campaign_version`, and the SHA-256 `material_hash`.
- `blockers`: exactly `external_material_unconfirmed` followed by
  `execution_path_not_installed`. Neither can be removed in this version.

Audience arms are ordered `a`, `b`, have distinct campaign IDs, and contain
exactly `arm`, `campaign_id`, `allocated`, `eligible`, `excluded`, `revoked`, and
`missing`. Allocation is positive and at most 50000 per arm. Other counts are
integers between zero and 100000, with `eligible + excluded = allocated` and
`revoked + missing <= excluded`, matching the confirmed audience review.
Each material campaign ID must match the corresponding audience arm. The DTO
does not include the protocol minimum itself; the trusted inspector must prove
`minimum_reached` from the protocol and current review before constructing it.

`audience.checked_at` is the canonical UTC statement timestamp of the final
`Allocated.resolveAllocated` snapshot, no later than the parent `checked_at`
and at most five minutes earlier. The parent timestamp marks completion of the
authentication/time boundary checks. These timestamps have different meanings.
Under READ COMMITTED, an insertion of a previously missing membership can occur
after audience resolution. `snapshot_only=true` explicitly describes an
observed statement snapshot; it does not promise a serializable cutoff across
all audience, membership and final authorization reads, or freeze eligibility
through the parent timestamp or future send time.

`request()` and `inspection()` return detached, deeply frozen values.
`seal()` returns `{contract, inspection, ...FLAGS}`, with `inspection_hash`
added to the validated inspection. The digest is precisely
`H.digest({contract: VERSION, inspection: raw})`, using the existing bounded
canonical JSON/SHA-256 implementation. It includes the timestamps and all raw
inspection fields, excludes its own hash, and excludes envelope flags. Contract
versioning pins the flag semantics. Digests are integrity identifiers, not
signatures or replay-safe authorization tokens.

Every envelope fixes `authorizes_selection=false`, `authorizes_send=false`,
`execution_blocked=true`, and `external_dependencies_complete=false`. A material
hash does not prove attachment bytes, global rendering configuration, recipient
personalization or final rendered message identity. External material and the
execution path remain unconfirmed. This candidate does not admit or schedule an
experiment and must not be interpreted as permission to send.

All DTOs are limited to 20000 UTF-8 bytes, 1000 nodes and depth 12 before use.
Accessors, proxies, symbols, cycles, non-plain objects, sparse arrays, fractional
numbers, unsafe integers, and negative zero are rejected. Validation failures
expose only static `AB_ADMISSION_INPUT` (400) or `AB_ADMISSION_CORRUPT` (503)
errors. No input value is included in an error message.
