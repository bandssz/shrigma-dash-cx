'use strict';
// Offline component proof. Exact SQL runs in disposable PGlite; no DB URL,
// production credentials, n8n, HTTP transport or deploy is used by this suite.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const loadPGlite=()=>require(require.main===module&&process.env.CAMPAIGN_PGLITE_MODULE||require.resolve('@electric-sql/pglite',{paths:[path.join(__dirname,'../services/crm-audience-sandbox')]})).PGlite;
const SQL=fs.readFileSync(path.join(__dirname,'../n8n/access/crm-manager-provision-v1.sql'),'utf8');
const OPERATOR_SQL=fs.readFileSync(path.join(__dirname,'../n8n/access/panel-operator.sql'),'utf8');
const CLIENT=require('../services/dashboard-operational/crm-manager-provisioning.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const epoch=value=>value instanceof Date?value.getTime():Date.parse(value);
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
let serial=0;
const id=()=> (++serial).toString(16).padStart(8,'0')+'-1234-4234-8234-123456789abc';
const principal=()=> 'dcrm-'+(++serial).toString(16).padStart(32,'0');
const A={issuerId:'a1111111-1234-4234-8234-123456789abc',namespaceId:'a2222222-1234-4234-8234-123456789abc',login:'crm_manager_fixture_a'};
const B={issuerId:'b1111111-1234-4234-8234-123456789abc',namespaceId:'b2222222-1234-4234-8234-123456789abc',login:'crm_manager_fixture_b'};
const policy={area:'growth',slot:'crm-panel-read',role:'manager',caps:['read_content','list_history','submission'],candidateTtlMs:600000,lifetimeMs:1209600000};
function prepare(overrides={},issuer=A){return {schema:CLIENT.REQUEST_SCHEMA,issuerId:issuer.issuerId,namespaceId:issuer.namespaceId,action:'prepare_read',operationId:id(),userId:id(),lifecycleId:id(),owner:'manager@example.test',principalId:principal(),keySha256:sha('synthetic-manager-bearer-'+serial),generation:1,expectedGeneration:0,...policy,...overrides};}
function renewal(p,overrides={}){return prepare({action:'renew_read',userId:p.userId,lifecycleId:p.lifecycleId,owner:p.owner,generation:p.generation+1,expectedGeneration:p.generation,...overrides});}
function commit(q,p,overrides={}){return {...q,action:'commit_read',operationId:id(),prepareOperationId:q.operationId,issuedAt:p.issuedAt,candidateExpiresAt:p.candidateExpiresAt,expiresAt:p.expiresAt,...overrides};}
function revoke(q,overrides={}){return {schema:CLIENT.REQUEST_SCHEMA,issuerId:q.issuerId,namespaceId:q.namespaceId,action:'revoke_read',operationId:id(),userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner,...overrides};}
function status(q,overrides={}){return {schema:CLIENT.REQUEST_SCHEMA,issuerId:q.issuerId,namespaceId:q.namespaceId,action:'status',operationId:q.operationId,expectedRequestSha256:sha(canonical(q)),...overrides};}
const rpcName=action=>({prepare_read:'prepare',renew_read:'prepare',commit_read:'commit',revoke_read:'revoke',status:'status'})[action];
async function fixture(t,{PGlite:Engine=loadPGlite()}={}){
 const db=new Engine();t.after(()=>db.close());await db.waitReady;
 await db.exec(`
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL CHECK(painel IN ('cx','growth','influs','organico','todos')),dono text NOT NULL,ativo boolean NOT NULL DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer NOT NULL DEFAULT 0,chave_hash text,chave_hash_curta text,expira_em timestamptz,criado_em timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX fixture_key_hash ON public.crm_dash_chave(chave_hash) WHERE chave_hash IS NOT NULL;
  CREATE UNIQUE INDEX fixture_short_hash ON public.crm_dash_chave(chave_hash_curta) WHERE chave_hash_curta IS NOT NULL;
  CREATE TABLE public.shrigma_panel_permission_v1(principal_id text NOT NULL REFERENCES public.crm_dash_chave(chave),area text NOT NULL CHECK(area IN ('growth','influs')),caps jsonb NOT NULL CHECK(jsonb_typeof(caps)='array'),PRIMARY KEY(principal_id,area));
  REVOKE ALL ON public.crm_dash_chave,public.shrigma_panel_permission_v1 FROM PUBLIC;
  CREATE ROLE crm_manager_fixture_a LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  CREATE ROLE crm_manager_fixture_b LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 `);
 // Synthetic fallback makes the existing operator SQL installable in this
 // empty database; it grants nobody and reads no real template credential.
 await db.exec("CREATE FUNCTION public.shrigma_template_auth_v2(text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::jsonb $$");
 await db.exec(OPERATOR_SQL);
 await db.exec(SQL); // Exact proposal, without replacement, helper emulation or guard removal.
 for(const issuer of [A,B])await db.query('INSERT INTO public.shrigma_crm_manager_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains,active) VALUES($1,$2,$3,ARRAY[$4],true)',[issuer.issuerId,issuer.namespaceId,issuer.login,'example.test']);
 await db.exec(`GRANT EXECUTE ON FUNCTION public.shrigma_crm_manager_prepare_v1(jsonb),public.shrigma_crm_manager_commit_v1(jsonb),public.shrigma_crm_manager_revoke_v1(jsonb),public.shrigma_crm_manager_status_v1(jsonb) TO crm_manager_fixture_a,crm_manager_fixture_b`);
 const legacy='dcrm-ffffffffffffffffffffffffffffffff';
 await db.query('INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash,chave_hash_curta) VALUES($1,$2,$3,$4,$5)',[legacy,'todos','legacy-admin@example.test',sha('synthetic-legacy-bearer'),sha('synthetic-legacy-short')]);
 await db.query('INSERT INTO public.shrigma_panel_permission_v1 VALUES($1,$2,$3::jsonb),($1,$4,$5::jsonb)',[legacy,'growth','["crm_campaign_write","crm_send"]','influs','["all"]']);
 const snapshot=async()=>({keys:(await db.query('SELECT * FROM public.crm_dash_chave WHERE chave=$1',[legacy])).rows,permissions:(await db.query('SELECT * FROM public.shrigma_panel_permission_v1 WHERE principal_id=$1 ORDER BY area',[legacy])).rows});
 const legacyBefore=await snapshot();
 const call=async(q,issuer=A,forcedRpc=rpcName(q.action))=>{
  assert.match(issuer.login,/^crm_manager_fixture_[ab]$/);assert.ok(['prepare','commit','revoke','status'].includes(forcedRpc));
  await db.exec('SET SESSION AUTHORIZATION '+issuer.login);
  // PGlite retains its most recent session_user after RESET; restore the
  // synthetic fixture administrator explicitly, never a production session.
  try{return (await db.query('SELECT public.shrigma_crm_manager_'+forcedRpc+'_v1($1::jsonb) AS body',[canonical(q)])).rows[0].body;}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}
 };
 const key=async q=>(await db.query('SELECT * FROM public.crm_dash_chave WHERE chave=$1',[q.principalId])).rows[0];
 const permissions=async q=>(await db.query('SELECT area,caps FROM public.shrigma_panel_permission_v1 WHERE principal_id=$1 ORDER BY area',[q.principalId])).rows;
 const age=async q=>{ // Synthetic fixture clock advance; no sleeping or production data.
  await db.query('UPDATE public.shrigma_crm_manager_generation_v1 SET issued_at_ms=issued_at_ms-660000,candidate_expires_at_ms=candidate_expires_at_ms-660000,expires_at_ms=expires_at_ms-660000 WHERE namespace_id=$1 AND prepare_operation_id=$2',[q.namespaceId,q.operationId]);
  await db.query('UPDATE public.crm_dash_chave c SET expira_em=to_timestamp(g.candidate_expires_at_ms/1000.0) FROM public.shrigma_crm_manager_generation_v1 g WHERE g.namespace_id=$1 AND g.prepare_operation_id=$2 AND c.chave=g.principal_id',[q.namespaceId,q.operationId]);
 };
 const unchanged=async()=>assert.deepEqual(await snapshot(),legacyBefore,'unmapped legacy admin and permissions remain byte/value identical');
 return {db,call,key,permissions,age,legacy,unchanged};
}
const error=(body,code,q)=>{assert.equal(body.schema,CLIENT.ERROR_SCHEMA);assert.equal(body.code,code);if(q){assert.equal(body.operationId,q.operationId);assert.equal(body.requestSha256,sha(canonical(q)));}return body;};
const receipt=(body,q,state)=>{assert.equal(body.schema,CLIENT.RECEIPT_SCHEMA);assert.equal(body.state,state);assert.equal(body.operationId,q.operationId);assert.equal(body.requestSha256,sha(canonical(q)));assert.ok(!Object.hasOwn(body,'keySha256'));return body;};

if(require.main===module)test('four CRM manager RPCs run only in disposable PostgreSQL fixture',async t=>{
 const f=await fixture(t),{db,call,key,permissions}=f;
 await t.test('canonical SHA-256 matches JS, prepares digest-only Growth read scope and commits exactly fourteen days',async()=>{
  const q=prepare(),p=receipt(await call(q),q,'prepared');
  const c=await key(q);assert.equal(c.chave_hash,q.keySha256);assert.equal(c.chave_hash_curta,null);assert.equal(c.painel,'growth');assert.equal(c.dono,q.owner);assert.equal(c.ativo,true);assert.equal(c.revogada_em,null);assert.equal(c.usos,0);assert.equal(epoch(c.expira_em),p.candidateExpiresAt);
  assert.deepEqual(await permissions(q),[{area:'growth',caps:policy.caps}]);assert.equal(p.candidateExpiresAt-p.issuedAt,600000);assert.equal(p.expiresAt-p.issuedAt,1209600000);
  const cmd=commit(q,p),committed=receipt(await call(cmd),cmd,'committed');assert.equal(committed.revokedGeneration,null);assert.equal(committed.expiresAt,p.expiresAt);assert.equal(epoch((await key(q)).expira_em),p.expiresAt);await f.unchanged();
 });
 await t.test('prepare/commit exact retries retain immutable receipts and never extend TTL; changed payload conflicts',async()=>{
  const q=prepare(),p=await call(q);assert.deepEqual(await call(q),p);
  const mismatch={...q,keySha256:sha('changed synthetic bearer')};error(await call(mismatch),'IDEMPOTENCY_CONFLICT',mismatch);
  const cmd=commit(q,p),c=await call(cmd);assert.deepEqual(await call(cmd),c);assert.equal(epoch((await key(q)).expira_em),p.expiresAt);
  const s=status(cmd);assert.deepEqual((await call(s)).receipt,c);assert.equal((await call(s)).found,true);
 });
 await t.test('ASCII corporate-email aliases match client normalization and canonical fingerprints',async()=>{
  for(const owner of ["o'reilly@example.test",'_.leading@example.test','ops+crm@example.test','local!#$%&*+/=?^_`{|}~-@example.test']){
   const q=prepare({owner}),p=receipt(await call(q),q,'prepared');assert.equal(p.owner,owner);await call(commit(q,p));
  }
 });
 await t.test('existing operator authenticates only the private bearer in Growth, rejects principal ID, Influs and revoked/expired key',async()=>{
  const bearer=sha('synthetic-operator-bearer'),q=prepare({keySha256:sha(bearer)}),p=await call(q);
  const auth=async(k,area='growth')=>(await db.query('SELECT public.shrigma_panel_operator_v1($1,$2) AS body',[k,area])).rows[0].body;
  assert.deepEqual(await auth(bearer),{who:'panel:'+q.principalId,label:q.owner,caps:policy.caps});assert.equal(await auth(q.principalId),null);assert.equal(await auth(bearer,'influs'),null);
  await call(commit(q,p));assert.deepEqual((await auth(bearer)).caps,policy.caps);await call(revoke(q));assert.equal(await auth(bearer),null);
  const expired=prepare({keySha256:sha(sha('synthetic-expired-bearer'))});await call(expired);await f.age(expired);assert.equal(await auth(sha('synthetic-expired-bearer')),null);await f.unchanged();
 });
 await t.test('closed schema rejects edits, foreign slots, raw keys, extra fields, invalid UUIDs and numeric digests without DML',async()=>{
  const q=prepare(),before=(await db.query('SELECT count(*)::int AS n FROM public.shrigma_crm_manager_operation_v1')).rows[0].n;
  for(const change of [{role:'editor'},{caps:['crm_campaign_write']},{area:'influs'},{slot:'crm-campaign'},{candidateTtlMs:600001},{lifetimeMs:1209600001},{generation:2},{expectedGeneration:1},{keySha256:'RAW_SYNTHETIC_BEARER_SENTINEL'},{keySha256:JSON.parse('1'.repeat(64))},{owner:'external@outside.test'},{owner:'Manager@example.test'},{userId:'not-a-uuid'},{issuerId:B.issuerId},{namespaceId:B.namespaceId},{authorization:'RAW_HEADER_SENTINEL'}]){
   const invalid={...q,...change};error(await call(invalid),'INPUT_INVALID',typeof invalid.keySha256==='number'?undefined:invalid);
  }
  error(await call(q,A,'commit'),'INPUT_INVALID',q);assert.equal((await db.query('SELECT count(*)::int AS n FROM public.shrigma_crm_manager_operation_v1')).rows[0].n,before);assert.equal(await key(q),undefined);
 });
 await t.test('legacy principal/hash collisions are refused atomically and never adopted',async()=>{
  const q=prepare({principalId:f.legacy});error(await call(q),'CREDENTIAL_CONFLICT',q);await f.unchanged();
  const hashCollision=prepare({keySha256:sha('synthetic-legacy-bearer')});error(await call(hashCollision),'CREDENTIAL_CONFLICT',hashCollision);assert.equal(await key(hashCollision),undefined);await f.unchanged();
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.shrigma_crm_manager_generation_v1 WHERE principal_id=$1',[f.legacy])).rows[0].n,0);
 });
 await t.test('status finds only exact operation fingerprint and namespace, preserves terminal errors and has no mutation',async()=>{
  const q=prepare(),p=await call(q),unknown=status(prepare());assert.deepEqual(await call(unknown),{schema:CLIENT.STATUS_SCHEMA,issuerId:A.issuerId,namespaceId:A.namespaceId,operationId:unknown.operationId,found:false});
  const good=status(q);assert.deepEqual((await call(good)).receipt,p);const bad=status(q,{expectedRequestSha256:'0'.repeat(64)});error(await call(bad),'IDEMPOTENCY_CONFLICT',bad);
  const other={...good,issuerId:B.issuerId,namespaceId:B.namespaceId};assert.equal((await call(other,B)).found,false);
  const collision=prepare({principalId:f.legacy});await call(collision);const failed=status(collision);error(await call(failed),'CREDENTIAL_CONFLICT',failed);
  const opBefore=(await db.query('SELECT count(*)::int AS n FROM public.shrigma_crm_manager_operation_v1')).rows[0].n;await call(good);await call(other,B);assert.equal((await db.query('SELECT count(*)::int AS n FROM public.shrigma_crm_manager_operation_v1')).rows[0].n,opBefore);
 });
 await t.test('renewal leaves predecessor live until atomic commit, and CAS prevents stale generation',async()=>{
  const q=prepare(),p=await call(q);await call(commit(q,p));const next=renewal(q),np=await call(next);assert.equal((await key(q)).ativo,true);assert.equal((await key(next)).ativo,true);
  const blocked=renewal(q);error(await call(blocked),'GENERATION_CONFLICT',blocked);assert.equal(await key(blocked),undefined);
  const ncmd=commit(next,np),nc=receipt(await call(ncmd),ncmd,'committed');assert.equal(nc.revokedGeneration,1);assert.equal((await key(q)).ativo,false);assert.ok((await key(q)).revogada_em);assert.deepEqual(await permissions(q),[]);assert.equal((await key(next)).ativo,true);
  const stale=renewal(q);error(await call(stale),'GENERATION_CONFLICT',stale);assert.equal(await key(stale),undefined);await f.unchanged();
 });
 await t.test('expired renewal is replaced at same next generation without revoking active predecessor or resurrecting old candidate',async()=>{
  const q=prepare(),p=await call(q);await call(commit(q,p));const n=renewal(q),np=await call(n),ncommit=commit(n,np),saved=(await db.query('SELECT response FROM public.shrigma_crm_manager_operation_v1 WHERE namespace_id=$1 AND operation_id=$2',[n.namespaceId,n.operationId])).rows[0].response;
  await f.age(n);error(await call(n),'CANDIDATE_EXPIRED',n);const replacement=renewal(q),rp=receipt(await call(replacement),replacement,'prepared');
  assert.equal((await key(q)).ativo,true);assert.deepEqual(await permissions(q),[{area:'growth',caps:policy.caps}]);assert.equal((await key(n)).ativo,false);assert.deepEqual(await permissions(n),[]);assert.equal((await key(replacement)).ativo,true);assert.equal(rp.generation,np.generation);
  error(await call(ncommit),'CANDIDATE_EXPIRED',ncommit);const ns=status(n),historical=await call(ns);assert.equal(historical.found,true);assert.deepEqual(historical.receipt,saved);
  assert.deepEqual((await db.query('SELECT response FROM public.shrigma_crm_manager_operation_v1 WHERE namespace_id=$1 AND operation_id=$2',[n.namespaceId,n.operationId])).rows[0].response,saved);
  await call(commit(replacement,rp));assert.equal((await key(replacement)).ativo,true);assert.equal((await key(q)).ativo,false);assert.equal((await key(n)).ativo,false);await f.unchanged();
 });
 await t.test('expired first candidate permits fresh generation one with separate operation/principal',async()=>{
  const q=prepare(),p=await call(q);await f.age(q);const fresh=prepare({userId:q.userId,lifecycleId:q.lifecycleId}),fp=await call(fresh);receipt(fp,fresh,'prepared');assert.equal(fp.generation,1);assert.notEqual(fresh.principalId,q.principalId);assert.equal((await key(q)).ativo,false);await call(commit(fresh,fp));assert.equal((await key(fresh)).ativo,true);error(await call(commit(q,p)),'CANDIDATE_EXPIRED');
 });
 await t.test('lost prepare ACK plus expired lease recovers historical status so journal can expire and retry',async()=>{
  const {DatabaseSync}=require('node:sqlite'),{createManagerJournal}=require('../services/dashboard-operational/crm-manager-journal.cjs'),{EventEmitter}=require('node:events');
  const local=new DatabaseSync(':memory:');try{
   local.exec('PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,role TEXT,state TEXT);CREATE TABLE grants(user_id TEXT,area TEXT,can_read INTEGER,can_edit INTEGER);CREATE TABLE upstream_credentials(user_id TEXT,slot TEXT,encrypted_key TEXT,key_digest TEXT,updated_at INTEGER,PRIMARY KEY(user_id,slot));');
   const seed=crypto.randomBytes(32);let clock=Date.now(),lost=true,knownReceipt,queries=0;
   const encrypt=value=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',seed,iv),out=Buffer.concat([c.update(value),c.final()]);return ['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),out.toString('base64url')].join('.');};
   const decrypt=value=>{const[,iv,tag,out]=value.split('.'),d=crypto.createDecipheriv('aes-256-gcm',seed,Buffer.from(iv,'base64url'));d.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([d.update(Buffer.from(out,'base64url')),d.final()]).toString();};
   const journal=createManagerJournal({db:local,issuerId:A.issuerId,namespaceId:A.namespaceId,encrypt,decrypt,digest:value=>crypto.createHmac('sha256',seed).update(value).digest('hex'),now:()=>clock});
   const userId=id();local.prepare('INSERT INTO users VALUES(?,?,?,?)').run(userId,'lostack@example.test','manager','invited');local.prepare('INSERT INTO grants VALUES(?,?,1,0)').run(userId,'growth');
   local.exec('BEGIN IMMEDIATE');journal.createLifecycle(userId);local.prepare("UPDATE users SET state='active' WHERE id=?").run(userId);const operationId=journal.activateLifecycle(userId).operationId;local.exec('COMMIT');
   const {generation,expectedGeneration,...args}=journal.beginPrepare(operationId),q=prepare({...args}),descriptor={action:'prepare_read',args};
   const requestImpl=(url,options,callback)=>{const req=new EventEmitter();req.setTimeout=()=>req;req.destroy=()=>{};req.end=body=>{Promise.resolve().then(async()=>{
    const command=JSON.parse(body),value=await call(command);queries++;if(lost){lost=false;knownReceipt=value;return req.emit('error',Error('SYNTHETIC_ACK_LOST'));}
    const res=new EventEmitter();res.statusCode=value.schema===CLIENT.ERROR_SCHEMA?409:200;res.headers={'content-type':'application/json'};res.destroy=()=>{};callback(res);res.emit('data',Buffer.from(JSON.stringify(value)));res.emit('end');
   }).catch(e=>req.emit('error',e));};return req;};
   const client=CLIENT.createProvisioningClient({issuerId:A.issuerId,namespaceId:A.namespaceId,allowedEmailDomains:['example.test'],provisionerToken:'S'.repeat(43),requestImpl,now:()=>clock});
   await assert.rejects(client.prepareRead(args),e=>e.code==='PROVISIONING_TRANSPORT_UNAVAILABLE'&&e.uncertain===true);
   assert.equal(local.prepare('SELECT phase FROM crm_manager_operations_v1 WHERE operation_id=?').get(operationId).phase,'prepare_uncertain');
   // Advance the consumer clock and model the database lease expiring without
   // waiting ten minutes. Stored historical receipt remains untouched.
   clock+=660000;await f.age(q);error(await call(q),'CANDIDATE_EXPIRED',q);
   const recovered=await client.operationStatus(descriptor);assert.equal(recovered.found,true);assert.equal(recovered.receipt.candidateExpiresAt,knownReceipt.candidateExpiresAt);assert.equal(recovered.receipt.expiresAt,knownReceipt.expiresAt);
   assert.deepEqual((await call(status(q))).receipt,knownReceipt);assert.equal(queries,2);
   await assert.rejects(client.commitRead({operationId:id(),prepared:recovered.receipt}),e=>e.code==='PROVISIONING_CANDIDATE_EXPIRED');assert.equal(queries,2);
   journal.recordPrepared(operationId,recovered.receipt);journal.expireCandidate(operationId);assert.equal(local.prepare('SELECT phase FROM crm_manager_operations_v1 WHERE operation_id=?').get(operationId).phase,'expired');
   const next=journal.retryIssue(userId).operationId,n=journal.request(next);assert.notEqual(next,operationId);assert.notEqual(n.principalId,q.principalId);assert.equal(n.generation,1);assert.equal(n.expectedGeneration,0);assert.equal(journal.credentialReady(userId),false);await f.unchanged();
  }finally{local.close();}
 });
 await t.test('promotion refuses tampered candidate activation, hash, owner, expiry, panel or permission scope',async()=>{
  const changes=[['UPDATE public.crm_dash_chave SET ativo=false WHERE chave=$1',[]],['UPDATE public.crm_dash_chave SET revogada_em=now() WHERE chave=$1',[]],['UPDATE public.crm_dash_chave SET chave_hash=$2 WHERE chave=$1',[sha('tampered-synthetic')]],['UPDATE public.crm_dash_chave SET dono=$2 WHERE chave=$1',['changed@example.test']],['UPDATE public.crm_dash_chave SET painel=$2 WHERE chave=$1',['todos']],['UPDATE public.crm_dash_chave SET expira_em=expira_em+interval \'1 day\' WHERE chave=$1',[]],['UPDATE public.shrigma_panel_permission_v1 SET caps=$2::jsonb WHERE principal_id=$1',['["crm_send"]']],['INSERT INTO public.shrigma_panel_permission_v1 VALUES($1,\'influs\',\'["all"]\')',[]]];
  for(const [sql,extra] of changes){const q=prepare(),p=await call(q);await db.query(sql,[q.principalId,...extra]);const c=commit(q,p);error(await call(c),'CREDENTIAL_CONFLICT',c);assert.equal((await db.query('SELECT active_generation FROM public.shrigma_crm_manager_subject_v1 WHERE namespace_id=$1 AND user_id=$2 AND lifecycle_id=$3',[q.namespaceId,q.userId,q.lifecycleId])).rows[0].active_generation,0);}
 });
 await t.test('revocation atomically tombstones all mapped generations, absorbs late commit/replay/status, reinvite is independent',async()=>{
  const q=prepare(),p=await call(q),c=commit(q,p);await call(c);const n=renewal(q),np=await call(n),r=revoke(q),rr=receipt(await call(r),r,'revoked');assert.equal(rr.revokedCount,2);assert.equal(rr.allGenerationsRevoked,true);assert.deepEqual(await call(r),rr);
  for(const old of [q,n,c,commit(n,np)])error(await call(old),'LIFECYCLE_REVOKED',old);
  for(const old of [q,c]){const s=status(old);error(await call(s),'LIFECYCLE_REVOKED',s);}
  for(const old of [q,n]){assert.equal((await key(old)).ativo,false);assert.deepEqual(await permissions(old),[]);}
  const again=prepare({userId:q.userId,lifecycleId:id()}),ap=await call(again);await call(commit(again,ap));await call(revoke(q));assert.equal((await key(again)).ativo,true);await f.unchanged();
 });
 await t.test('revoking unseen lifecycle prevents delayed prepare without adopting legacy records',async()=>{
  const q=prepare(),r=revoke(q);receipt(await call(r),r,'revoked');error(await call(q),'LIFECYCLE_REVOKED',q);const s=status(q);error(await call(s),'LIFECYCLE_REVOKED',s);assert.equal(await key(q),undefined);
  assert.equal((await db.query('SELECT response->>\'code\' AS code FROM public.shrigma_crm_manager_operation_v1 WHERE namespace_id=$1 AND operation_id=$2',[q.namespaceId,q.operationId])).rows[0].code,'LIFECYCLE_REVOKED');await f.unchanged();
 });
 await t.test('authority derives from dedicated login role: registry disabled, inherited/member/admin roles fail, helpers/tables inaccessible',async()=>{
  await db.exec('SET SESSION AUTHORIZATION crm_manager_fixture_a');
  try{await assert.rejects(db.query('SELECT * FROM public.crm_dash_chave'),/permission denied/);await assert.rejects(db.query('SELECT public.shrigma_crm_manager_apply_v1($1,\'prepare\')',[JSON.stringify(prepare())]),/permission denied/);}finally{await db.exec('SET SESSION AUTHORIZATION postgres');}
  const q=prepare();await db.query('UPDATE public.shrigma_crm_manager_issuer_v1 SET active=false WHERE issuer_id=$1',[A.issuerId]);error(await call(q),'ISSUER_DENIED',q);await db.query('UPDATE public.shrigma_crm_manager_issuer_v1 SET active=true WHERE issuer_id=$1',[A.issuerId]);
  for(const flag of ['INHERIT','CREATEDB','CREATEROLE','BYPASSRLS','REPLICATION','SUPERUSER']){await db.exec('ALTER ROLE crm_manager_fixture_a '+flag);error(await call(q),'ISSUER_DENIED',q);await db.exec('ALTER ROLE crm_manager_fixture_a NO'+flag);}
  await db.exec('GRANT crm_manager_fixture_b TO crm_manager_fixture_a');error(await call(q),'ISSUER_DENIED',q);await db.exec('REVOKE crm_manager_fixture_b FROM crm_manager_fixture_a');receipt(await call(q),q,'prepared');
 });
 await t.test('exact SQL receipts integrate with pinned client through synthetic in-process transport',async()=>{
  const {EventEmitter}=require('node:events');let commands=[];
  const requestImpl=(url,options,callback)=>{const req=new EventEmitter();req.setTimeout=()=>req;req.destroy=()=>{};req.end=body=>{Promise.resolve().then(async()=>{const q=JSON.parse(body);commands.push(q);const value=await call(q),code=value.schema===CLIENT.ERROR_SCHEMA?({INPUT_INVALID:400,ISSUER_DENIED:403,SUBJECT_NOT_FOUND:404,IDEMPOTENCY_CONFLICT:409,GENERATION_CONFLICT:409,LIFECYCLE_REVOKED:409,CANDIDATE_EXPIRED:409,CREDENTIAL_CONFLICT:409})[value.code]:200;const res=new EventEmitter();res.statusCode=code;res.headers={'content-type':'application/json'};res.destroy=()=>{};callback(res);res.emit('data',Buffer.from(JSON.stringify(value)));res.emit('end');}).catch(e=>req.emit('error',e));};return req;};
  const client=CLIENT.createProvisioningClient({issuerId:A.issuerId,namespaceId:A.namespaceId,allowedEmailDomains:['example.test'],provisionerToken:'S'.repeat(43),requestImpl});
  const q=prepare(),args={operationId:q.operationId,userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner,principalId:q.principalId,keySha256:q.keySha256},p=await client.prepareRead(args);assert.equal(p.state,'prepared');assert.ok(!Object.hasOwn(p,'keySha256'));assert.ok(!Object.hasOwn(p,'requestSha256'));
  const opid=id(),descriptor=client.describeCommit({operationId:opid,prepared:p}),c=await client.commitRead({operationId:opid,prepared:p});assert.equal(c.state,'committed');const restored=await client.operationStatus(descriptor);assert.equal(restored.receipt.state,'committed');
  await client.revokeRead({operationId:id(),userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner});await assert.rejects(client.operationStatus(descriptor),e=>e.code==='PROVISIONING_LIFECYCLE_REVOKED');assert.equal(commands.length,5);
 });
 await t.test('proposal owns no legacy grants, registers no production issuer and refuses duplicate installation',async()=>{
  assert.doesNotMatch(SQL.replace(/^\s*--.*$/gm,''),/CREATE\s+(?:OR\s+REPLACE\s+)?ROLE|GRANT\s|ALTER\s+TABLE\s+public\.crm_dash_chave|DROP\s/i);assert.match(SQL,/OFFLINE PROPOSAL/);await f.unchanged();
  await assert.rejects(db.exec(SQL),/already exists/);await db.exec('ROLLBACK');await f.unchanged();
 });
});
// A gateway component fixture can reuse this disposable database without
// invoking the tests or introducing a remote PostgreSQL transport.
module.exports={createFixture:fixture,createPrepare:prepare,createRenewal:renewal,createCommit:commit,createRevoke:revoke,createStatus:status,canonical,sha,issuerA:A,issuerB:B};
