-- Durable boundary for the isolated Shopify product collector. It stores no
-- customer payload, signed URL or credential. Existing product chunks remain
-- the source of truth when an HTTP/SQL response is uncertain.
DO $install$
BEGIN
 IF current_user<>'postgres' OR current_setting('server_version_num')<>'170010' THEN RAISE EXCEPTION 'SHOPIFY_SYNC_INSTALL_CONTEXT'; END IF;
 IF to_regprocedure('crm_audience_v2.shopify_ingest_product_chunk(jsonb,integer,jsonb)') IS NULL THEN RAISE EXCEPTION 'SHOPIFY_SYNC_DEPENDENCY'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crm_shopify_sync') THEN CREATE ROLE crm_shopify_sync NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER; END IF;
END $install$;

CREATE TABLE crm_audience_v2.shopify_sync_operation(
 operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 idempotency_key text UNIQUE NOT NULL CHECK(idempotency_key~'^[A-Za-z0-9_.:-]{16,160}$'),
 brand text NOT NULL CHECK(brand IN('fish','aristo')),kind text NOT NULL CHECK(kind IN('run','recover')),
 scheduled_for timestamptz NOT NULL,query_sha256 text NOT NULL CHECK(query_sha256='bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086'),
 state text NOT NULL CHECK(state IN('claimed','start_intent','start_uncertain','bulk_running','ingesting','chunk_uncertain','completed','blocked')),
 bulk_operation_id text CHECK(bulk_operation_id IS NULL OR bulk_operation_id~'^gid://shopify/BulkOperation/[1-9][0-9]{0,24}$'),
 intent_sha256 text CHECK(intent_sha256 IS NULL OR intent_sha256~'^[0-9a-f]{64}$'),intent_at timestamptz,
 evidence_meta jsonb,source_sha256 text CHECK(source_sha256 IS NULL OR source_sha256~'^[0-9a-f]{64}$'),
 chunks integer CHECK(chunks IS NULL OR chunks BETWEEN 1 AND 50),next_chunk integer NOT NULL DEFAULT 0 CHECK(next_chunk BETWEEN 0 AND 50),
 last_chunk integer,last_chunk_sha256 text CHECK(last_chunk_sha256 IS NULL OR last_chunk_sha256~'^[0-9a-f]{64}$'),last_receipt jsonb,error_code text,
 lease_token uuid NOT NULL,lease_until timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(isfinite(scheduled_for) AND isfinite(lease_until) AND (kind='run' OR bulk_operation_id IS NOT NULL)),
 CHECK(evidence_meta IS NULL OR octet_length(evidence_meta::text)<=16000),
 CHECK(last_receipt IS NULL OR octet_length(last_receipt::text)<=4000),
 CHECK(error_code IS NULL OR error_code~'^[A-Z0-9_]{3,80}$')
);
CREATE TABLE crm_audience_v2.shopify_sync_mutex(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),operation_id uuid REFERENCES crm_audience_v2.shopify_sync_operation(operation_id),lease_token uuid,lease_until timestamptz);
INSERT INTO crm_audience_v2.shopify_sync_mutex(singleton) VALUES(true);
REVOKE ALL ON crm_audience_v2.shopify_sync_operation,crm_audience_v2.shopify_sync_mutex FROM PUBLIC,crm_shopify_sync;

CREATE FUNCTION crm_audience_v2.shopify_sync_effect(action text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='500ms' AS $fn$
DECLARE o crm_audience_v2.shopify_sync_operation%ROWTYPE;m crm_audience_v2.shopify_sync_mutex%ROWTYPE;
 now_at timestamptz:=clock_timestamp();token uuid;ttl integer;receipt jsonb;chunk_hash text;stored_hash text;batch_status text;persisted_meta jsonb;
BEGIN
 IF session_user NOT IN('crm_shopify_sync','postgres') OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR action IS NULL THEN RAISE EXCEPTION 'SHOPIFY_SYNC_AUTH'; END IF;
 IF action='claim' THEN
  IF NOT(p ?& ARRAY['idempotency_key','brand','kind','scheduled_for','bulk_operation_id','lease_seconds','query_sha256']) OR p-'idempotency_key'-'brand'-'kind'-'scheduled_for'-'bulk_operation_id'-'lease_seconds'-'query_sha256'<>'{}'::jsonb
   OR p->>'brand' NOT IN('fish','aristo') OR p->>'kind' NOT IN('run','recover') OR p->>'idempotency_key'!~'^[A-Za-z0-9_.:-]{16,160}$'
   OR p->>'query_sha256'<>'bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086' OR p->>'lease_seconds'!~'^[0-9]{2,3}$'
   OR (p->>'kind'='run' AND p->>'bulk_operation_id' IS NOT NULL) OR (p->>'kind'='recover' AND coalesce(p->>'bulk_operation_id','')!~'^gid://shopify/BulkOperation/[1-9][0-9]{0,24}$') THEN RAISE EXCEPTION 'SHOPIFY_SYNC_INPUT'; END IF;
  ttl:=(p->>'lease_seconds')::integer;IF ttl NOT BETWEEN 30 AND 300 THEN RAISE EXCEPTION 'SHOPIFY_SYNC_INPUT'; END IF;
  SELECT * INTO o FROM crm_audience_v2.shopify_sync_operation WHERE idempotency_key=p->>'idempotency_key' FOR UPDATE;
  IF FOUND THEN
   IF o.brand<>p->>'brand' OR o.kind<>p->>'kind' OR o.scheduled_for<>(p->>'scheduled_for')::timestamptz OR o.query_sha256<>p->>'query_sha256'
    OR (o.kind='recover' AND o.bulk_operation_id<>p->>'bulk_operation_id') THEN RAISE EXCEPTION 'SHOPIFY_SYNC_IDEMPOTENCY_CONFLICT'; END IF;
   IF o.state IN('completed','blocked') THEN RETURN jsonb_build_object('operation_id',o.operation_id,'idempotency_key',o.idempotency_key,'brand',o.brand,'kind',o.kind,'scheduled_for',o.scheduled_for,'state',o.state,'query_sha256',o.query_sha256,'bulk_operation_id',o.bulk_operation_id,'next_chunk',o.next_chunk,'chunks',o.chunks,'error_code',o.error_code); END IF;
   IF o.lease_until>now_at THEN RETURN jsonb_build_object('operation_id',o.operation_id,'idempotency_key',o.idempotency_key,'brand',o.brand,'kind',o.kind,'scheduled_for',o.scheduled_for,'state',o.state,'query_sha256',o.query_sha256,'bulk_operation_id',o.bulk_operation_id,'next_chunk',o.next_chunk,'chunks',o.chunks,'owned',false); END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM crm_audience_v2.shopify_sync_operation WHERE state IN('start_intent','start_uncertain')) THEN RAISE EXCEPTION 'SHOPIFY_SYNC_START_UNCERTAIN'; END IF;
   token:=gen_random_uuid();INSERT INTO crm_audience_v2.shopify_sync_operation(idempotency_key,brand,kind,scheduled_for,query_sha256,state,bulk_operation_id,lease_token,lease_until)
    VALUES(p->>'idempotency_key',p->>'brand',p->>'kind',(p->>'scheduled_for')::timestamptz,p->>'query_sha256','claimed',nullif(p->>'bulk_operation_id',''),token,now_at+make_interval(secs=>ttl)) RETURNING * INTO o;
  END IF;
  SELECT * INTO m FROM crm_audience_v2.shopify_sync_mutex WHERE singleton FOR UPDATE;
  IF m.operation_id IS NOT NULL AND m.operation_id<>o.operation_id AND m.lease_until>now_at THEN RAISE EXCEPTION 'SHOPIFY_SYNC_BUSY'; END IF;
  IF m.operation_id IS NOT NULL AND m.operation_id<>o.operation_id AND EXISTS(SELECT 1 FROM crm_audience_v2.shopify_sync_operation x WHERE x.operation_id=m.operation_id AND x.state IN('start_intent','start_uncertain')) THEN RAISE EXCEPTION 'SHOPIFY_SYNC_START_UNCERTAIN'; END IF;
  token:=gen_random_uuid();UPDATE crm_audience_v2.shopify_sync_operation SET lease_token=token,lease_until=now_at+make_interval(secs=>ttl),updated_at=now_at WHERE operation_id=o.operation_id RETURNING * INTO o;
  UPDATE crm_audience_v2.shopify_sync_mutex SET operation_id=o.operation_id,lease_token=token,lease_until=o.lease_until WHERE singleton;
  RETURN jsonb_build_object('operation_id',o.operation_id,'idempotency_key',o.idempotency_key,'brand',o.brand,'kind',o.kind,'scheduled_for',o.scheduled_for,'state',o.state,'query_sha256',o.query_sha256,'bulk_operation_id',o.bulk_operation_id,'evidence_meta',o.evidence_meta,'next_chunk',o.next_chunk,'chunks',o.chunks,'intent_at',o.intent_at,'created_at',o.created_at,'lease',token,'owned',true);
 ELSIF action='inspect' THEN
  SELECT * INTO STRICT o FROM crm_audience_v2.shopify_sync_operation WHERE idempotency_key=p->>'idempotency_key';
  RETURN jsonb_build_object('operation_id',o.operation_id,'idempotency_key',o.idempotency_key,'brand',o.brand,'kind',o.kind,'scheduled_for',o.scheduled_for,'state',o.state,'query_sha256',o.query_sha256,'bulk_operation_id',o.bulk_operation_id,'source_sha256',o.source_sha256,'next_chunk',o.next_chunk,'chunks',o.chunks,'last_chunk',o.last_chunk,'last_chunk_sha256',o.last_chunk_sha256,'last_receipt',o.last_receipt,'error_code',o.error_code);
 ELSIF action='pending' THEN
  RETURN jsonb_build_object('operations',coalesce((SELECT jsonb_agg(jsonb_build_object('idempotency_key',idempotency_key,'brand',brand,'kind',kind,'scheduled_for',scheduled_for,'bulk_operation_id',bulk_operation_id) ORDER BY created_at) FROM crm_audience_v2.shopify_sync_operation WHERE state NOT IN('completed','blocked')),'[]'::jsonb));
 END IF;
 IF NOT(p ?& ARRAY['operation_id','lease']) OR p->>'operation_id'!~'^[0-9a-f-]{36}$' OR p->>'lease'!~'^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'SHOPIFY_SYNC_INPUT'; END IF;
 SELECT * INTO STRICT o FROM crm_audience_v2.shopify_sync_operation WHERE operation_id=(p->>'operation_id')::uuid FOR UPDATE;
 IF o.lease_token<>(p->>'lease')::uuid OR o.lease_until<=now_at THEN RAISE EXCEPTION 'SHOPIFY_SYNC_LEASE_LOST'; END IF;
 IF action='renew' THEN
  ttl:=(p->>'lease_seconds')::integer;IF ttl NOT BETWEEN 30 AND 300 THEN RAISE EXCEPTION 'SHOPIFY_SYNC_INPUT'; END IF;UPDATE crm_audience_v2.shopify_sync_operation SET lease_until=now_at+make_interval(secs=>ttl),updated_at=now_at WHERE operation_id=o.operation_id RETURNING * INTO o;UPDATE crm_audience_v2.shopify_sync_mutex SET lease_until=o.lease_until WHERE singleton AND operation_id=o.operation_id AND lease_token=o.lease_token;RETURN jsonb_build_object('lease_until',o.lease_until);
 ELSIF action='start_intent' THEN
  IF o.kind<>'run' OR o.state<>'claimed' OR p->>'intent_sha256'!~'^[0-9a-f]{64}$' OR o.lease_until<now_at+interval '20 seconds' THEN RAISE EXCEPTION 'SHOPIFY_SYNC_START_GUARD'; END IF;UPDATE crm_audience_v2.shopify_sync_operation SET state='start_intent',intent_sha256=p->>'intent_sha256',intent_at=now_at,updated_at=now_at WHERE operation_id=o.operation_id RETURNING * INTO o;RETURN jsonb_build_object('intent_at',o.intent_at,'permit_until',least(o.lease_until,now_at+interval '15 seconds'));
 ELSIF action='start_uncertain' THEN
  IF o.state NOT IN('start_intent','start_uncertain') THEN RAISE EXCEPTION 'SHOPIFY_SYNC_STATE'; END IF;UPDATE crm_audience_v2.shopify_sync_operation SET state='start_uncertain',updated_at=now_at WHERE operation_id=o.operation_id;RETURN jsonb_build_object('state','start_uncertain');
 ELSIF action='bind_bulk' THEN
  IF o.state NOT IN('claimed','start_intent','start_uncertain') OR p->>'bulk_operation_id'!~'^gid://shopify/BulkOperation/[1-9][0-9]{0,24}$' OR o.bulk_operation_id IS NOT NULL AND o.bulk_operation_id<>p->>'bulk_operation_id' THEN RAISE EXCEPTION 'SHOPIFY_SYNC_BULK_CONFLICT'; END IF;UPDATE crm_audience_v2.shopify_sync_operation SET state='bulk_running',bulk_operation_id=p->>'bulk_operation_id',updated_at=now_at WHERE operation_id=o.operation_id RETURNING * INTO o;RETURN jsonb_build_object('state',o.state,'bulk_operation_id',o.bulk_operation_id);
 ELSIF action='evidence' THEN
  IF o.state NOT IN('bulk_running','ingesting','chunk_uncertain') OR jsonb_typeof(p->'meta')<>'object' OR p->>'chunks'!~'^[1-9][0-9]?$' OR (p->>'chunks')::integer>50 OR p#>>'{meta,query_sha256}'<>o.query_sha256 OR p#>>'{meta,brand}'<>o.brand OR p#>>'{meta,operation_id}'<>o.bulk_operation_id OR p#>>'{meta,source_sha256}'!~'^[0-9a-f]{64}$' OR p#>'{meta,bulk,url}' IS NOT NULL THEN RAISE EXCEPTION 'SHOPIFY_SYNC_EVIDENCE'; END IF;
  IF o.state IN('ingesting','chunk_uncertain') THEN IF o.evidence_meta<>p->'meta' OR o.source_sha256<>p#>>'{meta,source_sha256}' OR o.chunks<>(p->>'chunks')::integer THEN RAISE EXCEPTION 'SHOPIFY_SYNC_EVIDENCE_CONFLICT'; END IF;RETURN jsonb_build_object('state',o.state,'next_chunk',o.next_chunk,'chunks',o.chunks,'replayed',true); END IF;
  SELECT provenance INTO persisted_meta FROM crm_audience_v2.shopify_product_batch WHERE brand=o.brand AND operation_id=o.bulk_operation_id;
  IF FOUND AND (persisted_meta-'observed_at'<>(p->'meta')-'observed_at' OR (p#>>'{meta,observed_at}')::timestamptz<(persisted_meta->>'observed_at')::timestamptz) THEN RAISE EXCEPTION 'SHOPIFY_SYNC_EVIDENCE_CONFLICT'; END IF;
  UPDATE crm_audience_v2.shopify_sync_operation SET state='ingesting',evidence_meta=p->'meta',source_sha256=p#>>'{meta,source_sha256}',chunks=(p->>'chunks')::integer,updated_at=now_at WHERE operation_id=o.operation_id RETURNING * INTO o;RETURN jsonb_build_object('state',o.state,'next_chunk',o.next_chunk,'chunks',o.chunks,'replayed',false);
 ELSIF action IN('chunk_status','ingest') THEN
  IF o.state NOT IN('ingesting','chunk_uncertain') OR p->>'part'!~'^(0|[1-9][0-9]?)$' OR jsonb_typeof(p->'customers')<>'array' THEN RAISE EXCEPTION 'SHOPIFY_SYNC_CHUNK'; END IF;
  chunk_hash:=encode(sha256(convert_to((p->'customers')::text,'UTF8')),'hex');SELECT payload_sha256 INTO stored_hash FROM crm_audience_v2.shopify_product_chunk WHERE brand=o.brand AND operation_id=o.bulk_operation_id AND chunk_index=(p->>'part')::integer;
  IF FOUND THEN
   IF stored_hash<>chunk_hash THEN RAISE EXCEPTION 'SHOPIFY_SYNC_CHUNK_CONFLICT'; END IF;SELECT status INTO batch_status FROM crm_audience_v2.shopify_batch WHERE brand=o.brand AND operation_id=o.bulk_operation_id;receipt:=jsonb_build_object('status',batch_status,'replayed',true,'authorizes_send',false);UPDATE crm_audience_v2.shopify_sync_operation SET state='ingesting',next_chunk=greatest(next_chunk,(p->>'part')::integer+1),last_chunk=(p->>'part')::integer,last_chunk_sha256=chunk_hash,last_receipt=receipt,updated_at=now_at WHERE operation_id=o.operation_id;RETURN jsonb_build_object('status','committed','chunk_sha256',chunk_hash,'receipt',receipt);
  END IF;
  IF action='chunk_status' THEN RETURN jsonb_build_object('status','absent','chunk_sha256',chunk_hash); END IF;
  IF (p->>'part')::integer<>o.next_chunk THEN RAISE EXCEPTION 'SHOPIFY_SYNC_CHUNK_ORDER'; END IF;receipt:=crm_audience_v2.shopify_ingest_product_chunk(o.evidence_meta,(p->>'part')::integer,p->'customers');UPDATE crm_audience_v2.shopify_sync_operation SET state='ingesting',next_chunk=next_chunk+1,last_chunk=(p->>'part')::integer,last_chunk_sha256=chunk_hash,last_receipt=receipt,updated_at=now_at WHERE operation_id=o.operation_id;RETURN jsonb_build_object('status','committed','chunk_sha256',chunk_hash,'receipt',receipt);
 ELSIF action='chunk_uncertain' THEN
  IF o.state NOT IN('ingesting','chunk_uncertain') OR p->>'part'!~'^(0|[1-9][0-9]?)$' OR p->>'chunk_sha256'!~'^[0-9a-f]{64}$' OR (p->>'part')::integer<>o.next_chunk THEN RAISE EXCEPTION 'SHOPIFY_SYNC_CHUNK'; END IF;
  UPDATE crm_audience_v2.shopify_sync_operation SET state='chunk_uncertain',last_chunk=(p->>'part')::integer,last_chunk_sha256=p->>'chunk_sha256',updated_at=now_at WHERE operation_id=o.operation_id;RETURN jsonb_build_object('state','chunk_uncertain','part',(p->>'part')::integer,'chunk_sha256',p->>'chunk_sha256');
 ELSIF action='finish' THEN
  IF o.state<>'ingesting' OR o.next_chunk<>o.chunks OR NOT EXISTS(SELECT 1 FROM crm_audience_v2.shopify_product_batch WHERE brand=o.brand AND operation_id=o.bulk_operation_id AND ready) THEN RAISE EXCEPTION 'SHOPIFY_SYNC_NOT_READY'; END IF;UPDATE crm_audience_v2.shopify_sync_operation SET state='completed',updated_at=now_at WHERE operation_id=o.operation_id RETURNING * INTO o;UPDATE crm_audience_v2.shopify_sync_mutex SET operation_id=NULL,lease_token=NULL,lease_until=NULL WHERE singleton AND operation_id=o.operation_id;RETURN jsonb_build_object('operation_id',o.operation_id,'idempotency_key',o.idempotency_key,'brand',o.brand,'state',o.state,'query_sha256',o.query_sha256,'bulk_operation_id',o.bulk_operation_id,'next_chunk',o.next_chunk,'chunks',o.chunks);
 ELSIF action='fail' THEN
  IF p->>'code'!~'^[A-Z0-9_]{3,80}$' THEN RAISE EXCEPTION 'SHOPIFY_SYNC_INPUT'; END IF;UPDATE crm_audience_v2.shopify_sync_operation SET state='blocked',error_code=p->>'code',updated_at=now_at WHERE operation_id=o.operation_id;UPDATE crm_audience_v2.shopify_sync_mutex SET operation_id=NULL,lease_token=NULL,lease_until=NULL WHERE singleton AND operation_id=o.operation_id;RETURN jsonb_build_object('state','blocked','error_code',p->>'code');
 END IF;
 RAISE EXCEPTION 'SHOPIFY_SYNC_ACTION';
END $fn$;
REVOKE ALL ON FUNCTION crm_audience_v2.shopify_sync_effect(text,jsonb) FROM PUBLIC;
GRANT USAGE ON SCHEMA crm_audience_v2 TO crm_shopify_sync;
GRANT EXECUTE ON FUNCTION crm_audience_v2.shopify_sync_effect(text,jsonb) TO crm_shopify_sync;
