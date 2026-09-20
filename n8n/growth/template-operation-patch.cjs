'use strict';
const R=require('./template-operation-receipt.cjs');
const MARKER='TEMPLATE_OPERATION_RECEIPT_V1';
const AUTH_ANCHOR="const req=$json,k=String(req.body?.k||req.query?.k||'');";
const AUTH_PATCH=`// ${MARKER}: operation lookups authenticate through a header, never a URL key.
const req=$json;
const receiptRequest=String(req.body?.acao||req.query?.acao||'').toLowerCase()==='operacao';
const k=String(receiptRequest?(req.headers?.['x-template-key']||req.headers?.['X-Template-Key']||''):(req.body?.k||req.query?.k||''));`;
const PREP_ANCHOR="if(!auth) return [out(401,{erro:'invalid_key'})];";
const PREP_PATCH=`
// ${MARKER}: a SELECT-only path, before every mutation route.
if(acao==='operacao'){
 if(method!=='GET')return [out(405,{erro:'metodo_invalido'})];
 const operation_action=String(q.operacao||'');
 const capability={rascunho:'draft',validar:'validate',submeter:'submit'}[operation_action];
 if(!capability)return [out(400,{erro:'operacao_invalida'})];
 if(!Array.isArray(auth.caps)||!auth.caps.includes(capability))return [out(403,{erro:'capability_missing',capability})];
 if(typeof auth.who!=='string'||!auth.who)return [out(403,{erro:'actor_unavailable'})];
 const operation_key=String(q.idempotency_key||'');
 if(!/^[\\w.:-]{8,128}$/.test(operation_key))return [out(400,{erro:'idempotency_key_obrigatoria'})];
 return [{json:{acao,who:auth.who,operation_key,operation_action,_step:'pg_leitura',sql:${JSON.stringify(R.SQL)},sqlParameters:[operation_key,auth.who]}}];
}
`;
const FORMAT_ANCHOR="const c=$('Prepara').first().json; const rows=$input.all().map(i=>i.json);";
const FORMAT_PATCH=`
// ${MARKER}: never falls into provider polling or status consolidation.
if(c.acao==='operacao'){
 ${[R.sha256Bytes,R.stable,R.canonical,R.digest,R.safePayload,R.cleanResponse,R.operationReceipt].map(f=>f.toString()).join('\n')}
 return [{json:{_step:'resposta',_http:200,_body:operationReceipt(c,rows.length===1?rows[0]:null)}}];
}
`;
const COUNT=(s,t)=>s.split(t).length-1;
function insert(code,anchor,patch,replace=false){
 if(typeof code!=='string')throw Error('Expected Code source');
 if(code.includes(MARKER)){
  if(COUNT(code,MARKER)!==1||!code.includes(patch))throw Error('Unrecognized receipt patch');
  return code;
 }
 if(COUNT(code,anchor)!==1)throw Error('Receipt anchor changed; inspect the fresh workflow');
 return code.replace(anchor,replace?patch:anchor+patch);
}
function patchWorkflow(fresh,{expectedVersionId}={}){
 if(!fresh||!expectedVersionId||fresh.versionId!==expectedVersionId||!Array.isArray(fresh.nodes))throw Error('Fresh workflow with matching expectedVersionId required');
 const workflow=JSON.parse(JSON.stringify(fresh)),changes=[];
 const node=(name,type)=>{const a=workflow.nodes.filter(n=>n.name===name);if(a.length!==1||a[0].type!==type)throw Error('Expected one '+name+' node');return a[0];};
 for(const [name,anchor,patch,replace] of [['Autenticação entrada',AUTH_ANCHOR,AUTH_PATCH,true],['Prepara',PREP_ANCHOR,PREP_PATCH,false],['Formata leitura',FORMAT_ANCHOR,FORMAT_PATCH,false]]){
  const n=node(name,'n8n-nodes-base.code'),before=n.parameters.jsCode;n.parameters.jsCode=insert(before,anchor,patch,replace);if(before!==n.parameters.jsCode)changes.push({node:name,field:'jsCode'});
 }
 const pg=node('PG leitura','n8n-nodes-base.postgres');
 if(pg.typeVersion!==2.5||pg.parameters.operation!=='executeQuery'||pg.parameters.query!=='={{ $json.sql }}')throw Error('PG read contract changed');
 const expression='={{ $json.sqlParameters || [] }}',previous=pg.parameters.options?.queryReplacement;
 if(previous!==undefined&&previous!==expression)throw Error('PG read parameters changed');
 pg.parameters.options={...(pg.parameters.options||{}),queryReplacement:expression};if(previous!==expression)changes.push({node:'PG leitura',field:'options.queryReplacement'});
 const response=node('Responde','n8n-nodes-base.respondToWebhook');
 const entries=response.parameters.options?.responseHeaders?.entries;
 if(!Array.isArray(entries))throw Error('Response headers contract changed');
 for(const [name,value] of [['Cache-Control','private, no-store'],['Vary','Origin, X-Template-Key'],['Access-Control-Allow-Headers','Content-Type, Idempotency-Key, X-Template-Key'],['Access-Control-Allow-Methods','GET, POST, OPTIONS']]){
  const existing=entries.filter(h=>h.name.toLowerCase()===name.toLowerCase());
  if(existing.length>1||existing.length===1&&existing[0].value!==value)throw Error('Response header changed: '+name);
  if(!existing.length){entries.push({name,value});changes.push({node:'Responde',field:'header.'+name});}
 }
 return {workflow,changes};
}
module.exports={MARKER,AUTH_ANCHOR,AUTH_PATCH,PREP_ANCHOR,PREP_PATCH,FORMAT_ANCHOR,FORMAT_PATCH,patchWorkflow};
