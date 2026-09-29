'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto');
const E=require('../n8n/growth/segment-shopify-bulk-evidence.cjs');
const at={started:'2026-09-29T03:00:00.000Z',completed:'2026-09-29T03:01:00.000Z',observed:'2026-09-29T03:01:01.000Z'};
const customer=(id,email=' One@Example.COM ',overrides={})=>({id:`gid://shopify/Customer/${id}`,email,defaultEmailAddress:email===null?null:{emailAddress:email.trim()},firstName:'One',numberOfOrders:'0',amountSpent:{amount:'0.00',currencyCode:'BRL'},lastOrder:null,createdAt:'2025-01-01T00:00:00Z',updatedAt:'2026-09-29T03:00:00.123456Z',...overrides});
const input=(rows=[],overrides={})=>{const jsonl=rows.map(v=>JSON.stringify(v)).join('\n')+(rows.length?'\n':'');return {brand:'fish',shop:'synthetic-fish',operation:{data:{shop:{id:'gid://shopify/Shop/11',myshopifyDomain:'synthetic-fish.myshopify.com',currencyCode:'BRL',ianaTimezone:'America/Sao_Paulo'},currentAppInstallation:{accessScopes:[{handle:'read_customers'}]},node:{id:'gid://shopify/BulkOperation/91',status:'COMPLETED',errorCode:null,objectCount:String(rows.length),rootObjectCount:String(rows.length),createdAt:at.started,completedAt:at.completed,fileSize:String(Buffer.byteLength(jsonl)),url:rows.length?'https://storage.example.invalid/bulk?signature=secret':null,partialDataUrl:null}}},jsonl,observedAt:at.observed,querySha256:'a'.repeat(64),workflowId:'kcEo4Vb8rqDm4QZs',workflowVersion:'shopify-customer-bulk-v1',...overrides};};
const rejects=(value,code)=>assert.throws(()=>E.buildCustomerEvidence(value),error=>error?.message===code);

test('complete Customer-only Bulk preserves exact uint64, decimal, dates and provenance',()=>{
 const row=customer(1,' One@Example.COM ',{numberOfOrders:'18446744073709551615',amountSpent:{amount:'12345678901234567890.00100',currencyCode:'BRL'},lastOrder:{createdAt:'2026-08-01T15:30:00Z'}}),out=E.buildCustomerEvidence(input([row]));
 assert.equal(out.version,1);assert.equal(out.brand,'fish');assert.equal(out.shop,'synthetic-fish.myshopify.com');
 assert.equal(out.workflow_version,'shopify-customer-bulk-v1');
 assert.deepEqual(out.customers,[{customer_gid:'gid://shopify/Customer/1',email:'one@example.com',orders_count:'18446744073709551615',amount_spent:'12345678901234567890.00100',currency:'BRL',last_order_at:'2026-08-01T15:30:00Z',created_at:'2025-01-01T00:00:00Z',updated_at:'2026-09-29T03:00:00.123456Z',identity_ambiguous:false,identity_resolvable:true}]);
 assert.equal(out.source_sha256,crypto.createHash('sha256').update(input([row]).jsonl).digest('hex'));assert.equal(out.bulk.url_present,true);assert.equal(JSON.stringify(out).includes('signature=secret'),false);
});

test('a proven complete empty export stays empty without manufacturing zero-valued Customers',()=>{
 const out=E.buildCustomerEvidence(input([]));assert.deepEqual(out.customers,[]);assert.deepEqual(out.counts,{bytes:0,customers:0,object_count:'0',root_object_count:'0',email_missing:0,email_non_ascii:0,identity_ambiguous_records:0,identity_ambiguous_emails:0});
});

test('Aristo uses the same strict contract while keeping its server-provided shop identity',()=>{
 const value=input([customer(8,'aristo@example.com')],{brand:'aristo',shop:'synthetic-aristo.myshopify.com'});value.operation.data.shop.id='gid://shopify/Shop/22';value.operation.data.shop.myshopifyDomain='synthetic-aristo.myshopify.com';
 const out=E.buildCustomerEvidence(value);assert.equal(out.brand,'aristo');assert.equal(out.shop,'synthetic-aristo.myshopify.com');assert.equal(out.bulk.shop_gid,'gid://shopify/Shop/22');
});

test('incomplete, partial, errored and unreconciled operations fail the whole envelope',()=>{
 for(const [change,code] of [[{status:'RUNNING'},'SHOPIFY_BULK_INCOMPLETE'],[{errorCode:'INTERNAL_SERVER_ERROR'},'SHOPIFY_BULK_INCOMPLETE'],[{partialDataUrl:'https://partial.invalid'},'SHOPIFY_BULK_INCOMPLETE'],[{objectCount:'2'},'SHOPIFY_BULK_COUNT_MISMATCH'],[{rootObjectCount:'2'},'SHOPIFY_BULK_COUNT_MISMATCH'],[{fileSize:'999'},'SHOPIFY_BULK_SIZE_MISMATCH']]){const v=input([customer(1)]);Object.assign(v.operation.data.node,change);rejects(v,code);}
});

test('invalid JSON, non-root rows, invalid fields and duplicate GIDs fail atomically',()=>{
 const bad=input([customer(1)]);bad.jsonl=bad.jsonl.replace('{','{broken');bad.operation.data.node.fileSize=String(Buffer.byteLength(bad.jsonl));rejects(bad,'SHOPIFY_BULK_JSON_INVALID');
 rejects(input([customer(1),customer(1,'two@example.com')]),'SHOPIFY_CUSTOMER_GID_DUPLICATE');
 rejects(input([customer(1,'one@example.com',{__parentId:'gid://shopify/Customer/9'})]),'SHOPIFY_CUSTOMER_INVALID');
 rejects(input([customer(1,'one@example.com',{numberOfOrders:0})]),'SHOPIFY_CUSTOMER_ORDERS_INVALID');
 rejects(input([customer(1,'one@example.com',{amountSpent:{amount:'0e0',currencyCode:'BRL'}})]),'SHOPIFY_CUSTOMER_MONEY_INVALID');
 rejects(input([customer('1'.repeat(26))]),'SHOPIFY_CUSTOMER_GID_INVALID');
});

test('duplicate normalized email keeps every Customer and marks all identities ambiguous',()=>{
 const out=E.buildCustomerEvidence(input([customer(1,'Same@Example.com',{numberOfOrders:'1'}),customer(2,' same@example.com ',{numberOfOrders:'99'})]));
 assert.deepEqual(out.customers.map(v=>[v.customer_gid,v.orders_count,v.identity_ambiguous,v.identity_resolvable]),[['gid://shopify/Customer/1','1',true,false],['gid://shopify/Customer/2','99',true,false]]);assert.equal(out.counts.identity_ambiguous_emails,1);assert.equal(out.counts.identity_ambiguous_records,2);
});

test('nullable email and last order remain unknown rather than becoming empty string, false or zero',()=>{
 const out=E.buildCustomerEvidence(input([customer(1,null,{numberOfOrders:'7',amountSpent:{amount:'12.30',currencyCode:'BRL'}})]));assert.equal(out.customers[0].email,null);assert.equal(out.customers[0].last_order_at,null);assert.equal(out.customers[0].identity_resolvable,false);assert.equal(out.counts.email_missing,1);
});

test('shop, scope, chronology and limits are enforced from the server readback',()=>{
 let v=input([],{shop:'other'});rejects(v,'SHOPIFY_BULK_SHOP_INVALID');
 v=input([]);v.operation.data.currentAppInstallation.accessScopes=[];rejects(v,'SHOPIFY_BULK_SCOPE_INVALID');
 v=input([]);v.operation.data.node.completedAt='2026-09-29T04:00:00Z';rejects(v,'SHOPIFY_BULK_DATE_INVALID');
 v=input([]);v.operation.data.node.completedAt='2026-02-30T03:01:00Z';rejects(v,'SHOPIFY_BULK_DATE_INVALID');
 v=input([customer(1,'one@example.com',{updatedAt:'2026-09-29T03:01:00.000000002Z'})]);v.operation.data.node.completedAt='2026-09-29T03:01:00.000000001Z';rejects(v,'SHOPIFY_CUSTOMER_DATE_INVALID');
 v=input([]);v.operation.data.node.rootObjectCount='250001';v.operation.data.node.objectCount='250001';rejects(v,'SHOPIFY_BULK_LIMIT');
 v=input([]);v.operation.data.node.fileSize=String(128*1024*1024+1);rejects(v,'SHOPIFY_BULK_LIMIT');
 v=input([]);v.operation.data.shop.id='gid://shopify/Shop/'+'1'.repeat(21);rejects(v,'SHOPIFY_BULK_SHOP_INVALID');
 v=input([]);v.operation.data.node.id='gid://shopify/BulkOperation/'+'1'.repeat(26);rejects(v,'SHOPIFY_BULK_INCOMPLETE');
});

test('GraphQL cost extensions and empty errors are tolerated but errors are never evidence',()=>{
 const v=input([customer(1)]);v.operation.extensions={cost:{requestedQueryCost:4}};v.operation.errors=[];assert.equal(E.buildCustomerEvidence(v).customers.length,1);
 v.operation.errors=[{message:'synthetic'}];rejects(v,'SHOPIFY_BULK_RESPONSE_INVALID');
});

test('SMTPUTF8 is preserved but cannot become a subscriber identity, and streaming digest matches Node',()=>{
 const v=input([customer(1,'üser@example.com',{firstName:'Peixe 🐟'})]),out=E.buildCustomerEvidence(v);assert.equal(out.customers[0].email,'üser@example.com');assert.equal(out.customers[0].identity_resolvable,false);assert.equal(out.counts.email_non_ascii,1);assert.equal(out.source_sha256,crypto.createHash('sha256').update(v.jsonl).digest('hex'));assert.doesNotMatch(E.buildCustomerEvidenceSource,/const out=\[\]/);
});

test('serialized Code-node representation is self-contained and byte-equivalent',()=>{
 const isolated=vm.runInNewContext(E.buildCustomerEvidenceSource),value=input([customer(1,'üser@example.com')]);assert.deepEqual(JSON.parse(JSON.stringify(isolated(value))),E.buildCustomerEvidence(value));
});
