'use strict';
// Leitura isolada de listas, públicos salvos e vínculo de campanha.
// Não chama refresh_native_catalog, não bloqueia linhas, não grava recibos,
// contadores ou catálogo. Cada consulta passa por uma allowlist fixa e roda
// numa transação READ ONLY do papel crm_audience_reader, sempre desfeita.
const S=require('../../n8n/growth/segment-audience-store.cjs'),B=require('../../n8n/growth/segment-campaign-binding.cjs');
const ROLE='crm_audience_reader',FRESHNESS='crm-audience-read-freshness-v1',CONTEXT='crm-audience-campaign-read-context-v1';
const ACTIONS=Object.freeze({lists:'publicos_listas',list:'segmentos_listar',get:'segmento_obter',binding:'campanha_publico_obter',context:'campanha_publico_contexto'});
const FIELDS=Object.freeze({publicos_listas:[],segmentos_listar:['limit','offset'],segmento_obter:['id'],campanha_publico_obter:['campaign_id'],campanha_publico_contexto:['campaign_id']});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,BEARER=/^Bearer ([a-z0-9-]{8,128})$/;
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const exact=(o,keys)=>!!o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
// Únicas instruções que este módulo pode emitir. As do catálogo legado com
// FOR SHARE são trocadas pelas funções crm_audience_read.* equivalentes.
const SQL=Object.freeze({
 setup:"SELECT pg_catalog.set_config('search_path','pg_catalog',true),pg_catalog.set_config('lock_timeout','500ms',true)",
 auth:S.SQL.auth,
 config:"SELECT brand,enabled,base_list_id,revision,catalog,checked_at,expires_at,pg_catalog.clock_timestamp() AS read_at FROM crm_audience_read.config_snapshot($1::text)",
 lists:"SELECT id,name,status,optin FROM crm_audience_read.catalog_lists($1::text)",
 recorded:S.SQL.recorded,shopify:S.SQL.shopify,rfm:S.SQL.rfm,
 list:"SELECT * FROM crm_audience_v2.audience WHERE brand=$1::text ORDER BY updated_at DESC,id LIMIT $2::integer OFFSET $3::integer",
 get:"SELECT * FROM crm_audience_v2.audience WHERE id=$1::uuid AND brand=$2::text",
 campaign:"SELECT crm_audience_read.campaign_current($1::integer) AS current",
 head:"SELECT * FROM crm_audience_v2.campaign_binding WHERE campaign_id=$1::integer AND brand=$2::text",
 released:"SELECT EXISTS(SELECT 1 FROM crm_audience_v2.campaign_binding_release WHERE campaign_id=$1::integer AND binding_version=$2::integer AND binding_hash=$3::text) AS released"
});
const REWRITE=new Map([[S.SQL.config,SQL.config],[S.SQL.lists,SQL.lists]]),ALLOWED=new Set(Object.values(SQL));

function request(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw fail('SEGMENT_REQUEST_INVALID',400);
 const p={...raw};
 if(!Object.hasOwn(FIELDS,p.acao)||!['fish','aristo'].includes(p.brand))throw fail('SEGMENT_REQUEST_INVALID',400);
 const allowed=['acao','brand',...FIELDS[p.acao]];if(Object.keys(p).some(k=>!allowed.includes(k)))throw fail('SEGMENT_FIELDS',400);
 for(const k of Object.keys(p))if(typeof p[k]!=='string'||p[k].length>64)throw fail('SEGMENT_FIELDS',400);
 if(p.acao===ACTIONS.list){
  for(const [k,fallback]of [['limit',50],['offset',0]]){if(!Object.hasOwn(p,k))p[k]=fallback;else if(/^(0|[1-9][0-9]{0,5})$/.test(p[k]))p[k]=Number(p[k]);else throw fail('SEGMENT_PAGE_INVALID',400);}
  if(p.limit<1||p.limit>100||p.offset>10000)throw fail('SEGMENT_PAGE_INVALID',400);
 }else for(const k of FIELDS[p.acao])if(!Object.hasOwn(p,k))throw fail('SEGMENT_FIELDS',400);
 if(Object.hasOwn(p,'id')){if(!UUID.test(p.id))throw fail('SEGMENT_ID_INVALID',400);p.id=p.id.toLowerCase();}
 if(Object.hasOwn(p,'campaign_id')){if(!/^[1-9][0-9]{0,9}$/.test(p.campaign_id)||!positive(Number(p.campaign_id)))throw fail('SEGMENT_FIELDS',400);p.campaign_id=Number(p.campaign_id);}
 return Object.freeze(p);
}
function iso(v){if(v===null||v===undefined)return null;const n=v instanceof Date?v.getTime():Date.parse(v);if(!Number.isFinite(n))throw fail('SEGMENT_READ_UNCONFIRMED');return new Date(n).toISOString();}
// Idade/cobertura do catálogo lido. Leitura nunca serve de prova para
// agendamento: schedule_proof é sempre false, mesmo com catálogo atual.
function freshness(row,ready){
 const read_at=iso(row.read_at),refreshed=iso(row.checked_at),expires=iso(row.expires_at);
 const stale=!ready||refreshed===null||expires===null||Date.parse(expires)<=Date.parse(read_at);
 const age=refreshed===null?null:Math.max(0,Math.floor((Date.parse(read_at)-Date.parse(refreshed))/1000));
 return {contract:FRESHNESS,catalog_refreshed_at:refreshed,catalog_expires_at:expires,catalog_age_seconds:age,read_at,current:!stale,stale,coverage:'unconfirmed',schedule_proof:false};
}
function bearer(value){const m=typeof value==='string'?BEARER.exec(value):null;return m?m[1]:null;}

function createReadTransaction({pool,statementTimeoutMs=8000,role=ROLE}={}){
 if(typeof pool?.connect!=='function'||!Number.isInteger(statementTimeoutMs)||statementTimeoutMs<1||statementTimeoutMs>30000||role!==ROLE)throw fail('CRM_AUDIENCE_READ_TRANSACTION_CONFIG');
 let active=0;const waiters=new Set();
 async function transaction(work,{signal}={}){
  if(typeof work!=='function'||signal!==undefined&&!(signal instanceof AbortSignal))throw fail('CRM_AUDIENCE_READ_TRANSACTION_INPUT');
  if(signal?.aborted)throw fail('CRM_AUDIENCE_READ_ABORTED');
  active++;let client,destroy=false,begun=false;
  try{
   client=await pool.connect();
   await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');begun=true;
   await client.query(`SET LOCAL statement_timeout='${statementTimeoutMs}ms'`);
   const id=(await client.query("SELECT current_user AS role,pg_catalog.current_setting('transaction_read_only') AS read_only"))?.rows;
   if(id?.length!==1||id[0].role!==role||id[0].read_only!=='on')throw fail('CRM_AUDIENCE_READ_ROLE');
   const tx=Object.freeze({query:async(text,values=[])=>{
    if(signal?.aborted)throw fail('CRM_AUDIENCE_READ_ABORTED');
    if(!ALLOWED.has(text)||!Array.isArray(values))throw fail('CRM_AUDIENCE_READ_STATEMENT_DENIED');
    const r=await client.query({text,values});if(signal?.aborted)throw fail('CRM_AUDIENCE_READ_ABORTED');return r;
   }});
   const result=await work(tx);
   // Uma transação que não escreveu (nem bloqueou linha) não recebe xid.
   const xid=(await client.query('SELECT pg_catalog.txid_current_if_assigned() AS xid'))?.rows;
   if(xid?.length!==1||xid[0].xid!==null)throw fail('CRM_AUDIENCE_READ_WRITE_DETECTED');
   await client.query('ROLLBACK');begun=false;return result;
  }catch(e){destroy=true;if(client&&begun){try{await client.query('ROLLBACK');}catch{}}throw e;}
  finally{if(client){try{client.release(destroy);}catch{}}active--;if(active===0){for(const r of waiters)r();waiters.clear();}}
 }
 transaction.active=()=>active;
 transaction.drain=()=>active===0?Promise.resolve():new Promise(r=>waiters.add(r));
 return Object.freeze(transaction);
}

function createAudienceReadStore({transaction,timeoutMs=9000}={}){
 if(typeof transaction!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw fail('CRM_AUDIENCE_READ_ADAPTER');
 async function handle({authorization,query:raw}={},{signal:external}={}){
  let p;try{p=request(raw);}catch(e){return {status:e.status||400,body:{error:e.code||'SEGMENT_REQUEST_INVALID'}};}
  const key=bearer(authorization);if(!key)return {status:401,body:{error:'SEGMENT_UNAUTHORIZED'}};
  const controller=new AbortController();let timer,onAbort;
  const run=()=>transaction(async tx=>{
   let configRow=null;
   const query=async(text,values=[])=>{
    const r=await tx.query(REWRITE.get(text)||text,values);if(!r||!Array.isArray(r.rows))throw fail('SEGMENT_READ_UNCONFIRMED');
    if(text===S.SQL.config)configRow=r.rows.length===1?r.rows[0]:null;return r;
   };
   await query(SQL.setup);
   const first=await S.readAuth(query,key,'read_content');
   const reauth=async()=>{const a=await S.readAuth(query,key,'read_content');if(a.actor!==first.actor)throw fail('SEGMENT_UNAUTHORIZED',401);};
   const catalog=await S.readCatalog(query,p.brand);if(!configRow)throw fail('SEGMENT_READ_UNCONFIRMED');
   const fresh=freshness(configRow,catalog.ready);
   let body;
   if(p.acao===ACTIONS.lists){
    body={brand:p.brand,base_list_id:positive(catalog.base_list_id)?catalog.base_list_id:null,lists:catalog.catalog.lists,freshness:fresh};
   }else if(p.acao===ACTIONS.list){
    const rows=(await query(SQL.list,[p.brand,p.limit,p.offset])).rows;
    body={segments:rows.map(row=>S.publicSegment(row,catalog)),limit:p.limit,offset:p.offset,catalog:catalog.catalog,capabilities:{draft:false,count:false,send:false},freshness:fresh};
   }else if(p.acao===ACTIONS.get){
    const rows=(await query(SQL.get,[p.id,p.brand])).rows;if(rows.length!==1)throw fail('SEGMENT_NOT_FOUND',404);
    body={segment:S.publicSegment(rows[0],catalog),freshness:fresh};
   }else{
    const current=(await query(SQL.campaign,[p.campaign_id])).rows[0]?.current;
    if(!current||current.id!==p.campaign_id||current.definition?.brand!==p.brand)throw fail('SEGMENT_BINDING_CAMPAIGN_NOT_FOUND',404);
    if(typeof current.version!=='string'||!/^[a-f0-9]{32}$/.test(current.version)||current.definition.schema_version!=='crm-campaign-v1'||!Array.isArray(current.definition.list_ids)||current.definition.list_ids.length>30||current.definition.list_ids.some(id=>!positive(id)))throw fail('SEGMENT_READ_UNCONFIRMED');
    const heads=(await query(SQL.head,[p.campaign_id,p.brand])).rows;if(heads.length>1)throw fail('SEGMENT_READ_UNCONFIRMED');
    let state='none',view=null;
    if(heads.length===1){
     const head=heads[0];B.binding(head);
     const released=(await query(SQL.released,[p.campaign_id,head.binding_version,head.binding_hash])).rows[0]?.released;
     if(typeof released!=='boolean')throw fail('SEGMENT_READ_UNCONFIRMED');
     if(released)state='released';else{state='bound';view=B.view(head,current,catalog);}
    }
    if(p.acao===ACTIONS.binding)body={binding:view,campaign_id:p.campaign_id,campaign_version:current.version,...B.FLAGS};
    else{
     const known=new Map(catalog.catalog.lists.map(l=>[l.id,l]));
     body={contract:CONTEXT,brand:p.brand,campaign_id:p.campaign_id,campaign_version:current.version,status:typeof current.status==='string'?current.status:null,
      list_ids:current.definition.list_ids.slice(),lists:current.definition.list_ids.map(id=>known.has(id)?{id,name:known.get(id).name,available:known.get(id).available,in_brand:true}:{id,name:null,available:false,in_brand:false}),
      list_only:state!=='bound',binding_state:state,binding:view,freshness:fresh,schedule_proof:false,...B.FLAGS};
    }
   }
   await reauth();if(controller.signal.aborted)throw fail('SEGMENT_READ_UNAVAILABLE');
   return {status:200,body};
  },{signal:controller.signal});
  if(external?.aborted)return {status:503,body:{error:'SEGMENT_READ_UNAVAILABLE'}};
  const aborted=new Promise((_,reject)=>{onAbort=()=>{controller.abort();reject(fail('SEGMENT_READ_UNAVAILABLE'));};external?.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([run(),aborted,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('SEGMENT_READ_UNAVAILABLE'));},timeoutMs);})]);}
  catch(e){
   if(['SEGMENT_UNAUTHORIZED','SEGMENT_ACCESS_DENIED','SEGMENT_NOT_FOUND','SEGMENT_BINDING_CAMPAIGN_NOT_FOUND'].includes(e?.code))return {status:e.status,body:{error:e.code}};
   return {status:503,body:{error:'SEGMENT_READ_UNAVAILABLE'}};
  }finally{clearTimeout(timer);external?.removeEventListener('abort',onAbort);controller.abort();}
 }
 return Object.freeze({handle});
}
module.exports={ROLE,FRESHNESS,CONTEXT,ACTIONS,FIELDS,SQL,request,freshness,createReadTransaction,createAudienceReadStore};
