'use strict';
// Pure Shopify collector state machine. The caller supplies authenticated transport.
// Only normalized pseudonymous rows leave accept(); raw responses are never retained.
const {createHash}=require('node:crypto');
const VERSION='growth-wa-cart-outcomes-v1';
const COUNT_QUERY=`query GrowthCartOutcomeCount($query: String!) { ordersCount(query: $query, limit: null) { count precision } }`;
const PAGE_QUERY=`query GrowthCartOutcomes($query: String!, $after: String, $sortKey: OrderSortKeys!) {
 orders(first: 100, after: $after, query: $query, sortKey: $sortKey) {
  pageInfo { hasNextPage endCursor }
  nodes { id createdAt updatedAt test cancelledAt displayFinancialStatus
   phone shippingAddress { phone countryCodeV2 } billingAddress { phone countryCodeV2 }
   netPaymentSet { shopMoney { amount currencyCode } }
   totalReceivedSet { shopMoney { amount currencyCode } }
   totalRefundedSet { shopMoney { amount currencyCode } }
   transactions { kind status processedAt amountSet { shopMoney { amount currencyCode } } }
  }
 }
}`;
const hash=(algorithm,s)=>createHash(algorithm).update(s).digest('hex');
const fail=reason=>{throw Error('OUTCOME_'+reason);};
function iso(v){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))fail('INVALID_TIME');return new Date(v).toISOString();}
function normalizePhone(value,country){
 if(value==null||value==='')return null;
 if(typeof value!=='string'||!/^[+\d() .-]+$/.test(value))return null;
 let digits=value.replace(/\D/g,'');
 if(/^55\d{10,11}$/.test(digits))return digits;
 if(country==='BR'&&/^\d{10,11}$/.test(digits)&&!value.trim().startsWith('+'))return '55'+digits;
 return null;
}
function identityInput(order,brand,salt){
 const fields=[[order.phone,order.shippingAddress?.countryCodeV2||order.billingAddress?.countryCodeV2],
  [order.shippingAddress?.phone,order.shippingAddress?.countryCodeV2],[order.billingAddress?.phone,order.billingAddress?.countryCodeV2]];
 const supplied=fields.filter(([v])=>v!=null&&v!==''),phones=supplied.map(([v,c])=>normalizePhone(v,c));
 if(!supplied.length)return {identity_state:'missing',value:null};
 if(phones.some(p=>!p))return {identity_state:'invalid',value:null};
 if(new Set(phones).size!==1)return {identity_state:'conflict',value:null};
 return {identity_state:'matched',value:salt+'|'+brand+'|'+phones[0]};
}
function identity(order,brand,salt,hashFn=hash){
 const i=identityInput(order,brand,salt);return {identity_state:i.identity_state,unit_key:i.value?hashFn('md5',i.value):null};
}
function money(bag){
 const m=bag?.shopMoney;
 if(!m||typeof m.amount!=='string'||!/^\-?\d{1,14}(?:\.\d{1,2})?$/.test(m.amount)||!/^\w{3}$/.test(m.currencyCode||''))return null;
 const negative=m.amount.startsWith('-'),parts=m.amount.replace('-','').split('.');
 const cents=BigInt(parts[0])*100n+BigInt((parts[1]||'').padEnd(2,'0'));
 return {cents:(negative?-cents:cents).toString(),currency:m.currencyCode};
}
function normalize(order,{brand,salt},hashFn=hash){
 if(!order||!/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(order.id||'')||typeof order.test!=='boolean')fail('INVALID_ORDER');
 const row={brand,order_id:order.id.split('/').pop(),created_at:iso(order.createdAt),source_updated_at:iso(order.updatedAt),test:order.test,cancelled_at:order.cancelledAt?iso(order.cancelledAt):null,...identity(order,brand,salt,hashFn)};
 const received=money(order.totalReceivedSet),refunded=money(order.totalRefundedSet),net=money(order.netPaymentSet);
 row.financial_status=typeof order.displayFinancialStatus==='string'?order.displayFinancialStatus:'UNKNOWN';
 row.currency=net?.currency||null;row.received_cents=received?.cents??null;row.refunded_cents=refunded?.cents??null;row.net_cents=net?.cents??null;
 row.financial_state='known';row.first_payment_at=null;row.paid_at=null;
 if(!received||!refunded||!net||received.currency!==net.currency||refunded.currency!==net.currency||BigInt(received.cents)-BigInt(refunded.cents)!==BigInt(net.cents)||BigInt(received.cents)<0||BigInt(refunded.cents)<0)row.financial_state='unknown_amount';
 const statuses=['PAID','PARTIALLY_REFUNDED','REFUNDED','PENDING','AUTHORIZED','PARTIALLY_PAID','VOIDED','EXPIRED'];
 if(!statuses.includes(row.financial_status)||!Array.isArray(order.transactions))row.financial_state='unknown_state';
 const payments=[];let paymentTotal=0n;
 for(const t of order.transactions||[]){
  if(t.status==='SUCCESS'&&['SALE','CAPTURE'].includes(t.kind)){
   const m=money(t.amountSet);
   if(!m||m.currency!==row.currency){row.financial_state='unknown_payment';continue;}
   if(BigInt(m.cents)>0){paymentTotal+=BigInt(m.cents);try{payments.push(iso(t.processedAt));}catch{row.financial_state='unknown_payment';}}
  }
 }
 // A split payment is not complete at the first deposit; use the last successful
 // positive capture/sale and retain the current financial status separately.
 if(payments.length){payments.sort();row.first_payment_at=payments[0];row.paid_at=payments.at(-1);}
 if(received&&BigInt(received.cents)>0&&!row.paid_at)row.financial_state='unknown_payment';
 if(received&&BigInt(received.cents)!==paymentTotal)row.financial_state='unknown_payment';
 if(new Date(row.source_updated_at)<new Date(row.created_at))fail('ORDER_TIME_REGRESSION');
 if(row.paid_at&&(Date.parse(row.paid_at)<Date.parse(row.created_at)-86400000||Date.parse(row.paid_at)>Date.parse(row.source_updated_at)+60000))row.financial_state='unknown_payment';
 row.source_hash=hashFn('sha256',JSON.stringify(row));
 return row;
}
// Native n8n Crypto adapter: these transient strings never reach result()/SQL.
function prepareIdentity(order,options){
 const row=normalize(order,options,()=>null);delete row.source_hash;
 return {row,_identity_input:identityInput(order,options.brand,options.salt).value||''};
}
function prepareRevision(prepared,digest){
 if(!/^[a-f0-9]{32}$/.test(digest||''))fail('NATIVE_MD5_INVALID');
 const row={...prepared.row,unit_key:prepared.row.identity_state==='matched'?digest:null};
 return {row,_revision_input:JSON.stringify(row)};
}
function finishRevision(prepared,digest){
 if(!/^[a-f0-9]{64}$/.test(digest||''))fail('NATIVE_SHA256_INVALID');
 return {...prepared.row,source_hash:digest};
}
function begin({brand,mode,since,until,salt,run_id,now=new Date().toISOString(),max_orders=500,query_hash=null}){
 if(!['aristo','fish'].includes(brand)||!['updated','reconcile'].includes(mode)||!/^[-a-f0-9]{36}$/.test(salt||'')||!/^[-a-f0-9]{36}$/.test(run_id||''))fail('INVALID_CONFIG');
 const from=iso(since),to=iso(until),started=iso(now);
 if(Date.parse(to)<=Date.parse(from)||Date.parse(to)>Date.parse(started)||Date.parse(to)-Date.parse(from)>31*86400000||!Number.isInteger(max_orders)||max_orders<1||max_orders>500)fail('INVALID_WINDOW');
 const field=mode==='updated'?'updated_at':'created_at',query=`${field}:>='${from}' ${field}:<'${to}'`;
 if(query_hash!==null&&!/^[a-f0-9]{64}$/.test(query_hash))fail('QUERY_HASH_INVALID');
 return {version:VERSION,brand,mode,since:from,until:to,salt,run_id,started_at:started,phase:'count_before',query,query_hash:query_hash||hash('sha256',query),cursor:null,pages:0,max_orders,count_before:null,count_after:null,rows:{},done:false};
}
function request(state){
 if(state.done)fail('ALREADY_DONE');
 if(state.phase==='page')return {query:PAGE_QUERY,variables:{query:state.query,after:state.cursor,sortKey:state.mode==='updated'?'UPDATED_AT':'CREATED_AT'}};
 if(['count_before','count_after'].includes(state.phase))return {query:COUNT_QUERY,variables:{query:state.query}};
 fail('INVALID_PHASE');
}
function accept(input,response,{now=new Date().toISOString(),normalized=false}={}){
 // The n8n Code sandbox does not expose structuredClone. This state deliberately
 // contains JSON values only (money/date values were normalized to strings).
 const s=JSON.parse(JSON.stringify(input));
 if(s.done||response?.errors?.length||!response?.data)fail('SHOPIFY_RESPONSE');
 if(s.phase==='count_before'||s.phase==='count_after'){
  const c=response.data.ordersCount;
  if(!Number.isSafeInteger(c?.count)||c.count<0||c.precision!=='EXACT')fail('COUNT_NOT_EXACT');
  if(c.count>s.max_orders)fail('WINDOW_TOO_LARGE_SPLIT_REQUIRED');
  if(s.phase==='count_before'){s.count_before=c.count;s.phase='page';return s;}
  s.count_after=c.count;s.done=true;s.phase='done';s.completed_at=iso(now);
  s.complete=s.count_before===c.count&&c.count===Object.keys(s.rows).length;
  s.reason=s.complete?'complete':'count_changed_or_missing_rows';return s;
 }
 if(s.phase!=='page')fail('INVALID_PHASE');
 const page=response.data.orders,info=page?.pageInfo;
 if(!Array.isArray(page?.nodes)||typeof info?.hasNextPage!=='boolean')fail('INVALID_PAGE');
 if(page.nodes.length>100||JSON.stringify(response).length>1024000)fail('PAGE_SIZE_LIMIT_SPLIT_REQUIRED');
 for(const order of page.nodes){
  const row=normalized?order:normalize(order,s),at=s.mode==='updated'?row.source_updated_at:row.created_at;
  if(normalized&&(!/^[a-f0-9]{64}$/.test(row.source_hash||'')||'phone' in row||'_identity_input' in row||'_revision_input' in row))fail('INVALID_NATIVE_ROW');
  if(at<s.since||at>=s.until)fail('ORDER_OUTSIDE_WINDOW');
  const prior=s.rows[row.order_id];
  if(prior&&prior.source_hash!==row.source_hash)fail('ORDER_CHANGED_DURING_SCAN');
  s.rows[row.order_id]=row;
 }
 s.pages++;
 if(Object.keys(s.rows).length>s.max_orders||s.pages>6)fail('WINDOW_TOO_LARGE_SPLIT_REQUIRED');
 if(JSON.stringify(s).length>512000)fail('STATE_SIZE_LIMIT_SPLIT_REQUIRED');
 if(info.hasNextPage){if(!page.nodes.length||typeof info.endCursor!=='string'||!info.endCursor||info.endCursor===s.cursor)fail('CURSOR_NOT_ADVANCING');s.cursor=info.endCursor;}
 else{s.phase='count_after';s.cursor=null;}
 return s;
}
function result(s){
 if(!s.done)fail('INCOMPLETE_SCAN');
 return {version:VERSION,run_id:s.run_id,brand:s.brand,mode:s.mode,since:s.since,until:s.until,started_at:s.started_at,completed_at:s.completed_at,allocation_salt:s.salt,query_hash:s.query_hash,count_before:s.count_before,count_after:s.count_after,pages:s.pages,complete:s.complete,reason:s.reason,rows:Object.values(s.rows)};
}
module.exports={VERSION,COUNT_QUERY,PAGE_QUERY,normalizePhone,identity,money,normalize,prepareIdentity,prepareRevision,finishRevision,begin,request,accept,result};
