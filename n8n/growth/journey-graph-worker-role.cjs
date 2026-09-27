'use strict';
// Installation fragment only. No connection, password, login, activation or role membership.
const ROLE='crm_graph_worker';
const GRAPH_READ=['control','cart_control_v1','journey','revision','entry','intent','operation','dispatch_receipt_v1','source_event_v1','source_observation_v1','source_batch_v1','message_release_v1','native_template_v1','cart_epoch_v1','cart_owner_v1','cart_delivery_v1','cart_permit_v1'];
const GRAPH_INSERT=['intent','transition','operation','dispatch_receipt_v1','source_event_v1','source_observation_v1','source_batch_v1','cart_delivery_v1','cart_permit_v1'];
const GRAPH_FUNCTIONS=[
 'source_capture_v1(text,uuid,timestamp with time zone,jsonb)','source_read_v1(text,uuid)','source_time_v1(text)','source_material_v1(jsonb,text)',
 'release_get_v1(text,uuid)','native_resolve_v1(text,uuid,text,text)','native_clone_check_v1(crm_graph_candidate.native_template_v1,integer)',
 'native_guard_check_v1()','native_content_v1(jsonb)','native_receipt_v1(crm_graph_candidate.native_template_v1)',
 'cart_maintenance_guard_v1()','cart_claim_v1(text,uuid,integer,jsonb,text)','cart_dispatch_v1(text,uuid)','cart_pin_v1(jsonb)','cart_url_v1(jsonb,text)','cart_owned_v1(jsonb)'
];
const PUBLIC_FUNCTIONS=['shrigma_email_claim_cart(jsonb)','shrigma_email_finish_cart(uuid,uuid,text,jsonb)','shrigma_flow_slot(text,text,text,text,text,text)','shrigma_flow_wait(text,text,text,numeric)','shrigma_flow_stage_enabled(text,text,text)','shrigma_email_recipient_key(text)','digest(bytea,text)'];
function buildWorkerRoleSql({sendLogSequence,recipientKeySha256}={}){
 if(!/^public\.[a-z][a-z0-9_]{0,62}$/.test(sendLogSequence||'')||! /^[a-f0-9]{64}$/.test(recipientKeySha256||''))throw Error('GRAPH_WORKER_ROLE_CONFIG');
 const tableList=a=>a.map(t=>'crm_graph_candidate.'+t).join(',');
 const policy={};const allow=(table,privilege,columns)=>{(policy[table]??={})[privilege]=columns;};
 for(const t of GRAPH_READ)allow('crm_graph_candidate.'+t,'SELECT',['*']);
 for(const t of GRAPH_INSERT)allow('crm_graph_candidate.'+t,'INSERT',['*']);
 allow('crm_maintenance_candidate.control','SELECT',['*']);
 for(const t of ['subscribers','subscriber_lists','templates','shrigma_flow_definition','shrigma_email_dispatch','shrigma_send_log'])allow('public.'+t,'SELECT',['*']);
 for(const [t,c] of Object.entries({lists:['id','tags'],shrigma_template_email_registry:['template_id'],shrigma_exposure_7d:['subscriber_id','marketing_7d']}))allow('public.'+t,'SELECT',c);
 for(const [t,c] of Object.entries({'crm_graph_candidate.entry':['state','version','next_due_at','stopped_reason','updated_at'],'crm_graph_candidate.source_observation_v1':['material_hash','observed_at'],'crm_graph_candidate.control':['singleton'],'crm_maintenance_candidate.control':['singleton'],'crm_graph_candidate.cart_control_v1':['brand'],'crm_graph_candidate.journey':['id'],'crm_graph_candidate.intent':['id'],'public.subscribers':['attribs','updated_at'],'public.subscriber_lists':['subscriber_id'],'public.shrigma_email_dispatch':['transport_state','outcome_at','accepted_at','send_log_id','error_code']}))allow(t,'UPDATE',c);
 allow('crm_graph_candidate.cart_permit_v1','DELETE',['*']);
 allow('public.shrigma_email_dispatch','INSERT',['dispatch_id','brand','flow','piece','dedupe_key','payload_sha256','account_id','region','configuration_set','recipient_key','recipient_key_version','is_test','transport_state','started_at','claim_token']);
 allow('public.shrigma_send_log','INSERT',['email','brand','kind','flow','channel','piece','template_id','ref','subscriber_id']);
 return `-- One-shot role fragment: caller owns the single installation transaction.
DO $role_preflight$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${ROLE}')
 OR to_regprocedure('crm_graph_candidate.worker_lock_guard_v1()') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.worker_subscriber_guard_v1()') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.worker_operation_guard_v1()') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.worker_dispatch_guard_v1()') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.worker_dispatch_link_v1()') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.worker_log_guard_v1()') IS NOT NULL
 OR to_regprocedure('crm_graph_candidate.worker_log_link_v1()') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN('graph_worker_lock_guard_v1','graph_worker_subscriber_guard_v1','graph_worker_operation_guard_v1','graph_worker_dispatch_guard_v1','graph_worker_dispatch_link_v1','graph_worker_log_guard_v1','graph_worker_log_link_v1'))
 THEN RAISE EXCEPTION 'GRAPH_WORKER_ROLE_COLLISION';END IF;
 IF to_regclass('${sendLogSequence}') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('${sendLogSequence}') AND relkind='S')
 OR NOT EXISTS(SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum JOIN pg_depend dep ON dep.classid='pg_attrdef'::regclass AND dep.objid=d.oid WHERE d.adrelid='public.shrigma_send_log'::regclass AND a.attname='id' AND dep.refobjid=to_regclass('${sendLogSequence}'))
 THEN RAISE EXCEPTION 'GRAPH_WORKER_ROLE_SEQUENCE';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.shrigma_email_recipient_key(text)') AND p.prosecdef
 AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')='${recipientKeySha256}')
 THEN RAISE EXCEPTION 'GRAPH_WORKER_ROLE_RECIPIENT_BOUNDARY';END IF;
END $role_preflight$;
CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
-- FOR SHARE/UPDATE needs UPDATE on a column, not permission to change the row.
-- These triggers affect only the executor identity; existing operator/legacy roles retain behavior.
CREATE FUNCTION crm_graph_candidate.worker_lock_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
 IF current_user='${ROLE}' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'GRAPH_WORKER_LOCK_ONLY';END IF;
 RETURN NEW;
END $guard$;
CREATE TRIGGER graph_worker_lock_guard_v1 BEFORE UPDATE ON crm_graph_candidate.control FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_lock_guard_v1();
CREATE TRIGGER graph_worker_lock_guard_v1 BEFORE UPDATE ON crm_graph_candidate.cart_control_v1 FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_lock_guard_v1();
CREATE TRIGGER graph_worker_lock_guard_v1 BEFORE UPDATE ON crm_graph_candidate.journey FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_lock_guard_v1();
CREATE TRIGGER graph_worker_lock_guard_v1 BEFORE UPDATE ON crm_maintenance_candidate.control FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_lock_guard_v1();
CREATE TRIGGER graph_worker_lock_guard_v1 BEFORE UPDATE ON public.subscriber_lists FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_lock_guard_v1();
-- finish_cart may append its original first-cart mark; it may not rewrite consent,
-- identity, material, another flow or an already persisted mark through attribs.
CREATE FUNCTION crm_graph_candidate.worker_subscriber_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
DECLARE b text;o jsonb;n jsonb;old_flow jsonb;new_flow jsonb;
BEGIN
 IF current_user<>'${ROLE}' THEN RETURN NEW;END IF;
 IF (to_jsonb(NEW)-ARRAY['attribs','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['attribs','updated_at'])
 OR (coalesce(NEW.attribs,'{}')-ARRAY['fish','aristo']) IS DISTINCT FROM (coalesce(OLD.attribs,'{}')-ARRAY['fish','aristo'])
 THEN RAISE EXCEPTION 'GRAPH_WORKER_SUBSCRIBER_SCOPE';END IF;
 FOREACH b IN ARRAY ARRAY['fish','aristo'] LOOP
  o:=OLD.attribs->b;n:=NEW.attribs->b;
  IF n IS NOT DISTINCT FROM o THEN CONTINUE;END IF;
  IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR jsonb_typeof(n) IS DISTINCT FROM 'object'
  OR (n-'flows') IS DISTINCT FROM (o-'flows') THEN RAISE EXCEPTION 'GRAPH_WORKER_SUBSCRIBER_SCOPE';END IF;
  old_flow:=coalesce(o->'flows','{}');new_flow:=n->'flows';
  IF jsonb_typeof(old_flow) IS DISTINCT FROM 'object' OR jsonb_typeof(new_flow) IS DISTINCT FROM 'object'
  OR (new_flow-'cart_t05_at') IS DISTINCT FROM (old_flow-'cart_t05_at')
  OR old_flow ? 'cart_t05_at' OR jsonb_typeof(new_flow->'cart_t05_at') IS DISTINCT FROM 'string'
  OR coalesce(new_flow->>'cart_t05_at','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
  THEN RAISE EXCEPTION 'GRAPH_WORKER_SUBSCRIBER_SCOPE';END IF;
  IF NOT EXISTS(SELECT 1 FROM crm_graph_candidate.cart_owner_v1 o JOIN crm_graph_candidate.cart_delivery_v1 l ON l.source_ref=o.source_ref AND l.brand=o.brand
   JOIN public.shrigma_email_dispatch d ON d.dispatch_id=l.dispatch_id AND d.brand=l.brand
   WHERE o.brand=b AND o.subscriber_id=NEW.id AND o.ref=(NEW.attribs->b->>'cart_abandoned_at')::timestamptz
   AND d.transport_state='in_flight' AND d.flow='carrinho' AND d.piece='carrinho-30min' AND d.is_test=false)
  THEN RAISE EXCEPTION 'GRAPH_WORKER_SUBSCRIBER_DISPATCH';END IF;
 END LOOP;
 RETURN NEW;
END $guard$;
CREATE TRIGGER graph_worker_subscriber_guard_v1 BEFORE UPDATE ON public.subscribers FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_subscriber_guard_v1();
CREATE FUNCTION crm_graph_candidate.worker_operation_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
 IF current_user='${ROLE}' AND (NEW.actor IS DISTINCT FROM 'worker:graph-cart-v1' OR NEW.action NOT IN('step','apply_dispatch'))
 THEN RAISE EXCEPTION 'GRAPH_WORKER_OPERATION_SCOPE';END IF;
 RETURN NEW;
END $guard$;
CREATE TRIGGER graph_worker_operation_guard_v1 BEFORE INSERT ON crm_graph_candidate.operation FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_operation_guard_v1();
-- INSERT occurs inside native claim before cart_delivery exists. Require its
-- ephemeral permit immediately, then the durable graph link at transaction end.
CREATE FUNCTION crm_graph_candidate.worker_dispatch_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
 IF current_user<>'${ROLE}' THEN RETURN NEW;END IF;
 IF NEW.brand NOT IN('fish','aristo') OR NEW.flow IS DISTINCT FROM 'carrinho' OR NEW.piece IS DISTINCT FROM 'carrinho-30min' OR NEW.is_test IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'GRAPH_WORKER_DISPATCH_SCOPE';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.transport_state IS DISTINCT FROM 'in_flight' OR NEW.claim_token IS NULL OR NEW.send_log_id IS NOT NULL OR NEW.outcome_at IS NOT NULL OR NEW.accepted_at IS NOT NULL OR NEW.error_code IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM crm_graph_candidate.cart_permit_v1 p JOIN crm_graph_candidate.intent i ON i.id=p.intent_id AND i.brand=p.brand
   JOIN crm_graph_candidate.cart_owner_v1 o ON o.entry_id=i.entry_id AND o.brand=i.brand
   WHERE p.brand=NEW.brand AND p.tx=txid_current() AND p.expires_at>clock_timestamp()
   AND NEW.dedupe_key=jsonb_build_array('email',to_char(o.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),o.subscriber_id,false)::text)
  THEN RAISE EXCEPTION 'GRAPH_WORKER_DISPATCH_PERMIT';END IF;
 ELSE
  IF OLD.transport_state IS DISTINCT FROM 'in_flight' OR NEW.transport_state NOT IN('accepted','rejected','outcome_unknown') OR NEW.outcome_at IS NULL
  OR (NEW.transport_state='accepted') IS DISTINCT FROM (NEW.accepted_at IS NOT NULL)
  OR (to_jsonb(NEW)-ARRAY['transport_state','outcome_at','accepted_at','send_log_id','error_code']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['transport_state','outcome_at','accepted_at','send_log_id','error_code'])
  OR NOT EXISTS(SELECT 1 FROM crm_graph_candidate.cart_delivery_v1 l JOIN crm_graph_candidate.cart_owner_v1 o ON o.source_ref=l.source_ref AND o.brand=l.brand
   WHERE l.dispatch_id=OLD.dispatch_id AND l.brand=OLD.brand AND OLD.dedupe_key=jsonb_build_array('email',to_char(o.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),o.subscriber_id,false)::text)
  THEN RAISE EXCEPTION 'GRAPH_WORKER_DISPATCH_TRANSITION';END IF;
  IF NEW.transport_state<>'accepted' AND NEW.send_log_id IS NOT NULL THEN RAISE EXCEPTION 'GRAPH_WORKER_DISPATCH_LOG';END IF;
  IF NEW.transport_state='accepted' AND NEW.send_log_id IS NULL AND NEW.error_code IS DISTINCT FROM 'LEGACY_LOG_CONFLICT_AFTER_ACCEPT' THEN RAISE EXCEPTION 'GRAPH_WORKER_DISPATCH_LOG';END IF;
  IF NEW.send_log_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.shrigma_send_log s JOIN crm_graph_candidate.cart_delivery_v1 l ON l.dispatch_id=NEW.dispatch_id
   JOIN crm_graph_candidate.cart_owner_v1 o ON o.source_ref=l.source_ref AND o.brand=l.brand
   JOIN crm_graph_candidate.cart_epoch_v1 ep ON ep.id=o.epoch_id
   JOIN crm_graph_candidate.native_template_v1 nt ON nt.id=ep.native_id
   WHERE s.id=NEW.send_log_id AND s.brand=NEW.brand AND s.flow='carrinho' AND s.piece='carrinho-30min' AND s.channel='email' AND s.kind='tx'
    AND s.subscriber_id=o.subscriber_id AND s.ref::timestamptz=o.ref AND s.template_id=nt.clone_template_id)
  THEN RAISE EXCEPTION 'GRAPH_WORKER_DISPATCH_LOG';END IF;
 END IF;
 RETURN NEW;
END $guard$;
CREATE TRIGGER graph_worker_dispatch_guard_v1 BEFORE INSERT OR UPDATE ON public.shrigma_email_dispatch FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_dispatch_guard_v1();
CREATE FUNCTION crm_graph_candidate.worker_dispatch_link_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
 IF current_user='${ROLE}' AND NOT EXISTS(SELECT 1 FROM crm_graph_candidate.cart_delivery_v1 l JOIN crm_graph_candidate.cart_owner_v1 o ON o.source_ref=l.source_ref AND o.brand=l.brand
  WHERE l.dispatch_id=NEW.dispatch_id AND l.brand=NEW.brand AND l.entry_id=o.entry_id
  AND NEW.dedupe_key=jsonb_build_array('email',to_char(o.ref AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),o.subscriber_id,false)::text)
 THEN RAISE EXCEPTION 'GRAPH_WORKER_DISPATCH_LINK';END IF;
 RETURN NULL;
END $guard$;
CREATE CONSTRAINT TRIGGER graph_worker_dispatch_link_v1 AFTER INSERT ON public.shrigma_email_dispatch DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_dispatch_link_v1();
CREATE FUNCTION crm_graph_candidate.worker_log_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
 IF current_user<>'${ROLE}' THEN RETURN NEW;END IF;
 IF NEW.brand NOT IN('fish','aristo') OR NEW.flow IS DISTINCT FROM 'carrinho' OR NEW.piece IS DISTINCT FROM 'carrinho-30min' OR NEW.channel IS DISTINCT FROM 'email' OR NEW.kind IS DISTINCT FROM 'tx'
 OR NOT EXISTS(SELECT 1 FROM crm_graph_candidate.cart_owner_v1 o JOIN crm_graph_candidate.cart_delivery_v1 l ON l.source_ref=o.source_ref AND l.brand=o.brand
  JOIN public.shrigma_email_dispatch d ON d.dispatch_id=l.dispatch_id AND d.brand=l.brand
  JOIN crm_graph_candidate.cart_epoch_v1 ep ON ep.id=o.epoch_id
  JOIN crm_graph_candidate.native_template_v1 nt ON nt.id=ep.native_id
  JOIN public.subscribers s ON s.id=o.subscriber_id
  WHERE o.brand=NEW.brand AND o.subscriber_id=NEW.subscriber_id AND o.ref=NEW.ref::timestamptz AND nt.clone_template_id=NEW.template_id
   AND lower(s.email)=lower(NEW.email) AND d.transport_state='in_flight' AND d.flow='carrinho' AND d.piece='carrinho-30min' AND d.is_test=false)
 THEN RAISE EXCEPTION 'GRAPH_WORKER_LOG_SCOPE';END IF;
 RETURN NEW;
END $guard$;
CREATE TRIGGER graph_worker_log_guard_v1 BEFORE INSERT ON public.shrigma_send_log FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_log_guard_v1();
CREATE FUNCTION crm_graph_candidate.worker_log_link_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $guard$
BEGIN
 IF current_user='${ROLE}' AND NOT EXISTS(SELECT 1 FROM public.shrigma_email_dispatch d JOIN crm_graph_candidate.cart_delivery_v1 l ON l.dispatch_id=d.dispatch_id AND l.brand=d.brand
  WHERE d.send_log_id=NEW.id AND d.brand=NEW.brand AND d.transport_state='accepted')
 THEN RAISE EXCEPTION 'GRAPH_WORKER_LOG_LINK';END IF;
 RETURN NULL;
END $guard$;
CREATE CONSTRAINT TRIGGER graph_worker_log_link_v1 AFTER INSERT ON public.shrigma_send_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_graph_candidate.worker_log_link_v1();
REVOKE ALL ON FUNCTION crm_graph_candidate.worker_lock_guard_v1(),crm_graph_candidate.worker_subscriber_guard_v1(),crm_graph_candidate.worker_operation_guard_v1(),crm_graph_candidate.worker_dispatch_guard_v1(),crm_graph_candidate.worker_dispatch_link_v1(),crm_graph_candidate.worker_log_guard_v1(),crm_graph_candidate.worker_log_link_v1() FROM PUBLIC;
GRANT USAGE ON SCHEMA public,crm_graph_candidate,crm_maintenance_candidate TO ${ROLE};
GRANT SELECT ON ${tableList(GRAPH_READ)},crm_maintenance_candidate.control TO ${ROLE};
GRANT INSERT ON ${tableList(GRAPH_INSERT)} TO ${ROLE};
GRANT UPDATE(state,version,next_due_at,stopped_reason,updated_at) ON crm_graph_candidate.entry TO ${ROLE};
GRANT UPDATE(material_hash,observed_at) ON crm_graph_candidate.source_observation_v1 TO ${ROLE};
GRANT DELETE ON crm_graph_candidate.cart_permit_v1 TO ${ROLE};
GRANT UPDATE(singleton) ON crm_graph_candidate.control,crm_maintenance_candidate.control TO ${ROLE};
GRANT UPDATE(brand) ON crm_graph_candidate.cart_control_v1 TO ${ROLE};
GRANT UPDATE(id) ON crm_graph_candidate.journey,crm_graph_candidate.intent TO ${ROLE};
GRANT SELECT ON public.subscribers,public.subscriber_lists,public.templates,public.shrigma_flow_definition,public.shrigma_email_dispatch,public.shrigma_send_log TO ${ROLE};
GRANT SELECT(id,tags) ON public.lists TO ${ROLE};
GRANT SELECT(template_id) ON public.shrigma_template_email_registry TO ${ROLE};
GRANT SELECT(subscriber_id,marketing_7d) ON public.shrigma_exposure_7d TO ${ROLE};
GRANT UPDATE(attribs,updated_at) ON public.subscribers TO ${ROLE};
GRANT UPDATE(subscriber_id) ON public.subscriber_lists TO ${ROLE};
GRANT INSERT(dispatch_id,brand,flow,piece,dedupe_key,payload_sha256,account_id,region,configuration_set,recipient_key,recipient_key_version,is_test,transport_state,started_at,claim_token) ON public.shrigma_email_dispatch TO ${ROLE};
GRANT UPDATE(transport_state,outcome_at,accepted_at,send_log_id,error_code) ON public.shrigma_email_dispatch TO ${ROLE};
GRANT INSERT(email,brand,kind,flow,channel,piece,template_id,ref,subscriber_id) ON public.shrigma_send_log TO ${ROLE};
GRANT USAGE ON SEQUENCE ${sendLogSequence} TO ${ROLE};
GRANT EXECUTE ON FUNCTION ${GRAPH_FUNCTIONS.map(f=>'crm_graph_candidate.'+f).join(',')},${PUBLIC_FUNCTIONS.map(f=>'public.'+f).join(',')} TO ${ROLE};
DO $role_verify$
DECLARE policy jsonb:='${JSON.stringify(policy)}'::jsonb;rel record;privilege text;allowed jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege('${ROLE}',n.oid,'CREATE'))
 OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname='${ROLE}') OR m.roleid=(SELECT oid FROM pg_roles WHERE rolname='${ROLE}'))
 THEN RAISE EXCEPTION 'GRAPH_WORKER_ROLE_INHERITED_PRIVILEGE';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='crm_graph_candidate'
 AND has_function_privilege('${ROLE}',p.oid,'EXECUTE') AND p.oid NOT IN (${GRAPH_FUNCTIONS.map(f=>"'crm_graph_candidate."+f+"'::regprocedure").join(',')}))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND p.prosecdef
 AND has_function_privilege('${ROLE}',p.oid,'EXECUTE') AND p.oid<>'public.shrigma_email_recipient_key(text)'::regprocedure)
 OR (to_regclass('public.shrigma_email_hmac_key') IS NOT NULL AND has_table_privilege('${ROLE}','public.shrigma_email_hmac_key','SELECT'))
 THEN RAISE EXCEPTION 'GRAPH_WORKER_ROLE_PUBLIC_ESCAPE';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='crm_maintenance_candidate' AND has_function_privilege('${ROLE}',p.oid,'EXECUTE'))
 THEN RAISE EXCEPTION 'GRAPH_WORKER_ROLE_PUBLIC_ESCAPE';END IF;
 -- Audit effective privileges, including PUBLIC/default ACLs. A narrow GRANT
 -- cannot negate an inherited wider grant; refuse that environment, never revoke shared access.
 FOR rel IN SELECT c.oid,n.nspname||'.'||c.relname name,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f','S') LOOP
  IF rel.relkind='S' THEN
   FOREACH privilege IN ARRAY ARRAY['USAGE','SELECT','UPDATE'] LOOP
    IF has_sequence_privilege('${ROLE}',rel.oid,privilege) AND NOT (rel.name='${sendLogSequence}' AND privilege='USAGE') THEN RAISE EXCEPTION 'GRAPH_WORKER_ROLE_EFFECTIVE_PRIVILEGE';END IF;
   END LOOP;
   CONTINUE;
  END IF;
  FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
   allowed:=coalesce(policy->rel.name->privilege,'[]'::jsonb);
   IF NOT allowed ? '*' AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=rel.oid AND a.attnum>0 AND NOT a.attisdropped
    AND has_column_privilege('${ROLE}',rel.oid,a.attnum,privilege) AND NOT allowed ? a.attname)
   THEN RAISE EXCEPTION 'GRAPH_WORKER_ROLE_EFFECTIVE_PRIVILEGE';END IF;
  END LOOP;
  FOREACH privilege IN ARRAY ARRAY['DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
   IF has_table_privilege('${ROLE}',rel.oid,privilege) AND NOT coalesce(policy->rel.name->privilege,'[]'::jsonb) ? '*'
   THEN RAISE EXCEPTION 'GRAPH_WORKER_ROLE_EFFECTIVE_PRIVILEGE';END IF;
  END LOOP;
 END LOOP;
END $role_verify$;`;
}
module.exports={ROLE,GRAPH_READ,GRAPH_INSERT,GRAPH_FUNCTIONS,PUBLIC_FUNCTIONS,buildWorkerRoleSql};
