'use strict';
// Additive installer only. Network/SQL are supplied by the existing private driver.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../maintenance-cart-deploy/deploy.cjs');
const G=require('../graph-install/deploy.cjs');
const CART=require('../../n8n/growth/maintenance-cart-patch.cjs');
const P=require('../../n8n/growth/maintenance-tx-popup-patch.cjs');
const {FileStore,canonical,sha,projection,projects,SHAPE,STATE_SQL}=C;
const CONTRACT='maintenance-tx-install-v1',SCHEMA='crm_maintenance_candidate';
const DEP=['shrigma_email_claim_cart','shrigma_email_finish_cart','shrigma_flow_email_claim_tx','shrigma_email_claim_engagement','shrigma_email_claim_fish','shrigma_email_claim_aristo','shrigma_flow_slot','shrigma_flow_slot_wa_versioned_v1','shrigma_email_finish_fish','shrigma_email_finish_aristo','shrigma_email_transport_outcome'];
const FILES=['n8n/growth/maintenance-tx-popup.sql','n8n/growth/maintenance-tx-popup-protocol.cjs','n8n/growth/maintenance-tx-popup-patch.cjs','n8n/growth/maintenance-cart-patch.cjs','tools/maintenance-cart-deploy/deploy.cjs','tools/maintenance-tx-deploy/deploy.cjs','tools/maintenance-tx-deploy/api-adapter.cjs','tools/maintenance-tx-deploy/n8n-2.0.2.cjs','tools/maintenance-tx-deploy/cli.cjs','tools/graph-install/deploy.cjs'];
const clone=x=>JSON.parse(JSON.stringify(x)),same=(a,b)=>canonical(a)===canonical(b),lit=x=>"'"+String(x).replaceAll("'","''")+"'";
const extra=w=>Object.fromEntries(['description','pinData','tags','meta'].filter(k=>w[k]!==undefined).map(k=>[k,w[k]]));
const pg=w=>[...new Set(w.nodes.filter(n=>n.credentials?.postgres).map(n=>n.credentials.postgres.id))].sort();
function check(ok,code){if(!ok)throw Error('TX_DEPLOY_'+code);}
function published(w){check(w.active===true&&w.versionId&&w.activeVersionId===w.versionId,'NOT_PUBLISHED');check(w.activeVersion?.versionId===w.versionId&&same(w.activeVersion.nodes,w.nodes)&&same(w.activeVersion.connections,w.connections),'PUBLISHED_BODY_DRIFT');}
const GRAPH_SEAL_SQL="(SELECT obj_description(n.oid,'pg_namespace') FROM pg_namespace n WHERE n.nspname='crm_graph_candidate')";
const graphField=sql=>`CASE WHEN ${GRAPH_SEAL_SQL} IS NOT NULL THEN ${sql} END`;
// Legacy CART-only fixtures need not have the graph's send-log dependency.
// The value/fingerprint is identical when that dependency exists.
const OPTIONAL_PUBLIC_SHAPE=G.PUBLIC_SHAPE.replace("pg_get_serial_sequence('public.shrigma_send_log','id')","pg_get_serial_sequence(to_regclass('public.shrigma_send_log')::text,'id')");
const METADATA_SQL=`SELECT current_database() AS database,current_user AS role,
 (SELECT jsonb_agg(jsonb_build_object('name',p.proname,'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'hash',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'execute',has_function_privilege(current_user,p.oid,'EXECUTE')) ORDER BY p.proname,p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN (${DEP.map(lit).join(',')})) AS dependencies,
 to_regnamespace('${SCHEMA}')::text AS schema,${SHAPE} AS shape,
 (SELECT obj_description(n.oid,'pg_namespace') FROM pg_namespace n WHERE n.nspname='${SCHEMA}') AS seal,
 ${GRAPH_SEAL_SQL} AS graph_seal,${graphField(G.GRAPH_SHAPE)} AS graph_shape,
 ${graphField(G.MAINTENANCE_SHAPE)} AS graph_maintenance_shape,${graphField(OPTIONAL_PUBLIC_SHAPE)} AS graph_public_shape,
 ${graphField(G.ROLE_SQL)} AS graph_worker_role;`;
function sourceFiles(root){return Object.fromEntries(FILES.map(f=>[f,sha(fs.readFileSync(path.join(root,f),'utf8'))]));}
function depGuard(s){check(typeof s.database==='string'&&/^[a-zA-Z0-9_]+$/.test(s.database)&&typeof s.role==='string'&&s.dependencies?.length===DEP.length,'DB_IDENTITY');check(same(s.dependencies.map(f=>f.name).sort(),DEP.slice().sort())&&s.dependencies.every(f=>f.execute===true&&/^[a-f0-9]{32}$/.test(f.hash)),'DB_DEPENDENCIES');}
const keys=(o,k)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&same(Object.keys(o).sort(),k.slice().sort());
const md5=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),nonce=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
function cartSeal(seal){return keys(seal,['contract','ddl','nonce','shape'])&&seal.contract===C.CONTRACT&&nonce(seal.nonce)&&digest(seal.ddl)&&md5(seal.shape);}
function graphSeal(s,maintenance){
 let graph;try{graph=JSON.parse(s.graph_seal);}catch{throw Error('TX_DEPLOY_GRAPH_SEAL');}
 check(keys(maintenance,['contract','ddl','nonce','previous','shape'])&&maintenance.contract===G.MAINTENANCE_CONTRACT&&cartSeal(maintenance.previous)&&md5(maintenance.shape),'GRAPH_MAINTENANCE_CHAIN');
 check(keys(graph,['contract','ddl','nonce','previous','graph_shape','maintenance_shape','public_shape','worker_role'])&&graph.contract===G.CONTRACT&&nonce(graph.nonce)&&digest(graph.ddl)&&same(graph.previous,maintenance.previous)&&graph.nonce===maintenance.nonce&&graph.ddl===maintenance.ddl,'GRAPH_SEAL_CHAIN');
 check(md5(s.graph_shape)&&md5(s.graph_maintenance_shape)&&md5(s.graph_public_shape)&&graph.graph_shape===s.graph_shape&&graph.maintenance_shape===s.graph_maintenance_shape&&graph.public_shape===s.graph_public_shape&&same(graph.worker_role,s.graph_worker_role),'GRAPH_SEAL_DRIFT');
 check(keys(graph.worker_role,['name','login','superuser','createdb','createrole','inherit','replication','bypassrls','memberships'])&&graph.worker_role.name==='crm_graph_worker'&&['login','superuser','createdb','createrole','inherit','replication','bypassrls'].every(k=>graph.worker_role[k]===false)&&graph.worker_role.memberships===0,'GRAPH_ROLE');
 return graph;
}
function previousSeal(s){
 let seal;try{seal=JSON.parse(s.seal);}catch{throw Error('TX_DEPLOY_OLD_SEAL');}
 check(seal&&s.schema===SCHEMA&&md5(s.shape)&&s.shape===seal.shape,'OLD_SEAL');
 if(seal.contract===G.MAINTENANCE_CONTRACT)graphSeal(s,seal);else check(cartSeal(seal),'OLD_SEAL');return seal;
}
function graphExtensionGuard(s,planned){
 if(!planned)return;
 let graph;try{graph=JSON.parse(s.graph_seal);}catch{throw Error('TX_DEPLOY_GRAPH_SEAL');}
 check(same(graph,{...planned.before,maintenance_shape:s.graph_maintenance_shape,maintenance_extension:planned.extension})&&md5(s.graph_maintenance_shape)&&s.graph_shape===planned.before.graph_shape&&s.graph_public_shape===planned.before.public_shape&&same(s.graph_worker_role,planned.before.worker_role),'GRAPH_EXTENSION_DRIFT');
}
function gateGuard(s,expected){check(s?.control?.enabled===true&&s.control.mode==='open','GATE_NOT_OPEN');check(s.control.version===2&&(!expected||same(s.control,expected)),'GATE_DRIFT');}
function dependencySQL(s){return `IF current_database()<>${lit(s.database)} OR current_user<>${lit(s.role)} THEN RAISE EXCEPTION 'TX_DEPLOY_DB_IDENTITY';END IF;\n`+s.dependencies.map(f=>`IF (SELECT md5(pg_get_functiondef(to_regprocedure(${lit(f.signature)})))) IS DISTINCT FROM ${lit(f.hash)} THEN RAISE EXCEPTION 'TX_DEPLOY_DEPENDENCY_DRIFT';END IF;`).join('\n');}
function atomicInstall(root,before,control,nonce){
 depGuard(before);const previous=previousSeal(before);gateGuard({control});
 const src=fs.readFileSync(path.join(root,FILES[0]),'utf8');check(/^--[^]*?\bBEGIN;/.test(src)&&/COMMIT;\s*$/.test(src),'SQL_BOUNDARY');
 const ddl=src.replace(/\bBEGIN;/,'').replace(/COMMIT;\s*$/,'');check(!ddl.includes('$tx_ddl$'),'SQL_DELIMITER');
 const seal={contract:CONTRACT,nonce,ddl:sha(ddl),previous};
 const graph=previous.contract===G.MAINTENANCE_CONTRACT?{before:graphSeal(before,previous),extension:{contract:CONTRACT,nonce,ddl:seal.ddl,previous_maintenance_shape:before.graph_maintenance_shape}}:null;
 const graphGuard=graph?`IF NOT pg_try_advisory_xact_lock(hashtextextended('crm-graph-install',0)) THEN RAISE EXCEPTION 'TX_DEPLOY_GRAPH_BUSY';END IF;
 IF ${GRAPH_SEAL_SQL} IS DISTINCT FROM ${lit(before.graph_seal)} OR ${G.GRAPH_SHAPE} IS DISTINCT FROM ${lit(before.graph_shape)} OR ${G.MAINTENANCE_SHAPE} IS DISTINCT FROM ${lit(before.graph_maintenance_shape)} OR ${G.PUBLIC_SHAPE} IS DISTINCT FROM ${lit(before.graph_public_shape)} OR ${G.ROLE_SQL} IS DISTINCT FROM ${lit(JSON.stringify(before.graph_worker_role))}::jsonb THEN RAISE EXCEPTION 'TX_DEPLOY_GRAPH_DRIFT';END IF;`:'';
 const sql=`SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s';
DO $tx_install$ DECLARE current_control jsonb; next_seal jsonb; next_graph_seal jsonb; BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-cart-install',0));
 ${dependencySQL(before)}
 IF to_regnamespace('${SCHEMA}') IS NULL THEN RAISE EXCEPTION 'TX_DEPLOY_OLD_SEAL';END IF;
 SELECT to_jsonb(c) INTO STRICT current_control FROM ${SCHEMA}.control c WHERE singleton FOR SHARE;
 IF current_control IS DISTINCT FROM ${lit(JSON.stringify(control))}::jsonb THEN RAISE EXCEPTION 'TX_DEPLOY_GATE_DRIFT';END IF;
 IF ${SHAPE} IS DISTINCT FROM ${lit(before.shape)} OR (SELECT obj_description(n.oid,'pg_namespace')::jsonb FROM pg_namespace n WHERE n.nspname='${SCHEMA}') IS DISTINCT FROM ${lit(JSON.stringify(previous))}::jsonb THEN RAISE EXCEPTION 'TX_DEPLOY_OLD_SEAL_DRIFT';END IF;
 ${graphGuard}
 EXECUTE $tx_ddl$${ddl}$tx_ddl$;
 next_seal:=${lit(JSON.stringify(seal))}::jsonb||jsonb_build_object('shape',${SHAPE});
 EXECUTE format('COMMENT ON SCHEMA ${SCHEMA} IS %L',next_seal::text);
 ${graph?`next_graph_seal:=${lit(JSON.stringify(graph.before))}::jsonb||jsonb_build_object('maintenance_shape',${G.MAINTENANCE_SHAPE},'maintenance_extension',${lit(JSON.stringify(graph.extension))}::jsonb);
 EXECUTE format('COMMENT ON SCHEMA crm_graph_candidate IS %L',next_graph_seal::text);`:''}
END $tx_install$;
SELECT ${SHAPE} AS shape;`;
 return {sql,seal,graph};
}
class Installer{
 constructor({root,io,store}){this.root=root;this.io=io;this.store=store;}
 evidence(label,value){this.store.put('read-'+label+'-'+crypto.randomUUID(),value);}
 async prepare(guard){
  check(!this.store.has('plan'),'PLAN_EXISTS');check(guard?.producer&&guard?.retention&&guard?.cart?.producer&&guard?.cart?.consumer,'REVIEWED_GUARD');
  const w=await this.io.getWorkflow(P.TARGET);this.evidence('prepare-tx',w);check(w.id===P.TARGET,'SOURCE_IDENTITY');published(w);
  const producer=P.patchTxProducer(w,guard.producer),consumer=P.buildTxConsumer(w,guard.producer);
  const pr=projects(w),ids=pg(w),utility=await this.io.utilityPG();check(ids.length===1&&same(ids,utility.ids)&&same(pg(consumer),ids),'PG_REFERENCE');
  const cart=[];
  check(guard.cart.producer.id===CART.TARGET&&guard.cart.consumer.id!==CART.TARGET&&guard.cart.consumer.id!==P.TARGET,'CART_SCOPE');
  for(const g of [guard.cart.producer,guard.cart.consumer]){
   check(/^[A-Za-z0-9_-]{1,80}$/.test(g.id),'CART_SCOPE');const c=await this.io.getWorkflow(g.id);this.evidence('prepare-cart',c);published(c);
   check(c.id===g.id&&c.versionId===g.version&&P.digest(c)===g.workflowHash&&same(projects(c),pr)&&same(pg(c),ids),'CART_DRIFT');cart.push(c);
  }
  check(cart[0].nodes.some(n=>n.parameters?.query==='SELECT * FROM crm_maintenance_candidate.cart_admit_claim_v1($1::jsonb);')&&cart[1].nodes.some(n=>n.parameters?.query==='SELECT * FROM crm_maintenance_candidate.cart_next_v1($1::text);'),'CART_NOT_RETAINED');
  const before=await this.io.metadata();this.evidence('prepare-sql',before);depGuard(before);check(before.database==='listmonk','DATABASE_SCOPE');
  const old=previousSeal(before);check(guard.retention.seal_sha256===sha(old)&&guard.retention.shape===before.shape&&guard.retention.control_version===2,'UNREVIEWED_RETENTION');
  const state=await this.io.state();gateGuard(state);const nonce=crypto.randomUUID(),migration=atomicInstall(this.root,before,state.control,nonce);
  consumer.name='Growth · Pedidos retidos · '+nonce;
  const p={contract:CONTRACT,nonce,prepared_at:new Date().toISOString(),sources:sourceFiles(this.root),before,control:state.control,source:w,producer,consumer,cart,projects:pr,pg:ids,utility,migration};
  p.hash=sha(p);this.store.put('plan',p);return this.summary(p);
 }
 plan(approval){const p=this.store.read('plan'),x=clone(p);delete x.hash;check(p.contract===CONTRACT&&sha(x)===p.hash,'PLAN_HASH');check(same(p.sources,sourceFiles(this.root)),'SOURCE_DRIFT');if(approval!==undefined)check(approval===p.hash,'APPROVAL');return p;}
 summary(p){return {contract:CONTRACT,plan_hash:p.hash,source_version:p.source.versionId,producer_hash:sha(projection(p.producer)),consumer_hash:sha(projection(p.consumer)),sql_hash:sha(p.migration.sql),previous_seal_hash:sha(p.migration.seal.previous),cart_versions:p.cart.map(w=>({id:w.id,version:w.versionId})),gate_version:2,consumer_initially_active:false,scope:['fish','aristo'],popup:false,vip:false,restart:false,installed:false};}
 async db(p,installed=true){
  const s=await this.io.metadata();this.evidence('sql',s);depGuard(s);check(s.database===p.before.database&&s.role===p.before.role&&same(s.dependencies,p.before.dependencies),'DEPENDENCY_DRIFT');
  if(installed){let seal;try{seal=JSON.parse(s.seal);}catch{throw Error('TX_DEPLOY_SEAL');}check(s.schema===SCHEMA&&same({...seal,shape:undefined},{...p.migration.seal,shape:undefined})&&seal.shape===s.shape&&s.shape,'SCHEMA_DRIFT');graphExtensionGuard(s,p.migration.graph);}
  else check(same(previousSeal(s),p.migration.seal.previous)&&s.shape===p.before.shape,'OLD_SEAL_DRIFT');
  check(same(await this.io.utilityPG(),p.utility),'UTILITY_DRIFT');return s;
 }
 async protectedCart(p){for(const original of p.cart){const w=await this.io.getWorkflow(original.id);this.evidence('protected-cart',w);published(w);check(same(w,original),'CART_DRIFT');}}
 async gate(p,installed=true){await this.db(p,installed);await this.protectedCart(p);const s=await this.io.state();gateGuard(s,p.control);return s;}
 async source(p,kind='original',requirePublished=true){
  const w=await this.io.getWorkflow(P.TARGET);this.evidence('producer',w);check(w.id===P.TARGET&&w.active===true&&same(projects(w),p.projects)&&same(pg(w),p.pg),'SOURCE_IDENTITY');
  check(same(projection(w),projection(kind==='original'?p.source:p.producer))&&same(extra(w),extra(p.source)),'WORKFLOW_DRIFT');
  if(kind==='candidate'&&this.store.has('patch-verified'))check(w.versionId===this.receipt('patch').version,'CANDIDATE_VERSION_DRIFT');
  if(kind==='original')check(w.versionId===p.source.versionId&&w.activeVersionId===p.source.activeVersionId,'VERSION_DRIFT');
  if(requirePublished)published(w);return w;
 }
 async consumer(p,id,active){
  check(typeof id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(id)&&id!==P.TARGET&&!p.cart.some(w=>w.id===id),'CONSUMER_ID');
  const w=await this.io.getWorkflow(id);this.evidence('consumer',w);check(w.id===id&&typeof w.versionId==='string'&&w.versionId.length>0&&same(projects(w),p.projects)&&same(projection(w),projection(p.consumer))&&w.active===active,'CONSUMER_DRIFT');
  if(this.store.has('create-verified'))check(w.versionId===this.receipt('create').version,'CONSUMER_VERSION_DRIFT');if(active)published(w);return w;
 }
 receipt(phase){check(this.store.has(phase+'-verified'),'PHASE_REQUIRED_'+phase);return this.store.read(phase+'-verified');}
 async write(phase,intent,operation,verify){check(!this.store.has(phase+'-intent'),'UNCERTAIN_RECONCILE_'+phase);this.store.put(phase+'-intent',{...intent,at:new Date().toISOString()});const response=await operation();this.store.put(phase+'-response',{response});const result=await verify(response);this.store.put(phase+'-verified',result);return result;}
 async phase(phase,approval,options={}){
  check(typeof approval==='string'&&/^[a-f0-9]{64}$/.test(approval),'APPROVAL_REQUIRED');const p=this.plan(approval);check(!this.store.has(phase+'-intent')&&!this.store.has(phase+'-verified'),'UNCERTAIN_RECONCILE_'+phase);
  if(phase==='install'){await this.gate(p,false);await this.source(p);return this.write(phase,{sql_hash:sha(p.migration.sql)},()=>this.io.sql(p.migration.sql),()=>this.verifyInstall(p));}
  if(phase==='create'){this.receipt('install');await this.gate(p);await this.source(p);return this.write(phase,{name:p.consumer.name,hash:sha(projection(p.consumer))},()=>this.io.createWorkflow(projection(p.consumer)),r=>this.verifyCreate(p,r.id));}
  if(phase==='patch'){await this.gate(p);await this.consumer(p,this.receipt('create').id,false);const w=await this.source(p);return this.write(phase,{version:w.versionId,hash:sha(projection(w))},()=>this.io.putWorkflow(P.TARGET,projection(p.producer)),()=>this.verifyPatch(p));}
  if(phase==='publish'){
   const saved=this.receipt('patch');await this.gate(p);await this.consumer(p,this.receipt('create').id,false);const w=await this.source(p,'candidate',false);check(w.versionId===saved.version,'SAVED_VERSION_DRIFT');
   if(w.activeVersionId===w.versionId){const r=await this.verifyPublish(p);this.store.put('publish-verified',r);return r;}
   return this.write(phase,{version:w.versionId,hash:sha(projection(w))},()=>this.io.activateWorkflow(P.TARGET,w.versionId),()=>this.verifyPublish(p));
  }
  if(phase==='activate'){
   check(options.activationApproval===p.hash+':activate','ACTIVATION_REVIEW');this.receipt('publish');await this.gate(p);await this.source(p,'candidate');const w=await this.consumer(p,this.receipt('create').id,false);
   return this.write(phase,{id:w.id,version:w.versionId},()=>this.io.activateWorkflow(w.id,w.versionId),()=>this.verifyActive(p));
  }
  if(phase==='halt'){
   // Only stop the new consumer. Do not remove retained inputs or restore a bypass.
   await this.db(p);await this.protectedCart(p);await this.source(p,'candidate');const w=await this.consumer(p,this.receipt('create').id,true);
   return this.write(phase,{id:w.id,version:w.versionId},()=>this.io.deactivateWorkflow(w.id),()=>this.verifyHalt(p));
  }
  throw Error('TX_DEPLOY_PHASE');
 }
 async verifyInstall(p){const s=await this.gate(p);await this.source(p);return {installed:true,consumer_created:false,gate_version:s.control.version,previous_seal_preserved:true,shape:(await this.io.metadata()).shape};}
 async verifyCreate(p,id){await this.gate(p);await this.source(p);const w=await this.consumer(p,id,false);return {id:w.id,version:w.versionId,active:false};}
 async verifyPatch(p){await this.gate(p);await this.consumer(p,this.receipt('create').id,false);const w=await this.source(p,'candidate',false);check(w.versionId!==p.source.versionId,'PUT_NOT_CONFIRMED');return {version:w.versionId,active_version:w.activeVersionId,hash:sha(projection(w))};}
 async verifyPublish(p){await this.gate(p);await this.consumer(p,this.receipt('create').id,false);const w=await this.source(p,'candidate');check(w.versionId===this.receipt('patch').version,'PUBLISH_VERSION');return {version:w.versionId,published:true,hash:sha(projection(w))};}
 async verifyActive(p){await this.gate(p);await this.source(p,'candidate');const w=await this.consumer(p,this.receipt('create').id,true);return {id:w.id,version:w.versionId,active:true,drained:false,runtime_acceptance_pending:true};}
 async verifyHalt(p){await this.db(p);await this.protectedCart(p);await this.source(p,'candidate');const id=this.receipt('create').id;await this.consumer(p,id,false);return {id,active:false,drained:false,queue_and_claims_preserved:true};}
 async reconcile(phase,options={}){
  const p=this.plan();check(this.store.has(phase+'-intent')&&!this.store.has(phase+'-verified'),'RECONCILE_STATE');let r;
  if(phase==='install')r=await this.verifyInstall(p);
  else if(phase==='create'){const saved=this.store.has('create-response')?this.store.read('create-response').response:null;r=await this.verifyCreate(p,saved?.id||options.consumerId);}
  else if(phase==='patch')r=await this.verifyPatch(p);
  else if(phase==='publish')r=await this.verifyPublish(p);
  else if(phase==='activate')r=await this.verifyActive(p);
  else if(phase==='halt')r=await this.verifyHalt(p);
  else throw Error('TX_DEPLOY_PHASE');
  this.store.put(phase+'-verified',{...r,reconciled_read_only:true});return {...r,reconciled_read_only:true};
 }
 async verify(){const p=this.plan(),s=await this.gate(p),w=await this.source(p,'candidate'),c=await this.consumer(p,this.receipt('create').id,this.store.has('activate-verified')&&!this.store.has('halt-verified'));return {contract:CONTRACT,published_version:w.versionId,consumer_active:c.active,control:s.control,event_count:s.event_count,pending_count:s.pending_count,non_cart_count:s.non_cart_count,cart_preserved:true,previous_seal_hash:sha(p.migration.seal.previous),drained:false,runtime_acceptance_pending:true};}
}
module.exports={Installer,FileStore,atomicInstall,projection,projects,sourceFiles,sha,canonical,METADATA_SQL,STATE_SQL,SHAPE,CONTRACT,previousSeal};
