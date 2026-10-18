DO $$BEGIN IF current_database()<>'consent_fixture' THEN RAISE EXCEPTION 'FIXTURE_DATABASE_REQUIRED';END IF;END$$;
CREATE FUNCTION pg_temp.require(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'CASE_FAILED: %',label;END IF;RAISE NOTICE 'CONSENT_CASE_OK:%',label;END$$;
CREATE FUNCTION pg_temp.seed(b text,n integer,pin boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i integer;lid integer;uid uuid;oid uuid;origins jsonb;hash text;state_hash text;
BEGIN
 INSERT INTO subscribers VALUES(n,'enabled'),(n+1,'enabled');
 FOR i IN 0..4 LOOP
  INSERT INTO lists(id,uuid,brand,optin) VALUES(n+i,gen_random_uuid(),b,CASE WHEN i=1 THEN 'double' ELSE 'single' END);
  INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES(n,n+i,CASE WHEN i=1 THEN 'confirmed'::subscription_status ELSE 'unconfirmed'::subscription_status END),(n+1,n+i,'confirmed');
 END LOOP;
 FOR i IN 3..4 LOOP
  oid:=gen_random_uuid();lid:=n+i;hash:=repeat(CASE WHEN i=3 THEN 'a' ELSE 'b' END,64);SELECT uuid INTO uid FROM lists WHERE id=lid;
  UPDATE subscriber_lists SET meta=jsonb_build_object('crm_frozen_request_hash',hash) WHERE list_id=lid;
  state_hash:=crm_audience_v2.consent_member_state_sha256_v1(lid);
  SELECT jsonb_agg(jsonb_build_object('id',id,'uuid',uuid,'optin',optin) ORDER BY id) INTO origins FROM lists WHERE id IN(n,n+i-2);
  INSERT INTO crm_audience_v2.request(actor,operation_key,brand,payload,payload_hash,response,crm_native_consent)
  VALUES('panel:synthetic-owner','freeze-'||lid,b,jsonb_build_object('brand',b,'id',gen_random_uuid()),hash,
   jsonb_build_object('_http',200,'_body',jsonb_build_object('contract','crm-native-frozen-list-v3')),
   jsonb_build_object('schema','crm-native-consent-v1','freeze',jsonb_build_object('list_id',lid,'list_uuid',uid,'origins',origins,'request_hash',hash,'optin','single','list_status','active','member_state_sha256',state_hash),'pin',NULL,'events','{}'::jsonb));
  -- Native meta pins the membership to the immutable original receipt.
  INSERT INTO campaigns(id,brand,created_operation_id) VALUES(n+100+i,b,oid);
  INSERT INTO campaign_lists VALUES(n+100+i,lid);
  INSERT INTO shrigma_campaign_operation VALUES(oid,'panel:synthetic-owner',b,'salvar','pending',n+100+i,clock_timestamp());
  IF pin THEN UPDATE shrigma_campaign_operation SET state='succeeded' WHERE id=oid;END IF;
 END LOOP;
END$$;

BEGIN;
SELECT pg_temp.seed('aristo',100,false);
SELECT pg_temp.require((SELECT count(*)=0 FROM crm_audience_v2.consent_owned_v1()),'pending create never pins');
UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=100 AND list_id=103;
SELECT pg_temp.require((SELECT status='unconfirmed' FROM subscriber_lists WHERE subscriber_id=100 AND list_id=100),'unowned freeze cannot alter origins');
ROLLBACK;

BEGIN;
SELECT pg_temp.seed('aristo',100);SELECT pg_temp.seed('fish',200);
CREATE TEMP TABLE before_receipts AS SELECT actor,operation_key,to_jsonb(r)-'crm_native_consent' image FROM crm_audience_v2.request r;
SELECT pg_temp.require((SELECT count(*)=4 FROM crm_audience_v2.consent_owned_v1()),'finish atomically pins both brands');
UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=100 AND list_id=103;
SELECT pg_temp.require((SELECT count(*)=4 FROM subscriber_lists WHERE subscriber_id=100 AND list_id IN(100,101,103,104) AND status='unsubscribed'),'frozen to own origins and dependent frozen');
SELECT pg_temp.require((SELECT status='unconfirmed' FROM subscriber_lists WHERE subscriber_id=100 AND list_id=102),'derived frozen cannot expand its other origin');
SELECT pg_temp.require((SELECT count(*)=5 FROM subscriber_lists WHERE subscriber_id=200 AND status<>'unsubscribed'),'other brand unchanged');
SELECT pg_temp.require((SELECT count(*)=5 FROM subscriber_lists WHERE subscriber_id=101 AND status='confirmed'),'other subscriber unchanged');
SELECT pg_temp.require((SELECT count(*)=2 FROM crm_audience_v2.request r WHERE brand='aristo' AND (SELECT count(*) FROM jsonb_object_keys(r.crm_native_consent->'events'))=1),'per-campaign backup');
SELECT pg_temp.require((SELECT optin='single' FROM lists WHERE id=100),'optin never changed');
SELECT pg_temp.require((SELECT bool_and(b.image=to_jsonb(r)-'crm_native_consent') FROM before_receipts b JOIN crm_audience_v2.request r USING(actor,operation_key)),'original receipts byte-equivalent after propagation');
SELECT pg_temp.require((SELECT bool_and(crm_audience_v2.consent_event_matches_v1(r.actor,r.operation_key,e.key)) FROM crm_audience_v2.request r CROSS JOIN LATERAL jsonb_object_keys(r.crm_native_consent->'events')e(key) WHERE r.brand='aristo'),'post-image CAS matches all affected campaigns');
UPDATE subscriber_lists SET meta='{"external_change":true}' WHERE subscriber_id=100 AND list_id=101;
SELECT pg_temp.require((SELECT bool_and(NOT crm_audience_v2.consent_event_matches_v1(r.actor,r.operation_key,e.key)) FROM crm_audience_v2.request r CROSS JOIN LATERAL jsonb_object_keys(r.crm_native_consent->'events')e(key) WHERE r.brand='aristo'),'CAS refuses a changed member image');
ROLLBACK;

BEGIN;
SELECT pg_temp.seed('fish',300);
UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=300 AND list_id=300;
SELECT pg_temp.require((SELECT count(*)=2 FROM subscriber_lists WHERE subscriber_id=300 AND list_id IN(303,304) AND status='unsubscribed'),'origin to all own frozen lists');
SELECT pg_temp.require((SELECT count(*)=2 FROM subscriber_lists WHERE subscriber_id=300 AND list_id IN(301,302) AND status<>'unsubscribed'),'origin does not expand other origins');
ROLLBACK;

BEGIN;
SELECT pg_temp.seed('aristo',400);
DELETE FROM subscriber_lists WHERE subscriber_id=400 AND list_id=403;
SELECT pg_temp.require(NOT EXISTS(SELECT 1 FROM subscriber_lists WHERE subscriber_id=400 AND list_id=403),'deleted frozen member not reinserted');
SELECT pg_temp.require((SELECT count(*)=3 FROM subscriber_lists WHERE subscriber_id=400 AND list_id IN(400,401,404) AND status='unsubscribed'),'deleted frozen propagates only closed set');
SELECT pg_temp.require((SELECT crm_native_consent->'events'<>'{}'::jsonb FROM crm_audience_v2.request WHERE operation_key='freeze-403'),'delete backup survives membership');
ROLLBACK;

BEGIN;
SELECT pg_temp.seed('fish',500);
DELETE FROM subscriber_lists WHERE subscriber_id=500 AND list_id=500;
SELECT pg_temp.require((SELECT count(*)=2 FROM subscriber_lists WHERE subscriber_id=500 AND list_id IN(503,504) AND status='unsubscribed'),'deleted origin removes frozen eligibility');
SELECT pg_temp.require((SELECT status='confirmed' FROM subscriber_lists WHERE subscriber_id=500 AND list_id=501),'deleted origin does not remove other origin');
ROLLBACK;

BEGIN;
SELECT pg_temp.seed('aristo',600);
DELETE FROM lists WHERE id=603;
SELECT pg_temp.require((SELECT status='unconfirmed' FROM subscriber_lists WHERE subscriber_id=600 AND list_id=600),'list cascade cannot opt out source base');
SELECT pg_temp.require((SELECT status='confirmed' FROM subscriber_lists WHERE subscriber_id=600 AND list_id=601),'list cascade cannot opt out extra origin');
ROLLBACK;

BEGIN;
SELECT pg_temp.seed('fish',700);
DELETE FROM subscribers WHERE id=700;
SELECT pg_temp.require((SELECT count(*)=5 FROM subscriber_lists WHERE subscriber_id=701 AND status='confirmed'),'subscriber cascade cannot alter another subscriber');
ROLLBACK;

BEGIN;
SELECT pg_temp.seed('aristo',800);
DO $$BEGIN
 BEGIN UPDATE crm_audience_v2.request SET payload='{}' WHERE operation_key='freeze-803';RAISE EXCEPTION 'MUTABLE_RECEIPT';EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'AUDIENCE_HISTORY_IMMUTABLE' THEN RAISE;END IF;PERFORM pg_temp.require(true,'receipt mutation denied');END;
 BEGIN UPDATE crm_audience_v2.request SET crm_native_consent=jsonb_set(crm_native_consent,'{events,x}','{}') WHERE operation_key='freeze-803';RAISE EXCEPTION 'FORGED_METADATA';EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'AUDIENCE_HISTORY_IMMUTABLE' THEN RAISE;END IF;PERFORM pg_temp.require(true,'direct metadata mutation denied');END;
 BEGIN DELETE FROM crm_audience_v2.request WHERE operation_key='freeze-803';RAISE EXCEPTION 'DELETED_REQUEST';EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'AUDIENCE_HISTORY_IMMUTABLE' THEN RAISE;END IF;PERFORM pg_temp.require(true,'request deletion denied');END;
 BEGIN INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES(801,803,'confirmed');RAISE EXCEPTION 'APPENDED_FROZEN_MEMBER';EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'CONSENT_FROZEN_MEMBER_APPEND_DENIED' THEN RAISE;END IF;PERFORM pg_temp.require(true,'member append after pin denied');END;
 BEGIN UPDATE subscriber_lists SET list_id=802 WHERE subscriber_id=800 AND list_id=803;RAISE EXCEPTION 'MOVED_FROZEN_MEMBER';EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'CONSENT_FROZEN_STATE_PROMOTION_DENIED' THEN RAISE;END IF;PERFORM pg_temp.require(true,'move out of frozen list denied');END;
END$$;
UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=800 AND list_id=803;
DO $$BEGIN
 BEGIN UPDATE subscriber_lists SET status='confirmed' WHERE subscriber_id=800 AND list_id=803;RAISE EXCEPTION 'RECONFIRMED';EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'CONSENT_FROZEN_STATE_PROMOTION_DENIED' THEN RAISE;END IF;PERFORM pg_temp.require(true,'reconfirmation denied');END;
END$$;
ROLLBACK;

BEGIN;
SELECT pg_temp.seed('fish',900,false);
INSERT INTO subscribers VALUES(902,'enabled');
DO $$DECLARE kind text;oid uuid;BEGIN
 SELECT created_operation_id INTO oid FROM campaigns WHERE id=1003;
 FOREACH kind IN ARRAY ARRAY['promotion','append','move','meta','optin'] LOOP
  BEGIN
   CASE kind
    WHEN 'promotion' THEN UPDATE subscriber_lists SET status='confirmed' WHERE subscriber_id=900 AND list_id=903;
    WHEN 'append' THEN INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES(902,903,'confirmed');
    WHEN 'move' THEN UPDATE subscriber_lists SET subscriber_id=902 WHERE subscriber_id=900 AND list_id=903;
    WHEN 'meta' THEN UPDATE subscriber_lists SET meta='{}' WHERE subscriber_id=900 AND list_id=903;
    WHEN 'optin' THEN UPDATE lists SET optin='double' WHERE id=903;
   END CASE;
   UPDATE shrigma_campaign_operation SET state='succeeded' WHERE id=oid;
   RAISE EXCEPTION 'MODIFIED_FREEZE_ADOPTED';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'CONSENT_PREPIN_STATE_CHANGED' THEN RAISE;END IF;PERFORM pg_temp.require(true,'pre-pin tampering refused: '||kind);END;
 END LOOP;
END$$;
ROLLBACK;
SELECT 'consent-native-fixture-cases-passed' AS result;
