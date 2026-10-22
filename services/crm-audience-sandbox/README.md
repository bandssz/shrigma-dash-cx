# CRM audience sandbox

This image exercises the actual `crm-audience` HTTP boundary and audience API/store with a disposable PGlite database. It accepts only synthetic owner addresses ending in `@synthetic.invalid`. The SQL fixture has synthetic lists and contacts; every external source field is explicitly unavailable. The only allowed audience changes are drafts in this isolated database. No network client, campaign endpoint, worker, sender, scheduler, Shopify/Listmonk adapter, or production database is configured.

Build from the repository root with `services/crm-audience-sandbox/Dockerfile` as the Dockerfile and the repository root as context. The Dockerfile-specific ignore list closes the context to the required source and fixture files. The image pins Node 22 by digest, installs locked PGlite 0.3.14, runs as UID 1000, and caps the Node heap at 384 MiB. Set the new service's hard limits to **0.5 CPU and 512 MiB** before build or start.

The runtime requires an exclusive, empty volume mounted at `/sandbox-data`, writable by UID 1000. It fails before database initialization if that path is not a mountpoint. On first boot it seeds the fixture, deletes all fixture credentials, installs exactly two per-runtime synthetic principals, then writes a private manifest with source/function/key hashes. On later boots it requires the same source pins, revision, owner, keys, principal grants, synthetic catalog, and schema function digest. A partial or occupied volume is never overwritten. Remove a disposable volume only after the sandbox has been retired and its data is no longer needed; do not mount any production volume.

Required runtime environment:

| Name | Contract |
| --- | --- |
| `SANDBOX_OWNER_EMAIL` | Lowercase address ending `@synthetic.invalid`; no real account. |
| `SANDBOX_SOURCE_REVISION` | Exact 40-character source commit SHA. |
| `SANDBOX_PUBLIC_ORIGIN` | `https://dashboard-crm-sandbox-20261002.tazdb8.easypanel.host` exactly. |
| `SANDBOX_READ_BEARER` | Independently generated 64-character lowercase hexadecimal test secret. |
| `SANDBOX_WRITER_BEARER` | Different independently generated 64-character lowercase hexadecimal test secret. |
| `PORT` | Optional; defaults to 8080. |

Inject both bearers only through the new service's private runtime environment. They are never baked into the image, stored on the volume, printed, or returned by HTTP. `/identity` accepts either bearer and reports that principal's exact capabilities; `/dashboard` accepts only the reader and returns labeled synthetic Growth data and the exact sandbox `/segments` endpoint; `/segments` uses the real API, which permits reader queries and writer drafts/receipts according to SQL grants. `/healthz` is public and reports only synthetic status and source revision. Other paths return 404. Browser `Origin` is rejected; the portal BFF removes it and authenticates users and CSRF independently.

Catalog timestamps are renewed **only during a `/segments` request** after verifying the exact synthetic catalog/base-list pins. This is a local fixture timestamp, not proof of external source freshness. The sandbox proves the audience store/API/HTTP and portal path against synthetic data. It does not prove production sources, native PostgreSQL roles and concurrency, campaign bindings, delivery, or production data parity. Those require separate gated checks before any production activation.
