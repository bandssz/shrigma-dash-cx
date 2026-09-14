# Engagement journeys in the visual editor

Six new executable journeys: initial NPS, unanswered NPS reminder and popup coupon,
for Fishermans and O Aristocrata. Together with the existing editor this is 26
journeys and 52 stages. Bindings are in `engagement-flow-definitions.json`.

- Published journey/stage pauses are checked before reservation or subscriber updates.
- Template changes use the same immutable claim context for HTTP and finalization.
  A later publication cannot relabel an already reserved message or resend it.
- New NPS templates must retain `nps_url`, `p`, `e`, and `s`, and may use only
  fields supplied by the journey. The email registry also enforces brand ownership.
- Initial NPS and popup remain immediate upon their existing eligible event.
- Reminder eligibility uses the published interval, initially 4,320 minutes.
  Bounds are 1–14 days. Its existing daily 19:00 America/Sao_Paulo scan is unchanged;
  the interval is a minimum age since the initial NPS record, not an exact timer.
- Candidate selection filters published pauses and wait before the 200-item limit.
  Claim repeats the checks, including response, cooldown, subscriber status and dedupe.
- Pausing initial NPS alone does not stop reminders of previous surveys. The separate
  reminder journey controls those. Popup pauses do not create an automatic replay.

Deployment order: register the six original templates and insert missing definitions
with `runtime_ready=false`; apply the validation and claim definitions; update the
NPS candidate query in the existing workflow; verify its active version; enable only
these six definitions and record their initial revisions. Preserve existing drafts,
versions, credentials and other workflow nodes. Use optimistic version guards.

Validation: 58 SQL assertions in a rolled-back subtransaction covered actual API
save/publish/pause, template replacement, candidate/claim agreement and immutable
finalization. Browser checks covered the editor actions with intercepted network
requests. No test messages were sent. Natural delivery verification remains separate.
