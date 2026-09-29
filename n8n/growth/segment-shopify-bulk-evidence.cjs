'use strict';

function buildCustomerEvidence({brand,shop,operation,jsonl,observedAt,querySha256,workflowId,workflowVersion}){
 const LIMITS={bytes:128*1024*1024,records:250000,lineBytes:256*1024,dateLength:40,urlLength:8192};
 const UINT64_MAX=18446744073709551615n;
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
 const fail=code=>{throw Error(code);};
 const exact=(v,keys,code)=>{if(!object(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!own(v,k)))fail(code);return v;};
 const goodString=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
 const instant=(v,code)=>{
  if(typeof v!=='string'||v.length>LIMITS.dateLength)fail(code);const m=/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?Z$/.exec(v);if(!m)fail(code);
  const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number),millisecond=Number((m[7]||'').padEnd(3,'0').slice(0,3));
  if(year<1970||month<1||month>12||hour>23||minute>59||second>59)fail(code);const ms=Date.UTC(year,month-1,day,hour,minute,second,millisecond),d=new Date(ms);
  if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day||d.getUTCHours()!==hour||d.getUTCMinutes()!==minute||d.getUTCSeconds()!==second)fail(code);const ns=BigInt(Date.UTC(year,month-1,day,hour,minute,second))*1000000n+BigInt((m[7]||'').padEnd(9,'0'));return {text:v,ms,ns};
 };
 const uint64=(v,code)=>{if(typeof v!=='string'||!/^(?:0|[1-9][0-9]{0,19})$/.test(v))fail(code);const n=BigInt(v);if(n>UINT64_MAX)fail(code);return n;};
 const decimal=(v,code)=>{if(typeof v!=='string'||v.length>96||!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(v))fail(code);return v;};
 const eachUtf8=(s,emit)=>{let count=0;const put=v=>{count++;if(emit)emit(v);};for(let i=0;i<s.length;i++){let c=s.charCodeAt(i);
  if(c>=0xd800&&c<=0xdbff){if(i+1>=s.length)fail('SHOPIFY_BULK_UTF8_INVALID');const d=s.charCodeAt(++i);if(d<0xdc00||d>0xdfff)fail('SHOPIFY_BULK_UTF8_INVALID');c=0x10000+((c-0xd800)<<10)+(d-0xdc00);}else if(c>=0xdc00&&c<=0xdfff)fail('SHOPIFY_BULK_UTF8_INVALID');
  if(c<0x80)put(c);else if(c<0x800){put(0xc0|(c>>6));put(0x80|(c&63));}else if(c<0x10000){put(0xe0|(c>>12));put(0x80|((c>>6)&63));put(0x80|(c&63));}else{put(0xf0|(c>>18));put(0x80|((c>>12)&63));put(0x80|((c>>6)&63));put(0x80|(c&63));}}
  return count;
 };
 const utf8Length=s=>eachUtf8(s,null);
 const sha256=s=>{
  const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const H=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]),W=new Uint32Array(64),r=(x,n)=>(x>>>n)|(x<<(32-n)),block=new Uint8Array(64);let used=0,total=0;
  const compress=()=>{for(let i=0;i<16;i++)W[i]=(block[i*4]<<24)|(block[i*4+1]<<16)|(block[i*4+2]<<8)|block[i*4+3];for(let i=16;i<64;i++){const q=r(W[i-15],7)^r(W[i-15],18)^(W[i-15]>>>3),z=r(W[i-2],17)^r(W[i-2],19)^(W[i-2]>>>10);W[i]=(W[i-16]+q+W[i-7]+z)>>>0;}let [a,c,d,e,f,g,h,j]=H;for(let i=0;i<64;i++){const s1=r(f,6)^r(f,11)^r(f,25),ch=(f&g)^(~f&h),t1=(j+s1+ch+K[i]+W[i])>>>0,s0=r(a,2)^r(a,13)^r(a,22),maj=(a&c)^(a&d)^(c&d),t2=(s0+maj)>>>0;j=h;h=g;g=f;f=(e+t1)>>>0;e=d;d=c;c=a;a=(t1+t2)>>>0;}H[0]=(H[0]+a)>>>0;H[1]=(H[1]+c)>>>0;H[2]=(H[2]+d)>>>0;H[3]=(H[3]+e)>>>0;H[4]=(H[4]+f)>>>0;H[5]=(H[5]+g)>>>0;H[6]=(H[6]+h)>>>0;H[7]=(H[7]+j)>>>0;used=0;};
  const put=v=>{block[used++]=v;total++;if(used===64)compress();};eachUtf8(s,put);const bit=BigInt(total)*8n;put(0x80);while(used!==56)put(0);for(let shift=56n;shift>=0n;shift-=8n)put(Number((bit>>shift)&255n));
  return Array.from(H).map(v=>v.toString(16).padStart(8,'0')).join('');
 };
 const email=v=>{if(v===null)return {value:null,resolvable:false};if(typeof v!=='string')fail('SHOPIFY_CUSTOMER_EMAIL_INVALID');const trimmed=v.trim();
  if(trimmed.length<3||trimmed.length>320||/[\u0000-\u0020\u007f]/.test(trimmed)||!/^[^@]+@[^@]+$/.test(trimmed))fail('SHOPIFY_CUSTOMER_EMAIL_INVALID');const ascii=/^[\x21-\x7e]+$/.test(trimmed);return {value:ascii?trimmed.toLowerCase():trimmed,resolvable:ascii};
 };

 if(!['fish','aristo'].includes(brand))fail('SHOPIFY_BULK_BRAND_INVALID');
 if(typeof shop!=='string'||!/^[a-z0-9][a-z0-9-]{0,62}(?:\.myshopify\.com)?$/.test(shop))fail('SHOPIFY_BULK_SHOP_INVALID');
 const expectedShop=shop.endsWith('.myshopify.com')?shop:shop+'.myshopify.com';
 if(typeof jsonl!=='string')fail('SHOPIFY_BULK_JSONL_INVALID');
 if(!/^[a-f0-9]{64}$/.test(querySha256)||!goodString(workflowId,64)||!goodString(workflowVersion,80))fail('SHOPIFY_BULK_PROVENANCE_INVALID');
 const observed=instant(observedAt,'SHOPIFY_BULK_OBSERVED_AT_INVALID');
 if(!object(operation)||!own(operation,'data')||Object.keys(operation).some(k=>!['data','extensions','errors'].includes(k))||(own(operation,'errors')&&(!Array.isArray(operation.errors)||operation.errors.length)))fail('SHOPIFY_BULK_RESPONSE_INVALID');
 const data=exact(operation.data,['shop','currentAppInstallation','node'],'SHOPIFY_BULK_RESPONSE_INVALID');
 const sourceShop=exact(data.shop,['id','myshopifyDomain','currencyCode','ianaTimezone'],'SHOPIFY_BULK_SHOP_INVALID');
 if(!/^gid:\/\/shopify\/Shop\/[1-9][0-9]{0,19}$/.test(sourceShop.id)||sourceShop.myshopifyDomain!==expectedShop||!/^[A-Z]{3}$/.test(sourceShop.currencyCode)||!goodString(sourceShop.ianaTimezone,80))fail('SHOPIFY_BULK_SHOP_INVALID');
 const app=exact(data.currentAppInstallation,['accessScopes'],'SHOPIFY_BULK_SCOPE_INVALID');if(!Array.isArray(app.accessScopes))fail('SHOPIFY_BULK_SCOPE_INVALID');
 const scopes=new Set();for(const v of app.accessScopes){exact(v,['handle'],'SHOPIFY_BULK_SCOPE_INVALID');if(!goodString(v.handle,100)||scopes.has(v.handle))fail('SHOPIFY_BULK_SCOPE_INVALID');scopes.add(v.handle);}if(!scopes.has('read_customers'))fail('SHOPIFY_BULK_SCOPE_INVALID');
 const op=exact(data.node,['id','status','errorCode','objectCount','rootObjectCount','createdAt','completedAt','fileSize','url','partialDataUrl'],'SHOPIFY_BULK_OPERATION_INVALID');
 if(!/^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]{0,24}$/.test(op.id)||op.status!=='COMPLETED'||op.errorCode!==null||op.partialDataUrl!==null)fail('SHOPIFY_BULK_INCOMPLETE');
 const started=instant(op.createdAt,'SHOPIFY_BULK_DATE_INVALID'),completed=instant(op.completedAt,'SHOPIFY_BULK_DATE_INVALID');if(started.ns>completed.ns||completed.ns>observed.ns)fail('SHOPIFY_BULK_DATE_INVALID');
 const objectCount=uint64(op.objectCount,'SHOPIFY_BULK_COUNT_INVALID'),rootCount=uint64(op.rootObjectCount,'SHOPIFY_BULK_COUNT_INVALID'),fileSize=uint64(op.fileSize,'SHOPIFY_BULK_SIZE_INVALID');
 if(objectCount!==rootCount)fail('SHOPIFY_BULK_COUNT_MISMATCH');if(rootCount>BigInt(LIMITS.records)||fileSize>BigInt(LIMITS.bytes))fail('SHOPIFY_BULK_LIMIT');
 if(fileSize===0n){if(op.url!==null)fail('SHOPIFY_BULK_URL_INVALID');}else if(!goodString(op.url,LIMITS.urlLength)||!/^https:\/\//.test(op.url))fail('SHOPIFY_BULK_URL_INVALID');
 const rawBytes=utf8Length(jsonl);if(rawBytes>LIMITS.bytes||BigInt(rawBytes)!==fileSize)fail('SHOPIFY_BULK_SIZE_MISMATCH');
 let lines=jsonl===''?[]:jsonl.split('\n');if(lines.length&&lines.at(-1)==='')lines.pop();if(lines.some(v=>v===''||utf8Length(v)>LIMITS.lineBytes)||lines.length>LIMITS.records)fail('SHOPIFY_BULK_JSONL_INVALID');
 if(BigInt(lines.length)!==rootCount)fail('SHOPIFY_BULK_COUNT_MISMATCH');
 const gids=new Set(),emailCounts=new Map(),customers=[];
 for(const line of lines){let row;try{row=JSON.parse(line);}catch{fail('SHOPIFY_BULK_JSON_INVALID');}
  exact(row,['id','email','defaultEmailAddress','firstName','numberOfOrders','amountSpent','lastOrder','createdAt','updatedAt'],'SHOPIFY_CUSTOMER_INVALID');
  if(typeof row.id!=='string'||!/^gid:\/\/shopify\/Customer\/[1-9][0-9]{0,24}$/.test(row.id)||gids.has(row.id))fail(gids.has(row.id)?'SHOPIFY_CUSTOMER_GID_DUPLICATE':'SHOPIFY_CUSTOMER_GID_INVALID');gids.add(row.id);
  if(row.firstName!==null&&(typeof row.firstName!=='string'||row.firstName.length>255))fail('SHOPIFY_CUSTOMER_INVALID');
  const legacy=email(row.email);let primary={value:null,resolvable:false};if(row.defaultEmailAddress!==null){exact(row.defaultEmailAddress,['emailAddress'],'SHOPIFY_CUSTOMER_EMAIL_INVALID');primary=email(row.defaultEmailAddress.emailAddress);}
  if(legacy.value!==null&&primary.value!==null&&legacy.value!==primary.value)fail('SHOPIFY_CUSTOMER_EMAIL_CONFLICT');const normalized=primary.value??legacy.value,resolvable=primary.value!==null?primary.resolvable:legacy.resolvable;
  const orders=uint64(row.numberOfOrders,'SHOPIFY_CUSTOMER_ORDERS_INVALID');
  const money=exact(row.amountSpent,['amount','currencyCode'],'SHOPIFY_CUSTOMER_MONEY_INVALID');decimal(money.amount,'SHOPIFY_CUSTOMER_MONEY_INVALID');if(money.currencyCode!==sourceShop.currencyCode)fail('SHOPIFY_CUSTOMER_CURRENCY_INVALID');
  const created=instant(row.createdAt,'SHOPIFY_CUSTOMER_DATE_INVALID'),updated=instant(row.updatedAt,'SHOPIFY_CUSTOMER_DATE_INVALID');if(created.ns>updated.ns||updated.ns>completed.ns)fail('SHOPIFY_CUSTOMER_DATE_INVALID');
  let last=null;if(row.lastOrder!==null){exact(row.lastOrder,['createdAt'],'SHOPIFY_CUSTOMER_DATE_INVALID');last=instant(row.lastOrder.createdAt,'SHOPIFY_CUSTOMER_DATE_INVALID');if(last.ns>completed.ns)fail('SHOPIFY_CUSTOMER_DATE_INVALID');}
  if(normalized!==null&&resolvable)emailCounts.set(normalized,(emailCounts.get(normalized)||0)+1);
  customers.push({customer_gid:row.id,email:normalized,orders_count:orders.toString(),amount_spent:money.amount,currency:money.currencyCode,last_order_at:last?.text??null,created_at:created.text,updated_at:updated.text,identity_ambiguous:false,identity_resolvable:normalized!==null&&resolvable});
 }
 let ambiguousRecords=0,missingEmail=0,nonAsciiEmail=0;const ambiguousEmails=new Set();for(const c of customers){if(c.email===null){missingEmail++;continue;}if(!c.identity_resolvable){nonAsciiEmail++;continue;}if(emailCounts.get(c.email)>1){c.identity_ambiguous=true;c.identity_resolvable=false;ambiguousRecords++;ambiguousEmails.add(c.email);}}
 return {version:1,brand,shop:expectedShop,operation_id:op.id,started_at:started.text,completed_at:completed.text,observed_at:observed.text,query_sha256:querySha256,workflow_id:workflowId,workflow_version:workflowVersion,source_sha256:sha256(jsonl),customers,counts:{bytes:rawBytes,customers:customers.length,object_count:op.objectCount,root_object_count:op.rootObjectCount,email_missing:missingEmail,email_non_ascii:nonAsciiEmail,identity_ambiguous_records:ambiguousRecords,identity_ambiguous_emails:ambiguousEmails.size},bulk:{file_size:op.fileSize,url_present:op.url!==null,partial_data:false,shop_gid:sourceShop.id,shop_currency:sourceShop.currencyCode,shop_timezone:sourceShop.ianaTimezone,required_scope:'read_customers'}};
}

const buildCustomerEvidenceSource='('+buildCustomerEvidence.toString()+')';
module.exports={buildCustomerEvidence,buildCustomerEvidenceSource};
