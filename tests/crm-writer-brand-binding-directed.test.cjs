'use strict';
// Disposable SQLite and injectable native adapters only. No genuine bearer,
// provider connection, campaign write or send is used by this fixture.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,CAPS}=require('./corporate-writer-fixture.cjs');
const {createWriterPolicy}=require('../services/dashboard-operational/crm-manager-writer-policy.cjs');
const W=require('../services/crm-manager-writer/wire.cjs');
const {createExecutor,AUTH_SQL}=require('../services/crm-campaign/transport.cjs');
const {createMediaExecutor}=require('../services/crm-campaign/media.cjs');

test('the real auth/journal/issuer flow carries the signed individual brand through preparation and commit',async t=>{
 const f=await fixture(t),id=await f.manager(),master=f.masterBaseline();
 assert.deepEqual(await f.issue(id),{state:'ready'});
 const q=f.auth.managedCampaignWriterJournal.request(f.operation(id));
 const r=JSON.parse(f.db.prepare('SELECT committed_json FROM crm_writer_bridge_op_v1 WHERE operation_id=?').get(f.operation(id)).committed_json);
 assert.equal(q.brand,'fish');assert.equal(r.brand,'fish');assert.deepEqual(q.caps,CAPS);
 const context=await f.login();assert.equal(f.auth.campaignWriterReady(context),true);assert.deepEqual(f.masterBaseline(),master);
 // Editing a brand row without its original MAC cannot rebind this credential.
 const before=f.db.prepare('SELECT * FROM crm_writer_bridge_op_v1 WHERE operation_id=?').get(f.operation(id));
 f.db.prepare("UPDATE user_brand_grants_v1 SET brand='aristo' WHERE user_id=?").run(id);
 assert.equal(f.auth.campaignWriterReady(context),false);await assert.rejects(f.login(),e=>e.code==='BRAND_REPROVISION_REQUIRED');
 assert.deepEqual(f.db.prepare('SELECT * FROM crm_writer_bridge_op_v1 WHERE operation_id=?').get(f.operation(id)),before);
 assert.deepEqual(f.masterBaseline(),master);
});

test('brand loss during attestation cannot promote edit and compensation retains the exact journal',async t=>{
 const f=await fixture(t),id=await f.manager(),context=await f.login();f.duringAttest=()=>{f.db.prepare("UPDATE user_brand_grants_v1 SET brand='aristo' WHERE user_id=?").run(id);};
 const result=await f.issue(id);assert.notEqual(result.state,'ready');
 assert.equal(f.db.prepare("SELECT can_edit FROM grants WHERE user_id=? AND area='growth'").get(id).can_edit,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM crm_writer_bridge_op_v1 WHERE lifecycle_id=(SELECT lifecycle_id FROM crm_writer_auth_admission_v1 WHERE user_id=?)").get(id).n>=1,true);
 assert.equal(f.auth.campaignWriterReady(context),false);await assert.rejects(f.login(),e=>e.code==='BRAND_REPROVISION_REQUIRED');
 assert.ok(f.events.includes('FULL_ATTEST'));assert.equal(f.events.filter(e=>e==='prepare_writer').length,1);assert.equal(f.events.filter(e=>e==='commit_writer').length,1);
});

test('closed writer wire refuses missing or crossed brand without changing the four capabilities',()=>{
 const p=createWriterPolicy({issuerId:'c1111111-1234-4234-8234-123456789abc',namespaceId:'c2222222-1234-4234-8234-123456789abc',allowedEmailDomains:['synthetic.invalid'],now:()=>1791000000000});
 const args={operationId:'c3333333-1234-4234-8234-123456789abc',userId:'c4444444-1234-4234-8234-123456789abc',lifecycleId:'c5555555-1234-4234-8234-123456789abc',owner:'manager@synthetic.invalid',brand:'fish',principalId:'dcrmw-'+'a'.repeat(32),keySha256:'b'.repeat(64)};
 const q=p.command('prepare_writer',args),scope={issuerId:q.issuerId,namespaceId:q.namespaceId,domains:new Set(['synthetic.invalid'])};
 assert.deepEqual(W.validateRequest(q,'/internal/v1/crm-writers/prepare',scope),q);
 const {brand,...unbound}=args;assert.throws(()=>p.command('prepare_writer',unbound));assert.throws(()=>p.command('prepare_writer',{...args,brand:'unknown'}));
 const receipt={schema:W.RECEIPT,issuerId:q.issuerId,namespaceId:q.namespaceId,operationId:q.operationId,action:q.action,requestSha256:W.sha(W.canonical(q)),userId:q.userId,lifecycleId:q.lifecycleId,owner:q.owner,state:'prepared',brand:'fish',principalId:q.principalId,generation:1,expectedGeneration:0,area:'growth',slot:'growth-campaign',role:'manager',caps:[...CAPS],issuedAt:1791000000000,candidateExpiresAt:1791000600000,expiresAt:1792209600000};
 assert.equal(W.validateResult(receipt,q,scope,1791000000000).status,200);
 assert.throws(()=>W.validateResult({...receipt,brand:'aristo'},q,scope,1791000000000));assert.throws(()=>p.receipt({...receipt,brand:'aristo'},q));assert.deepEqual(q.caps,CAPS);
});

test('direct gateway rejects the foreign brand before runtime, lease, execution ID and native delivery',async()=>{
 let auth={actor:'panel:synthetic-issued-writer',caps:[...CAPS],brand:'fish'},queries=0,starts=0,ids=0,native=0;
 const execute=createExecutor({pool:{query:async(sql)=>{assert.equal(sql,AUTH_SQL);queries++;return{rows:[{auth}]};}},native:async()=>{native++;throw Error('native must not execute');},executionId:()=>{ids++;return'fixture';},runtimeFactory:()=>({start:async(g,c)=>{starts++;assert.deepEqual(g.caps,CAPS);return{kind:'response',response:{status:200,body:{brand:c.brand}}};}})});
 const denied=await execute({key:'synthetic-only',command:{acao:'campanha_salvar',brand:'aristo'}});assert.equal(denied.status,403);assert.equal(denied.body.error,'BRAND_DENIED');assert.deepEqual([queries,starts,ids,native],[1,0,0,0]);
 assert.equal((await execute({key:'synthetic-only',command:{acao:'campanha_catalogo',brand:'fish'}})).status,200);assert.deepEqual([queries,starts,ids,native],[2,1,1,0]);
 auth={actor:'panel:real-row-master-fixture',caps:[...CAPS]};for(const brand of ['fish','aristo'])assert.equal((await execute({key:'synthetic-only',command:{acao:'campanha_catalogo',brand}})).status,200);
 auth={actor:'panel:malformed-fixture',caps:[...CAPS],brand:null};assert.equal((await execute({key:'synthetic-only',command:{acao:'campanha_catalogo',brand:'fish'}})).status,403);
 assert.equal(native,0);
});

test('media read cannot cross an individual brand; established unscoped admin and legacy media still work',async()=>{
 let auth={actor:'panel:synthetic-issued-writer',caps:[...CAPS],brand:'fish'},reads=0,posts=0;
 const media=createMediaExecutor({pool:{query:async()=>({rows:[{auth}]})},native:{origin:'https://native.synthetic.invalid',list:async()=>{reads++;return{status:200,body:{data:{results:[],total:0,page:1,per_page:20}}};},upload:async()=>{posts++;throw Error('no upload');}}});
 const input=brand=>({brand,page:1,per_page:20});const denied=await media({key:'synthetic',method:'GET',input:input('aristo')});assert.equal(denied.status,403);assert.deepEqual([reads,posts],[0,0]);
 assert.equal((await media({key:'synthetic',method:'GET',input:input('fish')})).status,200);
 auth={actor:'existing-authenticated-legacy-fixture',caps:['read_content','edit_content']};for(const brand of ['fish','aristo'])assert.equal((await media({key:'synthetic',method:'GET',input:input(brand)})).status,200);
 assert.deepEqual([reads,posts],[3,0]);
});
