'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../n8n/growth/whatsapp-order-status-proposal.cjs'),WAT=require('../whatsapp-template-contract.js'),GR=require('../growth-drafts.js');
const sourceCatalogs=require('./whatsapp-order-status-fixture.cjs').catalogs(),drafts=M.buildProposal(sourceCatalogs);
const response=()=>({data:{order:{id:'gid://shopify/Order/42',test:false,cancelledAt:null,displayFinancialStatus:'PAID',statusPageUrl:'https://fishermans.com.br/123/orders/SYNTHETICORDER/authenticate?key=SYNTHETICKEY'}}});
test('six proposals preserve reviewed text/support and remain disabled, with only synthetic examples',()=>{
 assert.equal(drafts.length,6);
 for(const p of drafts){
  const old=sourceCatalogs[p.brand].find(x=>x.name===p.source_template_name);
  for(const [key,type] of [['cabecalho','HEADER'],['corpo','BODY'],['rodape','FOOTER']])assert.equal(p.draft[key],old.components.find(c=>c.type===type).text);
  const buttons=old.components.find(c=>c.type==='BUTTONS').buttons;
  assert.deepEqual(p.draft.botoes[1],{tipo:'url',texto:buttons[1].text,valor:buttons[1].url});assert.equal(p.draft.botoes[0].texto,buttons[0].text);
  assert.equal(p.caller_proposal.enabled,false);assert.equal(p.caller_proposal.approved_template_id,null);
  assert.ok(p.target_template_name.endsWith('_v2'));assert.deepEqual(WAT.errors(p.draft),[]);
  assert.equal(WAT.isPix(p.draft),false);assert.ok(p.draft.botoes[0].exemplo_url.endsWith(M.SAMPLE_PATH));
  assert.ok(!JSON.stringify(p.draft.exemplos).includes('gmail.com'));
 }
});
test('panel serialization/export keeps the optional synthetic sample but does not add it to old drafts',()=>{
 const draft=drafts.find(p=>p.brand==='fish').draft,serialized=GR.conteudo(draft);
 assert.equal(serialized.botoes[0].exemplo_url,draft.botoes[0].exemplo_url);
 assert.equal(serialized.botoes[1].exemplo_url,undefined);
 assert.deepEqual(WAT.errors(serialized),[]);
 const imported=GR.importa(GR.exporta(draft));assert.equal(imported.erro,undefined);assert.equal(imported.rascunho.botoes[0].exemplo_url,draft.botoes[0].exemplo_url);
 const malformed=structuredClone(draft);malformed.botoes[0].exemplo_url={secret:'do not accept'};assert.ok(GR.importa(JSON.stringify(malformed)).erro);
 const plain=structuredClone(draft);delete plain.botoes[0].exemplo_url;
 assert.equal(Object.hasOwn(GR.conteudo(plain).botoes[0],'exemplo_url'),false);
});
test('exact order URL preserves opaque key and original taxonomy without overwriting existing query',()=>{
 const r=response(),result=M.resolveOrderStatus(r,{brand:'fish',order_id:'42',tracking:{utm_source:'whatsapp',utm_campaign:'fish-pos-compra'}});
 assert.equal(result.ok,true);assert.equal(result.parameter,'123/orders/SYNTHETICORDER/authenticate?key=SYNTHETICKEY&utm_source=whatsapp&utm_campaign=fish-pos-compra');
 r.data.order.statusPageUrl+='&utm_source=existing';
 assert.match(M.resolveOrderStatus(r,{brand:'fish',order_id:'42',tracking:{utm_source:'whatsapp'}}).parameter,/utm_source=existing$/);
});
test('wrong brand/order, generic account, ambiguous key, invalid path and customer cancellation fail closed',()=>{
 for(const url of ['https://oaristocrata.com/123/orders/X/authenticate?key=x','https://conta.fishermans.com.br/','https://fishermans.com.br/123/orders/X/authenticate?key=x&key=y','https://fishermans.com.br/123/orders/X/authenticate?key=','https://fishermans.com.br/123/orders/X/authenticate?other=x','https://fishermans.com.br/0/orders/X/authenticate?key=x','https://fishermans.com.br/123/orders/X/authenticate?key=x#frag','https://fishermans.com.br/123/orders/X/authenticate?key=%ZZ']){
  const r=response();r.data.order.statusPageUrl=url;assert.equal(M.resolveOrderStatus(r,{brand:'fish',order_id:'42'}).ok,false,url);
 }
 assert.equal(M.resolveOrderStatus(response(),{brand:'fish',order_id:'43'}).ok,false);
 const cancelled=response();cancelled.data.order.cancelledAt='2026-09-19T00:00:00Z';assert.equal(M.resolveOrderStatus(cancelled,{brand:'fish',order_id:'42'}).ok,false);
});
test('caller proposal cannot switch on draft/accepted/pending status or change paid/PIX semantics',()=>{
 const p=drafts.find(p=>p.target_template_name==='fishermans_pedido_pago_claro_v2');
 const input={brand:'fish',flow:'transacional',piece:'pedido-pago',ref:'42',template_id:p.caller_template_id,template_name:'old',language:'pt_BR',components:[{type:'header',parameters:[{type:'image',image:{link:'https://example.invalid/synthetic.png'}}]},{type:'body',parameters:Object.values(p.draft.exemplos).map(text=>({type:'text',text}))}]};
 const approved={...p.provider_payload,id:'90001',status:'APPROVED'};
 assert.deepEqual(M.prepareCallerChange(input,response(),p.caller_proposal,approved).input,input);
 const on={...p.caller_proposal,enabled:true,approved_template_id:'90001'};
 assert.equal(M.prepareCallerChange(input,response(),on,{...approved,status:'PENDING'}).blocked,true);
 const good=M.prepareCallerChange(input,response(),on,approved);assert.equal(good.applied,true);assert.equal(good.input.components.some(c=>c.type==='header'),false);assert.equal(good.input.components.at(-1).sub_type,'url');
 const changed=structuredClone(approved);changed.components.find(c=>c.type==='BODY').text+=' Outra mensagem';assert.equal(M.prepareCallerChange(input,response(),on,changed).blocked,true);
 const unpaid=response();unpaid.data.order.displayFinancialStatus='PENDING';assert.equal(M.prepareCallerChange(input,unpaid,on,approved).reason,'pedido_nao_pago');
 assert.equal(M.prepareCallerChange({...input,piece:'pix-15min'},response(),on,approved).blocked,true);
});
