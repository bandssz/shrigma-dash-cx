'use strict';
// Pure receipt/lineage validation. No credential generation, SQL mutation, IO or
// authority to enable LOGIN. The caller supplies independently reviewed pins.
const {canonical,sha}=require('../maintenance-cart-deploy/deploy.cjs');
const CONTRACT='crm-graph-worker-access-v1',GRAPH='crm-graph-install-v1',MAINTENANCE='maintenance-cart-graph-install-v1',CART='maintenance-cart-install-v1',TX='maintenance-tx-install-v1';
const ROLE='crm_graph_worker';
const ROLE_KEYS=['name','login','superuser','createdb','createrole','inherit','replication','bypassrls','memberships'];
const GRAPH_KEYS=['contract','nonce','ddl','previous','graph_shape','maintenance_shape','public_shape','worker_role'];
const EXTENSION_KEYS=['contract','nonce','ddl','base_plan_hash','base_receipt_hash','previous_graph_seal_hash','role_oid','previous_role','connection_scope_hash','credential_version','auth_proof_hash'];
const SCOPE_POLICY='audited-current-database-privileges-v1';
const APP_PRIVILEGES=['non_system_read','non_system_write','non_system_create','non_system_definer_execute','foreign_server_usage'];
const DIAGNOSTIC_KEYS=['relation_oid','extension_oid','extension_name','extension_version','definition_hash','acl_hash','dependency_hash'];
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),same=(a,b)=>canonical(a)===canonical(b);
const keys=(x,n)=>object(x)&&same(Object.keys(x).sort(),n.slice().sort());
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),md5=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x);
const nonce=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const oid=x=>typeof x==='string'&&/^[1-9][0-9]{0,9}$/.test(x)&&BigInt(x)<=4294967295n;
function check(ok,code){if(!ok)throw Error('GRAPH_WORKER_ACCESS_'+code);}
function parse(value,code){if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{throw Error('GRAPH_WORKER_ACCESS_'+code);}}
function role(value,login){check(keys(value,ROLE_KEYS)&&value.name===ROLE&&value.login===login&&value.memberships===0&&['superuser','createdb','createrole','inherit','replication','bypassrls'].every(k=>value[k]===false),'ROLE');return value;}
function identity(value,login){
 check(keys(value,['oid','role','settings','valid_until','connection_limit','database_settings'])&&oid(value.oid),'ROLE_IDENTITY');role(value.role,login);
 // The initial contract preserves the observed unconfigured role. New settings,
 // expiration or connection policy require a different reviewed transition.
 check(value.settings===null&&value.valid_until===null&&value.connection_limit===-1&&same(value.database_settings,[]),'ROLE_SETTINGS');return value;
}
function cart(seal){check(keys(seal,['contract','nonce','ddl','shape'])&&seal.contract===CART&&nonce(seal.nonce)&&digest(seal.ddl)&&md5(seal.shape),'CART_SEAL');return seal;}
function graph(seal){
 const extensions=['maintenance_extension','worker_access_extension'].filter(k=>Object.hasOwn(seal||{},k));
 check(keys(seal,[...GRAPH_KEYS,...extensions])&&seal.contract===GRAPH&&nonce(seal.nonce)&&digest(seal.ddl)&&['graph_shape','maintenance_shape','public_shape'].every(k=>md5(seal[k])),'GRAPH_SEAL');cart(seal.previous);role(seal.worker_role,extensions.includes('worker_access_extension'));
 if(seal.maintenance_extension){const e=seal.maintenance_extension;check(keys(e,['contract','nonce','ddl','previous_maintenance_shape'])&&e.contract===TX&&nonce(e.nonce)&&digest(e.ddl)&&md5(e.previous_maintenance_shape),'TX_EXTENSION');}
 if(seal.worker_access_extension){const e=seal.worker_access_extension;check(keys(e,EXTENSION_KEYS)&&e.contract===CONTRACT&&nonce(e.nonce)&&['ddl','base_plan_hash','base_receipt_hash','previous_graph_seal_hash','connection_scope_hash','auth_proof_hash'].every(k=>digest(e[k]))&&oid(e.role_oid)&&typeof e.credential_version==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(e.credential_version),'ACCESS_EXTENSION');role(e.previous_role,false);}
 return seal;
}
function maintenance(seal){
 check(keys(seal,['contract','nonce','ddl','previous','shape'])&&[MAINTENANCE,TX].includes(seal.contract)&&nonce(seal.nonce)&&digest(seal.ddl)&&md5(seal.shape),'MAINTENANCE_SEAL');
 if(seal.contract===MAINTENANCE)cart(seal.previous);else{check(seal.previous?.contract===MAINTENANCE,'MAINTENANCE_CHAIN');maintenance(seal.previous);}return seal;
}
function state(value){
 check(keys(value,['graph_seal','maintenance_seal','role_identity']),'STATE');const g=graph(value.graph_seal),m=maintenance(value.maintenance_seal);identity(value.role_identity,!!g.worker_access_extension);
 check(same(g.worker_role,value.role_identity.role),'STATE_ROLE');
 const base=m.contract===TX?m.previous:m;
 check(g.nonce===base.nonce&&g.ddl===base.ddl&&same(g.previous,base.previous),'PAIRED_SEALS');
 check(!!g.maintenance_extension===(m.contract===TX),'PAIRED_TX');
 if(g.maintenance_extension){const e=g.maintenance_extension;check(e.nonce===m.nonce&&e.ddl===m.ddl,'PAIRED_TX');}
 return value;
}
function inventory(value){
 check(Array.isArray(value)&&value.length>0,'DATABASE_INVENTORY');let previous=0n;const names=new Set();
 for(const d of value){check(keys(d,['oid','name'])&&oid(d.oid)&&BigInt(d.oid)>previous&&typeof d.name==='string'&&d.name.length>0&&d.name.length<=63&&!/[\0\r\n]/.test(d.name)&&!names.has(d.name),'DATABASE_INVENTORY');previous=BigInt(d.oid);names.add(d.name);}return value;
}
function diagnostic(value){check(keys(value,DIAGNOSTIC_KEYS)&&oid(value.relation_oid)&&oid(value.extension_oid)&&value.extension_name==='pg_stat_statements'&&value.extension_version==='1.11'&&['definition_hash','acl_hash','dependency_hash'].every(k=>digest(value[k])),'DIAGNOSTIC_EXCEPTION');}
function validateConnectionScope(scope,roleOid,review){
 check(keys(scope,['database','role','role_oid','policy','database_audits'])&&scope.database==='listmonk'&&scope.role===ROLE&&scope.role_oid===roleOid&&oid(roleOid)&&scope.policy===SCOPE_POLICY&&Array.isArray(scope.database_audits)&&scope.database_audits.length>0,'CONNECTION_SCOPE');
 check(object(review)&&Array.isArray(review.diagnostic_read_exceptions),'SCOPE_REVIEW');inventory(review.database_inventory);
 check(same(scope.database_audits.map(a=>({oid:a.oid,name:a.name})),review.database_inventory),'DATABASE_INVENTORY_DRIFT');
 const expectedExceptions=new Map();let prior='';
 for(const item of review.diagnostic_read_exceptions){
  check(keys(item,['database_oid',...DIAGNOSTIC_KEYS])&&review.database_inventory.some(d=>d.oid===item.database_oid),'DIAGNOSTIC_REVIEW');const {database_oid,...exception}=item;diagnostic(exception);
  const key=BigInt(database_oid).toString().padStart(10,'0')+':'+BigInt(exception.relation_oid).toString().padStart(10,'0');check(key>prior,'DIAGNOSTIC_REVIEW');prior=key;
  const list=expectedExceptions.get(database_oid)||[];list.push(exception);check(list.length<=2,'DIAGNOSTIC_REVIEW');expectedExceptions.set(database_oid,list);
 }
 const seenNames=new Set();let previous=0n,target=0;
 for(const a of scope.database_audits){
  check(keys(a,['oid','name','connect','temporary','create','catalog_hash','diagnostic_read_exceptions',...APP_PRIVILEGES])&&oid(a.oid)&&BigInt(a.oid)>previous&&typeof a.name==='string'&&a.name.length>0&&a.name.length<=63&&!/[\0\r\n]/.test(a.name)&&!seenNames.has(a.name)&&digest(a.catalog_hash)&&['connect','temporary','create',...APP_PRIVILEGES].every(k=>typeof a[k]==='boolean'),'DATABASE_AUDIT');
  check(same(a.diagnostic_read_exceptions,expectedExceptions.get(a.oid)||[]),'DIAGNOSTIC_REVIEW_DRIFT');
  previous=BigInt(a.oid);seenNames.add(a.name);check(a.create===false,'DATABASE_CREATE');
  if(a.name==='listmonk'){target++;check(a.connect===true,'TARGET_CONNECT');}
  else check(APP_PRIVILEGES.every(k=>a[k]===false),'OTHER_DATABASE_APPLICATION_ACCESS');
 }
 check(target===1,'TARGET_DATABASE');return scope;
}
function baseState(anchor){
 check(keys(anchor,['plan','install_verified','metadata','role_identity','reviewed']),'BASE_ANCHOR');
 const {plan:p,install_verified:v,metadata:m,role_identity:i,reviewed:r}=anchor;
 check(keys(r,['plan_hash','receipt_hash','metadata_hash','identity_hash','sources'])&&['plan_hash','receipt_hash','metadata_hash','identity_hash'].every(k=>digest(r[k])),'BASE_REVIEW');
 check(object(p)&&p.contract===GRAPH&&p.hash===r.plan_hash,'BASE_PLAN');const {hash,...body}=p;check(sha(body)===hash&&same(p.sources,r.sources)&&object(r.sources)&&Object.keys(r.sources).length>0&&Object.values(r.sources).every(digest),'BASE_PLAN');
 check(object(v)&&sha(v)===r.receipt_hash&&v.contract===GRAPH&&v.plan_hash===hash&&v.sql_hash===sha(p.migration?.sql)&&v.installed===true&&v.readback_verified===true&&v.execution_enabled===false&&v.worker_login===false&&v.activation_available===false,'BASE_RECEIPT');
 check(object(m)&&sha(m)===r.metadata_hash&&m.database==='listmonk'&&m.role==='postgres'&&sha(i)===r.identity_hash,'BASE_METADATA');identity(i,false);
 const g=graph(parse(m.graph_seal,'BASE_GRAPH')),ms=maintenance(parse(m.maintenance_seal,'BASE_MAINTENANCE'));
 check(!g.worker_access_extension&&!g.maintenance_extension&&ms.contract===MAINTENANCE,'BASE_EXTENSIONS');
 const {graph_shape,maintenance_shape,public_shape,worker_role,...base}=g;
 check(same(base,p.migration.seal)&&same(ms,{...p.migration.maintenanceSeal,shape:m.maintenance_legacy_shape})&&same(v.baseline,{graph_shape,maintenance_shape,public_shape,worker_role,maintenance_legacy_shape:m.maintenance_legacy_shape}),'BASE_LINEAGE');
 check(g.graph_shape===m.graph_shape&&g.maintenance_shape===m.maintenance_shape&&g.public_shape===m.public_shape&&same(g.worker_role,m.worker_role)&&same(i.role,m.worker_role),'BASE_DRIFT');
 check(same(m.graph_control,{singleton:true,enabled:false})&&m.maintenance_control?.enabled===true&&m.maintenance_control.mode==='open'&&m.maintenance_control.version===2&&m.maintenance_control.cutoff_at===null&&same(m.public_create_schemas,[]),'BASE_CONTROLS');
 return state({graph_seal:g,maintenance_seal:ms,role_identity:i});
}
function accessTransition(receipt,anchor,plan,review){
 check(keys(receipt,['contract','nonce','plan_hash','sql_hash','before','after','connection_scope','auth_proof_hash'])&&receipt.contract===CONTRACT&&nonce(receipt.nonce)&&['plan_hash','sql_hash','auth_proof_hash'].every(k=>digest(receipt[k])),'ACCESS_RECEIPT');
 check(keys(review,['plan_hash','receipt_hash','sql_hash','body_hash','sources','database_inventory','diagnostic_read_exceptions'])&&['plan_hash','receipt_hash','sql_hash','body_hash'].every(k=>digest(review[k])),'ACCESS_REVIEW');
 check(keys(plan,['contract','nonce','before','connection_scope','database_inventory','auth_proof_hash','sources','migration','hash'])&&plan.contract===CONTRACT&&plan.nonce===receipt.nonce&&plan.hash===review.plan_hash&&receipt.plan_hash===plan.hash,'ACCESS_PLAN');const {hash,...body}=plan;
 check(sha(body)===hash&&same(plan.sources,review.sources)&&object(review.sources)&&Object.keys(review.sources).length>0&&Object.values(review.sources).every(digest),'ACCESS_PLAN');
 check(keys(plan.migration,['body','sql','extension'])&&typeof plan.migration.body==='string'&&plan.migration.body.length>0&&typeof plan.migration.sql==='string'&&plan.migration.sql.length>0&&sha(plan.migration.body)===review.body_hash&&sha(plan.migration.sql)===review.sql_hash&&receipt.sql_hash===review.sql_hash&&sha(receipt)===review.receipt_hash,'ACCESS_EXECUTION_PIN');
 check(same(plan.before,receipt.before)&&same(plan.connection_scope,receipt.connection_scope)&&same(plan.database_inventory,review.database_inventory)&&plan.auth_proof_hash===receipt.auth_proof_hash,'ACCESS_PLAN_RECEIPT');
 const before=state(receipt.before),after=state(receipt.after),g=before.graph_seal,e=after.graph_seal.worker_access_extension;
 check(!g.worker_access_extension&&e&&same(e,plan.migration.extension)&&e.ddl===review.body_hash&&e.nonce===receipt.nonce&&e.base_plan_hash===anchor.reviewed.plan_hash&&e.base_receipt_hash===anchor.reviewed.receipt_hash&&e.previous_graph_seal_hash===sha(g)&&e.role_oid===before.role_identity.oid&&e.auth_proof_hash===receipt.auth_proof_hash&&same(e.previous_role,g.worker_role),'ACCESS_PREDECESSOR');
 validateConnectionScope(receipt.connection_scope,e.role_oid,review);check(e.connection_scope_hash===sha(receipt.connection_scope),'SCOPE_HASH');
 const nextRole={...g.worker_role,login:true};
 check(same(after,{graph_seal:{...g,worker_role:nextRole,worker_access_extension:e},maintenance_seal:before.maintenance_seal,role_identity:{...before.role_identity,role:nextRole}}),'ACCESS_DIFFERENCE');
 return {kind:'access',before,after};
}
function txTransition(receipt){
 check(keys(receipt,['contract','before','after','extension'])&&receipt.contract===TX,'TX_RECEIPT');const before=state(receipt.before),after=state(receipt.after),e=receipt.extension;
 check(!before.graph_seal.maintenance_extension&&before.maintenance_seal.contract===MAINTENANCE&&same(e,after.graph_seal.maintenance_extension)&&e.previous_maintenance_shape===before.graph_seal.maintenance_shape,'TX_PREDECESSOR');
 check(same(after,{graph_seal:{...before.graph_seal,maintenance_shape:after.graph_seal.maintenance_shape,maintenance_extension:e},maintenance_seal:{contract:TX,nonce:e.nonce,ddl:e.ddl,previous:before.maintenance_seal,shape:after.maintenance_seal.shape},role_identity:before.role_identity}),'TX_DIFFERENCE');
 return {kind:'tx',before,after};
}
function validateOperational({metadata,baseAnchor,accessReceipt=null,accessPlan=null,accessReview=null,txReceipt=null}={}){
 let current=baseState(baseAnchor);const transitions=[];
 if(accessReceipt!==null)transitions.push(accessTransition(accessReceipt,baseAnchor,accessPlan,accessReview));
 else check(accessPlan===null&&accessReview===null,'ACCESS_UNEXPECTED');
 if(txReceipt!==null)transitions.push(txTransition(txReceipt));
 const order=['base'];
 while(transitions.length){const matches=transitions.map((x,n)=>same(x.before,current)?n:-1).filter(n=>n>=0);check(matches.length===1,'CHAIN_ORDER');const next=transitions.splice(matches[0],1)[0];current=next.after;order.push(next.kind);}
 check(object(metadata)&&metadata.database==='listmonk'&&metadata.role==='postgres','METADATA');
 const actual=state({graph_seal:parse(metadata.graph_seal,'GRAPH_SEAL'),maintenance_seal:parse(metadata.maintenance_seal,'MAINTENANCE_SEAL'),role_identity:metadata.worker_role_identity});
 check(same(actual,current),'CURRENT_CHAIN');
 check(actual.graph_seal.graph_shape===metadata.graph_shape&&actual.graph_seal.maintenance_shape===metadata.maintenance_shape&&actual.graph_seal.public_shape===metadata.public_shape&&actual.maintenance_seal.shape===metadata.maintenance_legacy_shape&&same(actual.graph_seal.worker_role,metadata.worker_role),'CURRENT_DRIFT');
 return Object.freeze({contract:CONTRACT,structural_valid:true,policy_valid:accessReceipt!==null,online_auth_verified:false,login_authorized:false,execution_authorized:false,worker_login:actual.graph_seal.worker_role.login,role_oid:actual.role_identity.oid,order:Object.freeze(order),connection_isolated:false});
}
// Read-only catalog expression; the OID anchor is established by a fresh
// reviewed NOLOGIN read, not retroactively attributed to the old base receipt.
const ROLE_IDENTITY_SQL=`(SELECT jsonb_build_object('oid',r.oid::text,'role',jsonb_build_object('name',r.rolname,'login',r.rolcanlogin,'superuser',r.rolsuper,'createdb',r.rolcreatedb,'createrole',r.rolcreaterole,'inherit',r.rolinherit,'replication',r.rolreplication,'bypassrls',r.rolbypassrls,'memberships',(SELECT count(*) FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)),'settings',r.rolconfig,'valid_until',r.rolvaliduntil::text,'connection_limit',r.rolconnlimit,'database_settings',(SELECT coalesce(jsonb_agg(jsonb_build_object('database_oid',s.setdatabase::text,'settings',s.setconfig) ORDER BY s.setdatabase),'[]'::jsonb) FROM pg_db_role_setting s WHERE s.setrole=r.oid)) FROM pg_roles r WHERE r.rolname='crm_graph_worker')`;
module.exports={CONTRACT,ROLE,SCOPE_POLICY,ROLE_IDENTITY_SQL,validateOperational,validateConnectionScope};
