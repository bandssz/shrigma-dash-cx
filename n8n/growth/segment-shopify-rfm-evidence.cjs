'use strict';
// OFF candidate consumer for the existing collector. R/F/M use the same paid
// order export; the Customer export supplies GIDs only. No I/O or send here.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Customer=require('./segment-shopify-bulk-evidence.cjs'),Rfm=require('./segment-shopify-rfm.cjs');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const CUSTOMER_QUERY=fs.readFileSync(path.join(__dirname,'segment-shopify-customer-bulk.graphql'),'utf8');
const PAID_ORDERS_QUERY=fs.readFileSync(path.join(__dirname,'segment-shopify-rfm-paid-orders-bulk.graphql'),'utf8');
const CUSTOMER_QUERY_SHA256=sha(CUSTOMER_QUERY),PAID_ORDERS_QUERY_SHA256=sha(PAID_ORDERS_QUERY);
const ALGORITHM_SHA256=Rfm.SOURCE_SHA256;
const SOURCE_FILES=['segment-shopify-rfm-evidence.cjs','segment-shopify-rfm.cjs','segment-shopify-bulk-evidence.cjs','segment-shopify-customer-bulk.graphql','segment-shopify-rfm-paid-orders-bulk.graphql'];
const LOADED_SOURCE_PINS=Object.freeze(Object.fromEntries(SOURCE_FILES.map(name=>[name,sha(fs.readFileSync(path.join(__dirname,name)))])));
const LIMITS=Object.freeze({customerBytes:96*1024*1024,ordersBytes:128*1024*1024,orders:500000,lineBytes:256*1024});
const CUSTOMER_BATCH_ROWS=1000;
const fail=c=>{throw Object.assign(Error(c),{code:c});};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function assertSourceSeal(){
 if(LOADED_SOURCE_PINS['segment-shopify-rfm.cjs']!==ALGORITHM_SHA256||SOURCE_FILES.some(name=>sha(fs.readFileSync(path.join(__dirname,name)))!==LOADED_SOURCE_PINS[name]))fail('RFM_EXPORT_SOURCE_DRIFT');
 const customerModule=fs.readFileSync(path.join(__dirname,'segment-shopify-bulk-evidence.cjs'),'utf8'),start=customerModule.indexOf('function buildCustomerEvidence('),end=customerModule.indexOf('\n\nconst buildCustomerEvidenceSource=',start);
 if(start<0||end<0||customerModule.slice(start,end).trim()!==Customer.buildCustomerEvidence.toString())fail('RFM_EXPORT_SOURCE_DRIFT');
}
function exact(v,keys,code){if(!object(v)||Object.keys(v).sort().join(',')!==keys.slice().sort().join(','))fail(code);}
function instant(v){
 const m=typeof v==='string'&&/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?Z$/.exec(v);if(!m)fail('RFM_EXPORT_DATE');
 const [y,mo,d,h,mi,s]=m.slice(1,7).map(Number),ms=Date.UTC(y,mo-1,d,h,mi,s),date=new Date(ms);
 if(y<1970||mo<1||mo>12||h>23||mi>59||s>59||date.getUTCFullYear()!==y||date.getUTCMonth()!==mo-1||date.getUTCDate()!==d)fail('RFM_EXPORT_DATE');
 return {ns:BigInt(ms)*1000000n+BigInt((m[7]||'').padEnd(9,'0')),iso:v.slice(0,19)+'.'+(m[7]||'').padEnd(3,'0').slice(0,3)+'Z'};
}
function count(v){if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(v)||!Number.isSafeInteger(Number(v)))fail('RFM_EXPORT_COUNT');return Number(v);}
function scalarText(v){if(typeof v!=='string'||Buffer.from(v,'utf8').toString('utf8')!==v)fail('RFM_EXPORT_UTF8');return v;}
function decodeBytes(v){if(!Buffer.isBuffer(v)&&!(v instanceof Uint8Array))fail('RFM_EXPORT_BYTES');try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(v);}catch{fail('RFM_EXPORT_UTF8');}}
function pinnedOperation(input,expectedQuery){
 if(!object(input)||!object(input.data)||!object(input.data.node)||typeof input.data.node.query!=='string'||sha(input.data.node.query)!==expectedQuery)fail('RFM_EXPORT_QUERY_PIN');
 const out=structuredClone(input);delete out.data.node.query;return out;
}
function customerMap(customers){return new Map(customers.map(c=>[c.customer_gid,{customer_gid:c.customer_gid,identity_email_sha256:c.identity_resolvable===true&&c.identity_ambiguous===false?sha(c.email):null,paid_orders:0,amount:0n,scale:0,last:null}]));}
function prepareOrdersEvidence({brand,operationId,producerRevision,workflowId,observedAt,paidOrdersOperation},observed,customerPoll,customer,byCustomer){
 const ordersPoll=pinnedOperation(paidOrdersOperation,PAID_ORDERS_QUERY_SHA256);
 if(Object.hasOwn(ordersPoll,'errors')&&(!Array.isArray(ordersPoll.errors)||ordersPoll.errors.length)||Object.keys(ordersPoll).some(k=>!['data','errors','extensions'].includes(k)))fail('RFM_EXPORT_RESPONSE');
 exact(ordersPoll.data,['shop','currentAppInstallation','node'],'RFM_EXPORT_RESPONSE');const d=ordersPoll.data,op=d.node;
 exact(d.shop,['id','myshopifyDomain','currencyCode','ianaTimezone'],'RFM_EXPORT_SHOP');
 if(Object.keys(d.shop).some(k=>d.shop[k]!==customerPoll.data.shop[k]))fail('RFM_EXPORT_SHOP');
 exact(d.currentAppInstallation,['accessScopes'],'RFM_EXPORT_SCOPES');
 const scopes=x=>{if(!Array.isArray(x))fail('RFM_EXPORT_SCOPES');return x.map(v=>{exact(v,['handle'],'RFM_EXPORT_SCOPES');if(typeof v.handle!=='string'||!/^[a-z_]{1,80}$/.test(v.handle))fail('RFM_EXPORT_SCOPES');return v.handle;}).sort();};
 const currentScopes=scopes(d.currentAppInstallation.accessScopes),customerScopes=scopes(customerPoll.data.currentAppInstallation.accessScopes);
 if(JSON.stringify(currentScopes)!==JSON.stringify(customerScopes)||new Set(currentScopes).size!==currentScopes.length||!['read_customers','read_orders','read_all_orders'].every(s=>currentScopes.includes(s)))fail('RFM_EXPORT_SCOPES');
 exact(op,['id','status','errorCode','objectCount','rootObjectCount','createdAt','completedAt','fileSize','url','partialDataUrl'],'RFM_EXPORT_OPERATION');
 if(typeof op.id!=='string'||!/^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]{0,24}$/.test(op.id)||op.id===customer.operation_id||op.status!=='COMPLETED'||op.errorCode!==null||op.partialDataUrl!==null)fail('RFM_EXPORT_INCOMPLETE');
 const started=instant(op.createdAt),completed=instant(op.completedAt),first=instant(customer.started_at);
 if(started.ns<instant(customer.completed_at).ns||completed.ns<started.ns||completed.ns>observed.ns)fail('RFM_EXPORT_SEQUENCE');
 const rootCount=count(op.rootObjectCount),objectCount=count(op.objectCount),fileBytes=count(op.fileSize);
 if(rootCount>LIMITS.orders||fileBytes>LIMITS.ordersBytes||objectCount!==rootCount)fail('RFM_EXPORT_LIMIT');
 if(fileBytes===0?op.url!==null:typeof op.url!=='string'||op.url.length>8192||!/^https:\/\//.test(op.url))fail('RFM_EXPORT_URL');
 const expires=new Date(Date.parse(first.iso)+26*3600000).toISOString();if(observed.ns>=instant(expires).ns)fail('RFM_EXPORT_EXPIRED');
 // Only reduced GID facts survive this phase; raw Customer rows/emails are freed
 // before streaming orders. No metadata object retains either raw payload.
 return {brand,operationId,producerRevision,workflowId,observedAt:observed.iso,first:first.iso,expires,currentScopes,shopId:d.shop.id,currency:d.shop.currencyCode,customerBulk:customer.operation_id,customerHash:customer.source_sha256,customerBytes:customer.counts.bytes,op,completedNs:completed.ns,rootCount,fileBytes,byCustomer,orderIds:new Set(),hash:crypto.createHash('sha256'),bytes:0,roots:0,unassigned:0};
}
function prepareRfmEvidence({brand,shop,operationId,producerRevision,workflowId,observedAt,customerOperation,paidOrdersOperation,customerJsonl}={}){
 assertSourceSeal();
 const observed=instant(observedAt),customerPoll=pinnedOperation(customerOperation,CUSTOMER_QUERY_SHA256);
 scalarText(customerJsonl);if(Buffer.byteLength(customerJsonl)>LIMITS.customerBytes)fail('RFM_EXPORT_LIMIT');
 const customer=Customer.buildCustomerEvidence({brand,shop,operation:customerPoll,jsonl:customerJsonl,observedAt,querySha256:CUSTOMER_QUERY_SHA256,workflowId,workflowVersion:producerRevision});
 return prepareOrdersEvidence({brand,operationId,producerRevision,workflowId,observedAt,paidOrdersOperation},observed,customerPoll,customer,customerMap(customer.customers));
}
function unsigned(v,code){if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(v))fail(code);const n=BigInt(v);if(n>18446744073709551615n)fail(code);return n;}
function customerView(poll,rows,bytes){const view=structuredClone(poll),node=view.data.node;node.objectCount=String(rows);node.rootObjectCount=String(rows);node.fileSize=String(bytes);node.url=rows?'https://stream.invalid/customer-batch':null;return view;}
function prepareCustomerStream(input={}){
 assertSourceSeal();const {brand,shop,operationId,producerRevision,workflowId,observedAt,customerOperation,paidOrdersOperation}=input,observed=instant(observedAt),customerPoll=pinnedOperation(customerOperation,CUSTOMER_QUERY_SHA256),node=customerPoll.data.node;
 const roots=unsigned(node.rootObjectCount,'RFM_EXPORT_COUNT'),objects=unsigned(node.objectCount,'RFM_EXPORT_COUNT'),fileBytes=unsigned(node.fileSize,'RFM_EXPORT_COUNT');
 if(roots!==objects||roots>250000n||fileBytes>BigInt(LIMITS.customerBytes))fail('RFM_EXPORT_LIMIT');
 if(fileBytes===0n?node.url!==null:typeof node.url!=='string'||node.url.length>8192||!/^https:\/\//.test(node.url))fail('RFM_EXPORT_URL');
 const empty=Customer.buildCustomerEvidence({brand,shop,operation:customerView(customerPoll,0,0),jsonl:'',observedAt,querySha256:CUSTOMER_QUERY_SHA256,workflowId,workflowVersion:producerRevision});
 return {input:{brand,operationId,producerRevision,workflowId,observedAt,paidOrdersOperation},observed,customerPoll,empty,expected:Number(roots),fileBytes:Number(fileBytes),bytes:0,rows:0,hash:crypto.createHash('sha256'),decoder:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),tail:'',batch:[],byCustomer:new Map(),emailCounts:new Map(),missing:0,nonAscii:0};
}
function addCustomerBatch(state){
 if(!state.batch.length)return;const jsonl=state.batch.join('\n')+'\n',view=customerView(state.customerPoll,state.batch.length,Buffer.byteLength(jsonl)),part=Customer.buildCustomerEvidence({brand:state.empty.brand,shop:state.empty.shop,operation:view,jsonl,observedAt:state.empty.observed_at,querySha256:CUSTOMER_QUERY_SHA256,workflowId:state.empty.workflow_id,workflowVersion:state.empty.workflow_version});
 for(const c of part.customers){if(state.byCustomer.has(c.customer_gid))fail('SHOPIFY_CUSTOMER_GID_DUPLICATE');let digest=null;if(c.email===null)state.missing++;else if(c.identity_resolvable||c.identity_ambiguous){digest=sha(c.email);state.emailCounts.set(digest,(state.emailCounts.get(digest)||0)+1);}else state.nonAscii++;state.byCustomer.set(c.customer_gid,{customer_gid:c.customer_gid,identity_email_sha256:digest,paid_orders:0,amount:0n,scale:0,last:null});}
 state.batch.length=0;
}
function addCustomerLine(state,line){if(line===''||Buffer.byteLength(line)>LIMITS.lineBytes)fail('RFM_EXPORT_OBJECTS');state.rows++;if(state.rows>state.expected)fail('RFM_EXPORT_ROOTS');state.batch.push(line);if(state.batch.length===CUSTOMER_BATCH_ROWS)addCustomerBatch(state);}
async function consumeCustomerStream(state,stream){
 try{for await(const chunk of stream){if(!Buffer.isBuffer(chunk)&&!(chunk instanceof Uint8Array))fail('RFM_EXPORT_BYTES');state.bytes+=chunk.byteLength;if(state.bytes>LIMITS.customerBytes||state.bytes>state.fileBytes)fail('RFM_EXPORT_LIMIT');state.hash.update(chunk);state.tail+=state.decoder.decode(chunk,{stream:true});let offset=0,end;while((end=state.tail.indexOf('\n',offset))>=0){addCustomerLine(state,state.tail.slice(offset,end));offset=end+1;}state.tail=state.tail.slice(offset);if(Buffer.byteLength(state.tail)>LIMITS.lineBytes)fail('RFM_EXPORT_OBJECTS');}state.tail+=state.decoder.decode();if(state.tail!=='')addCustomerLine(state,state.tail);}catch(e){if(e.code?.startsWith('RFM_')||e.message?.startsWith('SHOPIFY_'))throw e;if(e instanceof TypeError)fail('RFM_EXPORT_UTF8');throw e;}
 addCustomerBatch(state);if(state.bytes!==state.fileBytes)fail('RFM_EXPORT_BYTES');if(state.rows!==state.expected)fail('RFM_EXPORT_ROOTS');let ambiguous=0;for(const fact of state.byCustomer.values())if(fact.identity_email_sha256!==null&&(state.emailCounts.get(fact.identity_email_sha256)||0)>1){fact.identity_email_sha256=null;ambiguous++;}
 const customer={operation_id:state.empty.operation_id,started_at:state.empty.started_at,completed_at:state.empty.completed_at,source_sha256:state.hash.digest('hex'),counts:{bytes:state.bytes,customers:state.rows,email_missing:state.missing,email_non_ascii:state.nonAscii,identity_ambiguous_records:ambiguous}};
 state.emailCounts.clear();state.batch.length=0;state.tail='';return prepareOrdersEvidence(state.input,state.observed,state.customerPoll,customer,state.byCustomer);
}
function addLine(state,line){
 if(line===''||Buffer.byteLength(line)>LIMITS.lineBytes)fail('RFM_EXPORT_OBJECTS');let row;try{row=JSON.parse(line);}catch{fail('RFM_EXPORT_JSON');}
 exact(row,['id','createdAt','displayFinancialStatus','customer','currentTotalPriceSet'],'RFM_EXPORT_ORDER');
 if(typeof row.id!=='string'||!/^gid:\/\/shopify\/Order\/[1-9][0-9]{0,24}$/.test(row.id)||state.orderIds.has(BigInt(row.id.slice('gid://shopify/Order/'.length)))||row.displayFinancialStatus!=='PAID')fail('RFM_EXPORT_ORDER');
 // Compact exact IDs; Number would alias distinct IDs above 2^53.
 state.orderIds.add(BigInt(row.id.slice('gid://shopify/Order/'.length)));state.roots++;if(state.roots>state.rootCount)fail('RFM_EXPORT_ROOTS');const created=instant(row.createdAt);if(created.ns>state.completedNs)fail('RFM_EXPORT_DATE');
 exact(row.currentTotalPriceSet,['shopMoney'],'RFM_EXPORT_MONEY');const money=row.currentTotalPriceSet.shopMoney;exact(money,['amount','currencyCode'],'RFM_EXPORT_MONEY');
 if(typeof money.amount!=='string'||money.amount.length>96||!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,20})?$/.test(money.amount)||money.currencyCode!==state.currency)fail('RFM_EXPORT_MONEY');
 if(row.customer===null){state.unassigned++;return;}
 exact(row.customer,['id'],'RFM_EXPORT_CUSTOMER');if(typeof row.customer.id!=='string'||!/^gid:\/\/shopify\/Customer\/[1-9][0-9]{0,24}$/.test(row.customer.id))fail('RFM_EXPORT_CUSTOMER');
 const fact=state.byCustomer.get(row.customer.id);if(!fact)fail('RFM_EXPORT_CUSTOMER_MISSING');fact.paid_orders++;
 const [whole,fraction='']=money.amount.split('.'),scale=Math.max(fact.scale,fraction.length);fact.amount=fact.amount*10n**BigInt(scale-fact.scale)+BigInt(whole+fraction)*10n**BigInt(scale-fraction.length);fact.scale=scale;
 // Retain only exact nanoseconds, not a date object and ISO string per buyer.
 if(fact.last===null||created.ns>fact.last)fact.last=created.ns;
}
function finishRfmEvidence(state){
 assertSourceSeal();
 if(state.bytes!==state.fileBytes)fail('RFM_EXPORT_BYTES');if(state.roots!==state.rootCount)fail('RFM_EXPORT_ROOTS');
 const payloadHash=state.hash.digest('hex'),customers=[];for(const f of state.byCustomer.values()){const text=f.amount.toString().padStart(f.scale+1,'0');f.amount_spent=f.scale?text.slice(0,-f.scale)+'.'+text.slice(-f.scale):text;f.last_paid_order_at=f.last===null?null:new Date(Number(f.last/1000000n)).toISOString();delete f.amount;delete f.scale;delete f.last;customers.push(f);}state.byCustomer.clear();
 const provenance=Rfm.validateProvenance({brand:state.brand,shop_id:state.shopId,operation_id:state.operationId,customer_bulk:{gid:state.customerBulk,query_sha256:CUSTOMER_QUERY_SHA256,payload_sha256:state.customerHash,status:'COMPLETED',object_count:customers.length},paid_orders_bulk:{gid:state.op.id,query_sha256:PAID_ORDERS_QUERY_SHA256,payload_sha256:payloadHash,status:'COMPLETED',object_count:state.roots},workflow_id:state.workflowId,producer_revision:state.producerRevision,algorithm_sha256:ALGORITHM_SHA256,access_scopes:state.currentScopes,history_complete:true,started_at:state.first,observed_at:state.observedAt,expires_at:state.expires});
 const meta={brand:state.brand,operation_id:state.operationId,shop_id:state.shopId,customer_bulk_gid:state.customerBulk,paid_orders_bulk_gid:state.op.id,customer_query_sha256:CUSTOMER_QUERY_SHA256,paid_orders_query_sha256:PAID_ORDERS_QUERY_SHA256,customer_payload_sha256:state.customerHash,paid_orders_payload_sha256:payloadHash,workflow_id:state.workflowId,producer_revision:state.producerRevision,algorithm_sha256:ALGORITHM_SHA256,access_scopes:state.currentScopes,history_complete:true,started_at:state.first,observed_at:state.observedAt,expires_at:state.expires,expected_customers:customers.length};
 const result={meta,customers,provenance,source_hash:Rfm.sourceHash(provenance),counts:{customers:customers.length,paid_orders:state.roots,unassigned_orders:state.unassigned,bytes:state.customerBytes+state.bytes}};
 state.orderIds.clear();return result;
}
function buildRfmEvidence(input){
 const state=prepareRfmEvidence(input),text=scalarText(input.paidOrdersJsonl),raw=Buffer.from(text,'utf8');if(raw.length>LIMITS.ordersBytes)fail('RFM_EXPORT_LIMIT');state.hash.update(raw);state.bytes=raw.length;
 let offset=0;while(offset<text.length){const end=text.indexOf('\n',offset);if(end<0){addLine(state,text.slice(offset));break;}addLine(state,text.slice(offset,end));offset=end+1;}return finishRfmEvidence(state);
}
async function consumePaidOrdersStream(state,stream){
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let tail='';
 try{for await(const chunk of stream){if(!Buffer.isBuffer(chunk)&&!(chunk instanceof Uint8Array))fail('RFM_EXPORT_BYTES');state.bytes+=chunk.byteLength;if(state.bytes>LIMITS.ordersBytes||state.bytes>state.fileBytes)fail('RFM_EXPORT_LIMIT');state.hash.update(chunk);tail+=decoder.decode(chunk,{stream:true});let offset=0,end;while((end=tail.indexOf('\n',offset))>=0){addLine(state,tail.slice(offset,end));offset=end+1;}tail=tail.slice(offset);if(Buffer.byteLength(tail)>LIMITS.lineBytes)fail('RFM_EXPORT_OBJECTS');}tail+=decoder.decode();if(tail!=='')addLine(state,tail);}catch(e){if(e.code?.startsWith('RFM_'))throw e;if(e instanceof TypeError)fail('RFM_EXPORT_UTF8');throw e;}
 return finishRfmEvidence(state);
}
module.exports={assertSourceSeal,LOADED_SOURCE_PINS,buildRfmEvidence,prepareRfmEvidence,prepareCustomerStream,consumeCustomerStream,consumePaidOrdersStream,decodeBytes,LIMITS,CUSTOMER_BATCH_ROWS,CUSTOMER_QUERY,PAID_ORDERS_QUERY,CUSTOMER_QUERY_SHA256,PAID_ORDERS_QUERY_SHA256,ALGORITHM_SHA256};
