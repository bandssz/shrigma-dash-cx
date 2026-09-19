-- Run this one statement outside an explicit transaction.
-- Preflight: inspect pg_index/pg_get_indexdef for this name and for equivalent
-- indexes. Refuse a conflicting or invalid index; IF NOT EXISTS would hide it.
-- The current health metric is global, with this exact predicate:
-- result='pending' AND received_at < now()-interval '15 minutes'.
-- Only the stable result filter belongs in the partial-index predicate.
-- This index changes neither ingestion state nor the metric's time window.
CREATE INDEX CONCURRENTLY shrigma_email_ingest_pending_received_ix
ON public.shrigma_email_event_ingest USING btree (received_at)
WHERE result = 'pending';
