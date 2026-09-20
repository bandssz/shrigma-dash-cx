-- B05 registry only: no assignment, campaign creation, transport or causal result.
-- Cutover migration: legacy direct DML is rejected after installation.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $shape$
DECLARE expected jsonb := '[{"table_name":"crm_teste","column_name":"teste_id","udt_name":"text","is_nullable":"NO","column_default":null},{"table_name":"crm_teste","column_name":"marca","udt_name":"text","is_nullable":"NO","column_default":null},{"table_name":"crm_teste","column_name":"canal","udt_name":"text","is_nullable":"NO","column_default":null},{"table_name":"crm_teste","column_name":"nome","udt_name":"text","is_nullable":"NO","column_default":null},{"table_name":"crm_teste","column_name":"hipotese","udt_name":"text","is_nullable":"NO","column_default":null},{"table_name":"crm_teste","column_name":"variavel","udt_name":"text","is_nullable":"NO","column_default":null},{"table_name":"crm_teste","column_name":"metrica_primaria","udt_name":"text","is_nullable":"NO","column_default":null},{"table_name":"crm_teste","column_name":"efeito_minimo","udt_name":"numeric","is_nullable":"YES","column_default":null},{"table_name":"crm_teste","column_name":"criado_em","udt_name":"timestamptz","is_nullable":"NO","column_default":"now()"},{"table_name":"crm_teste","column_name":"iniciado_em","udt_name":"timestamptz","is_nullable":"YES","column_default":null},{"table_name":"crm_teste","column_name":"encerrado_em","udt_name":"timestamptz","is_nullable":"YES","column_default":null},{"table_name":"crm_teste","column_name":"vencedor","udt_name":"text","is_nullable":"YES","column_default":null},{"table_name":"crm_teste","column_name":"conclusao","udt_name":"text","is_nullable":"YES","column_default":null},{"table_name":"crm_teste","column_name":"status","udt_name":"text","is_nullable":"NO","column_default":"''rascunho''::text"},{"table_name":"crm_teste_braco","column_name":"teste_id","udt_name":"text","is_nullable":"NO","column_default":null},{"table_name":"crm_teste_braco","column_name":"braco","udt_name":"text","is_nullable":"NO","column_default":null},{"table_name":"crm_teste_braco","column_name":"campanha_id","udt_name":"int4","is_nullable":"YES","column_default":null},{"table_name":"crm_teste_braco","column_name":"utm_term","udt_name":"text","is_nullable":"NO","column_default":null},{"table_name":"crm_teste_braco","column_name":"descricao","udt_name":"text","is_nullable":"YES","column_default":null}]'::jsonb; observed jsonb;
BEGIN
 SELECT jsonb_agg(jsonb_build_object('table_name',table_name,'column_name',column_name,'udt_name',udt_name,'is_nullable',is_nullable,'column_default',column_default) ORDER BY table_name,ordinal_position) INTO observed
 FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('crm_teste','crm_teste_braco') AND column_name<>'registry_version';
 IF observed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'AB_SCHEMA_DRIFT';END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_teste' AND column_name='registry_version' AND (udt_name<>'int8' OR is_nullable<>'NO' OR column_default IS DISTINCT FROM '0')) THEN RAISE EXCEPTION 'AB_VERSION_COLUMN_DRIFT';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.crm_teste'::regclass AND contype='p' AND convalidated AND pg_get_constraintdef(oid)='PRIMARY KEY (teste_id)')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.crm_teste_braco'::regclass AND contype='p' AND convalidated AND pg_get_constraintdef(oid)='PRIMARY KEY (teste_id, braco)')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.crm_teste_braco'::regclass AND contype='f' AND convalidated AND pg_get_constraintdef(oid)='FOREIGN KEY (teste_id) REFERENCES crm_teste(teste_id) ON DELETE CASCADE') THEN RAISE EXCEPTION 'AB_CONSTRAINT_DRIFT';END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN ('public.crm_teste'::regclass,'public.crm_teste_braco'::regclass) AND NOT tgisinternal AND tgname<>'crm_ab_registry_guard_v1') THEN RAISE EXCEPTION 'AB_TRIGGER_DRIFT';END IF;
 IF EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.crm_teste'::regclass,'public.crm_teste_braco'::regclass) AND relowner<>current_user::regrole) THEN RAISE EXCEPTION 'AB_INSTALLER_OWNER_REQUIRED';END IF;
 IF NOT has_table_privilege(current_user,'public.crm_teste','SELECT,INSERT,UPDATE,DELETE') OR NOT has_table_privilege(current_user,'public.crm_teste_braco','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'AB_INSTALLER_ACL_REQUIRED';END IF;
 IF to_regclass('public.crm_ab_operation_v1') IS NOT NULL AND obj_description(to_regclass('public.crm_ab_operation_v1'),'pg_class') IS DISTINCT FROM 'shrigma-ab-registry-v1' THEN RAISE EXCEPTION 'AB_LEDGER_DRIFT';END IF;
END $shape$;
ALTER TABLE public.crm_teste ADD COLUMN IF NOT EXISTS registry_version bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS public.crm_ab_operation_v1(
 operation_id uuid PRIMARY KEY,
 actor_sha256 text NOT NULL CHECK(actor_sha256 ~ '^[a-f0-9]{64}$'),
 action text NOT NULL CHECK(action IN ('criar','encerrar')),
 teste_id text NOT NULL,
 request_payload jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('running','completed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 response jsonb,
 CHECK(state<>'completed' OR (finished_at IS NOT NULL AND response IS NOT NULL))
);
DO $ledger_shape$
DECLARE columns_shape jsonb; constraints_shape jsonb;
BEGIN
 SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO columns_shape
 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.crm_ab_operation_v1'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF columns_shape IS DISTINCT FROM '[ ["operation_id","uuid",true,null], ["actor_sha256","text",true,null], ["action","text",true,null], ["teste_id","text",true,null], ["request_payload","jsonb",true,null], ["state","text",true,null], ["created_at","timestamp with time zone",true,"clock_timestamp()"], ["finished_at","timestamp with time zone",false,null], ["response","jsonb",false,null] ]'::jsonb THEN RAISE EXCEPTION 'AB_LEDGER_COLUMN_DRIFT';END IF;
 SELECT jsonb_agg(jsonb_build_object('contype',contype,'def',pg_get_constraintdef(oid)) ORDER BY contype,pg_get_constraintdef(oid)) INTO constraints_shape FROM pg_constraint WHERE conrelid='public.crm_ab_operation_v1'::regclass AND convalidated;
 IF constraints_shape IS DISTINCT FROM $constraints$[{"contype":"c","def":"CHECK (((state <> 'completed'::text) OR ((finished_at IS NOT NULL) AND (response IS NOT NULL))))"},{"contype":"c","def":"CHECK ((action = ANY (ARRAY['criar'::text, 'encerrar'::text])))"},{"contype":"c","def":"CHECK ((actor_sha256 ~ '^[a-f0-9]{64}$'::text))"},{"contype":"c","def":"CHECK ((state = ANY (ARRAY['running'::text, 'completed'::text])))"},{"contype":"p","def":"PRIMARY KEY (operation_id)"}]$constraints$::jsonb
 OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.crm_ab_operation_v1'::regclass AND NOT convalidated) THEN RAISE EXCEPTION 'AB_LEDGER_CONSTRAINT_DRIFT';END IF;
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.crm_ab_operation_v1'::regclass AND (c.relowner<>current_user::regrole OR c.relrowsecurity OR c.relforcerowsecurity))
 OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='public.crm_ab_operation_v1'::regclass AND a.grantee=0)
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.crm_ab_operation_v1'::regclass AND NOT tgisinternal) THEN RAISE EXCEPTION 'AB_LEDGER_ACCESS_DRIFT';END IF;
END $ledger_shape$;
COMMENT ON TABLE public.crm_ab_operation_v1 IS 'shrigma-ab-registry-v1';
REVOKE ALL ON public.crm_ab_operation_v1 FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.crm_ab_registry_record_v1(p_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
 SELECT CASE WHEN t.teste_id IS NULL THEN NULL ELSE jsonb_build_object('teste',to_jsonb(t),
 'bracos',COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.braco) FROM public.crm_teste_braco b WHERE b.teste_id=t.teste_id),'[]'::jsonb)) END
 FROM (SELECT p_id AS id) wanted LEFT JOIN public.crm_teste t ON t.teste_id=wanted.id
$f$;

CREATE OR REPLACE FUNCTION public.crm_ab_registry_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $f$
DECLARE op public.crm_ab_operation_v1%ROWTYPE; ident text; marker text; marker_id uuid;
BEGIN
 ident:=CASE WHEN TG_OP='DELETE' THEN OLD.teste_id ELSE NEW.teste_id END;
 marker:=current_setting('shrigma.ab_operation_v1',true);
 IF (marker ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') IS DISTINCT FROM true THEN RAISE EXCEPTION 'AB_REGISTRY_MANAGED_WRITE_REQUIRED';END IF;
 marker_id:=marker::uuid;
 SELECT * INTO op FROM public.crm_ab_operation_v1 WHERE operation_id=marker_id AND state='running' AND teste_id=ident;
 IF NOT FOUND OR TG_OP='DELETE' THEN RAISE EXCEPTION 'AB_REGISTRY_MANAGED_WRITE_REQUIRED';END IF;
 IF TG_TABLE_NAME='crm_teste' THEN
  IF TG_OP='INSERT' AND (op.action<>'criar' OR NEW.registry_version<>1 OR NEW.status<>'rodando' OR NEW.vencedor IS NOT NULL) THEN RAISE EXCEPTION 'AB_REGISTRY_CREATE_INVALID';END IF;
  IF TG_OP='UPDATE' AND (op.action<>'encerrar' OR NEW.teste_id<>OLD.teste_id OR OLD.status<>'rodando' OR NEW.status<>'inconclusivo' OR NEW.vencedor IS NOT NULL
   OR NEW.registry_version<>OLD.registry_version+1
   OR (to_jsonb(NEW)-ARRAY['registry_version','status','vencedor','conclusao','encerrado_em']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['registry_version','status','vencedor','conclusao','encerrado_em'])) THEN RAISE EXCEPTION 'AB_REGISTRY_CLOSE_INVALID';END IF;
 ELSE
  IF TG_OP<>'INSERT' OR op.action<>'criar' THEN RAISE EXCEPTION 'AB_REGISTRY_ARMS_IMMUTABLE';END IF;
 END IF;
 RETURN NEW;
END $f$;
DO $g$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['crm_teste','crm_teste_braco'] LOOP
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname='crm_ab_registry_guard_v1'
   AND (tgfoid<>'public.crm_ab_registry_guard_v1()'::regprocedure OR tgenabled<>'O' OR tgtype<>31 OR tgnargs<>0 OR tgqual IS NOT NULL)) THEN RAISE EXCEPTION 'AB_REGISTRY_GUARD_DRIFT';END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname='crm_ab_registry_guard_v1') THEN
   EXECUTE format('CREATE TRIGGER crm_ab_registry_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.crm_ab_registry_guard_v1()',tab);
  END IF;
 END LOOP;
END $g$;

CREATE OR REPLACE FUNCTION public.crm_ab_registry_v1(p_mode text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='5s' AS $f$
DECLARE actor text; id uuid; test_id text; v_action text; req jsonb; t jsonb; arms jsonb; arm jsonb; expected bigint;
 op public.crm_ab_operation_v1%ROWTYPE; current_row public.crm_teste%ROWTYPE;
 code text; result jsonb; record jsonb; http integer:=200; stamp timestamptz;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('write','operation','record','capabilities') OR jsonb_typeof(p) IS DISTINCT FROM 'object'
  OR jsonb_typeof(p->'actor_sha256') IS DISTINCT FROM 'string' OR p->>'actor_sha256' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'AB_INVALID_REQUEST';END IF;
 actor:=p->>'actor_sha256';
 IF p_mode='capabilities' THEN RETURN jsonb_build_object('status',200,'body',jsonb_build_object('contract','ab_registry_v1','write',true,'operation',true,'record',true,'causal_engine',false));END IF;
 test_id:=p->>'teste_id';
 IF jsonb_typeof(p->'teste_id') IS DISTINCT FROM 'string' OR length(test_id) NOT BETWEEN 1 AND 256 OR test_id<>btrim(test_id) THEN RAISE EXCEPTION 'AB_INVALID_IDENTITY';END IF;
 IF p_mode='record' THEN RETURN jsonb_build_object('status',200,'body',jsonb_build_object('contract','ab_registry_record_v1','teste_id',test_id,'record',public.crm_ab_registry_record_v1(test_id)));END IF;
 IF jsonb_typeof(p->'operation_id') IS DISTINCT FROM 'string' OR p->>'operation_id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(p->'action') IS DISTINCT FROM 'string' OR p->>'action' NOT IN ('criar','encerrar') THEN RAISE EXCEPTION 'AB_INVALID_IDENTITY';END IF;
 id:=(p->>'operation_id')::uuid;v_action:=p->>'action';
 IF p_mode='operation' THEN
  SELECT * INTO op FROM public.crm_ab_operation_v1 WHERE operation_id=id AND actor_sha256=actor AND teste_id=test_id AND crm_ab_operation_v1.action=v_action;
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('contract','ab_registry_operation_v1','operation',jsonb_build_object('operation_id',id,'actor_sha256',actor,'action',v_action,'teste_id',test_id,
   'state',CASE WHEN op.operation_id IS NULL THEN 'missing' ELSE op.state END,'request_payload',op.request_payload,'response',op.response,'created_at',op.created_at,'finished_at',op.finished_at)));
 END IF;
 req:=p->'request_payload';t:=req->'teste';arms:=req->'bracos';
 IF jsonb_typeof(req) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(req))<>4 OR NOT req ?& ARRAY['acao','expected_version','teste','bracos']
  OR req->>'acao' IS DISTINCT FROM v_action OR jsonb_typeof(req->'expected_version') IS DISTINCT FROM 'number' OR req->>'expected_version' !~ '^(0|[1-9][0-9]{0,14})$'
  OR jsonb_typeof(t) IS DISTINCT FROM 'object' OR t->>'teste_id' IS DISTINCT FROM test_id OR jsonb_typeof(t->'teste_id') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'AB_INVALID_PAYLOAD';END IF;
 expected:=(req->>'expected_version')::bigint;
 IF v_action='criar' THEN
  IF expected<>0 OR (SELECT count(*) FROM jsonb_object_keys(t))<>8 OR NOT t ?& ARRAY['teste_id','marca','canal','nome','hipotese','variavel','metrica_primaria','efeito_minimo']
   OR t->>'marca' NOT IN ('aristo','fish','olivas') OR t->>'canal' NOT IN ('email','whatsapp')
   OR jsonb_typeof(t->'marca') IS DISTINCT FROM 'string' OR jsonb_typeof(t->'canal') IS DISTINCT FROM 'string'
   OR EXISTS(SELECT 1 FROM jsonb_each(t) x WHERE x.key IN ('nome','hipotese','variavel','metrica_primaria') AND (jsonb_typeof(x.value)<>'string' OR length(btrim(x.value#>>'{}')) NOT BETWEEN 1 AND 4000))
   OR (t->'efeito_minimo'<>'null'::jsonb AND (jsonb_typeof(t->'efeito_minimo')<>'number' OR (t->>'efeito_minimo')::numeric<0 OR (t->>'efeito_minimo')::numeric>1000000))
   OR jsonb_typeof(arms) IS DISTINCT FROM 'array' OR jsonb_array_length(arms) NOT BETWEEN 2 AND 20 THEN RAISE EXCEPTION 'AB_INVALID_CREATE';END IF;
  FOR arm IN SELECT value FROM jsonb_array_elements(arms) LOOP
   IF jsonb_typeof(arm) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(arm))<>4 OR NOT arm ?& ARRAY['braco','campanha_id','utm_term','descricao']
    OR jsonb_typeof(arm->'braco') IS DISTINCT FROM 'string' OR length(btrim(arm->>'braco')) NOT BETWEEN 1 AND 64
    OR jsonb_typeof(arm->'utm_term') IS DISTINCT FROM 'string' OR length(arm->>'utm_term')>256
    OR (arm->'descricao'<>'null'::jsonb AND (jsonb_typeof(arm->'descricao')<>'string' OR length(arm->>'descricao')>4000))
    OR (arm->'campanha_id'<>'null'::jsonb AND (jsonb_typeof(arm->'campanha_id')<>'number' OR arm->>'campanha_id' !~ '^[1-9][0-9]{0,9}$' OR (arm->>'campanha_id')::numeric>2147483647)) THEN RAISE EXCEPTION 'AB_INVALID_ARM';END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x->>'braco') FROM jsonb_array_elements(arms) x)<>jsonb_array_length(arms) THEN RAISE EXCEPTION 'AB_DUPLICATE_ARM';END IF;
 ELSE
  IF (SELECT count(*) FROM jsonb_object_keys(t))<>4 OR NOT t ?& ARRAY['teste_id','status','vencedor','conclusao'] OR t->>'status' IS DISTINCT FROM 'inconclusivo'
   OR t->'vencedor' IS DISTINCT FROM 'null'::jsonb OR arms IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(t->'conclusao') IS DISTINCT FROM 'string' OR length(t->>'conclusao')>8000 THEN RAISE EXCEPTION 'AB_INVALID_CLOSE';END IF;
 END IF;
 -- Fixed operation-before-resource lock order. No external effect occurs between them.
 PERFORM pg_advisory_xact_lock(hashtextextended('ab-operation:'||id::text,0));
 SELECT * INTO op FROM public.crm_ab_operation_v1 WHERE operation_id=id FOR UPDATE;
 IF FOUND THEN
  IF op.actor_sha256<>actor OR op.request_payload IS DISTINCT FROM req OR op.action<>v_action OR op.teste_id<>test_id THEN RETURN jsonb_build_object('status',409,'body',jsonb_build_object('ok',false,'code','operation_identity_conflict','operation_id',id));END IF;
  IF op.state='completed' THEN RETURN op.response;END IF;
  RETURN jsonb_build_object('status',503,'body',jsonb_build_object('ok',false,'code','operation_uncertain','operation_id',id));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ab-record:'||test_id,0));
 INSERT INTO public.crm_ab_operation_v1(operation_id,actor_sha256,action,teste_id,request_payload,state) VALUES(id,actor,v_action,test_id,req,'running');
 SELECT * INTO current_row FROM public.crm_teste WHERE teste_id=test_id FOR UPDATE;
 IF v_action='criar' AND current_row.teste_id IS NOT NULL THEN code:='record_exists';
 ELSIF v_action='encerrar' AND current_row.teste_id IS NULL THEN code:='record_missing';
 ELSIF v_action='encerrar' AND current_row.registry_version<>expected THEN code:='version_conflict';
 ELSIF v_action='encerrar' AND current_row.status<>'rodando' THEN code:='record_not_running';END IF;
 IF code IS NULL THEN
  PERFORM set_config('shrigma.ab_operation_v1',id::text,true);
  IF v_action='criar' THEN
   INSERT INTO public.crm_teste(teste_id,marca,canal,nome,hipotese,variavel,metrica_primaria,efeito_minimo,iniciado_em,status,registry_version)
    VALUES(test_id,t->>'marca',t->>'canal',t->>'nome',t->>'hipotese',t->>'variavel',t->>'metrica_primaria',(t->>'efeito_minimo')::numeric,clock_timestamp(),'rodando',1);
   INSERT INTO public.crm_teste_braco(teste_id,braco,campanha_id,utm_term,descricao)
    SELECT test_id,x->>'braco',(x->>'campanha_id')::integer,x->>'utm_term',x->>'descricao' FROM jsonb_array_elements(arms) x;
  ELSE
   UPDATE public.crm_teste SET status='inconclusivo',vencedor=NULL,conclusao=t->>'conclusao',encerrado_em=clock_timestamp(),registry_version=registry_version+1 WHERE teste_id=test_id;
  END IF;
  PERFORM set_config('shrigma.ab_operation_v1','',true);
 ELSE http:=409;END IF;
 record:=public.crm_ab_registry_record_v1(test_id);stamp:=clock_timestamp();
 result:=jsonb_build_object('status',http,'body',jsonb_build_object('contract','ab_registry_v1','ok',code IS NULL,'code',COALESCE(code,'recorded'),'operation_id',id,'teste_id',test_id,'version',record#>'{teste,registry_version}','record',record,'gravado_em',stamp));
 UPDATE public.crm_ab_operation_v1 SET state='completed',finished_at=stamp,response=result WHERE operation_id=id;
 RETURN result;
END $f$;
REVOKE ALL ON FUNCTION public.crm_ab_registry_record_v1(text),public.crm_ab_registry_guard_v1(),public.crm_ab_registry_v1(text,jsonb) FROM PUBLIC;
COMMIT;
