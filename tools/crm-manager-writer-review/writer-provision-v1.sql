-- OFFLINE WRITER COMPONENT PROPOSAL ONLY. Never applied to production.
-- This is a separate namespace; the reviewed READ SQL and its caps are intact.
-- Four NEW tables, two explicit indexes, seven functions, two NOLOGIN roles.
-- No password, issuer registration, DML invocation, HTTP service or activation.
-- This component guard is NOT a production installer: a future reviewed outer
-- admission must pin listmonk/postgres/17, fresh legacy/auth/catalog metadata,
-- actual HBA/TLS/logging and a native PostgreSQL17 proof before any execution.
-- Narrow additive grants affect only the NEW NOLOGIN definer on two auth tables.
-- PUBLIC/default ACL/HBA/TLS/log settings and all existing roles stay unchanged.
BEGIN;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='4s';
SET LOCAL lock_timeout='500ms';
SET LOCAL idle_in_transaction_session_timeout='5s';
DO $writer_component_admission$
BEGIN
 IF current_user<>session_user OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
  OR current_setting('transaction_read_only')<>'off' OR NOT pg_try_advisory_xact_lock(1609296685,2)
  THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_WRITER_COMPONENT_REFUSED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1'))
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['crm_manager_writer_issuer_v1','crm_manager_writer_subject_v1','crm_manager_writer_operation_v1','crm_manager_writer_generation_v1','crm_manager_writer_one_prepared_v1','crm_manager_writer_one_active_v1']))
  OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=ANY(ARRAY['crm_manager_writer_issuer_v1','crm_manager_writer_subject_v1','crm_manager_writer_operation_v1','crm_manager_writer_generation_v1']))
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY['crm_manager_writer_canonical_v1','crm_manager_writer_error_v1','crm_manager_writer_apply_v1','crm_manager_writer_prepare_v1','crm_manager_writer_commit_v1','crm_manager_writer_revoke_v1','crm_manager_writer_status_v1']))
  THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_WRITER_COMPONENT_REFUSED'; END IF;
 -- Only the already observed additive SELECT default for central_leitor is
 -- recognized; it is revoked on FOUR NEW tables below, never on legacy/defaults.
 IF (SELECT count(*) FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace)
   AND d.defaclobjtype='r' AND a.grantee NOT IN (0,d.defaclrole))<>1
  OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
   WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace)
    AND d.defaclobjtype='r' AND a.grantee NOT IN (0,d.defaclrole) AND
    (a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname='central_leitor') OR a.privilege_type<>'SELECT'
     OR a.is_grantable OR a.grantor<>d.defaclrole OR d.defaclnamespace<>'public'::regnamespace))
  OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
   WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace)
    AND d.defaclobjtype='f' AND a.grantee NOT IN (0,d.defaclrole))
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname IN ('crm_dash_chave','shrigma_panel_permission_v1')
    AND (c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition OR c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
     OR EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=c.oid AND NOT g.tgisinternal)
     OR EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)))
  THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_WRITER_COMPONENT_REFUSED'; END IF;
END
$writer_component_admission$;

SET LOCAL search_path=pg_catalog;

CREATE TABLE public.crm_manager_writer_issuer_v1 (
 issuer_id uuid PRIMARY KEY,namespace_id uuid NOT NULL UNIQUE,login_role name NOT NULL UNIQUE,
 allowed_email_domains text[] NOT NULL CHECK(cardinality(allowed_email_domains) BETWEEN 1 AND 8),
 active boolean NOT NULL DEFAULT false
);
CREATE TABLE public.crm_manager_writer_subject_v1 (
 namespace_id uuid NOT NULL REFERENCES public.crm_manager_writer_issuer_v1(namespace_id),
 user_id uuid NOT NULL,lifecycle_id uuid NOT NULL,owner text NOT NULL,
 state text NOT NULL CHECK(state IN ('active','revoked')),active_generation integer NOT NULL DEFAULT 0 CHECK(active_generation BETWEEN 0 AND 999999999),
 revoked_at timestamptz,PRIMARY KEY(namespace_id,user_id,lifecycle_id)
);
CREATE TABLE public.crm_manager_writer_operation_v1 (
 namespace_id uuid NOT NULL REFERENCES public.crm_manager_writer_issuer_v1(namespace_id),
 operation_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('prepare_writer','renew_writer','commit_writer','revoke_writer')),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 response jsonb,PRIMARY KEY(namespace_id,operation_id)
);
CREATE TABLE public.crm_manager_writer_generation_v1 (
 namespace_id uuid NOT NULL,user_id uuid NOT NULL,lifecycle_id uuid NOT NULL,prepare_operation_id uuid NOT NULL,
 generation integer NOT NULL CHECK(generation BETWEEN 1 AND 999999999),
 expected_generation integer NOT NULL CHECK(expected_generation=generation-1),
 principal_id text NOT NULL UNIQUE CHECK(principal_id ~ '^dcrmw-[a-f0-9]{32}$') REFERENCES public.crm_dash_chave(chave),
 state text NOT NULL CHECK(state IN ('prepared','active','revoked','expired')),
 issued_at_ms bigint NOT NULL,candidate_expires_at_ms bigint NOT NULL,expires_at_ms bigint NOT NULL,
 commit_operation_id uuid,committed_at_ms bigint,
 PRIMARY KEY(namespace_id,prepare_operation_id),
 FOREIGN KEY(namespace_id,user_id,lifecycle_id) REFERENCES public.crm_manager_writer_subject_v1(namespace_id,user_id,lifecycle_id),
 FOREIGN KEY(namespace_id,prepare_operation_id) REFERENCES public.crm_manager_writer_operation_v1(namespace_id,operation_id),
 CHECK(candidate_expires_at_ms=issued_at_ms+600000),
 CHECK(expires_at_ms=issued_at_ms+1209600000)
);
CREATE UNIQUE INDEX crm_manager_writer_one_prepared_v1 ON public.crm_manager_writer_generation_v1(namespace_id,user_id,lifecycle_id) WHERE state='prepared';
CREATE UNIQUE INDEX crm_manager_writer_one_active_v1 ON public.crm_manager_writer_generation_v1(namespace_id,user_id,lifecycle_id) WHERE state='active';
REVOKE ALL ON public.crm_manager_writer_issuer_v1,public.crm_manager_writer_subject_v1,public.crm_manager_writer_operation_v1,public.crm_manager_writer_generation_v1 FROM PUBLIC;

-- Canonical JSON matches the client's sorted-key serializer for the closed
-- ASCII/integer request schema. No pgcrypto extension or secret is required.
CREATE FUNCTION public.crm_manager_writer_canonical_v1(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE result text;kind text:=jsonb_typeof(v);
BEGIN
 IF kind='object' THEN
  SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||public.crm_manager_writer_canonical_v1(val),',' ORDER BY k COLLATE "C"),'')||'}'
   INTO result FROM jsonb_each(v) item(k,val);
 ELSIF kind='array' THEN
  SELECT '['||coalesce(string_agg(public.crm_manager_writer_canonical_v1(val),',' ORDER BY n),'')||']'
   INTO result FROM jsonb_array_elements(v) WITH ORDINALITY item(val,n);
 ELSE result:=coalesce(v::text,'null'); END IF;
 RETURN result;
END $$;
CREATE FUNCTION public.crm_manager_writer_error_v1(req jsonb,issuer uuid,ns uuid,code text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('schema','crm-manager-writer-error-v1','issuerId',issuer,'namespaceId',ns,
  'operationId',CASE WHEN coalesce(req->>'operationId','') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN req->>'operationId' ELSE NULL END,
  'requestSha256',encode(sha256(convert_to(public.crm_manager_writer_canonical_v1(req),'UTF8')),'hex'),'code',code)
$$;

-- Private implementation. Four wrappers below are the only proposed RPCs.
CREATE FUNCTION public.crm_manager_writer_apply_v1(req jsonb,rpc text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 issuer public.crm_manager_writer_issuer_v1%ROWTYPE;
 subject public.crm_manager_writer_subject_v1%ROWTYPE;
 op public.crm_manager_writer_operation_v1%ROWTYPE;
 candidate public.crm_manager_writer_generation_v1%ROWTYPE;
 role_ok boolean;action text;expected_keys text[];actual_keys text[];ns uuid;opid uuid;uid uuid;life uuid;
 principal text;owner_email text;hash_value text;fp text;gen integer;previous integer;prepare_id uuid;
 now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;issued bigint;candidate_until bigint;final_until bigint;
 result jsonb;code text;revoked_count integer;
BEGIN
 SELECT * INTO issuer FROM public.crm_manager_writer_issuer_v1 WHERE login_role=session_user AND active;
 IF NOT FOUND THEN RETURN public.crm_manager_writer_error_v1(req,NULL,NULL,'ISSUER_DENIED'); END IF;
 ns:=issuer.namespace_id;
 SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
  AND NOT r.rolbypassrls AND NOT r.rolreplication AND NOT r.rolinherit
  AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
  INTO role_ok FROM pg_roles r WHERE r.rolname=session_user;
 IF role_ok IS DISTINCT FROM true THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'ISSUER_DENIED'); END IF;
 IF jsonb_typeof(req) IS DISTINCT FROM 'object' OR octet_length(req::text)>4096
  THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 action:=req->>'action';
 IF rpc='prepare' AND action IN ('prepare_writer','renew_writer') THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','userId','lifecycleId','owner','principalId','keySha256','generation','expectedGeneration','area','slot','role','caps','candidateTtlMs','lifetimeMs'];
 ELSIF rpc='commit' AND action='commit_writer' THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','userId','lifecycleId','owner','principalId','keySha256','generation','expectedGeneration','area','slot','role','caps','candidateTtlMs','lifetimeMs','prepareOperationId','issuedAt','candidateExpiresAt','expiresAt'];
 ELSIF rpc='revoke' AND action='revoke_writer' THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','userId','lifecycleId','owner'];
 ELSIF rpc='status' AND action='writer_status' THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','expectedRequestSha256'];
 ELSE RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 SELECT array_agg(k ORDER BY k COLLATE "C") INTO actual_keys FROM jsonb_object_keys(req) k;
 SELECT array_agg(k ORDER BY k COLLATE "C") INTO expected_keys FROM unnest(expected_keys) k;
 IF actual_keys IS DISTINCT FROM expected_keys OR req->>'schema' IS DISTINCT FROM 'crm-manager-writer-request-v1'
  OR req->>'issuerId' IS DISTINCT FROM issuer.issuer_id::text OR req->>'namespaceId' IS DISTINCT FROM ns::text
  OR coalesce(req->>'operationId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 opid:=(req->>'operationId')::uuid;
 fp:=encode(sha256(convert_to(public.crm_manager_writer_canonical_v1(req),'UTF8')),'hex');
 IF rpc='status' THEN
  IF jsonb_typeof(req->'expectedRequestSha256') IS DISTINCT FROM 'string' OR coalesce(req->>'expectedRequestSha256','') !~ '^[a-f0-9]{64}$'
   THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  SELECT * INTO op FROM public.crm_manager_writer_operation_v1 WHERE namespace_id=ns AND operation_id=opid;
  IF NOT FOUND THEN
   RETURN jsonb_build_object('schema','crm-manager-writer-status-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'found',false);
  END IF;
  IF op.request_sha256<>req->>'expectedRequestSha256' THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'IDEMPOTENCY_CONFLICT'); END IF;
  IF op.response IS NULL THEN
   RETURN jsonb_build_object('schema','crm-manager-writer-status-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'found',false);
  END IF;
  IF op.response->>'schema'='crm-manager-writer-error-v1' THEN
   RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,op.response->>'code');
  END IF;
  IF op.action<>'revoke_writer' AND EXISTS(SELECT 1 FROM public.crm_manager_writer_subject_v1 s WHERE s.namespace_id=ns
   AND s.user_id=(op.response->>'userId')::uuid AND s.lifecycle_id=(op.response->>'lifecycleId')::uuid AND s.state='revoked') THEN
   RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'LIFECYCLE_REVOKED');
  END IF;
  -- An expired prepare/renew receipt is historical proof, not a live lease.
  -- Lost-ACK reconciliation needs its fixed dates to close the local operation
  -- and issue a new candidate. Status never extends TTL or reactivates a key;
  -- direct prepare replay/commit still reject expiry, and tombstones dominate.
  RETURN jsonb_build_object('schema','crm-manager-writer-status-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'found',true,'receipt',op.response);
 END IF;
 IF coalesce(req->>'userId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR coalesce(req->>'lifecycleId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(req->'owner') IS DISTINCT FROM 'string'
  OR coalesce(req->>'owner','') !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9-]+\.)+[a-z]{2,63}$'
  OR length(req->>'owner')>254 OR req->>'owner'<>lower(req->>'owner')
  OR NOT(split_part(req->>'owner','@',2)=ANY(issuer.allowed_email_domains))
  THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 uid:=(req->>'userId')::uuid;life:=(req->>'lifecycleId')::uuid;owner_email:=req->>'owner';
 IF rpc IN ('prepare','commit') THEN
  IF coalesce(req->>'principalId','') !~ '^dcrmw-[a-f0-9]{32}$'
   OR jsonb_typeof(req->'keySha256') IS DISTINCT FROM 'string' OR coalesce(req->>'keySha256','') !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(req->'generation') IS DISTINCT FROM 'number' OR jsonb_typeof(req->'expectedGeneration') IS DISTINCT FROM 'number'
   OR coalesce(req->>'generation','') !~ '^[0-9]{1,9}$' OR coalesce(req->>'expectedGeneration','') !~ '^[0-9]{1,9}$'
   OR req->>'area' IS DISTINCT FROM 'growth' OR req->>'slot' IS DISTINCT FROM 'growth-campaign' OR req->>'role' IS DISTINCT FROM 'manager'
   OR req->'caps' IS DISTINCT FROM '["read_content","draft","validate","submit"]'::jsonb
   OR req->'candidateTtlMs' IS DISTINCT FROM '600000'::jsonb OR req->'lifetimeMs' IS DISTINCT FROM '1209600000'::jsonb
   THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  gen:=(req->>'generation')::integer;previous:=(req->>'expectedGeneration')::integer;
  IF gen<>previous+1 OR (action='prepare_writer' AND (gen<>1 OR previous<>0)) OR (action='renew_writer' AND previous<1)
   THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  principal:=req->>'principalId';hash_value:=req->>'keySha256';
 END IF;
 IF rpc='commit' THEN
  IF coalesce(req->>'prepareOperationId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR req->>'prepareOperationId'=opid::text
   OR jsonb_typeof(req->'issuedAt') IS DISTINCT FROM 'number' OR jsonb_typeof(req->'candidateExpiresAt') IS DISTINCT FROM 'number' OR jsonb_typeof(req->'expiresAt') IS DISTINCT FROM 'number'
   OR coalesce(req->>'issuedAt','') !~ '^[0-9]{1,16}$' OR coalesce(req->>'candidateExpiresAt','') !~ '^[0-9]{1,16}$' OR coalesce(req->>'expiresAt','') !~ '^[0-9]{1,16}$'
   THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  prepare_id:=(req->>'prepareOperationId')::uuid;
 END IF;
 -- Idempotency record is claimed before subject mutations. Different operations
 -- then serialize on the same subject row; a response becomes visible atomically.
 INSERT INTO public.crm_manager_writer_operation_v1(namespace_id,operation_id,action,request_sha256)
  VALUES(ns,opid,action,fp) ON CONFLICT(namespace_id,operation_id) DO NOTHING;
 SELECT * INTO op FROM public.crm_manager_writer_operation_v1 WHERE namespace_id=ns AND operation_id=opid FOR UPDATE;
 IF op.request_sha256<>fp OR op.action<>action THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'IDEMPOTENCY_CONFLICT'); END IF;
 SELECT * INTO subject FROM public.crm_manager_writer_subject_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life FOR UPDATE;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF FOUND AND subject.owner<>owner_email THEN
  result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT');
 ELSIF FOUND AND subject.state='revoked' AND rpc<>'revoke' THEN
  result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'LIFECYCLE_REVOKED');
 ELSIF op.response IS NOT NULL THEN
  IF rpc='prepare' THEN
   SELECT * INTO candidate FROM public.crm_manager_writer_generation_v1 WHERE namespace_id=ns AND prepare_operation_id=opid;
   IF FOUND AND (candidate.state IN ('expired','revoked') OR candidate.candidate_expires_at_ms<=now_ms AND candidate.state='prepared')
    THEN RETURN public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'CANDIDATE_EXPIRED'); END IF;
  END IF;
  RETURN op.response;
 END IF;
 IF result IS NULL AND rpc IN ('prepare','revoke') AND subject.namespace_id IS NULL THEN
  INSERT INTO public.crm_manager_writer_subject_v1(namespace_id,user_id,lifecycle_id,owner,state)
   VALUES(ns,uid,life,owner_email,CASE WHEN rpc='revoke' THEN 'revoked' ELSE 'active' END) ON CONFLICT DO NOTHING;
  SELECT * INTO subject FROM public.crm_manager_writer_subject_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life FOR UPDATE;
  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF subject.owner<>owner_email THEN result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT'); END IF;
  IF subject.state='revoked' AND rpc<>'revoke' THEN result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'LIFECYCLE_REVOKED'); END IF;
 END IF;
 IF result IS NULL AND subject.namespace_id IS NULL THEN result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'SUBJECT_NOT_FOUND'); END IF;
 IF result IS NULL AND rpc='prepare' THEN
  IF subject.active_generation<>previous THEN result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'GENERATION_CONFLICT');
  ELSE
   -- Reconcile only expired pending candidates. Active predecessor is untouched.
   UPDATE public.crm_dash_chave c SET ativo=false,revogada_em=clock_timestamp()
    FROM public.crm_manager_writer_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life
    AND g.state='prepared' AND g.candidate_expires_at_ms<=now_ms AND c.chave=g.principal_id;
   DELETE FROM public.shrigma_panel_permission_v1 p USING public.crm_manager_writer_generation_v1 g
    WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND g.state='prepared' AND g.candidate_expires_at_ms<=now_ms AND p.principal_id=g.principal_id;
   UPDATE public.crm_manager_writer_generation_v1 SET state='expired'
    WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state='prepared' AND candidate_expires_at_ms<=now_ms;
   IF EXISTS(SELECT 1 FROM public.crm_manager_writer_generation_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state='prepared') THEN
    result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'GENERATION_CONFLICT');
   ELSE
    -- A writer candidate must not authenticate before its atomic commit.
    issued:=now_ms;candidate_until:=issued+600000;final_until:=issued+1209600000;
    BEGIN
     INSERT INTO public.crm_dash_chave(chave,painel,dono,ativo,revogada_em,ultimo_uso,usos,chave_hash,chave_hash_curta,expira_em)
      VALUES(principal,'growth',owner_email,false,NULL,NULL,0,hash_value,NULL,to_timestamp(candidate_until/1000.0));
     INSERT INTO public.shrigma_panel_permission_v1(principal_id,area,caps) VALUES(principal,'growth','["read_content","draft","validate","submit"]'::jsonb);
     INSERT INTO public.crm_manager_writer_generation_v1(namespace_id,user_id,lifecycle_id,prepare_operation_id,generation,expected_generation,principal_id,state,issued_at_ms,candidate_expires_at_ms,expires_at_ms)
      VALUES(ns,uid,life,opid,gen,previous,principal,'prepared',issued,candidate_until,final_until);
    EXCEPTION WHEN unique_violation THEN result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT'); END;
    IF result IS NULL THEN result:=jsonb_build_object('schema','crm-manager-writer-receipt-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'action',action,'requestSha256',fp,'userId',uid,'lifecycleId',life,'owner',owner_email,
     'state','prepared','principalId',principal,'generation',gen,'expectedGeneration',previous,'area','growth','slot','growth-campaign','role','manager','caps','["read_content","draft","validate","submit"]'::jsonb,
     'issuedAt',issued,'candidateExpiresAt',candidate_until,'expiresAt',final_until); END IF;
   END IF;
  END IF;
 ELSIF result IS NULL AND rpc='commit' THEN
  SELECT * INTO candidate FROM public.crm_manager_writer_generation_v1 WHERE namespace_id=ns AND prepare_operation_id=prepare_id FOR UPDATE;
  -- Keep the verified key and existing grants stable during promotion. The
  -- parent key lock also serializes FK-backed concurrent grant insertion.
  PERFORM c.chave FROM public.crm_dash_chave c WHERE c.chave=candidate.principal_id FOR UPDATE;
  PERFORM p.principal_id FROM public.shrigma_panel_permission_v1 p WHERE p.principal_id=candidate.principal_id FOR UPDATE;
  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF candidate.namespace_id IS NULL OR candidate.user_id<>uid OR candidate.lifecycle_id<>life OR candidate.principal_id<>principal OR candidate.generation<>gen OR candidate.expected_generation<>previous THEN
   result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT');
  ELSIF candidate.state IN ('expired','revoked') OR candidate.candidate_expires_at_ms<=now_ms THEN
   result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'CANDIDATE_EXPIRED');
  ELSIF candidate.issued_at_ms<>(req->>'issuedAt')::bigint OR candidate.candidate_expires_at_ms<>(req->>'candidateExpiresAt')::bigint OR candidate.expires_at_ms<>(req->>'expiresAt')::bigint
   OR NOT EXISTS(SELECT 1 FROM public.crm_dash_chave c WHERE c.chave=principal AND c.chave_hash=hash_value AND c.painel='growth' AND c.dono=owner_email AND c.chave_hash_curta IS NULL
    AND NOT c.ativo AND c.revogada_em IS NULL AND c.expira_em=to_timestamp(candidate.candidate_expires_at_ms/1000.0))
   OR NOT EXISTS(SELECT 1 FROM public.shrigma_panel_permission_v1 p WHERE p.principal_id=principal AND p.area='growth' AND p.caps='["read_content","draft","validate","submit"]'::jsonb)
   OR EXISTS(SELECT 1 FROM public.shrigma_panel_permission_v1 p WHERE p.principal_id=principal AND p.area<>'growth') THEN
   result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT');
  ELSIF candidate.state<>'prepared' OR subject.active_generation<>previous THEN
   result:=public.crm_manager_writer_error_v1(req,issuer.issuer_id,ns,'GENERATION_CONFLICT');
  ELSE
   UPDATE public.crm_dash_chave c SET ativo=false,revogada_em=clock_timestamp()
    FROM public.crm_manager_writer_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND g.state='active' AND c.chave=g.principal_id;
   DELETE FROM public.shrigma_panel_permission_v1 p USING public.crm_manager_writer_generation_v1 g
    WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND g.state='active' AND p.principal_id=g.principal_id;
   UPDATE public.crm_manager_writer_generation_v1 SET state='revoked' WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state='active';
   UPDATE public.crm_dash_chave SET ativo=true,expira_em=to_timestamp(candidate.expires_at_ms/1000.0) WHERE chave=principal;
   UPDATE public.crm_manager_writer_generation_v1 SET state='active',commit_operation_id=opid,committed_at_ms=now_ms WHERE namespace_id=ns AND prepare_operation_id=prepare_id;
   UPDATE public.crm_manager_writer_subject_v1 SET active_generation=gen WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life;
   result:=jsonb_build_object('schema','crm-manager-writer-receipt-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'action',action,'requestSha256',fp,'userId',uid,'lifecycleId',life,'owner',owner_email,
    'state','committed','principalId',principal,'generation',gen,'expectedGeneration',previous,'area','growth','slot','growth-campaign','role','manager','caps','["read_content","draft","validate","submit"]'::jsonb,
    'issuedAt',candidate.issued_at_ms,'candidateExpiresAt',candidate.candidate_expires_at_ms,'expiresAt',candidate.expires_at_ms,'prepareOperationId',prepare_id,'committedAt',now_ms,'revokedGeneration',CASE WHEN previous=0 THEN NULL ELSE previous END);
  END IF;
 ELSIF result IS NULL AND rpc='revoke' THEN
  SELECT count(*)::integer INTO revoked_count FROM public.crm_manager_writer_generation_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state IN ('prepared','active');
  UPDATE public.crm_manager_writer_subject_v1 SET state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life;
  UPDATE public.crm_dash_chave c SET ativo=false,revogada_em=coalesce(c.revogada_em,clock_timestamp())
   FROM public.crm_manager_writer_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND c.chave=g.principal_id;
  DELETE FROM public.shrigma_panel_permission_v1 p USING public.crm_manager_writer_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND p.principal_id=g.principal_id;
  UPDATE public.crm_manager_writer_generation_v1 SET state='revoked' WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life;
  result:=jsonb_build_object('schema','crm-manager-writer-receipt-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'action',action,'requestSha256',fp,'userId',uid,'lifecycleId',life,'owner',owner_email,
   'state','revoked','revocationMode','lifecycle','allGenerationsRevoked',true,'effectiveAt',now_ms,'revokedCount',revoked_count);
 END IF;
 UPDATE public.crm_manager_writer_operation_v1 SET response=result WHERE namespace_id=ns AND operation_id=opid AND response IS NULL;
 RETURN result;
END $$;

CREATE FUNCTION public.crm_manager_writer_prepare_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.crm_manager_writer_apply_v1($1,'prepare') $$;
CREATE FUNCTION public.crm_manager_writer_commit_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.crm_manager_writer_apply_v1($1,'commit') $$;
CREATE FUNCTION public.crm_manager_writer_revoke_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.crm_manager_writer_apply_v1($1,'revoke') $$;
CREATE FUNCTION public.crm_manager_writer_status_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.crm_manager_writer_apply_v1($1,'status') $$;
REVOKE ALL ON FUNCTION public.crm_manager_writer_canonical_v1(jsonb),public.crm_manager_writer_error_v1(jsonb,uuid,uuid,text),public.crm_manager_writer_apply_v1(jsonb,text),
 public.crm_manager_writer_prepare_v1(jsonb),public.crm_manager_writer_commit_v1(jsonb),public.crm_manager_writer_revoke_v1(jsonb),public.crm_manager_writer_status_v1(jsonb) FROM PUBLIC;

-- Remove exactly the inherited default SELECT on these FOUR newly created tables.
REVOKE SELECT ON public.crm_manager_writer_issuer_v1,public.crm_manager_writer_subject_v1,
 public.crm_manager_writer_operation_v1,public.crm_manager_writer_generation_v1 FROM central_leitor;

SET LOCAL search_path=pg_catalog;
DO $$
DECLARE creator oid;target record;item record;object_name text;relation oid;
BEGIN
 SELECT oid INTO creator FROM pg_roles WHERE rolname=current_user AND rolsuper;
 IF creator IS NULL OR current_user<>session_user OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1'))
  THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
 -- Refuse inherited CREATE or direct access instead of changing legacy ACLs.
 IF EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname NOT LIKE 'pg_%' AND a.grantee=0 AND a.privilege_type='CREATE')
  OR EXISTS(SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='CREATE')
  THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
 FOREACH object_name IN ARRAY ARRAY['crm_dash_chave','shrigma_panel_permission_v1','crm_manager_writer_issuer_v1','crm_manager_writer_subject_v1','crm_manager_writer_operation_v1','crm_manager_writer_generation_v1'] LOOP
  SELECT c.oid,c.relowner,c.relkind,c.relpersistence INTO target FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=object_name;
  IF NOT FOUND OR target.relkind<>'r' OR target.relpersistence<>'p' THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
  relation:=target.oid;
  IF object_name LIKE 'crm_manager_writer_%' AND (target.relowner<>creator OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation AND NOT tgisinternal))
   THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=relation AND a.grantee=0)
   OR EXISTS(SELECT 1 FROM pg_attribute c CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(c.attacl)>0 THEN c.attacl END) a WHERE c.attrelid=relation AND c.attnum>0 AND NOT c.attisdropped AND a.grantee=0)
   THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ('crm_manager_writer_one_prepared_v1','prepared'),('crm_manager_writer_one_active_v1','active')
 ) v(name,state) LOOP
  SELECT c.oid,c.relowner,c.relkind,i.indrelid,i.indisunique,i.indisvalid,i.indisready,pg_get_expr(i.indpred,i.indrelid) AS predicate,
   (SELECT array_agg(a.attname::text ORDER BY u.n) FROM unnest(i.indkey::smallint[]) WITH ORDINALITY u(attnum,n) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=u.attnum) AS columns
   INTO target FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid WHERE n.nspname='public' AND c.relname=item.name;
  IF NOT FOUND OR target.relowner<>creator OR target.relkind<>'i' OR target.indrelid<>to_regclass('public.crm_manager_writer_generation_v1')
   OR NOT target.indisunique OR NOT target.indisvalid OR NOT target.indisready OR target.columns IS DISTINCT FROM ARRAY['namespace_id','user_id','lifecycle_id']
   OR target.predicate IS DISTINCT FROM format('(state = %L::text)',item.state)
   THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
 END LOOP;
 -- Match the exact reviewed function bodies, signatures and safe search_path.
 -- Hashes are of public source text, not credentials or database rows.
 FOR item IN SELECT * FROM (VALUES
  ('public.crm_manager_writer_canonical_v1(jsonb)','text','plpgsql',false,'i','0954dea00b21d1df3ee80ba3138da84bb0d56092525fc6d878bfa91e0184d879'),
  ('public.crm_manager_writer_error_v1(jsonb,uuid,uuid,text)','jsonb','sql',false,'i','013470bf619352bdaf85f591502494a2a5d95c75d472843e993901681d49342d'),
  ('public.crm_manager_writer_apply_v1(jsonb,text)','jsonb','plpgsql',false,'v','9e2a82dc01ba1a6c17eab6c5e2d686b5556b10094e01f5852ddca40c0c12cfee'),
  ('public.crm_manager_writer_prepare_v1(jsonb)','jsonb','sql',true,'v','c38fe18763520f1b33035dad0f6a71d61fe90c5ce6c2a05f7c883cf0ec329552'),
  ('public.crm_manager_writer_commit_v1(jsonb)','jsonb','sql',true,'v','ff56b491d033c7448e52e6f3b5fb187ad6b1f72bebeb17b834994ba1b4583120'),
  ('public.crm_manager_writer_revoke_v1(jsonb)','jsonb','sql',true,'v','ca936031b6824b52e51f1392fd71b65c19fee87f789705784b263e1a254e8a4f'),
  ('public.crm_manager_writer_status_v1(jsonb)','jsonb','sql',true,'v','556a9c80d727498f93c2f8a6443cb16e0b085de4cd1b3cbf09438040c3d93019')
 ) v(signature,returns,language,definer,volatility,body_sha256) LOOP
  SELECT p.oid,p.proowner,p.prorettype,p.prosecdef,p.provolatile,p.proconfig,l.lanname,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256
   INTO target FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure(item.signature);
  IF NOT FOUND OR target.proowner<>creator OR target.prorettype<>to_regtype('pg_catalog.'||item.returns) OR target.prosecdef<>item.definer
   OR target.provolatile::text<>item.volatility OR target.lanname<>item.language OR target.body_sha256<>item.body_sha256
   OR target.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=target.oid AND a.grantee=0)
   THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
 END LOOP;
END $$;

CREATE ROLE crm_manager_writer_owner_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE crm_manager_writer_service_v1 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
GRANT USAGE,CREATE ON SCHEMA public TO crm_manager_writer_owner_v1;
GRANT USAGE ON SCHEMA public TO crm_manager_writer_service_v1;
ALTER TABLE public.crm_manager_writer_issuer_v1 OWNER TO crm_manager_writer_owner_v1;
ALTER TABLE public.crm_manager_writer_subject_v1 OWNER TO crm_manager_writer_owner_v1;
ALTER TABLE public.crm_manager_writer_operation_v1 OWNER TO crm_manager_writer_owner_v1;
ALTER TABLE public.crm_manager_writer_generation_v1 OWNER TO crm_manager_writer_owner_v1;
ALTER FUNCTION public.crm_manager_writer_canonical_v1(jsonb) OWNER TO crm_manager_writer_owner_v1;
ALTER FUNCTION public.crm_manager_writer_error_v1(jsonb,uuid,uuid,text) OWNER TO crm_manager_writer_owner_v1;
ALTER FUNCTION public.crm_manager_writer_apply_v1(jsonb,text) OWNER TO crm_manager_writer_owner_v1;
ALTER FUNCTION public.crm_manager_writer_prepare_v1(jsonb) OWNER TO crm_manager_writer_owner_v1;
ALTER FUNCTION public.crm_manager_writer_commit_v1(jsonb) OWNER TO crm_manager_writer_owner_v1;
ALTER FUNCTION public.crm_manager_writer_revoke_v1(jsonb) OWNER TO crm_manager_writer_owner_v1;
ALTER FUNCTION public.crm_manager_writer_status_v1(jsonb) OWNER TO crm_manager_writer_owner_v1;
REVOKE CREATE ON SCHEMA public FROM crm_manager_writer_owner_v1;
GRANT SELECT,INSERT,UPDATE ON TABLE public.crm_dash_chave TO crm_manager_writer_owner_v1;
GRANT SELECT,INSERT,DELETE ON TABLE public.shrigma_panel_permission_v1 TO crm_manager_writer_owner_v1;
-- The reviewed commit locks a permission row with SELECT FOR UPDATE. PostgreSQL
-- requires UPDATE on at least one column for that lock. Grant only its identity
-- column to the NOLOGIN owner, never caps/area or any column to the service login.
GRANT UPDATE(principal_id) ON TABLE public.shrigma_panel_permission_v1 TO crm_manager_writer_owner_v1;
GRANT EXECUTE ON FUNCTION public.crm_manager_writer_prepare_v1(jsonb),public.crm_manager_writer_commit_v1(jsonb),public.crm_manager_writer_revoke_v1(jsonb),public.crm_manager_writer_status_v1(jsonb) TO crm_manager_writer_service_v1;

DO $$
DECLARE owner_role oid;login_role oid;
BEGIN
 SELECT oid INTO owner_role FROM pg_roles WHERE rolname='crm_manager_writer_owner_v1' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls;
 SELECT oid INTO login_role FROM pg_roles WHERE rolname='crm_manager_writer_service_v1' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=2;
 IF owner_role IS NULL OR login_role IS NULL OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN (owner_role,login_role))
  OR has_schema_privilege(owner_role,'public','CREATE') OR has_schema_privilege(login_role,'public','CREATE')
  OR EXISTS(SELECT 1 FROM pg_authid WHERE oid IN (owner_role,login_role) AND rolpassword IS NOT NULL)
  THEN RAISE EXCEPTION USING MESSAGE='CRM_MANAGER_ROLE_INSTALL_REFUSED'; END IF;
END $$;

COMMIT;
