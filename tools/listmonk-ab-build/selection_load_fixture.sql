-- ONLY the empty ab_selection_load database in the disposable CI service.
-- 100,000 is the A/B cohort limit, not the total installation's audience.
-- Unrelated memberships approximate cardinality only, not real distribution.
BEGIN;
INSERT INTO templates(id,name,subject,body,is_default)
 VALUES(1,'Synthetic wrapper','','{{ template "content" . }}',true);
INSERT INTO lists(id,uuid,name,type,optin,tags) VALUES
 (1,gen_random_uuid(),'Synthetic double','private','double',ARRAY['fish']),
 (2,gen_random_uuid(),'Synthetic overlap','private','single',ARRAY['fish']);
INSERT INTO lists(id,uuid,name,type,optin,tags)
 SELECT n,gen_random_uuid(),'Unrelated synthetic '||n,'private','double',ARRAY['synthetic']
 FROM generate_series(10,18)n;
INSERT INTO subscribers(id,uuid,email,name)
 SELECT n,gen_random_uuid(),'s'||lpad(n::text,6,'0')||'@example.invalid','Synthetic '||n
 FROM generate_series(1,250000)n;
INSERT INTO subscriber_lists(subscriber_id,list_id,status)
 SELECT n,1,'confirmed' FROM generate_series(1,100000)n;
INSERT INTO subscriber_lists(subscriber_id,list_id,status)
 SELECT n,2,'unconfirmed' FROM generate_series(1,100000)n WHERE n%5=0;
-- These 1,000 members are eligible ONLY through single/unconfirmed. The other
-- overlaps exercise deduplication; double/unconfirmed alone is suppressed below.
UPDATE subscriber_lists SET status='unconfirmed' WHERE list_id=1 AND subscriber_id%100=5;
INSERT INTO subscriber_lists(subscriber_id,list_id,status)
 SELECT n,l,'confirmed' FROM generate_series(100001,250000)n CROSS JOIN generate_series(10,18)l;
INSERT INTO campaigns(id,uuid,name,subject,from_email,body,content_type,status,send_at,messenger,template_id)
 SELECT id,gen_random_uuid(),label,label,'Synthetic <smoke@example.invalid>',
 '<p>Synthetic fixture</p>','html','running',clock_timestamp()-interval '1 minute','email',1
 FROM (VALUES(1,'AB-A'),(2,'AB-B'),(3,'CONTROL'))c(id,label);
INSERT INTO campaigns(id,uuid,name,subject,from_email,body,content_type,status,messenger,template_id)
 SELECT n,gen_random_uuid(),'Unrelated '||n,'Unrelated','smoke@example.invalid',
 '<p>Synthetic fixture</p>','html','draft','email',1 FROM generate_series(1001,1150)n;
INSERT INTO campaign_lists(campaign_id,list_id,list_name)
 SELECT c,l,'Synthetic' FROM generate_series(1,3)c CROSS JOIN generate_series(1,2)l;
INSERT INTO campaign_lists(campaign_id,list_id,list_name)
 SELECT n,10+n%9,'Unrelated' FROM generate_series(1001,1150)n;
-- This fixture tests selection only. It does not prove allocation authorization,
-- scheduling, worker concurrency, SMTP throughput or production capacity.
UPDATE crm_ab_runtime_v2 SET enabled=true,
 native_query_sha256='b1a3dafd0502622d70a1b28b8ff09956acc48541bb883ff0e0894089ea42c817',verified_at=clock_timestamp();
INSERT INTO crm_ab_experiment_v2(test_id,brand,protocol,source_list_ids,state,
 window_start,window_end,transport_bound,tracking_continuous)
 VALUES('00000000-0000-4000-8000-000000000001','fish','{}',ARRAY[1,2],'scheduled',
 clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',true,true);
INSERT INTO crm_ab_arm_v2(test_id,arm,campaign_id,campaign_version,allocated_count) VALUES
 ('00000000-0000-4000-8000-000000000001','a',1,'synthetic-selection-fixture',50000),
 ('00000000-0000-4000-8000-000000000001','b',2,'synthetic-selection-fixture',50000);
INSERT INTO crm_ab_member_v2(test_id,subscriber_id,arm)
 SELECT '00000000-0000-4000-8000-000000000001',n,CASE WHEN n%2=1 THEN 'a' ELSE 'b' END
 FROM generate_series(1,100000)n;

-- Test-only tables, not application schema. IDs remain inside this synthetic DB.
CREATE TABLE selection_load_seen(label text,id integer,PRIMARY KEY(label,id));
CREATE TABLE selection_load_expected(phase text,kind text,id integer,PRIMARY KEY(phase,kind,id));
INSERT INTO selection_load_expected
 SELECT phase,kind,n FROM generate_series(1,100000)n
 CROSS JOIN (VALUES('baseline'),('suppressed'))p(phase)
 CROSS JOIN (VALUES('control'),('a'),('b'))k(kind)
 WHERE (kind='control' OR kind='a' AND n%2=1 OR kind='b' AND n%2=0)
 AND (phase='baseline' OR CASE WHEN kind='control' THEN n%100 NOT IN(0,1,3) ELSE n%100 NOT IN(0,1,2,3,4) END);

-- RETURN QUERY uses SPI execution, not a cursor. A FOR ... IN EXECUTE cursor
-- cannot run PostgreSQL queries whose WITH includes a data-modifying statement.
-- Only one native batch (1,000 rows) is materialized by this test wrapper.
CREATE FUNCTION selection_load_batch(query_text text,cid integer,last_id integer,max_id integer)
 RETURNS SETOF subscribers LANGUAGE plpgsql AS $fn$
BEGIN
 RETURN QUERY EXECUTE query_text USING cid,'regular',last_id,max_id,ARRAY[1,2],1000;
END $fn$;

CREATE FUNCTION selection_load_paginate(label_value text,cid integer,max_id integer,query_text text)
 RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE row_id integer;last_id integer:=0;previous_id integer;batch_ids integer[];
 pages integer:=0;requests integer:=0;total integer:=0;checkpoint integer;
BEGIN
 IF cid NOT IN(1,2,3) OR max_id NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'LOAD_SCOPE';END IF;
 UPDATE campaigns SET last_subscriber_id=0,max_subscriber_id=max_id WHERE id=cid;
 LOOP
  requests:=requests+1;
  IF requests>101 THEN RAISE EXCEPTION 'LOAD_PAGE_LIMIT';END IF;
  previous_id:=last_id;
  -- The query is the complete, hash-verified native/candidate statement. It
  -- retains the DML CTE that advances the native campaign checkpoint.
  SELECT coalesce(array_agg(s.id ORDER BY s.ordinality),'{}') INTO batch_ids
   FROM selection_load_batch(query_text,cid,last_id,max_id) WITH ORDINALITY s;
  IF cardinality(batch_ids)>1000 THEN RAISE EXCEPTION 'LOAD_BATCH_LIMIT';END IF;
  FOREACH row_id IN ARRAY batch_ids LOOP
   IF row_id<=previous_id OR row_id>max_id THEN RAISE EXCEPTION 'LOAD_PAGE_ORDER';END IF;
   previous_id:=row_id;
  END LOOP;
  SELECT last_subscriber_id INTO checkpoint FROM campaigns WHERE id=cid;
  IF cardinality(batch_ids)=0 THEN
   IF checkpoint<>last_id THEN RAISE EXCEPTION 'LOAD_EMPTY_CHECKPOINT';END IF;
   EXIT;
  END IF;
  IF checkpoint<>previous_id THEN RAISE EXCEPTION 'LOAD_CHECKPOINT';END IF;
  INSERT INTO selection_load_seen SELECT label_value,unnest(batch_ids);
  total:=total+cardinality(batch_ids);pages:=pages+1;last_id:=previous_id;
 END LOOP;
 RETURN jsonb_build_object('count',total,'pages',pages,'requests',requests,'checkpoint',last_id,'batch_size',1000);
END $fn$;
COMMIT;
ANALYZE;
