const test=require('node:test'),assert=require('node:assert/strict');
const {makePixCard,pixFields,pixCents,getPixCard}=require('../n8n/growth/whatsapp-pix-card');
const WAT=require('../whatsapp-template-contract');
const now=Date.parse('2026-09-17T12:00:00Z');
function code(location='qrcode.pix.celcoin.com.br/pixqrcode/v2/00000000-0000-0000-0000-000000000000'){const tlv=(k,v)=>k+String(Buffer.byteLength(v)).padStart(2,'0')+v;let s='000201010212'+tlv('26','0014br.gov.bcb.pix'+tlv('25',location))+'5204000053039865802BR'+tlv('59','FIXTURE')+tlv('60','CIDADE')+'6304';let c=0xffff;for(const b of Buffer.from(s)){c^=b<<8;for(let i=0;i<8;i++)c=((c&0x8000)?((c<<1)^0x1021):(c<<1))&0xffff;}return s+c.toString(16).toUpperCase().padStart(4,'0');}
const input={brand:'aristo',reference:'123',code:code(),total:'43.05',expires_at:'2026-09-17T12:07:00Z',minimum_remaining_seconds:90};
const charge={status:'ATIVA',valor:{original:'43.05',modalidadeAlteracao:0},chave:'00000000-0000-0000-0000-000000000000',calendario:{criacao:'2026-09-17T12:00:00Z',expiracao:420}};
test('native card preserves the exact provider code and amount',()=>{const b=makePixCard(input,charge,now),d=b.parameters[0].action.order_details;assert.equal(b.sub_type,'order_details');assert.equal(d.total_amount.value,4305);assert.equal(d.payment_settings[0].pix_dynamic_code.code,input.code);assert.equal(d.payment_settings[0].pix_dynamic_code.key_type,'EVP');assert.equal(d.reference_id,'aristo-123');assert.equal(pixCents(78.13000000000001),7813);});
test('paid, changed amount, near-expired, untrusted PSP and broken code never make a card',()=>{assert.throws(()=>makePixCard(input,{...charge,status:'CONCLUIDA'},now));assert.throws(()=>makePixCard({...input,total:'44'},charge,now));assert.throws(()=>makePixCard(input,charge,now+360000));assert.throws(()=>pixFields(input.code.slice(0,-1)+'0'));assert.throws(()=>makePixCard(input,{...charge,chave:'not-a-key'},now));});
test('creator blocks PIX as text and accepts its native card',()=>{const r={canal:'whatsapp',categoria:'UTILITY',nome:'pix_v1',peca:'pix-3min',corpo:'Olá {{1}}, seu pagamento está pendente.',exemplos:{1:'Ana'},botoes:[]};assert.ok(WAT.errors(r).length);assert.equal(WAT.errors({...r,botoes:[{tipo:'order_details',texto:'Copiar código Pix'}]}).length,0);assert.ok(WAT.errors({...r,corpo:input.code}).length);});
test('runtime verifies header/body/button separately and refuses a plain PIX template',()=>{const template={id:'1',name:'native',language:'pt_BR',status:'APPROVED',category:'UTILITY',components:[{type:'HEADER',format:'TEXT',text:'Olá {{1}}'},{type:'BODY',text:'Pagamento pendente.'},{type:'BUTTONS',buttons:[{type:'ORDER_DETAILS'}]}]};const r={brand:'aristo',piece:'pix-3min',flow:'pix',template_id:'1',template_name:'native',language:'pt_BR',components:[{type:'header',parameters:[{type:'text',text:'Ana'}]},makePixCard(input,charge,now)]};assert.equal(WAT.runtime(r,template),null);assert.ok(WAT.runtime({...r,components:r.components.slice(0,1)},template));assert.ok(WAT.runtime(r,{...template,components:template.components.slice(0,2)}));assert.ok(WAT.runtime({...r,components:[{type:'header',parameters:[{type:'text',text:input.code}]},r.components[1]]},template));});

test('Appmax bank endpoint comes from the original code, independently of brand',async()=>{
 const bb='qrcodepix.bb.com.br/pix/v2/00000000-0000-0000-0000-000000000000';
 const header={alg:'RS512',jku:'https://qrcodepix.bb.com.br/pix/jwks.json'};
 const raw=[header,charge].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.')+'.fixture';
 for(const brand of ['aristo','fish']){
  const calls=[];const result=await getPixCard({...input,brand,code:code(bb)},async q=>{calls.push(q);return raw;},now);
  assert.equal(result.parameters[0].action.order_details.reference_id,brand+'-123');assert.equal(calls.length,1);assert.equal(calls[0].url,'https://'+bb);assert.equal(calls[0].disableFollowRedirect,true);
 }
 await assert.rejects(()=>getPixCard({...input,code:code('attacker.example/pix/123')},async()=>{throw Error('must not fetch');},now),/pix_provider_not_verified/);
 const altered=Buffer.from(JSON.stringify({...header,jku:'https://attacker.example/keys'})).toString('base64url')+'.'+raw.split('.').slice(1).join('.');
 await assert.rejects(()=>getPixCard({...input,code:code(bb)},async()=>altered,now),/pix_signature_invalid/);
});
test('Celcoin can return JSON or JWS for the same Appmax code',async()=>{
 const raw=[{alg:'PS512',jku:'https://qrcode.pix.celcoin.com.br/pixqrcode/v2/jwks'},charge].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.')+'.fixture';
 for(const response of [JSON.stringify(charge),raw]){
  const b=await getPixCard(input,async()=>response,now);assert.equal(b.parameters[0].action.order_details.total_amount.value,4305);
 }
});

const {pixShopifyOrder}=require('../n8n/growth/whatsapp-pix-card');
const money=amount=>({shopMoney:{amount,currencyCode:'BRL'}});
function shopifyOrder(){return {id:'gid://shopify/Order/123',currencyCode:'BRL',cancelledAt:null,displayFinancialStatus:'PENDING',taxesIncluded:false,currentTotalPriceSet:money('43.05'),currentShippingPriceSet:money('5.05'),currentTotalTaxSet:money('0'),lineItems:{pageInfo:{hasNextPage:false},nodes:[{id:'gid://shopify/LineItem/1',name:'Produto de teste',quantity:2,currentQuantity:2,originalUnitPriceSet:money('20.00'),discountAllocations:[{allocatedAmountSet:money('2.00')}]}]}};}
test('itemized card reconciles real quantity, unit price, shipping and discounts to the verified charge',()=>{
 const order=shopifyOrder(),enriched=pixShopifyOrder(order,'123','43.05');assert.equal(enriched.mode,'itemized');assert.deepEqual(enriched.order.items,[{retailer_id:'1',name:'Produto de teste',amount:{value:2000,offset:100},quantity:2}]);assert.equal(enriched.order.subtotal.value,4000);assert.equal(enriched.order.discount.value,200);assert.equal(enriched.order.shipping.value,505);
 const card=makePixCard({...input,shopify_order:order},charge,now).parameters[0].action.order_details;
 assert.deepEqual(card.order,enriched.order);assert.equal(card.total_amount.value,4305);assert.equal(card.payment_settings[0].pix_dynamic_code.code,input.code);
});
test('incomplete or foreign order details keep the truthful aggregate card',()=>{
 for(const change of [o=>{o.id='gid://shopify/Order/999';},o=>{o.lineItems.pageInfo.hasNextPage=true;},o=>{o.lineItems.nodes[0].currentQuantity=1;},o=>{o.displayFinancialStatus='PAID';},o=>{o.currentShippingPriceSet=money('5.06');}]){
  const o=shopifyOrder();change(o);const r=pixShopifyOrder(o,'123','43.05');assert.equal(r.mode,'aggregate');assert.equal(r.order,null);
  const d=makePixCard({...input,shopify_order:o},charge,now).parameters[0].action.order_details;assert.equal(d.order.items[0].name,'Pedido #123');assert.equal(d.order.items[0].amount.value,4305);
 }
});
test('no guessed zeros, currencies, quantities or missing discounts enter item details',()=>{
 for(const change of [o=>{o.currentShippingPriceSet.shopMoney.amount=null;},o=>{o.currentShippingPriceSet.shopMoney.amount='';},o=>{o.currentShippingPriceSet.shopMoney.currencyCode='USD';},o=>{o.lineItems.nodes[0].quantity=1.5;},o=>{delete o.lineItems.nodes[0].discountAllocations;},o=>{o.lineItems.nodes[0].originalUnitPriceSet=money('20.001');},o=>{o.lineItems.nodes.push({...o.lineItems.nodes[0]});}]){const o=shopifyOrder();change(o);assert.equal(pixShopifyOrder(o,'123','43.05').mode,'aggregate');}
});
test('included tax cannot be charged twice and ordinary tax is reconciled',()=>{
 const o=shopifyOrder();o.currentTotalTaxSet=money('1');o.currentTotalPriceSet=money('44.05');
 assert.equal(pixShopifyOrder(o,'123','44.05').order.tax.value,100);
 o.taxesIncluded=true;assert.equal(pixShopifyOrder(o,'123','44.05').reason,'pix_order_tax_inclusive');
});
test('enrichment never bypasses payment state or charge-total checks',()=>{
 assert.throws(()=>makePixCard({...input,shopify_order:shopifyOrder()},{...charge,status:'CONCLUIDA'},now),/pix_charge_not_active/);
 assert.throws(()=>makePixCard({...input,shopify_order:shopifyOrder(),total:'44.05'},charge,now),/pix_amount_mismatch/);
});
