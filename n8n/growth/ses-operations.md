# SES operational health and finalization recovery

The current health object is nested at `crm_email_ses.health`. It is independent
of the selected historical date range. Brand-specific counters use the same
recorded telemetry coverage as delivery metrics; pre-coverage sends and test
records do not become missing-delivery alarms.

Signals:
- Successful SQS poll heartbeat, including empty responses. Five minutes without
  confirmation warns of stale collection; it does not prove a delivery failure.
- Sanitized collection errors remain visible for 15 minutes.
- Approximate queue waiting/in-flight/delayed counts, read every minute through
  the existing consumer credential. Missing or stale measurements stay unknown.
- Reservations awaiting finalization, delivered messages with incomplete logs,
  unknown transport outcomes, pending reconciliation and conflicts.
- Observed failures/complaints for sends started in the last 24 hours, and accepted
  sends in that period lacking a final SES outcome for over 15 minutes.

Both schedules live in the existing SES consumer. The original archive → strict
normalization → commit → ACK sequence is preserved. Poll and error recording add
PostgreSQL nodes; queue measurement uses native AWS HTTP and PostgreSQL nodes.
No customer data or credential values are exposed by health views. Alerts appear
in the dashboard; this release does not send external notifications.

`engagement-finalization.sql` classifies HTTP responses inside PostgreSQL. The
n8n parameter expressions only capture the response and original claim context.
The earlier inline JavaScript function passed JS tests but failed in the n8n
expression engine. The replacement was verified on 200 items inside n8n without
sending messages, as well as on genuine resumed pre-transport events.

Transactional Fish/Aristo routes also use native IF nodes around reservation and
acceptance, and classify inside their final PostgreSQL statement. They no longer
need a Code task runner between reservation, HTTP delivery and finalization.

`engagement-recovery.sql` is an explicit repair interface, never an automatic
resend mechanism. It requires captured HTTP acceptance, matching claim/context,
and matched SES Delivery. A dry run rolls back every affected log/marker/audit
row. The applied repair preserves original dispatch state in an audit table.

343 NPS finalizations were repaired on September 15 UTC, including the 200
reminders from the September 14 19:00 São Paulo schedule. Ten original events
that failed before transport were retried using the current workflow: eight
accepted, two stopped by subscriber/cooldown guards. No delivered message was
resent. Historical transactional reservations without sufficient evidence remain
explicit pending work rather than being silently relabeled or retried.

Deployment: apply `ses-health.sql`, then `ses-queue-health.sql`, then the payload
view in `ses-metrics.sql`; apply finalization/recovery functions with privileges
restricted to the existing service owner. Preserve current workflow versions and
credentials when adding the native nodes. Inspect active versions and observe
real poll/queue timestamps after publication.

## Transactional reconciliation and popup sender repair (September 15)

`ses-transactional-recovery.sql` provides an explicit repair for lost HTTP
responses. It requires both SES Send and Delivery for one message, with the
same dispatch, recipient, account, region and configuration set. The complete
archived SNS envelope must pass its stored SHA-256 check. Missing events,
conflicting identity, existing logs and test dispatches are rejected. No HTTP
request or queue retry is part of this function.

Two historical Aristo dispatches were reconciled after 13 rollback checks.
Their original dispatch state and evidence references are retained in
`shrigma_email_tx_recovery`. Acceptance is inferred from provider Send and
Delivery, explicitly marked `RECONCILED_SES_DELIVERY_HTTP_NOT_CAPTURED`;
the HTTP response remains unavailable. Send time comes from SES, and the
unknown template stays NULL. The reservation and claim remain intact.
The other 39 historical transactional outcomes have insufficient evidence and
remain protected against another send.

The absence of popup dispatches was investigated against pre-migration sends.
Both popup forms use the pedidos mailbox; the engagement guard had incorrectly
required the NPS contato mailbox. The claim now validates pedidos for popup and
contato for NPS. Existing Reply-To addresses are preserved: pedidos for Fish
popup, contato for Aristo popup and both NPS routes. This is a database function
change; existing webhooks, credentials and published editor controls are intact.

`tests/sql/engagement-senders.sql` exercises both brands and all three engagement
pieces, including duplicate claims, finalization, concurrent votes, cooldown,
blocklist and uncertain outcomes. Run the entire SQL through the protected
utility; its caught subtransaction rolls back all fixtures without sending mail.
Do not claim popup delivery based only on this test; inspect natural dispatches
and matched SES Delivery after deployment.
