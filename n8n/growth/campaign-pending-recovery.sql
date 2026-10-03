-- CRM · Recuperação segura de tentativas pendentes de agendar/cancelar (DESLIGADA).
-- PROPOSTA para revisão. NÃO aplicar em produção sem a sequência descrita em
-- docs/crm/RECUPERACAO-TENTATIVAS-PENDENTES-20261003.md. Aplicada só em bancos de teste.
--
-- O que instala (idempotente, uma transação, aborta em qualquer desvio):
--  1) colunas novas em shrigma_campaign_operation: lease_expires_at e abandoned_at;
--  2) tabela de configuração com enabled=false (gate SQL; sem ela ligada nada muda);
--  3) gatilho de cerca (fencing) na própria linha da operação:
--     - só emite lease para 'agendar'/'cancelar' recém-reivindicadas quando ligado;
--     - recusa a transição pending->succeeded depois do lease (OPERATION_LEASE_EXPIRED),
--       o que desfaz o efeito SQL atômico (status da campanha + recibo na mesma transação);
--     - lápide (abandoned_at) é imutável e só nasce pela função abaixo;
--  4) public.shrigma_campaign_abandon(jsonb): grava a lápide sob o MESMO advisory lock
--     do claim e o MESMO FOR UPDATE da linha usado pelo provider.
-- Não altera o corpo de shrigma_campaign_store/provider/recovery (md5 preservados) e
-- não toca campanhas, contatos nem recibos existentes. Owner do backend apenas.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $check$
BEGIN
 IF current_user<>'postgres' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'PENDING_RECOVERY_OWNER_REQUIRED';
 END IF;
 IF to_regclass('public.shrigma_campaign_operation') IS NULL OR to_regprocedure('public.shrigma_campaign_store(text,jsonb)') IS NULL
  OR to_regprocedure('public.shrigma_campaign_provider(text,jsonb)') IS NULL THEN RAISE EXCEPTION 'PENDING_RECOVERY_DEPENDENCY_MISSING'; END IF;
 -- A lápide só é verdadeira se agendar/cancelar gravam o recibo 'succeeded' na
 -- mesma transação do efeito (CRM atomic receipt) e o claim usa este advisory lock.
 IF strpos((SELECT prosrc FROM pg_proc WHERE oid='public.shrigma_campaign_provider(text,jsonb)'::regprocedure),'CAMPAIGN_ATOMIC_SCHEDULE_RECEIPT_V1')=0
  OR strpos((SELECT prosrc FROM pg_proc WHERE oid='public.shrigma_campaign_provider(text,jsonb)'::regprocedure),'CAMPAIGN_ATOMIC_CANCEL_RECEIPT_V1')=0
  OR strpos((SELECT prosrc FROM pg_proc WHERE oid='public.shrigma_campaign_provider(text,jsonb)'::regprocedure),'op.state<>''pending''')=0
  OR strpos((SELECT prosrc FROM pg_proc WHERE oid='public.shrigma_campaign_store(text,jsonb)'::regprocedure),'pg_advisory_xact_lock(hashtextextended(''campaign-operation:''||jsonb_build_array(p->>''actor'',p->>''key'')::text,0))')=0
 THEN RAISE EXCEPTION 'PENDING_RECOVERY_PROVIDER_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.shrigma_campaign_operation'::regclass AND attname IN ('lease_expires_at','abandoned_at') AND NOT attisdropped
   AND format_type(atttypid,atttypmod)<>'timestamp with time zone') THEN RAISE EXCEPTION 'PENDING_RECOVERY_COLUMN_DRIFT'; END IF;
END $check$;

ALTER TABLE public.shrigma_campaign_operation ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE public.shrigma_campaign_operation ADD COLUMN IF NOT EXISTS abandoned_at timestamptz;
DO $c$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.shrigma_campaign_operation'::regclass AND conname='shrigma_campaign_operation_abandon_check') THEN
  ALTER TABLE public.shrigma_campaign_operation ADD CONSTRAINT shrigma_campaign_operation_abandon_check
   CHECK (abandoned_at IS NULL OR (state='rejected' AND action IN ('agendar','cancelar')));
 END IF;
END $c$;

CREATE TABLE IF NOT EXISTS public.shrigma_campaign_pending_recovery_config (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 enabled boolean NOT NULL DEFAULT false,
 lease_seconds integer NOT NULL DEFAULT 900 CHECK (lease_seconds BETWEEN 300 AND 3600),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.shrigma_campaign_pending_recovery_config(id) VALUES(true) ON CONFLICT(id) DO NOTHING;
REVOKE ALL ON public.shrigma_campaign_pending_recovery_config FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.shrigma_campaign_operation_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE cfg public.shrigma_campaign_pending_recovery_config%ROWTYPE; writer text:=current_setting('shrigma.campaign_abandon',true);
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.abandoned_at IS NOT NULL THEN
   IF writer IS DISTINCT FROM NEW.actor||':'||NEW.operation_key OR NEW.state<>'rejected' THEN RAISE EXCEPTION 'OPERATION_ABANDON_GUARD'; END IF;
   NEW.lease_expires_at:=NULL;RETURN NEW;
  END IF;
  -- O chamador nunca escolhe o lease: só o servidor, e só com o gate ligado.
  NEW.lease_expires_at:=NULL;
  IF NEW.state='pending' AND NEW.action IN ('agendar','cancelar') THEN
   SELECT * INTO cfg FROM public.shrigma_campaign_pending_recovery_config WHERE id;
   IF FOUND AND cfg.enabled THEN NEW.lease_expires_at:=clock_timestamp()+make_interval(secs=>cfg.lease_seconds); END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.abandoned_at IS NOT NULL THEN RAISE EXCEPTION 'OPERATION_ABANDONED'; END IF;
 IF NEW.abandoned_at IS NOT NULL THEN
  IF writer IS DISTINCT FROM OLD.actor||':'||OLD.operation_key OR OLD.state<>'pending' OR NEW.state<>'rejected'
   OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at>clock_timestamp() THEN RAISE EXCEPTION 'OPERATION_ABANDON_GUARD'; END IF;
  RETURN NEW;
 END IF;
 -- Cerca: um efeito agendar/cancelar só confirma com lease válido no instante em que
 -- grava o recibo, sob o FOR UPDATE que o provider já segura desde o início.
 IF OLD.state='pending' AND NEW.state='succeeded' AND OLD.lease_expires_at IS NOT NULL
  AND OLD.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'OPERATION_LEASE_EXPIRED'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_operation_fence() FROM PUBLIC;
DROP TRIGGER IF EXISTS shrigma_campaign_operation_fence ON public.shrigma_campaign_operation;
CREATE TRIGGER shrigma_campaign_operation_fence BEFORE INSERT OR UPDATE ON public.shrigma_campaign_operation
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_operation_fence();

-- Lápide terminal para (ator, chave). Recusas são exceções: nada é gravado.
CREATE OR REPLACE FUNCTION public.shrigma_campaign_abandon(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='3s' AS $fn$
DECLARE r public.shrigma_campaign_operation%ROWTYPE; cfg public.shrigma_campaign_pending_recovery_config%ROWTYPE;
 created boolean:=false; t timestamptz; new_id uuid;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object' OR coalesce(p->>'actor','')='' OR length(p->>'actor')>200
  OR coalesce(p->>'key','') !~ '^[A-Za-z0-9_-]{16,100}$' OR coalesce(p->>'brand','') NOT IN ('aristo','fish') THEN RAISE EXCEPTION 'ABANDON_INPUT'; END IF;
 -- CREATE nativo, salvar/validar/recuperar: efeito externo ou recibo não atômico. Nunca por TTL.
 IF coalesce(p->>'action','') NOT IN ('agendar','cancelar') THEN RAISE EXCEPTION 'ABANDON_ACTION_UNSUPPORTED'; END IF;
 SELECT * INTO cfg FROM public.shrigma_campaign_pending_recovery_config WHERE id;
 IF NOT FOUND OR NOT cfg.enabled THEN RAISE EXCEPTION 'ABANDON_DISABLED'; END IF;
 -- Mesmo advisory lock do claim: um claim atrasado espera e encontra a lápide.
 PERFORM pg_advisory_xact_lock(hashtextextended('campaign-operation:'||jsonb_build_array(p->>'actor',p->>'key')::text,0));
 -- Mesmo FOR UPDATE do provider: um efeito em andamento termina antes desta leitura.
 SELECT * INTO r FROM public.shrigma_campaign_operation WHERE actor=p->>'actor' AND operation_key=p->>'key' FOR UPDATE;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM public.shrigma_campaign_operation WHERE operation_key=p->>'key') THEN RAISE EXCEPTION 'ABANDON_IDENTITY_MISMATCH'; END IF;
  t:=clock_timestamp();new_id:=gen_random_uuid();
  PERFORM set_config('shrigma.campaign_abandon',(p->>'actor')||':'||(p->>'key'),true);
  -- request_hash sentinela: nenhum pedido real produz este hash, então um POST
  -- atrasado com esta chave recebe IDEMPOTENCY_CONFLICT antes de qualquer efeito.
  INSERT INTO public.shrigma_campaign_operation(id,actor,operation_key,request_hash,brand,action,state,response,abandoned_at,created_at,updated_at)
  VALUES(new_id,p->>'actor',p->>'key',encode(sha256(convert_to('crm-campaign-abandon-v1:'||jsonb_build_array(p->>'actor',p->>'key')::text,'UTF8')),'hex'),
   p->>'brand',p->>'action','rejected',jsonb_build_object('status',409,'body',jsonb_build_object('error','OPERATION_ABANDONED',
    'message','Tentativa encerrada sem efeito: o servidor não tinha registro desta chave e a bloqueou. Um envio atrasado com esta chave será recusado.',
    'provider_id',NULL,'operation_id',new_id)),t,t,t)
  RETURNING * INTO r;
  created:=true;
  PERFORM set_config('shrigma.campaign_abandon','',true);
 ELSE
  IF r.action NOT IN ('agendar','cancelar') THEN RAISE EXCEPTION 'ABANDON_ACTION_UNSUPPORTED'; END IF;
  IF r.brand IS DISTINCT FROM p->>'brand' OR r.action IS DISTINCT FROM p->>'action' THEN RAISE EXCEPTION 'ABANDON_IDENTITY_MISMATCH'; END IF;
  IF r.state='pending' THEN
   -- Sem lease (operação anterior ao gate) não há prova: continua em conciliação.
   IF r.lease_expires_at IS NULL THEN RAISE EXCEPTION 'ABANDON_LEASE_UNKNOWN'; END IF;
   IF r.lease_expires_at>clock_timestamp() THEN RAISE EXCEPTION 'ABANDON_LEASE_ACTIVE'; END IF;
   t:=clock_timestamp();
   PERFORM set_config('shrigma.campaign_abandon',r.actor||':'||r.operation_key,true);
   UPDATE public.shrigma_campaign_operation SET state='rejected',abandoned_at=t,updated_at=t,
    response=jsonb_build_object('status',409,'body',jsonb_build_object('error','OPERATION_ABANDONED',
     'message','Tentativa encerrada sem efeito: o prazo dela venceu e o servidor a bloqueou antes de qualquer agendamento ou cancelamento.',
     'provider_id',r.provider_id,'operation_id',r.id))
    WHERE id=r.id RETURNING * INTO r;
   PERFORM set_config('shrigma.campaign_abandon','',true);
  END IF;
  -- Estado final (succeeded, rejected, outcome_unknown ou lápide anterior): devolve como está.
 END IF;
 RETURN jsonb_build_object('policy','crm-campaign-abandon-v1','abandoned',r.abandoned_at IS NOT NULL,'created',created,
  'operation',jsonb_build_object('id',r.id,'operation_key',r.operation_key,'brand',r.brand,'action',r.action,'state',r.state,
   'providerId',r.provider_id,'response',r.response,'abandoned_at',r.abandoned_at,'created_at',r.created_at,'updated_at',r.updated_at));
END $fn$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_abandon(jsonb) FROM PUBLIC;
COMMIT;
