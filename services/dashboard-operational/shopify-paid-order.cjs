'use strict';
// Branch only: admission of a paid-order fact. No HTTP route or storage is wired.
const crypto=require('node:crypto');
function refuse(code,status=400){throw Object.assign(new Error(code),{code,status});}
function header(headers,name){const value=headers?.[name];if(typeof value!=='string'||!value||value.length>256||/[\r\n\0]/.test(value))refuse('SHOPIFY_HEADER_INVALID');return value;}
function id(value){if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<1)refuse('SHOPIFY_ORDER_INVALID');return String(value);}if(typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value))return value;refuse('SHOPIFY_ORDER_INVALID');}
function gid(kind,number,claimed){const expected='gid://shopify/'+kind+'/'+id(number);if(claimed!==undefined&&claimed!==null&&claimed!==expected)refuse('SHOPIFY_ORDER_INVALID');return expected;}
function stamp(value){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))refuse('SHOPIFY_ORDER_INVALID');return new Date(value).toISOString();}
function amount(value){if(typeof value!=='string'||!/^\d{1,12}\.\d{2}$/.test(value))refuse('SHOPIFY_ORDER_INVALID');return value;}
function verifyPaidOrder({rawBody,headers,shops,receivedAt}){
 if(!Buffer.isBuffer(rawBody)||rawBody.length===0||rawBody.length>2*1024*1024)refuse('SHOPIFY_BODY_INVALID',413);
 const shop=header(headers,'x-shopify-shop-domain');
 if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)||!shops||!Object.hasOwn(shops,shop))refuse('SHOPIFY_SHOP_UNAVAILABLE',401);
 const binding=shops[shop];if(!binding||!['aristo','fish'].includes(binding.brand)||typeof binding.secret!=='string'||!binding.secret)refuse('SHOPIFY_SHOP_UNAVAILABLE',503);
 const signature=header(headers,'x-shopify-hmac-sha256');
 if(!/^[A-Za-z0-9+/]{43}=$/.test(signature))refuse('SHOPIFY_SIGNATURE_INVALID',401);
 const provided=Buffer.from(signature,'base64'),expected=crypto.createHmac('sha256',binding.secret).update(rawBody).digest();
 if(provided.length!==expected.length||!crypto.timingSafeEqual(provided,expected))refuse('SHOPIFY_SIGNATURE_INVALID',401);
 if(header(headers,'x-shopify-topic')!=='orders/paid')refuse('SHOPIFY_TOPIC_UNSUPPORTED');
 const deliveryId=header(headers,'x-shopify-webhook-id');if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(deliveryId))refuse('SHOPIFY_HEADER_INVALID');
 let order;try{order=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawBody));}catch{refuse('SHOPIFY_BODY_INVALID');}
 if(!order||typeof order!=='object'||Array.isArray(order)||order.financial_status!=='paid'||typeof order.test!=='boolean'||order.cancelled_at!==null)refuse('SHOPIFY_ORDER_INVALID');
 const orderId=gid('Order',order.id,order.admin_graphql_api_id),customer=order.customer;
 if(customer!==null&&(!customer||typeof customer!=='object'||Array.isArray(customer)))refuse('SHOPIFY_ORDER_INVALID');
 const customerId=customer===null?null:gid('Customer',customer.id,customer.admin_graphql_api_id);
 if(typeof order.currency!=='string'||!/^[A-Z]{3}$/.test(order.currency))refuse('SHOPIFY_ORDER_INVALID');
 const createdAt=stamp(order.created_at),sourceUpdatedAt=stamp(order.updated_at),observedAt=stamp(receivedAt);
 if(Date.parse(sourceUpdatedAt)<Date.parse(createdAt))refuse('SHOPIFY_ORDER_INVALID');
 return Object.freeze({schema:'crm-shopify-paid-order-fact-v1',brand:binding.brand,orderId,customerId,createdAt,sourceUpdatedAt,observedAt,currency:order.currency,total:amount(order.current_total_price),financialStatus:'paid',test:order.test,deliveryId:deliveryId.toLowerCase(),orderKey:binding.brand+':'+orderId});
}
module.exports=Object.freeze({verifyPaidOrder});
