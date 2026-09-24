const money = amount => ({ shopMoney: { amount: String(amount), currencyCode: 'BRL' } });
const page = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const refund = ({items=0,shipping=0,itemTax=0,shippingTax=0,amount=items+shipping+itemTax+shippingTax,status='SUCCESS',id=1}={}) => ({
 id: 'gid://shopify/Refund/'+id,
 refundLineItems: page(items?[{id:'gid://shopify/RefundLineItem/'+id,subtotalSet:money(items),totalTaxSet:money(itemTax)}]:[]),
 refundShippingLines: page(shipping?[{id:'gid://shopify/RefundShippingLine/'+id,subtotalAmountSet:money(shipping),taxAmountSet:money(shippingTax)}]:[]),
 transactions: page([{id:'gid://shopify/OrderTransaction/'+id,kind:'REFUND',status,amountSet:money(amount)}]),
});
const order = (overrides={}) => ({
 id:'gid://shopify/Order/1',name:'#1',createdAt:'2026-09-10T15:00:00Z',updatedAt:'2026-09-10T15:00:00Z',
 cancelledAt:null,displayFinancialStatus:'PAID',currencyCode:'BRL',taxesIncluded:false,test:false,
 subtotalPriceSet:money(100),totalShippingPriceSet:money(20),totalRefundedSet:money(0),refunds:[],
 lineItems:page([{id:'gid://shopify/LineItem/1',quantity:1,originalTotalSet:money(110),discountAllocations:[{allocatedAmountSet:money(10)}]}]),
 shippingLines:page([{id:'gid://shopify/ShippingLine/1',discountedPriceSet:money(20)}]),...overrides,
});
module.exports={money,page,refund,order};
