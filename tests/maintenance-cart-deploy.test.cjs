'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const D=require('../tools/maintenance-cart-deploy/deploy.cjs'),P=require('../n8n/growth/maintenance-cart-patch.cjs'),{workflow}=require('./maintenance-cart-fixture.cjs');
const ROOT=path.join(__dirname,'..'),copy=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cart-deploy-')),store=new D.FileStore(directory),w=workflow();w.shared=[{projectId:'synthetic-project'}];w.activeVersion={versionId:w.versionId,nodes:copy(w.nodes),connections:copy(w.connections)};
 const before={database:'listmonk',role:'synthetic',schema:null,shape:null,seal:null,dependencies:['shrigma_email_claim_cart','shrigma_email_finish_cart','shrigma_flow_email_claim_tx','shrigma_email_claim_engagement'].sort().map(name=>({name,signature:name+'(jsonb)',hash:'a'.repeat(32),execute:true,definition:'synthetic'}))};
 const state={control:{singleton:true,version:1,enabled:false,mode:'closed',cutoff_at:null},event_count:'0',pending_count:'0',non_cart_count:'0'};
 const effects=[],workflows={[w.id]:w};let metadata=copy(before),operation=null,lose=null;
 function effect(name,fn){effects.push(name);const r=fn();if(lose===name){lose=null;throw Error('NETWORK_RESPONSE_LOST');}return copy(r);}
 const io={
  getWorkflow:async id=>{assert.ok(workflows[id]);return copy(workflows[id]);},utilityPG:async()=>({ids:['synthetic-db'],version:'util-v1',configuration:'synthetic'}),metadata:async()=>copy(metadata),state:async()=>copy(state),controlOperation:async()=>copy(operation),
  sql:async q=>effect(q.includes('DO $cart_install$')?'install':'open',()=>{const p=store.read('plan');if(q.includes('DO $cart_install$')){metadata={...metadata,schema:'crm_maintenance_candidate',shape:'installed-shape',seal:JSON.stringify({...p.migration.seal,shape:'installed-shape'})};return [{shape:metadata.shape}];}
   state.control={...state.control,version:2,enabled:true,mode:'open'};operation={request:{expected:1,enabled:true,mode:'open'},response:{...state.control,drained:false}};return [{receipt:operation.response}];}),
  createWorkflow:async body=>effect('create',()=>{assert.equal(body.active,undefined);workflows.consumer={...copy(body),id:'consumer',active:false,versionId:'consumer-v1',activeVersionId:null,shared:copy(w.shared)};return workflows.consumer;}),
  putWorkflow:async(id,body)=>effect('patch',()=>{workflows[id]={...workflows[id],...copy(body),versionId:'producer-v2'};return workflows[id];}),
  activateWorkflow:async(id,v)=>effect(id===w.id?'publish':'activate',()=>{assert.equal(workflows[id].versionId,v);workflows[id].active=true;workflows[id].activeVersionId=v;workflows[id].activeVersion={versionId:v,nodes:copy(workflows[id].nodes),connections:copy(workflows[id].connections)};return workflows[id];}),
  deactivateWorkflow:async id=>effect('halt',()=>{workflows[id].active=false;return workflows[id];})
 };
 const installer=new D.Installer({root:ROOT,io,store});
 return {installer,io,store,state,effects,workflows,before,setMeta:f=>{metadata=f(metadata);},lose:n=>{lose=n;},directory,guard:{version:w.versionId,workflowHash:P.digest(w),connectionsHash:P.digest(w.connections)}};
}
async function until(f,last='activate'){const p=await f.installer.prepare(f.guard),phases=['install','create','open','patch','publish','activate'];for(const phase of phases){await f.installer.phase(phase,p.plan_hash,{activationApproval:p.plan_hash+':activate'});if(phase===last)break;}return p;}
test('full phase rehearsal creates OFF, opens before patch/publish, activates only after separate review and never invokes transport',async()=>{
 const f=fixture(),p=await until(f,'publish');assert.deepEqual(f.effects,['install','create','open','patch','publish']);assert.equal(f.workflows.consumer.active,false);
 await assert.rejects(f.installer.phase('activate',p.plan_hash),/ACTIVATION_REVIEW/);assert.equal(f.effects.length,5);
 await f.installer.phase('activate',p.plan_hash,{activationApproval:p.plan_hash+':activate'});const v=await f.installer.verify();assert.equal(v.consumer_active,true);assert.equal(v.drained,false);assert.equal(v.runtime_acceptance_pending,true);
 await f.installer.phase('halt',p.plan_hash);assert.equal(f.state.control.mode,'open');assert.equal(f.workflows.consumer.active,false);assert.equal(f.workflows[P.TARGET].active,true);
 assert.ok(fs.readdirSync(f.directory).every(n=>(fs.statSync(path.join(f.directory,n)).mode&0o777)===0o600));
});
for(const phase of ['install','create','open','patch','publish','activate'])test('lost '+phase+' response is never retried and can only reconcile exact durable state',async()=>{
 const f=fixture(),p=await f.installer.prepare(f.guard);for(const s of ['install','create','open','patch','publish','activate']){if(s===phase)break;await f.installer.phase(s,p.plan_hash,{activationApproval:p.plan_hash+':activate'});}
 f.lose(phase);await assert.rejects(f.installer.phase(phase,p.plan_hash,{activationApproval:p.plan_hash+':activate'}),/RESPONSE_LOST/);
 const count=f.effects.length;await assert.rejects(f.installer.phase(phase,p.plan_hash,{activationApproval:p.plan_hash+':activate'}),/UNCERTAIN_RECONCILE/);assert.equal(f.effects.length,count);
 if(phase==='create')await assert.rejects(f.installer.reconcile('create'),/CONSUMER_ID/);
 await f.installer.reconcile(phase,{consumerId:'consumer'});assert.equal(f.effects.length,count);assert.equal(f.store.read(phase+'-verified').reconciled_read_only,true);
});
test('version, graph, credential, project, source and schema drift stop before writes',async()=>{
 for(const mutate of [f=>f.workflows[P.TARGET].versionId='foreign',f=>f.workflows[P.TARGET].connections={},f=>f.workflows[P.TARGET].nodes[2].credentials.postgres.id='foreign',f=>f.workflows[P.TARGET].shared[0].projectId='foreign']){
  const f=fixture(),p=await f.installer.prepare(f.guard);mutate(f);await assert.rejects(f.installer.phase('install',p.plan_hash),/DRIFT|IDENTITY/);assert.equal(f.effects.length,0);
 }
 const f=fixture(),p=await until(f,'install');f.setMeta(m=>({...m,shape:'modified-by-other'}));await assert.rejects(f.installer.phase('create',p.plan_hash),/SCHEMA_DRIFT/);assert.deepEqual(f.effects,['install']);
});
test('closed or administratively changed gate cannot publish/activate; missing phase cannot jump ahead',async()=>{
 const f=fixture(),p=await until(f,'create');await assert.rejects(f.installer.phase('patch',p.plan_hash),/GATE_NOT_OPEN/);
 await f.installer.phase('open',p.plan_hash);f.state.control.version=3;await assert.rejects(f.installer.phase('patch',p.plan_hash),/GATE_VERSION_DRIFT/);
 f.state.control.mode='closed';await assert.rejects(f.installer.phase('patch',p.plan_hash),/GATE_NOT_OPEN/);assert.deepEqual(f.effects,['install','create','open']);
});
test('unknown outcome without effect stays blocked; wrong consumer and partial install cannot reconcile',async()=>{
 const f=fixture(),p=await f.installer.prepare(f.guard);f.io.sql=async()=>{throw Error('TIMEOUT_BEFORE_OR_AFTER');};await assert.rejects(f.installer.phase('install',p.plan_hash),/TIMEOUT/);await assert.rejects(f.installer.reconcile('install'),/SEAL|SCHEMA_DRIFT/);
 await assert.rejects(f.installer.phase('install',p.plan_hash),/UNCERTAIN/);assert.equal(f.effects.length,0);
});
test('reconcile refuses modified content and never chooses a consumer by name alone',async()=>{
 const f=fixture(),p=await until(f,'install');f.lose('create');await assert.rejects(f.installer.phase('create',p.plan_hash));f.workflows.consumer.nodes[0].parameters={changed:true};await assert.rejects(f.installer.reconcile('create',{consumerId:'consumer'}),/DRIFT/);assert.deepEqual(f.effects,['install','create']);
});
test('plan corruption, unreviewed export and wrong approval are rejected',async()=>{
 const f=fixture();await assert.rejects(f.installer.prepare({...f.guard,version:'other'}),/VERSION_HASH/);assert.equal(f.effects.length,0);const p=await f.installer.prepare(f.guard);await assert.rejects(f.installer.phase('install','bad'),/APPROVAL/);
 const location=path.join(f.directory,'plan.json'),data=JSON.parse(fs.readFileSync(location));data.consumer.nodes=[];fs.writeFileSync(location,JSON.stringify(data));await assert.rejects(f.installer.phase('install',p.plan_hash),/PLAN_HASH/);
});
test('DDL uses one atomic DO with original source intact, no external BEGIN or COMMIT and guarded schema absence',()=>{
 const f=fixture(),a=D.atomicInstall(ROOT,f.before,'00000000-0000-4000-8000-000000000000');assert.match(a.sql,/SET LOCAL statement_timeout='15s';/);assert.equal((a.sql.match(/DO \$cart_install\$/g)||[]).length,1);assert.doesNotMatch(a.sql,/^BEGIN;|^COMMIT;/m);assert.match(a.sql,/SCHEMA_EXISTS/);assert.match(a.sql,/DEPENDENCY_DRIFT/);assert.match(a.sql,/COMMENT ON SCHEMA/);assert.ok(a.sql.includes('CREATE FUNCTION crm_maintenance_candidate.cart_next_v1'));
});
test('public API PUT may publish immediately: exact active body is verified without an extra activation',async()=>{
 const f=fixture(),p=await until(f,'open'),put=f.io.putWorkflow;f.io.putWorkflow=async(...args)=>{const w=await put(...args),saved=f.workflows[P.TARGET];saved.activeVersionId=saved.versionId;saved.activeVersion={versionId:saved.versionId,nodes:copy(saved.nodes),connections:copy(saved.connections)};return w;};
 await f.installer.phase('patch',p.plan_hash);await f.installer.phase('publish',p.plan_hash);assert.deepEqual(f.effects,['install','create','open','patch']);assert.equal(f.store.read('publish-verified').published,true);
});
test('matching active version ID is insufficient when published body differs; same-code foreign version also blocks activation',async()=>{
 const f=fixture(),p=await until(f,'publish');f.workflows[P.TARGET].activeVersion.nodes=[];await assert.rejects(f.installer.phase('activate',p.plan_hash,{activationApproval:p.plan_hash+':activate'}),/PUBLISHED_BODY_DRIFT/);assert.equal(f.effects.length,5);
 f.workflows[P.TARGET].activeVersion.nodes=copy(f.workflows[P.TARGET].nodes);f.workflows.consumer.versionId='foreign-identical-content';await assert.rejects(f.installer.phase('activate',p.plan_hash,{activationApproval:p.plan_hash+':activate'}),/CONSUMER_VERSION_DRIFT/);assert.equal(f.effects.length,5);
});

test('every mutating phase requires explicit plan hash, including CLI omission, before any network write',async()=>{
 const f=fixture();await f.installer.prepare(f.guard);for(const phase of ['install','create','open','patch','publish','activate','halt'])await assert.rejects(f.installer.phase(phase),/APPROVAL_REQUIRED/);assert.deepEqual(f.effects,[]);assert.ok(!fs.readdirSync(f.directory).some(n=>n.includes('-intent')));
});
