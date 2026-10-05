/* Regressões do instalador de recuperação de tentativas pendentes (revisão Codex #220).
   Compartilhado entre PGlite (claude-pending-recovery-install-postgres.cjs) e PostgreSQL
   nativo (claude-pending-recovery-install-pg16-postgres.cjs). Pré-condição: cadeia de
   campanha instalada (schema de teste + store + recovery + provider; no nativo também o
   gateway) e a recuperação AINDA NÃO instalada.
   Prova: o instalador recusa QUALQUER desvio antes de qualquer DDL (comentário não é
   prova), nunca sobrescreve objeto alheio, reinstalação exata é no-op, e o gate desligado
   mantém a cerca dos leases já emitidos (com o inventário do documento rodando). */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {hash}=require('../n8n/growth/campaign-service');
const ROOT=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
const INSTALL='n8n/growth/campaign-pending-recovery.sql',GATEWAY='n8n/growth/crm-campaign-abandon-gateway.sql';
const DOC='docs/crm/RECUPERACAO-TENTATIVAS-PENDENTES-20261003.md';
const NAMES=['shrigma_campaign_store','shrigma_campaign_provider','shrigma_campaign_recovery','shrigma_crm_campaign_auth_v1','shrigma_crm_campaign_effect_v1',
 'shrigma_campaign_abandon','shrigma_campaign_operation_fence','shrigma_crm_campaign_abandon_v1','pr_alien_trigger'];
const SNAPSHOT=`SELECT jsonb_build_object(
 'columns',(SELECT coalesce(jsonb_agg(attname||':'||format_type(atttypid,atttypmod) ORDER BY attname),'[]') FROM pg_attribute
   WHERE attrelid='public.shrigma_campaign_operation'::regclass AND attname IN ('lease_expires_at','abandoned_at') AND NOT attisdropped),
 'constraints',(SELECT coalesce(jsonb_agg(conname||'='||pg_get_constraintdef(oid) ORDER BY conname),'[]') FROM pg_constraint WHERE conrelid='public.shrigma_campaign_operation'::regclass),
 'config',(SELECT coalesce(jsonb_agg(row_to_json(c)),'[]') FROM (SELECT oid,xmin::text FROM pg_class WHERE oid=to_regclass('public.shrigma_campaign_pending_recovery_config')) c),
 'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('oid',t.oid,'name',t.tgname,'fn',t.tgfoid::regprocedure::text,'enabled',t.tgenabled,'type',t.tgtype,'fnmd5',md5(p.prosrc)) ORDER BY t.tgname),'[]')
   FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.shrigma_campaign_operation'::regclass AND NOT t.tgisinternal),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('sig',p.oid::regprocedure::text,'oid',p.oid,'xmin',p.xmin::text,'md5',md5(p.prosrc),'owner',p.proowner::regrole::text,
   'secdef',p.prosecdef,'volatile',p.provolatile,'config',p.proconfig,'acl',p.proacl::text) ORDER BY p.oid::regprocedure::text),'[]')
   FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1::text[]))) AS s`;
// Identidade lógica (sem oid/xmin): para comparar depois de desfazer uma alteração de teste.
const logical=s=>JSON.parse(JSON.stringify(s,(k,v)=>k==='oid'||k==='xmin'?undefined:v));

module.exports=async function installerCases(db,{native=false}={}){
 const exec=sql=>db.exec(sql),one=async(sql,params)=>(await db.query(sql,params)).rows[0];
 const snap=async()=>(await one(SNAPSHOT,[NAMES])).s;
 const install=async(file=INSTALL)=>{try{await exec(read(file));}catch(e){await exec('ROLLBACK').catch(()=>{});throw e;}};
 const refused=async(re,label,file=INSTALL)=>{const before=await snap();await assert.rejects(install(file),re,label);assert.deepEqual(await snap(),before,label+': nada alterado (nenhum DDL)');};
 await exec("DO $r$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pr_alien') THEN CREATE ROLE pr_alien NOLOGIN; END IF; END $r$");
 const base=await snap();
 assert.deepEqual([base.columns,base.config,base.triggers],[[],[],[]],'pré-condição: recuperação ainda não instalada');
 assert.equal(base.functions.filter(f=>/abandon|fence/.test(f.sig)).length,0);

 // 1) Contraprova do Codex: provider sem o recibo atômico de agendar, comentários preservados.
 const providerSql=read('n8n/growth/campaign-provider.sql');
 const fnStart=providerSql.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_provider('),fnEnd=providerSql.indexOf('END $fn$;',fnStart)+'END $fn$;'.length;
 const atomicSchedule=/(-- CAMPAIGN_ATOMIC_SCHEDULE_RECEIPT_V1:[\s\S]*?UPDATE public\.shrigma_campaign_operation SET provider_id=c\.id,)state='succeeded',\n\s*response=jsonb_build_object\([^\n]*\),updated_at/;
 assert.ok(fnStart>0&&atomicSchedule.test(providerSql.slice(fnStart,fnEnd)),'bloco do recibo atômico reconhecido');
 await exec(providerSql.slice(fnStart,fnEnd).replace(atomicSchedule,'$1updated_at'));
 const tampered=(await one("SELECT prosrc FROM pg_proc WHERE oid='public.shrigma_campaign_provider(text,jsonb)'::regprocedure")).prosrc;
 for(const marker of ['CAMPAIGN_ATOMIC_SCHEDULE_RECEIPT_V1','CAMPAIGN_ATOMIC_CANCEL_RECEIPT_V1',"op.state<>'pending'"])assert.ok(tampered.includes(marker),'comentário/marcador preservado: '+marker);
 await refused(/PENDING_RECOVERY_DEPENDENCY_DRIFT/,'provider sem recibo atômico de agendar (comentários preservados)');
 await exec(providerSql);
 assert.deepEqual(logical(await snap()),logical(base),'provider restaurado');

 // 2) Dependência com owner / SECURITY / volatilidade / search_path / ACL divergentes.
 const S='public.shrigma_campaign_store(text,jsonb)',P='public.shrigma_campaign_provider(text,jsonb)',R='public.shrigma_campaign_recovery(text,jsonb)';
 const variants=[
  ['owner',`ALTER FUNCTION ${S} OWNER TO pr_alien`,`ALTER FUNCTION ${S} OWNER TO postgres`],
  ['SECURITY DEFINER',`ALTER FUNCTION ${P} SECURITY DEFINER`,`ALTER FUNCTION ${P} SECURITY INVOKER`],
  ['volatilidade',`ALTER FUNCTION ${S} STABLE`,`ALTER FUNCTION ${S} VOLATILE`],
  ['search_path',`ALTER FUNCTION ${R} SET search_path=public`,`ALTER FUNCTION ${R} SET search_path=pg_catalog,public`],
  ['search_path removido',`ALTER FUNCTION ${P} RESET search_path`,null],
  ['ACL PUBLIC',`GRANT EXECUTE ON FUNCTION ${S} TO PUBLIC`,`REVOKE EXECUTE ON FUNCTION ${S} FROM PUBLIC`],
  ['ACL extra',`GRANT EXECUTE ON FUNCTION ${R} TO pr_alien`,`REVOKE EXECUTE ON FUNCTION ${R} FROM pr_alien`],
  ['dependência ausente',`ALTER FUNCTION ${R} RENAME TO shrigma_campaign_recovery_moved`,'ALTER FUNCTION public.shrigma_campaign_recovery_moved(text,jsonb) RENAME TO shrigma_campaign_recovery'],
 ];
 if(native)variants.push(
  ['gateway effect_v1 ACL PUBLIC','GRANT EXECUTE ON FUNCTION public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb) TO PUBLIC','REVOKE EXECUTE ON FUNCTION public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb) FROM PUBLIC'],
  ['gateway effect_v1 INVOKER','ALTER FUNCTION public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb) SECURITY INVOKER','ALTER FUNCTION public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb) SECURITY DEFINER'],
  ['gateway auth_v1 search_path','ALTER FUNCTION public.shrigma_crm_campaign_auth_v1(text) SET search_path=public','ALTER FUNCTION public.shrigma_crm_campaign_auth_v1(text) SET search_path=pg_catalog,public']);
 for(const [label,alter,revert] of variants){
  await exec(alter);
  await refused(/PENDING_RECOVERY_DEPENDENCY_(DRIFT|MISSING)/,label);
  if(revert)await exec(revert);else await exec(`ALTER FUNCTION ${P} SET search_path=pg_catalog,public`);
  if(label==='search_path removido'){// RESET muda a ordem do proconfig: recria como na migração original.
   await exec(`ALTER FUNCTION ${P} RESET lock_timeout`);await exec(`ALTER FUNCTION ${P} SET lock_timeout='3s'`);
  }
  assert.deepEqual(logical(await snap()),logical(base),label+': restaurado');
 }

 // 3) Trigger de mesmo nome alheio (e função homônima alheia): recusa, objeto alheio intacto.
 await exec("CREATE FUNCTION public.pr_alien_trigger() RETURNS trigger LANGUAGE plpgsql AS $a$BEGIN RETURN NEW; END$a$");
 await exec('CREATE TRIGGER shrigma_campaign_operation_fence BEFORE INSERT OR UPDATE ON public.shrigma_campaign_operation FOR EACH ROW EXECUTE FUNCTION public.pr_alien_trigger()');
 await refused(/PENDING_RECOVERY_OBJECT_COLLISION/,'trigger homônimo alheio');
 assert.equal((await snap()).triggers[0].fn,'pr_alien_trigger()','trigger alheio intacto');
 await exec('DROP TRIGGER shrigma_campaign_operation_fence ON public.shrigma_campaign_operation');
 await exec("CREATE FUNCTION public.shrigma_campaign_operation_fence() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $a$BEGIN RETURN NEW; END$a$");
 await exec('REVOKE ALL ON FUNCTION public.shrigma_campaign_operation_fence() FROM PUBLIC');
 await refused(/PENDING_RECOVERY_OBJECT_COLLISION/,'função de cerca homônima com outro corpo');
 await exec('DROP FUNCTION public.shrigma_campaign_operation_fence()');
 await exec('ALTER TABLE public.shrigma_campaign_operation ADD COLUMN lease_expires_at timestamptz');
 await refused(/PENDING_RECOVERY_PARTIAL/,'instalação parcial (só uma coluna)');
 await exec('ALTER TABLE public.shrigma_campaign_operation DROP COLUMN lease_expires_at');
 await exec('DROP FUNCTION public.pr_alien_trigger()');
 assert.deepEqual(logical(await snap()),logical(base),'objetos alheios de teste removidos');

 // 4) Instalação limpa; reinstalação exata é no-op (mesmos oid/xmin, gate preservado).
 await install();
 const installed=await snap();
 assert.equal(installed.triggers.length,1);assert.equal(installed.triggers[0].fn,'shrigma_campaign_operation_fence()');
 assert.deepEqual(installed.functions.filter(f=>NAMES.slice(0,5).some(n=>f.sig.startsWith(n+'('))).map(logical),base.functions.filter(f=>NAMES.slice(0,5).some(n=>f.sig.startsWith(n+'('))).map(logical),'dependências intactas');
 await exec('UPDATE public.shrigma_campaign_pending_recovery_config SET enabled=true');
 await install();
 assert.deepEqual(await snap(),installed,'reinstalação exata: nenhum objeto recriado');
 assert.equal((await one('SELECT enabled FROM public.shrigma_campaign_pending_recovery_config')).enabled,true,'reinstalação não mexe no gate');
 // Cerca desabilitada / trocada depois de instalada: reinstalação recusa e não "conserta" sozinha.
 await exec('ALTER TABLE public.shrigma_campaign_operation DISABLE TRIGGER shrigma_campaign_operation_fence');
 await refused(/PENDING_RECOVERY_OBJECT_COLLISION/,'cerca desabilitada');
 await exec('ALTER TABLE public.shrigma_campaign_operation ENABLE TRIGGER shrigma_campaign_operation_fence');
 await exec("CREATE FUNCTION public.pr_alien_trigger() RETURNS trigger LANGUAGE plpgsql AS $a$BEGIN RETURN NEW; END$a$");
 await exec('DROP TRIGGER shrigma_campaign_operation_fence ON public.shrigma_campaign_operation');
 await exec('CREATE TRIGGER shrigma_campaign_operation_fence BEFORE INSERT OR UPDATE ON public.shrigma_campaign_operation FOR EACH ROW EXECUTE FUNCTION public.pr_alien_trigger()');
 await refused(/PENDING_RECOVERY_OBJECT_COLLISION/,'trigger trocado por alheio depois da instalação');
 assert.equal((await snap()).triggers[0].fn,'pr_alien_trigger()','trigger alheio intacto');
 await exec('DROP TRIGGER shrigma_campaign_operation_fence ON public.shrigma_campaign_operation');await exec('DROP FUNCTION public.pr_alien_trigger()');
 await refused(/PENDING_RECOVERY_PARTIAL/,'cerca removida (parcial)');
 await exec('CREATE TRIGGER shrigma_campaign_operation_fence BEFORE INSERT OR UPDATE ON public.shrigma_campaign_operation FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_operation_fence()');
 await exec('ALTER FUNCTION public.shrigma_campaign_abandon(jsonb) SECURITY DEFINER');
 await refused(/PENDING_RECOVERY_OBJECT_COLLISION/,'função de encerrar com SECURITY divergente');
 await exec('ALTER FUNCTION public.shrigma_campaign_abandon(jsonb) SECURITY INVOKER');
 const again=await snap();await install();assert.deepEqual(await snap(),again,'reinstalação exata depois de restaurar');
 assert.deepEqual(logical(again),logical(installed));

 // 5) Wrapper do gateway (nativo): objeto alheio recusado; reinstalação exata no-op.
 if(native){
  await exec("CREATE FUNCTION public.shrigma_crm_campaign_abandon_v1(p_key text,p_command jsonb) RETURNS jsonb LANGUAGE sql AS $a$SELECT '{}'::jsonb$a$");
  await refused(/CRM_CAMPAIGN_ABANDON_OBJECT_COLLISION/,'wrapper homônimo alheio',GATEWAY);
  assert.equal((await one("SELECT md5(prosrc) m FROM pg_proc WHERE oid='public.shrigma_crm_campaign_abandon_v1(text,jsonb)'::regprocedure")).m,(await one("SELECT md5($1) m",["SELECT '{}'::jsonb"])).m,'wrapper alheio intacto');
  await exec('DROP FUNCTION public.shrigma_crm_campaign_abandon_v1(text,jsonb)');
  await exec('ALTER FUNCTION public.shrigma_campaign_abandon(jsonb) SET search_path=public');
  await refused(/CRM_CAMPAIGN_ABANDON_DEPENDENCY_DRIFT/,'função interna divergente',GATEWAY);
  await exec('ALTER FUNCTION public.shrigma_campaign_abandon(jsonb) SET search_path=pg_catalog,public');
  await install(GATEWAY);const gw=await snap();await install(GATEWAY);assert.deepEqual(await snap(),gw,'wrapper: reinstalação exata no-op');
  await exec('GRANT EXECUTE ON FUNCTION public.shrigma_crm_campaign_abandon_v1(text,jsonb) TO PUBLIC');
  await refused(/CRM_CAMPAIGN_ABANDON_OBJECT_COLLISION/,'wrapper com ACL divergente',GATEWAY);
  await exec('REVOKE EXECUTE ON FUNCTION public.shrigma_crm_campaign_abandon_v1(text,jsonb) FROM PUBLIC');
  await install(GATEWAY);
  await exec('ALTER FUNCTION public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb) OWNER TO pr_alien');
  await refused(/CRM_CAMPAIGN_ABANDON_DEPENDENCY_DRIFT/,'gateway effect_v1 com owner divergente',GATEWAY);
  await refused(/PENDING_RECOVERY_DEPENDENCY_DRIFT/,'gateway effect_v1 com owner divergente (recuperação)');
  await exec('ALTER FUNCTION public.shrigma_crm_campaign_effect_v1(text,jsonb,jsonb) OWNER TO postgres');
  await install(GATEWAY);await install();
 }

 // 6) Gate desligado com lease já emitido: a cerca continua; não é reversão completa.
 //    O inventário do documento (antes de qualquer rollback) enxerga a operação.
 const doc=read(DOC),at=doc.indexOf('## Inventário antes de qualquer reversão'),section=doc.slice(at,doc.indexOf('\n## ',at+3));
 const queries=[...section.matchAll(/```sql\n([\s\S]*?)```/g)].map(m=>m[1]);
 assert.ok(at>0&&queries.length===2,'documento traz o inventário de leases/lápides');
 const reversal=doc.slice(doc.indexOf('## Reversão'),at);
 assert.match(reversal,/não é reversão completa/i);assert.match(reversal,/nunca remova o gatilho/i);assert.match(reversal,/OPERATION_LEASE_EXPIRED/);
 await exec("UPDATE campaigns SET body='<p>Fixture</p>{{ UnsubscribeURL }}',altbody='Fixture {{ UnsubscribeURL }}' WHERE id=100");
 await exec(`INSERT INTO campaigns(id,name,subject,from_email,body,altbody,content_type,headers,status,tags,type,messenger,template_id,sent,attribs,send_at)
  SELECT 990,name,subject,from_email,body,altbody,content_type,headers,'draft',tags,type,messenger,template_id,0,attribs,NULL FROM campaigns WHERE id=100`);
 await exec("INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(990,3,'Fish')");
 await exec("UPDATE campaigns SET send_at=date_trunc('milliseconds',clock_timestamp()+interval '1 day') WHERE id=990");
 await exec("INSERT INTO crm_familia_campanha(marca,utm_campaign,familia) VALUES('fish','week','week') ON CONFLICT DO NOTHING");
 const review=(await one('SELECT fixture_audience_review(990) AS v')).v.audience.review_id;
 const c=(await one("SELECT shrigma_campaign_provider('get',$1::jsonb) AS r",[JSON.stringify({id:990})])).r;
 const req={acao:'campanha_agendar',brand:'fish',id:990,expected_version:c.version,confirm:'agendar',audience_review_id:review,idempotency_key:'gate-off-lease-key-01'};
 await exec('UPDATE public.shrigma_campaign_pending_recovery_config SET enabled=true');
 const op=(await one("SELECT shrigma_campaign_store('claim',$1::jsonb) AS r",[JSON.stringify({actor:'install-fixture',key:req.idempotency_key,hash:hash(req),brand:'fish',action:'agendar'})])).r;
 assert.ok((await one('SELECT lease_expires_at FROM shrigma_campaign_operation WHERE id=$1',[op.id])).lease_expires_at,'lease emitido com o gate ligado');
 await exec('UPDATE public.shrigma_campaign_pending_recovery_config SET enabled=false');
 const inventory=async()=>{const out=[];for(const q of queries)out.push((await db.query(q)).rows);return out;};
 let [rowsInv,summary]=await inventory();
 assert.equal(rowsInv.find(r=>r.operation_key===req.idempotency_key)?.situacao,'lease_ativo','inventário mostra o lease ainda ativo');
 assert.ok(summary.some(r=>r.situacao==='lease_ativo'&&Number(r.total)>=1));
 await exec(`UPDATE shrigma_campaign_operation SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='${op.id}'`);
 await assert.rejects(db.query("SELECT shrigma_campaign_provider('schedule',$1::jsonb)",[JSON.stringify({id:990,expectedVersion:c.version,operationId:op.id,audienceReviewId:review})]),/OPERATION_LEASE_EXPIRED/,'gate OFF: efeito tardio ainda recusado');
 await exec('ROLLBACK').catch(()=>{});
 assert.deepEqual((await one("SELECT shrigma_campaign_provider('get',$1::jsonb) AS r",[JSON.stringify({id:990})])).r,c,'campanha intacta');
 await assert.rejects(db.query('SELECT shrigma_campaign_abandon($1::jsonb)',[JSON.stringify({actor:'install-fixture',key:req.idempotency_key,brand:'fish',action:'agendar'})]),/ABANDON_DISABLED/,'gate OFF: sem lápide');
 assert.equal((await one('SELECT state FROM shrigma_campaign_operation WHERE id=$1',[op.id])).state,'pending','continua pending e cercado (conciliação)');
 [rowsInv]=await inventory();
 assert.equal(rowsInv.find(r=>r.operation_key===req.idempotency_key)?.situacao,'lease_vencido_cercado');
 const off=(await one("SELECT shrigma_campaign_store('claim',$1::jsonb) AS r",[JSON.stringify({actor:'install-fixture',key:'gate-off-new-key-0001',hash:'c'.repeat(64),brand:'fish',action:'agendar'})])).r;
 assert.equal((await one('SELECT lease_expires_at FROM shrigma_campaign_operation WHERE id=$1',[off.id])).lease_expires_at,null,'gate OFF: nenhum lease novo');
 return {cases:native?6:5};
};
