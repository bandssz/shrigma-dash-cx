-- PROPOSED READ ONLY descriptor. Not admitted or called in production.
-- Existing infra_leitura SELECT: ingest_id, topic_arn, event_payload only.
-- $1 after PK, $2 immutable cap, $3 page size (1..100).
-- Consumer must validate campaign UUID, subscriber UUID, recipient identity,
-- provider timestamp, complete PK coverage and an individual-events asOf.
-- Missing/truncated/ambiguous evidence remains unknown. No current-list join.
WITH settings AS MATERIALIZED (
 SELECT $3::integer AS lim WHERE $3::integer BETWEEN 1 AND 100
), page AS MATERIALIZED (
 SELECT ingest_id,topic_arn,event_payload
 FROM public.shrigma_email_event_ingest
 WHERE ingest_id>$1::bigint AND ingest_id<=$2::bigint
 ORDER BY ingest_id LIMIT COALESCE((SELECT lim FROM settings),0)
), decoded AS MATERIALIZED (
 SELECT ingest_id,topic_arn,
 CASE WHEN jsonb_typeof(event_payload->'Message')='string'
      AND pg_input_is_valid(event_payload->>'Message','jsonb')
      THEN (event_payload->>'Message')::jsonb ELSE event_payload END AS event
 FROM page
)
SELECT ingest_id,topic_arn,
 coalesce(event->>'eventType',event->>'notificationType') AS kind,
 event#>>'{delivery,timestamp}' AS provider_at,
 event#>'{delivery,recipients}' AS delivered_recipients,
 event#>>'{mail,messageId}' AS message_id,
 event#>>'{mail,source}' AS sender,
 event#>'{mail,headersTruncated}' AS headers_truncated,
 coalesce((SELECT jsonb_agg(jsonb_build_object('name',h->>'name','value',h->>'value'))
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(event#>'{mail,headers}')='array'
      THEN event#>'{mail,headers}' ELSE '[]'::jsonb END) h
 WHERE lower(h->>'name') IN ('x-listmonk-campaign','x-listmonk-subscriber')),'[]'::jsonb) AS listmonk_headers
FROM decoded ORDER BY ingest_id;
