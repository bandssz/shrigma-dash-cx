'use strict';
const columns='v.brand,v.kind,v.fact_key,v.revision,v.body,v.body_hash,v.observed_at,v.expires_at,v.source_ref,v.event_ref,v.brand_revision,b.payload_hash AS batch_payload_hash,b.authority_ref,b.envelope';
module.exports=Object.freeze({
 BEGIN_WRITE:'BEGIN ISOLATION LEVEL SERIALIZABLE',BEGIN_READ:'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',COMMIT:'COMMIT',ROLLBACK:'ROLLBACK',
 EVENT:'SELECT brand,source_ref,event_ref,brand_revision,payload_hash,authority_ref,recorded_at,envelope FROM dashboard_crm_controls.control_fact_batches_v1 WHERE brand=$1 AND source_ref=$2 AND event_ref=$3',
 BRAND:'SELECT brand,revision FROM dashboard_crm_controls.control_fact_brand_heads_v1 WHERE brand=$1',
 LOCK_BRAND:'SELECT brand,revision FROM dashboard_crm_controls.control_fact_brand_heads_v1 WHERE brand=$1 FOR UPDATE',
 HEADS:`SELECT ${columns} FROM dashboard_crm_controls.control_fact_heads_v1 h JOIN dashboard_crm_controls.control_fact_versions_v1 v USING(brand,kind,fact_key,revision) JOIN dashboard_crm_controls.control_fact_batches_v1 b ON b.brand=v.brand AND b.source_ref=v.source_ref AND b.event_ref=v.event_ref AND b.brand_revision=v.brand_revision WHERE h.brand=$1 AND (h.kind,h.fact_key) IN (SELECT kind,fact_key FROM jsonb_to_recordset($2::jsonb) AS q(kind text,fact_key text)) ORDER BY v.kind,v.fact_key`,
 HISTORY:`SELECT ${columns} FROM dashboard_crm_controls.control_fact_versions_v1 v JOIN dashboard_crm_controls.control_fact_batches_v1 b ON b.brand=v.brand AND b.source_ref=v.source_ref AND b.event_ref=v.event_ref AND b.brand_revision=v.brand_revision WHERE v.brand=$1 AND v.kind=$2 AND v.fact_key=$3 AND v.revision=$4::bigint`,
 INSERT_EVENT:'INSERT INTO dashboard_crm_controls.control_fact_batches_v1 (brand,source_ref,event_ref,brand_revision,payload_hash,authority_ref,recorded_at,envelope) VALUES($1,$2,$3,$4::bigint,$5,$6,$7::bigint,$8::jsonb) ON CONFLICT DO NOTHING RETURNING brand_revision',
 INSERT_BRAND:'INSERT INTO dashboard_crm_controls.control_fact_brand_heads_v1 (brand,revision) VALUES($1,$2::bigint) ON CONFLICT DO NOTHING RETURNING revision',
 UPDATE_BRAND:'UPDATE dashboard_crm_controls.control_fact_brand_heads_v1 SET revision=$3::bigint WHERE brand=$1 AND revision=$2::bigint RETURNING revision',
 INSERT_VERSION:'INSERT INTO dashboard_crm_controls.control_fact_versions_v1 (brand,kind,fact_key,revision,body,body_hash,observed_at,expires_at,source_ref,event_ref,brand_revision) VALUES($1,$2,$3,$4::bigint,$5::jsonb,$6,$7::bigint,$8::bigint,$9,$10,$11::bigint) RETURNING revision',
 INSERT_HEAD:'INSERT INTO dashboard_crm_controls.control_fact_heads_v1 (brand,kind,fact_key,revision) VALUES($1,$2,$3,$4::bigint) ON CONFLICT DO NOTHING RETURNING revision',
 UPDATE_HEAD:'UPDATE dashboard_crm_controls.control_fact_heads_v1 SET revision=$5::bigint WHERE brand=$1 AND kind=$2 AND fact_key=$3 AND revision=$4::bigint RETURNING revision',
 ORIGINAL:'SELECT brand,operation_id,attempt_id,state,receipt_hash,scope,reservation,reserved_member_count,reserved_members_hash,capacity_evidence_hash,revision FROM dashboard_crm_controls.crm_mvp_operations_v1 WHERE brand=$1 AND operation_id=$2::uuid AND attempt_id=$3::uuid'
});
