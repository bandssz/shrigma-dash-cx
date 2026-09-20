# TikTok read isolation

The TikTok tab keeps successful reads in page memory, scoped to the current read credential and exact date window. It retires only the legacy persistent `shrigma_tts_cache`; operation journals and uncertain reservations remain intact. Reloading the page requires a fresh read.

A refresh marks cached data stale immediately, closing existing mutation guards until a successful read. Network failure can retain only same-access, same-period data, visibly stale and read-only. Authorization refusal clears that cache. Superseded requests are cancelled; reads have a 20-second deadline covering headers and body. Invalid responses or mismatched windows remain unavailable instead of appearing as zero revenue.

Controlled before/after execution of the actual loader found that prior-user cache painting and writable state during refresh changed from present to absent. The financial fixture was unchanged. This is a client reliability measurement, not evidence of reduced server latency or infrastructure cost.

Validation: seven focused isolation scenarios, existing frontend consistency regression, and the full Node suite. Production API schema compatibility is checked separately; published asset verification does not prove a commercial button operation. No API, SQL, financial calculation, sending workflow, or decision admission rule changes are included.
