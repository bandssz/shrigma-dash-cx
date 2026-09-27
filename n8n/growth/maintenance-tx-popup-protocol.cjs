'use strict';
// Only JSON body values cross into the inbox; never headers or webhook envelopes.
const MAP={fish:{recebido:6,confirmado:5,preparando:12,em_rota:7,entregue:8,cancelado:9},aristo:{recebido:14,confirmado:15,preparando:17,em_rota:18,entregue:20,cancelado:16}};
const CORE='email name from_email reply_to subject template_id order_id event_type';
const DATA='address cancel_reason carrier checkout_url coupon_code coupon_heading coupon_text coupon_value cta_text delivered_at delivered_by delivery_estimate e first_name nome brand brand_name store_url shop_url has_discount headline items items_count last_update nps_url order_number order_url p paragraph_1 paragraph_2 paragraph_3 paragraph_4 payment_deadline payment_method preheader refund_method refund_status review_url s shipping_label shipping_name shipping_value status subtotal total tracking_company tracking_number tracking_status tracking_updated_at tracking_url urgency_text urgency_title';
const FIELDS=(CORE+' '+DATA).split(' '),ITEM_FIELDS='image name price qty quantity title variant'.split(' ');
const forbidden=/^(?:__proto__|prototype|constructor|headers?|authorization|credentials?|password|secret|api_key|access_token|claim_token|subscriber_mode|subscriber_emails|subscriber_ids|is_test|test)$/i;
function recognized(brand,b){
 const m=MAP[brand];return !!m&&b&&typeof b==='object'&&!Array.isArray(b)&&Object.prototype.hasOwnProperty.call(m,b.event_type)&&Number(b.template_id)===m[b.event_type]&&(brand==='fish'?/(^|<)[^<>\s@]+@fishermans\.com\.br>?$/i:/(^|<)[^<>\s@]+@oaristocrata\.com>?$/i).test(b.from_email||'');
}
function normalizeJSON(brand,text){
 if(typeof text!=='string'||text.length>131072)throw Error('MAINTENANCE_TX_BODY');
 const b=JSON.parse(text);if(!recognized(brand,b))throw Error('MAINTENANCE_TX_SCOPE');
 function controls(v,depth=0){if(depth>8)throw Error('MAINTENANCE_TX_BODY');if(v&&typeof v==='object')for(const [k,value] of Object.entries(v)){if(forbidden.test(k))throw Error('MAINTENANCE_TX_CONTROL');controls(value,depth+1);}}
 controls(b);
 const out={};for(const k of FIELDS){if(!Object.prototype.hasOwnProperty.call(b,k))continue;const v=b[k];
  if(k==='items'){
   if(!Array.isArray(v)||v.length>200)throw Error('MAINTENANCE_TX_ITEMS');out.items=v.map(item=>{if(!item||typeof item!=='object'||Array.isArray(item))throw Error('MAINTENANCE_TX_ITEMS');const o={};for(const key of ITEM_FIELDS)if(Object.prototype.hasOwnProperty.call(item,key)){scalar(item[key]);o[key]=item[key];}return o;});
  }else{scalar(v);out[k]=v;}
 }
 function scalar(v){if(v!==null&&!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)||typeof v==='string'&&(v.length>16384||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)))throw Error('MAINTENANCE_TX_FIELD');}
 if(typeof out.email!=='string'||!/^\S+@[^\s@]+\.[^\s@]+$/.test(out.email)||out.email.length>320||typeof out.subject!=='string'||!out.subject||out.subject.length>1000||!['string','number'].includes(typeof out.order_id)||!String(out.order_id)||String(out.order_id).length>256)throw Error('MAINTENANCE_TX_IDENTITY');
 for(const key of ['email','name','from_email','reply_to','subject'])if(typeof out[key]==='string'&&/[\r\n]/.test(out[key]))throw Error('MAINTENANCE_TX_HEADER');
 out.email=out.email.toLowerCase();if(JSON.stringify(out).length>131072)throw Error('MAINTENANCE_TX_BODY');return out;
}
function receiptResponse(row,brand){const r=row?.receipt;return r&&r.contract==='growth-maintenance-retention-v1'&&r.brand===brand&&r.flow==='transacional'&&r.persisted===true&&r.authorizes_send===false&&/^[a-f0-9-]{36}$/.test(r.event_id)&&/^[a-f0-9]{64}$/.test(r.payload_hash)?{status:200,body:r}:{status:503,body:{error:'retention_unconfirmed',persisted:false,authorizes_send:false}};}
function source(){return `const MAP=${JSON.stringify(MAP)};const FIELDS=${JSON.stringify(FIELDS)};const ITEM_FIELDS=${JSON.stringify(ITEM_FIELDS)};const forbidden=${forbidden};\n${recognized}\n${normalizeJSON}\n${receiptResponse}\n`;}
module.exports={MAP,FIELDS,ITEM_FIELDS,recognized,normalizeJSON,receiptResponse,source};
