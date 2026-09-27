'use strict';
// No network, secrets, default endpoint or automatic retry. All effects are injected.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const P=require('../../n8n/growth/maintenance-cart-patch.cjs');
const CONTRACT='maintenance-cart-install-v1',SCHEMA='crm_maintenance_candidate';
const DEP=['shrigma_email_claim_cart','shrigma_email_finish_cart','shrigma_flow_email_claim_tx','shrigma_email_claim_engagement'];
const FILES=['n8n/growth/maintenance-retention.sql','n8n/growth/maintenance-cart.sql','n8n/growth/maintenance-cart-patch.cjs','tools/maintenance-cart-deploy/deploy.cjs','tools/maintenance-cart-deploy/api-adapter.cjs','tools/maintenance-cart-deploy/cli.cjs'];
const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
const sha=x=>crypto.createHash('sha256').update(typeof x==='string'?x:canonical(x)).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
const extra=w=>Object.fromEntries(['description','pinData','tags','meta'].filter(k=>w[k]!==undefined).map(k=>[k,w[k]]));
function check(ok,code){if(!ok)throw Error('CART_DEPLOY_'+code);}
const same=(a,b)=>canonical(a)===canonical(b),lit=s=>"'"+String(s).replaceAll("'","''")+"'";
const projection=w=>Object.fromEntries(['name','nodes','connections','settings'].map(k=>[k,w[k]]));
function projects(w){const p=(w.shared||[]).map(x=>x.projectId).filter(Boolean).sort();check(p.length===1,'PROJECT_AMBIGUOUS');return p;}
const pg=w=>[...new Set(w.nodes.filter(n=>n.credentials?.postgres).map(n=>n.credentials.postgres.id))].sort();
function published(w){check(w.id===P.TARGET&&w.active===true&&w.versionId&&w.activeVersionId===w.versionId,'NOT_PUBLISHED');check(w.activeVersion?.versionId===w.versionId&&same(w.activeVersion.nodes,w.nodes)&&same(w.activeVersion.connections,w.connections),'PUBLISHED_BODY_DRIFT');}
// Full definitions/structure, without rows or PII. Catalog changes invalidate the installation seal.
const CATALOG=`jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace=n.oid),
 'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl,'rls',c.relrowsecurity,'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'index',CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) END,'sequence',(SELECT to_jsonb(s)-'seqrelid' FROM pg_sequence s WHERE s.seqrelid=c.oid)) ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace=n.oid),'owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl)`;
const SHAPE=`(SELECT md5((${CATALOG})::text) FROM pg_namespace n WHERE n.nspname='${SCHEMA}')`;
const METADATA_SQL=`SELECT current_database() AS database,current_user AS role,
 (SELECT jsonb_agg(jsonb_build_object('name',p.proname,'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'hash',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'execute',has_function_privilege(current_user,p.oid,'EXECUTE')) ORDER BY p.proname,p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN (${DEP.map(lit).join(',')})) AS dependencies,
 to_regnamespace('${SCHEMA}')::text AS schema,${SHAPE} AS shape,
 (SELECT obj_description(n.oid,'pg_namespace') FROM pg_namespace n WHERE n.nspname='${SCHEMA}') AS seal;`;
const STATE_SQL=`SELECT (SELECT to_jsonb(c) FROM ${SCHEMA}.control c WHERE singleton) AS control,
 (SELECT count(*)::text FROM ${SCHEMA}.event) AS event_count,
 (SELECT count(*)::text FROM ${SCHEMA}.event WHERE state IN('queued','claimed','review_required','outcome_unknown')) AS pending_count,
 (SELECT count(*)::text FROM ${SCHEMA}.event WHERE kind<>'cart') AS non_cart_count;`;
function sourceFiles(root){return Object.fromEntries(FILES.map(f=>[f,sha(fs.readFileSync(path.join(root,f),'utf8'))]));}
function depGuard(s){check(typeof s.database==='string'&&/^[a-zA-Z0-9_]+$/.test(s.database)&&typeof s.role==='string'&&s.dependencies?.length===4,'DB_IDENTITY');check(same(s.dependencies.map(f=>f.name).sort(),DEP.slice().sort())&&s.dependencies.every(f=>f.execute===true),'DB_DEPENDENCIES');}
function dependencySQL(s){return `IF current_database()<>${lit(s.database)} OR current_user<>${lit(s.role)} THEN RAISE EXCEPTION 'CART_DEPLOY_DB_IDENTITY';END IF;\n`+s.dependencies.map(f=>`IF (SELECT md5(pg_get_functiondef(to_regprocedure(${lit(f.signature)})))) IS DISTINCT FROM ${lit(f.hash)} THEN RAISE EXCEPTION 'CART_DEPLOY_DEPENDENCY_DRIFT';END IF;`).join('\n');}
function ddlBody(src){check(/^--[^]*?\bBEGIN;/.test(src)&&/COMMIT;\s*$/.test(src),'SQL_BOUNDARY');return src.replace(/\bBEGIN;/,'').replace(/COMMIT;\s*$/,'');}
function atomicInstall(root,before,nonce){
 depGuard(before);check(!before.schema,'SCHEMA_EXISTS');
 const ddl=FILES.slice(0,2).map(f=>ddlBody(fs.readFileSync(path.join(root,f),'utf8'))).join('\n');
 check(!ddl.includes('$cart_ddl$'),'SQL_DELIMITER');
 const base={contract:CONTRACT,nonce,ddl:sha(ddl)};
 const sql=`SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s';
DO $cart_install$ DECLARE seal jsonb; BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('maintenance-cart-install',0));
 ${dependencySQL(before)}
 IF to_regnamespace('${SCHEMA}') IS NOT NULL THEN RAISE EXCEPTION 'CART_DEPLOY_SCHEMA_EXISTS';END IF;
 EXECUTE $cart_ddl$${ddl}$cart_ddl$;
 seal:=${lit(JSON.stringify(base))}::jsonb||jsonb_build_object('shape',${SHAPE});
 EXECUTE format('COMMENT ON SCHEMA ${SCHEMA} IS %L',seal::text);
END $cart_install$;
SELECT ${SHAPE} AS shape;`;
 return {sql,seal:base};
}
class FileStore{
 constructor(dir){this.dir=dir;fs.mkdirSync(dir,{recursive:true,mode:0o700});}
 has(name){return fs.existsSync(path.join(this.dir,name+'.json'));}
 read(name){return JSON.parse(fs.readFileSync(path.join(this.dir,name+'.json'),'utf8'));}
 put(name,value){const p=path.join(this.dir,name+'.json'),fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(this.dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
}
class Installer{
 constructor({root,io,store}){this.root=root;this.io=io;this.store=store;}
 evidence(label,value){this.store.put('read-'+label+'-'+crypto.randomUUID(),value);}
 async prepare(approvedGuard){
  check(!this.store.has('plan'),'PLAN_EXISTS');const w=await this.io.getWorkflow(P.TARGET);this.evidence('prepare-source',w);published(w);
  // The caller supplies the previously reviewed export guard; never bless an unknown export.
  const producer=P.patchCartProducer(w,approvedGuard),consumer=P.buildCartConsumer(w,approvedGuard);
  const pr=projects(w),ids=pg(w),util=await this.io.utilityPG();
  check(ids.length===1&&same(ids,util.ids),'PG_REFERENCE');
  const before=await this.io.metadata();depGuard(before);check(before.database==='listmonk','DATABASE_SCOPE');check(!before.schema,'SCHEMA_EXISTS');
  const nonce=crypto.randomUUID(),migration=atomicInstall(this.root,before,nonce);
  consumer.name='Growth · Carrinho retido · '+nonce; // Deterministic recovery identity after lost create response.
  const p={contract:CONTRACT,nonce,prepared_at:new Date().toISOString(),sources:sourceFiles(this.root),before,source:w,producer,consumer,projects:pr,pg:ids,utility:util,migration,open_operation:crypto.randomUUID()};
  p.hash=sha(p);this.store.put('plan',p);return this.summary(p);
 }
 plan(approval){const p=this.store.read('plan'),x=clone(p);delete x.hash;check(p.contract===CONTRACT&&sha(x)===p.hash,'PLAN_HASH');check(same(p.sources,sourceFiles(this.root)),'SOURCE_DRIFT');if(approval!==undefined)check(approval===p.hash,'APPROVAL');return p;}
 summary(p){return {contract:p.contract,plan_hash:p.hash,source_version:p.source.versionId,source_hash:sha(projection(p.source)),producer_hash:sha(projection(p.producer)),consumer_hash:sha(projection(p.consumer)),sql_hash:sha(p.migration.sql),consumer_initially_active:false,scope:['fish','aristo'],restart:false,installed:false};}
 async db(p,installed=true){const s=await this.io.metadata();this.evidence('sql',s);depGuard(s);check(s.database===p.before.database&&s.role===p.before.role&&same(s.dependencies,p.before.dependencies),'DEPENDENCY_DRIFT');
  if(installed){let seal;try{seal=JSON.parse(s.seal);}catch{throw Error('CART_DEPLOY_SEAL');}check(s.schema===SCHEMA&&same({...seal,shape:undefined},{...p.migration.seal,shape:undefined})&&seal.shape===s.shape&&s.shape,'SCHEMA_DRIFT');}
  else check(!s.schema,'SCHEMA_EXISTS');
  const util=await this.io.utilityPG();check(same(util,p.utility),'UTILITY_DRIFT');return s;
 }
 async source(p,kind='original',requirePublished=true){const w=await this.io.getWorkflow(P.TARGET);this.evidence('producer',w);check(w.id===P.TARGET&&w.active===true&&same(projects(w),p.projects)&&same(pg(w),p.pg),'SOURCE_IDENTITY');
  check(same(projection(w),projection(kind==='original'?p.source:p.producer))&&same(extra(w),extra(p.source)),'WORKFLOW_DRIFT');
  if(kind==='candidate'&&this.store.has('patch-verified'))check(w.versionId===this.receipt('patch').version,'CANDIDATE_VERSION_DRIFT');
  if(kind==='original')check(w.versionId===p.source.versionId&&w.activeVersionId===p.source.activeVersionId,'VERSION_DRIFT');
  if(requirePublished)published(w);return w;
 }
 async consumer(p,id,active){check(typeof id==='string'&&id!==P.TARGET&&id.length>0,'CONSUMER_ID');const w=await this.io.getWorkflow(id);this.evidence('consumer',w);
  check(w.id===id&&same(projects(w),p.projects)&&same(projection(w),projection(p.consumer))&&w.active===active,'CONSUMER_DRIFT');
  if(this.store.has('create-verified'))check(w.versionId===this.receipt('create').version,'CONSUMER_VERSION_DRIFT');
  if(active)check(w.activeVersionId===w.versionId&&w.activeVersion?.versionId===w.versionId&&same(w.activeVersion.nodes,w.nodes)&&same(w.activeVersion.connections,w.connections),'CONSUMER_UNPUBLISHED');return w;
 }
 receipt(phase){check(this.store.has(phase+'-verified'),'PHASE_REQUIRED_'+phase);return this.store.read(phase+'-verified');}
 async write(phase,intent,operation,verify){
  check(!this.store.has(phase+'-intent'),'UNCERTAIN_RECONCILE_'+phase);
  this.store.put(phase+'-intent',{...intent,at:new Date().toISOString()});
  const response=await operation();this.store.put(phase+'-response',{response});
  const result=await verify(response);this.store.put(phase+'-verified',result);return result;
 }
 async gate(p){await this.db(p);const s=await this.io.state();check(s.control?.enabled===true&&s.control.mode==='open','GATE_NOT_OPEN');
  const r=this.receipt('open');check(s.control.version===r.control.version,'GATE_VERSION_DRIFT');return s;}
 async phase(phase,approval,options={}){
  check(typeof approval==='string'&&/^[a-f0-9]{64}$/.test(approval),'APPROVAL_REQUIRED');
  const p=this.plan(approval);check(!this.store.has(phase+'-intent'),'UNCERTAIN_RECONCILE_'+phase);
  if(phase==='install'){
   await this.source(p);await this.db(p,false);
   return this.write(phase,{sql_hash:sha(p.migration.sql)},()=>this.io.sql(p.migration.sql),()=>this.verifyInstall(p));
  }
  if(phase==='create'){
   this.receipt('install');await this.source(p);await this.db(p);const s=await this.io.state();check(s.control?.enabled===false&&s.control.mode==='closed'&&Number(s.event_count)===0,'NOT_INITIAL_OFF');
   return this.write(phase,{name:p.consumer.name,hash:sha(projection(p.consumer))},()=>this.io.createWorkflow(projection(p.consumer)),async r=>this.verifyCreate(p,r.id));
  }
  if(phase==='open'){
   this.receipt('install');const id=this.receipt('create').id;await this.source(p);await this.consumer(p,id,false);await this.db(p);
   const s=await this.io.state();check(s.control?.version===1&&s.control.enabled===false&&s.control.mode==='closed'&&Number(s.event_count)===0,'OPEN_CAS');
   const q=`SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'; DO $guard$ BEGIN ${dependencySQL(p.before)} IF (SELECT count(*) FROM ${SCHEMA}.event)<>0 THEN RAISE EXCEPTION 'CART_DEPLOY_NOT_EMPTY';END IF; END $guard$; SELECT ${SCHEMA}.control_v1(${lit(p.open_operation)}::uuid,1,true,'open') AS receipt;`;
   return this.write(phase,{operation:p.open_operation,expected_version:1},()=>this.io.sql(q),()=>this.verifyOpen(p));
  }
  if(phase==='patch'){
   await this.gate(p);await this.consumer(p,this.receipt('create').id,false);const w=await this.source(p);
   return this.write(phase,{version:w.versionId,hash:sha(projection(w))},()=>this.io.putWorkflow(P.TARGET,projection(p.producer)),()=>this.verifyPatch(p));
  }
  if(phase==='publish'){
   const saved=this.receipt('patch');await this.gate(p);await this.consumer(p,this.receipt('create').id,false);const w=await this.source(p,'candidate',false);check(w.versionId===saved.version,'SAVED_VERSION_DRIFT');
   if(w.activeVersionId===w.versionId){const r=await this.verifyPublish(p);this.store.put('publish-verified',r);return r;}
   return this.write(phase,{version:w.versionId,hash:sha(projection(w))},()=>this.io.activateWorkflow(P.TARGET,w.versionId),()=>this.verifyPublish(p));
  }
  if(phase==='activate'){
   check(options.activationApproval===p.hash+':activate','ACTIVATION_REVIEW');this.receipt('publish');await this.gate(p);await this.source(p,'candidate');const id=this.receipt('create').id,w=await this.consumer(p,id,false);
   return this.write(phase,{id,version:w.versionId},()=>this.io.activateWorkflow(id,w.versionId),()=>this.verifyActive(p));
  }
  if(phase==='halt'){
   // Stops only future consumer triggers; this is NOT drain and never restores the bypassing producer.
   const id=this.receipt('create').id;await this.db(p);await this.source(p,'candidate');const w=await this.consumer(p,id,true);
   return this.write(phase,{id,version:w.versionId},()=>this.io.deactivateWorkflow(id),async()=>{await this.consumer(p,id,false);return {id,active:false,drained:false,queue_and_claims_preserved:true};});
  }
  throw Error('CART_DEPLOY_PHASE');
 }
 async verifyInstall(p){await this.db(p);const s=await this.io.state();check(s.control?.version===1&&s.control.enabled===false&&s.control.mode==='closed'&&Number(s.event_count)===0,'INSTALL_NOT_OFF');return {installed:true,off:true,shape:(await this.io.metadata()).shape};}
 async verifyCreate(p,id){const w=await this.consumer(p,id,false);return {id:w.id,version:w.versionId,active:false};}
 async verifyOpen(p){await this.db(p);const r=await this.io.controlOperation(p.open_operation);check(r?.request?.expected===1&&r.request.enabled===true&&r.request.mode==='open'&&r.response.version===2&&r.response.enabled===true&&r.response.mode==='open'&&r.response.drained===false,'OPEN_RECEIPT');const s=await this.io.state();check(s.control.version===2&&s.control.enabled===true&&s.control.mode==='open','OPEN_READBACK');return {operation:p.open_operation,control:s.control,drained:false};}
 async verifyPatch(p){await this.gate(p);const w=await this.source(p,'candidate',false);check(w.versionId!==p.source.versionId,'PUT_NOT_CONFIRMED');return {version:w.versionId,active_version:w.activeVersionId,hash:sha(projection(w))};}
 async verifyPublish(p){await this.gate(p);const w=await this.source(p,'candidate');check(w.versionId===this.receipt('patch').version,'PUBLISH_VERSION');return {version:w.versionId,published:true,hash:sha(projection(w))};}
 async verifyActive(p){await this.gate(p);await this.source(p,'candidate');const w=await this.consumer(p,this.receipt('create').id,true);return {id:w.id,version:w.versionId,active:true,drained:false,runtime_acceptance_pending:true};}
 async reconcile(phase,options={}){
  const p=this.plan();check(this.store.has(phase+'-intent')&&!this.store.has(phase+'-verified'),'RECONCILE_STATE');
  let result;
  if(phase==='install')result=await this.verifyInstall(p);
  else if(phase==='create'){const r=this.store.has('create-response')?this.store.read('create-response').response:null;result=await this.verifyCreate(p,r?.id||options.consumerId);}
  else if(phase==='open')result=await this.verifyOpen(p);
  else if(phase==='patch')result=await this.verifyPatch(p);
  else if(phase==='publish')result=await this.verifyPublish(p);
  else if(phase==='activate')result=await this.verifyActive(p);
  else if(phase==='halt'){const id=this.receipt('create').id;await this.consumer(p,id,false);result={id,active:false,drained:false,queue_and_claims_preserved:true};}
  else throw Error('CART_DEPLOY_PHASE');
  this.store.put(phase+'-verified',{...result,reconciled_read_only:true});return result;
 }
 async verify(){const p=this.plan();await this.db(p);const w=await this.source(p,'candidate'),c=await this.consumer(p,this.receipt('create').id,this.store.has('activate-verified')&&!this.store.has('halt-verified'));const s=await this.io.state();return {published_version:w.versionId,consumer_active:c.active,control:s.control,event_count:s.event_count,pending_count:s.pending_count,non_cart_count:s.non_cart_count,drained:false,runtime_acceptance_pending:true};}
}
module.exports={Installer,FileStore,atomicInstall,projection,projects,sourceFiles,sha,canonical,METADATA_SQL,STATE_SQL,SHAPE,CONTRACT};
