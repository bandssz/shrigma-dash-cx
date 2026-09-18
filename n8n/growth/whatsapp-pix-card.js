'use strict';
// Optional presentation enrichment. The verified Appmax charge remains authoritative.
function pixOrderCents(v) {
 if ((typeof v!=='number'&&typeof v!=='string')||String(v).trim()==='') throw Error('pix_order_money_invalid');
 if(typeof v==='string'&&!/^\d+(?:\.\d+)?$/.test(v))throw Error('pix_order_money_invalid');
 const n=Number(v),c=Math.round(n*100);
 if(!Number.isFinite(n)||n<0||!Number.isSafeInteger(c)||Math.abs(n*100-c)>0.00001)throw Error('pix_order_money_invalid');
 return c;
}
function pixOrderMoney(bag) {
 const m=bag?.shopMoney;if(m?.currencyCode!=='BRL')throw Error('pix_order_currency_invalid');
 return pixOrderCents(m.amount);
}
function pixShopifyOrder(order,reference,total) {
 try {
  if(order?.id!=='gid://shopify/Order/'+reference||order.currencyCode!=='BRL'||order.cancelledAt||order.displayFinancialStatus!=='PENDING')throw Error('pix_order_identity_invalid');
  if(order.lineItems?.pageInfo?.hasNextPage!==false)throw Error('pix_order_items_incomplete');
  const lines=order.lineItems.nodes;
  if(!Array.isArray(lines)||!lines.length||lines.length>30)throw Error('pix_order_items_invalid');
  const totalCents=pixOrderCents(total),shipping=pixOrderMoney(order.currentShippingPriceSet),tax=pixOrderMoney(order.currentTotalTaxSet);
  if(pixOrderMoney(order.currentTotalPriceSet)!==totalCents)throw Error('pix_order_total_mismatch');
  // Tax-inclusive prices need a separate allocation contract; don't double-count tax.
  if(typeof order.taxesIncluded!=='boolean'||(order.taxesIncluded&&tax>0))throw Error('pix_order_tax_inclusive');
  let subtotal=0,discount=0;const ids=new Set(),m=value=>({value,offset:100});
  const items=lines.map(line=>{
   const id=String(line.id||''),name=String(line.name||'').replace(/[\r\n\t]/g,' ').trim(),q=line.quantity;
   if(!/^gid:\/\/shopify\/LineItem\/\d+$/.test(id)||ids.has(id)||!name||Array.from(name).length>60||!Number.isSafeInteger(q)||q<1||q!==line.currentQuantity)throw Error('pix_order_item_invalid');
   ids.add(id);const unit=pixOrderMoney(line.originalUnitPriceSet),lineTotal=unit*q;
   if(!Number.isSafeInteger(lineTotal)||!Array.isArray(line.discountAllocations))throw Error('pix_order_item_invalid');
   const lineDiscount=line.discountAllocations.reduce((n,a)=>n+pixOrderMoney(a.allocatedAmountSet),0);
   if(!Number.isSafeInteger(lineDiscount)||lineDiscount>lineTotal)throw Error('pix_order_discount_invalid');
   subtotal+=lineTotal;discount+=lineDiscount;
   return {retailer_id:id.split('/').pop(),name,amount:m(unit),quantity:q};
  });
  if(!Number.isSafeInteger(subtotal)||!Number.isSafeInteger(discount)||!Number.isSafeInteger(subtotal+shipping+tax)||subtotal+shipping+tax-discount!==totalCents)throw Error('pix_order_total_mismatch');
  const result={status:'pending',items,subtotal:m(subtotal),tax:m(tax)};
  if(shipping)result.shipping=m(shipping);if(discount)result.discount=m(discount);
  return {mode:'itemized',reason:null,order:result};
 }catch(e){return {mode:'aggregate',reason:/^pix_order_[a-z_]+$/.test(e.message)?e.message:'pix_order_data_invalid',order:null};}
}

// Payment data comes from the original provider. Never generate or rewrite a PIX.
function pixCents(value) {
 const n=Number(value);if(!Number.isFinite(n)||n<0||Math.abs(n*100-Math.round(n*100))>0.00001)throw Error('pix_amount_invalid');
 const result=Math.round(n*100);if(!Number.isSafeInteger(result))throw Error('pix_amount_invalid');return result;
}
function pixFields(code) {
 if(typeof code!=='string'||!code.startsWith('000201')||/[\r\n\t]/.test(code))throw Error('pix_code_invalid');
 let crc=0xffff;for(const b of Buffer.from(code.slice(0,-4))){crc^=b<<8;for(let i=0;i<8;i++)crc=((crc&0x8000)?((crc<<1)^0x1021):(crc<<1))&0xffff;}
 if(!/6304[0-9A-Fa-f]{4}$/.test(code)||crc.toString(16).toUpperCase().padStart(4,'0')!==code.slice(-4).toUpperCase())throw Error('pix_crc_invalid');
 function fields(s){const bytes=Buffer.from(s),out={};let i=0;while(i<bytes.length){const tag=bytes.subarray(i,i+2).toString(),len=bytes.subarray(i+2,i+4).toString();if(!/^\d{2}$/.test(tag)||!/^\d{2}$/.test(len)||i+4+Number(len)>bytes.length||tag in out)throw Error('pix_tlv_invalid');out[tag]=bytes.subarray(i+4,i+4+Number(len)).toString();i+=4+Number(len);}return out;}
 const f=fields(code),ma=Object.entries(f).filter(([k])=>+k>=26&&+k<=51).map(([,v])=>fields(v)).find(v=>v['00']?.toLowerCase()==='br.gov.bcb.pix');
 if(!ma||!f['59'])throw Error('pix_account_invalid');
 const location=ma['25'];
 if(!/^(?:qrcode\.pix\.celcoin\.com\.br\/pixqrcode\/v2|qrcodepix\.bb\.com\.br\/pix\/v2)\/[a-f0-9-]+$/i.test(location||''))throw Error('pix_provider_not_verified');
 return {url:'https://'+location,merchant:f['59'],amount:f['54']===undefined?null:pixCents(f['54'])};
}
function pixKeyType(key){if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key))return 'EVP';if(/^\d{14}$/.test(key))return 'CNPJ';if(/^\d{11}$/.test(key))return 'CPF';if(/^\+[1-9]\d{7,14}$/.test(key))return 'PHONE';if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key))return 'EMAIL';throw Error('pix_key_invalid');}
function makePixCard(input,charge,now=Date.now()) {
 const f=pixFields(input.code),amount=pixCents(input.total),expiry=Date.parse(input.expires_at),min=Number(input.minimum_remaining_seconds||90);
 if(!amount||!Number.isFinite(expiry)||expiry<=now+min*1000)throw Error('pix_expired_or_short');
 if(!charge||charge.status!=='ATIVA'||charge.valor?.modalidadeAlteracao!==0)throw Error('pix_charge_not_active');
 if(pixCents(charge.valor?.original)!==amount||(f.amount!==null&&f.amount!==amount))throw Error('pix_amount_mismatch');
 const providerExpiry=Date.parse(charge.calendario?.criacao)+Number(charge.calendario?.expiracao)*1000;
 if(!Number.isFinite(providerExpiry)||providerExpiry<=now+min*1000||Math.abs(providerExpiry-expiry)>61000)throw Error('pix_expiry_mismatch');
 const key=String(charge.chave||''),key_type=pixKeyType(key);
 if(!/^(aristo|fish)$/.test(input.brand)||!/^\d+$/.test(String(input.reference)))throw Error('pix_reference_invalid');
 const m=v=>({value:v,offset:100});
 const details={reference_id:input.brand+'-'+input.reference,type:'digital-goods',payment_type:'br',payment_settings:[{type:'pix_dynamic_code',pix_dynamic_code:{code:input.code,merchant_name:f.merchant,key,key_type}}],currency:'BRL',total_amount:m(amount)};
 // An aggregate order label is truthful when the upstream event has no product detail.
 details.order={status:'pending',items:[{retailer_id:'order-'+input.reference,name:input.item_label||'Pedido #'+input.reference,amount:m(amount),quantity:1}],subtotal:m(amount),tax:m(0)};
 if(input.shopify_order){const enriched=pixShopifyOrder(input.shopify_order,String(input.reference),input.total);if(enriched.order)details.order=enriched.order;}
 return {type:'button',sub_type:'order_details',index:'0',parameters:[{type:'action',action:{order_details:details}}]};
}
async function getPixCard(input,http,now) {
 const url=pixFields(input.code).url;
 let response=await http({method:'GET',url,json:false,timeout:10000,disableFollowRedirect:true});
 if(typeof response==='string'){
  try{response=JSON.parse(response);}catch{
   const signed=url.startsWith('https://qrcodepix.bb.com.br/')?{alg:'RS512',jku:'https://qrcodepix.bb.com.br/pix/jwks.json'}:url.startsWith('https://qrcode.pix.celcoin.com.br/')?{alg:'PS512',jku:'https://qrcode.pix.celcoin.com.br/pixqrcode/v2/jwks'}:null;
   if(!signed)throw Error('pix_response_invalid');
   const parts=response.split('.');if(parts.length!==3)throw Error('pix_signature_invalid');
   let header;try{header=JSON.parse(Buffer.from(parts[0],'base64url').toString());}catch{throw Error('pix_signature_invalid');}
   if(header.alg!==signed.alg||header.jku!==signed.jku)throw Error('pix_signature_invalid');
   // This JWS is fetched directly from the pinned PSP over certificate-validated
   // HTTPS with redirects disabled. Trust that transport; never accept a JWS
   // supplied by the customer or follow its header URLs.
   try{response=JSON.parse(Buffer.from(parts[1],'base64url').toString());}catch{throw Error('pix_response_invalid');}
  }
 }
 return makePixCard(input,response,now===undefined?Date.now():now);
}
module.exports={pixShopifyOrder,pixCents,pixFields,pixKeyType,makePixCard,getPixCard};
