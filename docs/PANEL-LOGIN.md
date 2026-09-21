# Panel entry and shorter credentials

The entry checks identity and allowed areas on the server before opening a panel. Its 25-second deadline covers both the HTTP response and its JSON body, even when a request does not honor cancellation. At eight seconds it explains the delay. Expired attempts cannot open a session later; no key is stored persistently in the browser.

An optional shorter random bearer can be assigned to the same principal with `panel-short-keys.sql`. Only its hash is stored. The original credential remains usable during transition so existing sessions and unresolved receipts keep their access. Both credentials share revocation, expiry, area and explicit operator grants. A short key is not an account name or a predictable password. Provisioning must check uniqueness and use cryptographic randomness (at least 100 bits).

Private delivery includes a separate package per area and a master package. Importing the access JSON avoids typing. Never place these packages, bearer values, access URLs containing secrets, or production evidence in the public repository.

Validation: deadline tests include stalled fetch and stalled body; isolated PostgreSQL tests cover the area matrix, unchanged operator identity, legacy transport refusal, expiry and revocation. Runtime changes must use current exports and a version guard. Native parser replacement was not promoted; the existing runtime parser remains in use.
