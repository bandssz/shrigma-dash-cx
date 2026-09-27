'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const D=require('../tools/maintenance-tx-deploy/deploy.cjs'),C=require('../tools/maintenance-cart-deploy/deploy.cjs');
const P=require('../n8n/growth/maintenance-tx-popup-patch.cjs'),CP=require('../n8n/growth/maintenance-cart-patch.cjs');
const F=require('./maintenance-tx-popup-fixture.cjs'),CF=require('./maintenance-cart-fixture.cjs');
const ROOT=path.join(__dirname,'..'),copy=x=>JSON.parse(JSON.stringify(x));
const seal={contract:C.CONTRACT,nonce:'00000000-0000-4000-8000-000000000000',ddl:'d'.repeat(64),shape:'a'.repeat(32)};
function publish(w){w.active=true;w.shared=[{projectId:'synthetic-project'}];w.activeVersionId=w.versionId;w.activeVersion={versionId:w.versionId,nodes:copy(w.nodes),connections:copy(w.connections)};return w;}
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tx-deploy-')),store=new D.FileStore(directory),w=publish(F.workflow());
 const old=CF.workflow();for(const n of old.nodes)if(n.credentials?.postgres)n.credentials.postgres.id='synthetic-pg';
 const g={version:old.versionId,workflowHash:CP.digest(old),connectionsHash:CP.digest(old.connections)};
 const cart=publish(CP.patchCartProducer(old,g)),cc=publish({...CP.buildCartConsumer(old,g),id:'cart-consumer',versionId:'cart-consumer-v1'});
 const before={database:'listmonk',role:'synthetic',schema:'crm_maintenance_candidate',shape:seal.shape,seal:JSON.stringify(seal),dependencies:['shrigma_email_claim_cart','shrigma_email_finish_cart','shrigma_flow_email_claim_tx','shrigma_email_claim_engagement','shrigma_email_claim_fish','shrigma_email_claim_aristo','shrigma_flow_slot','shrigma_flow_slot_wa_versioned_v1','shrigma_email_finish_fish','shrigma_email_finish_aristo','shrigma_email_transport_outcome'].sort().map(name=>({name,signature:name+'(jsonb)',hash:'a'.repeat(32),execute:true,definition:'synthetic'}))};
 const state={control:{singleton:true,version:2,enabled:true,mode:'open',cutoff_at:null},event_count:'2',pending_count:'1',non_cart_count:'0'};
 const effects=[],workflows={[w.id]:w,[cart.id]:cart,[cc.id]:cc};let metadata=copy(before),lose=null;
 function effect(name,fn){effects.push(name);const r=fn();if(lose===name){lose=null;throw Error('NETWORK_RESPONSE_LOST');}return copy(r);}
 const io={
  getWorkflow:async id=>{assert.ok(workflows[id]);return copy(workflows[id]);},utilityPG:async()=>({ids:['synthetic-pg'],version:'util-v1',node_hash:'a'.repeat(64)}),metadata:async()=>copy(metadata),state:async()=>copy(state),
  sql:async q=>effect('install',()=>{assert.match(q,/DO \$tx_install\$/);const p=store.read('plan');metadata={...metadata,shape:'b'.repeat(32),seal:JSON.stringify({...p.migration.seal,shape:'b'.repeat(32)})};return [{shape:metadata.shape}];}),
  createWorkflow:async body=>effect('create',()=>{assert.equal(body.active,undefined);workflows.consumer={...copy(body),id:'consumer',active:false,versionId:'consumer-v1',activeVersionId:null,shared:copy(w.shared)};return workflows.consumer;}),
  putWorkflow:async(id,body)=>effect('patch',()=>{assert.equal(id,P.TARGET);workflows[id]={...workflows[id],...copy(body),versionId:'producer-v2'};return workflows[id];}),
  activateWorkflow:async(id,v)=>effect(id===w.id?'publish':'activate',()=>{assert.ok([P.TARGET,'consumer'].includes(id));assert.equal(workflows[id].versionId,v);publish(workflows[id]);return workflows[id];}),
  deactivateWorkflow:async id=>effect('halt',()=>{assert.equal(id,'consumer');workflows[id].active=false;return workflows[id];})
 };
 const guard={producer:{version:w.versionId,workflowHash:P.digest(w),connectionsHash:P.digest(w.connections)},retention:{seal_sha256:D.sha(seal),shape:seal.shape,control_version:2},cart:{producer:{id:cart.id,version:cart.versionId,workflowHash:P.digest(cart)},consumer:{id:cc.id,version:cc.versionId,workflowHash:P.digest(cc)}}};
 return {installer:new D.Installer({root:ROOT,io,store}),io,store,state,effects,workflows,before,guard,directory,setMeta:fn=>{metadata=fn(metadata);},lose:n=>{lose=n;}};
}
const PHASES=['install','create','patch','publish','activate'];
async function until(f,last='activate'){const p=await f.installer.prepare(f.guard);for(const phase of PHASES){await f.installer.phase(phase,p.plan_hash,{activationApproval:p.plan_hash+':activate'});if(phase===last)break;}return p;}
// Synthetic native functions only. No live data or transport.
const fixtureSQL=F.fixtureSQL+`
CREATE FUNCTION public.shrigma_email_finish_cart(p_id uuid,p_claim uuid,outcome text,b jsonb)
RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text) LANGUAGE sql AS $$ SELECT p_id,outcome,42::bigint,NULL::text $$;
`;
async function installBase(db){
 await db.exec(fixtureSQL);const before=(await db.query(C.METADATA_SQL)).rows[0];await db.exec(C.atomicInstall(ROOT,before,'00000000-0000-4000-8000-000000000000').sql);
 await F.api(db).control(1,true,'open');await F.api(db).admit('fish','cart',F.cart('fish'));
 return {before:(await db.query(D.METADATA_SQL)).rows[0],control:(await db.query(D.STATE_SQL)).rows[0].control};
}
const rowSnapshot=async db=>(await db.query(`SELECT jsonb_build_object('control',(SELECT jsonb_agg(to_jsonb(t)) FROM crm_maintenance_candidate.control t),'events',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM crm_maintenance_candidate.event t),'operations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM crm_maintenance_candidate.operation t),'cart_attempts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY event_id) FROM crm_maintenance_candidate.cart_attempt t),'dispatches',(SELECT jsonb_agg(to_jsonb(t) ORDER BY dispatch_id) FROM public.shrigma_email_dispatch t)) AS value`)).rows[0].value;
module.exports={ROOT,copy,seal,fixture,PHASES,until,fixtureSQL,installBase,rowSnapshot};
