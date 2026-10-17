'use strict';
// The cookie selects person/front/brand; one private service key authenticates
// each existing source. Fixed READ routes return only the selected brand.
const crypto=require('node:crypto');
const {decide,forward,FIXED_DESTINATIONS}=require('./proxy.cjs');
const Individual=require('./dashboard-individual-read.cjs');
const Affiliate=require('./afiliados-read.cjs');
const AffiliateProjection=require('./afiliados-read-contract.cjs');
const Journeys=require('./crm-published-journey-read.cjs');
const Audiences=require('./crm-master-audience-read.cjs');
const fail=(code,status=403)=>{throw Object.assign(Error(code),{code,status});};

const PUBLIC_READ_PURPOSE='crm.publics-read-key',PUBLIC_READ_LABEL='Gateway READ Públicos 2026-10-13';
const PUBLIC_READ_DIR='/dashboard-data',PUBLIC_READ_FILE='source-audience-read.env',PUBLIC_READ_STATE='publics-read-key-operation.json';
function privateFile(io,root,name){const dir=io.lstatSync(root);if(!dir.isDirectory()||dir.isSymbolicLink()||io.realpathSync(root)!==root)fail('PUBLIC_READ_PRIVATE_PATH_REFUSED',503);const file=require('node:path').join(root,name),st=io.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o777)!==0o600||st.size>8192)fail('PUBLIC_READ_PRIVATE_FILE_REFUSED',503);return io.readFileSync(file,'utf8');}
function readPublicReadKey({io=require('node:fs'),root=PUBLIC_READ_DIR,confirmedOnly=true}={}){
 if(!io.existsSync(require('node:path').join(root,PUBLIC_READ_STATE)))return undefined;
 const journal=JSON.parse(privateFile(io,root,PUBLIC_READ_STATE));if(confirmedOnly&&journal.state!=='confirmed')return undefined;
 const raw=privateFile(io,root,PUBLIC_READ_FILE),match=/^DASHBOARD_SERVICE_READ_AUDIENCE_KEY=([a-f0-9]{64})\n$/.exec(raw);if(!match)fail('PUBLIC_READ_PRIVATE_FILE_REFUSED',503);return match[1];
}
function createPublicReadKeyInstaller({auth,onLinked,io=require('node:fs'),root=PUBLIC_READ_DIR,createClient,now=()=>new Date().toISOString()}={}){
 if(!auth?.nativeConnections||!auth?.nativeDatabaseVault?.getPrivateCredential||typeof onLinked!=='function')return null;
 const path=require('node:path'),stateFile=path.join(root,PUBLIC_READ_STATE),keyFile=path.join(root,PUBLIC_READ_FILE),U=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
 let busy=false;
 const write=(name,value,{exclusive=false}={})=>{const dir=io.lstatSync(root);if(!dir.isDirectory()||dir.isSymbolicLink()||io.realpathSync(root)!==root)fail('PUBLIC_READ_PRIVATE_PATH_REFUSED',503);const file=path.join(root,name);if(!exclusive)privateFile(io,root,name);const destination=exclusive?file:file+'.'+crypto.randomUUID();const fd=io.openSync(destination,io.constants.O_WRONLY|io.constants.O_CREAT|io.constants.O_EXCL|io.constants.O_NOFOLLOW,0o600);try{io.writeFileSync(fd,value);io.fsyncSync(fd);}finally{io.closeSync(fd);}if(!exclusive)io.renameSync(destination,file);privateFile(io,root,name);};
 const current=context=>{if(!context?.nativeBearer)fail('PUBLIC_READ_NATIVE_MASTER_REQUIRED');const c=auth.nativeConnections.authenticate(context.nativeBearer,{scope:'crm.iam'});if(!['fish','aristo'].every(b=>c.brands.includes(b)))fail('PUBLIC_READ_BOTH_BRANDS_REQUIRED');const user=auth.authorize({...context,admin:true});if(user.role!=='superadmin'||user.id!==c.userId)fail('PUBLIC_READ_NATIVE_MASTER_REQUIRED');const p=auth.nativeDatabaseVault.getPrivateCredential({ownerId:user.id});const r=p.resource;if(r?.project!=='comunicacao'||r.service!=='postgres'||r.host!=='comunicacao_postgres'||r.port!==5432||r.database!=='listmonk'||r.network!=='easypanel'||p.transport?.mode!=='admitted-private-network')fail('PUBLIC_READ_RESOURCE_REFUSED',503);return {c,p};};
 const same=(context,before)=>{const after=current(context);if(after.c.id!==before.c.id||after.c.userId!==before.c.userId||after.p.revision!==before.p.revision||after.p.username!==before.p.username)fail('PUBLIC_READ_ADMISSION_CHANGED',409);};
 const clientFor=p=>{const config={host:'comunicacao_postgres',port:5432,database:'listmonk',user:p.username,password:p.password,application_name:'shrigma-publics-read-key',connectionTimeoutMillis:3000,query_timeout:15000};if(createClient)return createClient(config);const manifest=JSON.parse(require('node:fs').readFileSync('/app/native-backend/manifest.json'));const {Client}=require('./native-pg-driver.cjs').loadPGDriver(manifest.pgDriverManifestSha256);return new Client(config);};
 const stored=()=>io.existsSync(stateFile)?JSON.parse(privateFile(io,root,PUBLIC_READ_STATE)):null;
 const saveJournal=j=>{const prior=stored();if(!prior||prior.operationId!==j.operationId||prior.ownerId!==j.ownerId||prior.connectionId!==j.connectionId||prior.profileRevision!==j.profileRevision||prior.state==='confirmed'&&j.state!=='confirmed')fail('PUBLIC_READ_JOURNAL_CHANGED',409);write(PUBLIC_READ_STATE,JSON.stringify(j));};
 const response=j=>({schema:'shrigma-public-read-key-install-v1',purpose:PUBLIC_READ_PURPOSE,operationId:j.operationId,state:j.state,catalogueCommitted:j.grantCommitted===true,connectionClosed:j.connectionClosed===true,sourceReadOnly:true,businessWrites:0,expires:'none',linked:j.state==='confirmed',...(j.code?{error:j.code}:{}),...(j.sqlState?{sqlState:j.sqlState}:{})});
 const ownership=(j,before,id)=>{if(j.operationId!==id||j.ownerId!==before.c.userId||j.connectionId!==before.c.id||j.profileRevision!==before.p.revision)fail('PUBLIC_READ_OPERATION_CHANGED',409);};
 const peer=async client=>{const r=await client.query("SELECT current_database()='listmonk' AS db,session_user=current_user AS role_match,(SELECT system_identifier::text FROM pg_control_system())='7641650273200603174' AS cluster,md5((SELECT prosrc FROM pg_proc WHERE oid='crm_audience_v2.authenticate(text)'::regprocedure))='884370b5c93cd89137827c638cc05f92' AS audience_pin,md5((SELECT prosrc FROM pg_proc WHERE oid='public.shrigma_panel_operator_v1(text,text)'::regprocedure))='2092629644f901de260051084d2fb2c2' AS operator_pin");if(r.rows.length!==1||Object.values(r.rows[0]).some(v=>v!==true))fail('PUBLIC_READ_PEER_REFUSED',503);};
 async function install(context,args){
  if(!args||Object.keys(args).sort().join(',')!=='approved,operationId,purpose'||args.approved!==true||args.purpose!==PUBLIC_READ_PURPOSE||!U.test(args.operationId))fail('PUBLIC_READ_EXPLICIT_APPROVAL_REQUIRED',400);
  const before=current(context),prior=stored();if(prior){ownership(prior,before,args.operationId);return {status:prior.state==='confirmed'?200:202,body:response(prior)};}if(busy)fail('PUBLIC_READ_INSTALL_BUSY',409);busy=true;
  let client,journal,journalCreated=false,commitAttempted=false,commitConfirmed=false,closeAttempted=false,stage='private-path';
  try{
   if(io.existsSync(keyFile))fail('PUBLIC_READ_PRIVATE_FILE_EXISTS',409);
   journal={schema:'shrigma-public-read-key-journal-v1',purpose:PUBLIC_READ_PURPOSE,operationId:args.operationId,ownerId:before.c.userId,connectionId:before.c.id,profileRevision:before.p.revision,state:'approved',approvedAt:now()};
   write(PUBLIC_READ_STATE,JSON.stringify(journal),{exclusive:true});journalCreated=true;
   stage='connect';client=clientFor(before.p);await client.connect();
   await client.query("BEGIN;SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='15s';SET LOCAL idle_in_transaction_session_timeout='20s';SET LOCAL log_statement='none';SET LOCAL log_duration=off;SET LOCAL log_min_error_statement='panic';SET LOCAL log_min_duration_statement=-1;SET LOCAL log_min_duration_sample=-1;SET LOCAL log_transaction_sample_rate=0;SET LOCAL log_parameter_max_length=0;SET LOCAL log_parameter_max_length_on_error=0;");
   stage='peer';await peer(client);same(context,before);
   await client.query('LOCK TABLE public.crm_dash_chave,public.shrigma_panel_permission_v1 IN SHARE ROW EXCLUSIVE MODE');
   const absent=await client.query("SELECT count(*)=0 AS absent FROM public.crm_dash_chave WHERE dono=$1 AND painel='growth'",[PUBLIC_READ_LABEL]);if(absent.rows.length!==1||absent.rows[0].absent!==true)fail('PUBLIC_READ_PRINCIPAL_EXISTS',409);
   const secret=crypto.randomBytes(32).toString('hex'),hash=crypto.createHash('sha256').update(secret).digest('hex'),principal='gateway-publics-read-v1-'+crypto.randomUUID().replaceAll('-','');
   write(PUBLIC_READ_FILE,'DASHBOARD_SERVICE_READ_AUDIENCE_KEY='+secret+'\n',{exclusive:true});
   journal.state='attempted';saveJournal(journal);same(context,before);
   stage='catalogue';
   await client.query("INSERT INTO public.crm_dash_chave(chave,painel,dono,ativo,criado_em,usos,revogada_em,chave_hash,chave_hash_curta,expira_em) VALUES($1,'growth',$2,true,statement_timestamp(),0,NULL,$3,NULL,'infinity'::timestamptz)",[principal,PUBLIC_READ_LABEL,hash]);
   await client.query("INSERT INTO public.shrigma_panel_permission_v1(principal_id,area,caps) VALUES($1,'growth','[\"read_content\"]'::jsonb)",[principal]);
   const proof=await client.query("SELECT crm_audience_v2.authenticate($1) IS NOT NULL AS audience,public.shrigma_panel_operator_v1($1,'growth')->'caps'='[\"read_content\"]'::jsonb AS read_only",( [secret] ));
   if(proof.rows.length!==1||Object.values(proof.rows[0]).some(v=>v!==true))fail('PUBLIC_READ_PROOF_REFUSED',503);same(context,before);
   stage='commit';commitAttempted=true;const ack=await client.query('COMMIT');if(ack?.command!=='COMMIT')fail('PUBLIC_READ_COMMIT_UNCONFIRMED',503);commitConfirmed=true;journal.grantCommitted=true;journal.state='committed';saveJournal(journal);stage='close';closeAttempted=true;try{await client.end();client=null;}catch{fail('PUBLIC_READ_CLOSE_UNCONFIRMED',503);}journal.connectionClosed=true;stage='link';same(context,before);onLinked(secret);journal.state='confirmed';journal.confirmedAt=now();journal.connectionClosed=true;saveJournal(journal);
   return {status:200,body:response(journal)};
  }catch(e){
   if(client&&!commitAttempted)try{await client.query('ROLLBACK');}catch{}
   if(journalCreated){journal.state=commitConfirmed?'committed':commitAttempted?'uncertain':'refused';journal.stage=stage;journal.code=typeof e.code==='string'&&/^PUBLIC_READ_[A-Z_]+$/.test(e.code)?e.code:'PUBLIC_READ_INSTALL_REFUSED';if(/^[0-9A-Z]{5}$/.test(e.code||''))journal.sqlState=e.code;try{saveJournal(journal);}catch{}return {status:commitAttempted&&!commitConfirmed?202:503,body:response(journal)};}throw e;
  }finally{if(client&&!closeAttempted)try{await client.end();}catch{}busy=false;}
 }
 async function status(context,args){
  if(!args||Object.keys(args).join(',')!=='operationId'||!U.test(args.operationId))fail('PUBLIC_READ_ARGUMENTS_INVALID',400);
  const before=current(context),journal=stored();if(!journal)fail('PUBLIC_READ_OPERATION_NOT_FOUND',404);ownership(journal,before,args.operationId);
  if(journal.state==='confirmed'){onLinked(readPublicReadKey({io,root}));return {status:200,body:response(journal)};}
  if(journal.state!=='uncertain'&&journal.state!=='attempted'&&journal.state!=='committed')return {status:200,body:response(journal)};
  if(busy)fail('PUBLIC_READ_INSTALL_BUSY',409);busy=true;let client,closeAttempted=false;
  try{const secret=readPublicReadKey({io,root,confirmedOnly:false}),hash=crypto.createHash('sha256').update(secret).digest('hex');client=clientFor(before.p);await client.connect();await client.query("BEGIN TRANSACTION READ ONLY;SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='15s';SET LOCAL log_statement='none';SET LOCAL log_duration=off;SET LOCAL log_min_error_statement='panic';SET LOCAL log_min_duration_statement=-1;SET LOCAL log_min_duration_sample=-1;SET LOCAL log_transaction_sample_rate=0;SET LOCAL log_parameter_max_length=0;SET LOCAL log_parameter_max_length_on_error=0;");await peer(client);
   const r=await client.query("SELECT count(*)=1 AS present FROM public.crm_dash_chave k JOIN public.shrigma_panel_permission_v1 p ON p.principal_id=k.chave AND p.area='growth' WHERE k.chave_hash=$1 AND k.dono=$2 AND k.painel='growth' AND k.ativo AND k.revogada_em IS NULL AND k.expira_em='infinity'::timestamptz AND p.caps='[\"read_content\"]'::jsonb",[hash,PUBLIC_READ_LABEL]);same(context,before);const rollback=await client.query('ROLLBACK');if(rollback?.command!=='ROLLBACK')fail('PUBLIC_READ_ROLLBACK_UNCONFIRMED',503);closeAttempted=true;await client.end();client=null;same(context,before);
   if(r.rows.length===1&&r.rows[0].present===true){journal.state='confirmed';journal.grantCommitted=true;journal.connectionClosed=true;journal.confirmedAt=now();saveJournal(journal);onLinked(secret);}return {status:journal.state==='confirmed'?200:202,body:response(journal)};
  }catch(e){return {status:503,body:{...response(journal),error:'PUBLIC_READ_STATUS_UNCONFIRMED'}};}finally{if(client)try{await client.query('ROLLBACK');}catch{}if(client&&!closeAttempted)try{await client.end();}catch{}busy=false;}
 }
 return Object.freeze({install,status});
}

const AREA={growth:'growth',organico:'organico',influs:'influs',afiliados:'influs'};
function sourceKeysFromEnv(env){
 const names={growth:'DASHBOARD_SERVICE_READ_CRM_KEY',organico:'DASHBOARD_SERVICE_READ_ORGANICO_KEY',influs:'DASHBOARD_SERVICE_READ_INFLUS_KEY',afiliados:'DASHBOARD_SERVICE_READ_AFILIADOS_KEY',audiences:'DASHBOARD_SERVICE_READ_AUDIENCE_KEY'};
 const out={};for(const [front,name]of Object.entries(names)){const value=env[name];if(value!==undefined){if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{8,256}$/.test(value))fail('SERVICE_READ_CONFIG_INVALID',500);out[front]=value;}}
 if(out.audiences===undefined){const privateKey=readPublicReadKey();if(privateKey)out.audiences=privateKey;}return Object.freeze(out);
}
function createReader({auth,upstreams,keys={},fetchImpl=globalThis.fetch,projectGrowth,growthDiagnostics,onReadFailure,timings=false}={}){
 if(!auth?.authorizeBrand||!auth?.authorize||typeof fetchImpl!=='function'||typeof projectGrowth!=='function'||Object.keys(keys).some(k=>!Object.hasOwn(AREA,k)&&k!=='audiences'))fail('SERVICE_READ_CONFIG_INVALID',500);
 const credentials={...keys},versions=Object.fromEntries(Object.keys(credentials).map(front=>[front,crypto.randomBytes(32).toString('hex')]));
 const noSecrets=value=>{const serialized=JSON.stringify(value);for(const secret of Object.values(credentials))if(serialized.includes(secret))fail('BRAND_RESPONSE_UNSCOPED',502);};
 let pending=0;
 // Concurrent brand projections share only an identical upstream GET in flight.
 // No TTL, stale response or authorization result is retained.
 const growthReads=new Map();
 const readFailures=[];
 function recordFailure(error,{front,brand,started}){
  if(front!=='growth'||Number(error.status)<500)return;
  const d=error.sourceDiagnostic||{},issue=error.projectionIssue;
  const row={event:'DASHBOARD_READ_FAILURE',id:crypto.randomUUID(),at:new Date().toISOString(),front,brand,route:'crm-read',method:'GET',status:Number.isInteger(error.status)?error.status:503,code:/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'SERVICE_READ_UNCONFIRMED',elapsedMs:Math.max(0,Date.now()-started),stage:/^[a-z-]{1,40}$/.test(d.stage||'')?d.stage:issue?'projection':'source-read',...(Number.isInteger(d.httpStatus)?{sourceStatus:d.httpStatus}:{}),...Object.fromEntries(['sourceCode','transportCode','errorType','sqlState'].filter(k=>typeof d[k]==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(d[k])).map(k=>[k,d[k]]))};
  if(/^[a-f0-9-]{36}$/.test(d.requestId||''))row.sourceRequestId=d.requestId;
  if(issue&&/^[a-z_.]{1,80}$/.test(issue.section||''))row.projection={section:issue.section,...(/^[a-z_]{1,80}$/.test(issue.reason||'')?{reason:issue.reason}:{}),...(/^[a-z_]{1,64}$/.test(issue.field||'')?{field:issue.field}:{})};
  noSecrets(row);readFailures.push(row);if(readFailures.length>32)readFailures.shift();
  try{if(typeof onReadFailure==='function')onReadFailure({...row});}catch{}
 }
 const current=(context,front,brand)=>{
  const user=auth.authorizeBrand({...context,area:AREA[front],productFront:front,edit:false},brand);
  return {user,stamp:JSON.stringify([user.id,user.role,user.areas,user.permissions,user.productFronts,user.productWriteFronts,user.brands,user.jobTitle])};
 };
 const same=(context,front,brand,before)=>{if(current(context,front,brand).stamp!==before.stamp)fail('SERVICE_READ_ACCESS_CHANGED',403);};
 const journeys=Journeys.createReader({fetchImpl,authorize:(context,{brand})=>{const {user}=current(context,'growth',brand);if(!credentials.growth)fail('SERVICE_READ_SOURCE_NOT_LINKED',503);return {userId:user.id,binding:versions.growth+':'+user.id,credential:credentials.growth};}});
 const templates=require('./crm-master-template-read.cjs').createReader({fetchImpl,authorize:(context,{brand})=>{const {user}=current(context,'growth',brand);if(!credentials.growth)fail('SERVICE_READ_SOURCE_NOT_LINKED',503);return {userId:user.id,binding:versions.growth+':'+user.id,credential:credentials.growth};}});
 function availability(context,brand){
  current(context,'afiliados',brand);if(brand==='olivas')fail('BRAND_READ_CONTRACT_NOT_READY',503);
  return {schema:'shrigma-affiliate-read-availability-v1',brand,readLinked:!!credentials.afiliados,binding:versions.afiliados||null,readOnly:true};
 }
 async function readDnsOnce(invoke,stillCurrent,{front,brand}){try{return await invoke();}catch(e){if(e.readDnsTemporary!==true)throw e;stillCurrent();try{onReadFailure?.({event:'DASHBOARD_READ_DNS_RETRY',front,brand,code:'EAI_AGAIN',at:new Date().toISOString(),retry:1});}catch{}await new Promise(resolve=>setTimeout(resolve,250));stillCurrent();return invoke();}}
 async function read({context,route,method,query,body,viewBrand,homeOnly=false,analyticsOnly=false,origin}){
  let front,brand,d,affiliateCommand;
  if(route==='segments'){
   if(method==='POST'&&body?.acao==='segmento_contar'){
    const saved=Object.hasOwn(body,'id'),shape=saved?'acao,brand,expected_catalog_hash,expected_version,id':'acao,brand,definition,expected_catalog_hash';
    if(query.size||Object.keys(body).sort().join(',')!==shape||!['fish','aristo'].includes(body.brand)||saved&&(! /^[a-f0-9-]{36}$/.test(body.id||'')||!Number.isSafeInteger(body.expected_version)||body.expected_version<1)||! /^[a-f0-9]{64}$/.test(body.expected_catalog_hash||''))fail('AUDIENCE_COUNT_REQUEST_INVALID',400);
    let definition;if(!saved){try{definition=require('./segment-audience-contract.js').normalize(body.definition);}catch{fail('AUDIENCE_COUNT_REQUEST_INVALID',400);}if(definition.brand!==body.brand)fail('AUDIENCE_COUNT_REQUEST_INVALID',400);body={...body,definition};}
    brand=body.brand;const owner=current(context,'growth',brand),credential=credentials.audiences;if(!credential)fail('AUDIENCE_READ_SOURCE_NOT_LINKED',503);
    const get=async q=>read({context:{...context,method:'GET'},route:'segments',method:'GET',query:new URLSearchParams(q),origin});
    const catalog=await get({acao:'segmentos_listar',brand,limit:'1',offset:'0'}),original=saved?await get({acao:'segmento_obter',brand,id:body.id}):null;
    if(catalog.status!==200||original&&original.status!==200)return original&&original.status!==200?original:catalog;
    if(catalog.body.capabilities.count!==true)fail('SEGMENT_UNAVAILABLE',503);
    if(catalog.body.catalog.catalog_hash!==body.expected_catalog_hash||!catalog.body.catalog.current||saved&&(original.body.segment.version!==body.expected_version||!original.body.segment.semantic_context.current))fail('SEGMENT_CATALOG_CHANGED',409);
    if(!saved&&!require('./segment-audience-contract.js').checkCatalog(definition,catalog.body.catalog).ok)fail('SEGMENT_UNAVAILABLE',503);
    same(context,'growth',brand,owner);if(pending>=8)fail('UPSTREAM_BUSY',429);pending++;
    let raw;try{raw=await forward({route,method,query,body,user:owner.user,credential,upstreams,origin,simpleAudienceCount:true,fetchImpl});}finally{pending--;}
    same(context,'growth',brand,owner);
    const checked=require('./crm-master-audience-count.cjs').validateAudienceCount(raw,{brand,request:body,originalDefinition:saved?original.body.segment.definition:definition,nowMs:Date.now(),secrets:Object.values(credentials)});
    if(checked.status!==200)return checked;
    const after=await get({acao:'segmentos_listar',brand,limit:'1',offset:'0'}),latest=saved?await get({acao:'segmento_obter',brand,id:body.id}):null;
    same(context,'growth',brand,owner);
    if(after.status!==200||after.body.catalog.catalog_hash!==body.expected_catalog_hash||!after.body.catalog.current||saved&&(latest.status!==200||latest.body.segment.version!==body.expected_version||JSON.stringify(latest.body.segment.definition)!==JSON.stringify(original.body.segment.definition)))fail('SEGMENT_CATALOG_CHANGED',409);
    noSecrets(checked.body);return checked;
   }
   if(method!=='GET'||body!==undefined||!['segmentos_listar','segmento_obter'].includes(query.get('acao')))fail('READ_ONLY');
   const decision=decide(route,method,query,body);if(decision.edit)fail('READ_ONLY');
   brand=query.get('brand');const before=current(context,'growth',brand);if(brand==='olivas')fail('BRAND_READ_CONTRACT_NOT_READY',503);
   // Original audience authentication requires its own hashed READ principal.
   // A legacy cache READ key is not promoted or reused as an operator credential.
   const credential=credentials.audiences;if(!credential)fail('AUDIENCE_READ_SOURCE_NOT_LINKED',503);
   if(upstreams?.segments?.href!==require('./proxy.cjs').REVIEWED_DYNAMIC.routes.segments)fail('SERVICE_READ_DESTINATION_INVALID',503);
   if(pending>=8)fail('UPSTREAM_BUSY',429);pending++;
   try{
    const raw=await readDnsOnce(()=>forward({route,method,query,user:before.user,credential,upstreams,origin,simpleAudienceRead:true,fetchImpl}),()=>same(context,'growth',brand,before),{front:'growth',brand});
    same(context,'growth',brand,before);
    const checked=Audiences.validateAudienceRead(raw,{brand,action:decision.action,query,secrets:Object.values(credentials)});
    const payload=JSON.parse(JSON.stringify(checked.body));
    if(checked.status===200&&decision.action==='segmentos_listar')payload.capabilities.count=checked.sourceCapabilities.count===true;
    for(const record of payload.segments||[payload.segment].filter(Boolean))record.updated_by='Equipe CRM';
    noSecrets(payload);same(context,'growth',brand,before);return {status:checked.status,body:payload};
   }finally{pending--;}
  }
  if(route==='affiliate-own-read'){
   if(method!=='POST'||query.size||!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).sort().join(',')!=='brand,fim,ini')fail('READ_ONLY');
   front='afiliados';brand=body.brand;
   const check=decide('influ','POST',new URLSearchParams(),{acao:'listar',marca:brand,ini:body.ini,fim:body.fim,pilot:true});
   if(check.edit)fail('READ_ONLY');
   const before=current(context,front,brand);if(brand==='olivas')fail('BRAND_READ_CONTRACT_NOT_READY',503);
   const credential=credentials.afiliados;if(!credential)fail('SERVICE_READ_SOURCE_NOT_LINKED',503);
   if(upstreams?.influ?.href!==FIXED_DESTINATIONS.influ)fail('SERVICE_READ_DESTINATION_INVALID',503);
   if(pending>=8)fail('UPSTREAM_BUSY',429);pending++;
   try{
    const result=await forward({route:'influ',method:'POST',query:new URLSearchParams(),body:{acao:'listar',marca:brand,ini:body.ini,fim:body.fim,pilot:true},user:before.user,credential,upstreams,origin,fetchImpl});
    same(context,front,brand,before);if(result.status!==200)fail('SERVICE_READ_SOURCE_REFUSED',503);noSecrets(result.body);
    const payload=Individual.ownAffiliates(result.body,brand,body);same(context,front,brand,before);return {status:200,body:payload};
   }finally{pending--;}
  }
  if(route==='templates'){
   if(method!=='GET'||body!==undefined)fail('READ_ONLY');
   const action=query.get('acao');
   if(action==='listar'&&query.get('canal')==='email'){const result=await templates.read({...context,method},query);noSecrets(result.body);return result;}
   if(!['fluxos_capacidade','fluxos_listar'].includes(action))fail('READ_ONLY');
   const result=action==='fluxos_capacidade'?journeys.capability(context,query):await journeys.read(context,query);noSecrets(result.body);return result;
  }
  if(route==='affiliate-read'){
   affiliateCommand=Affiliate.decision(method,query,body);brand=affiliateCommand.brand;front='afiliados';
   if(method==='GET')return {status:200,body:availability(context,brand)};
  }else{
   d=decide(route,method,query,body);if(d.edit)fail('READ_ONLY');front=d.area;
   if(!Object.hasOwn(AREA,front)||front==='afiliados')fail('READ_ONLY');
   const identity=route==='cx'&&query.get('access')==='1'||route==='crm-read'&&d.action==='identity';
   if(identity){const user=auth.authorize({...context,area:AREA[front],edit:false});return {status:200,body:{schema:'shrigma_access_identity_v1',role:user.role==='superadmin'?'master':'manager',panel:front,allowedPanels:user.areas,owner:user.jobTitle||'administrador',brand:user.brand,brands:user.brands,brandAccess:user.brandAccess}};}
   const allowed=front==='growth'?route==='crm-read'&&method==='GET'&&d.action==='cache_growth':front==='organico'?['cx','cache'].includes(route)&&method==='GET'&&d.action==='':front==='influs'&&route==='influ'&&method==='POST'&&d.action==='listar';
   if(!allowed)fail('READ_ONLY');
   if(viewBrand!==undefined&&(!['cx','cache','crm-read'].includes(route)||method!=='GET'||!['fish','aristo','olivas'].includes(viewBrand)))fail('BRAND_INVALID',400);
   const user=auth.authorize({...context,area:AREA[front],productFront:front,edit:false});
   brand=body?.marca||query.get('brand')||query.get('marca')||viewBrand||user.brand;
  }
  const before=current(context,front,brand);if(brand==='olivas')fail('BRAND_READ_CONTRACT_NOT_READY',503);
  const credential=credentials[front];if(!credential)fail('SERVICE_READ_SOURCE_NOT_LINKED',503);
  if(route==='affiliate-read'&&affiliateCommand.expected_binding!==versions.afiliados)fail('AFFILIATE_READ_BINDING_CHANGED',409);
  const targetRoute=route==='affiliate-read'?'tts':route;
  if(upstreams?.[targetRoute]?.href!==FIXED_DESTINATIONS[targetRoute])fail('SERVICE_READ_DESTINATION_INVALID',503);
  if(pending>=8)fail('UPSTREAM_BUSY',429);pending++;
  const started=Date.now(),homeVariant=homeOnly===true&&front==='growth'&&targetRoute==='crm-read'&&method==='GET'&&d.action==='cache_growth',resultsVariant=!homeVariant&&analyticsOnly===true&&front==='growth'&&targetRoute==='crm-read'&&method==='GET'&&d.action==='cache_growth';
  try{
   const sourceCall=()=>forward({route:targetRoute,method:route==='affiliate-read'?'POST':method,query:route==='affiliate-read'?new URLSearchParams():query,body:route==='affiliate-read'?{ini:body.ini,fim:body.fim}:body,user:before.user,credential,upstreams,origin,crmHomeRead:homeVariant,crmHomeBrand:homeVariant?brand:undefined,crmResultsRead:resultsVariant,crmResultsBrand:resultsVariant?brand:undefined,captureReadDiagnostic:front==='growth',captureReadTiming:timings===true,fetchImpl});
   const call=()=>method==='GET'?readDnsOnce(sourceCall,()=>same(context,front,brand,before),{front,brand}):sourceCall();
   let result;
   if(front==='growth'){
    const key=JSON.stringify([targetRoute,query.toString(),origin,homeVariant?'home':resultsVariant?'results-brand':'full',homeVariant||resultsVariant?brand:null]);let inFlight=growthReads.get(key);
    if(!inFlight){inFlight=call();growthReads.set(key,inFlight);inFlight.then(()=>{if(growthReads.get(key)===inFlight)growthReads.delete(key);},()=>{if(growthReads.get(key)===inFlight)growthReads.delete(key);});}
    result=await inFlight;
   }else result=await call();
   same(context,front,brand,before);if(result.status!==200)throw Object.assign(Error('SERVICE_READ_SOURCE_REFUSED'),{code:'SERVICE_READ_SOURCE_REFUSED',status:503,sourceDiagnostic:result.sourceDiagnostic});
   noSecrets(result.body);
   const projectionStarted=Date.now();let payload=front==='growth'?projectGrowth(result.body,brand,'growth',origin):front==='afiliados'?AffiliateProjection.project(result.body,{brand,ini:body.ini,fim:body.fim,credential}):Individual.project(result.body,{area:front,brand,query:body||Object.fromEntries(query),credential});
   if(front==='growth'){
    payload=Journeys.capabilities(payload,origin,true);
    if(upstreams?.segments?.href===require('./proxy.cjs').REVIEWED_DYNAMIC.routes.segments)payload.capabilities={...(payload.capabilities||{}),segments:{read:!!credentials.audiences,save:false,count:false,operation:false,send:false,brands:[brand],contract_version:'crm-audience-v2'},endpoints:{...(payload.capabilities?.endpoints||{}),segments:origin+'/api/segments'}};
    if(typeof growthDiagnostics==='function')payload.cart_contract=growthDiagnostics(result.body,brand);
   }
   same(context,front,brand,before);return {status:200,body:payload,...(timings===true?{readTiming:{...(result.readTiming||{}),projection:Date.now()-projectionStarted}}:{})};
  }catch(error){recordFailure(error,{front,brand,started});throw error;}finally{pending--;}
 }
 async function summary(context,brands,origin,now=Date.now()){
  auth.authorize({...context,admin:true});
  if(!Array.isArray(brands)||brands.length>2||brands.some(b=>!['fish','aristo'].includes(b))||new Set(brands).size!==brands.length)fail('BRAND_INVALID',400);
  const fim=new Date(now-3*3600000).toISOString().slice(0,10),ini=new Date(now-3*3600000-29*86400000).toISOString().slice(0,10);
  const measuredAt=new Date(now).toISOString();
  const jobs=brands.flatMap(brand=>Object.keys(AREA).map(async front=>{
   auth.authorize({...context,admin:true});
   let result;
   try{
    const q=new URLSearchParams();let route,method='GET',body,viewBrand;
    if(front==='growth'){route='crm-read';q.set('action','cache_growth');q.set('painel','growth');viewBrand=brand;}
    else if(front==='organico'){route='cache';q.set('painel','organico');viewBrand=brand;}
    else if(front==='influs'){route='influ';method='POST';body={acao:'listar',ini,fim,marca:brand};}
    else{route='affiliate-read';method='POST';body={ini,fim,brand,expected_binding:availability(context,brand).binding};}
    result=await read({context,route,method,query:q,body,viewBrand,origin});
    const b=result.body,counts={},freshness={};
    for(const [key,value]of Object.entries(b)){
     if(Array.isArray(value)&&!['crm_credencial','read_issues'].includes(key))counts[key]=value.length;
     if(['gerado_em','_cache_gerado_em'].includes(key)&&typeof value==='string')freshness[key]=new Date(value).toISOString();
    }
    // Only dates from allowlisted collector fields leave this diagnostic;
    // rows, emails, names, cookies, keys and provider error text stay private.
    for(const rows of Object.values(b).filter(Array.isArray))for(const row of rows)for(const key of ['coletado_em','ultima_coleta','ultima_ok','ultima']){
     const v=row?.[key];if(typeof v==='string'&&Number.isFinite(Date.parse(v))&&(!freshness[key]||Date.parse(v)>Date.parse(freshness[key])))freshness[key]=new Date(v).toISOString();
    }
    if(b.coleta&&typeof b.coleta[brand]==='string'&&Number.isFinite(Date.parse(b.coleta[brand])))freshness.pedidos_coletados_em=new Date(b.coleta[brand]).toISOString();
    const attribution=b.organico_attribution||b.crm_attribution,attributionCounts={};
    if(attribution&&typeof attribution==='object')for(const name of ['daily','quality','coverage'])if(Array.isArray(attribution[name])){
     attributionCounts[name]=attribution[name].length;
     if(name==='daily'&&front==='organico')attributionCounts.detailedRows=attribution[name].filter(row=>row.detail_level==='utm').length;
     for(const row of attribution[name])if(typeof row.checked_at==='string'&&Number.isFinite(Date.parse(row.checked_at))&&(!freshness.attribution_checked_at||Date.parse(row.checked_at)>Date.parse(freshness.attribution_checked_at)))freshness.attribution_checked_at=new Date(row.checked_at).toISOString();
    }
    result={front,brand,status:200,counts,freshness,...(Object.keys(attributionCounts).length?{attributionCounts}:{}),source:front==='growth'?'crm-panel-read':front==='organico'?'cache-organico':front==='influs'?'influ-listar':'tts-painel',window:front==='influs'||front==='afiliados'?{ini,fim}:null,readOnly:true};
    if(b.cart_contract)result.cartContract=b.cart_contract;
    if(Array.isArray(b.read_issues))result.sourceIssues=b.read_issues.filter(p=>['crm_carrinho','cx_post_midia','clientes','conciliacao','saude','coleta'].includes(p.section)&&['rows_type_invalid','row_type_invalid','brand_marker_invalid','field_type_invalid','field_absent','field_null_invalid','recovery_pair_mismatch','contract_invalid','relation_ambiguous'].includes(p.reason)&&(!p.field||/^[a-z_]{1,64}$/.test(p.field))).map(p=>({section:p.section,reason:p.reason,...(p.field?{field:p.field}:{})}));
   }catch(e){
    result={front,brand,status:Number.isInteger(e.status)?e.status:503,error:/^[A-Z_]{1,80}$/.test(e.code||'')?e.code:'SERVICE_READ_UNCONFIRMED',counts:null,freshness:null,readOnly:true};
    const p=e.projectionIssue;
    if(['growth','organico','influs'].includes(front)&&p&&/^(crm_[a-z_]+|wa_[a-z_]+|cx_[a-z_]+|(?:attribution|organic)\.[a-z_]+|influs|roi|cupons|custos|receita_cupom|termos|clientes|conciliacao|saude)$/.test(p.section||'')&&['rows_type_invalid','row_type_invalid','brand_marker_invalid','field_type_invalid'].includes(p.reason)&&(!p.field||/^[a-z_]{1,64}$/.test(p.field)))result.diagnostic={section:p.section,reason:p.reason,...(p.field?{field:p.field}:{})};
   }
   auth.authorize({...context,admin:true});return result;
  }));
  const sources=await Promise.all(jobs);auth.authorize({...context,admin:true});
  for(const result of sources.filter(x=>x.front==='growth')){
   try{
    const query=new URLSearchParams({acao:'segmentos_listar',brand:result.brand,offset:'0',limit:'100'}),r=await read({context,route:'segments',method:'GET',query,origin});
    result.audiences={status:r.status,countReturned:r.status===200?r.body.segments.length:null,limit:100,offset:0,catalogCurrent:r.status===200?r.body.catalog.current:null,readOnly:true,...(r.body.error?{error:r.body.error}:{})};
    const sample=r.body.segments?.find(s=>!s.archived&&s.semantic_context.current);
    if(sample&&r.body.capabilities?.count===true){try{const counted=await read({context:{...context,method:'POST'},route:'segments',method:'POST',query:new URLSearchParams(),body:{acao:'segmento_contar',brand:result.brand,id:sample.id,expected_version:sample.version,expected_catalog_hash:r.body.catalog.catalog_hash},origin});result.audiences.countProbe={status:counted.status,id:sample.id,version:sample.version,eligible_count:counted.body.eligible_count??null,source_confirmed:counted.body.source_confirmed===true,checked_at:counted.body.checked_at??null,...(counted.body.error?{error:counted.body.error}:{})};}catch(e){result.audiences.countProbe={status:e.status||503,error:e.code||'AUDIENCE_COUNT_UNCONFIRMED',eligible_count:null};}}
   }catch(e){result.audiences={status:Number.isInteger(e.status)?e.status:503,error:/^[A-Z_]{1,80}$/.test(e.code||'')?e.code:'AUDIENCE_READ_UNCONFIRMED',countReturned:null,limit:100,offset:0,readOnly:true};}
  }
  for(const result of sources.filter(x=>x.front==='afiliados')){
   // Same admitted technical READ, fixed 90-day window, aggregate metrics only.
   // This does not copy a personal token or start a collector.
   try{
    const from=new Date(now-3*3600000-89*86400000).toISOString().slice(0,10);
    const r=await read({context,route:'affiliate-read',method:'POST',query:new URLSearchParams(),body:{brand:result.brand,ini:from,fim,expected_binding:availability(context,result.brand).binding},origin}),b=r.body;
    const total=field=>!Array.isArray(b.kpis)||!b.kpis.length||b.kpis.some(x=>x[field]===null||x[field]===undefined||!Number.isFinite(Number(x[field])))?null:b.kpis.reduce((n,x)=>n+Number(x[field]),0);
    result.affiliate90d={status:200,window:{ini:from,fim},metrics:Object.fromEntries(['gmv','pedidos','criadores','comissao'].map(k=>[k,total(k)])),counts:Object.fromEntries(['serie','canal','canal_total','lives','videos','live_produtos','cobranca','cobranca_pendentes'].filter(k=>Array.isArray(b[k])).map(k=>[k,b[k].length])),collection:b.frescor?.map(x=>({ultima_ok:x.ultima_ok??null,ultima:x.ultima??null,ultima_ok_todas:x.ultima_ok_todas??null,hasErrors:!!x.erros}))??null,readOnly:true};
   }catch(e){result.affiliate90d={status:Number.isInteger(e.status)?e.status:503,error:/^[A-Z_]{1,80}$/.test(e.code||'')?e.code:'AFFILIATE_SOURCE_UNCONFIRMED',metrics:null,readOnly:true};}
   try{
    const r=await read({context,route:'affiliate-own-read',method:'POST',query:new URLSearchParams(),body:{brand:result.brand,ini,fim},origin}),b=r.body;
    result.ownAffiliates={status:200,counts:Object.fromEntries(['programs','candidates','links','partner_orders','fechamento'].filter(k=>Array.isArray(b[k])).map(k=>[k,b[k].length])),gerado_em:b.gerado_em||null,source:b.source,readOnly:true};
   }catch(e){result.ownAffiliates={status:Number.isInteger(e.status)?e.status:503,error:/^[A-Z_]{1,80}$/.test(e.code||'')?e.code:'OWN_AFFILIATE_SOURCE_UNCONFIRMED',counts:null,readOnly:true};}
  }
  let accountSummary;
  try{const people=auth.simpleAccounts?.list({context}),managers=people?.filter(p=>!p.administrator&&p.active);if(managers)accountSummary={activeManagers:managers.length,byFront:Object.fromEntries(Object.keys(AREA).map(front=>[front,managers.filter(p=>p.fronts.includes(front)).length]))};}catch{}
  auth.authorize({...context,admin:true});
  return {schema:'shrigma-four-front-read-summary-v1',measuredAt,sources,...(accountSummary?{accountSummary}:{}),readFailures:readFailures.filter(row=>brands.includes(row.brand)).map(row=>({...row})),readOnly:true,operational:false};
 }
 return Object.freeze({read,availability,summary,linkAudience(key){if(credentials.audiences===key)return;if(typeof key!=='string'||! /^[a-f0-9]{64}$/.test(key)||Object.values(credentials).includes(key))fail('PUBLIC_READ_KEY_LINK_REFUSED',503);credentials.audiences=key;}});
}
function affiliateWriteKeyFromEnv(env){
 const value=env.DASHBOARD_SERVICE_WRITE_AFILIADOS_KEY;
 if(value===undefined)return undefined;
 if(typeof value!=='string'||!/^[a-z0-9-]{8,128}$/.test(value))fail('AFFILIATE_WRITE_CONFIG_INVALID',500);
 return value;
}
function createAffiliateEditor({auth,upstreams,readKey,writeKey,otherReadKeys=[],fetchImpl=globalThis.fetch,now=Date.now}={}){
 if(!auth?.simpleAccounts?.reserveAffiliateEdit||!auth.authorizeBrand||typeof fetchImpl!=='function'||typeof now!=='function'||writeKey!==undefined&&(typeof writeKey!=='string'||!/^[a-z0-9-]{8,128}$/.test(writeKey)||[readKey,...otherReadKeys].includes(writeKey)))fail('AFFILIATE_WRITE_CONFIG_INVALID',500);
 const binding=writeKey?crypto.createHash('sha256').update(writeKey).digest('hex'):null;
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
 const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
 const noSecrets=value=>{const text=JSON.stringify(value);for(const secret of [readKey,writeKey,...otherReadKeys].filter(Boolean))if(text.includes(secret))fail('AFFILIATE_SOURCE_UNCONFIRMED',503);};
 const current=(context,brand,edit)=>{
  const user=auth.authorizeBrand({...context,area:'influs',productFront:'afiliados',edit},brand);
  return {user,stamp:JSON.stringify([user.id,user.role,user.permissions,user.productFronts,user.productWriteFronts,user.brands,user.jobTitle])};
 };
 const same=(context,brand,edit,before)=>{if(current(context,brand,edit).stamp!==before.stamp)fail('AFFILIATE_ACCESS_CHANGED',403);};
 function availability(context,brand){
  const {user}=current(context,brand,false);
  return {allowed:!!writeKey&&!!readKey&&['fish','aristo'].includes(brand)&&(user.role==='superadmin'||user.productWriteFronts?.includes('afiliados')),readOnly:!writeKey,operational:false};
 }
 const unwrap=body=>{if(Array.isArray(body)){if(body.length!==1)fail('AFFILIATE_SOURCE_UNCONFIRMED',503);body=body[0];}if(exact(body,['payload']))body=body.payload;return body;};
 async function original(before,brand){
  if(!readKey||upstreams?.influ?.href!==FIXED_DESTINATIONS.influ)fail('AFFILIATE_SOURCE_NOT_LINKED',503);
  const fim=new Date(now()-3*3600000).toISOString().slice(0,10),ini=fim;
  const r=await forward({route:'influ',method:'POST',query:new URLSearchParams(),body:{acao:'listar',marca:brand,ini,fim,pilot:true},user:before.user,credential:readKey,upstreams,fetchImpl});
  const body=unwrap(r.body);if(r.status!==200)fail('AFFILIATE_SOURCE_UNCONFIRMED',503);noSecrets(body);Individual.ownAffiliates(body,brand,{ini,fim});return body.pilot.candidates;
 }
 function selected(rows,brand,id){
  const found=rows.filter(r=>r.id===id&&(r.marca||r.brand)===brand);if(found.length!==1)fail('AFFILIATE_CANDIDATE_NOT_FOUND',404);
  const r=found[0];if(!Number.isSafeInteger(r.version)||r.version<1||!['manual','formulario_site'].includes(r.source)||!['novo','em_analise','aprovado_piloto','pausado','recusado'].includes(r.state))fail('AFFILIATE_SOURCE_UNCONFIRMED',503);
  for(const [key,max]of [['name',120],['handle',120],['note',1000],['source_reference',100]])if(!Object.hasOwn(r,key)||typeof r[key]!=='string'||[...r[key]].length>max)fail('AFFILIATE_SOURCE_UNCONFIRMED',503);
  if([...r.name.trim()].length<2||r.name!==r.name.trim())fail('AFFILIATE_SOURCE_UNCONFIRMED',503);
  return r;
 }
 function receipt(body,row){
  if(!exact(body,['ok','kind','id','version','request_id'])||body.ok!==true||body.kind!=='candidato'||body.id!==row.candidate_id||body.version!==row.expected_version+1||body.request_id!==row.request_id)fail('AFFILIATE_RECEIPT_UNCONFIRMED',503);
  return {ok:true,state:'confirmed',request_id:row.request_id,candidate_id:row.candidate_id,brand:row.brand,version:body.version};
 }
 const rejected=new Map([
  ['Acesso de operação de Creators necessário.','AFFILIATE_WRITER_REFUSED'],
  ['Cadastro mudou. Atualize antes de salvar.','AFFILIATE_VERSION_CHANGED'],
  ['A marca de um cadastro existente não pode mudar.','AFFILIATE_BRAND_CHANGED'],
  ['Confira nome, origem e situação do candidato.','AFFILIATE_SOURCE_UNCONFIRMED']
 ]);
 function uncertain(row,context,brand,before){
  const state=auth.simpleAccounts.finishAffiliateEdit(row,'uncertain');same(context,brand,true,before);
  if(state==='confirmed')return {status:200,body:{state:'confirmed',request_id:row.request_id,brand:row.brand,candidate_id:row.candidate_id,version:row.expected_version+1,readBackConfirmed:false}};
  return {status:202,body:{state:'uncertain',request_id:row.request_id,brand:row.brand,candidate_id:row.candidate_id,error:'AFFILIATE_RESULT_UNCERTAIN'}};
 }
 async function edit(context,body){
  if(!exact(body,['action','brand','candidate_id','expected_version','request_id'])||body.action!=='review'||!['fish','aristo'].includes(body.brand)||typeof body.candidate_id!=='string'||!UUID.test(body.candidate_id)||typeof body.request_id!=='string'||!UUID.test(body.request_id)||!Number.isSafeInteger(body.expected_version)||body.expected_version<1||body.expected_version>99999999)fail('AFFILIATE_ARGUMENTS_INVALID',400);
  const before=current(context,body.brand,true);
  if(!writeKey||!readKey)fail('AFFILIATE_WRITE_NOT_LINKED',503);
  const row=auth.simpleAccounts.reserveAffiliateEdit({context,requestId:body.request_id,brand:body.brand,candidateId:body.candidate_id,expectedVersion:body.expected_version,binding});
  let data;
  try{
   const r=selected(await original(before,body.brand),body.brand,body.candidate_id);same(context,body.brand,true,before);
   if(r.version!==body.expected_version||r.state!=='novo')fail('AFFILIATE_VERSION_CHANGED',409);
   data=Object.fromEntries(['id','name','handle','source','source_reference','note'].map(k=>[k,r[k]]));data.marca=body.brand;data.state='em_analise';
  }catch(e){auth.simpleAccounts.finishAffiliateEdit(row,'not_sent');throw e;}
  let response,attempted=false;
  try{
   same(context,body.brand,true,before);
   attempted=true;
   response=await forward({route:'influ',method:'POST',query:new URLSearchParams(),body:{acao:'piloto_salvar',kind:'candidato',request_id:body.request_id,expected_version:body.expected_version,data},user:before.user,credential:writeKey,upstreams,fetchImpl,simpleAffiliateEdit:true});
  }catch(e){if(!attempted){auth.simpleAccounts.finishAffiliateEdit(row,'not_sent');throw e;}return uncertain(row,context,body.brand,before);}
  let result,rejection;
  try{
   const b=unwrap(response.body);noSecrets(b);
   if(response.status===200&&exact(b,['erro'])&&rejected.has(b.erro))rejection=rejected.get(b.erro);
   else{if(response.status!==200)fail('AFFILIATE_RECEIPT_UNCONFIRMED',503);result=receipt(b,row);}
  }catch(e){return uncertain(row,context,body.brand,before);}
  if(rejection){auth.simpleAccounts.finishAffiliateEdit(row,'rejected');same(context,body.brand,true,before);return {status:409,body:{state:'rejected',error:rejection,request_id:row.request_id}};}
  auth.simpleAccounts.finishAffiliateEdit(row,'confirmed');same(context,body.brand,true,before);
  try{const reread=selected(await original(before,body.brand),body.brand,body.candidate_id);same(context,body.brand,true,before);result.readBackConfirmed=reread.version===result.version&&reread.state==='em_analise'&&['name','handle','source','source_reference','note'].every(k=>reread[k]===data[k]);}
  catch(e){same(context,body.brand,true,before);result.readBackConfirmed=false;}
  return {status:200,body:result};
 }
 async function operation(context,query){
  if(!exact(query,['brand','candidate_id','request_id'])||!['fish','aristo'].includes(query.brand)||typeof query.candidate_id!=='string'||!UUID.test(query.candidate_id)||typeof query.request_id!=='string'||!UUID.test(query.request_id))fail('AFFILIATE_ARGUMENTS_INVALID',400);
  const before=current(context,query.brand,false),row=auth.simpleAccounts.affiliateEdit({context,requestId:query.request_id,brand:query.brand,candidateId:query.candidate_id});
  if(row.state==='confirmed'||row.state==='rejected'||row.state==='not_sent')return {status:200,body:{state:row.state,request_id:row.request_id,brand:row.brand,candidate_id:row.candidate_id,...(row.state==='confirmed'?{version:row.expected_version+1}:{})}};
  if(!writeKey||row.binding!==binding)fail('AFFILIATE_WRITE_BINDING_CHANGED',409);
  let response;try{response=await forward({route:'influ',method:'POST',query:new URLSearchParams(),body:{acao:'piloto_operacao',request_id:row.request_id},user:before.user,credential:writeKey,upstreams,fetchImpl,simpleAffiliateEdit:true});}catch{fail('AFFILIATE_OPERATION_READ_UNCONFIRMED',503);}
  same(context,query.brand,false,before);const b=unwrap(response.body);noSecrets(b);
  if(response.status!==200||!exact(b,['ok','state','receipt'])||b.ok!==true||!['confirmed','not_found'].includes(b.state))fail('AFFILIATE_OPERATION_READ_UNCONFIRMED',503);
  if(b.state==='not_found'){if(b.receipt!==null)fail('AFFILIATE_OPERATION_READ_UNCONFIRMED',503);return {status:202,body:{state:'uncertain',request_id:row.request_id,brand:row.brand,candidate_id:row.candidate_id,originalReceiptFound:false}};}
  const result=receipt(b.receipt,row);auth.simpleAccounts.finishAffiliateEdit(row,'confirmed');same(context,query.brand,false,before);return {status:200,body:result};
 }
 return Object.freeze({availability,edit,operation});
}
function projectCrmHome(body){
 if(!body||!['fish','aristo'].includes(body.brand)||!Array.isArray(body.brands)||body.brands.length!==1||body.brands[0]!==body.brand)fail('CRM_HOME_SCOPE_UNCONFIRMED',502);
 const brand=body.brand,fields=(row,names)=>Object.fromEntries(names.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]));
 function marked(row){const values=['marca','brand'].filter(k=>Object.hasOwn(row||{},k)).map(k=>({fishermans:'fish',aristocrata:'aristo'}[row[k]]||row[k]));if(!values.length||values.some(b=>!['fish','aristo'].includes(b)||b!==values[0]))fail('CRM_HOME_SCOPE_UNCONFIRMED',502);return values[0];}
 const scoped=rows=>Array.isArray(rows)?rows.filter(r=>marked(r)===brand).map(r=>({...r,marca:brand})):null;
 const a=body.crm_attribution||{},original=scoped(a.daily),all=original?.every(require('./public/crm-preview/home.js').validAttributionRow)?original:null,daily=all?.filter(r=>r.model==='last_click'&&r.grain==='channel'&&Array.isArray(r.dimension)&&r.dimension[0]==='email')??null;
 const sourceDaily=scoped(body.crm_diario)?.filter(r=>r.canal==='email')??null,hasWindow=sourceDaily?.some(r=>r.janela!==undefined),coverage=scoped(a.coverage);
 const sharedSources=Array.isArray(body.crm_fontes)?body.crm_fontes.filter(r=>(!Object.hasOwn(r,'brand')&&!Object.hasOwn(r,'marca')||marked(r)===brand)&&['listmonk_snapshot','shopify_conversao'].includes(r.fonte||r.source)).map(r=>({...fields(r,['source','fonte','status','coletado_em','cadencia_seg']),scope:!Object.hasOwn(r,'brand')&&!Object.hasOwn(r,'marca')?'shared':'brand'})):null;
 const attributeFields=['marca','dia','model','grain','dimension','receita','pedidos'];
 return {contract:'shrigma-crm-home-read-v1',brand,brands:[brand],gerado_em:body.gerado_em,_cache_gerado_em:body._cache_gerado_em,
  crm_diario:sourceDaily?.filter(r=>!hasWindow||r.janela==='1d').map(r=>fields(r,['marca','dia','canal','janela','enviados','entregues','abriram','clicaram','cliques','hard','complaints','descadastros','coletado_em']))??null,
  crm_attribution:{schema_version:a.schema_version,default_model:a.default_model,money_basis:a.money_basis,generated_at:a.generated_at,window_days:a.window_days,
   coverage:coverage?.map(r=>({brand,day:r.day,checked_at:r.checked_at}))??null,
   daily:daily?.map(r=>fields(r,attributeFields))??null,
   quality:scoped(a.quality)?.map(r=>fields(r,['marca','dia','model','pagos_elegiveis','pagos_sem_ultima_sessao','jornada_pendente','jornada_parcial','coletado_em']))??null},
  flow_attribution:all?.filter(r=>r.model==='last_click'&&r.grain==='flow_piece'&&Array.isArray(r.dimension)&&r.dimension[0]==='email').map(r=>fields(r,attributeFields))??null,
  crm_collection_receipt:scoped(body.crm_collection_receipt)?.map(r=>fields(r,['marca','source','pages','checked_at','observed_at']))??null,
  crm_fontes:sharedSources,
  crm_campanha:scoped(body.crm_campanha)?.map(r=>fields(r,['marca','nome','campanha_id','status','agendado_em','enviado_em','coletado_em']))??null,capabilities:{read:true,send:false}};
}
module.exports={createPublicReadKeyInstaller,readPublicReadKey,PUBLIC_READ_PURPOSE,PUBLIC_READ_LABEL,createReader,sourceKeysFromEnv,createAffiliateEditor,affiliateWriteKeyFromEnv,projectCrmHome};
