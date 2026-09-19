'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const WAT=require('../whatsapp-template-contract.js'),P=require('../n8n/growth/whatsapp-template-example-patch.cjs');
const url='https://fishermans.com.br/{{1}}',example='https://fishermans.com.br/0/orders/EXEMPLOPEDIDO/authenticate?key=EXEMPLOCHAVE';
const draft=b=>({canal:'whatsapp',marca:'fish',nome:'fishermans_pedido_pago_claro_v2',peca:'pedido-pago',categoria:'UTILITY',corpo:'Seu pedido está pago.',botoes:[{tipo:'url',texto:'Acompanhar pedido',valor:url,...b}]});
const serialize=d=>WAT.components(d,[{type:'BODY',text:d.corpo},{type:'BUTTONS',buttons:[]}]);
test('explicit reserved synthetic sample survives serialization in the approved host and path shape',()=>{
 const d=draft({exemplo_url:example});assert.deepEqual(WAT.errors(d),[]);
 assert.equal(serialize(d)[1].buttons[0].example[0],example);
 assert.equal(serialize(d)[1].buttons[0].url,url);
 const a=draft({valor:'https://oaristocrata.com/{{1}}',exemplo_url:example.replace('fishermans.com.br','oaristocrata.com')});assert.deepEqual(WAT.errors(a),[]);
});
test('real-shaped identifiers, cross-host, credentials, wrong prefix, placeholders and extra query are rejected',()=>{
 for(const b of [{exemplo_url:example.replace('/0/','/123/')},{exemplo_url:example.replace('EXEMPLOCHAVE','private')},{exemplo_url:example.replace('fishermans.com.br','oaristocrata.com')},{exemplo_url:example+'&extra=true'},{exemplo_url:example.replace('EXEMPLOPEDIDO','{{1}}')},{exemplo_url:example.replace('https://','https://user@')},{valor:'https://fishermans.com.br/pedido/{{1}}',exemplo_url:example},{valor:'https://evil.invalid/{{1}}',exemplo_url:'https://evil.invalid/exemplo'},{exemplo_url:null}]){
  const d=draft(b);assert.ok(WAT.errors(d).length);assert.equal(serialize(d)[1].buttons[0].example?.[0],d.botoes[0].valor.replace('{{1}}','exemplo'),'invalid provided sample is ignored; errors block submission');
 }
});
test('existing dynamic examples and static/support/PIX behavior stay unchanged when omitted',()=>{
 assert.equal(serialize(draft({}))[1].buttons[0].example[0],'https://fishermans.com.br/exemplo');
 const staticDraft=draft({valor:'https://fishermans.com.br/suporte'});assert.equal(serialize(staticDraft)[1].buttons[0].example,undefined);
 const pix={canal:'whatsapp',categoria:'UTILITY',peca:'pix',corpo:'Detalhes da cobrança.',botoes:[{tipo:'order_details',texto:'Copiar PIX',valor:''}]};
 assert.deepEqual(WAT.errors(pix),[]);assert.equal(serialize(pix)[1].buttons[0].type,'ORDER_DETAILS');
});
test('fresh-version generator changes only both WAT copies and fails on drift',()=>{
 const fs=require('node:fs');const updated=fs.readFileSync(require.resolve('../whatsapp-template-contract.js'),'utf8');
 const original=updated.replace(P.HELPERS,'').replace("const error=WAT.urlError(b.valor)||WAT.urlExampleError(b)","const error=WAT.urlError(b.valor)").replace('example:[WAT.urlExample(x)]',P.OLD_EXAMPLE);
 const w={versionId:'fresh',nodes:['Prepara','Decide escrita'].map(name=>({name,type:'n8n-nodes-base.code',parameters:{jsCode:original}})).concat({name:'Meta criar template',parameters:{untouched:true}}),connections:{untouched:true}};
 const p=P.patchWorkflow(w,{expectedVersionId:'fresh'});assert.equal(p.changes.length,2);assert.deepEqual(p.workflow.nodes[2],w.nodes[2]);assert.deepEqual(p.workflow.connections,w.connections);
 assert.deepEqual(P.patchWorkflow(p.workflow,{expectedVersionId:'fresh'}).changes,[]);
 assert.throws(()=>P.patchWorkflow(w,{expectedVersionId:'old'}),/matching/);
 w.nodes[0].parameters.jsCode='drift';assert.throws(()=>P.patchWorkflow(w,{expectedVersionId:'fresh'}),/changed/);
});
