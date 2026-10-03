'use strict';
// Leitura de templates com marca obrigatória (contrato crm-template-read-v1,
// §9.5 de docs/crm/PARIDADE-LEITURA-PORTAL-20261003.md). Só chama as três
// funções STABLE de n8n/growth/crm-template-read-access.sql, numa transação
// READ ONLY do papel crm_template_reader, sempre desfeita (ROLLBACK) e
// conferida sem xid. Não consulta Listmonk/Meta, não grava recibo, contador ou
// último uso. A resposta passa pela mesma validação da ponte do portal antes
// de sair; qualquer item fora da marca recusa a página inteira.
const Bridge=require('../dashboard-operational/crm-template-read-bridge.cjs');
const ROLE='crm_template_reader',CONTRACT='crm-template-read-v1';
const MAX_LIMIT=Bridge.MAX_LIMIT,MAX_OFFSET=100000,MAX_BODY=Bridge.MAX_RESPONSE;
// Pedido canônico, exatamente como a ponte reescreve (ordem e campos fixos).
const SHAPES=Object.freeze({
 listar:Object.freeze(['acao','brand','channel','offset','limit']),
 historico:Object.freeze(['acao','brand','draft_id']),
 submissao:Object.freeze(['acao','brand','submission_id'])
});
const REF=/^[A-Za-z0-9_-]{1,64}$/,KEY=/^Bearer ([a-f0-9]{64})$/;
const SQL=Object.freeze({
 setup:"SELECT pg_catalog.set_config('search_path','pg_catalog',true),pg_catalog.set_config('lock_timeout','500ms',true)",
 identity:"SELECT current_user AS role,pg_catalog.current_setting('transaction_read_only') AS read_only",
 listar:'SELECT crm_template_read.listar($1::text,$2::text,$3::integer,$4::integer) AS r',
 historico:'SELECT crm_template_read.historico($1::text,$2::text,$3::text) AS r',
 submissao:'SELECT crm_template_read.submissao($1::text,$2::text,$3::text) AS r',
 xid:'SELECT pg_catalog.txid_current_if_assigned() AS xid'
});
const ALLOWED=new Set([SQL.setup,SQL.listar,SQL.historico,SQL.submissao]);
// Erros do SQL → resposta HTTP. 401/403/404 são os únicos que a ponte trata sem ler corpo.
const SQL_ERRORS=Object.freeze({
 CRM_TEMPLATE_READ_UNAUTHORIZED:[401,'TEMPLATE_READ_UNAUTHORIZED'],
 CRM_TEMPLATE_READ_ACCESS_DENIED:[403,'TEMPLATE_READ_ACCESS_DENIED'],
 CRM_TEMPLATE_READ_NOT_FOUND:[404,'TEMPLATE_READ_NOT_FOUND'],
 CRM_TEMPLATE_READ_BRAND:[400,'TEMPLATE_READ_REQUEST'],
 CRM_TEMPLATE_READ_PAGE:[400,'TEMPLATE_READ_REQUEST'],
 CRM_TEMPLATE_READ_REQUEST:[400,'TEMPLATE_READ_REQUEST']
});
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});

// Recebe os pares da query na ordem em que chegaram. Recusa sem I/O tudo que
// não seja o pedido canônico: marca ausente/todas/olivas, canal ≠ email,
// paginação fora dos limites, chave extra, ordem diferente, histórico por key.
function request(pairs){
 if(!Array.isArray(pairs)||!pairs.every(p=>Array.isArray(p)&&p.length===2&&typeof p[0]==='string'&&typeof p[1]==='string'))throw fail('TEMPLATE_READ_REQUEST',400);
 const acao=pairs[0]?.[0]==='acao'?pairs[0][1]:null;
 if(!Object.hasOwn(SHAPES,acao))throw fail('TEMPLATE_READ_REQUEST',400);
 const keys=SHAPES[acao];if(pairs.length!==keys.length||pairs.some(([k],i)=>k!==keys[i]))throw fail('TEMPLATE_READ_REQUEST',400);
 const p=Object.fromEntries(pairs);
 if(!['fish','aristo'].includes(p.brand))throw fail('TEMPLATE_READ_REQUEST',400);
 if(acao==='listar'){
  if(p.channel!=='email'||!/^(0|[1-9][0-9]{0,5})$/.test(p.offset)||!/^[1-9][0-9]?$/.test(p.limit))throw fail('TEMPLATE_READ_REQUEST',400);
  const offset=Number(p.offset),limit=Number(p.limit);if(offset>MAX_OFFSET||limit>MAX_LIMIT)throw fail('TEMPLATE_READ_REQUEST',400);
  return Object.freeze({action:acao,brand:p.brand,offset,limit,query:new URLSearchParams(pairs)});
 }
 const field=acao==='historico'?'draft_id':'submission_id';if(!REF.test(p[field]))throw fail('TEMPLATE_READ_REQUEST',400);
 return Object.freeze({action:acao,brand:p.brand,ref:p[field],query:new URLSearchParams(pairs)});
}
// Credencial crm-panel-read: 64 hex, igual à ponte. Nada mais é aceito.
function bearer(value){const m=typeof value==='string'?KEY.exec(value):null;return m?m[1]:null;}

function createReadTransaction({pool,statementTimeoutMs=8000,role=ROLE}={}){
 if(typeof pool?.connect!=='function'||!Number.isInteger(statementTimeoutMs)||statementTimeoutMs<100||statementTimeoutMs>30000||role!==ROLE)throw fail('CRM_TEMPLATE_READ_TRANSACTION_CONFIG');
 let active=0;const waiters=new Set();
 async function transaction(work,{signal}={}){
  if(typeof work!=='function'||signal!==undefined&&!(signal instanceof AbortSignal))throw fail('CRM_TEMPLATE_READ_TRANSACTION_INPUT');
  if(signal?.aborted)throw fail('CRM_TEMPLATE_READ_ABORTED');
  active++;let client,destroy=false,begun=false;
  try{
   client=await pool.connect();
   await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');begun=true;
   await client.query(`SET LOCAL statement_timeout='${statementTimeoutMs}ms'`);
   const id=(await client.query(SQL.identity))?.rows;
   if(id?.length!==1||id[0].role!==role||id[0].read_only!=='on')throw fail('CRM_TEMPLATE_READ_ROLE');
   const tx=Object.freeze({query:async(text,values=[])=>{
    if(signal?.aborted)throw fail('CRM_TEMPLATE_READ_ABORTED');
    if(!ALLOWED.has(text)||!Array.isArray(values))throw fail('CRM_TEMPLATE_READ_STATEMENT_DENIED');
    const r=await client.query({text,values});if(signal?.aborted)throw fail('CRM_TEMPLATE_READ_ABORTED');return r;
   }});
   const result=await work(tx);
   // Leitura que não escreveu nem bloqueou linha não recebe xid.
   const xid=(await client.query(SQL.xid))?.rows;
   if(xid?.length!==1||xid[0].xid!==null)throw fail('CRM_TEMPLATE_READ_WRITE_DETECTED');
   await client.query('ROLLBACK');begun=false;return result;
  }catch(e){destroy=true;if(client&&begun){try{await client.query('ROLLBACK');}catch{}}throw e;}
  finally{if(client){try{client.release(destroy);}catch{}}active--;if(active===0){for(const r of waiters)r();waiters.clear();}}
 }
 transaction.active=()=>active;
 transaction.drain=()=>active===0?Promise.resolve():new Promise(r=>waiters.add(r));
 return Object.freeze(transaction);
}

// O corpo que sai é exatamente o que a ponte aceitaria: mesma função de forma,
// sem eco da credencial (texto bruto, chaves e strings, caixa ignorada) e
// dentro do teto de bytes da ponte.
function checkBody(req,body,key){
 const text=JSON.stringify(body);
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BODY||text.toLowerCase().includes(key))throw fail('TEMPLATE_READ_RESPONSE_DENIED');
 try{Bridge.responseShape({action:req.action,brand:req.brand,query:req.query},JSON.parse(text));}catch{throw fail('TEMPLATE_READ_RESPONSE_DENIED');}
 return text;
}

function createTemplateReadStore({transaction,timeoutMs=9000}={}){
 if(typeof transaction!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw fail('CRM_TEMPLATE_READ_ADAPTER');
 async function handle({authorization,pairs}={},{signal:external}={}){
  let req;try{req=request(pairs);}catch(e){return {status:400,body:{error:'TEMPLATE_READ_REQUEST'}};}
  const key=bearer(authorization);if(!key)return {status:401,body:{error:'TEMPLATE_READ_UNAUTHORIZED'}};
  const controller=new AbortController();let timer,onAbort;
  const run=()=>transaction(async tx=>{
   await tx.query(SQL.setup);
   const args=req.action==='listar'?[key,req.brand,req.offset,req.limit]:[key,req.brand,req.ref];
   const rows=(await tx.query(SQL[req.action],args))?.rows;
   if(!Array.isArray(rows)||rows.length!==1)throw fail('TEMPLATE_READ_UNAVAILABLE');
   const text=checkBody(req,rows[0].r,key);
   if(controller.signal.aborted)throw fail('TEMPLATE_READ_UNAVAILABLE');
   return {status:200,text};
  },{signal:controller.signal});
  if(external?.aborted)return {status:503,body:{error:'TEMPLATE_READ_UNAVAILABLE'}};
  const aborted=new Promise((_,reject)=>{onAbort=()=>{controller.abort();reject(fail('TEMPLATE_READ_UNAVAILABLE'));};external?.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([run(),aborted,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('TEMPLATE_READ_UNAVAILABLE'));},timeoutMs);})]);}
  catch(e){
   const code=Object.keys(SQL_ERRORS).find(c=>typeof e?.message==='string'&&e.message.includes(c));
   if(code){const [status,error]=SQL_ERRORS[code];return {status,body:{error}};}
   if(e?.code==='TEMPLATE_READ_RESPONSE_DENIED')return {status:502,body:{error:'TEMPLATE_READ_RESPONSE_DENIED'}};
   return {status:503,body:{error:'TEMPLATE_READ_UNAVAILABLE'}};
  }finally{clearTimeout(timer);external?.removeEventListener('abort',onAbort);controller.abort();}
 }
 return Object.freeze({handle});
}
module.exports={ROLE,CONTRACT,SQL,SHAPES,MAX_LIMIT,MAX_OFFSET,request,bearer,checkBody,createReadTransaction,createTemplateReadStore};
