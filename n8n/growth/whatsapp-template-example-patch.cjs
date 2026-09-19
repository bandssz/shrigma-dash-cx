'use strict';
const MARKER='WA_SYNTHETIC_ORDER_URL_EXAMPLE_V1';
const ANCHOR=' warnings(r){';
const HELPERS=` // ${MARKER}: opt-in sample, never a customer's authenticated order URL.
 urlExampleError(button){
  if(button?.exemplo_url === undefined)return null;
  const base=String(button.valor||'');
  if(WAT.urlError(base)||!/^https:\\/\\/(?:fishermans\\.com\\.br|oaristocrata\\.com)\\/\\{\\{1\\}\\}$/.test(base))return 'Exemplo de pedido exige domínio próprio aprovado e um único {{1}} no final.';
  const expected=base.replace('{{1}}','0/orders/EXEMPLOPEDIDO/authenticate?key=EXEMPLOCHAVE');
  if(typeof button.exemplo_url!=='string'||button.exemplo_url!==expected)return 'Use somente o exemplo sintético reservado; não informe URL ou chave de pedido real.';
  return null;
 },
 urlExample(button){
  if(WAT.urlExampleError(button))return String(button.valor||'').replace('{{1}}','exemplo');
  return button.exemplo_url===undefined?button.valor.replace('{{1}}','exemplo'):button.exemplo_url;
 },
`;
const OLD_VALIDATE="for(const b of buttons)if(b.tipo==='url'){const error=WAT.urlError(b.valor);if(error)add('botoes',error);}";
const NEW_VALIDATE="for(const b of buttons)if(b.tipo==='url'){const error=WAT.urlError(b.valor)||WAT.urlExampleError(b);if(error)add('botoes',error);}";
const OLD_EXAMPLE="example:[x.valor.replace('{{1}}','exemplo')]";
const NEW_EXAMPLE='example:[WAT.urlExample(x)]';
const count=(s,x)=>s.split(x).length-1;
function patchCode(code){
 if(typeof code!=='string')throw Error('Expected WAT source');
 if(code.includes(MARKER)){
  if(count(code,MARKER)!==1||!code.includes(HELPERS)||!code.includes(NEW_VALIDATE)||!code.includes(NEW_EXAMPLE))throw Error('Unrecognized synthetic example patch');
  return code;
 }
 if(count(code,ANCHOR)!==1||count(code,OLD_VALIDATE)!==1||count(code,OLD_EXAMPLE)!==1)throw Error('WAT contract changed; inspect the fresh code');
 return code.replace(ANCHOR,HELPERS+ANCHOR).replace(OLD_VALIDATE,NEW_VALIDATE).replace(OLD_EXAMPLE,NEW_EXAMPLE);
}
function patchWorkflow(fresh,{expectedVersionId}={}){
 if(!fresh||!Array.isArray(fresh.nodes)||!expectedVersionId||fresh.versionId!==expectedVersionId)throw Error('Fresh workflow and matching expectedVersionId are required');
 const workflow=JSON.parse(JSON.stringify(fresh)),changes=[];
 for(const name of ['Prepara','Decide escrita']){
  const found=workflow.nodes.filter(n=>n.name===name);
  if(found.length!==1||found[0].type!=='n8n-nodes-base.code')throw Error('Expected one code node: '+name);
  const before=found[0].parameters?.jsCode,after=patchCode(before);found[0].parameters.jsCode=after;
  if(before!==after)changes.push({node:name,field:'jsCode'});
 }
 return {workflow,changes};
}
module.exports={MARKER,HELPERS,ANCHOR,OLD_VALIDATE,OLD_EXAMPLE,patchCode,patchWorkflow};
