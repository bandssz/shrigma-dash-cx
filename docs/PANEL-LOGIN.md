# Panel entry and shorter credentials

The entry checks identity and allowed areas on the server before opening a panel. Its deadline covers both the HTTP response and its JSON body, even when a request does not honor cancellation. The ceiling is 180 seconds, declared once as `ACCESS_WAIT_MS` and asserted by the tests. While the request is open the entry shows the elapsed seconds and, after eight seconds, says the server is answering slowly; an explicit button lets the operator give up, which aborts the request and opens nothing. There is no automatic retry, because a retry only adds another execution to the same server queue. Expired attempts cannot open a session later; no key is stored persistently in the browser.

The longer ceiling is an interface mitigation for measured server queueing, not a server optimization: on 2026-09-21 the identity call stayed queued past 140 seconds while the n8n API itself answered in under a second. Shortening it again is correct as soon as the queue latency is fixed at the host.

An optional shorter random bearer can be assigned to the same principal with `panel-short-keys.sql`. Only its hash is stored. The original credential remains usable during transition so existing sessions and unresolved receipts keep their access. Both credentials share revocation, expiry, area and explicit operator grants. A short key is not an account name or a predictable password. Provisioning must check uniqueness and use cryptographic randomness (at least 100 bits).

Private delivery includes a separate package per area and a master package. Importing the access JSON avoids typing. Never place these packages, bearer values, access URLs containing secrets, or production evidence in the public repository.

Validation: deadline tests include stalled fetch, stalled body, an operator who gives up, an unavailable server and the declared ceiling; isolated PostgreSQL tests cover the area matrix, unchanged operator identity, legacy transport refusal, expiry and revocation. Runtime changes must use current exports and a version guard. Native parser replacement was not promoted; the existing runtime parser remains in use.
