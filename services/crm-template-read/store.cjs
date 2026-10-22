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
 xid:'SELECT pg_catalog.txid_current_if_assigned() AS xid',
 // Admissão do catálogo a cada pedido: as três leituras, o principal e a autenticação
 // de que ele depende precisam ser exatamente as revisadas (corpo, dono, SECURITY
 // DEFINER, volatilidade, search_path e quem executa). Só lê pg_catalog.
 attest:"SELECT n.nspname AS schema,p.proname AS name,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,p.prosecdef AS definer,p.provolatile AS volatility,pg_catalog.array_to_string(p.proconfig,',') AS config,r.rolname AS owner,pg_catalog.md5(p.prosrc) AS src,pg_catalog.has_function_privilege(p.oid,'EXECUTE') AS executable FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles r ON r.oid=p.proowner WHERE n.nspname='crm_template_read' OR (n.nspname='public' AND p.proname='shrigma_panel_operator_v1') ORDER BY 1,2,3"
});
const ALLOWED=new Set([SQL.setup,SQL.attest,SQL.listar,SQL.historico,SQL.submissao]);
// Esperado em n8n/growth/crm-template-read-access.sql e n8n/access/panel-operator.sql
// (md5 do corpo conferido em teste contra os próprios arquivos). Qualquer
// diferença: 503 TEMPLATE_READ_NOT_READY, sem chamar a leitura.
const pin=(schema,name,args,definer,config,src,executable)=>Object.freeze({schema,name,args,definer,volatility:'s',config,owner:'postgres',src,executable});
const ATTEST_ROWS=Object.freeze([
 pin('crm_template_read','historico','k text, b text, did text',true,'search_path=pg_catalog','72ea87cf3bc28af17321f0a1d88a7479',true),
 pin('crm_template_read','listar','k text, b text, p_offset integer, p_limit integer',true,'search_path=pg_catalog','76d5dadb47cac7cff09de2f839a02090',true),
 pin('crm_template_read','principal','k text, cap text',true,'search_path=pg_catalog','42f144bdf5cfbdb0aea3ea94f958b7cb',false),
 pin('crm_template_read','submissao','k text, b text, sid text',true,'search_path=pg_catalog','abf7f77765b6851a41ecca014c1ce488',true),
 pin('public','shrigma_panel_operator_v1','k text, a text',false,'search_path=pg_catalog, public','2092629644f901de260051084d2fb2c2',false)
]);
function attested(rows){
 if(!Array.isArray(rows)||rows.length!==ATTEST_ROWS.length)return false;
 return rows.every((row,i)=>{const e=ATTEST_ROWS[i];return row&&Object.keys(e).every(k=>row[k]===e[k]);});
}
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

// Cada operação ocupa uma vaga do pedido até a conexão ser devolvida ou
// descartada — inclusive depois de o pedido ter recebido 503 por prazo. A
// admissão é conferida antes de pool.connect; sem fila.
function createReadTransaction({pool,statementTimeoutMs=8000,role=ROLE,maxActive=4}={}){
 if(typeof pool?.connect!=='function'||!Number.isInteger(statementTimeoutMs)||statementTimeoutMs<100||statementTimeoutMs>30000||role!==ROLE||!Number.isInteger(maxActive)||maxActive<1||maxActive>4)throw fail('CRM_TEMPLATE_READ_TRANSACTION_CONFIG');
 let active=0;const waiters=new Set();
 async function transaction(work,{signal}={}){
  if(typeof work!=='function'||signal!==undefined&&!(signal instanceof AbortSignal))throw fail('CRM_TEMPLATE_READ_TRANSACTION_INPUT');
  if(signal?.aborted)throw fail('CRM_TEMPLATE_READ_ABORTED');
  if(active>=maxActive)throw fail('TEMPLATE_READ_BUSY');
  active++;let client,destroy=false,begun=false;
  const live=()=>{if(signal?.aborted)throw fail('CRM_TEMPLATE_READ_ABORTED');};
  try{
   client=await pool.connect();
   // Operação já abandonada enquanto esperava a conexão: nenhuma instrução, conexão descartada.
   live();
   await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');begun=true;live();
   await client.query(`SET LOCAL statement_timeout='${statementTimeoutMs}ms'`);live();
   const id=(await client.query(SQL.identity))?.rows;live();
   if(id?.length!==1||id[0].role!==role||id[0].read_only!=='on')throw fail('CRM_TEMPLATE_READ_ROLE');
   const tx=Object.freeze({query:async(text,values=[])=>{
    if(signal?.aborted)throw fail('CRM_TEMPLATE_READ_ABORTED');
    if(!ALLOWED.has(text)||!Array.isArray(values))throw fail('CRM_TEMPLATE_READ_STATEMENT_DENIED');
    const r=await client.query({text,values});if(signal?.aborted)throw fail('CRM_TEMPLATE_READ_ABORTED');return r;
   }});
   const result=await work(tx);live();
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
// Eco da credencial, também codificado: cada string e cada chave do corpo
// (depois do parse) é conferida em texto (sem caixa), após decodificar percent
// (%XX, inclusive duplo) e entidades HTML (&#..;), e em todo trecho base64 ou
// base64url com 16+ caracteres, nos quatro alinhamentos, contra o texto da
// chave e contra os seus 32 bytes. Decodificações encadeadas até 3 níveis.
const B64RUN=/[A-Za-z0-9+/_-]{16,}={0,2}/g;
const pctDecode=t=>t.replace(/%([0-9a-fA-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
const entityDecode=t=>t.replace(/&#([xX][0-9a-fA-F]{1,6}|[0-9]{1,7});?/g,(m,v)=>{const n=v[0]==='x'||v[0]==='X'?parseInt(v.slice(1),16):parseInt(v,10);return n<=0x10ffff?String.fromCodePoint(n):m;});
function stringEchoes(s,key,keyBytes){
 const keyBinary=keyBytes.toString('latin1');
 let level=[s];const seen=new Set();
 for(let depth=0;depth<4&&level.length;depth++){
  const next=[];
  for(const t of level){
   if(seen.has(t))continue;seen.add(t);
   if(t.toLowerCase().includes(key)||t.includes(keyBinary))return true;
   if(depth===3)continue;
   for(const d of [pctDecode(t),entityDecode(t)])if(d!==t)next.push(d);
   for(const m of t.matchAll(B64RUN)){
    const run=m[0].replace(/-/g,'+').replace(/_/g,'/').replace(/=+$/,'');
    for(let off=0;off<4;off++){
     const buf=Buffer.from(run.slice(off),'base64');if(buf.length<32)continue;
     if(buf.includes(keyBytes))return true;
     const txt=buf.toString('latin1');if(txt.toLowerCase().includes(key))return true;
     next.push(txt);
    }
   }
  }
  level=next;
 }
 return false;
}
function echoes(value,key){
 const keyBytes=Buffer.from(key,'hex'),stack=[value];
 while(stack.length){
  const v=stack.pop();
  if(typeof v==='string'){if(stringEchoes(v,key,keyBytes))return true;continue;}
  if(v&&typeof v==='object')for(const k of Object.keys(v)){if(stringEchoes(k,key,keyBytes))return true;stack.push(v[k]);}
 }
 return false;
}
function checkBody(req,body,key){
 const text=JSON.stringify(body);
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BODY||text.toLowerCase().includes(key))throw fail('TEMPLATE_READ_RESPONSE_DENIED');
 let parsed;try{parsed=JSON.parse(text);}catch{throw fail('TEMPLATE_READ_RESPONSE_DENIED');}
 if(echoes(parsed,key))throw fail('TEMPLATE_READ_RESPONSE_DENIED');
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
   if(!attested((await tx.query(SQL.attest))?.rows))throw fail('TEMPLATE_READ_NOT_READY');
   const args=req.action==='listar'?[key,req.brand,req.offset,req.limit]:[key,req.brand,req.ref];
   const rows=(await tx.query(SQL[req.action],args))?.rows;
   if(!Array.isArray(rows)||rows.length!==1)throw fail('TEMPLATE_READ_UNAVAILABLE');
   const text=checkBody(req,rows[0].r,key);
   if(controller.signal.aborted)throw fail('TEMPLATE_READ_UNAVAILABLE');
   return {status:200,text};
  },{signal:controller.signal});
  if(external?.aborted)return {status:503,body:{error:'TEMPLATE_READ_UNAVAILABLE'}};
  const aborted=new Promise((_,reject)=>{onAbort=()=>{controller.abort();reject(fail('TEMPLATE_READ_UNAVAILABLE'));};external?.addEventListener('abort',onAbort,{once:true});});
  // `settled` só resolve quando a transação terminou de fato (conexão devolvida
  // ou descartada); o servidor segura a vaga HTTP até lá, mesmo após responder 503.
  const work=run(),settled=work.then(()=>undefined,()=>undefined);
  const respond=r=>Object.assign(r,{settled});
  try{return respond(await Promise.race([work,aborted,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('TEMPLATE_READ_UNAVAILABLE'));},timeoutMs);})]));}
  catch(e){
   const code=Object.keys(SQL_ERRORS).find(c=>typeof e?.message==='string'&&e.message.includes(c));
   if(code){const [status,error]=SQL_ERRORS[code];return respond({status,body:{error}});}
   if(e?.code==='TEMPLATE_READ_RESPONSE_DENIED')return respond({status:502,body:{error:'TEMPLATE_READ_RESPONSE_DENIED'}});
   if(['TEMPLATE_READ_BUSY','TEMPLATE_READ_NOT_READY'].includes(e?.code))return respond({status:503,body:{error:e.code}});
   return respond({status:503,body:{error:'TEMPLATE_READ_UNAVAILABLE'}});
  }finally{clearTimeout(timer);external?.removeEventListener('abort',onAbort);controller.abort();}
 }
 return Object.freeze({handle});
}
module.exports={ROLE,CONTRACT,SQL,SHAPES,MAX_LIMIT,MAX_OFFSET,ATTEST_ROWS,attested,echoes,request,bearer,checkBody,createReadTransaction,createTemplateReadStore};
