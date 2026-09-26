-- TEST PROFILE ONLY, not a deployment migration or grants for the whole Listmonk UI.
-- SECURITY INVOKER requires table access for the trusted server credential.
CREATE ROLE ab_native_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE ab_native_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE ab_native_unauthorized NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ab_native_api,ab_native_worker,ab_native_unauthorized;

GRANT SELECT ON campaigns,campaign_lists,campaign_media,lists,templates,media,subscribers,subscriber_lists,settings,link_clicks,
 crm_dash_chave,shrigma_panel_permission_v1,shrigma_campaign_validation,
 crm_ab_experiment_v2,crm_ab_arm_v2,crm_ab_member_v2,crm_ab_action_v2,crm_ab_review_v2,crm_ab_runtime_v2 TO ab_native_api;
GRANT INSERT ON crm_ab_experiment_v2,crm_ab_arm_v2,crm_ab_member_v2,crm_ab_action_v2,crm_ab_review_v2 TO ab_native_api;
GRANT UPDATE(state,version,transport_bound,tracking_continuous,window_start,window_end) ON crm_ab_experiment_v2 TO ab_native_api;
GRANT UPDATE(allocated_count) ON crm_ab_arm_v2 TO ab_native_api;
GRANT UPDATE(review_id,actor,experiment_version,checked_at,expires_at,evidence) ON crm_ab_review_v2 TO ab_native_api;
GRANT UPDATE(status,updated_at) ON campaigns TO ab_native_api;
-- SELECT FOR SHARE/UPDATE requires UPDATE on at least one column, even when no
-- statement changes it. These narrow extra grants are an explicit trust cost.
GRANT UPDATE(updated_at) ON lists,templates,subscribers,subscriber_lists,settings,shrigma_campaign_validation TO ab_native_api;
GRANT UPDATE(id) ON media TO ab_native_api;
GRANT UPDATE(singleton) ON crm_ab_runtime_v2 TO ab_native_api;
GRANT EXECUTE ON FUNCTION shrigma_panel_operator_v1(text,text),shrigma_campaign_current(integer),shrigma_campaign_list_brand(lists),shrigma_campaign_audience(integer),shrigma_campaign_is_managed(campaigns),
 crm_ab_api_v2(text,text,jsonb),crm_ab_protocol_valid_v2(jsonb),crm_ab_snapshot_v2(uuid),crm_ab_prepare_v2(text,jsonb,uuid,jsonb),crm_ab_operation_v2(text,uuid),crm_ab_measure_v2(uuid),
 crm_ab_review_evidence_v2(uuid,jsonb),crm_ab_public_review_v2(uuid),crm_ab_control_v2(text,jsonb,uuid,jsonb) TO ab_native_api;

-- Narrow native selection/progress profile. Existing Listmonk web/admin features
-- require their own reviewed grants; this is not a complete service role recipe.
GRANT SELECT ON campaigns,campaign_lists,campaign_media,lists,templates,media,subscribers,subscriber_lists,settings,
 crm_ab_experiment_v2,crm_ab_arm_v2,crm_ab_member_v2,crm_ab_runtime_v2 TO ab_native_worker;
GRANT UPDATE(status,sent,to_send,last_subscriber_id,max_subscriber_id,started_at,updated_at) ON campaigns TO ab_native_worker;
GRANT UPDATE(finished_at,transport_interrupted_at) ON crm_ab_arm_v2 TO ab_native_worker;
GRANT EXECUTE ON FUNCTION crm_ab_delivery_allowed_v2(integer,integer),shrigma_campaign_is_managed(campaigns) TO ab_native_worker;
