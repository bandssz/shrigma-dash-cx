'use strict';

const BRAND_HOSTS=Object.freeze({fish:'fishermans.com.br',aristo:'oaristocrata.com'});

function fail(reason){return {ok:false,reason,event:null};}
function text(value,max){
 const result=String(value??'').replace(/[\r\n\t\u200b\u2060]/g,' ').replace(/\s{2,}/g,' ').trim();
 return result&&Array.from(result).length<=max?result:null;
}
function cents(value){
 if((typeof value!=='string'&&typeof value!=='number')||String(value).trim()===''||!/^\d+(?:\.\d{1,2})?$/.test(String(value)))return null;
 const result=Math.round(Number(value)*100);
 return Number.isSafeInteger(result)&&result>=0?result:null;
}
function instant(value){
 if(typeof value!=='string'||!/^(?:19|20)\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value))return null;
 const result=Date.parse(value);return Number.isFinite(result)?result:null;
}
function httpsUrl(value,expectedHost){
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hostname.toLowerCase()!==expectedHost)return null;
  return url.toString();
 }catch{return null;}
}
function publicImageUrl(value){
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!url.hostname||url.searchParams.has('token'))return null;
  return url.toString();
 }catch{return null;}
}
function paid(order,reference,nowMs){
 if(!order||order.id!=='gid://shopify/Order/'+reference)return 'pedido_divergente';
 if(order.test!==false)return order.test===true?'pedido_de_teste':'pedido_test_desconhecido';
 if(order.cancelledAt!==null)return order.cancelledAt?'pedido_cancelado':'cancelamento_desconhecido';
 if(order.displayFinancialStatus!=='PAID')return 'pedido_nao_pago';
 if(!Array.isArray(order.transactions))return 'transacoes_pagamento_indisponiveis';
 let proved=false;
 for(const tx of order.transactions){
  if(!tx||typeof tx.kind!=='string'||typeof tx.status!=='string')return 'transacao_pagamento_malformada';
  if(!['SALE','CAPTURE'].includes(tx.kind)||tx.status!=='SUCCESS')continue;
  if(tx.test!==false)return tx.test===true?'transacao_de_teste':'transacao_test_desconhecido';
  const at=instant(tx.processedAt);if(at===null)return 'instante_pagamento_indisponivel';
  if(at>nowMs)return 'instante_pagamento_futuro';proved=true;
 }
 return proved?null:'sem_sale_ou_capture_success';
}

// Builds Meta's customer_events contract for the native Rich Order Status UI.
// Transport is deliberately separate because it requires a Meta message-integration
// installation id and its BISU credential, not the regular Cloud API token.
function richOrderEvent(input,nowMs=Date.now()){
 if(!Number.isFinite(nowMs))return fail('relogio_validacao_invalido');
 const brand=String(input?.brand||''),host=BRAND_HOSTS[brand],reference=String(input?.reference||'');
 if(!host||!/^\d+$/.test(reference))return fail('pedido_referencia_invalida');
 const order=input.order,financial=paid(order,reference,nowMs);if(financial)return fail(financial);
 const orderNumber=text(order.name,40),createdAt=instant(order.createdAt),orderUrl=httpsUrl(order.statusPageUrl,host);
 const shipping=text(order.shippingLine?.title,120),firstName=text(input.first_name,80);
 let phone=String(input.phone||'').replace(/\D/g,'');if(phone.length===10||phone.length===11)phone='55'+phone;
 if(!orderNumber||createdAt===null||!orderUrl||order.currencyCode!=='BRL'||!shipping||!firstName||!/^55\d{10,11}$/.test(phone))return fail('pedido_metadados_incompletos');
 if(order.lineItems?.pageInfo?.hasNextPage!==false)return fail('pedido_itens_incompletos');
 const lines=order.lineItems?.nodes;if(!Array.isArray(lines)||!lines.length||lines.length>30)return fail('pedido_itens_invalidos');
 const items=[];
 for(const line of lines){
  const name=text(line?.name,120),variant=text(line?.variantTitle,80),quantity=line?.quantity;
  const amount=cents(line?.discountedTotalSet?.shopMoney?.amount),currency=line?.discountedTotalSet?.shopMoney?.currencyCode;
  const image=publicImageUrl(line?.image?.url||line?.variant?.image?.url);
  if(!name||!Number.isSafeInteger(quantity)||quantity<1||amount===null||currency!=='BRL'||!image)return fail('pedido_item_incompleto');
  items.push({name:variant&&!/^default title$/i.test(variant)?name+' — '+variant:name,quantity,amount_1000:amount,image_url:image});
 }
 const event={
  customer:{id:phone,type:'GUEST',first_name:firstName,country_code:'BR',language:'pt_BR'},
  event:{
   id:orderNumber.startsWith('#')?orderNumber:'#'+orderNumber,
   type:'ORDER_PLACED',
   order_placed:{order_details_url:orderUrl},
   rich_order_status:{order_url:orderUrl,order_date:new Date(createdAt).toISOString(),currency:'BRL',shipping_method:shipping,items},
  },
 };
 return {ok:true,reason:null,event};
}

module.exports={BRAND_HOSTS,richOrderEvent};
