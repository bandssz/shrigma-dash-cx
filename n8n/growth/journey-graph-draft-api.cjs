/* Private OFF candidate. No route, activation, source resolver or transport. */
'use strict';
const {createHash}=require('node:crypto'),G=require('./journey-graph-contract.js'),{createGraphRuntime}=require('./journey-graph-runtime.cjs');
const VERSION='journey_graph_draft_api_v1',ENABLED=false;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const API_ERROR=Symbol('graph_api_error');
const fail=(status,code)=>Object.assign(Error(code),{status,code,[API_ERROR]:true});
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const digest=x=>createHash('sha256').update(canonical(x)).digest('hex');
const response=(status,body)=>({status,headers:{'Cache-Control':'no-store'},body:{contract:VERSION,authorizes_publish:false,authorizes_send:false,...body}});
function copyJSON(value){
 const seen=new Set();let count=0;
 function visit(x,depth){
  if(++count>20000||depth>24)throw fail(413,'GRAPH_REQUEST_SIZE');
  if(x===null||typeof x==='boolean'||typeof x==='string'||typeof x==='number'&&Number.isFinite(x))return;
  if(!x||typeof x!=='object'||seen.has(x)||Object.getOwnPropertySymbols(x).length||!Array.isArray(x)&&![Object.prototype,null].includes(Object.getPrototypeOf(x)))throw fail(400,'GRAPH_REQUEST_INVALID');
  if(Array.isArray(x)&&(Object.keys(x).length!==x.length||Object.keys(x).some((k,i)=>k!==String(i))))throw fail(400,'GRAPH_REQUEST_INVALID');
  seen.add(x);for(const [key,d]of Object.entries(Object.getOwnPropertyDescriptors(x))){if(Array.isArray(x)&&key==='length')continue;if(!d.enumerable||!Object.hasOwn(d,'value')||['__proto__','prototype','constructor'].includes(key))throw fail(400,'GRAPH_REQUEST_INVALID');visit(d.value,depth+1);}seen.delete(x);
 }
 visit(value,0);const text=JSON.stringify(value);if(Buffer.byteLength(text)>196608)throw fail(413,'GRAPH_REQUEST_SIZE');return JSON.parse(text);
}
function exact(x,keys){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))throw fail(400,'GRAPH_REQUEST_INVALID');}
function id(x){if(typeof x!=='string'||!UUID.test(x))throw fail(400,'GRAPH_REQUEST_INVALID');}
function createDraftApi({pool,catalogFor}={}){
 if(typeof pool?.connect!=='function'||typeof catalogFor!=='function')throw Error('GRAPH_API_ADAPTER_REQUIRED');
 async function authenticate(query,key,needed){
  const r=await query("SELECT public.shrigma_panel_operator_v1($1,'growth') AS auth",[key]),auth=r.rows?.[0]?.auth;
  if(r.rows?.length!==1||!auth||typeof auth.who!=='string'||!/^panel:[A-Za-z0-9_.:-]{1,122}$/.test(auth.who)||!Array.isArray(auth.caps))throw fail(401,'GRAPH_UNAUTHORIZED');
  if(!auth.caps.includes(needed))throw fail(403,'GRAPH_PERMISSION_REQUIRED');
  return auth.who;
 }
 async function catalog(query,brand){
  const c=copyJSON(await catalogFor({brand,query}));
  const probe={version:G.VERSION,brand,name:'Catálogo',nodes:[{id:'entry',type:'trigger',event:'cart.abandoned'},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'entry',port:'next',to:'end'}]};
  const checked=G.validateGraph(probe,{catalog:c});if(!checked.ok&&checked.errors[0]?.code!=='GRAPH_TRIGGER_UNAVAILABLE')throw fail(503,'GRAPH_CATALOG_UNAVAILABLE');
  return c;
 }
 function server(row){return {journey_id:row.id,brand:row.brand,version:row.version,revision:row.head_revision,published_revision:row.published_revision,paused:row.paused};}
 async function read(query,p,actor){
  if(p.action==='catalog')return {catalog:await catalog(query,p.brand)};
  if(p.action==='list'){
   const r=await query('SELECT j.*,r.definition->>\'name\' AS name FROM crm_graph_candidate.journey j JOIN crm_graph_candidate.revision r ON r.journey_id=j.id AND r.revision=j.head_revision AND r.brand=j.brand WHERE j.brand=$1 AND ($2::uuid IS NULL OR j.id>$2::uuid) ORDER BY j.id LIMIT $3',[p.brand,p.after,p.limit+1]);
   const rows=r.rows.slice(0,p.limit);return {journeys:rows.map(row=>({...server(row),name:row.name})),next_cursor:r.rows.length>p.limit?rows.at(-1).id:null};
  }
  if(p.action==='get'){
   const r=await query('SELECT j.*,r.definition,r.catalog,r.content_hash FROM crm_graph_candidate.journey j JOIN crm_graph_candidate.revision r ON r.journey_id=j.id AND r.revision=j.head_revision AND r.brand=j.brand WHERE j.id=$1::uuid AND j.brand=$2',[p.journey_id,p.brand]);
   if(r.rows.length!==1)throw fail(404,'GRAPH_NOT_FOUND');const row=r.rows[0];
   if(digest({definition:row.definition,catalog:row.catalog})!==row.content_hash)throw fail(503,'GRAPH_READBACK_UNCONFIRMED');
   // Head and definition come from one statement snapshot. The current catalog
   // is separate: saving a new revision must pass the current server catalog.
   return {server:server(row),definition:row.definition,catalog:await catalog(query,p.brand)};
  }
  if(p.action==='operation'){
   const q='SELECT request_id,actor,brand,action,response FROM crm_graph_candidate.operation WHERE request_id=$1::uuid';
   let r=await query(q,[p.request_id]);
   if(!r.rows.length){
    const lock=await query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[p.request_id]);
    if(lock.rows?.[0]?.acquired)r=await query(q,[p.request_id]);
   }
   if(!r.rows.length)return {state:'unconfirmed',request_id:p.request_id,retry_same_request_only:true};
   const row=r.rows[0];if(row.actor!==actor||row.brand!==p.brand||!['create','save'].includes(row.action))throw fail(404,'GRAPH_OPERATION_NOT_FOUND');
   const receipt=row.response;if(receipt?.contract!=='journey_graph_store_v1'||receipt.operation_id!==p.request_id||receipt.brand!==p.brand||receipt.authorizes_send!==false)throw fail(503,'GRAPH_READBACK_UNCONFIRMED');
   return {state:'succeeded',request_id:p.request_id,action:row.action,receipt};
  }
  throw fail(400,'GRAPH_ACTION_UNAVAILABLE');
 }
 async function withRead(key,needed,fn){
  const c=await pool.connect();let discard=null;
  try{await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='5s'");await c.query("SET LOCAL lock_timeout='2s'");const actor=await authenticate(c.query.bind(c),key,needed);const result=await fn(c.query.bind(c),actor);await c.query('COMMIT');return result;}
  catch(e){try{await c.query('ROLLBACK');}catch(rollback){discard=rollback;}throw e;}
  finally{c.release(discard||undefined);}
 }
 return Object.freeze({enabled:false,async handle(envelope){
  let request=null,writing=false;
  try{
   const input=copyJSON(envelope);exact(input,['method','authorization','request']);
   if(typeof input.authorization!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(input.authorization))throw fail(401,'GRAPH_UNAUTHORIZED');
   const key=input.authorization.slice(7),p=input.request;request=p;
   if(!p||typeof p!=='object'||Array.isArray(p)||!['fish','aristo'].includes(p.brand))throw fail(400,'GRAPH_REQUEST_INVALID');
   const actions={catalog:[],list:['after','limit'],get:['journey_id'],operation:['request_id'],create:['request_id','definition'],save:['request_id','journey_id','expected_version','definition']};
   if(typeof p.action!=='string'||!Object.hasOwn(actions,p.action))throw fail(400,'GRAPH_ACTION_UNAVAILABLE');exact(p,['action','brand',...actions[p.action]]);
   writing=p.action==='create'||p.action==='save';if(input.method!==(writing?'POST':'GET'))throw fail(405,'GRAPH_METHOD_NOT_ALLOWED');
   if(Object.hasOwn(p,'request_id')){id(p.request_id);p.request_id=p.request_id.toLowerCase();}if(Object.hasOwn(p,'journey_id')){id(p.journey_id);p.journey_id=p.journey_id.toLowerCase();}
   if(p.action==='list'){if(p.after!==null){id(p.after);p.after=p.after.toLowerCase();}if(!Number.isInteger(p.limit)||p.limit<1||p.limit>50)throw fail(400,'GRAPH_REQUEST_INVALID');}
   if(p.action==='save'&&(!Number.isSafeInteger(p.expected_version)||p.expected_version<1||p.expected_version>=2147483647))throw fail(400,'GRAPH_REQUEST_INVALID');
   if(!writing){const value=await withRead(key,'read_content',(query,actor)=>read(query,p,actor));return response(value.state==='unconfirmed'?202:200,value);}
   // Never accept actor/caps from the request. Author is resolved by the current
   // manager helper, then checked again inside the runtime transaction/replay.
   const actor=await withRead(key,'draft',async(_,who)=>who);
   const runtime=createGraphRuntime({pool,catalogFor,readSource:async()=>{throw Error('GRAPH_SOURCE_DISABLED');},beforeCommand:async({query,actor:claimed,action,brand})=>{
    if(!['create','save'].includes(action)||brand!==p.brand||claimed!==actor)throw fail(403,'GRAPH_PERMISSION_REQUIRED');
    const current=await authenticate(query,key,'draft');if(current!==claimed)throw fail(401,'GRAPH_UNAUTHORIZED');
   }});
   const command={request_id:p.request_id,actor,brand:p.brand,definition:p.definition,...(p.action==='save'?{journey_id:p.journey_id,expected_version:p.expected_version}:{})};
   const receipt=await runtime[p.action](command);return response(p.action==='create'?201:200,{state:'succeeded',request_id:p.request_id,receipt});
  }catch(e){
   if(e[API_ERROR])return response(e.status,{error:e.code});
   if(e.code==='GRAPH_OUTCOME_UNKNOWN')return response(202,{state:'unconfirmed',request_id:request?.request_id,retry_same_request_only:true,error:'GRAPH_OUTCOME_UNKNOWN'});
   const status={GRAPH_NOT_FOUND:404,GRAPH_VERSION_CONFLICT:409,GRAPH_REPLAY_MISMATCH:409,GRAPH_CATALOG_CHANGED:409,GRAPH_REVISION_CORRUPT:503}[e.code];
   if(status)return response(status,{error:e.code});
   const validation=['GRAPH_SHAPE','GRAPH_VERSION','GRAPH_TEXT','GRAPH_ID','GRAPH_RANGE','GRAPH_SIZE','GRAPH_JSON','GRAPH_CATALOG','GRAPH_DUPLICATE','GRAPH_FIELD','GRAPH_CONDITION','GRAPH_CONDITION_TYPE','GRAPH_TRIGGER','GRAPH_TRIGGER_UNAVAILABLE','GRAPH_MESSAGE_UNAVAILABLE','GRAPH_MESSAGE_FIELDS','GRAPH_NODE_TYPE','GRAPH_EDGE','GRAPH_PARALLEL','GRAPH_PORTS','GRAPH_BRANCH','GRAPH_CYCLE','GRAPH_ORPHAN','GRAPH_CANDIDATE_SCOPE','GRAPH_INPUT_SHAPE','GRAPH_INPUT_JSON','GRAPH_INPUT_SIZE'];
   if(validation.includes(e.code))return response(422,{error:e.code});
   // Never expose provider/SQL text, key, actor or a raw callback exception.
   return response(503,{error:'GRAPH_SERVICE_UNAVAILABLE',...(writing&&request?.request_id?{state:'unconfirmed',request_id:request.request_id,retry_same_request_only:true}:{})});
  }
 }});
}
module.exports={VERSION,ENABLED,createDraftApi};
