-- Synthetic fixture for the live 2026-09-28 SES health view definition.
-- Source SHA-256: 039880495056b8e0d52ccdee53d42e47d852a5fc3e9f903ee427736d8075e260
CREATE TABLE public.shrigma_email_dispatch (
 dispatch_id uuid PRIMARY KEY, brand text, flow text, piece text,
 dedupe_key text, payload_sha256 text, account_id text, region text,
 configuration_set text, recipient_key text, recipient_key_version text,
 is_test boolean NOT NULL, transport_state text, reserved_at timestamptz,
 started_at timestamptz, accepted_at timestamptz, outcome_at timestamptz,
 claim_token uuid, error_code text, send_log_id bigint
);
CREATE TABLE public.shrigma_email_coverage (
 coverage_id uuid PRIMARY KEY, brand text, flow text, piece text,
 is_test boolean NOT NULL, starts_at timestamptz, ends_at timestamptz
);
CREATE TABLE public.shrigma_email_status (
 event_key text PRIMARY KEY, dispatch_id uuid, is_test boolean NOT NULL,
 reconciliation_status text, status text, complaint_type text
);
CREATE TABLE public.shrigma_email_event_ingest (
 ingest_id uuid PRIMARY KEY, result text, received_at timestamptz
);
CREATE TABLE public.shrigma_email_consumer_health (
 key text PRIMARY KEY, last_poll_ok_at timestamptz, last_poll_count integer,
 last_error_at timestamptz, last_error_code text, queue_checked_at timestamptz,
 queue_visible integer, queue_inflight integer, queue_delayed integer,
 queue_error_at timestamptz
);

INSERT INTO public.shrigma_email_coverage VALUES
 ('10000000-0000-0000-0000-000000000001','fish','regular','covered',false,now()-interval '10 days',NULL),
 ('10000000-0000-0000-0000-000000000002','aristo','regular','covered',false,now()-interval '10 days',NULL),
 ('10000000-0000-0000-0000-000000000003','fish','regular','test-coverage',true,now()-interval '10 days',NULL);

INSERT INTO public.shrigma_email_dispatch
 (dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,
  configuration_set,recipient_key,recipient_key_version,is_test,transport_state,
  reserved_at,started_at,accepted_at,outcome_at,claim_token,error_code,send_log_id)
VALUES
 ('20000000-0000-0000-0000-000000000001','fish','regular','covered','f1','','a','r','configured','r','v',false,'in_flight',now()-interval '20 minutes',now()-interval '20 minutes',NULL,NULL,NULL,NULL,NULL),
 ('20000000-0000-0000-0000-000000000002','fish','regular','covered','f2','','a','r','configured','r','v',false,'accepted',now()-interval '20 minutes',now()-interval '20 minutes',now()-interval '19 minutes',NULL,NULL,NULL,NULL),
 ('20000000-0000-0000-0000-000000000003','fish','regular','covered','f3','','a','r','configured','r','v',false,'rejected',now()-interval '1 hour',now()-interval '1 hour',NULL,now()-interval '59 minutes',NULL,'fixture',NULL),
 ('20000000-0000-0000-0000-000000000004','fish','regular','covered','f4','','a','r','configured','r','v',false,'accepted',now()-interval '1 hour',now()-interval '1 hour',now()-interval '59 minutes',NULL,NULL,NULL,NULL),
 ('20000000-0000-0000-0000-000000000005','fish','regular','covered','f5','','a','r','configured','r','v',false,'accepted',now()-interval '1 hour',now()-interval '1 hour',now()-interval '59 minutes',NULL,NULL,NULL,NULL),
 ('20000000-0000-0000-0000-000000000006','fish','regular','covered','f6','','a','r','configured','r','v',false,'accepted',now()-interval '24 hours',now()-interval '24 hours',now()-interval '24 hours',NULL,NULL,NULL,NULL),
 ('20000000-0000-0000-0000-000000000007','fish','regular','covered','f7','','a','r','configured','r','v',false,'outcome_unknown',now()-interval '48 hours',now()-interval '48 hours',NULL,NULL,NULL,NULL,NULL),
 ('20000000-0000-0000-0000-000000000008','fish','regular','uncovered','f8','','a','r','configured','r','v',false,'accepted',now()-interval '1 hour',now()-interval '1 hour',now()-interval '59 minutes',NULL,NULL,NULL,NULL),
 ('20000000-0000-0000-0000-000000000009','fish','regular','covered','f9','','a','r','configured','r','v',true,'in_flight',now()-interval '1 hour',now()-interval '1 hour',NULL,NULL,NULL,NULL,NULL),
 ('20000000-0000-0000-0000-000000000010','fish','regular','covered','f10','','a','r','configured','r','v',false,'accepted',now()-interval '23 hours 59 minutes 59 seconds',now()-interval '23 hours 59 minutes 59 seconds',now()-interval '23 hours 59 minutes 58 seconds',NULL,NULL,NULL,NULL),
 ('30000000-0000-0000-0000-000000000001','aristo','regular','covered','a1','','a','r','configured','r','v',false,'in_flight',now()-interval '10 minutes',now()-interval '10 minutes',NULL,NULL,NULL,NULL,NULL),
 ('30000000-0000-0000-0000-000000000002','aristo','regular','covered','a2','','a','r','configured','r','v',false,'in_flight',now()-interval '16 minutes',now()-interval '16 minutes',NULL,NULL,NULL,NULL,NULL),
 ('30000000-0000-0000-0000-000000000003','aristo','regular','covered','a3','','a','r','configured','r','v',false,'outcome_unknown',now()-interval '2 days',now()-interval '2 days',NULL,NULL,NULL,NULL,NULL),
 ('30000000-0000-0000-0000-000000000004','aristo','regular','covered','a4','','a','r','configured','r','v',false,'accepted',now()-interval '16 minutes',now()-interval '16 minutes',now()-interval '15 minutes',NULL,NULL,NULL,NULL),
 ('30000000-0000-0000-0000-000000000005','aristo','regular','covered','a5','','a','r','configured','r','v',false,'accepted',now()-interval '20 minutes',now()-interval '20 minutes',now()-interval '19 minutes',NULL,NULL,NULL,NULL),
 ('30000000-0000-0000-0000-000000000006','aristo','regular','uncovered','a6','','a','r','configured','r','v',false,'accepted',now()-interval '20 minutes',now()-interval '20 minutes',now()-interval '19 minutes',NULL,NULL,NULL,NULL),
 ('30000000-0000-0000-0000-000000000007','aristo','regular','covered','a7','','a','r','configured','r','v',false,'accepted',now()-interval '25 hours',now()-interval '25 hours',now()-interval '25 hours',NULL,NULL,NULL,NULL),
 ('40000000-0000-0000-0000-000000000001','olivas','regular','uncovered','o1','','a','r','unconfigured','r','v',false,'in_flight',now()-interval '20 minutes',now()-interval '20 minutes',NULL,NULL,NULL,NULL,NULL),
 ('40000000-0000-0000-0000-000000000002','olivas','regular','uncovered','o2','','a','r','unconfigured','r','v',false,'outcome_unknown',now()-interval '2 days',now()-interval '2 days',NULL,NULL,NULL,NULL,NULL),
 ('40000000-0000-0000-0000-000000000003','olivas','regular','uncovered','o3','','a','r','unconfigured','r','v',false,'accepted',now()-interval '20 minutes',now()-interval '20 minutes',now()-interval '19 minutes',NULL,NULL,NULL,NULL),
 ('40000000-0000-0000-0000-000000000004','olivas','regular','uncovered','o4','','a','r','unconfigured','r','v',false,'rejected',now()-interval '1 hour',now()-interval '1 hour',NULL,now()-interval '59 minutes',NULL,'fixture',NULL),
 ('40000000-0000-0000-0000-000000000005','olivas','regular','uncovered','o5','','a','r','unconfigured','r','v',false,'accepted',now()-interval '1 hour',now()-interval '1 hour',now()-interval '59 minutes',NULL,NULL,NULL,NULL),
 ('40000000-0000-0000-0000-000000000006','olivas','regular','uncovered','o6','','a','r','configured','r','v',false,'accepted',now()-interval '1 hour',now()-interval '1 hour',now()-interval '59 minutes',NULL,NULL,NULL,NULL),
 ('40000000-0000-0000-0000-000000000007','olivas','regular','uncovered','o7','','a','r','unconfigured','r','v',true,'in_flight',now()-interval '1 hour',now()-interval '1 hour',NULL,NULL,NULL,NULL,NULL);

INSERT INTO public.shrigma_email_status VALUES
 ('f1-delivery','20000000-0000-0000-0000-000000000001',false,'matched','delivery',NULL),
 ('f2-test-delivery','20000000-0000-0000-0000-000000000002',true,'matched','delivery',NULL),
 ('f4-complaint','20000000-0000-0000-0000-000000000004',false,'matched','complaint','abuse'),
 ('f5-not-spam','20000000-0000-0000-0000-000000000005',false,'matched','complaint','not-spam'),
 ('f6-bounce','20000000-0000-0000-0000-000000000006',false,'matched','bounce',NULL),
 ('f7-delivery','20000000-0000-0000-0000-000000000007',false,'matched','delivery',NULL),
 ('f8-delivery','20000000-0000-0000-0000-000000000008',false,'matched','delivery',NULL),
 ('f10-bounce','20000000-0000-0000-0000-000000000010',false,'matched','bounce',NULL),
 ('a2-bounce','30000000-0000-0000-0000-000000000002',false,'matched','bounce',NULL),
 ('a4-render','30000000-0000-0000-0000-000000000004',false,'matched','rendering_failure',NULL),
 ('a5-complaint','30000000-0000-0000-0000-000000000005',false,'matched','complaint',NULL),
 ('a6-delivery','30000000-0000-0000-0000-000000000006',false,'matched','delivery',NULL),
 ('a7-bounce','30000000-0000-0000-0000-000000000007',false,'matched','bounce',NULL),
 ('o1-delivery','40000000-0000-0000-0000-000000000001',false,'matched','delivery',NULL),
 ('o5-not-spam','40000000-0000-0000-0000-000000000005',false,'matched','complaint','not-spam'),
 ('o6-bounce','40000000-0000-0000-0000-000000000006',false,'matched','bounce',NULL),
 ('global-conflict',NULL,false,'conflict','delivery',NULL),
 ('test-conflict',NULL,true,'conflict','delivery',NULL);

INSERT INTO public.shrigma_email_event_ingest VALUES
 ('50000000-0000-0000-0000-000000000001','pending',now()-interval '16 minutes'),
 ('50000000-0000-0000-0000-000000000002','pending',now()-interval '14 minutes'),
 ('50000000-0000-0000-0000-000000000003','processed',now()-interval '1 hour');

INSERT INTO public.shrigma_email_consumer_health VALUES
 ('ses-events',now()-interval '1 minute',7,now()-interval '2 minutes','FIXTURE_ERROR',
  now()-interval '30 seconds',11,2,3,now()-interval '3 minutes');
