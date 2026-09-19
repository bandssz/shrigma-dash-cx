-- Incremental receipt durability; never finalizes old pending operations.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $migration$
DECLARE body text;
BEGIN
 SELECT pg_get_functiondef('public.shrigma_campaign_provider(text,jsonb)'::regprocedure) INTO body;
 IF strpos(body,'  -- CAMPAIGN_ATOMIC_CANCEL_RECEIPT_V1: status and its durable receipt commit together.
  current_row:=public.shrigma_campaign_current(c.id);
  IF current_row->>''status'' IS DISTINCT FROM ''cancelled'' OR current_row->''sent'' IS DISTINCT FROM ''0''::jsonb
   OR current_row->''started_at'' IS DISTINCT FROM ''null''::jsonb OR (current_row->>''id'')::integer IS DISTINCT FROM c.id
   OR nullif(current_row->>''send_at'','''')::timestamptz IS DISTINCT FROM c.send_at THEN RAISE EXCEPTION ''CAMPAIGN_RECEIPT_MISMATCH''; END IF;
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,state=''succeeded'',
   response=jsonb_build_object(''status'',200,''body'',jsonb_build_object(''campaign'',current_row,''operation_id'',op.id)),updated_at=clock_timestamp() WHERE id=op.id;
  PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
  RETURN current_row;')>0 THEN NULL;
 ELSIF (length(body)-length(replace(body,'  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
  PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
  RETURN public.shrigma_campaign_current(c.id);','')))/length('  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
  PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
  RETURN public.shrigma_campaign_current(c.id);')=1 THEN body:=replace(body,'  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
  PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
  RETURN public.shrigma_campaign_current(c.id);','  -- CAMPAIGN_ATOMIC_CANCEL_RECEIPT_V1: status and its durable receipt commit together.
  current_row:=public.shrigma_campaign_current(c.id);
  IF current_row->>''status'' IS DISTINCT FROM ''cancelled'' OR current_row->''sent'' IS DISTINCT FROM ''0''::jsonb
   OR current_row->''started_at'' IS DISTINCT FROM ''null''::jsonb OR (current_row->>''id'')::integer IS DISTINCT FROM c.id
   OR nullif(current_row->>''send_at'','''')::timestamptz IS DISTINCT FROM c.send_at THEN RAISE EXCEPTION ''CAMPAIGN_RECEIPT_MISMATCH''; END IF;
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,state=''succeeded'',
   response=jsonb_build_object(''status'',200,''body'',jsonb_build_object(''campaign'',current_row,''operation_id'',op.id)),updated_at=clock_timestamp() WHERE id=op.id;
  PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
  RETURN current_row;');
 ELSE RAISE EXCEPTION 'ATOMIC_RECEIPT_PROVIDER_DRIFT_0'; END IF;
 IF strpos(body,' current_row:=public.shrigma_campaign_current(c.id);
 IF a=''schedule'' THEN
  -- CAMPAIGN_ATOMIC_SCHEDULE_RECEIPT_V1: losing the runtime''s final step cannot orphan a confirmed schedule.
  IF current_row->>''status'' IS DISTINCT FROM ''scheduled'' OR current_row->''sent'' IS DISTINCT FROM ''0''::jsonb
   OR current_row->''started_at'' IS DISTINCT FROM ''null''::jsonb OR (current_row->>''id'')::integer IS DISTINCT FROM c.id
   OR nullif(current_row->>''send_at'','''')::timestamptz IS DISTINCT FROM c.send_at THEN RAISE EXCEPTION ''CAMPAIGN_RECEIPT_MISMATCH''; END IF;
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,state=''succeeded'',
   response=jsonb_build_object(''status'',200,''body'',jsonb_build_object(''campaign'',current_row,''operation_id'',op.id)),updated_at=clock_timestamp() WHERE id=op.id;
 ELSE
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
 END IF;
 PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
 RETURN current_row;')>0 THEN NULL;
 ELSIF (length(body)-length(replace(body,' UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
 PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
 RETURN public.shrigma_campaign_current(c.id);','')))/length(' UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
 PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
 RETURN public.shrigma_campaign_current(c.id);')=1 THEN body:=replace(body,' UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
 PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
 RETURN public.shrigma_campaign_current(c.id);',' current_row:=public.shrigma_campaign_current(c.id);
 IF a=''schedule'' THEN
  -- CAMPAIGN_ATOMIC_SCHEDULE_RECEIPT_V1: losing the runtime''s final step cannot orphan a confirmed schedule.
  IF current_row->>''status'' IS DISTINCT FROM ''scheduled'' OR current_row->''sent'' IS DISTINCT FROM ''0''::jsonb
   OR current_row->''started_at'' IS DISTINCT FROM ''null''::jsonb OR (current_row->>''id'')::integer IS DISTINCT FROM c.id
   OR nullif(current_row->>''send_at'','''')::timestamptz IS DISTINCT FROM c.send_at THEN RAISE EXCEPTION ''CAMPAIGN_RECEIPT_MISMATCH''; END IF;
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,state=''succeeded'',
   response=jsonb_build_object(''status'',200,''body'',jsonb_build_object(''campaign'',current_row,''operation_id'',op.id)),updated_at=clock_timestamp() WHERE id=op.id;
 ELSE
  UPDATE public.shrigma_campaign_operation SET provider_id=c.id,updated_at=clock_timestamp() WHERE id=op.id;
 END IF;
 PERFORM set_config(''shrigma.campaign_writer'',coalesce(previous_writer,''''),true);
 RETURN current_row;');
 ELSE RAISE EXCEPTION 'ATOMIC_RECEIPT_PROVIDER_DRIFT_1'; END IF;
 EXECUTE body;
END $migration$;
COMMIT;
