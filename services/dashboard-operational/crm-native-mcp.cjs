'use strict';
const {Readable,Writable}=require('node:stream');
const {readJson}=require('./proxy.cjs');
const ENDPOINT='/api/native/mcp',VERSIONS=['2025-11-25','2025-06-18','2025-03-26'];
const BRANDS=['fish','aristo'];
const obj=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const brand={type:'string',enum:BRANDS},id={type:'integer',minimum:1},key={type:'string',pattern:'^[A-Za-z0-9_-]{16,100}$'};
const tools=[
 ['crm_status','Verificar acesso CRM','crm.read',obj(),false,false],
 ['crm_campaign_catalog','Consultar catálogo da marca','crm.read',obj({brand},['brand']),true,false],
 ['crm_campaign_list','Listar campanhas da marca','crm.read',obj({brand},['brand']),true,false],
 ['crm_campaign_get','Reler campanha original','crm.read',obj({brand,id},['brand','id']),true,false],
 ['crm_campaign_save','Salvar rascunho existente','crm.draft',obj({brand,id,expected_version:{type:'string',pattern:'^[a-f0-9]{32}$'},definition:{type:'object'},idempotency_key:key},['brand','id','expected_version','definition','idempotency_key']),false,false],
 ['crm_campaign_operation','Consultar a tentativa original','crm.draft',obj({brand,idempotency_key:key},['brand','idempotency_key']),false,false],
 ['crm_users','Consultar acessos individuais','crm.iam',obj(),false,false],
 ['crm_user_update','Atualizar acesso individual da marca','crm.iam',obj({userId:{type:'string',minLength:1,maxLength:80},expectedRevision:{type:'string',pattern:'^[a-f0-9]{64}$'},brand,access:{type:'string',enum:['read','edit']}},['userId','expectedRevision','brand','access']),false,true],
 ['crm_user_revoke','Revogar acesso individual da marca','crm.iam',obj({userId:{type:'string',minLength:1,maxLength:80},brand},['userId','brand']),false,true],
 ['db_inspect','Verificar admissão do banco próprio','db.inspect',obj(),true,false],
 ['db_migration_preview','Revisar migração cadastrada','db.inspect',obj({migrationId:{type:'string',minLength:1,maxLength:100},expectedSha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},['migrationId','expectedSha256']),true,false],
 ['db_migration_apply','Aplicar migração própria revisada','db.install',obj({migrationId:{type:'string',minLength:1,maxLength:100},expectedSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},operationId:{type:'string',pattern:'^[0-9a-f-]{36}$'}},['migrationId','expectedSha256','operationId']),false,true],
 ['db_migration_status','Reler operação de instalação original','db.inspect',obj({operationId:{type:'string',pattern:'^[0-9a-f-]{36}$'}},['operationId']),true,false]
].map(([name,title,scope,inputSchema,readOnlyHint,destructiveHint])=>({name,title,scope,inputSchema,description:title+'. Usa identidade e permissões efetivas; não promove grants. '+(name.includes('operation')?'A consulta pode reconciliar o journal da operação original.':''),annotations:{readOnlyHint,destructiveHint,idempotentHint:readOnlyHint,openWorldHint:false}}));
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
function validate(schema,x){
 if(schema.type==='object'){
  if(!plain(x))fail('NATIVE_ARGUMENTS_INVALID');
  if(schema.additionalProperties===false&&Object.keys(x).some(k=>!Object.hasOwn(schema.properties,k)))fail('NATIVE_ARGUMENTS_INVALID');
  if((schema.required||[]).some(k=>!Object.hasOwn(x,k)))fail('NATIVE_ARGUMENTS_INVALID');
  for(const [k,s]of Object.entries(schema.properties||{}))if(Object.hasOwn(x,k))validate(s,x[k]);
 }else if(schema.type==='string'){
  if(typeof x!=='string'||schema.enum&&!schema.enum.includes(x)||schema.minLength&&x.length<schema.minLength||schema.maxLength&&x.length>schema.maxLength||schema.pattern&&!new RegExp(schema.pattern).test(x))fail('NATIVE_ARGUMENTS_INVALID');
 }else if(schema.type==='integer'&&(!Number.isSafeInteger(x)||x<(schema.minimum??Number.MIN_SAFE_INTEGER)))fail('NATIVE_ARGUMENTS_INVALID');
}
const redact=x=>{
 if(Array.isArray(x))return x.map(redact);
 if(!plain(x))return x;
 return Object.fromEntries(Object.entries(x).filter(([k])=>!/(?:password|cookie|csrf|uiKey|bearer|token|credential|inviteUrl|principalId|actorId)/i.test(k)&&!['email','owner'].includes(k)).map(([k,v])=>[k,redact(v)]));
};
function response(res,status,body){res.statusCode=status;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.end(body===undefined?'':JSON.stringify(body));}
// Calls the SAME gateway request dispatcher. There is no arbitrary URL,
// upstream token, network client, actor payload, or alternate writer here.
function dispatchJson(dispatch,{method,path,body,context}){
 return new Promise((resolve,reject)=>{
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  req.method=method;req.url=path;req.headers={host:context.host,origin:context.origin,'x-csrf-token':context.csrf,...(body===undefined?{}:{'content-type':'application/json'})};req.socket={remoteAddress:'native-delegation'};
  const chunks=[];let bytes=0,settled=false;
  const res=new Writable({write(chunk,encoding,cb){bytes+=chunk.length;if(bytes>2*1024*1024)return cb(Object.assign(Error('NATIVE_RESPONSE_LIMIT'),{code:'NATIVE_RESPONSE_LIMIT'}));chunks.push(Buffer.from(chunk));cb();}});
  res.statusCode=200;const headers=new Map();res.setHeader=(k,v)=>headers.set(k.toLowerCase(),v);res.getHeader=k=>headers.get(k.toLowerCase());res.removeHeader=k=>headers.delete(k.toLowerCase());
  const timer=setTimeout(()=>{if(settled)return;settled=true;reject(Object.assign(Error('NATIVE_OPERATION_UNCERTAIN'),{code:'NATIVE_OPERATION_UNCERTAIN',status:504}));},95000);timer.unref?.();
  res.once('finish',()=>{if(settled)return;settled=true;clearTimeout(timer);try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{reject(Object.assign(Error('NATIVE_RESPONSE_INVALID'),{code:'NATIVE_RESPONSE_INVALID',status:502}));}});
  res.once('error',e=>{if(settled)return;settled=true;clearTimeout(timer);reject(e);});
  res.once('close',()=>{if(!settled&&!res.writableFinished){settled=true;clearTimeout(timer);reject(Object.assign(Error('NATIVE_OPERATION_UNCERTAIN'),{code:'NATIVE_OPERATION_UNCERTAIN',status:502}));}});
  try{dispatch(req,res,context);}catch(e){clearTimeout(timer);settled=true;reject(e);}
 });
}
function createNativeMcp({auth,managerHost,invoke,installer}={}){
 if(!auth?.nativeConnections||typeof invoke!=='function'||typeof managerHost!=='string')throw Error('NATIVE_CONFIG_INVALID');
 const store=auth.nativeConnections;
 async function call(name,args,bearer){
  const tool=tools.find(t=>t.name===name);if(!tool)fail('NATIVE_TOOL_NOT_FOUND');validate(tool.inputSchema,args);
  store.authenticate(bearer,{scope:tool.scope,brand:args.brand});
  const context=store.context(bearer),run=async(method,path,body)=>{
   // No retry on POST or uncertain ACK. Caller retains the original operation key.
   store.authenticate(bearer,{scope:tool.scope,brand:args.brand});
   const result=await invoke({method,path,body,context:{...context,method}});
   store.authenticate(bearer,{scope:tool.scope,brand:args.brand});
   return result;
  };
  let result;
  if(name==='crm_status'){
   const state=await run('GET','/auth/session');
   result={status:state.status,body:{authenticated:state.body?.authenticated===true,role:state.body?.user?.role,brands:store.authenticate(bearer).brands,permissions:state.body?.user?.permissions,features:state.body?.features,operational:false}};
  }else if(name.startsWith('crm_campaign_')){
   const actions={crm_campaign_catalog:'campanha_catalogo',crm_campaign_list:'campanha_listar',crm_campaign_get:'campanha_obter',crm_campaign_save:'campanha_salvar',crm_campaign_operation:'campanha_operacao'},action=actions[name];
   if(!action)fail('NATIVE_TOOL_NOT_FOUND');
   if(name==='crm_campaign_save')result=await run('POST','/api/campaigns',{acao:action,...args});
   else{const q=new URLSearchParams({acao:action,...Object.fromEntries(Object.entries(args).map(([k,v])=>[k,String(v)]))});result=await run('GET','/api/campaigns?'+q);}
  }else if(name.startsWith('crm_user')){
   const listing=await run('GET','/auth/users');
   if(listing.status!==200)return redact(listing);
   const allowed=store.authenticate(bearer).brands;
   const users=(listing.body?.users||[]).filter(u=>u.role==='manager'&&allowed.includes(u.brand)&&u.areas?.length===1&&u.areas[0]==='growth');
   if(name==='crm_users')result={status:200,body:{users:users.map(u=>({id:u.id,brand:u.brand,role:u.role,status:u.status,permissions:u.permissions,profileRevision:u.profileRevision,crmAccess:u.crmAccess,crmWriter:u.crmWriter,campaignContentAccess:u.campaignContentAccess}))}};
   else{
    const user=users.find(u=>u.id===args.userId&&u.brand===args.brand);if(!user)fail('BRAND_USER_DENIED',403);
    const body=name==='crm_user_update'?{action:'update',userId:user.id,expectedRevision:args.expectedRevision,email:user.email,area:'growth',brand:args.brand,access:args.access}:{action:'revoke',userId:user.id};
    result=await run('POST','/auth/users',body);
   }
  }else if(name.startsWith('db_')){
   if(!installer)fail('NATIVE_INSTALLER_NOT_ADMITTED',503);
   const fn={db_inspect:'inspect',db_migration_preview:'preview',db_migration_apply:'apply',db_migration_status:'status'}[name];
   result={status:200,body:await installer[fn](args)};
   store.authenticate(bearer,{scope:tool.scope});
  }else fail('NATIVE_TOOL_NOT_FOUND');
  return redact(result);
 }
 async function handle(req,res,url){
  if(url.pathname!==ENDPOINT)return false;
  if(String(req.headers.host||'').toLowerCase()!==managerHost)fail('HOST_DENIED',421);
  if(url.search)fail('NATIVE_QUERY_DENIED');
  if(req.headers.origin!==undefined&&req.headers.origin!=='https://'+managerHost)fail('ORIGIN_DENIED',403);
  const header=req.headers.authorization,bearer=typeof header==='string'&&/^Bearer [A-Za-z0-9_-]{43}$/.test(header)?header.slice(7):null;
  try{store.authenticate(bearer);}catch{res.setHeader('WWW-Authenticate','Bearer');response(res,401,{error:'NATIVE_AUTH_REQUIRED'});return true;}
  if(req.method==='GET'||req.method==='DELETE'){res.setHeader('Allow','POST');response(res,405,{error:'METHOD_DENIED'});return true;}
  if(req.method!=='POST')fail('METHOD_DENIED',405);
  if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')fail('CONTENT_TYPE_DENIED',415);
  const accept=String(req.headers.accept||'');if(!accept.includes('application/json')||!accept.includes('text/event-stream'))fail('NATIVE_ACCEPT_REQUIRED',406);
  const version=req.headers['mcp-protocol-version'];if(version!==undefined&&!VERSIONS.includes(version))fail('NATIVE_PROTOCOL_UNSUPPORTED');
  let message;try{message=await readJson(req,600*1024);}catch{fail('NATIVE_MESSAGE_INVALID');}
  if(!plain(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||Object.keys(message).some(k=>!['jsonrpc','method','id','params'].includes(k))||message.id!==undefined&&!(typeof message.id==='string'||Number.isSafeInteger(message.id)))fail('NATIVE_MESSAGE_INVALID');
  if(message.id===undefined){
   if(message.method!=='notifications/initialized'&&message.method!=='notifications/cancelled')fail('NATIVE_NOTIFICATION_UNSUPPORTED');
   response(res,202);return true;
  }
  let result;
  if(message.method==='initialize'){
   if(!plain(message.params)||typeof message.params.protocolVersion!=='string')fail('NATIVE_MESSAGE_INVALID');
   result={protocolVersion:VERSIONS.includes(message.params.protocolVersion)?message.params.protocolVersion:VERSIONS[0],capabilities:{tools:{listChanged:false}},serverInfo:{name:'shrigma-native',version:'0.1.0'},instructions:'Use marcas admitidas e a operação original. Código/instalação não comprovam operação CRM. Segredos são privados.'};
  }else if(message.method==='ping')result={};
  else if(message.method==='tools/list'){
   const proof=store.authenticate(bearer);result={tools:tools.filter(t=>proof.scopes.includes(t.scope)).map(({scope,...t})=>t)};
  }else if(message.method==='tools/call'){
   try{
    if(!plain(message.params)||Object.keys(message.params).some(k=>!['name','arguments','_meta'].includes(k)))fail('NATIVE_ARGUMENTS_INVALID');
    const value=await call(message.params.name,message.params.arguments??{},bearer);
    result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:value.status>=400};
   }catch(e){const value={status:Number.isInteger(e.status)?e.status:500,error:/^[A-Z][A-Z0-9_]{1,100}$/.test(e.code||'')?e.code:'NATIVE_REQUEST_FAILED'};result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:true};}
  }else{response(res,200,{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}});return true;}
  response(res,200,{jsonrpc:'2.0',id:message.id,result});return true;
 }
 return Object.freeze({handle,call,tools});
}
module.exports={createNativeMcp,dispatchJson,ENDPOINT,validate,redact};
