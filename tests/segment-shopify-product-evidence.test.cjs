'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const V1=require('../n8n/growth/segment-shopify-bulk-evidence.cjs'),E=require('../n8n/growth/segment-shopify-product-evidence.cjs');
const scopes=['read_customers','read_orders','read_all_orders','read_products'];
const at={started:'2026-09-29T03:00:00.000Z',completed:'2026-09-29T03:01:00.000Z',observed:'2026-09-29T03:01:01.000Z'};
const customer=(id,email='One@Example.com',more={})=>({id:`gid://shopify/Customer/${id}`,email,defaultEmailAddress:email===null?null:{emailAddress:email},firstName:'One',numberOfOrders:'2',amountSpent:{amount:'90.50',currencyCode:'BRL'},lastOrder:{createdAt:'2026-09-20T12:00:00Z'},createdAt:'2025-01-01T00:00:00Z',updatedAt:'2026-09-29T03:00:00Z',...more});
const order=(id,parent)=>({id:`gid://shopify/Order/${id}`,__parentId:`gid://shopify/Customer/${parent}`});
const item=(id,parent,product,quantity=1)=>({id:`gid://shopify/LineItem/${id}`,quantity,product:product===null?null:{id:`gid://shopify/Product/${product[0]}`,title:product[1]},__parentId:`gid://shopify/Order/${parent}`});
const value=(rows=[],more={})=>{const jsonl=rows.map(row=>JSON.stringify(row)).join('\n')+(rows.length?'\n':'');const roots=rows.filter(row=>!Object.hasOwn(row,'__parentId')).length;return {brand:'fish',shop:'synthetic-fish',operation:{data:{shop:{id:'gid://shopify/Shop/11',myshopifyDomain:'synthetic-fish.myshopify.com',currencyCode:'BRL',ianaTimezone:'America/Sao_Paulo'},currentAppInstallation:{accessScopes:scopes.map(handle=>({handle}))},node:{id:'gid://shopify/BulkOperation/91',status:'COMPLETED',errorCode:null,objectCount:String(rows.length),rootObjectCount:String(roots),createdAt:at.started,completedAt:at.completed,fileSize:String(Buffer.byteLength(jsonl)),url:rows.length?'https://storage.example.invalid/customer-products':null,partialDataUrl:null}}},jsonl,observedAt:at.observed,querySha256:'b'.repeat(64),workflowId:'synthetic-workflow',workflowVersion:'shopify-customer-products-v2',...more};};
const rejects=(v,code)=>assert.throws(()=>E.buildCustomerProductEvidence(v),error=>error?.message===code);

test('the historical v1 product semantics preserve the Customer projection and complete JSONL provenance',()=>{
 const rows=[customer(1),order(10,1),item(100,10,['9','Zeta']),item(101,10,['2','Alpha']),order(11,1),item(102,11,['2','Alpha'],0)],v=value(rows),out=E.buildCustomerProductEvidence(v);
 const rootInput=value([rows[0]]),legacy=V1.buildCustomerEvidence({...rootInput,querySha256:v.querySha256,workflowId:v.workflowId,workflowVersion:v.workflowVersion});
 assert.equal(out.version,2);for(const key of ['customer_gid','email','orders_count','amount_spent','currency','last_order_at','created_at','updated_at','identity_ambiguous','identity_resolvable'])assert.deepEqual(out.customers[0][key],legacy.customers[0][key]);
 assert.deepEqual(out.customers[0].products,[{id:'gid://shopify/Product/2',name:'Alpha'},{id:'gid://shopify/Product/9',name:'Zeta'}]);assert.equal(out.customers[0].unresolved_product_items,0);assert.equal(out.customers[0].product_history_complete,true);
 assert.equal(out.source_sha256,crypto.createHash('sha256').update(v.jsonl).digest('hex'));assert.deepEqual(out.counts,{...legacy.counts,bytes:Buffer.byteLength(v.jsonl),object_count:'6',root_object_count:'1',orders:2,line_items:3,product_missing:0,product_history_incomplete:0});
 assert.deepEqual(out.bulk.required_scopes,scopes);assert.equal(out.bulk.file_size,String(Buffer.byteLength(v.jsonl)));
 assert.equal(Object.hasOwn(out.bulk,'product_history_semantics'),false);
});

test('explicit v2 mode fails closed per Customer on missing or extra Order nodes',()=>{
 const missing=value([customer(1),order(10,1),item(100,10,['2','Alpha'])]),extra=value([customer(1,null,{numberOfOrders:'0',amountSpent:{amount:'0.00',currencyCode:'BRL'},lastOrder:null}),order(10,1),item(100,10,['2','Alpha'])]);
 const legacy=E.buildCustomerProductEvidence(missing),v2missing=E.buildCustomerProductEvidenceV2(missing),v2extra=E.buildCustomerProductEvidenceV2(extra);
 assert.equal(legacy.customers[0].product_history_complete,true);assert.equal(legacy.counts.product_history_incomplete,0);
 for(const out of [v2missing,v2extra]){assert.equal(out.customers[0].product_history_complete,false);assert.equal(out.customers[0].unresolved_product_items,0);assert.equal(out.counts.product_history_incomplete,1);assert.equal(out.bulk.product_history_semantics,'customer-order-parity-v2');assert.deepEqual(out.customers[0].products,[{id:'gid://shopify/Product/2',name:'Alpha'}]);}
});

test('null product makes only its Customer history incomplete, including quantity zero',()=>{
 const out=E.buildCustomerProductEvidence(value([customer(1),order(10,1),item(100,10,null,0),customer(2,'two@example.com'),order(20,2),item(200,20,['7','Seven'],1)]));
 assert.deepEqual(out.customers.map(c=>[c.customer_gid,c.unresolved_product_items,c.product_history_complete,c.products]),[
  ['gid://shopify/Customer/1',1,false,[]],['gid://shopify/Customer/2',0,true,[{id:'gid://shopify/Product/7',name:'Seven'}]]
 ]);assert.equal(out.counts.product_missing,1);assert.equal(out.counts.product_history_incomplete,1);
});

test('unresolved item totals and distinct incomplete Customers are independently exact',()=>{
 const out=E.buildCustomerProductEvidence(value([customer(1),order(10,1),item(100,10,null),item(101,10,null,0),customer(2,'two@example.com'),order(20,2),item(200,20,null),customer(3,'three@example.com'),order(30,3),item(300,30,['7','Seven'])]));
 assert.deepEqual(out.customers.map(c=>[c.unresolved_product_items,c.product_history_complete]),[[2,false],[1,false],[0,true]]);assert.equal(out.counts.product_missing,3);assert.equal(out.counts.product_history_incomplete,2);
});

test('empty completed product export preserves the default v1 envelope without manufacturing roots or products',()=>{
 const out=E.buildCustomerProductEvidence(value([]));assert.equal(out.version,2);assert.deepEqual(out.customers,[]);assert.equal(out.counts.object_count,'0');assert.equal(out.counts.root_object_count,'0');assert.equal(out.counts.orders,0);assert.equal(out.counts.line_items,0);assert.equal(out.counts.product_missing,0);assert.equal(out.counts.product_history_incomplete,0);
});

test('all required scopes are read from the completed operation response',()=>{
 for(const missing of scopes){const v=value([]);v.operation.data.currentAppInstallation.accessScopes=scopes.filter(x=>x!==missing).map(handle=>({handle}));rejects(v,'SHOPIFY_BULK_SCOPE_INVALID');}
 const v=value([]);v.operation.data.currentAppInstallation.accessScopes.push({handle:'read_customers'});rejects(v,'SHOPIFY_BULK_SCOPE_INVALID');
});

test('tree order, parents, exact row shapes and all row GIDs are strict',()=>{
 rejects(value([order(10,1),customer(1)]),'SHOPIFY_BULK_PARENT_INVALID');
 rejects(value([customer(1),item(100,10,['2','Alpha'])]),'SHOPIFY_BULK_PARENT_INVALID');
 rejects(value([customer(1),order(10,1),order(10,1)]),'SHOPIFY_BULK_GID_DUPLICATE');
 rejects(value([customer(1),order(10,1),item(100,10,['2','Alpha']),item(100,10,['2','Alpha'])]),'SHOPIFY_BULK_GID_DUPLICATE');
 rejects(value([customer(1),order(10,1),{...item(100,10,['2','Alpha']),nested:{}}]),'SHOPIFY_LINE_ITEM_INVALID');
 rejects(value([customer(1),{id:'gid://shopify/Order/10',__parentId:'gid://shopify/Customer/1',status:'paid'}]),'SHOPIFY_LINE_ITEM_INVALID');
});

test('counts and byte identity cover every node rather than the Customer projection',()=>{
 let v=value([customer(1),order(10,1),item(100,10,['2','Alpha'])]);v.operation.data.node.objectCount='2';rejects(v,'SHOPIFY_BULK_COUNT_MISMATCH');
 v=value([customer(1),order(10,1)]);v.operation.data.node.rootObjectCount='2';rejects(v,'SHOPIFY_BULK_COUNT_MISMATCH');
 v=value([customer(1)]);v.operation.data.node.fileSize='1';rejects(v,'SHOPIFY_BULK_SIZE_MISMATCH');
 v=value([customer(1)]);v.jsonl=v.jsonl.slice(0,-1)+'\ud800';v.operation.data.node.fileSize='1';rejects(v,'SHOPIFY_BULK_UTF8_INVALID');
});

test('quantity and product values fail closed and zero quantity is not a positive fact',()=>{
 const out=E.buildCustomerProductEvidence(value([customer(1),order(10,1),item(100,10,['2','Alpha'],0)]));assert.deepEqual(out.customers[0].products,[]);assert.equal(out.customers[0].unresolved_product_items,0);assert.equal(out.customers[0].product_history_complete,true);
 for(const quantity of [-1,1.5,'1',2147483648])rejects(value([customer(1),order(10,1),item(100,10,['2','Alpha'],quantity)]),'SHOPIFY_LINE_ITEM_INVALID');
 assert.deepEqual(E.buildCustomerProductEvidence(value([customer(1),order(10,1),item(100,10,['2','Alpha'],2147483647)])).customers[0].products,[{id:'gid://shopify/Product/2',name:'Alpha'}]);
 rejects(value([customer(1),order(10,1),item(100,10,['2','Alpha']),item(101,10,['2','Changed'])]),'SHOPIFY_PRODUCT_TITLE_CONFLICT');
 rejects(value([customer(1),order(10,1),{...item(100,10,['2','Alpha']),product:{id:'gid://shopify/Product/2',title:'Alpha',handle:'alpha'}}]),'SHOPIFY_PRODUCT_INVALID');
});

test('explicit root, all-node, byte and distinct-product limits fail before partial evidence',()=>{
 let v=value([]);v.operation.data.node.rootObjectCount='250001';v.operation.data.node.objectCount='250001';rejects(v,'SHOPIFY_BULK_LIMIT');
 v=value([]);v.operation.data.node.objectCount='1000001';rejects(v,'SHOPIFY_BULK_LIMIT');
 v=value([]);v.operation.data.node.fileSize=String(128*1024*1024+1);rejects(v,'SHOPIFY_BULK_LIMIT');
 const rows=[customer(1),order(10,1)];for(let n=1;n<=1001;n++)rows.push(item(1000+n,10,[String(n),'P'+n]));rejects(value(rows),'SHOPIFY_BULK_PRODUCT_LIMIT');
});

test('serialized n8n source is dependency-free and byte-equivalent',()=>{
 assert.doesNotMatch(E.buildCustomerProductEvidenceSource,/require\s*\(/);const isolated=vm.runInNewContext(E.buildCustomerProductEvidenceSource),v=value([customer(1,'üser@example.com'),order(10,1),item(100,10,['2','Peixe 🐟'])]);assert.deepEqual(JSON.parse(JSON.stringify(isolated(v))),E.buildCustomerProductEvidence(v));
 assert.doesNotMatch(E.buildCustomerProductEvidenceV2Source,/require\s*\(/);const isolatedV2=vm.runInNewContext(E.buildCustomerProductEvidenceV2Source);assert.deepEqual(JSON.parse(JSON.stringify(isolatedV2(v))),E.buildCustomerProductEvidenceV2(v));
});
