'use strict';
// Disposable SQL proof only. Imports do not open a DB, inspect environment,
// activate an issuer, register a test, read files or start transport.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createWriterPolicy,CAPS,SCHEMAS}=require('./writer-policy.cjs');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
let serial=0;const id=()=> (++serial).toString(16).padStart(8,'0')+'-1234-4234-8234-123456789abc';
const A=Object.freeze({issuerId:'c1111111-1234-4234-8234-123456789abc',namespaceId:'c2222222-1234-4234-8234-123456789abc',login:'crm_manager_fixture_a'});
const B=Object.freeze({issuerId:'d1111111-1234-4234-8234-123456789abc',namespaceId:'d2222222-1234-4234-8234-123456789abc',login:'crm_manager_fixture_b'});
const policy={area:'growth',slot:'growth-campaign',role:'manager',caps:[...CAPS],candidateTtlMs:600000,lifetimeMs:1209600000};
const PROFILE_SHA256='464d3cac6073dc6f3c42948203aa0d557d7396cefe1d8a5d0968c83896939311';
const OWNED=['issuer','subject','operation','generation'].map(s=>'crm_manager_writer_'+s+'_v1');
const FUNCTIONS=['canonical','error','apply','prepare','commit','revoke','status'].map(s=>'crm_manager_writer_'+s+'_v1');
function prepare(change={},issuer=A){return{schema:SCHEMAS.request,issuerId:issuer.issuerId,namespaceId:issuer.namespaceId,action:'prepare_writer',operationId:id(),userId:id(),lifecycleId:id(),owner:'manager@example.test',brand:'fish',principalId:'dcrmw-'+(++serial).toString(16).padStart(32,'0'),keySha256:sha('SYNTHETIC_WRITER_KEY_'+serial),generation:1,expectedGeneration:0,...policy,...change};}
const renew=(q,change={})=>prepare({action:'renew_writer',userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner,generation:q.generation+1,expectedGeneration:q.generation,...change});
const commit=(q,r,change={})=>({...q,action:'commit_writer',operationId:id(),prepareOperationId:q.operationId,issuedAt:r.issuedAt,candidateExpiresAt:r.candidateExpiresAt,expiresAt:r.expiresAt,...change});
const revoke=(q,change={})=>({schema:SCHEMAS.request,issuerId:q.issuerId,namespaceId:q.namespaceId,action:'revoke_writer',operationId:id(),userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner,...change});
const status=(q,change={})=>({schema:SCHEMAS.request,issuerId:q.issuerId,namespaceId:q.namespaceId,action:'writer_status',operationId:q.operationId,expectedRequestSha256:sha(canonical(q)),...change});
const method=q=>({prepare_writer:'prepare',renew_writer:'prepare',commit_writer:'commit',revoke_writer:'revoke',writer_status:'status'})[q.action];
const error=(body,code)=>{assert.equal(body.schema,'crm-manager-writer-error-v1');assert.equal(body.code,code);assert.equal(Object.hasOwn(body,'keySha256'),false);assert.equal(Object.hasOwn(body,'bearer'),false);return body;};
function profileQuery(rollback){const start=rollback.indexOf('WITH tables AS MATERIALIZED ('),end=rollback.indexOf('FROM records;',start);assert.ok(start>0&&end>start);return rollback.slice(start,end+'FROM records;'.length).replace(' AS profile_sha256 INTO profile_sha256 FROM records',' AS profile_sha256 FROM records');}
async function createWriterFixture(t,{Engine,readFixture,register=false}={}){
 assert.equal(typeof Engine,'function');assert.equal(typeof readFixture,'function');
 const f=await readFixture(t,{PGlite:Engine}),{db}=f;
 const source=fs.readFileSync(path.join(__dirname,'writer-provision-v1.sql'),'utf8'),rollback=fs.readFileSync(path.join(__dirname,'writer-empty-rollback-v1.sql'),'utf8');
 // Private fixtures alone create this known default ACL. Proposal never changes it.
 await db.exec('CREATE ROLE central_leitor NOLOGIN;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO central_leitor;');
 const baseline=async()=>({
  readObjects:(await db.query("SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,coalesce((SELECT jsonb_agg(jsonb_build_object('grantee',pg_get_userbyid(a.grantee),'privilege',a.privilege_type,'option',a.is_grantable) ORDER BY a.grantee,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a),'[]'::jsonb) AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'shrigma_crm_manager_%' ORDER BY c.relname")).rows,
  readFunctions:(await db.query("SELECT p.oid::regprocedure::text AS signature,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS source,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig,p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'shrigma_crm_manager_%' ORDER BY p.oid::regprocedure::text")).rows,
  authFunctions:(await db.query("SELECT p.oid::regprocedure::text AS signature,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS source,p.proacl::text AS acl,p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('shrigma_panel_operator_v1','shrigma_panel_identity_v1','shrigma_template_auth_v2') ORDER BY p.oid::regprocedure::text")).rows,
  schemaAcl:(await db.query("SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',pg_get_userbyid(a.grantee),'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'option',a.is_grantable) ORDER BY a.grantee,a.privilege_type),'[]'::jsonb) AS acl FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='public' AND pg_get_userbyid(a.grantee) NOT IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')")).rows,
  defaults:(await db.query('SELECT defaclrole::regrole::text,defaclnamespace::regnamespace::text,defaclobjtype,defaclacl::text FROM pg_default_acl ORDER BY defaclrole,defaclnamespace,defaclobjtype')).rows,
  legacyTriggers:(await db.query("SELECT c.conname,g.tgisinternal,g.tgenabled,g.tgtype,g.tgdeferrable,g.tginitdeferred,g.tgfoid::regprocedure::text AS fn FROM pg_trigger g LEFT JOIN pg_constraint c ON c.oid=g.tgconstraint WHERE g.tgrelid='public.crm_dash_chave'::regclass AND NOT EXISTS(SELECT 1 FROM pg_constraint z JOIN pg_class t ON t.oid=z.conrelid WHERE z.oid=g.tgconstraint AND t.relname LIKE 'crm_manager_writer_%') ORDER BY c.conname,g.tgtype")).rows,
  legacyData:(await db.query('SELECT * FROM public.crm_dash_chave WHERE chave=$1',[f.legacy])).rows,
  legacyPerms:(await db.query('SELECT * FROM public.shrigma_panel_permission_v1 WHERE principal_id=$1 ORDER BY area',[f.legacy])).rows,
  legacyAcl:(await db.query("SELECT c.relname,coalesce(jsonb_agg(jsonb_build_object('grantee',pg_get_userbyid(a.grantee),'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'option',a.is_grantable) ORDER BY a.grantee,a.privilege_type),'[]'::jsonb) AS acl FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass) AND pg_get_userbyid(a.grantee) NOT IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1') GROUP BY c.relname ORDER BY c.relname")).rows,
  legacyColumns:(await db.query("SELECT c.relname,att.attname,coalesce(jsonb_agg(jsonb_build_object('grantee',pg_get_userbyid(a.grantee),'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'option',a.is_grantable) ORDER BY a.grantee,a.privilege_type) FILTER (WHERE a.grantee IS NOT NULL AND pg_get_userbyid(a.grantee) NOT IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')),'[]'::jsonb) AS acl FROM pg_class c JOIN pg_attribute att ON att.attrelid=c.oid LEFT JOIN LATERAL aclexplode(att.attacl) a ON true WHERE c.oid IN ('public.crm_dash_chave'::regclass,'public.shrigma_panel_permission_v1'::regclass) AND att.attnum>0 AND NOT att.attisdropped GROUP BY c.relname,att.attname ORDER BY c.relname,att.attname")).rows
 });
 const before=await baseline();
 await db.exec(source);
 const call=async(q,issuer=A,forced=method(q))=>{assert.match(issuer.login,/^crm_manager_fixture_[ab]$|^crm_manager_writer_service_v1$/);assert.ok(['prepare','commit','revoke','status'].includes(forced));await db.exec('SET SESSION AUTHORIZATION '+issuer.login);try{return(await db.query('SELECT public.crm_manager_writer_'+forced+'_v1($1::jsonb) AS body',[canonical(q)])).rows[0].body;}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}};
 if(register)for(const x of[A,B])await db.query('INSERT INTO public.crm_manager_writer_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains,active) VALUES($1,$2,$3,ARRAY[$4],true)',[x.issuerId,x.namespaceId,x.login,'example.test']);
 if(register)await db.exec('GRANT EXECUTE ON FUNCTION public.crm_manager_writer_prepare_v1(jsonb),public.crm_manager_writer_commit_v1(jsonb),public.crm_manager_writer_revoke_v1(jsonb),public.crm_manager_writer_status_v1(jsonb) TO crm_manager_fixture_a,crm_manager_fixture_b');
 const key=async q=>(await db.query('SELECT * FROM public.crm_dash_chave WHERE chave=$1',[q.principalId])).rows[0];
 const permissions=async q=>(await db.query('SELECT area,caps FROM public.shrigma_panel_permission_v1 WHERE principal_id=$1 ORDER BY area',[q.principalId])).rows;
 const age=async q=>{await db.query('UPDATE public.crm_manager_writer_generation_v1 SET issued_at_ms=issued_at_ms-660000,candidate_expires_at_ms=candidate_expires_at_ms-660000,expires_at_ms=expires_at_ms-660000 WHERE namespace_id=$1 AND prepare_operation_id=$2',[q.namespaceId,q.operationId]);await db.query('UPDATE public.crm_dash_chave c SET expira_em=to_timestamp(g.candidate_expires_at_ms/1000.0) FROM public.crm_manager_writer_generation_v1 g WHERE g.namespace_id=$1 AND g.prepare_operation_id=$2 AND c.chave=g.principal_id',[q.namespaceId,q.operationId]);};
 const unchanged=async()=>{await f.unchanged();assert.deepEqual(await baseline(),before);};
 return{...f,source,rollback,call,key,permissions,age,unchanged,baseline,before,profile:async()=>{await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL search_path=pg_catalog;');try{return(await db.query(profileQuery(rollback))).rows[0].profile_sha256;}finally{await db.exec('ROLLBACK');}}};
}
async function proveWriter(t,options){
 const f=await createWriterFixture(t,{...options,register:true}),{db,call,key,permissions}=f;
 await t.test('new schema, NOLOGIN roles, narrow definer ownership and no direct service-table privilege',async()=>{
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_class WHERE relnamespace=\'public\'::regnamespace AND relname=ANY($1::text[])',[OWNED])).rows[0].n,4);
  const roles=(await db.query("SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1') ORDER BY rolname")).rows;assert.equal(roles.length,2);for(const r of roles)for(const k of ['rolcanlogin','rolsuper','rolcreatedb','rolcreaterole','rolinherit','rolreplication','rolbypassrls'])assert.equal(r[k],false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) AND proowner='crm_manager_writer_owner_v1'::regrole",[FUNCTIONS])).rows[0].n,7);
  const p=(await db.query("SELECT has_table_privilege('crm_manager_writer_service_v1','public.crm_dash_chave','SELECT') AS service_read,has_table_privilege('crm_manager_writer_owner_v1','public.crm_dash_chave','DELETE') AS owner_delete,has_column_privilege('crm_manager_writer_owner_v1','public.shrigma_panel_permission_v1','principal_id','UPDATE') AS owner_lock,has_column_privilege('crm_manager_writer_owner_v1','public.shrigma_panel_permission_v1','caps','UPDATE') AS caps_update,has_schema_privilege('crm_manager_writer_owner_v1','public','CREATE') AS owner_create")).rows[0];assert.deepEqual(p,{service_read:false,owner_delete:false,owner_lock:true,caps_update:false,owner_create:false});assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_trigger g JOIN pg_constraint c ON c.oid=g.tgconstraint WHERE g.tgrelid='public.crm_dash_chave'::regclass AND c.conrelid='public.crm_manager_writer_generation_v1'::regclass")).rows[0].n,2);await f.unchanged();
 });
 await t.test('writer policy binds exact SQL preparation/commit; operator accepts only bearer digest and fixed4caps',async()=>{
  const q=prepare(),p=createWriterPolicy({issuerId:A.issuerId,namespaceId:A.namespaceId,allowedEmailDomains:['example.test'],now:Date.now});
  const {schema,issuerId,namespaceId,action,generation,expectedGeneration,area,slot,role,caps,candidateTtlMs,lifetimeMs,...args}=q;
  const command=p.command('prepare_writer',args);assert.deepEqual(command,q);const prepared=p.receipt(await call(q),q),c=p.commit({operationId:id(),proof:prepared});assert.equal(p.receipt(await call(c),c).state,'committed');assert.deepEqual(await permissions(q),[{area:'growth',caps:[...CAPS]}]);assert.equal((await key(q)).chave_hash,q.keySha256);assert.equal((await key(q)).chave_hash_curta,null);
  const bearer=sha('SYNTHETIC_IDENTITY_BEARER'),authQ=prepare({keySha256:sha(bearer)}),authPrepared=await call(authQ);assert.equal((await key(authQ)).ativo,false);const auth=async(value,area='growth')=>(await db.query('SELECT public.shrigma_panel_operator_v1($1,$2) AS body',[value,area])).rows[0].body;assert.equal(await auth(bearer),null);await call(commit(authQ,authPrepared));assert.deepEqual(await auth(bearer),{who:'panel:'+authQ.principalId,label:authQ.owner,caps:[...CAPS]});assert.equal(await auth(authQ.principalId),null);assert.equal(await auth(bearer,'influs'),null);await f.unchanged();
 });
 await t.test('read actions/schema/slots/caps/principal/namespace and payload edits fail before any ledger/key write',async()=>{
  const q=prepare(),n=(await db.query('SELECT count(*)::int AS n FROM public.crm_manager_writer_operation_v1')).rows[0].n;
  for(const change of[{schema:'crm-manager-provision-request-v1'},{action:'prepare_read'},{principalId:'dcrm-'+'a'.repeat(32)},{slot:'crm-panel-read'},{caps:['read_content','list_history','submission']},{caps:[...CAPS,'all']},{namespaceId:'a2222222-1234-4234-8234-123456789abc'},{issuerId:B.issuerId},{role:'admin'},{area:'influs'},{candidateTtlMs:600001},{lifetimeMs:1209600001},{generation:2},{expectedGeneration:1},{keySha256:'RAW_SYNTHETIC_BEARER'},{owner:'other@outside.test'},{authorization:'RAW_SYNTHETIC_HEADER'},{actor:'postgres'}])error(await call({...q,...change},A,'prepare'),'INPUT_INVALID');
  error(await call(q,B),'INPUT_INVALID');error(await call(q,A,'commit'),'INPUT_INVALID');assert.equal((await db.query('SELECT count(*)::int AS n FROM public.crm_manager_writer_operation_v1')).rows[0].n,n);assert.equal(await key(q),undefined);await f.unchanged();
 });
 await t.test('prepared writer stays inactive; activation tampering cannot bypass commit and expired/revoked candidates never authenticate',async()=>{
  const q=prepare(),r=await call(q);assert.equal((await key(q)).ativo,false);assert.equal((await key(q)).revogada_em,null);
  await db.query('UPDATE public.crm_dash_chave SET ativo=true WHERE chave=$1',[q.principalId]);error(await call(commit(q,r)),'CREDENTIAL_CONFLICT');await db.query('UPDATE public.crm_dash_chave SET ativo=false WHERE chave=$1',[q.principalId]);
  const e=prepare(),er=await call(e);await f.age(e);error(await call(commit(e,er)),'CANDIDATE_EXPIRED');assert.equal((await key(e)).ativo,false);await call(revoke(e));assert.equal((await key(e)).ativo,false);await f.unchanged();
 });
 await t.test('idempotent retries/status retain exact receipt; unknown status is read-only and changed hash conflicts',async()=>{
  const q=prepare(),r=await call(q);assert.deepEqual(await call(q),r);error(await call({...q,keySha256:sha('changed synthetic') }),'IDEMPOTENCY_CONFLICT');assert.deepEqual((await call(status(q))).receipt,r);error(await call(status(q,{expectedRequestSha256:'0'.repeat(64)})),'IDEMPOTENCY_CONFLICT');
  const other=prepare({},B),before=(await db.query('SELECT count(*)::int AS n FROM public.crm_manager_writer_operation_v1')).rows[0].n;assert.deepEqual(await call(status(other),B),{schema:SCHEMAS.status,issuerId:B.issuerId,namespaceId:B.namespaceId,operationId:other.operationId,found:false});assert.equal((await db.query('SELECT count(*)::int AS n FROM public.crm_manager_writer_operation_v1')).rows[0].n,before);
  const c=commit(q,r),rc=await call(c);assert.deepEqual(await call(c),rc);assert.deepEqual((await call(status(c))).receipt,rc);await f.unchanged();
 });
 await t.test('a lost preparationACK recovers only by exact STATUS on a fresh policy instance',async()=>{
  const q=prepare(),calls=[];calls.push(q.action);const stored=await call(q); // Deliberately discard the client ACK.
  const fresh=createWriterPolicy({issuerId:A.issuerId,namespaceId:A.namespaceId,allowedEmailDomains:['example.test'],now:Date.now});
  const s=fresh.statusRequest(q);calls.push(s.action);const recovered=fresh.status(await call(s),q,{requireFound:true});assert.deepEqual(recovered.receipt,stored);
  assert.deepEqual(calls,['prepare_writer','writer_status']);assert.equal(fresh.commit({operationId:id(),proof:recovered.receipt}).principalId,q.principalId);await f.unchanged();
 });
 await t.test('renewal CAS keeps old generation live until atomic commit and revokes only mapped writer predecessor',async()=>{
  const q=prepare(),r=await call(q);await call(commit(q,r));const next=renew(q),nr=await call(next);assert.equal((await key(q)).ativo,true);error(await call(renew(q)),'GENERATION_CONFLICT');const c=await call(commit(next,nr));assert.equal(c.revokedGeneration,1);assert.equal((await key(q)).ativo,false);assert.deepEqual(await permissions(q),[]);assert.equal((await key(next)).ativo,true);error(await call(renew(q)),'GENERATION_CONFLICT');await f.unchanged();
 });
 await t.test('expired candidate status recovers historical proof without extendingTTL; replay/late commit fail and replacement is distinct',async()=>{
  const q=prepare(),r=await call(q);await call(commit(q,r));const next=renew(q),nr=await call(next),late=commit(next,nr);await f.age(next);error(await call(next),'CANDIDATE_EXPIRED');error(await call(late),'CANDIDATE_EXPIRED');assert.deepEqual((await call(status(next))).receipt,nr);const replace=renew(q),rp=await call(replace);assert.equal(rp.generation,nr.generation);assert.notEqual(replace.principalId,next.principalId);assert.equal((await key(q)).ativo,true);assert.equal((await key(next)).ativo,false);await call(commit(replace,rp));assert.equal((await key(q)).ativo,false);assert.equal((await key(replace)).ativo,true);await f.unchanged();
 });
 await t.test('lifecycle tombstone blocks late prepared/commit/status; reinvite and READ records stay independent',async()=>{
  const read=options.createReadPrepare(),readPrepared=await f.callRead(read);await f.callRead(options.createReadCommit(read,readPrepared));const readKeyBefore=(await db.query('SELECT * FROM public.crm_dash_chave WHERE chave=$1',[read.principalId])).rows[0],readPermBefore=(await db.query('SELECT * FROM public.shrigma_panel_permission_v1 WHERE principal_id=$1',[read.principalId])).rows;
  const q=prepare(),r=await call(q);await call(commit(q,r));const next=renew(q),nr=await call(next),rev=revoke(q);assert.equal((await call(rev)).revokedCount,2);assert.deepEqual(await call(rev),await call(rev));for(const old of[q,next,commit(next,nr)])error(await call(old),'LIFECYCLE_REVOKED');for(const old of[q,next])error(await call(status(old)),'LIFECYCLE_REVOKED');
  const reinvite=prepare({userId:q.userId,lifecycleId:id()}),ri=await call(reinvite);await call(commit(reinvite,ri));await call(revoke(q));assert.equal((await key(reinvite)).ativo,true);assert.deepEqual((await db.query('SELECT * FROM public.crm_dash_chave WHERE chave=$1',[read.principalId])).rows[0],readKeyBefore);assert.deepEqual((await db.query('SELECT * FROM public.shrigma_panel_permission_v1 WHERE principal_id=$1',[read.principalId])).rows,readPermBefore);await f.unchanged();
 });
 await t.test('legacy digest collision cannot be adopted, unseen revoke absorbs late prepare, and privatehelpers/tableDDL denied',async()=>{
  const collision=prepare({keySha256:sha('synthetic-legacy-bearer')});error(await call(collision),'CREDENTIAL_CONFLICT');assert.equal(await key(collision),undefined);
  const q=prepare();assert.equal((await call(revoke(q))).allGenerationsRevoked,true);error(await call(q),'LIFECYCLE_REVOKED');assert.equal(await key(q),undefined);
  await db.exec('SET SESSION AUTHORIZATION crm_manager_fixture_a');try{await assert.rejects(db.query('SELECT * FROM public.crm_manager_writer_issuer_v1'),/permission denied/);await assert.rejects(db.query("SELECT public.crm_manager_writer_apply_v1($1,'prepare')",[canonical(prepare())]),/permission denied/);await assert.rejects(db.exec('CREATE TABLE public.should_not_exist(i int)'),/permission denied/);}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}
  error(await call(prepare(),{login:'crm_manager_writer_service_v1'},'prepare'),'ISSUER_DENIED');await f.unchanged();
 });
 await t.test('all7functions remain separate; existing READ RPC rejects writer commands and writer ledger excludes READ principals at table boundary',async()=>{
  const q=prepare();await db.exec('SET SESSION AUTHORIZATION crm_manager_fixture_a');try{assert.equal((await db.query('SELECT public.shrigma_crm_manager_prepare_v1($1::jsonb) AS body',[canonical(q)])).rows[0].body.code,'INPUT_INVALID');}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}
  const r=await call(q);await assert.rejects(db.query('UPDATE public.crm_manager_writer_generation_v1 SET principal_id=$1 WHERE namespace_id=$2 AND prepare_operation_id=$3',[f.legacy,q.namespaceId,q.operationId]),/check constraint/);assert.equal((await key(q)).ativo,false);assert.equal(r.state,'prepared');await f.unchanged();
 });
}
async function proveEmptyRollback(t,options){
 const f=await createWriterFixture(t,options);
 await t.test('exact empty NOLOGIN profile matches fixed fingerprint; RESTRICT rollback restores baseline metadata/data',async()=>{
  assert.equal(await f.profile(),PROFILE_SHA256);await f.db.exec(f.rollback);await f.unchanged();assert.deepEqual(await f.baseline(),f.before);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')")).rows[0].n,0);
 });
}
async function proveRollbackRefusals(t,options){
 const cases=[['issuer row',db=>db.query('INSERT INTO public.crm_manager_writer_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains) VALUES($1,$2,$3,ARRAY[$4])',[A.issuerId,A.namespaceId,A.login,'example.test'])],['LOGIN activated',db=>db.exec('ALTER ROLE crm_manager_writer_service_v1 LOGIN')],['unexpected dependency',db=>db.exec('CREATE VIEW public.writer_unexpected_dependency AS SELECT * FROM public.crm_manager_writer_issuer_v1')],['caps/body changed',db=>db.exec("ALTER FUNCTION public.crm_manager_writer_prepare_v1(jsonb) IMMUTABLE")]];
 for(const[label,change]of cases)await t.test('empty rollback refuses '+label+' without dropping objects',async()=>{const f=await createWriterFixture(t,options);await change(f.db);await assert.rejects(f.db.exec(f.rollback),/CRM_MANAGER_WRITER_EMPTY_ROLLBACK_REFUSED/);await f.db.exec('ROLLBACK');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM pg_class WHERE relnamespace=\'public\'::regnamespace AND relname=ANY($1::text[])',[OWNED])).rows[0].n,4);await f.unchanged();});
}
module.exports={createWriterFixture,proveWriter,proveEmptyRollback,proveRollbackRefusals,profileQuery,PROFILE_SHA256,prepare,renew,commit,revoke,status,canonical,A,B};
if(require.main===module){
 const test=require('node:test');
 const args=process.argv.slice(2);assert.equal(args.length,2,'two public local dependency paths are required');for(const name of args)assert.ok(path.isAbsolute(name));
 const R=require(args[0]),{PGlite:Engine}=require(args[1]);
 const readFixture=async(t,o)=>{const f=await R.createFixture(t,o);return{...f,callRead:f.call};};
 const options={Engine,readFixture,createReadPrepare:R.createPrepare,createReadCommit:R.createCommit};
 test('separate writer SQL runs only in disposable fixture',t=>proveWriter(t,options));
 test('empty inactive writer namespace rollback',t=>proveEmptyRollback(t,options));
 test('empty writer rollback refusal guards',t=>proveRollbackRefusals(t,options));
}
