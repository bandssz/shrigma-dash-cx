-- OFFLINE PROPOSAL. Never applied to production by this task.
-- Additive objects only. Installation intentionally refuses existing v1 names.
-- No issuer registration, login creation, credential or production GRANT here.
BEGIN;
SET LOCAL search_path=pg_catalog;

CREATE TABLE public.shrigma_crm_manager_issuer_v1 (
 issuer_id uuid PRIMARY KEY,namespace_id uuid NOT NULL UNIQUE,login_role name NOT NULL UNIQUE,
 allowed_email_domains text[] NOT NULL CHECK(cardinality(allowed_email_domains) BETWEEN 1 AND 8),
 active boolean NOT NULL DEFAULT false
);
CREATE TABLE public.shrigma_crm_manager_subject_v1 (
 namespace_id uuid NOT NULL REFERENCES public.shrigma_crm_manager_issuer_v1(namespace_id),
 user_id uuid NOT NULL,lifecycle_id uuid NOT NULL,owner text NOT NULL,
 state text NOT NULL CHECK(state IN ('active','revoked')),active_generation integer NOT NULL DEFAULT 0 CHECK(active_generation BETWEEN 0 AND 999999999),
 revoked_at timestamptz,PRIMARY KEY(namespace_id,user_id,lifecycle_id)
);
CREATE TABLE public.shrigma_crm_manager_operation_v1 (
 namespace_id uuid NOT NULL REFERENCES public.shrigma_crm_manager_issuer_v1(namespace_id),
 operation_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('prepare_read','renew_read','commit_read','revoke_read')),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 response jsonb,PRIMARY KEY(namespace_id,operation_id)
);
CREATE TABLE public.shrigma_crm_manager_generation_v1 (
 namespace_id uuid NOT NULL,user_id uuid NOT NULL,lifecycle_id uuid NOT NULL,prepare_operation_id uuid NOT NULL,
 generation integer NOT NULL CHECK(generation BETWEEN 1 AND 999999999),
 expected_generation integer NOT NULL CHECK(expected_generation=generation-1),
 principal_id text NOT NULL UNIQUE REFERENCES public.crm_dash_chave(chave),
 state text NOT NULL CHECK(state IN ('prepared','active','revoked','expired')),
 issued_at_ms bigint NOT NULL,candidate_expires_at_ms bigint NOT NULL,expires_at_ms bigint NOT NULL,
 commit_operation_id uuid,committed_at_ms bigint,
 PRIMARY KEY(namespace_id,prepare_operation_id),
 FOREIGN KEY(namespace_id,user_id,lifecycle_id) REFERENCES public.shrigma_crm_manager_subject_v1(namespace_id,user_id,lifecycle_id),
 FOREIGN KEY(namespace_id,prepare_operation_id) REFERENCES public.shrigma_crm_manager_operation_v1(namespace_id,operation_id),
 CHECK(candidate_expires_at_ms=issued_at_ms+600000),
 CHECK(expires_at_ms=issued_at_ms+1209600000)
);
CREATE UNIQUE INDEX shrigma_crm_manager_one_prepared_v1 ON public.shrigma_crm_manager_generation_v1(namespace_id,user_id,lifecycle_id) WHERE state='prepared';
CREATE UNIQUE INDEX shrigma_crm_manager_one_active_v1 ON public.shrigma_crm_manager_generation_v1(namespace_id,user_id,lifecycle_id) WHERE state='active';
REVOKE ALL ON public.shrigma_crm_manager_issuer_v1,public.shrigma_crm_manager_subject_v1,public.shrigma_crm_manager_operation_v1,public.shrigma_crm_manager_generation_v1 FROM PUBLIC;

-- Canonical JSON matches the client's sorted-key serializer for the closed
-- ASCII/integer request schema. No pgcrypto extension or secret is required.
CREATE FUNCTION public.shrigma_crm_manager_canonical_v1(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE result text;kind text:=jsonb_typeof(v);
BEGIN
 IF kind='object' THEN
  SELECT '{'||coalesce(string_agg(to_jsonb(k)::text||':'||public.shrigma_crm_manager_canonical_v1(val),',' ORDER BY k COLLATE "C"),'')||'}'
   INTO result FROM jsonb_each(v) item(k,val);
 ELSIF kind='array' THEN
  SELECT '['||coalesce(string_agg(public.shrigma_crm_manager_canonical_v1(val),',' ORDER BY n),'')||']'
   INTO result FROM jsonb_array_elements(v) WITH ORDINALITY item(val,n);
 ELSE result:=coalesce(v::text,'null'); END IF;
 RETURN result;
END $$;
CREATE FUNCTION public.shrigma_crm_manager_error_v1(req jsonb,issuer uuid,ns uuid,code text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('schema','crm-manager-provision-error-v1','issuerId',issuer,'namespaceId',ns,
  'operationId',CASE WHEN coalesce(req->>'operationId','') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN req->>'operationId' ELSE NULL END,
  'requestSha256',encode(sha256(convert_to(public.shrigma_crm_manager_canonical_v1(req),'UTF8')),'hex'),'code',code)
$$;

-- Private implementation. Four wrappers below are the only proposed RPCs.
CREATE FUNCTION public.shrigma_crm_manager_apply_v1(req jsonb,rpc text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 issuer public.shrigma_crm_manager_issuer_v1%ROWTYPE;
 subject public.shrigma_crm_manager_subject_v1%ROWTYPE;
 op public.shrigma_crm_manager_operation_v1%ROWTYPE;
 candidate public.shrigma_crm_manager_generation_v1%ROWTYPE;
 role_ok boolean;action text;expected_keys text[];actual_keys text[];ns uuid;opid uuid;uid uuid;life uuid;
 principal text;owner_email text;hash_value text;fp text;gen integer;previous integer;prepare_id uuid;
 now_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;issued bigint;candidate_until bigint;final_until bigint;
 result jsonb;code text;revoked_count integer;
BEGIN
 SELECT * INTO issuer FROM public.shrigma_crm_manager_issuer_v1 WHERE login_role=session_user AND active;
 IF NOT FOUND THEN RETURN public.shrigma_crm_manager_error_v1(req,NULL,NULL,'ISSUER_DENIED'); END IF;
 ns:=issuer.namespace_id;
 SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
  AND NOT r.rolbypassrls AND NOT r.rolreplication AND NOT r.rolinherit
  AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
  INTO role_ok FROM pg_roles r WHERE r.rolname=session_user;
 IF role_ok IS DISTINCT FROM true THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'ISSUER_DENIED'); END IF;
 IF jsonb_typeof(req) IS DISTINCT FROM 'object' OR octet_length(req::text)>4096
  THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 action:=req->>'action';
 IF rpc='prepare' AND action IN ('prepare_read','renew_read') THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','userId','lifecycleId','owner','principalId','keySha256','generation','expectedGeneration','area','slot','role','caps','candidateTtlMs','lifetimeMs'];
 ELSIF rpc='commit' AND action='commit_read' THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','userId','lifecycleId','owner','principalId','keySha256','generation','expectedGeneration','area','slot','role','caps','candidateTtlMs','lifetimeMs','prepareOperationId','issuedAt','candidateExpiresAt','expiresAt'];
 ELSIF rpc='revoke' AND action='revoke_read' THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','userId','lifecycleId','owner'];
 ELSIF rpc='status' AND action='status' THEN
  expected_keys:=ARRAY['schema','issuerId','namespaceId','action','operationId','expectedRequestSha256'];
 ELSE RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 SELECT array_agg(k ORDER BY k COLLATE "C") INTO actual_keys FROM jsonb_object_keys(req) k;
 SELECT array_agg(k ORDER BY k COLLATE "C") INTO expected_keys FROM unnest(expected_keys) k;
 IF actual_keys IS DISTINCT FROM expected_keys OR req->>'schema' IS DISTINCT FROM 'crm-manager-provision-request-v1'
  OR req->>'issuerId' IS DISTINCT FROM issuer.issuer_id::text OR req->>'namespaceId' IS DISTINCT FROM ns::text
  OR coalesce(req->>'operationId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 opid:=(req->>'operationId')::uuid;
 fp:=encode(sha256(convert_to(public.shrigma_crm_manager_canonical_v1(req),'UTF8')),'hex');
 IF rpc='status' THEN
  IF jsonb_typeof(req->'expectedRequestSha256') IS DISTINCT FROM 'string' OR coalesce(req->>'expectedRequestSha256','') !~ '^[a-f0-9]{64}$'
   THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  SELECT * INTO op FROM public.shrigma_crm_manager_operation_v1 WHERE namespace_id=ns AND operation_id=opid;
  IF NOT FOUND THEN
   RETURN jsonb_build_object('schema','crm-manager-provision-status-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'found',false);
  END IF;
  IF op.request_sha256<>req->>'expectedRequestSha256' THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'IDEMPOTENCY_CONFLICT'); END IF;
  IF op.response IS NULL THEN
   RETURN jsonb_build_object('schema','crm-manager-provision-status-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'found',false);
  END IF;
  IF op.response->>'schema'='crm-manager-provision-error-v1' THEN
   RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,op.response->>'code');
  END IF;
  IF op.action<>'revoke_read' AND EXISTS(SELECT 1 FROM public.shrigma_crm_manager_subject_v1 s WHERE s.namespace_id=ns
   AND s.user_id=(op.response->>'userId')::uuid AND s.lifecycle_id=(op.response->>'lifecycleId')::uuid AND s.state='revoked') THEN
   RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'LIFECYCLE_REVOKED');
  END IF;
  -- An expired prepare/renew receipt is historical proof, not a live lease.
  -- Lost-ACK reconciliation needs its fixed dates to close the local operation
  -- and issue a new candidate. Status never extends TTL or reactivates a key;
  -- direct prepare replay/commit still reject expiry, and tombstones dominate.
  RETURN jsonb_build_object('schema','crm-manager-provision-status-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'found',true,'receipt',op.response);
 END IF;
 IF coalesce(req->>'userId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR coalesce(req->>'lifecycleId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(req->'owner') IS DISTINCT FROM 'string'
  OR coalesce(req->>'owner','') !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9-]+\.)+[a-z]{2,63}$'
  OR length(req->>'owner')>254 OR req->>'owner'<>lower(req->>'owner')
  OR NOT(split_part(req->>'owner','@',2)=ANY(issuer.allowed_email_domains))
  THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
 uid:=(req->>'userId')::uuid;life:=(req->>'lifecycleId')::uuid;owner_email:=req->>'owner';
 IF rpc IN ('prepare','commit') THEN
  IF coalesce(req->>'principalId','') !~ '^dcrm-[a-f0-9]{32}$'
   OR jsonb_typeof(req->'keySha256') IS DISTINCT FROM 'string' OR coalesce(req->>'keySha256','') !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(req->'generation') IS DISTINCT FROM 'number' OR jsonb_typeof(req->'expectedGeneration') IS DISTINCT FROM 'number'
   OR coalesce(req->>'generation','') !~ '^[0-9]{1,9}$' OR coalesce(req->>'expectedGeneration','') !~ '^[0-9]{1,9}$'
   OR req->>'area' IS DISTINCT FROM 'growth' OR req->>'slot' IS DISTINCT FROM 'crm-panel-read' OR req->>'role' IS DISTINCT FROM 'manager'
   OR req->'caps' IS DISTINCT FROM '["read_content","list_history","submission"]'::jsonb
   OR req->'candidateTtlMs' IS DISTINCT FROM '600000'::jsonb OR req->'lifetimeMs' IS DISTINCT FROM '1209600000'::jsonb
   THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  gen:=(req->>'generation')::integer;previous:=(req->>'expectedGeneration')::integer;
  IF gen<>previous+1 OR (action='prepare_read' AND (gen<>1 OR previous<>0)) OR (action='renew_read' AND previous<1)
   THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  principal:=req->>'principalId';hash_value:=req->>'keySha256';
 END IF;
 IF rpc='commit' THEN
  IF coalesce(req->>'prepareOperationId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR req->>'prepareOperationId'=opid::text
   OR jsonb_typeof(req->'issuedAt') IS DISTINCT FROM 'number' OR jsonb_typeof(req->'candidateExpiresAt') IS DISTINCT FROM 'number' OR jsonb_typeof(req->'expiresAt') IS DISTINCT FROM 'number'
   OR coalesce(req->>'issuedAt','') !~ '^[0-9]{1,16}$' OR coalesce(req->>'candidateExpiresAt','') !~ '^[0-9]{1,16}$' OR coalesce(req->>'expiresAt','') !~ '^[0-9]{1,16}$'
   THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'INPUT_INVALID'); END IF;
  prepare_id:=(req->>'prepareOperationId')::uuid;
 END IF;
 -- Idempotency record is claimed before subject mutations. Different operations
 -- then serialize on the same subject row; a response becomes visible atomically.
 INSERT INTO public.shrigma_crm_manager_operation_v1(namespace_id,operation_id,action,request_sha256)
  VALUES(ns,opid,action,fp) ON CONFLICT(namespace_id,operation_id) DO NOTHING;
 SELECT * INTO op FROM public.shrigma_crm_manager_operation_v1 WHERE namespace_id=ns AND operation_id=opid FOR UPDATE;
 IF op.request_sha256<>fp OR op.action<>action THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'IDEMPOTENCY_CONFLICT'); END IF;
 SELECT * INTO subject FROM public.shrigma_crm_manager_subject_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life FOR UPDATE;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 IF FOUND AND subject.owner<>owner_email THEN
  result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT');
 ELSIF FOUND AND subject.state='revoked' AND rpc<>'revoke' THEN
  result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'LIFECYCLE_REVOKED');
 ELSIF op.response IS NOT NULL THEN
  IF rpc='prepare' THEN
   SELECT * INTO candidate FROM public.shrigma_crm_manager_generation_v1 WHERE namespace_id=ns AND prepare_operation_id=opid;
   IF FOUND AND (candidate.state IN ('expired','revoked') OR candidate.candidate_expires_at_ms<=now_ms AND candidate.state='prepared')
    THEN RETURN public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CANDIDATE_EXPIRED'); END IF;
  END IF;
  RETURN op.response;
 END IF;
 IF result IS NULL AND rpc IN ('prepare','revoke') AND subject.namespace_id IS NULL THEN
  INSERT INTO public.shrigma_crm_manager_subject_v1(namespace_id,user_id,lifecycle_id,owner,state)
   VALUES(ns,uid,life,owner_email,CASE WHEN rpc='revoke' THEN 'revoked' ELSE 'active' END) ON CONFLICT DO NOTHING;
  SELECT * INTO subject FROM public.shrigma_crm_manager_subject_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life FOR UPDATE;
  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF subject.owner<>owner_email THEN result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT'); END IF;
  IF subject.state='revoked' AND rpc<>'revoke' THEN result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'LIFECYCLE_REVOKED'); END IF;
 END IF;
 IF result IS NULL AND subject.namespace_id IS NULL THEN result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'SUBJECT_NOT_FOUND'); END IF;
 IF result IS NULL AND rpc='prepare' THEN
  IF subject.active_generation<>previous THEN result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'GENERATION_CONFLICT');
  ELSE
   -- Reconcile only expired pending candidates. Active predecessor is untouched.
   UPDATE public.crm_dash_chave c SET ativo=false,revogada_em=clock_timestamp()
    FROM public.shrigma_crm_manager_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life
    AND g.state='prepared' AND g.candidate_expires_at_ms<=now_ms AND c.chave=g.principal_id;
   DELETE FROM public.shrigma_panel_permission_v1 p USING public.shrigma_crm_manager_generation_v1 g
    WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND g.state='prepared' AND g.candidate_expires_at_ms<=now_ms AND p.principal_id=g.principal_id;
   UPDATE public.shrigma_crm_manager_generation_v1 SET state='expired'
    WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state='prepared' AND candidate_expires_at_ms<=now_ms;
   IF EXISTS(SELECT 1 FROM public.shrigma_crm_manager_generation_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state='prepared') THEN
    result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'GENERATION_CONFLICT');
   ELSE
    issued:=now_ms;candidate_until:=issued+600000;final_until:=issued+1209600000;
    BEGIN
     INSERT INTO public.crm_dash_chave(chave,painel,dono,ativo,revogada_em,ultimo_uso,usos,chave_hash,chave_hash_curta,expira_em)
      VALUES(principal,'growth',owner_email,true,NULL,NULL,0,hash_value,NULL,to_timestamp(candidate_until/1000.0));
     INSERT INTO public.shrigma_panel_permission_v1(principal_id,area,caps) VALUES(principal,'growth','["read_content","list_history","submission"]'::jsonb);
     INSERT INTO public.shrigma_crm_manager_generation_v1(namespace_id,user_id,lifecycle_id,prepare_operation_id,generation,expected_generation,principal_id,state,issued_at_ms,candidate_expires_at_ms,expires_at_ms)
      VALUES(ns,uid,life,opid,gen,previous,principal,'prepared',issued,candidate_until,final_until);
    EXCEPTION WHEN unique_violation THEN result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT'); END;
    IF result IS NULL THEN result:=jsonb_build_object('schema','crm-manager-provision-receipt-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'action',action,'requestSha256',fp,'userId',uid,'lifecycleId',life,'owner',owner_email,
     'state','prepared','principalId',principal,'generation',gen,'expectedGeneration',previous,'area','growth','slot','crm-panel-read','role','manager','caps','["read_content","list_history","submission"]'::jsonb,
     'issuedAt',issued,'candidateExpiresAt',candidate_until,'expiresAt',final_until); END IF;
   END IF;
  END IF;
 ELSIF result IS NULL AND rpc='commit' THEN
  SELECT * INTO candidate FROM public.shrigma_crm_manager_generation_v1 WHERE namespace_id=ns AND prepare_operation_id=prepare_id FOR UPDATE;
  -- Keep the verified key and existing grants stable during promotion. The
  -- parent key lock also serializes FK-backed concurrent grant insertion.
  PERFORM c.chave FROM public.crm_dash_chave c WHERE c.chave=candidate.principal_id FOR UPDATE;
  PERFORM p.principal_id FROM public.shrigma_panel_permission_v1 p WHERE p.principal_id=candidate.principal_id FOR UPDATE;
  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF candidate.namespace_id IS NULL OR candidate.user_id<>uid OR candidate.lifecycle_id<>life OR candidate.principal_id<>principal OR candidate.generation<>gen OR candidate.expected_generation<>previous THEN
   result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT');
  ELSIF candidate.state IN ('expired','revoked') OR candidate.candidate_expires_at_ms<=now_ms THEN
   result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CANDIDATE_EXPIRED');
  ELSIF candidate.issued_at_ms<>(req->>'issuedAt')::bigint OR candidate.candidate_expires_at_ms<>(req->>'candidateExpiresAt')::bigint OR candidate.expires_at_ms<>(req->>'expiresAt')::bigint
   OR NOT EXISTS(SELECT 1 FROM public.crm_dash_chave c WHERE c.chave=principal AND c.chave_hash=hash_value AND c.painel='growth' AND c.dono=owner_email AND c.chave_hash_curta IS NULL
    AND c.ativo AND c.revogada_em IS NULL AND c.expira_em=to_timestamp(candidate.candidate_expires_at_ms/1000.0))
   OR NOT EXISTS(SELECT 1 FROM public.shrigma_panel_permission_v1 p WHERE p.principal_id=principal AND p.area='growth' AND p.caps='["read_content","list_history","submission"]'::jsonb)
   OR EXISTS(SELECT 1 FROM public.shrigma_panel_permission_v1 p WHERE p.principal_id=principal AND p.area<>'growth') THEN
   result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'CREDENTIAL_CONFLICT');
  ELSIF candidate.state<>'prepared' OR subject.active_generation<>previous THEN
   result:=public.shrigma_crm_manager_error_v1(req,issuer.issuer_id,ns,'GENERATION_CONFLICT');
  ELSE
   UPDATE public.crm_dash_chave c SET ativo=false,revogada_em=clock_timestamp()
    FROM public.shrigma_crm_manager_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND g.state='active' AND c.chave=g.principal_id;
   DELETE FROM public.shrigma_panel_permission_v1 p USING public.shrigma_crm_manager_generation_v1 g
    WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND g.state='active' AND p.principal_id=g.principal_id;
   UPDATE public.shrigma_crm_manager_generation_v1 SET state='revoked' WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state='active';
   UPDATE public.crm_dash_chave SET expira_em=to_timestamp(candidate.expires_at_ms/1000.0) WHERE chave=principal;
   UPDATE public.shrigma_crm_manager_generation_v1 SET state='active',commit_operation_id=opid,committed_at_ms=now_ms WHERE namespace_id=ns AND prepare_operation_id=prepare_id;
   UPDATE public.shrigma_crm_manager_subject_v1 SET active_generation=gen WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life;
   result:=jsonb_build_object('schema','crm-manager-provision-receipt-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'action',action,'requestSha256',fp,'userId',uid,'lifecycleId',life,'owner',owner_email,
    'state','committed','principalId',principal,'generation',gen,'expectedGeneration',previous,'area','growth','slot','crm-panel-read','role','manager','caps','["read_content","list_history","submission"]'::jsonb,
    'issuedAt',candidate.issued_at_ms,'candidateExpiresAt',candidate.candidate_expires_at_ms,'expiresAt',candidate.expires_at_ms,'prepareOperationId',prepare_id,'committedAt',now_ms,'revokedGeneration',CASE WHEN previous=0 THEN NULL ELSE previous END);
  END IF;
 ELSIF result IS NULL AND rpc='revoke' THEN
  SELECT count(*)::integer INTO revoked_count FROM public.shrigma_crm_manager_generation_v1 WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life AND state IN ('prepared','active');
  UPDATE public.shrigma_crm_manager_subject_v1 SET state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life;
  UPDATE public.crm_dash_chave c SET ativo=false,revogada_em=coalesce(c.revogada_em,clock_timestamp())
   FROM public.shrigma_crm_manager_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND c.chave=g.principal_id;
  DELETE FROM public.shrigma_panel_permission_v1 p USING public.shrigma_crm_manager_generation_v1 g WHERE g.namespace_id=ns AND g.user_id=uid AND g.lifecycle_id=life AND p.principal_id=g.principal_id;
  UPDATE public.shrigma_crm_manager_generation_v1 SET state='revoked' WHERE namespace_id=ns AND user_id=uid AND lifecycle_id=life;
  result:=jsonb_build_object('schema','crm-manager-provision-receipt-v1','issuerId',issuer.issuer_id,'namespaceId',ns,'operationId',opid,'action',action,'requestSha256',fp,'userId',uid,'lifecycleId',life,'owner',owner_email,
   'state','revoked','revocationMode','lifecycle','allGenerationsRevoked',true,'effectiveAt',now_ms,'revokedCount',revoked_count);
 END IF;
 UPDATE public.shrigma_crm_manager_operation_v1 SET response=result WHERE namespace_id=ns AND operation_id=opid AND response IS NULL;
 RETURN result;
END $$;

CREATE FUNCTION public.shrigma_crm_manager_prepare_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.shrigma_crm_manager_apply_v1($1,'prepare') $$;
CREATE FUNCTION public.shrigma_crm_manager_commit_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.shrigma_crm_manager_apply_v1($1,'commit') $$;
CREATE FUNCTION public.shrigma_crm_manager_revoke_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.shrigma_crm_manager_apply_v1($1,'revoke') $$;
CREATE FUNCTION public.shrigma_crm_manager_status_v1(jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT public.shrigma_crm_manager_apply_v1($1,'status') $$;
REVOKE ALL ON FUNCTION public.shrigma_crm_manager_canonical_v1(jsonb),public.shrigma_crm_manager_error_v1(jsonb,uuid,uuid,text),public.shrigma_crm_manager_apply_v1(jsonb,text),
 public.shrigma_crm_manager_prepare_v1(jsonb),public.shrigma_crm_manager_commit_v1(jsonb),public.shrigma_crm_manager_revoke_v1(jsonb),public.shrigma_crm_manager_status_v1(jsonb) FROM PUBLIC;
COMMIT;
