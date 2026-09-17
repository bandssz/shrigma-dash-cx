const {test}=require('node:test'),assert=require('node:assert/strict');
const W=require('../whatsapp-template-contract');
test('action templates require a navigable CTA, not only a quick reply',()=>{
 const d={canal:'whatsapp',peca:'pedido-pago',nome:'confirmacao',corpo:'Pedido confirmado.',botoes:[{tipo:'quick_reply',texto:'Acompanhar'}]};
 assert(W.errors(d).some(e=>/precisa de um botão/.test(e.mensagem)));
 d.botoes=[{tipo:'url',texto:'Acompanhar pedido',valor:'https://conta.fishermans.com.br/'}];assert.deepEqual(W.errors(d),[]);
});
test('link validation prevents malformed or unusable dynamic buttons',()=>{
 for(const url of ['http://example.com','https://user:pass@example.com/','https://example.com/a b','https://example.com/\\evil','https://example.com/{{2}}','https://example.com/{{1}}?q=1','https://example.com/{{1}}/{{1}}'])assert(W.urlError(url),url);
 for(const url of ['https://fishermans.com.br/{{1}}','https://fishermans.com.br/suporte','https://conta.oaristocrata.com/?utm_source=whatsapp'])assert.equal(W.urlError(url),null,url);
});
test('stock and pickup claims prompt verification in the creator',()=>{
 assert(W.warnings({canal:'whatsapp',corpo:'A transportadora já retirou o pedido.'}).some(w=>w.codigo==='VERIFY_CLAIM'));
 assert.equal(W.warnings({canal:'whatsapp',corpo:'Seu código de rastreio está disponível.'}).length,0);
});
const {friendlyComponents}=require('../n8n/growth/whatsapp-template-upgrade');
test('approved content migration removes old media only for the exact source and target',()=>{
 const c=[{type:'header',parameters:[{type:'image',image:{link:'https://example.com/a.jpg'}}]},{type:'body',parameters:[{type:'text',text:'Ana'}]}];
 const input={brand:'fish',template_id:'1791682188635768',components:c};
 assert.deepEqual(friendlyComponents(input,{template_name:'fishermans_pedido_pago_claro_v1'}),[c[1]]);
 assert.equal(friendlyComponents(input,{template_name:'another_template'}),c);
 assert.equal(friendlyComponents({...input,brand:'aristo'},{template_name:'fishermans_pedido_pago_claro_v1'}),c);
});
test('Meta header restrictions are caught before template submission',()=>{
 const d={canal:'whatsapp',nome:'aviso',corpo:'Um aviso para você.',botoes:[]};
 for(const cabecalho of ['Pagamento aprovado ✅','*Pagamento aprovado*','Linha 1\nLinha 2'])assert(W.errors({...d,cabecalho}).some(e=>e.campo==='cabecalho'));
 assert.deepEqual(W.errors({...d,cabecalho:'Pagamento aprovado'}),[]);
});
