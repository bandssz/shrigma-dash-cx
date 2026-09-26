# Native Listmonk 6.1.0 test proof — disposable CI only

This harness executes the **unmodified official Linux amd64 release**, not an A/B candidate or CRM transport. It creates a fresh PostgreSQL 17.10 database and only synthetic `example.invalid` records. No production credentials, panel endpoints, campaigns, suppression records or user accounts are read or changed. It does not implement a campaign-test feature or authorize deployment.

## Evidence produced

`report.json` records API status, decoded MIME checks/hashes and native database snapshots:

| Case | Expectation from the pinned source; CI must confirm |
|---|---|
| Unknown test recipient | HTTP 400, zero SMTP messages, identical database snapshot. No subscriber creation. |
| Existing subscriber, JSON `template_id=2` | Request body/subject rendered with the campaign's stored wrapper 1. JSON assigns the ID after the wrapper query. |
| Existing subscriber, query + JSON `template_id=2` | Wrapper 2, request body and `[TESTE]` subject; saved campaign content remains unchanged. |
| Blocklisted / unsubscribed subscribers | The native test path does not apply these suppressions. Record status and decoded SMTP evidence explicitly. This is **not** CRM permission to send. |
| One open and one click | Extracted URLs must contain the real synthetic campaign/subscriber identity. Only loopback requests are made; redirect is inspected, never followed. Native `campaign_views` and `link_clicks` attribution must increase. |
| `/tx`, external mode | A separate transaction template renders to an absent synthetic address, without registering it. UUID/name remain empty; no campaign wrapper or automatic campaign tracking. This does **not** prove equivalence to campaign rendering. |

Each campaign stays `draft`, `started_at` remains null, and the saved configuration, subscriber rows and memberships must remain unchanged. `sent`, `to_send`, global links/views/clicks and per-campaign/per-subscriber counters are recorded separately rather than assumed to mean delivery. SMTP receipt proves capture by this local sink, not deliverability to a real inbox. The harness performs five synthetic SMTP captures, seven cases, and no campaign scheduling/status changes. No test request is retried automatically.

## Isolation

The workflow downloads and verifies the official archive and its published checksums before execution. Pins came from the existing verified upstream lock; no runtime dependency on the A/B code is used. `upstream.py` retains the executable unchanged and checks its embedded native schema/query. SHA256 checks are reproducibility/integrity evidence, not a detached signature.

A dedicated unprivileged runner user has an OUTPUT firewall that permits only loopback and the exact disposable PostgreSQL container on TCP 5432; other IPv4 and all IPv6 egress are rejected. The process receives a cleared environment, fixed database name/host/user, synthetic API token and no repository credentials/proxy settings. The SMTP capture binds 127.0.0.1, rejects MAIL/RCPT outside `example.invalid`, permits one recipient per transaction, caps payload/messages/connections and never forwards mail. Native notifications, update checks, public subscription, bounce scanners and other messengers are disabled. Cleanup kills the dedicated user's processes before removing its ephemeral firewall rules.

Only the synthetic report, bounded failure log and upstream manifest are uploaded. No image, registry push, release, installed host service, CRM capability, A/B SQL or production access exists in this workflow. The CI opt-in is mandatory; local Docker is not required. No local native service has been run as evidence for this change.

## Primary sources

All behavior references are pinned to official commit `1b5e8d38c778e869003486d3c38bc7a964661e91`:

- [`cmd/campaigns.go`](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/cmd/campaigns.go): `TestCampaign`, `sendTestMessage`, field validation and wrapper lookup.
- [`internal/core/subscribers.go`](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/internal/core/subscribers.go): `GetSubscribersByEmail` rejects an entirely absent set.
- [`internal/manager/manager.go`](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/internal/manager/manager.go), [`cmd/public.go`](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/cmd/public.go): campaign tracking identity and counters.
- [`cmd/tx.go`](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/cmd/tx.go), [`models/messages.go`](https://github.com/knadh/listmonk/blob/1b5e8d38c778e869003486d3c38bc7a964661e91/models/messages.go): ephemeral external recipient and transaction template rendering.

Local guard tests: `python3 -m unittest discover -s tools/listmonk-test-probe -p 'test_*.py'`. These tests do not claim the native API proof; that result comes only from the isolated workflow report for its exact HEAD.
