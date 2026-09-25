-- Synthetic worker fixture only. Requires the empty, disposable ab_worker_smoke DB.
-- Allocation/coordinator authorization are tested elsewhere; this fixes membership
-- explicitly to make the real worker's expected SMTP envelopes independently known.
BEGIN;
INSERT INTO templates(id,name,subject,body,is_default) VALUES
 (1,'Synthetic wrapper','','{{ template "content" . }}',true);
INSERT INTO lists(id,uuid,name,type,optin,tags) VALUES
 (1,gen_random_uuid(),'Synthetic double','private','double',ARRAY['fish']),
 (2,gen_random_uuid(),'Synthetic overlap','private','single',ARRAY['fish']);
INSERT INTO subscribers(id,uuid,email,name)
 SELECT n,gen_random_uuid(),'s'||lpad(n::text,3,'0')||'@example.invalid','Synthetic '||n FROM generate_series(1,16) n;
INSERT INTO subscriber_lists(subscriber_id,list_id,status)
 SELECT n,1,'confirmed' FROM generate_series(1,16) n;
-- Duplicate eligible membership must not create duplicate native sends.
INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES(1,2,'unconfirmed'),(2,2,'confirmed');
INSERT INTO campaigns(id,uuid,name,subject,from_email,body,content_type,status,send_at,messenger,template_id)
 SELECT id,gen_random_uuid(),subject,subject,'Smoke <smoke@example.invalid>',
 '<p>Recipient {{ .Subscriber.Email }}</p><a href="{{ UnsubscribeURL }}">Unsubscribe</a>',
 'html','scheduled',clock_timestamp()-interval '1 minute','email',1
 FROM (VALUES(1,'AB-A'),(2,'AB-B'),(3,'CONTROL')) c(id,subject);
INSERT INTO campaign_lists(campaign_id,list_id,list_name)
 SELECT c,l,'Synthetic' FROM generate_series(1,3)c CROSS JOIN generate_series(1,2)l;
-- ON is temporary and confined to this disposable database. The distributed
-- candidate and migrations remain OFF. Do not use this fixture on a host.
UPDATE crm_ab_runtime_v2 SET enabled=true,
 native_query_sha256='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817',verified_at=clock_timestamp();
INSERT INTO crm_ab_experiment_v2(test_id,brand,protocol,source_list_ids,state,
 window_start,window_end,transport_bound,tracking_continuous)
 VALUES('00000000-0000-4000-8000-000000000001','fish','{}',ARRAY[1,2],'scheduled',
 clock_timestamp()-interval '1 minute',clock_timestamp()+interval '10 minutes',true,true);
INSERT INTO crm_ab_arm_v2(test_id,arm,campaign_id,campaign_version,allocated_count) VALUES
 ('00000000-0000-4000-8000-000000000001','a',1,'synthetic-worker-fixture',7),
 ('00000000-0000-4000-8000-000000000001','b',2,'synthetic-worker-fixture',7);
INSERT INTO crm_ab_member_v2(test_id,subscriber_id,arm)
 SELECT '00000000-0000-4000-8000-000000000001',n,CASE WHEN n%2=1 THEN 'a' ELSE 'b' END
 FROM generate_series(1,14)n;
-- Changes after frozen membership, committed BEFORE native worker selection.
UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id IN(3,4);
UPDATE subscribers SET status='blocklisted' WHERE id IN(5,6);
UPDATE subscribers SET status='disabled' WHERE id IN(7,8);
UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id IN(9,10);
UPDATE crm_ab_member_v2 SET revoked_at=clock_timestamp(),revoked_reason='synthetic'
 WHERE subscriber_id IN(11,12);
COMMIT;
