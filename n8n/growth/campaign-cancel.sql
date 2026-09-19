-- Incremental cancellation support. Existing tables, operations and six guards stay intact.
-- The enclosing transaction is mandatory: drift or lock failure rolls everything back.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $migration$
DECLARE body text; expr text; old_expr text; new_expr text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO expr FROM pg_constraint
  WHERE conrelid='public.shrigma_campaign_operation'::regclass AND conname='shrigma_campaign_operation_action_check';
 old_expr:='CHECK ((action = ANY (ARRAY[''salvar''::text, ''validar''::text, ''agendar''::text])))';
 new_expr:='CHECK ((action = ANY (ARRAY[''salvar''::text, ''validar''::text, ''agendar''::text, ''cancelar''::text])))';
 IF expr=old_expr THEN
  ALTER TABLE public.shrigma_campaign_operation DROP CONSTRAINT shrigma_campaign_operation_action_check;
  ALTER TABLE public.shrigma_campaign_operation ADD CONSTRAINT shrigma_campaign_operation_action_check CHECK(action IN ('salvar','validar','agendar','cancelar'));
 ELSIF expr IS DISTINCT FROM new_expr THEN RAISE EXCEPTION 'CANCEL_ACTION_CONSTRAINT_DRIFT'; END IF;
 SELECT pg_get_functiondef('public.shrigma_campaign_store(text,jsonb)'::regprocedure) INTO body;
 IF strpos(body,'coalesce(p->>''action'','''') NOT IN (''salvar'',''validar'',''agendar'',''cancelar'')')>0 THEN NULL;
 ELSIF (length(body)-length(replace(body,'coalesce(p->>''action'','''') NOT IN (''salvar'',''validar'',''agendar'')','')))/length('coalesce(p->>''action'','''') NOT IN (''salvar'',''validar'',''agendar'')')=1 THEN body:=replace(body,'coalesce(p->>''action'','''') NOT IN (''salvar'',''validar'',''agendar'')','coalesce(p->>''action'','''') NOT IN (''salvar'',''validar'',''agendar'',''cancelar'')');
 ELSE RAISE EXCEPTION 'CANCEL_STORE_DRIFT'; END IF;
 EXECUTE body;
 SELECT pg_get_functiondef('public.shrigma_campaign_provider(text,jsonb)'::regprocedure) INTO body;
 IF strpos(body,'IF a NOT IN (''update'',''schedule'',''cancel'') THEN')>0 THEN NULL;
 ELSIF (length(body)-length(replace(body,'IF a NOT IN (''update'',''schedule'') THEN','')))/length('IF a NOT IN (''update'',''schedule'') THEN')=1 THEN body:=replace(body,'IF a NOT IN (''update'',''schedule'') THEN','IF a NOT IN (''update'',''schedule'',''cancel'') THEN');
 ELSE RAISE EXCEPTION 'CANCEL_PROVIDER_DRIFT_0'; END IF;
 IF strpos(body,'op.action<>(CASE WHEN a=''update'' THEN ''salvar'' WHEN a=''cancel'' THEN ''cancelar'' ELSE ''agendar'' END)')>0 THEN NULL;
 ELSIF (length(body)-length(replace(body,'op.action<>(CASE WHEN a=''update'' THEN ''salvar'' ELSE ''agendar'' END)','')))/length('op.action<>(CASE WHEN a=''update'' THEN ''salvar'' ELSE ''agendar'' END)')=1 THEN body:=replace(body,'op.action<>(CASE WHEN a=''update'' THEN ''salvar'' ELSE ''agendar'' END)','op.action<>(CASE WHEN a=''update'' THEN ''salvar'' WHEN a=''cancel'' THEN ''cancelar'' ELSE ''agendar'' END)');
 ELSE RAISE EXCEPTION 'CANCEL_PROVIDER_DRIFT_1'; END IF;
 IF strpos(body,'CAMPAIGN_ATOMIC_CANCEL_RECEIPT_V1')>0 AND strpos(body,'IF a=''cancel'' THEN')>0 THEN NULL;
 ELSIF strpos(body,' IF current_row->>''version'' IS DISTINCT FROM p->>''expectedVersion'' THEN RAISE EXCEPTION ''VERSION_CONFLICT''; END IF;
 IF a=''cancel'' THEN
  -- The row lock arbitrates cancellation against the native worker. Never cancel
  -- a due, started or partly delivered campaign through this future-schedule path.
  IF c.status::text<>''scheduled'' OR c.sent IS DISTINCT FROM 0 OR c.started_at IS NOT NULL
   OR c.send_at IS NULL OR c.send_at<=clock_timestamp() THEN RAISE EXCEPTION ''CAMPAIGN_LOCKED''; END IF;
  previous_writer:=current_setting(''shrigma.campaign_writer'',true);
  PERFORM set_config(''shrigma.campaign_writer'',c.id::text,true);
  UPDATE public.campaigns SET status=''cancelled'',updated_at=clock_timestamp() WHERE id=c.id;
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
  PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
  RETURN public.shrigma_campaign_current(c.id);
 END IF;
')>0 THEN NULL;
 ELSIF (length(body)-length(replace(body,' IF current_row->>''version'' IS DISTINCT FROM p->>''expectedVersion'' THEN RAISE EXCEPTION ''VERSION_CONFLICT''; END IF;
','')))/length(' IF current_row->>''version'' IS DISTINCT FROM p->>''expectedVersion'' THEN RAISE EXCEPTION ''VERSION_CONFLICT''; END IF;
')=1 THEN body:=replace(body,' IF current_row->>''version'' IS DISTINCT FROM p->>''expectedVersion'' THEN RAISE EXCEPTION ''VERSION_CONFLICT''; END IF;
',' IF current_row->>''version'' IS DISTINCT FROM p->>''expectedVersion'' THEN RAISE EXCEPTION ''VERSION_CONFLICT''; END IF;
 IF a=''cancel'' THEN
  -- The row lock arbitrates cancellation against the native worker. Never cancel
  -- a due, started or partly delivered campaign through this future-schedule path.
  IF c.status::text<>''scheduled'' OR c.sent IS DISTINCT FROM 0 OR c.started_at IS NOT NULL
   OR c.send_at IS NULL OR c.send_at<=clock_timestamp() THEN RAISE EXCEPTION ''CAMPAIGN_LOCKED''; END IF;
  previous_writer:=current_setting(''shrigma.campaign_writer'',true);
  PERFORM set_config(''shrigma.campaign_writer'',c.id::text,true);
  UPDATE public.campaigns SET status=''cancelled'',updated_at=clock_timestamp() WHERE id=c.id;
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
  PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
  RETURN public.shrigma_campaign_current(c.id);
 END IF;
');
 ELSE RAISE EXCEPTION 'CANCEL_PROVIDER_DRIFT_2'; END IF;
 EXECUTE body;
END $migration$;
COMMIT;
