'use strict';
// CI-only fixture preparation. Import opens no files/socket, reads no env and
// starts no test. Native execution needs explicit opt-in on a disposable runner.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const PROFILE='464d3cac6073dc6f3c42948203aa0d557d7396cefe1d8a5d0968c83896939311';
const SOURCE_PINS=Object.freeze({'writer-provision-v1.sql':'0db3c19b63537a7fdda8987675f8fe157effe38be103681d258aa3775554ba04','writer-empty-rollback-v1.sql':'19a3714bb989047a8ad304ef05d88a916ef841705d69b003b2cc828571164ecd','writer-provision.test.cjs':'bd124b8e9994bc3b829c196538f9b04bf0e97f77b99ab636820e571adda0c189','writer-policy.cjs':'fbfcc642c43243cb53b081bf018782f3191317d976ecc73111e9583562e83703'});
const REPO_PINS=Object.freeze({'tests/crm-manager-provision-postgres.test.cjs':'49520781a50c1488a2a3d37d18ae3a3d435d35d408dd133c59a32c5e1316c2e2','n8n/access/crm-manager-provision-v1.sql':'be6d670b90cd30977bc0ad2ffd8e7bd2e1d67d58727ef9fa616c2d07c2b813b4','n8n/access/panel-operator.sql':'7b1ab4bb657c6109337355c9a615c0fe5ff6a9837e69ef181ab1806d307446e8','services/dashboard-operational/crm-manager-provisioning.cjs':'723bca94435efe08bea98fdd3ceec450264b7e7001d57c42f7a427384ec087a5'});
const CAPS=Object.freeze(['read_content','draft','validate','submit']);
function fail(){throw Error('NATIVE_WRITER_PROOF_REFUSED');}
function clientConfig(){return{host:'127.0.0.1',port:5440,database:'crm_manager_writer_fixture',user:'postgres',password:'synthetic-writer-native-only',ssl:false,application_name:'shrigma-manager-writer-native-fixture',options:'-c statement_timeout=8000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000',connectionTimeoutMillis:2000,query_timeout:10000,statement_timeout:8000,lock_timeout:3000,idle_in_transaction_session_timeout:10000};}
function checkParameters(c){const p=c.connectionParameters,expected=clientConfig();for(const k of['host','port','database','user','password','ssl','application_name','options'])if(p[k]!==expected[k])fail();}
async function identity(c,role='postgres'){
 const row=(await c.query("SELECT current_database() AS db,current_user AS role,session_user AS session,current_setting('server_version_num')::int/10000 AS major,inet_server_port() AS port,current_setting('application_name') AS app,current_setting('cluster_name') AS cluster")).rows[0];
 assert.deepEqual(row,{db:'crm_manager_writer_fixture',role,session:role,major:17,port:5432,app:'shrigma-manager-writer-native-fixture',cluster:'shrigma-native-writer-disposable-only'});
}
function checkedSources(repositoryRoot){
 if(typeof repositoryRoot!=='string'||!path.isAbsolute(repositoryRoot))fail();
 for(const[name,pin]of Object.entries(SOURCE_PINS))if(sha(fs.readFileSync(path.join(__dirname,'..',name)))!==pin)fail();
 for(const[name,pin]of Object.entries(REPO_PINS))if(sha(fs.readFileSync(path.join(repositoryRoot,name)))!==pin)fail();
 return{W:require('../writer-provision.test.cjs'),R:require(path.join(repositoryRoot,'tests/crm-manager-provision-postgres.test.cjs'))};
}
const normalize=r=>(Array.isArray(r)?r:[r]).flatMap(v=>v.rows||[]);
async function assertNoLogin(container){
 assert.match(container,/^shrigma-manager-writer-proof-[0-9]+-[0-9]+$/);
 const {execFile}=require('node:child_process');
 for(const role of['crm_manager_writer_owner_v1','crm_manager_writer_service_v1']){
  const r=await new Promise(resolve=>execFile('/usr/bin/docker',['--host','unix:///var/run/docker.sock','exec',container,'psql','--no-psqlrc','--no-password','-h','127.0.0.1','-U',role,'-d','crm_manager_writer_fixture','-c','SELECT 1'],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000,maxBuffer:2048},(error,stdout,stderr)=>resolve({failed:Boolean(error),stdout,stderr})));
  assert.equal(r.failed,true);assert.equal(r.stdout,'');assert.equal(r.stderr.includes('role "'+role+'" is not permitted to log in'),true);
 }
}
async function proveNativeWriter(t,{Client,container,repositoryRoot}){
 const {W,R}=checkedSources(repositoryRoot),clients=new Set();
 const make=()=>{const c=new Client(clientConfig());checkParameters(c);c.on('error',()=>{});return c;};
 class NativeEngine{
  constructor(){this.client=make();clients.add(this.client);this.waitReady=this.client.connect().then(async()=>{await identity(this.client);const row=(await this.client.query("SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S','f')) AS relations,(SELECT count(*)::int FROM pg_roles WHERE rolname IN ('central_leitor','crm_manager_fixture_a','crm_manager_fixture_b','crm_manager_writer_owner_v1','crm_manager_writer_service_v1')) AS fixture_roles,(SELECT count(*)::int FROM pg_default_acl) AS defaults,(SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace) AS public_functions")).rows[0];assert.deepEqual(row,{relations:0,fixture_roles:0,defaults:0,public_functions:0});});}
  exec(s){return this.client.query(s);}query(s,a){return this.client.query(s,a);}close(){return this.client.end();}
 }
 // The READ fixture is unchanged and invoked exactly once. This wrapper only
 // saves its private call before the WRITER fixture supplies a distinct method.
 const readFixture=async(_t,o)=>{const f=await R.createFixture({after:()=>{}},o);return{...f,callRead:f.call};};
 let f;
 try{
  f=await W.createWriterFixture({after:()=>{}},{Engine:NativeEngine,readFixture,register:false});
  const {db}=f;
  const sameProfile=async()=>{const actual=await f.profile();if(actual!==PROFILE){if(typeof actual==='string'&&/^[a-f0-9]{64}$/.test(actual))t.diagnostic(JSON.stringify({phase:'writer-frozen-profile',expected:PROFILE,actual}));throw Error('NATIVE_WRITER_PROFILE_MISMATCH');}};
  const error=(r,code)=>{assert.equal(r.schema,'crm-manager-writer-error-v1');assert.equal(r.code,code);};
  const receipt=(r,q,state)=>{assert.equal(r.schema,'crm-manager-writer-receipt-v1');assert.equal(r.state,state);assert.equal(r.requestSha256,W.canonical&&sha(W.canonical(q)));assert.deepEqual(r.caps,[...CAPS]);assert.equal(r.principalId,q.principalId);return r;};
  await t.test('real native context/HBA and empty NOLOGIN install→fixed profile→exact rollback preserve READ baseline',async()=>{
   const h=normalize(await db.query("SELECT type,auth_method,count(*)::int AS n FROM pg_hba_file_rules WHERE error IS NULL GROUP BY type,auth_method ORDER BY type,auth_method"));assert.deepEqual(h,[{type:'host',auth_method:'scram-sha-256',n:1},{type:'host',auth_method:'trust',n:2},{type:'local',auth_method:'trust',n:1}]);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_hba_file_rules WHERE error IS NOT NULL')).rows[0].n,0);await sameProfile();await f.unchanged();await assertNoLogin(container);
   await db.exec(f.rollback);await f.unchanged();assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('crm_manager_writer_owner_v1','crm_manager_writer_service_v1')")).rows[0].n,0);
   await db.exec(f.source);await sameProfile();
  });
  // Register only synthetic fixture principals, NEVER the proposed service.
  for(const x of[W.A,W.B])await db.query('INSERT INTO public.crm_manager_writer_issuer_v1(issuer_id,namespace_id,login_role,allowed_email_domains,active) VALUES($1,$2,$3,ARRAY[$4],true)',[x.issuerId,x.namespaceId,x.login,'example.test']);
  await db.exec('GRANT EXECUTE ON FUNCTION public.crm_manager_writer_prepare_v1(jsonb),public.crm_manager_writer_commit_v1(jsonb),public.crm_manager_writer_revoke_v1(jsonb),public.crm_manager_writer_status_v1(jsonb) TO crm_manager_fixture_a,crm_manager_fixture_b');
  async function actor(name){assert.ok([W.A.login,W.B.login].includes(name));const c=make();clients.add(c);await c.connect();await identity(c);await c.query('SET SESSION AUTHORIZATION '+name);await identity(c,name);return c;}
  const a=await actor(W.A.login),b=await actor(W.A.login),other=await actor(W.B.login);
  const rpc={prepare_writer:'prepare',renew_writer:'prepare',commit_writer:'commit',revoke_writer:'revoke',writer_status:'status'};
  const invoke=async(c,q,method=rpc[q.action])=>{assert.ok(['prepare','commit','revoke','status'].includes(method));return(await c.query('SELECT public.crm_manager_writer_'+method+'_v1($1::jsonb) AS body',[W.canonical(q)])).rows[0].body;};
  async function waitLock(c){const until=Date.now()+1500;while(Date.now()<until){const r=(await db.query('SELECT wait_event_type,state FROM pg_stat_activity WHERE pid=$1',[c.processID])).rows[0];if(r?.wait_event_type==='Lock'&&r.state==='active')return;await new Promise(r=>setTimeout(r,15));}fail();}
  async function race(first,second){let open=false,pending;await a.query('BEGIN');open=true;try{const r=await first(a);pending=second(b).then(value=>({value}),()=>({failed:true}));await waitLock(b);await a.query('COMMIT');open=false;const next=await pending;if(next.failed)fail();return[r,next.value];}finally{if(open)await a.query('ROLLBACK');if(pending)await pending;}}
  const read=R.createPrepare(),readPrepared=await f.callRead(read);await f.callRead(R.createCommit(read,readPrepared));
  const readSnapshot=async()=>({key:(await db.query('SELECT * FROM public.crm_dash_chave WHERE chave=$1',[read.principalId])).rows,permission:(await db.query('SELECT * FROM public.shrigma_panel_permission_v1 WHERE principal_id=$1 ORDER BY area',[read.principalId])).rows});const readBefore=await readSnapshot();
  const intact=async()=>{await f.unchanged();assert.deepEqual(await readSnapshot(),readBefore);};
  await t.test('native candidate cannot authenticate until atomic commit; issuer/receipt/caps/TTL/status bound exactly',async()=>{
   const bearer=sha('synthetic-native-writer-only-bearer'),q=W.prepare({keySha256:sha(bearer)}),p=receipt(await invoke(a,q),q,'prepared');assert.equal((await f.key(q)).ativo,false);assert.equal((await db.query('SELECT public.shrigma_panel_operator_v1($1,\'growth\') AS body',[bearer])).rows[0].body,null);
   const c=W.commit(q,p),r=receipt(await invoke(a,c),c,'committed');assert.equal(r.expiresAt-r.issuedAt,1209600000);assert.equal((await f.key(q)).ativo,true);assert.deepEqual((await db.query('SELECT public.shrigma_panel_operator_v1($1,\'growth\') AS body',[bearer])).rows[0].body,{who:'panel:'+q.principalId,label:q.owner,caps:[...CAPS]});assert.deepEqual((await invoke(b,W.status(c))).receipt,r);assert.deepEqual(await invoke(b,c),r);await intact();
  });
  await t.test('native ACL/wrongactor/read payload/schema/principal/caps and privatehelper rejects before mutation',async()=>{
   const q=W.prepare();for(const change of[{schema:'crm-manager-provision-request-v1'},{action:'prepare_read'},{principalId:read.principalId},{caps:['read_content','list_history','submission']},{slot:'crm-panel-read'},{candidateTtlMs:600001},{generation:2}])error(await invoke(a,{...q,...change},'prepare'),'INPUT_INVALID');error(await invoke(other,q),'INPUT_INVALID');
   for(const table of['crm_dash_chave','shrigma_panel_permission_v1','crm_manager_writer_issuer_v1','crm_manager_writer_generation_v1'])await assert.rejects(a.query('SELECT * FROM public.'+table),e=>e.code==='42501');await assert.rejects(a.query('SELECT public.crm_manager_writer_apply_v1($1,\'prepare\')',[W.canonical(q)]),e=>e.code==='42501');assert.equal(await f.key(q),undefined);await intact();
  });
  await t.test('two native connections replay one uncommitted prepare under a real rowlock without duplicate or lease extension',async()=>{
   const q=W.prepare(),[x,y]=await race(c=>invoke(c,q),c=>invoke(c,q));receipt(x,q,'prepared');assert.deepEqual(y,x);assert.equal((await db.query('SELECT count(*)::int AS n FROM public.crm_manager_writer_generation_v1 WHERE namespace_id=$1 AND prepare_operation_id=$2',[q.namespaceId,q.operationId])).rows[0].n,1);error(await invoke(b,{...q,keySha256:sha('changed-native-synthetic')}),'IDEMPOTENCY_CONFLICT');await intact();
  });
  await t.test('distinct native prepares serialize one lifecycle and CAS admits only one inactive candidate',async()=>{
   const q=W.prepare(),n=W.prepare({userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner}),[x,y]=await race(c=>invoke(c,q),c=>invoke(c,n));receipt(x,q,'prepared');error(y,'GENERATION_CONFLICT');assert.equal((await f.key(q)).ativo,false);assert.equal(await f.key(n),undefined);await intact();
  });
  for(const first of['commit','revoke'])await t.test('native renewal '+first+' lock wins; tombstone blocks late activation and preserves READ',async()=>{
   const q=W.prepare(),p=await invoke(a,q);await invoke(a,W.commit(q,p));const n=W.renew(q),np=await invoke(a,n),nc=W.commit(n,np),rev=W.revoke(q);assert.equal((await f.key(q)).ativo,true);assert.equal((await f.key(n)).ativo,false);
   const[x,y]=first==='commit'?await race(c=>invoke(c,nc),c=>invoke(c,rev)):await race(c=>invoke(c,rev),c=>invoke(c,nc));if(first==='commit'){receipt(x,nc,'committed');assert.equal(y.allGenerationsRevoked,true);}else{assert.equal(x.allGenerationsRevoked,true);error(y,'LIFECYCLE_REVOKED');}for(const old of[q,n]){assert.equal((await f.key(old)).ativo,false);assert.deepEqual(await f.permissions(old),[]);}error(await invoke(b,nc),'LIFECYCLE_REVOKED');await intact();
  });
  await t.test('native lostACK status recovers historical expired candidate without activation or newPOST',async()=>{
   const q=W.prepare(),stored=await invoke(a,q);await f.age(q);const before=await f.key(q);assert.deepEqual((await invoke(b,W.status(q))).receipt,stored);assert.deepEqual(await f.key(q),before);error(await invoke(b,W.commit(q,stored)),'CANDIDATE_EXPIRED');const n=W.prepare({userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner});await invoke(a,n);assert.equal((await f.key(q)).ativo,false);assert.equal((await f.key(n)).ativo,false);await intact();
  });
  for(const c of[a,b,other]){await c.end();clients.delete(c);}
  // Remove ONLY synthetic fixture data just created above to model the EMPTY
  // prerequisite. This cleanup is never a production reversal or runner action.
  const principals=(await db.query('SELECT principal_id FROM public.crm_manager_writer_generation_v1 ORDER BY principal_id')).rows.map(r=>r.principal_id);assert.ok(principals.every(v=>/^dcrmw-[a-f0-9]{32}$/.test(v)));
  await db.exec('DELETE FROM public.crm_manager_writer_generation_v1;DELETE FROM public.crm_manager_writer_operation_v1;DELETE FROM public.crm_manager_writer_subject_v1;DELETE FROM public.crm_manager_writer_issuer_v1;');
  await db.query('DELETE FROM public.shrigma_panel_permission_v1 WHERE principal_id=ANY($1::text[])',[principals]);await db.query('DELETE FROM public.crm_dash_chave WHERE chave=ANY($1::text[])',[principals]);
  await db.exec('REVOKE EXECUTE ON FUNCTION public.crm_manager_writer_prepare_v1(jsonb),public.crm_manager_writer_commit_v1(jsonb),public.crm_manager_writer_revoke_v1(jsonb),public.crm_manager_writer_status_v1(jsonb) FROM crm_manager_fixture_a,crm_manager_fixture_b');await sameProfile();await intact();
  const cases=[['issuer row',"INSERT INTO public.crm_manager_writer_issuer_v1 VALUES('e1111111-1234-4234-8234-123456789abc','e2222222-1234-4234-8234-123456789abc','crm_manager_writer_service_v1',ARRAY['example.test'],false)","DELETE FROM public.crm_manager_writer_issuer_v1 WHERE issuer_id='e1111111-1234-4234-8234-123456789abc'"],['LOGIN flag','ALTER ROLE crm_manager_writer_service_v1 LOGIN','ALTER ROLE crm_manager_writer_service_v1 NOLOGIN'],['external dependency','CREATE VIEW public.writer_rollback_dependency AS SELECT * FROM public.crm_manager_writer_issuer_v1','DROP VIEW public.writer_rollback_dependency RESTRICT'],['function policy metadata','ALTER FUNCTION public.crm_manager_writer_prepare_v1(jsonb) IMMUTABLE','ALTER FUNCTION public.crm_manager_writer_prepare_v1(jsonb) VOLATILE']];
  for(const[label,patch,undo]of cases)await t.test('native EMPTY rollback refuses '+label+' and preserves installed state',async()=>{await db.exec(patch);try{let refused=false;try{await db.exec(f.rollback);}catch(e){refused=e.code==='P0001'&&e.message==='CRM_MANAGER_WRITER_EMPTY_ROLLBACK_REFUSED';}finally{await db.exec('ROLLBACK');}assert.equal(refused,true);assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])",[['crm_manager_writer_issuer_v1','crm_manager_writer_subject_v1','crm_manager_writer_operation_v1','crm_manager_writer_generation_v1']])).rows[0].n,4);await intact();}finally{await db.exec(undo);}await sameProfile();});
  await db.exec(f.rollback);await intact();
 }finally{for(const c of clients){try{await c.query('ROLLBACK');}catch{}try{await c.end();}catch{}}}
}
module.exports={clientConfig,checkParameters,identity,checkedSources,normalize,proveNativeWriter,SOURCE_PINS,REPO_PINS,PROFILE};
if(require.main===module){const test=require('node:test'),enabled=process.env.CRM_MANAGER_WRITER_NATIVE_PROOF==='1';test('native WRITER component proof requires deliberate disposable fixture opt-in',{skip:!enabled,timeout:120000},async t=>{try{assert.equal(process.versions.node.split('.')[0],'22');const pg=require('pg');assert.equal(require('pg/package.json').version,'8.13.1');const container=process.env.CRM_MANAGER_WRITER_CONTAINER;assert.match(container||'',/^shrigma-manager-writer-proof-[0-9]+-[0-9]+$/);await proveNativeWriter(t,{Client:pg.Client,container,repositoryRoot:path.resolve(__dirname,'../../..')});}catch(e){if(e?.message==='NATIVE_WRITER_PROFILE_MISMATCH')throw e;throw Error('NATIVE_WRITER_PROOF_FAILED');}});}
