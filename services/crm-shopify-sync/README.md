# CRM Shopify sync

Runs the pinned Customer/Order/LineItem bulk query outside n8n and writes only through the existing `shopify_ingest_product_chunk` contract. The HTTP response is a small operation receipt; customer data, Shopify tokens and signed download URLs are never journaled or logged.

Install `segment-shopify-sync-runtime.sql` as `postgres`, deploy this image with a private network and bearer key, then patch each pinned n8n workflow with `segment-shopify-service-patch.cjs`. Configure each brand's app client id and client secret; the short-lived Admin token is obtained with `client_credentials`, retained only in memory and never logged. Keep `CRM_SHOPIFY_SYNC_ENABLED=false` until SQL, credentials, readback and recovery checks pass.

The service serializes all brands, records start intent before Shopify mutation, blocks ambiguous starts, and reconciles every chunk against its durable hash before retry. `/v1/recover` accepts a completed bulk id and resumes already committed chunks; it does not assume chunk zero.

Production sizing must include the whole service. The real Fish file used about 488 MiB RSS with a 512 MiB V8 heap, so a 512 MiB container has no margin. Keep the explicit 256 MiB old-space limit in this image and provision 1 GiB until whole-service RSS is measured. One process and one operation at a time are required.

Credentials may instead come from `CRM_SHOPIFY_SYNC_SECRETS_FILE`: a regular private JSON file mounted for the `node` user, maximum 4096 bytes, with no group/other permissions or symlink. Its exact six keys are `PGPASSWORD`, `CRM_SHOPIFY_SYNC_KEY` and the client id/secret pair for each brand. Public environment settings retain all activation, lease and memory controls; duplicate credentials in environment and file are rejected. Deploy the bind mount through Easypanel without returning credential values through tool outputs.
