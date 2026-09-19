'use strict';
// Approved button bases are a contract, not URLs inferred from a carrier name.
const TRACKING_BUTTONS=Object.freeze({
 'Loggi':Object.freeze({base:'https://app.loggi.com/rastreador/{{1}}',scope:'audit_only'}),
 'Total Express':Object.freeze({base:'https://totalconecta.totalexpress.com.br/rastreamento/{{1}}',scope:'audit_only'}),
 'Melhor Envio':Object.freeze({base:'https://melhorrastreio.com.br/{{1}}',scope:'source_path'})
});
function resolveMelhorTracking(response,request){
 const fail=reason=>({ok:false,reason});
 if(!request||request.carrier!=='Melhor Envio'||!/^\d+$/.test(String(request.order_id)))return fail('rastreio_referencia_invalida');
 if(!response||response.error||(Array.isArray(response.errors)&&response.errors.length))return fail('rastreio_consulta_indisponivel');
 const order=response.data?.order;
 if(!order||order.id!=='gid://shopify/Order/'+request.order_id)return fail('rastreio_pedido_divergente');
 if(order.test!==false||order.cancelledAt!==null)return fail('rastreio_pedido_teste_cancelado_ou_desconhecido');
 if(!['PENDING','AUTHORIZED','PARTIALLY_PAID','PAID','PARTIALLY_REFUNDED'].includes(order.displayFinancialStatus))return fail('rastreio_estado_financeiro_invalido');
 if(!Array.isArray(order.fulfillments))return fail('rastreio_fulfillment_indisponivel');
 if(order.fulfillments.length>=20)return fail('rastreio_fulfillment_parcial');
 const normalize=v=>typeof v==='string'?v.trim().replace(/\s+/g,'').toUpperCase():'';
 const incoming=normalize(request.tracking_number);
 if(!/^[A-Z0-9-]{1,120}$/.test(incoming))return fail('rastreio_codigo_invalido');
 const same=(a,b)=>a===b||a.replace(/^LGI-/,'')===b.replace(/^LGI-/,'');
 const candidates=[];
 for(const f of order.fulfillments){
  if(f?.status!=='SUCCESS'||!Array.isArray(f.trackingInfo))continue;
  for(const info of f.trackingInfo){
   const number=normalize(info?.number);
   if(!number||!same(number,incoming))continue;
   // Only the observed provider path is allowed; query, fragment, credentials,
   // encoded slash, alternate domains and generic/account destinations fail.
   const match=typeof info.url==='string'&&info.url.match(/^https:\/\/(?:www\.)?melhorrastreio\.com\.br\/(rastreio\/([A-Za-z0-9-]{1,120}))$/);
   if(!match||!same(normalize(match[2]),number))return fail('rastreio_url_incompativel');
   candidates.push(match[1]);
  }
 }
 const unique=[...new Set(candidates)];
 if(unique.length!==1)return fail(unique.length?'rastreio_url_ambigua':'rastreio_sem_fulfillment_correspondente');
 return {ok:true,parameter:unique[0],url:'https://melhorrastreio.com.br/'+unique[0]};
}
const MARKER='WA_TRACKING_SOURCE_PATH_V1';
const EXTRA='fulfillments(first: 20) { id status trackingInfo { company number url } }';
const DEFINITIONS='// '+MARKER+'\n'+resolveMelhorTracking.toString()+'\n';
const FISH_QUERY="const GQL = 'query($id: ID!) { order(id: $id) { id name displayFinancialStatus test cancelledAt transactions { kind status test processedAt } phone customer { phone } shippingAddress { phone } } }';";
const ARISTO_QUERY="const GQL = 'query($id: ID!) { order(id: $id) { name displayFinancialStatus phone customer { phone } shippingAddress { phone } } }';";
const FISH_BUTTON="      const btn = r.carrier === 'Melhor Envio' ? code.replace(/^LGI-/, '') : code;";
const ARISTO_BUTTON="parameters:txt([r.carrier === 'Melhor Envio' ? code.replace(/^LGI-/,'') : code])";
const FISH_REPLACEMENT=`      let btn = code;
      if(r.carrier === 'Melhor Envio'){
        const destination = resolveMelhorTracking(item.json,r);
        if(!destination.ok){saida.push({json:{_skip:destination.reason,brand:'fish',piece:r.piece,ref:r.order_id}});return;}
        btn = destination.parameter;
      }`;
const ARISTO_ANCHOR='      tpl = direto;';
const ARISTO_REPLACEMENT=`      tpl = direto;
      let trackingButton = code;
      if(r.carrier === 'Melhor Envio'){
        const destination = resolveMelhorTracking(item.json,r);
        if(!destination.ok)bloqueio = destination.reason;
        else trackingButton = destination.parameter;
      }`;
function verifyApprovedCatalog(catalog,brand){
 const prefix=brand==='fish'?'fishermans':'aristocrata';
 const names=[prefix+'_rastreio_melhor_envio_claro_v1',prefix+'_rastreio_melhor_envio_'+(brand==='fish'?'v1':'v2')];
 if(!Array.isArray(catalog))throw Error('Current approved catalog is required');
 for(const name of names){
  const rows=catalog.filter(t=>t.name===name&&t.brand===brand);
  const buttons=rows[0]?.components?.find(c=>c.type==='BUTTONS')?.buttons;
  if(rows.length!==1||rows[0].status!=='APPROVED'||buttons?.[0]?.type!=='URL'||buttons[0].url!==TRACKING_BUTTONS['Melhor Envio'].base)throw Error('Approved tracking button contract changed: '+name);
 }
}
function patchWorkflow(fresh,{expectedVersionId,brand,approvedCatalog}={}){
 if(!fresh||!Array.isArray(fresh.nodes)||!expectedVersionId||fresh.versionId!==expectedVersionId||!['fish','aristo'].includes(brand))throw Error('Fresh workflow, matching version and explicit brand are required');
 verifyApprovedCatalog(approvedCatalog,brand);
 const workflow=JSON.parse(JSON.stringify(fresh)),changes=[];
 const find=name=>{const found=workflow.nodes.filter(n=>n.name===name);if(found.length!==1||found[0].type!=='n8n-nodes-base.code')throw Error('Expected one code node: '+name);return found[0];};
 const route=find('Roteia evento → peça'),mount=find('Monta componentes');
 const r=route.parameters?.jsCode,m=mount.parameters?.jsCode;
 const query=brand==='fish'?FISH_QUERY:ARISTO_QUERY;
 const nextQuery=brand==='fish'?query.replace('id name','id name '+EXTRA):query.replace('{ name','{ id test cancelledAt '+EXTRA+' name');
 if(typeof r!=='string'||typeof m!=='string')throw Error('Missing workflow code');
 if(m.includes(MARKER)){
  if(!m.startsWith(DEFINITIONS)||!r.includes(nextQuery)||(brand==='fish'?!m.includes(FISH_REPLACEMENT):!m.includes(ARISTO_REPLACEMENT)||!m.includes('parameters:txt([trackingButton])')))throw Error('Unrecognized tracking patch');
  return {workflow,changes};
 }
 const button=brand==='fish'?FISH_BUTTON:ARISTO_BUTTON;
 if(r.split(query).length!==2||m.split(button).length!==2||(brand==='aristo'&&m.split(ARISTO_ANCHOR).length!==2))throw Error('Tracking workflow changed; review fresh export');
 route.parameters.jsCode=r.replace(query,nextQuery);
 mount.parameters.jsCode=DEFINITIONS+(brand==='fish'?m.replace(FISH_BUTTON,FISH_REPLACEMENT):m.replace(ARISTO_ANCHOR,ARISTO_REPLACEMENT).replace(ARISTO_BUTTON,'parameters:txt([trackingButton])'));
 changes.push({node:route.name,field:'jsCode'},{node:mount.name,field:'jsCode'});
 return {workflow,changes};
}
module.exports={TRACKING_BUTTONS,resolveMelhorTracking,verifyApprovedCatalog,patchWorkflow,MARKER,FISH_QUERY,ARISTO_QUERY,FISH_BUTTON,ARISTO_BUTTON,ARISTO_ANCHOR};
