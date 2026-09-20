-- Additive candidate. Installation alone never enables manual decisions.
-- No historical attempt is inferred to have failed because a log is absent.
BEGIN;
CREATE TABLE IF NOT EXISTS public.crm_tts_manual_control_v1 (
  marca text PRIMARY KEY CHECK (marca IN ('aristo','fish')),
  enabled boolean NOT NULL DEFAULT false,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  eligible_from timestamptz,
  CHECK (NOT enabled OR (eligible_from IS NOT NULL AND eligible_from >= installed_at))
);
INSERT INTO public.crm_tts_manual_control_v1(marca) VALUES ('aristo'),('fish') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.crm_tts_manual_operation_v1 (
  operation_id uuid PRIMARY KEY,
  marca text NOT NULL CHECK (marca IN ('aristo','fish')),
  application_id text NOT NULL CHECK (application_id ~ '^[1-9][0-9]{0,79}$'),
  actor_sha256 text NOT NULL CHECK (actor_sha256 ~ '^[a-f0-9]{64}$'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  state text NOT NULL CHECK (state IN ('reserved','in_flight','accepted','outcome_unknown','blocked')),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 160),
  claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
  source_snapshot jsonb NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  receipt jsonb,
  response jsonb,
  UNIQUE(marca,application_id),
  CHECK (state<>'in_flight' OR started_at IS NOT NULL),
  CHECK (state NOT IN ('accepted','outcome_unknown','blocked') OR finished_at IS NOT NULL)
);
REVOKE ALL ON public.crm_tts_manual_control_v1,public.crm_tts_manual_operation_v1 FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.crm_tts_manual_receipt_v1(p_id uuid,p_actor text,p_marca text,p_application text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('contract','tts_manual_operation_v1','operation',COALESCE(
  (SELECT jsonb_build_object('operation_id',operation_id,'marca',marca,'application_id',application_id,
    'actor_sha256',actor_sha256,'request_payload',request_payload,'state',state,
    'reserved_at',reserved_at,'started_at',started_at,'finished_at',finished_at,'response',response)
   FROM public.crm_tts_manual_operation_v1
   WHERE operation_id=p_id AND actor_sha256=p_actor AND marca=p_marca AND application_id=p_application),
  jsonb_build_object('operation_id',p_id,'marca',p_marca,'application_id',p_application,'actor_sha256',p_actor,
    'state','missing','request_payload',NULL,'response',NULL)))
$$;

CREATE OR REPLACE FUNCTION public.crm_tts_manual_store_v1(p_action text,p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE
 v_id uuid; v_actor text; v_marca text; v_app text; v_owner text; v_token uuid;
 v_request jsonb; v_snapshot jsonb; v_receipt jsonb; v_result text; v_reason text;
 v public.crm_tts_manual_operation_v1%ROWTYPE; c public.crm_tts_manual_control_v1%ROWTYPE;
 a public.crm_tts_amostra%ROWTYPE; v_mode text; v_current jsonb; v_response jsonb;
BEGIN
 IF p_action IS NULL OR p_action NOT IN ('claim','dispatch','finish','get') OR p IS NULL OR jsonb_typeof(p)<>'object' THEN
  RAISE EXCEPTION 'TTS_MANUAL_INVALID_REQUEST';
 END IF;
 IF jsonb_typeof(p->'operation_id') IS DISTINCT FROM 'string' OR (p->>'operation_id') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(p->'actor_sha256') IS DISTINCT FROM 'string' OR (p->>'actor_sha256') !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(p->'marca') IS DISTINCT FROM 'string' OR (p->>'marca') NOT IN ('aristo','fish')
  OR jsonb_typeof(p->'application_id') IS DISTINCT FROM 'string' OR (p->>'application_id') !~ '^[1-9][0-9]{0,79}$' THEN
  RAISE EXCEPTION 'TTS_MANUAL_INVALID_IDENTITY';
 END IF;
 v_id:=(p->>'operation_id')::uuid;v_actor:=p->>'actor_sha256';v_marca:=p->>'marca';v_app:=p->>'application_id';
 IF p_action='get' THEN RETURN public.crm_tts_manual_receipt_v1(v_id,v_actor,v_marca,v_app);END IF;
 v_owner:=p->>'owner';
 IF jsonb_typeof(p->'owner') IS DISTINCT FROM 'string' OR length(v_owner) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'TTS_MANUAL_OWNER_REQUIRED';END IF;
 -- Common order for every writer: control, rule (when needed), resource advisory,
 -- operation, sample. A collector only locks sample; no multi-sample lock here.
 IF p_action IN ('claim','dispatch') THEN
  SELECT * INTO c FROM public.crm_tts_manual_control_v1 WHERE marca=v_marca FOR SHARE;
  SELECT modo INTO v_mode FROM public.crm_tts_regra WHERE marca=v_marca FOR SHARE;
 END IF;
 -- This lock ends before HTTP. Automatic workers must share a durable fence
 -- before enablement; this read guard alone does not fence work already in flight.
 PERFORM pg_advisory_xact_lock(hashtextextended('tts_manual_v1:'||v_marca||':'||v_app,0));
 SELECT * INTO v FROM public.crm_tts_manual_operation_v1 WHERE marca=v_marca AND application_id=v_app FOR UPDATE;
 IF p_action='claim' THEN
  v_request:=p->'request_payload';
  IF jsonb_typeof(v_request) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v_request))<>6
   OR NOT v_request ?& ARRAY['marca','application_id','resultado','motivo_rejeicao','observacao','autor']
   OR jsonb_typeof(v_request->'marca') IS DISTINCT FROM 'string' OR jsonb_typeof(v_request->'application_id') IS DISTINCT FROM 'string'
   OR v_request->>'marca' IS DISTINCT FROM v_marca OR v_request->>'application_id' IS DISTINCT FROM v_app
   OR jsonb_typeof(v_request->'resultado') IS DISTINCT FROM 'string' OR v_request->>'resultado' NOT IN ('APPROVE','REJECT')
   OR jsonb_typeof(v_request->'autor') IS DISTINCT FROM 'string' OR length(btrim(v_request->>'autor')) NOT BETWEEN 1 AND 40
   OR jsonb_typeof(v_request->'observacao') IS DISTINCT FROM 'string' OR length(v_request->>'observacao')>200
   OR (v_request->>'resultado'='APPROVE' AND v_request->'motivo_rejeicao'<>'null'::jsonb)
   OR (v_request->>'resultado'='REJECT' AND (jsonb_typeof(v_request->'motivo_rejeicao') IS DISTINCT FROM 'string' OR v_request->>'motivo_rejeicao' NOT IN ('NOT_MATCH','INSUFFICIENT_STOCK','OTHER'))) THEN
   RAISE EXCEPTION 'TTS_MANUAL_INVALID_PAYLOAD';
  END IF;
  IF v.operation_id IS NOT NULL THEN
   IF v.actor_sha256=v_actor AND v.request_payload=v_request THEN
    RETURN jsonb_build_object('allowed',false,'code',CASE WHEN v.operation_id=v_id THEN 'operation_exists' ELSE 'resource_reserved' END,
     'receipt',public.crm_tts_manual_receipt_v1(v.operation_id,v_actor,v_marca,v_app));
   END IF;
   RETURN jsonb_build_object('allowed',false,'code','resource_reserved');
  END IF;
  IF EXISTS(SELECT 1 FROM public.crm_tts_manual_operation_v1 WHERE operation_id=v_id) THEN RETURN jsonb_build_object('allowed',false,'code','idempotency_conflict');END IF;
  IF c.marca IS NULL OR NOT c.enabled OR c.eligible_from IS NULL THEN RETURN jsonb_build_object('allowed',false,'code','disabled');END IF;
  SELECT * INTO a FROM public.crm_tts_amostra WHERE marca=v_marca AND application_id=v_app FOR UPDATE;
  IF a.application_id IS NULL THEN RETURN jsonb_build_object('allowed',false,'code','sample_missing');END IF;
  IF a.primeiro_visto_em<c.eligible_from THEN RETURN jsonb_build_object('allowed',false,'code','legacy_reconciliation_required');END IF;
  IF a.dry_run IS DISTINCT FROM true OR a.decisao LIKE 'manual_%'
   OR EXISTS(SELECT 1 FROM public.crm_tts_coleta_log WHERE marca=v_marca AND fonte='acao_painel' AND (erro LIKE 'APPROVE '||v_app||':%' OR erro LIKE 'REJECT '||v_app||':%')) THEN
   RETURN jsonb_build_object('allowed',false,'code','legacy_reconciliation_required');
  END IF;
  IF (v_mode IS NULL OR v_mode NOT IN ('dry_run','pausado')) THEN RETURN jsonb_build_object('allowed',false,'code','automatic_decisions_not_fenced');END IF;
  IF a.status IS DISTINCT FROM 'PENDING' OR a.approve_expira_em IS NULL OR a.approve_expira_em<=clock_timestamp()
   OR (v_request->>'resultado'='APPROVE' AND a.is_approvable IS DISTINCT FROM true) THEN RETURN jsonb_build_object('allowed',false,'code','sample_not_eligible');END IF;
  v_snapshot:=jsonb_build_object('status',a.status,'is_approvable',a.is_approvable,'approve_expira_em',a.approve_expira_em,'atualizado_em',a.atualizado_em,'primeiro_visto_em',a.primeiro_visto_em,'decisao',a.decisao,'dry_run',a.dry_run);
  INSERT INTO public.crm_tts_manual_operation_v1(operation_id,marca,application_id,actor_sha256,request_payload,state,owner,source_snapshot)
   VALUES(v_id,v_marca,v_app,v_actor,v_request,'reserved',v_owner,v_snapshot) ON CONFLICT DO NOTHING RETURNING * INTO v;
  IF v.operation_id IS NULL THEN RETURN jsonb_build_object('allowed',false,'code','idempotency_conflict');END IF;
  RETURN jsonb_build_object('allowed',true,'code','reserved','operation_id',v.operation_id,'marca',v.marca,'application_id',v.application_id,'actor_sha256',v.actor_sha256,'owner',v.owner,'claim_token',v.claim_token,'state',v.state,'request_payload',v.request_payload);
 END IF;
 IF v.operation_id IS NULL OR v.operation_id<>v_id OR v.actor_sha256<>v_actor OR v.owner<>v_owner THEN RETURN jsonb_build_object('allowed',false,'code','operation_not_owned');END IF;
 IF jsonb_typeof(p->'claim_token') IS DISTINCT FROM 'string' OR p->>'claim_token'<>v.claim_token::text THEN RETURN jsonb_build_object('allowed',false,'code','operation_not_owned');END IF;
 IF p_action='dispatch' THEN
  IF v.state<>'reserved' THEN RETURN jsonb_build_object('allowed',false,'code','transport_already_reserved','receipt',public.crm_tts_manual_receipt_v1(v_id,v_actor,v_marca,v_app));END IF;
  SELECT * INTO a FROM public.crm_tts_amostra WHERE marca=v_marca AND application_id=v_app FOR UPDATE;
  v_current:=jsonb_build_object('status',a.status,'is_approvable',a.is_approvable,'approve_expira_em',a.approve_expira_em,'atualizado_em',a.atualizado_em,'primeiro_visto_em',a.primeiro_visto_em,'decisao',a.decisao,'dry_run',a.dry_run);
  IF c.marca IS NULL OR NOT c.enabled OR c.eligible_from IS NULL OR a.primeiro_visto_em<c.eligible_from THEN v_reason:='disabled_or_cohort_changed';
  ELSIF (v_mode IS NULL OR v_mode NOT IN ('dry_run','pausado')) THEN v_reason:='automatic_decisions_not_fenced';
  ELSIF a.application_id IS NULL OR v_current IS DISTINCT FROM v.source_snapshot OR a.status IS DISTINCT FROM 'PENDING'
   OR a.approve_expira_em IS NULL OR a.approve_expira_em<=clock_timestamp() OR (v.request_payload->>'resultado'='APPROVE' AND a.is_approvable IS DISTINCT FROM true) THEN v_reason:='source_changed_or_expired';END IF;
  IF v_reason IS NOT NULL THEN
   UPDATE public.crm_tts_manual_operation_v1 SET state='blocked',finished_at=clock_timestamp(),receipt=jsonb_build_object('kind','blocked','reason',v_reason),response=jsonb_build_object('status',409,'body',jsonb_build_object('ok',false,'code',v_reason,'operation_id',v_id)) WHERE operation_id=v_id;
   RETURN jsonb_build_object('allowed',false,'code',v_reason,'receipt',public.crm_tts_manual_receipt_v1(v_id,v_actor,v_marca,v_app));
  END IF;
  UPDATE public.crm_tts_manual_operation_v1 SET state='in_flight',started_at=clock_timestamp() WHERE operation_id=v_id;
  RETURN jsonb_build_object('allowed',true,'code','in_flight','operation_id',v_id,'marca',v_marca,'application_id',v_app,'actor_sha256',v_actor,'owner',v_owner,'claim_token',v.claim_token,'state','in_flight','request_payload',v.request_payload);
 END IF;
 v_receipt:=p->'receipt';v_result:=v_receipt->>'kind';
 IF jsonb_typeof(v_receipt) IS DISTINCT FROM 'object' OR jsonb_typeof(v_receipt->'kind') IS DISTINCT FROM 'string' OR v_result NOT IN ('accepted','outcome_unknown','blocked')
  OR (SELECT count(*) FROM jsonb_object_keys(v_receipt))<>4 OR NOT v_receipt ?& ARRAY['kind','provider_code','request_id','reason']
  OR jsonb_typeof(v_receipt->'reason') IS DISTINCT FROM 'string' OR length(v_receipt->>'reason')>120
  OR (v_receipt->'provider_code'<>'null'::jsonb AND jsonb_typeof(v_receipt->'provider_code')<>'number')
  OR (v_receipt->'request_id'<>'null'::jsonb AND (jsonb_typeof(v_receipt->'request_id')<>'string' OR length(v_receipt->>'request_id') NOT BETWEEN 1 AND 160))
  OR (v_result='accepted' AND (v_receipt->'provider_code'<>'0'::jsonb OR jsonb_typeof(v_receipt->'request_id')<>'string')) THEN RAISE EXCEPTION 'TTS_MANUAL_INVALID_RECEIPT';END IF;
 IF v.state IN ('accepted','outcome_unknown','blocked') THEN
  RETURN jsonb_build_object('recorded',v.receipt=v_receipt,'code',CASE WHEN v.receipt=v_receipt THEN 'already_recorded' ELSE 'receipt_mismatch' END,'receipt',public.crm_tts_manual_receipt_v1(v_id,v_actor,v_marca,v_app));
 END IF;
 IF (v.state='reserved' AND v_result<>'blocked') OR (v.state='in_flight' AND v_result='blocked') THEN RETURN jsonb_build_object('recorded',false,'code','receipt_state_invalid');END IF;
 IF v_result='accepted' THEN
  -- Preserve a collector's later platform state; never turn SHIPPED/COMPLETED back into AWAITING_SHIPMENT.
  UPDATE public.crm_tts_amostra SET decisao=CASE WHEN v.request_payload->>'resultado'='APPROVE' THEN 'manual_aprovada' ELSE 'manual_rejeitada' END,
   decisao_motivo=(CASE WHEN v.request_payload->>'observacao'<>'' THEN (v.request_payload->>'observacao')||' · ' ELSE '' END)||'decidido no painel por '||(v.request_payload->>'autor')||(CASE WHEN v.request_payload->>'resultado'='REJECT' THEN ' · '||(v.request_payload->>'motivo_rejeicao') ELSE '' END),
   decidido_em=clock_timestamp(),decidido_por=(v.request_payload->>'autor')||' (painel)',dry_run=false,
   status=CASE WHEN status='PENDING' THEN CASE WHEN v.request_payload->>'resultado'='APPROVE' THEN 'AWAITING_SHIPMENT' ELSE 'REJECT_CANCELLED' END ELSE status END,
   atualizado_em=clock_timestamp() WHERE marca=v_marca AND application_id=v_app RETURNING * INTO a;
  IF a.application_id IS NULL THEN RAISE EXCEPTION 'TTS_MANUAL_SAMPLE_DISAPPEARED';END IF;
  v_response:=jsonb_build_object('status',200,'body',jsonb_build_object('ok',true,'operation_id',v_id,'mensagem','Decisão aceita pela API TikTok; confira o estado atual da amostra.','linhas',jsonb_build_array(jsonb_build_object('application_id',v_app,'status',a.status,'decisao',a.decisao))));
 ELSE
  v_response:=jsonb_build_object('status',CASE WHEN v_result='blocked' THEN 409 ELSE 503 END,'body',jsonb_build_object('ok',false,'operation_id',v_id,'code',v_result,'mensagem','Resultado preservado. Consulte a mesma operação; não repita a decisão.','linhas','[]'::jsonb));
 END IF;
 INSERT INTO public.crm_tts_coleta_log(marca,fonte,terminado_em,linhas,ok,erro) VALUES(v_marca,'acao_painel',clock_timestamp(),CASE WHEN v_result='accepted' THEN 1 ELSE 0 END,v_result='accepted',CASE WHEN v_result='accepted' THEN NULL ELSE 'manual_v1 '||v_id||' '||v_result END);
 UPDATE public.crm_tts_manual_operation_v1 SET state=v_result,finished_at=clock_timestamp(),receipt=v_receipt,response=v_response WHERE operation_id=v_id;
 RETURN jsonb_build_object('recorded',true,'code','recorded','receipt',public.crm_tts_manual_receipt_v1(v_id,v_actor,v_marca,v_app));
END $$;
REVOKE ALL ON FUNCTION public.crm_tts_manual_receipt_v1(uuid,text,text,text),public.crm_tts_manual_store_v1(text,jsonb) FROM PUBLIC;
COMMIT;
