'use strict';
const {sha}=require('../tools/maintenance-cart-deploy/deploy.cjs');
const A=require('../tools/graph-worker-access/contract.cjs');
const clone=x=>JSON.parse(JSON.stringify(x)),h=n=>String(n).repeat(64),m=n=>String(n).repeat(32),id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const ACCESS_BODY='synthetic nonsecret migration body',ACCESS_SQL='synthetic complete migration statement';
const inventory=()=>[{oid:'5',name:'synthetic_other'},{oid:'16384',name:'listmonk'}];
function fixture(){
 const role={name:'crm_graph_worker',login:false,superuser:false,createdb:false,createrole:false,inherit:false,replication:false,bypassrls:false,memberships:0};
 const role_identity={oid:'17001',role,settings:null,valid_until:null,connection_limit:-1,database_settings:[]};
 const cart={contract:'maintenance-cart-install-v1',nonce:id(1),ddl:h(1),shape:m(1)};
 const seal={contract:'crm-graph-install-v1',nonce:id(2),ddl:h(2),previous:cart};
 const maintenanceSeal={contract:'maintenance-cart-graph-install-v1',nonce:id(2),ddl:h(2),previous:cart};
 const graph_seal={...seal,graph_shape:m(2),maintenance_shape:m(3),public_shape:m(4),worker_role:role};
 const maintenance_seal={...maintenanceSeal,shape:m(5)};
 const metadata={database:'listmonk',role:'postgres',graph_shape:m(2),maintenance_shape:m(3),maintenance_legacy_shape:m(5),public_shape:m(4),worker_role:role,graph_seal:JSON.stringify(graph_seal),maintenance_seal:JSON.stringify(maintenance_seal),graph_control:{singleton:true,enabled:false},maintenance_control:{singleton:true,enabled:true,mode:'open',version:2,cutoff_at:null},public_create_schemas:[]};
 const plan={contract:seal.contract,sources:{'tools/graph-install/deploy.cjs':h(6)},migration:{sql:'synthetic immutable original install',seal,maintenanceSeal}};plan.hash=sha(plan);
 const install_verified={contract:seal.contract,plan_hash:plan.hash,sql_hash:sha(plan.migration.sql),installed:true,readback_verified:true,execution_enabled:false,worker_login:false,activation_available:false,baseline:{graph_shape:metadata.graph_shape,maintenance_shape:metadata.maintenance_shape,public_shape:metadata.public_shape,worker_role:role,maintenance_legacy_shape:metadata.maintenance_legacy_shape}};
 const baseAnchor={plan,install_verified,metadata,role_identity,reviewed:{plan_hash:plan.hash,receipt_hash:sha(install_verified),metadata_hash:sha(metadata),identity_hash:sha(role_identity),sources:clone(plan.sources)}};
 const base={graph_seal,maintenance_seal,role_identity};
 return {baseAnchor,base};
}
function scope(oid='17001'){
 const common={connect:true,temporary:true,create:false,catalog_hash:h(7),diagnostic_read_exceptions:[],non_system_read:false,non_system_write:false,non_system_create:false,non_system_definer_execute:false,foreign_server_usage:false};
 return {database:'listmonk',role:'crm_graph_worker',role_oid:oid,policy:A.SCOPE_POLICY,database_audits:[{...common,oid:'5',name:'synthetic_other'},{...common,oid:'16384',name:'listmonk',catalog_hash:h(8),non_system_read:true,non_system_write:true,non_system_definer_execute:true}]};
}
function access(before,baseAnchor){
 before=clone(before);const connection_scope=scope(before.role_identity.oid),auth_proof_hash=h(9);
 const extension={contract:A.CONTRACT,nonce:id(3),ddl:sha(ACCESS_BODY),base_plan_hash:baseAnchor.reviewed.plan_hash,base_receipt_hash:baseAnchor.reviewed.receipt_hash,previous_graph_seal_hash:sha(before.graph_seal),role_oid:before.role_identity.oid,previous_role:clone(before.graph_seal.worker_role),connection_scope_hash:sha(connection_scope),credential_version:'synthetic-v1',auth_proof_hash};
 const nextRole={...before.graph_seal.worker_role,login:true};
 const after={graph_seal:{...before.graph_seal,worker_role:nextRole,worker_access_extension:extension},maintenance_seal:clone(before.maintenance_seal),role_identity:{...clone(before.role_identity),role:nextRole}};
 return {contract:A.CONTRACT,nonce:id(3),plan_hash:h('b'),sql_hash:h('c'),before,after,connection_scope,auth_proof_hash};
}
function tx(before){
 before=clone(before);const extension={contract:'maintenance-tx-install-v1',nonce:id(4),ddl:h('d'),previous_maintenance_shape:before.graph_seal.maintenance_shape};
 return {contract:extension.contract,before,after:{graph_seal:{...before.graph_seal,maintenance_shape:m('e'),maintenance_extension:extension},maintenance_seal:{contract:extension.contract,nonce:extension.nonce,ddl:extension.ddl,previous:clone(before.maintenance_seal),shape:m('f')},role_identity:clone(before.role_identity)},extension};
}
function metadata(state){return {database:'listmonk',role:'postgres',graph_seal:JSON.stringify(state.graph_seal),maintenance_seal:JSON.stringify(state.maintenance_seal),graph_shape:state.graph_seal.graph_shape,maintenance_shape:state.graph_seal.maintenance_shape,public_shape:state.graph_seal.public_shape,maintenance_legacy_shape:state.maintenance_seal.shape,worker_role:clone(state.graph_seal.worker_role),worker_role_identity:clone(state.role_identity)};}
function repinAccess(input,exceptions=[]){
 const r=input.accessReceipt;
 const plan={contract:A.CONTRACT,nonce:r.nonce,before:clone(r.before),connection_scope:clone(r.connection_scope),database_inventory:inventory(),auth_proof_hash:r.auth_proof_hash,sources:{'tools/graph-worker-access/contract.cjs':h('a')},migration:{body:ACCESS_BODY,sql:ACCESS_SQL,extension:clone(r.after.graph_seal.worker_access_extension)}};plan.hash=sha(plan);
 r.plan_hash=plan.hash;r.sql_hash=sha(ACCESS_SQL);
 input.accessPlan=plan;input.accessReview={plan_hash:plan.hash,receipt_hash:sha(r),sql_hash:sha(ACCESS_SQL),body_hash:sha(ACCESS_BODY),sources:clone(plan.sources),database_inventory:inventory(),diagnostic_read_exceptions:clone(exceptions)};return input;
}
function inputs(order='access-tx'){
 const f=fixture();let accessReceipt=null,txReceipt=null,last=f.base;
 if(order==='access'||order==='access-tx'){accessReceipt=access(last,f.baseAnchor);last=accessReceipt.after;}
 if(order==='tx'||order==='access-tx'||order==='tx-access'){txReceipt=tx(last);last=txReceipt.after;}
 if(order==='tx-access'){accessReceipt=access(last,f.baseAnchor);last=accessReceipt.after;}
 const input={baseAnchor:f.baseAnchor,accessReceipt,accessPlan:null,accessReview:null,txReceipt,metadata:metadata(last)};if(accessReceipt)repinAccess(input);return input;
}
module.exports={fixture,scope,access,tx,metadata,inputs,clone,sha,h,m,id,inventory,repinAccess};
