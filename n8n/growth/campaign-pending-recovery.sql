-- CRM · Recuperação segura de tentativas pendentes de agendar/cancelar (DESLIGADA).
-- PROPOSTA para revisão. NÃO aplicar em produção sem a sequência descrita em
-- docs/crm/RECUPERACAO-TENTATIVAS-PENDENTES-20261003.md. Aplicada só em bancos de teste.
--
-- O que instala (uma transação; recusa QUALQUER desvio ANTES de qualquer DDL):
--  1) colunas novas em shrigma_campaign_operation: lease_expires_at e abandoned_at;
--  2) tabela de configuração com enabled=false (gate SQL; sem ela ligada nada muda);
--  3) gatilho de cerca (fencing) na própria linha da operação:
--     - só emite lease para 'agendar'/'cancelar' recém-reivindicadas quando ligado;
--     - recusa a transição pending->succeeded depois do lease (OPERATION_LEASE_EXPIRED),
--       o que desfaz o efeito SQL atômico (status da campanha + recibo na mesma transação);
--     - lápide (abandoned_at) é imutável e só nasce pela função abaixo;
--  4) public.shrigma_campaign_abandon(jsonb): grava a lápide sob o MESMO advisory lock
--     do claim e o MESMO FOR UPDATE da linha usado pelo provider.
--
-- Atestação (comentário no corpo NÃO conta como prova): cada função de que a lápide
-- depende precisa bater EXATAMENTE com a versão revisada — md5 do corpo (prosrc), dono
-- postgres, SECURITY INVOKER/DEFINER, volatilidade, linguagem, retorno, proconfig
-- (search_path/lock_timeout) e ACL. São os mesmos pins de crm-campaign-gateway-role.sql
-- (store/provider/recovery) e os corpos que esse arquivo instala (auth_v1/effect_v1,
-- conferidos se o gateway já estiver instalado). Qualquer diferença: RAISE, nada alterado.
--
-- Objetos próprios: ou nenhum existe (instalação limpa) ou TODOS existem exatamente como
-- este arquivo os cria (reinstalação = no-op, nada é recriado nem o gate é tocado).
-- Objeto homônimo alheio ou divergente (gatilho, função, coluna, CHECK, tabela) é
-- recusado com PENDING_RECOVERY_OBJECT_COLLISION; instalação parcial (ex.: gatilho
-- removido) com PENDING_RECOVERY_PARTIAL. Nunca sobrescreve objeto que não atestou.
-- Não altera o corpo de shrigma_campaign_store/provider/recovery nem do gateway e não
-- toca campanhas, contatos nem recibos existentes. Executar como postgres.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $install$
DECLARE
 op regclass:=to_regclass('public.shrigma_campaign_operation');
 cfg regclass;
 d record; r record;
 present integer; pass integer;
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'PENDING_RECOVERY_OWNER_REQUIRED'; END IF;
 IF op IS NULL THEN RAISE EXCEPTION 'PENDING_RECOVERY_DEPENDENCY_MISSING public.shrigma_campaign_operation'; END IF;
 -- Passo 1 confere tudo antes de qualquer DDL; passo 2 reconfere depois de instalar.
 FOR pass IN 1..2 LOOP
  -- Funções: dependências (dep obrigatórias; gateway se existir) e próprias (own).
  present:=0;
  FOR d IN SELECT * FROM (VALUES
    ('dep','public.shrigma_campaign_store(text,jsonb)','jsonb','b77d960aca32c2c93dfe15e82922d7ff',false,ARRAY['search_path=pg_catalog, public','lock_timeout=3s'],'postgres:EXECUTE'),
    ('dep','public.shrigma_campaign_provider(text,jsonb)','jsonb','ee8c16b6c37785dafd59c062330b2290',false,ARRAY['search_path=pg_catalog, public','lock_timeout=3s'],'postgres:EXECUTE'),
    ('dep','public.shrigma_campaign_recovery(text,jsonb)','jsonb','1e2c0a2bacd82f4dcf8d6797cbf1842c',false,ARRAY['search_path=pg_catalog, public','lock_timeout=3s'],'postgres:EXECUTE'),
    ('gateway','public.shrigma_crm_campaign_auth_v1(text)','jsonb','6195c421dedb3f63a0c933f5d90fddd9',true,ARRAY['search_path=pg_catalog, public'],'crm_campaign_api:EXECUTE,postgres:EXECUTE'),
    ('gateway','public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb)','jsonb','33ed94af3e5872454e4aa780780b9919',true,ARRAY['search_path=pg_catalog, public'],'crm_campaign_api:EXECUTE,postgres:EXECUTE'),
    ('own','public.shrigma_campaign_operation_fence()','trigger','5b15a30623151649574bb4b9de1453c8',false,ARRAY['search_path=pg_catalog, public'],'postgres:EXECUTE'),
    ('own','public.shrigma_campaign_abandon(jsonb)','jsonb','72bd1f5ec9aba153f1bbc0b5848fb362',false,ARRAY['search_path=pg_catalog, public','lock_timeout=3s'],'postgres:EXECUTE')
   ) v(kind,sig,ret,body_md5,definer,config,acl)
  LOOP
   SELECT p.proowner::regrole::text AS owner,p.prosecdef,p.provolatile,p.prokind,l.lanname,p.prorettype::regtype::text AS ret,p.proconfig,md5(p.prosrc) AS body_md5,
    (SELECT string_agg(x.grantee::regrole::text||':'||x.privilege_type||CASE WHEN x.is_grantable THEN '*' ELSE '' END,',' ORDER BY x.grantee::regrole::text,x.privilege_type)
     FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x) AS acl
   INTO r FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure(d.sig);
   IF NOT FOUND THEN
    IF d.kind='dep' THEN RAISE EXCEPTION 'PENDING_RECOVERY_DEPENDENCY_MISSING %',d.sig; END IF;
    CONTINUE;
   END IF;
   IF (r.owner,r.prosecdef,r.provolatile,r.prokind,r.lanname,r.ret,r.proconfig,r.body_md5,r.acl)
    IS DISTINCT FROM ('postgres',d.definer,'v'::"char",'f'::"char",'plpgsql',d.ret,d.config,d.body_md5,d.acl) THEN
    IF d.kind='own' THEN RAISE EXCEPTION 'PENDING_RECOVERY_OBJECT_COLLISION %',d.sig; END IF;
    RAISE EXCEPTION 'PENDING_RECOVERY_DEPENDENCY_DRIFT %',d.sig;
   END IF;
   IF d.kind='own' THEN present:=present+1; END IF;
  END LOOP;
  -- Sobrecargas homônimas (outra assinatura) também são objetos alheios.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('shrigma_campaign_operation_fence','shrigma_campaign_abandon'))<>present THEN
   RAISE EXCEPTION 'PENDING_RECOVERY_OBJECT_COLLISION overload'; END IF;
  -- Colunas: timestamptz, anuláveis, sem default/identity/generated.
  FOR r IN SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS typ,a.attnotnull,a.atthasdef,a.attidentity,a.attgenerated
   FROM pg_attribute a WHERE a.attrelid=op AND a.attname IN ('lease_expires_at','abandoned_at') AND NOT a.attisdropped LOOP
   IF (r.typ,r.attnotnull,r.atthasdef,r.attidentity,r.attgenerated) IS DISTINCT FROM ('timestamp with time zone',false,false,''::"char",''::"char") THEN
    RAISE EXCEPTION 'PENDING_RECOVERY_OBJECT_COLLISION column %',r.attname; END IF;
   present:=present+1;
  END LOOP;
  -- CHECK da lápide.
  FOR r IN SELECT c.contype,c.convalidated,pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
   WHERE c.conrelid=op AND c.conname='shrigma_campaign_operation_abandon_check' LOOP
   IF (r.contype,r.convalidated,r.def) IS DISTINCT FROM ('c'::"char",true,
    $q$CHECK (((abandoned_at IS NULL) OR ((state = 'rejected'::text) AND (action = ANY (ARRAY['agendar'::text, 'cancelar'::text])))))$q$) THEN
    RAISE EXCEPTION 'PENDING_RECOVERY_OBJECT_COLLISION constraint shrigma_campaign_operation_abandon_check'; END IF;
   present:=present+1;
  END LOOP;
  -- Tabela de configuração: forma exata, dono postgres, sem grant a terceiros, sem gatilho/RLS.
  cfg:=to_regclass('public.shrigma_campaign_pending_recovery_config');
  IF cfg IS NOT NULL THEN
   IF (SELECT relkind<>'r' OR relowner::regrole::text<>'postgres' OR relrowsecurity FROM pg_class WHERE oid=cfg)
    OR (SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(ad.adbin,ad.adrelid),''),',' ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum WHERE a.attrelid=cfg AND a.attnum>0 AND NOT a.attisdropped)
     IS DISTINCT FROM 'id:boolean:true:true,enabled:boolean:true:false,lease_seconds:integer:true:900,updated_at:timestamp with time zone:true:clock_timestamp()'
    OR (SELECT string_agg(conname||'='||pg_get_constraintdef(oid),';' ORDER BY conname) FROM pg_constraint WHERE conrelid=cfg)
     IS DISTINCT FROM 'shrigma_campaign_pending_recovery_config_id_check=CHECK (id);shrigma_campaign_pending_recovery_config_lease_seconds_check=CHECK (((lease_seconds >= 300) AND (lease_seconds <= 3600)));shrigma_campaign_pending_recovery_config_pkey=PRIMARY KEY (id)'
    OR EXISTS(SELECT 1 FROM pg_class c,aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=cfg AND x.grantee<>c.relowner)
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=cfg AND NOT tgisinternal)
   THEN RAISE EXCEPTION 'PENDING_RECOVERY_OBJECT_COLLISION table shrigma_campaign_pending_recovery_config'; END IF;
   present:=present+1;
  END IF;
  -- Gatilho de cerca: identidade E corpo da função (conferido acima) exatamente os esperados.
  FOR r IN SELECT t.* FROM pg_trigger t WHERE t.tgrelid=op AND t.tgname='shrigma_campaign_operation_fence' LOOP
   IF r.tgisinternal OR r.tgfoid IS DISTINCT FROM to_regprocedure('public.shrigma_campaign_operation_fence()')::oid
    OR r.tgtype<>23 OR r.tgenabled<>'O' OR r.tgnargs<>0 OR r.tgattr::text<>'' OR r.tgqual IS NOT NULL OR r.tgconstraint<>0
    OR r.tgoldtable IS NOT NULL OR r.tgnewtable IS NOT NULL THEN
    RAISE EXCEPTION 'PENDING_RECOVERY_OBJECT_COLLISION trigger shrigma_campaign_operation_fence'; END IF;
   present:=present+1;
  END LOOP;

  IF pass=2 THEN
   IF present<>7 THEN RAISE EXCEPTION 'PENDING_RECOVERY_POSTCHECK %/7',present; END IF;
   EXIT;
  END IF;
  IF present=7 THEN RAISE NOTICE 'PENDING_RECOVERY_ALREADY_INSTALLED: nada alterado'; RETURN; END IF;
  IF present<>0 THEN RAISE EXCEPTION 'PENDING_RECOVERY_PARTIAL %/7',present; END IF;

  -- Instalação limpa (nenhum objeto próprio existia). CREATE sem OR REPLACE/IF NOT EXISTS:
  -- se algo aparecer entre a checagem e aqui, o CREATE falha e a transação inteira volta.
  EXECUTE $ddl$ALTER TABLE public.shrigma_campaign_operation ADD COLUMN lease_expires_at timestamptz, ADD COLUMN abandoned_at timestamptz,
   ADD CONSTRAINT shrigma_campaign_operation_abandon_check CHECK (abandoned_at IS NULL OR (state='rejected' AND action IN ('agendar','cancelar')))$ddl$;
  EXECUTE $ddl$CREATE TABLE public.shrigma_campaign_pending_recovery_config (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 enabled boolean NOT NULL DEFAULT false,
 lease_seconds integer NOT NULL DEFAULT 900 CHECK (lease_seconds BETWEEN 300 AND 3600),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
)$ddl$;
  EXECUTE $ddl$INSERT INTO public.shrigma_campaign_pending_recovery_config(id) VALUES(true)$ddl$;
  EXECUTE $ddl$REVOKE ALL ON public.shrigma_campaign_pending_recovery_config FROM PUBLIC$ddl$;
  EXECUTE $ddl$CREATE FUNCTION public.shrigma_campaign_operation_fence() RETURNS trigger
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
END $fn$$ddl$;
  EXECUTE $ddl$REVOKE ALL ON FUNCTION public.shrigma_campaign_operation_fence() FROM PUBLIC$ddl$;
  EXECUTE $ddl$CREATE TRIGGER shrigma_campaign_operation_fence BEFORE INSERT OR UPDATE ON public.shrigma_campaign_operation
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_operation_fence()$ddl$;
  -- Lápide terminal para (ator, chave). Recusas são exceções: nada é gravado.
  EXECUTE $ddl$CREATE FUNCTION public.shrigma_campaign_abandon(p jsonb) RETURNS jsonb
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
END $fn$$ddl$;
  EXECUTE $ddl$REVOKE ALL ON FUNCTION public.shrigma_campaign_abandon(jsonb) FROM PUBLIC$ddl$;
 END LOOP;
END $install$;
COMMIT;
