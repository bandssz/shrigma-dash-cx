-- Narrow source_event -> entry/owner bridge for the reviewed CART epoch.
-- Installation is inert and grants no table write privilege to the worker role.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $install$ BEGIN
 IF to_regclass('crm_graph_candidate.cart_epoch_v1') IS NULL OR to_regprocedure('crm_graph_candidate.cart_enroll_v1(text,uuid)') IS NULL
 OR to_regclass('crm_graph_candidate.cart_admission_receipt_v1') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.cart_admit_source_v1(text,uuid,uuid,integer,text)') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.cart_canonical_v1(jsonb)') IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_graph_worker' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit)
 OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname='crm_graph_worker') OR m.roleid=(SELECT oid FROM pg_roles WHERE rolname='crm_graph_worker'))
 THEN RAISE EXCEPTION 'GRAPH_ADMISSION_DEPENDENCY_OR_COLLISION';END IF;
END $install$;
CREATE TABLE crm_graph_candidate.cart_admission_receipt_v1(
 source_ref uuid PRIMARY KEY REFERENCES crm_graph_candidate.source_event_v1(id),
 epoch_id uuid NOT NULL,journey_id uuid NOT NULL,brand text NOT NULL CHECK(brand IN('fish','aristo')),
 expected_version integer NOT NULL CHECK(expected_version>0),revision integer NOT NULL CHECK(revision>0),entry_id uuid NOT NULL UNIQUE,cache_target text NOT NULL,
 source_revision text NOT NULL CHECK(source_revision~'^[a-f0-9]{64}$'),receipt jsonb NOT NULL,created_at timestamptz NOT NULL,
 FOREIGN KEY(epoch_id,brand) REFERENCES crm_graph_candidate.cart_epoch_v1(id,brand),
 FOREIGN KEY(entry_id,brand) REFERENCES crm_graph_candidate.entry(id,brand),
 FOREIGN KEY(journey_id,revision,brand) REFERENCES crm_graph_candidate.revision(journey_id,revision,brand)
);
CREATE TRIGGER graph_cart_admission_receipt_immutable BEFORE UPDATE OR DELETE ON crm_graph_candidate.cart_admission_receipt_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.cart_immutable_v1();
CREATE FUNCTION crm_graph_candidate.cart_canonical_v1(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE out text;item jsonb;k text;parts text[]:='{}';
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'null' THEN RETURN 'null';WHEN 'boolean' THEN RETURN v::text;WHEN 'number' THEN RETURN v::text;WHEN 'string' THEN RETURN v::text;
 WHEN 'array' THEN
  parts:='{}';FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP parts:=parts||crm_graph_candidate.cart_canonical_v1(item);END LOOP;
  RETURN '['||array_to_string(parts,',')||']';
 WHEN 'object' THEN
  parts:='{}';FOR k,item IN SELECT key,value FROM jsonb_each(v) ORDER BY key LOOP parts:=parts||(to_jsonb(k)::text||':'||crm_graph_candidate.cart_canonical_v1(item));END LOOP;
  RETURN '{'||array_to_string(parts,',')||'}';
 ELSE RAISE EXCEPTION 'GRAPH_ADMISSION_JSON';END CASE;
END $fn$;
CREATE FUNCTION crm_graph_candidate.cart_admit_source_v1(b text,sid uuid,jid uuid,expected integer,target text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,crm_graph_candidate SET lock_timeout='3s' AS $fn$
DECLARE s crm_graph_candidate.source_event_v1%ROWTYPE;o crm_graph_candidate.source_observation_v1%ROWTYPE;j crm_graph_candidate.journey%ROWTYPE;
 r crm_graph_candidate.revision%ROWTYPE;ep crm_graph_candidate.cart_epoch_v1%ROWTYPE;existing crm_graph_candidate.entry%ROWTYPE;done crm_graph_candidate.cart_admission_receipt_v1%ROWTYPE;
 source jsonb;trigger_id text;entry_id uuid;at timestamptz;at_text text;identity jsonb;state jsonb;event_key_val text;identity_hash_val text;enrolled jsonb;reply jsonb;
BEGIN
 IF coalesce(b,'') NOT IN('fish','aristo') OR sid IS NULL OR jid IS NULL OR coalesce(expected,0)<1 OR coalesce(target,'')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RAISE EXCEPTION 'GRAPH_ADMISSION_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('graph-cart-admission:'||sid::text,0));
 SELECT * INTO done FROM crm_graph_candidate.cart_admission_receipt_v1 WHERE source_ref=sid;
 IF FOUND THEN
  IF done.brand<>b OR done.journey_id<>jid OR done.expected_version<>expected OR done.cache_target<>target THEN RAISE EXCEPTION 'GRAPH_ADMISSION_REPLAY_MISMATCH';END IF;
  RETURN done.receipt;
 END IF;
 PERFORM 1 FROM crm_graph_candidate.control WHERE singleton AND enabled FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_ADMISSION_DISABLED';END IF;
 PERFORM 1 FROM crm_graph_candidate.cart_control_v1 WHERE brand=b AND enabled AND cache_target=target FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_ADMISSION_DISABLED';END IF;
 SELECT * INTO j FROM crm_graph_candidate.journey WHERE id=jid AND brand=b FOR UPDATE;
 IF NOT FOUND OR j.version<>expected OR j.paused OR j.published_revision IS NULL THEN RAISE EXCEPTION 'GRAPH_ADMISSION_VERSION';END IF;
 SELECT * INTO ep FROM crm_graph_candidate.cart_epoch_v1 WHERE brand=b AND journey_id=jid AND ends_at IS NULL FOR SHARE;
 IF NOT FOUND OR ep.cache_target<>target OR ep.revision<>j.published_revision THEN RAISE EXCEPTION 'GRAPH_ADMISSION_EPOCH';END IF;
 SELECT * INTO s FROM crm_graph_candidate.source_event_v1 WHERE id=sid AND brand=b FOR SHARE;
 SELECT * INTO o FROM crm_graph_candidate.source_observation_v1 WHERE source_ref=sid FOR SHARE;
 IF s.id IS NULL OR o.source_ref IS NULL OR s.ref<ep.starts_at OR o.observed_at<ep.starts_at OR o.observed_at>clock_timestamp() OR s.ref<>date_trunc('milliseconds',s.ref) THEN RAISE EXCEPTION 'GRAPH_ADMISSION_SOURCE';END IF;
 PERFORM 1 FROM public.subscribers WHERE id=s.subscriber_id AND uuid=s.subject_id FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_ADMISSION_SOURCE';END IF;
 PERFORM 1 FROM public.subscriber_lists WHERE subscriber_id=s.subscriber_id ORDER BY list_id FOR SHARE;
 source:=crm_graph_candidate.source_read_v1(b,sid);
 IF source->'eligible' IS DISTINCT FROM 'true'::jsonb OR source->'consent' IS DISTINCT FROM 'true'::jsonb OR source->'suppressed' IS DISTINCT FROM 'false'::jsonb OR source->'material_matches' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'GRAPH_ADMISSION_INELIGIBLE';END IF;
 SELECT * INTO r FROM crm_graph_candidate.revision WHERE journey_id=jid AND revision=j.published_revision AND brand=b;
 SELECT x->>'id' INTO trigger_id FROM jsonb_array_elements(r.definition->'nodes') x WHERE x->>'type'='trigger' AND x->>'event'='cart.abandoned';
 IF trigger_id IS NULL OR (SELECT count(*) FROM jsonb_array_elements(r.definition->'nodes') x WHERE x->>'type'='trigger')<>1 THEN RAISE EXCEPTION 'GRAPH_ADMISSION_SCOPE';END IF;
 at:=date_trunc('milliseconds',clock_timestamp());at_text:=to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 event_key_val:=encode(sha256(convert_to(crm_graph_candidate.cart_canonical_v1(jsonb_build_array(b,'cart.abandoned',s.revision)),'UTF8')),'hex');
 identity_hash_val:=encode(sha256(convert_to(crm_graph_candidate.cart_canonical_v1(jsonb_build_array(b,'cart.abandoned',s.revision,s.subject_id,'cart:'||s.revision,to_char(s.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),'UTF8')),'hex');
 SELECT * INTO existing FROM crm_graph_candidate.entry ce WHERE ce.journey_id=jid AND ce.event_key=event_key_val FOR UPDATE;
 IF FOUND THEN
  IF existing.brand<>b OR existing.revision<>j.published_revision OR existing.source_ref<>sid OR existing.source_identity_hash<>identity_hash_val THEN RAISE EXCEPTION 'GRAPH_ADMISSION_REPLAY_MISMATCH';END IF;
  enrolled:=crm_graph_candidate.cart_enroll_v1(b,existing.id);
  reply:=jsonb_build_object('contract','journey_graph_cart_admission_v1','state','admitted','created',false,'source_ref',sid,'source_revision',s.revision,'brand',b,'journey_id',jid,'revision',j.published_revision,'entry_id',existing.id,'epoch_id',enrolled->>'epoch_id','cache_target',target,'authorizes_send',false);
  INSERT INTO crm_graph_candidate.cart_admission_receipt_v1(source_ref,epoch_id,journey_id,brand,expected_version,revision,entry_id,cache_target,source_revision,receipt,created_at)
  VALUES(sid,(enrolled->>'epoch_id')::uuid,jid,b,expected,j.published_revision,existing.id,target,s.revision,reply,clock_timestamp());
  RETURN reply;
 END IF;
 entry_id:=gen_random_uuid();identity:=jsonb_build_object('entry_id',entry_id,'journey_id',jid,'revision',j.published_revision,'event_id',event_key_val,'brand',b,'trigger','cart.abandoned');
 state:=jsonb_build_object('version','journey_graph_v1','identity',identity,'definition_key',crm_graph_candidate.cart_canonical_v1(r.definition),'catalog_key',crm_graph_candidate.cart_canonical_v1(r.catalog),
  'node_id',trigger_id,'entered_at',at_text,'last_now',at_text,'status','ready','attempt_key',NULL);
 INSERT INTO crm_graph_candidate.entry(id,journey_id,revision,brand,source_ref,event_key,source_identity_hash,identity,state,next_due_at,created_at,updated_at)
 VALUES(entry_id,jid,j.published_revision,b,sid,event_key_val,identity_hash_val,identity,state,at,at,at);
 enrolled:=crm_graph_candidate.cart_enroll_v1(b,entry_id);
 reply:=jsonb_build_object('contract','journey_graph_cart_admission_v1','state','admitted','created',true,'source_ref',sid,'source_revision',s.revision,'brand',b,'journey_id',jid,'revision',j.published_revision,'entry_id',entry_id,'epoch_id',enrolled->>'epoch_id','cache_target',target,'authorizes_send',false);
 INSERT INTO crm_graph_candidate.cart_admission_receipt_v1(source_ref,epoch_id,journey_id,brand,expected_version,revision,entry_id,cache_target,source_revision,receipt,created_at)
 VALUES(sid,(enrolled->>'epoch_id')::uuid,jid,b,expected,j.published_revision,entry_id,target,s.revision,reply,clock_timestamp());
 RETURN reply;
END $fn$;
REVOKE ALL ON crm_graph_candidate.cart_admission_receipt_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_graph_candidate.cart_canonical_v1(jsonb),crm_graph_candidate.cart_admit_source_v1(text,uuid,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_graph_candidate.cart_admit_source_v1(text,uuid,uuid,integer,text) TO crm_graph_worker;
COMMIT;
