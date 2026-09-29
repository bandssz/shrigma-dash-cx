'use strict';

const Customer=require('./segment-shopify-bulk-evidence.cjs');

function buildCustomerProductEvidenceWith(buildCustomerEvidence,input){
 const LIMITS={bytes:128*1024*1024,roots:250000,nodes:1000000,lineBytes:256*1024,products:1000,urlLength:8192};
 const REQUIRED_SCOPES=['read_customers','read_orders','read_all_orders','read_products'];
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
 const fail=code=>{throw Error(code);};
 const exact=(v,keys,code)=>{if(!object(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!own(v,k)))fail(code);return v;};
 const string=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
 const uint64=(v,code)=>{if(typeof v!=='string'||!/^(?:0|[1-9][0-9]{0,19})$/.test(v))fail(code);const n=BigInt(v);if(n>18446744073709551615n)fail(code);return n;};
 const gid=(v,type,digits=25)=>typeof v==='string'&&new RegExp('^gid://shopify/'+type+'/[1-9][0-9]{0,'+(digits-1)+'}$').test(v);
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
  const put=v=>{block[used++]=v;total++;if(used===64)compress();};eachUtf8(s,put);const bit=BigInt(total)*8n;put(0x80);while(used!==56)put(0);for(let shift=56n;shift>=0n;shift-=8n)put(Number((bit>>shift)&255n));return Array.from(H).map(v=>v.toString(16).padStart(8,'0')).join('');
 };

 if(!object(input)||typeof input.jsonl!=='string')fail('SHOPIFY_BULK_JSONL_INVALID');
 const rawBytes=utf8Length(input.jsonl);if(rawBytes>LIMITS.bytes)fail('SHOPIFY_BULK_LIMIT');
 const response=input.operation;
 if(!object(response)||!own(response,'data')||Object.keys(response).some(k=>!['data','extensions','errors'].includes(k))||(own(response,'errors')&&(!Array.isArray(response.errors)||response.errors.length)))fail('SHOPIFY_BULK_RESPONSE_INVALID');
 const data=exact(response.data,['shop','currentAppInstallation','node'],'SHOPIFY_BULK_RESPONSE_INVALID');
 const app=exact(data.currentAppInstallation,['accessScopes'],'SHOPIFY_BULK_SCOPE_INVALID');if(!Array.isArray(app.accessScopes))fail('SHOPIFY_BULK_SCOPE_INVALID');
 const scopes=new Set();for(const scope of app.accessScopes){exact(scope,['handle'],'SHOPIFY_BULK_SCOPE_INVALID');if(!string(scope.handle,100)||scopes.has(scope.handle))fail('SHOPIFY_BULK_SCOPE_INVALID');scopes.add(scope.handle);}if(REQUIRED_SCOPES.some(scope=>!scopes.has(scope)))fail('SHOPIFY_BULK_SCOPE_INVALID');
 const op=exact(data.node,['id','status','errorCode','objectCount','rootObjectCount','createdAt','completedAt','fileSize','url','partialDataUrl'],'SHOPIFY_BULK_OPERATION_INVALID');
 const objectCount=uint64(op.objectCount,'SHOPIFY_BULK_COUNT_INVALID'),rootCount=uint64(op.rootObjectCount,'SHOPIFY_BULK_COUNT_INVALID'),fileSize=uint64(op.fileSize,'SHOPIFY_BULK_SIZE_INVALID');
 if(objectCount>BigInt(LIMITS.nodes)||rootCount>BigInt(LIMITS.roots)||rootCount>objectCount||fileSize>BigInt(LIMITS.bytes))fail('SHOPIFY_BULK_LIMIT');
 if(BigInt(rawBytes)!==fileSize)fail('SHOPIFY_BULK_SIZE_MISMATCH');
 if(fileSize===0n){if(op.url!==null)fail('SHOPIFY_BULK_URL_INVALID');}else if(!string(op.url,LIMITS.urlLength)||!/^https:\/\//.test(op.url))fail('SHOPIFY_BULK_URL_INVALID');
 let lines=input.jsonl===''?[]:input.jsonl.split('\n');if(lines.length&&lines.at(-1)==='')lines.pop();if(lines.some(line=>line===''||utf8Length(line)>LIMITS.lineBytes)||lines.length>LIMITS.nodes)fail('SHOPIFY_BULK_JSONL_INVALID');
 if(BigInt(lines.length)!==objectCount)fail('SHOPIFY_BULK_COUNT_MISMATCH');

 const CUSTOMER_KEYS=['id','email','defaultEmailAddress','firstName','numberOfOrders','amountSpent','lastOrder','createdAt','updatedAt'];
 const roots=[],nodeGids=new Set(),customers=new Map(),orders=new Map(),productTitles=new Map();let orderCount=0,lineItemCount=0,productMissing=0;
 for(const line of lines){let row;try{row=JSON.parse(line);}catch{fail('SHOPIFY_BULK_JSON_INVALID');}
  if(!object(row))fail('SHOPIFY_BULK_NODE_INVALID');
  if(!own(row,'__parentId')){
   exact(row,CUSTOMER_KEYS,'SHOPIFY_CUSTOMER_INVALID');if(!gid(row.id,'Customer')||nodeGids.has(row.id))fail(nodeGids.has(row.id)?'SHOPIFY_BULK_GID_DUPLICATE':'SHOPIFY_CUSTOMER_GID_INVALID');
   nodeGids.add(row.id);roots.push(row);customers.set(row.id,{unresolved:0,products:new Map()});continue;
  }
  if(Object.keys(row).length===2&&own(row,'id')){
   exact(row,['id','__parentId'],'SHOPIFY_ORDER_INVALID');if(!gid(row.id,'Order')||nodeGids.has(row.id))fail(nodeGids.has(row.id)?'SHOPIFY_BULK_GID_DUPLICATE':'SHOPIFY_ORDER_INVALID');
   if(!gid(row.__parentId,'Customer')||!customers.has(row.__parentId))fail('SHOPIFY_BULK_PARENT_INVALID');nodeGids.add(row.id);orders.set(row.id,row.__parentId);orderCount++;continue;
  }
  exact(row,['id','quantity','product','__parentId'],'SHOPIFY_LINE_ITEM_INVALID');if(!gid(row.id,'LineItem')||nodeGids.has(row.id))fail(nodeGids.has(row.id)?'SHOPIFY_BULK_GID_DUPLICATE':'SHOPIFY_LINE_ITEM_INVALID');
  if(!gid(row.__parentId,'Order')||!orders.has(row.__parentId))fail('SHOPIFY_BULK_PARENT_INVALID');if(!Number.isSafeInteger(row.quantity)||row.quantity<0||row.quantity>2147483647)fail('SHOPIFY_LINE_ITEM_INVALID');nodeGids.add(row.id);lineItemCount++;
  const customer=customers.get(orders.get(row.__parentId));
  if(row.product===null){customer.unresolved++;productMissing++;continue;}
  exact(row.product,['id','title'],'SHOPIFY_PRODUCT_INVALID');if(!gid(row.product.id,'Product',20)||!string(row.product.title,500))fail('SHOPIFY_PRODUCT_INVALID');
  if(productTitles.has(row.product.id)&&productTitles.get(row.product.id)!==row.product.title)fail('SHOPIFY_PRODUCT_TITLE_CONFLICT');productTitles.set(row.product.id,row.product.title);if(productTitles.size>LIMITS.products)fail('SHOPIFY_BULK_PRODUCT_LIMIT');
  if(row.quantity>0)customer.products.set(row.product.id,row.product.title);
 }
 if(BigInt(roots.length)!==rootCount)fail('SHOPIFY_BULK_COUNT_MISMATCH');

 const rootJsonl=roots.map(row=>JSON.stringify(row)).join('\n')+(roots.length?'\n':'');
 const projected={...input,jsonl:rootJsonl,operation:JSON.parse(JSON.stringify(input.operation))};projected.operation.data.node.objectCount=String(roots.length);projected.operation.data.node.rootObjectCount=String(roots.length);projected.operation.data.node.fileSize=String(utf8Length(rootJsonl));projected.operation.data.node.url=roots.length?op.url:null;
 const base=buildCustomerEvidence(projected);if(base.customers.length!==roots.length)fail('SHOPIFY_BULK_COUNT_MISMATCH');
 let productHistoryIncomplete=0;for(const customer of base.customers){const state=customers.get(customer.customer_gid);customer.products=Array.from(state.products,([id,name])=>({id,name})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);customer.unresolved_product_items=state.unresolved;customer.product_history_complete=state.unresolved===0;if(state.unresolved>0)productHistoryIncomplete++;}
 base.version=2;base.source_sha256=sha256(input.jsonl);base.counts.bytes=rawBytes;base.counts.object_count=op.objectCount;base.counts.root_object_count=op.rootObjectCount;base.counts.orders=orderCount;base.counts.line_items=lineItemCount;base.counts.product_missing=productMissing;base.counts.product_history_incomplete=productHistoryIncomplete;
 base.bulk.file_size=op.fileSize;base.bulk.required_scope='read_customers';base.bulk.required_scopes=REQUIRED_SCOPES.slice();return base;
}

function buildCustomerProductEvidence(input){return buildCustomerProductEvidenceWith(Customer.buildCustomerEvidence,input);}
const buildCustomerProductEvidenceSource='((buildCustomerEvidence)=>((input)=>('+buildCustomerProductEvidenceWith.toString()+')(buildCustomerEvidence,input)))('+Customer.buildCustomerEvidenceSource+')';

module.exports={buildCustomerProductEvidence,buildCustomerProductEvidenceSource};
