-- Original operation only. No credential, customer data, lease or source key is read.
-- Execute only in the existing admitted PostgreSQL session for communicacao/postgres/listmonk.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '8s';
SET LOCAL lock_timeout = '2s';
WITH original AS (
 SELECT operation_id, brand, state, next_chunk, chunks, last_chunk,
        last_chunk_sha256, bulk_operation_id, error_code, updated_at
 FROM crm_audience_v2.shopify_sync_operation
 WHERE operation_id = 'c83ab812-d6d8-467e-97b3-02046bbbdcf5'::uuid
   AND brand = 'aristo' AND kind = 'run'
   AND pg_catalog.current_database() = 'listmonk'
), evidence AS (
 SELECT o.*,
   (SELECT count(*)::integer FROM crm_audience_v2.shopify_product_chunk c
    WHERE c.brand=o.brand AND c.operation_id=o.bulk_operation_id) AS stored_chunks,
   (SELECT count(*)::integer FROM crm_audience_v2.shopify_product_chunk c
    WHERE c.brand=o.brand AND c.operation_id=o.bulk_operation_id
      AND c.chunk_index >= 0 AND c.chunk_index < o.next_chunk) AS stored_prefix_chunks,
   EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_chunk c
    WHERE c.brand=o.brand AND c.operation_id=o.bulk_operation_id
      AND c.chunk_index=o.last_chunk) AS last_attempt_stored,
   (SELECT c.payload_sha256 = o.last_chunk_sha256
    FROM crm_audience_v2.shopify_product_chunk c
    WHERE c.brand=o.brand AND c.operation_id=o.bulk_operation_id
      AND c.chunk_index=o.last_chunk LIMIT 1) AS last_attempt_hash_matches,
   (SELECT b.ready FROM crm_audience_v2.shopify_product_batch b
    WHERE b.brand=o.brand AND b.operation_id=o.bulk_operation_id LIMIT 1) AS product_batch_ready
 FROM original o
)
SELECT pg_catalog.jsonb_build_object(
 'schema','shrigma-original-last-chunk-read-v1',
 'database',pg_catalog.current_database(),
 'transactionReadOnly',pg_catalog.current_setting('transaction_read_only')='on',
 'operationFound',e.operation_id IS NOT NULL,
 'operationId',e.operation_id,
 'brand',e.brand,
 'originalState',e.state,
 'nextChunk',e.next_chunk,
 'totalChunks',e.chunks,
 'lastAttemptIndex',e.last_chunk,
 'storedChunks',e.stored_chunks,
 'storedPrefixChunks',e.stored_prefix_chunks,
 'lastAttemptStored',e.last_attempt_stored,
 'lastAttemptHashMatches',e.last_attempt_hash_matches,
 'productBatchReady',e.product_batch_ready,
 'originalErrorCode',e.error_code,
 'originalUpdatedAt',e.updated_at,
 'completedByOriginal',COALESCE(e.state='completed',false),
 'authorizesRecovery',false,
 'authorizesAudienceRefresh',false,
 'operational',false
) AS original_chunk_evidence
FROM (SELECT 1) anchor LEFT JOIN evidence e ON true;
ROLLBACK;
