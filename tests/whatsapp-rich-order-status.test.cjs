'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {richOrderEvent}=require('../n8n/growth/whatsapp-rich-order-status.cjs');
const now=Date.parse('2026-09-20T16:00:00Z');
function fixture(){return {brand:'fish',reference:'42',phone:'41999060777',first_name:'Felipe',order:{id:'gid://shopify/Order/42',name:'#TESTE-42',test:false,cancelledAt:null,displayFinancialStatus:'PAID',createdAt:'2026-09-20T12:00:00-03:00',currencyCode:'BRL',statusPageUrl:'https://fishermans.com.br/0/orders/TESTE/authenticate?key=TESTE',shippingLine:{title:'Loggi'},transactions:[{kind:'SALE',status:'SUCCESS',test:false,processedAt:'2026-09-20T12:01:00-03:00'}],lineItems:{pageInfo:{hasNextPage:false},nodes:[{name:'Camiseta UV',variantTitle:'Azul / M',quantity:1,discountedTotalSet:{shopMoney:{amount:'89.90',currencyCode:'BRL'}},image:{url:'https://cdn.shopify.com/s/files/fixture.jpg'}}]}}};}
test('builds the native Meta customer event with item, image, shipping, price and order URL',()=>{
 const result=richOrderEvent(fixture(),now);assert.equal(result.ok,true);assert.deepEqual(result.event.event.rich_order_status,{order_url:'https://fishermans.com.br/0/orders/TESTE/authenticate?key=TESTE',order_date:'2026-09-20T15:00:00.000Z',currency:'BRL',shipping_method:'Loggi',items:[{name:'Camiseta UV — Azul / M',quantity:1,amount_1000:8990,image_url:'https://cdn.shopify.com/s/files/fixture.jpg'}]});assert.equal(result.event.customer.id,'5541999060777');assert.equal(result.event.event.type,'ORDER_PLACED');
});
test('refuses unpaid, test, cancelled or unproved orders before transport',()=>{
 for(const change of [x=>x.order.displayFinancialStatus='PENDING',x=>x.order.test=true,x=>x.order.cancelledAt='2026-09-20T12:02:00Z',x=>x.order.transactions=[],x=>x.order.transactions[0].test=true]){const input=fixture();change(input);assert.equal(richOrderEvent(input,now).ok,false);}
});
test('refuses incomplete item pages, missing image, guessed amount, foreign URL and missing shipping',()=>{
 for(const change of [x=>x.order.lineItems.pageInfo.hasNextPage=true,x=>delete x.order.lineItems.nodes[0].image,x=>x.order.lineItems.nodes[0].discountedTotalSet.shopMoney.amount='',x=>x.order.statusPageUrl='https://example.invalid/order',x=>x.order.shippingLine=null]){const input=fixture();change(input);assert.equal(richOrderEvent(input,now).ok,false);}
});
test('does not confuse a rich paid-order receipt with a PIX payment card',()=>{
 const result=richOrderEvent(fixture(),now);assert.equal(JSON.stringify(result).includes('payment_settings'),false);assert.equal(JSON.stringify(result).includes('pix_dynamic_code'),false);assert.equal(result.event.event.rich_order_status.currency,'BRL');
});
