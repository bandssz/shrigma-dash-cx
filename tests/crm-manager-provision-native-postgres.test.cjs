'use strict';
// CI-only native PostgreSQL proof. This file never reads DB_URL, PG* or a real
// credential. Without the explicit fixture flag it skips before loading pg or
// opening any connection. Every connection below pins the same loopback-only,
// synthetic database; the CI service must be fresh and use trust authentication.
const test=require('node:test'),assert=require('node:assert/strict');

test('native PostgreSQL16: closed manager RPCs, ACLs and concurrent lifecycle transactions',{
 skip:process.env.CRM_MANAGER_NATIVE_FIXTURE!=='1',timeout:90000
},async t=>{
 const {Client}=require('pg');
 const {createFixture,createPrepare:prepare,createRenewal:renewal,createCommit:commit,createRevoke:revoke,createStatus:status,canonical,sha,issuerA:A,issuerB:B}=require('./crm-manager-provision-postgres.test.cjs');
 const password='synthetic-local-trust-fixture-only';
 const names=Object.freeze({prepare_read:'prepare',renew_read:'prepare',commit_read:'commit',revoke_read:'revoke',status:'status'});
 const caps=['read_content','list_history','submission'];
 function makeClient(user){
  assert.ok(['postgres',A.login,B.login].includes(user));
  const client=new Client({host:'127.0.0.1',port:5432,database:'crm_manager_fixture',user,password,ssl:false,
   application_name:'crm-manager-native-fixture',options:'-c statement_timeout=5000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000',
   connectionTimeoutMillis:2000,query_timeout:6000,statement_timeout:5000,lock_timeout:3000,idle_in_transaction_session_timeout:10000});
  // Nonempty synthetic password/options also prevent pg's environment fallback.
  const p=client.connectionParameters;
  assert.equal(p.host,'127.0.0.1');assert.equal(p.port,5432);assert.equal(p.database,'crm_manager_fixture');
  assert.equal(p.user,user);assert.equal(p.password,password);assert.equal(p.ssl,false);
  assert.equal(p.application_name,'crm-manager-native-fixture');
  assert.equal(p.options,'-c statement_timeout=5000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000');
  client.on('error',()=>{});return client;
 }
 async function identity(client,user){
  // Docker's published loopback socket reaches a private container address;
  // destination authority is the client pin above, not that internal address.
  const r=(await client.query("SELECT current_database() AS db,session_user AS login,inet_server_port() AS port,current_setting('server_version_num')::int AS version")).rows[0];
  assert.equal(r.db,'crm_manager_fixture');assert.equal(r.login,user);assert.equal(r.port,5432);assert.ok(r.version>=160000&&r.version<170000,'fixture must be native PostgreSQL16');
 }
 class NativeFixtureEngine{
  constructor(){
   this.client=makeClient('postgres');
   this.waitReady=this.client.connect().then(async()=>{
    await identity(this.client,'postgres');
    const r=await this.client.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')");
    assert.equal(r.rows[0].n,0,'refuse a database containing non-system relations; CI fixture must be disposable and empty');
   });
  }
  exec(sql){return this.client.query(sql);}
  query(sql,args){return this.client.query(sql,args);}
  close(){return this.client.end();}
 }
 const f=await createFixture(t,{PGlite:NativeFixtureEngine});
 async function connect(issuer){const client=makeClient(issuer.login);t.after(()=>client.end());await client.connect();await identity(client,issuer.login);return client;}
 const a=await connect(A),b=await connect(A),other=await connect(B);
 const invoke=async(client,q)=>{
  assert.ok(Object.hasOwn(names,q.action));
  return (await client.query('SELECT public.shrigma_crm_manager_'+names[q.action]+'_v1($1::jsonb) AS body',[canonical(q)])).rows[0].body;
 };
 const receipt=(body,q,state)=>{
  assert.equal(body.schema,'crm-manager-provision-receipt-v1');assert.equal(body.state,state);
  assert.equal(body.action,q.action);assert.equal(body.issuerId,q.issuerId);assert.equal(body.namespaceId,q.namespaceId);
  assert.equal(body.operationId,q.operationId);assert.equal(body.requestSha256,sha(canonical(q)));
  assert.equal(body.userId,q.userId);assert.equal(body.lifecycleId,q.lifecycleId);assert.equal(body.owner,q.owner);
  assert.equal(Object.hasOwn(body,'keySha256'),false);return body;
 };
 const failure=(body,code,q)=>{assert.equal(body.schema,'crm-manager-provision-error-v1');assert.equal(body.code,code);assert.equal(body.operationId,q.operationId);assert.equal(body.requestSha256,sha(canonical(q)));return body;};
 const subject=async q=>(await f.db.query('SELECT * FROM public.shrigma_crm_manager_subject_v1 WHERE namespace_id=$1 AND user_id=$2 AND lifecycle_id=$3',[q.namespaceId,q.userId,q.lifecycleId])).rows[0];
 const generations=async q=>(await f.db.query('SELECT * FROM public.shrigma_crm_manager_generation_v1 WHERE namespace_id=$1 AND user_id=$2 AND lifecycle_id=$3 ORDER BY generation,prepare_operation_id',[q.namespaceId,q.userId,q.lifecycleId])).rows;
 async function waitForLock(client){
  const until=Date.now()+1500;
  while(Date.now()<until){
   const row=(await f.db.query('SELECT wait_event_type,state FROM pg_stat_activity WHERE pid=$1',[client.processID])).rows[0];
   if(row?.state==='active'&&row.wait_event_type==='Lock')return;
   await new Promise(resolve=>setTimeout(resolve,15));
  }
  assert.fail('second native connection did not contend on a PostgreSQL lock');
 }
 async function serializedRace(first,second){
  let transaction=false,pending;
  await a.query('BEGIN');transaction=true;
  try{
   const firstResult=await first(a);
   // Observe rejection immediately while the assertion inspects the real lock.
   pending=second(b).then(value=>({value}),error=>({error}));
   await waitForLock(b);await a.query('COMMIT');transaction=false;
   const next=await pending;if(next.error)throw next.error;return [firstResult,next.value];
  }finally{
   if(transaction)await a.query('ROLLBACK');
   if(pending)await pending;
  }
 }
 async function assertRevoked(q,prepared){
  assert.equal((await subject(q)).state,'revoked');
  for(const g of await generations(q)){
   assert.equal(g.state,'revoked');const key=await f.key({principalId:g.principal_id});assert.equal(key.ativo,false);assert.ok(key.revogada_em);
   assert.deepEqual(await f.permissions({principalId:g.principal_id}),[]);
  }
  failure(await invoke(a,q),'LIFECYCLE_REVOKED',q);
  if(prepared){const late=commit(q,prepared);failure(await invoke(b,late),'LIFECYCLE_REVOKED',late);}
  const lookup=status(q);failure(await invoke(b,lookup),'LIFECYCLE_REVOKED',lookup);await f.unchanged();
 }

 await t.test('dedicated login has only four RPC grants; direct tables, helpers and schema creation fail',async()=>{
  const role=(await f.db.query('SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[A.login])).rows[0];
  assert.deepEqual(role,{rolcanlogin:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false});
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',[A.login])).rows[0].n,0);
  for(const fn of ['prepare','commit','revoke','status']){
   const r=(await a.query('SELECT has_function_privilege(session_user,$1,\'EXECUTE\') AS allowed',['public.shrigma_crm_manager_'+fn+'_v1(jsonb)'])).rows[0];assert.equal(r.allowed,true);
  }
  for(const relation of ['crm_dash_chave','shrigma_panel_permission_v1','shrigma_crm_manager_issuer_v1','shrigma_crm_manager_subject_v1','shrigma_crm_manager_operation_v1','shrigma_crm_manager_generation_v1']){
   await assert.rejects(a.query('SELECT * FROM public.'+relation),e=>e.code==='42501');
   await assert.rejects(a.query('DELETE FROM public.'+relation+' WHERE false'),e=>e.code==='42501');
  }
  await assert.rejects(a.query('UPDATE public.crm_dash_chave SET ativo=false WHERE false'),e=>e.code==='42501');
  await assert.rejects(a.query("INSERT INTO public.crm_dash_chave(chave,painel,dono) VALUES('native-unauthorized','growth','synthetic@example.test')"),e=>e.code==='42501');
  await assert.rejects(a.query('SELECT public.shrigma_crm_manager_apply_v1($1::jsonb,\'prepare\')',[canonical(prepare())]),e=>e.code==='42501');
  await assert.rejects(a.query('SELECT public.shrigma_crm_manager_canonical_v1($1::jsonb)',['{}']),e=>e.code==='42501');
  await assert.rejects(a.query("SELECT public.shrigma_crm_manager_error_v1('{}'::jsonb,NULL,NULL,'INPUT_INVALID')"),e=>e.code==='42501');
  await assert.rejects(a.query('CREATE TABLE public.native_unauthorized_fixture(value int)'),e=>e.code==='42501');
  const q=prepare();await f.db.exec('GRANT crm_manager_fixture_b TO crm_manager_fixture_a');
  try{failure(await invoke(a,q),'ISSUER_DENIED',q);}finally{await f.db.exec('REVOKE crm_manager_fixture_b FROM crm_manager_fixture_a');}
  await f.db.query('UPDATE public.shrigma_crm_manager_issuer_v1 SET active=false WHERE issuer_id=$1',[A.issuerId]);
  try{failure(await invoke(a,q),'ISSUER_DENIED',q);}finally{await f.db.query('UPDATE public.shrigma_crm_manager_issuer_v1 SET active=true WHERE issuer_id=$1',[A.issuerId]);}
  await f.unchanged();
 });
 await t.test('native canonical digest, digest-only issue, fourteen-day commit, bound status and revoke',async()=>{
  const q=prepare({owner:"o'reilly+crm@example.test"}),p=receipt(await invoke(a,q),q,'prepared');
  assert.equal((await f.db.query('SELECT public.shrigma_crm_manager_canonical_v1($1::jsonb) AS body',[JSON.stringify(q)])).rows[0].body,canonical(q));
  const key=await f.key(q);assert.equal(key.chave_hash,q.keySha256);assert.equal(key.chave_hash_curta,null);assert.equal(key.painel,'growth');assert.equal(key.dono,q.owner);assert.equal(key.expira_em.getTime(),p.candidateExpiresAt);
  assert.deepEqual(await f.permissions(q),[{area:'growth',caps}]);assert.equal(p.candidateExpiresAt-p.issuedAt,600000);assert.equal(p.expiresAt-p.issuedAt,1209600000);
  const c=commit(q,p),cp=receipt(await invoke(a,c),c,'committed');assert.equal(cp.revokedGeneration,null);assert.equal((await f.key(q)).expira_em.getTime(),p.expiresAt);
  assert.deepEqual((await invoke(b,status(c))).receipt,cp);assert.deepEqual(await invoke(b,c),cp);
  const wrong=status(c,{expectedRequestSha256:'0'.repeat(64)});failure(await invoke(b,wrong),'IDEMPOTENCY_CONFLICT',wrong);
  const foreign={...status(c),issuerId:B.issuerId,namespaceId:B.namespaceId};assert.equal((await invoke(other,foreign)).found,false);
  const rq=revoke(q),rp=receipt(await invoke(a,rq),rq,'revoked');assert.equal(rp.allGenerationsRevoked,true);assert.deepEqual(await invoke(b,rq),rp);await assertRevoked(q,p);
 });
 await t.test('two native connections replay one uncommitted prepare and create only one immutable candidate',async()=>{
  const q=prepare();const [first,second]=await serializedRace(c=>invoke(c,q),c=>invoke(c,q));receipt(first,q,'prepared');assert.deepEqual(second,first);
  assert.equal((await generations(q)).length,1);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM public.shrigma_crm_manager_operation_v1 WHERE namespace_id=$1 AND operation_id=$2',[q.namespaceId,q.operationId])).rows[0].n,1);
  const conflicting={...q,keySha256:sha('changed-native-synthetic')};failure(await invoke(b,conflicting),'IDEMPOTENCY_CONFLICT',conflicting);assert.deepEqual((await invoke(b,status(q))).receipt,first);await f.unchanged();
 });
 await t.test('distinct prepares contend on one lifecycle and generation CAS permits only one candidate',async()=>{
  const q=prepare(),other=prepare({userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner});
  const [first,second]=await serializedRace(c=>invoke(c,q),c=>invoke(c,other));receipt(first,q,'prepared');failure(second,'GENERATION_CONFLICT',other);
  assert.equal((await generations(q)).length,1);assert.equal(await f.key(other),undefined);assert.equal((await subject(q)).active_generation,0);await f.unchanged();
 });
 await t.test('renew commit wins its row lock before revoke; revoke still tombstones every generation and blocks replay',async()=>{
  const q=prepare(),p=await invoke(a,q);await invoke(a,commit(q,p));const n=renewal(q),np=await invoke(a,n),nc=commit(n,np),rq=revoke(q);
  const [committed,revoked]=await serializedRace(c=>invoke(c,nc),c=>invoke(c,rq));receipt(committed,nc,'committed');assert.equal(committed.revokedGeneration,1);receipt(revoked,rq,'revoked');assert.equal(revoked.revokedCount,1);
  failure(await invoke(b,nc),'LIFECYCLE_REVOKED',nc);await assertRevoked(q,p);await assertRevoked(n,np);
 });
 await t.test('revoke wins its row lock before renew commit; waiting commit cannot activate a tombstoned lifecycle',async()=>{
  const q=prepare(),p=await invoke(a,q);await invoke(a,commit(q,p));const n=renewal(q),np=await invoke(a,n),nc=commit(n,np),rq=revoke(q);
  const [revoked,late]=await serializedRace(c=>invoke(c,rq),c=>invoke(c,nc));receipt(revoked,rq,'revoked');assert.equal(revoked.revokedCount,2);failure(late,'LIFECYCLE_REVOKED',nc);
  await assertRevoked(q,p);await assertRevoked(n,np);assert.equal((await subject(q)).active_generation,1);
  const fresh=prepare({userId:q.userId}),fp=receipt(await invoke(a,fresh),fresh,'prepared');await invoke(a,commit(fresh,fp));await invoke(b,rq);assert.equal((await f.key(fresh)).ativo,true);assert.deepEqual(await f.permissions(fresh),[{area:'growth',caps}]);await f.unchanged();
 });
 await t.test('expired candidate status returns historical receipt for reconciliation without reviving or extending it',async()=>{
  const q=prepare(),p=await invoke(a,q);await f.age(q);
  const before=await f.key(q),lookup=status(q),s=await invoke(b,lookup);assert.equal(s.found,true);assert.deepEqual(s.receipt,p);assert.deepEqual(await f.key(q),before);assert.ok(before.expira_em.getTime()<Date.now());
  const fresh=prepare({userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner}),fp=receipt(await invoke(a,fresh),fresh,'prepared');assert.equal((await f.key(q)).ativo,false);assert.deepEqual(await f.permissions(q),[]);
  assert.deepEqual((await invoke(b,lookup)).receipt,p);const late=commit(q,p);failure(await invoke(a,late),'CANDIDATE_EXPIRED',late);await invoke(a,commit(fresh,fp));assert.equal((await f.key(fresh)).ativo,true);await f.unchanged();
 });
});
