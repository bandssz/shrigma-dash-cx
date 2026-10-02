'use strict';
const E=require('../n8n/growth/segment-shopify-rfm-evidence.cjs');
function fixture(brand='fish',revision=1){
 const now=Date.now(),iso=x=>new Date(x).toISOString(),start=now-120000,completed=now-90000,ordersStart=now-80000,ordersEnd=now-60000;
 const scopes=['read_customers','read_orders','read_all_orders'];
 const shop={id:'gid://shopify/Shop/'+(brand==='fish'?1:2),myshopifyDomain:'synthetic-'+brand+'.myshopify.com',currencyCode:'BRL',ianaTimezone:'America/Sao_Paulo'};
 const cs=[1,2,3].map(id=>({id:'gid://shopify/Customer/'+id,email:id===3?null:'person'+id+'@example.test',defaultEmailAddress:id===3?null:{emailAddress:'person'+id+'@example.test'},firstName:'Synthetic',numberOfOrders:id===1?'4':id===2?'1':'0',amountSpent:{amount:id===1?'12345678901234567890.00100':id===2?'10.00':'0.00',currencyCode:'BRL'},lastOrder:id===3?null:{createdAt:iso(now-(id===1?3600000:180*86400000))},createdAt:'2025-01-01T00:00:00.000Z',updatedAt:iso(start-1000)}));
 const os=[1,2,3,4,5].map(id=>({id:'gid://shopify/Order/'+id,createdAt:iso(now-(id<=4?(5-id)*3600000:180*86400000)),displayFinancialStatus:'PAID',customer:{id:'gid://shopify/Customer/'+(id<=4?1:2)},currentTotalPriceSet:{shopMoney:{amount:id<=4?'1000000000000000000.00100':'10.00',currencyCode:'BRL'}}}));
 const jsonl=rows=>rows.map(row=>JSON.stringify(row)).join('\n')+(rows.length?'\n':'');
 const customerJsonl=jsonl(cs),paidOrdersJsonl=jsonl(os);
 const op=(id,query,raw,rootCount,from,to)=>({data:{shop:{...shop},currentAppInstallation:{accessScopes:scopes.map(handle=>({handle}))},node:{id:'gid://shopify/BulkOperation/'+id,query,status:'COMPLETED',errorCode:null,objectCount:String(raw?raw.trimEnd().split('\n').length:0),rootObjectCount:String(rootCount),createdAt:iso(from),completedAt:iso(to),fileSize:String(Buffer.byteLength(raw)),url:raw?'https://storage.example.invalid/private-download':null,partialDataUrl:null}}});
 const base=brand==='fish'?100:200;
 return {brand,shop:shop.myshopifyDomain,operationId:brand==='fish'?`${String(revision).repeat(8)}-${String(revision).repeat(4)}-4${String(revision).repeat(3)}-8${String(revision).repeat(3)}-${String(revision).repeat(12)}`:`aaaaaaaa-aaaa-4aaa-8aaa-${String(revision).repeat(12)}`,producerRevision:'1234567',workflowId:'synthetic-rfm-'+brand,observedAt:iso(now-30000),customerOperation:op(base+revision*2,E.CUSTOMER_QUERY,customerJsonl,cs.length,start,completed),paidOrdersOperation:op(base+revision*2+1,E.PAID_ORDERS_QUERY,paidOrdersJsonl,5,ordersStart,ordersEnd),customerJsonl,paidOrdersJsonl};
}
function replaceOrders(input,rows){input.paidOrdersJsonl=rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':'');const op=input.paidOrdersOperation.data.node;op.objectCount=String(rows.length);op.rootObjectCount=String(rows.filter(r=>!Object.hasOwn(r,'__parentId')).length);op.fileSize=String(Buffer.byteLength(input.paidOrdersJsonl));op.url=rows.length?'https://storage.example.invalid/private-download':null;}
module.exports={fixture,replaceOrders};
