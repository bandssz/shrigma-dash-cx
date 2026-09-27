'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const G=require('../tools/graph-install/deploy.cjs');
const ROOT=path.join(__dirname,'..'),copy=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 const store=new G.FileStore(fs.mkdtempSync(path.join(os.tmpdir(),'graph-install-protocol-')));
 let metadata={database:'listmonk',role:'postgres',graph_shape:'a'.repeat(32),maintenance_shape:'a'.repeat(32),maintenance_legacy_shape:'a'.repeat(32),public_shape:'a'.repeat(32),graph_seal:null,maintenance_seal:JSON.stringify({contract:'maintenance-cart-install-v1',nonce:'00000000-0000-4000-8000-000000000001',ddl:'a'.repeat(64),shape:'a'.repeat(32)}),graph_tables:G.BASE_TABLES,graph_control:{singleton:true,enabled:false},maintenance_control:{singleton:true,enabled:true,mode:'open',version:2,cutoff_at:null},send_log_sequence:'public.shrigma_send_log_id_seq',recipient_key:{signature:'public.shrigma_email_recipient_key(text)',sha256:'a'.repeat(64),definer:true},worker_role:null};
 const workflows=Object.fromEntries(G.WORKFLOWS.map(id=>[id,{id,active:true,versionId:'v1',activeVersionId:'v1',nodes:[{credentials:{postgres:{id:'synthetic'}}}],connections:{},activeVersion:{versionId:'v1',nodes:[{credentials:{postgres:{id:'synthetic'}}}],connections:{}}}]));
 let writes=0,lose=false,effect=true;
 const io={getWorkflow:async id=>copy(workflows[id]),metadata:async()=>copy(metadata),utilityPG:async()=>({ids:['synthetic'],version:'v1',node_hash:'a'.repeat(64)}),off:async()=>({cart_off:true,epochs:'0',owners:'0',sources:'0',clones:'0'}),sql:async sql=>{
  writes++;assert.equal(store.has('install-intent'),true);assert.equal(sql,store.read('plan').migration.sql);
  if(effect){const p=store.read('plan');metadata={...metadata,graph_shape:'b'.repeat(32),maintenance_shape:'b'.repeat(32),public_shape:'b'.repeat(32),maintenance_legacy_shape:'b'.repeat(32),worker_role:{name:'crm_graph_worker',login:false,superuser:false,createdb:false,createrole:false,inherit:false,replication:false,bypassrls:false,memberships:0}};
   metadata.graph_seal=JSON.stringify({...p.migration.seal,graph_shape:metadata.graph_shape,maintenance_shape:metadata.maintenance_shape,public_shape:metadata.public_shape,worker_role:metadata.worker_role});metadata.maintenance_seal=JSON.stringify({...p.migration.maintenanceSeal,shape:metadata.maintenance_legacy_shape});}
  if(lose)throw Error('SYNTHETIC_RESPONSE_LOST');return [];
 }};
 const installer=new G.Installer({root:ROOT,io,store});
 return {installer,store,io,workflows,writes:()=>writes,lose:(hasEffect=true)=>{lose=true;effect=hasEffect;},change:fn=>{metadata=fn(metadata);},metadata:()=>copy(metadata),prepare:async()=>installer.prepare({snapshot_sha256:G.sha(await installer.snapshot())})};
}
test('reviewed snapshot, durable intent, fresh readback and OFF-only output',async()=>{
 const f=fixture();await assert.rejects(f.installer.prepare({snapshot_sha256:'0'.repeat(64)}),/UNREVIEWED/);assert.equal(f.writes(),0);
 const g=fixture(),p=await g.prepare();const result=await g.installer.install(p.plan_hash);assert.equal(result.installed,true);assert.equal(result.execution_enabled,false);assert.equal(result.worker_login,false);assert.equal(result.activation_available,false);assert.equal(g.writes(),1);
 assert.ok(fs.readdirSync(g.store.dir).every(x=>(fs.statSync(path.join(g.store.dir,x)).mode&0o777)===0o600));await assert.rejects(g.installer.install(p.plan_hash),/UNCERTAIN_RECONCILE/);assert.equal(g.writes(),1);
});
test('lost acknowledgement after commit reconciles without repeating SQL; no-effect timeout stays blocked',async()=>{
 for(const committed of [true,false]){const f=fixture(),p=await f.prepare();f.lose(committed);await assert.rejects(f.installer.install(p.plan_hash),/RESPONSE_LOST/);await assert.rejects(f.installer.install(p.plan_hash),/UNCERTAIN_RECONCILE/);
  if(committed)assert.equal((await f.installer.reconcile()).readback_verified,true);else await assert.rejects(f.installer.reconcile(),/SEAL/);assert.equal(f.writes(),1);}
});
test('fresh schema, workflow version and utility drift stop before intent or SQL',async()=>{
 for(const mutate of [f=>f.change(m=>({...m,graph_shape:'c'.repeat(32)})),f=>{f.workflows[G.WORKFLOWS[0]].versionId='v2';},f=>{f.io.utilityPG=async()=>({ids:['other']});}]){
  const f=fixture(),p=await f.prepare();mutate(f);await assert.rejects(f.installer.install(p.plan_hash),/DRIFT|UNPUBLISHED|RUNTIME_PG_REFERENCE|UTILITY_PG/);assert.equal(f.writes(),0);assert.equal(f.store.has('install-intent'),false);
 }
});
test('wrong approval and tampered plan cannot write; missing intent cannot reconcile',async()=>{
 const f=fixture(),p=await f.prepare();await assert.rejects(f.installer.install('0'.repeat(64)),/PLAN_APPROVAL/);await assert.rejects(f.installer.reconcile(),/RECONCILE_STATE/);const body=f.store.read('plan');body.migration.sql+='ALTER ROLE crm_graph_worker LOGIN;';fs.writeFileSync(path.join(f.store.dir,'plan.json'),JSON.stringify(body));await assert.rejects(f.installer.install(p.plan_hash),/PLAN_HASH/);assert.equal(f.writes(),0);
});
test('postinstall catalog drift or role LOGIN never verifies',async()=>{
 const f=fixture(),p=await f.prepare();await f.installer.install(p.plan_hash);f.change(m=>({...m,worker_role:{...m.worker_role,login:true}}));await assert.rejects(f.installer.verify(),/SEAL_DRIFT/);assert.equal(f.writes(),1);
});
test('only a fully linked TX extension preserves the graph readback',async()=>{
 const f=fixture(),p=await f.prepare();await f.installer.install(p.plan_hash);const old=f.metadata(),gs=JSON.parse(old.graph_seal),ms=JSON.parse(old.maintenance_seal),extension={contract:'maintenance-tx-install-v1',nonce:'00000000-0000-4000-8000-000000000002',ddl:'c'.repeat(64),previous_maintenance_shape:old.maintenance_shape};
 f.change(m=>({...m,maintenance_shape:'c'.repeat(32),maintenance_legacy_shape:'c'.repeat(32),graph_seal:JSON.stringify({...gs,maintenance_shape:'c'.repeat(32),maintenance_extension:extension}),maintenance_seal:JSON.stringify({contract:extension.contract,nonce:extension.nonce,ddl:extension.ddl,previous:ms,shape:'c'.repeat(32)})}));assert.equal((await f.installer.verify()).readback_verified,true);
 f.change(m=>({...m,graph_seal:JSON.stringify({...JSON.parse(m.graph_seal),maintenance_extension:{...extension,previous_maintenance_shape:'d'.repeat(32)}})}));await assert.rejects(f.installer.verify(),/EXTENSION_PREDECESSOR/);f.change(m=>({...m,graph_seal:JSON.stringify({...JSON.parse(m.graph_seal),maintenance_extension:extension})}));
 f.change(m=>{const s=JSON.parse(m.maintenance_seal);s.previous.nonce='00000000-0000-4000-8000-000000000099';return {...m,maintenance_seal:JSON.stringify(s)};});await assert.rejects(f.installer.verify(),/EXTENSION_CHAIN/);assert.equal(f.writes(),1);
});
