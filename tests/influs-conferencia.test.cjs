'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const C=require('../influs-conferencia.js');
const linha=(o)=>({marca:'aristo',codigo:'CAPIVARA',tipo:'influ',influ:'capivara',relatorio_pedidos:655,relatorio_vendas_liquidas:105382.03,relatorio_cobertura:'completa',
 relatorio_coletado_em:'2026-09-26T17:00:27Z',pagos:630,receita_paga:103231.84,nao_pagos:25,receita_nao_paga:2150.19,status_nao_pagos:{EXPIRED:24,PENDING:1},
 painel_atualizado_em:'2026-09-26T07:16:06Z',diferenca:0,situacao:'explicada_nao_pagos',...o});
const payload=()=>({conciliacao:[linha(),
 linha({codigo:'PRIMEIRACOMPRA',tipo:'crm',influ:null,pagos:0,receita_paga:0,nao_pagos:0,receita_nao_paga:0,relatorio_pedidos:5049,relatorio_vendas_liquidas:676898.95,diferenca:676898.95,situacao:'fora_da_lente'}),
 linha({marca:'fish',codigo:'FF',influ:'ff',relatorio_pedidos:30,relatorio_vendas_liquidas:5467.25,pagos:27,receita_paga:5070.15,nao_pagos:3,receita_nao_paga:397.10,status_nao_pagos:{EXPIRED:3},diferenca:0}),
 linha({marca:'fish',codigo:'BRUTAL TAMBA',tipo:null,influ:null,relatorio_pedidos:3,relatorio_vendas_liquidas:916.75,pagos:3,receita_paga:916.75,nao_pagos:0,receita_nao_paga:0,status_nao_pagos:{},situacao:'igual'})],
 saude:[{lane:'sync_cupom',marca:'aristo',ok:true,em:'2026-09-26T06:50:00Z',ultimo_ok_em:'2026-09-26T06:50:00Z',detalhe:'ok'},
  {lane:'sync_cupom',marca:'fish',ok:false,em:'2026-09-26T06:50:00Z',ultimo_ok_em:null,detalhe:'Access denied for discountNodes'},
  {lane:'coleta_pedidos',marca:'aristo',ok:true,em:'2026-09-24T07:10:00Z',ultimo_ok_em:'2026-09-24T07:10:00Z',detalhe:'40 pagina(s)'}],
 coleta:{aristo:'2026-09-26T07:16:06Z',fish:'2026-09-26T07:17:37Z'}});
const AGORA=new Date('2026-09-26T15:00:00Z').getTime();

test('lente padrão mostra só cupons de creator; cupom de CRM aparece apenas em "todos"',()=>{
 assert.deepEqual(C.linhas(payload(),'todas','lente').map(x=>x.codigo),['CAPIVARA','FF','BRUTAL TAMBA']);
 assert.equal(C.linhas(payload(),'todas','todos')[0].codigo,'PRIMEIRACOMPRA');
 assert.deepEqual(C.linhas(payload(),'fish','lente').map(x=>x.codigo),['FF','BRUTAL TAMBA'],'marca isola');
 assert.equal(C.linhas({},'todas','lente'),null,'API sem conferência = indisponível, não lista vazia');
});

test('resumo por marca separa Shopify, pagos e não pagos sem somar lados',()=>{
 const [a,f]=C.resumo(payload(),'todas');
 assert.deepEqual([a.marca,a.relPedidos,a.relLiquidas,a.pagos,a.receitaPaga,a.naoPagos,a.receitaNaoPaga,a.investigar],['aristo',655,105382.03,630,103231.84,25,2150.19,0]);
 assert.equal(f.relLiquidas,6384,'FF + BRUTAL TAMBA');assert.equal(f.receitaPaga,5986.9);
 const p=payload();p.conciliacao[2].relatorio_cobertura='parcial';
 assert.equal(C.resumo(p,'fish')[0].relLiquidas,null,'cobertura parcial não vira total menor');
});

test('saúde: falha não fica verde, sucesso velho é desatualizado e etapa sem registro é desconhecida',()=>{
 const s=Object.fromEntries(C.saude(payload(),AGORA).map(x=>[x.lane+'|'+x.marca,x.estado]));
 assert.equal(s['sync_cupom|aristo'],'ok');assert.equal(s['sync_cupom|fish'],'falha');
 assert.equal(s['coleta_pedidos|aristo'],'desatualizada');assert.equal(s['coleta_pedidos|fish'],'sem_registro');
 assert.equal(s['relatorio_shopify|fish'],'sem_registro');assert.equal(C.saude({},AGORA),null);
});

test('CSV usa ponto e vírgula, vírgula decimal, BOM e escapa aspas; pedidos levam link do admin sem dado pessoal',()=>{
 const csv=C.csvCupons(C.linhas(payload(),'aristo','lente'),{ini:'2026-09-01',fim:'2026-09-25'});
 assert(csv.startsWith('﻿marca;cupom;'));
 assert.match(csv,/aristo;CAPIVARA;influ;capivara;655;105382,03;630;103231,84;25;2150,19;EXPIRED 24 PENDING 1;0;explicada_nao_pagos;completa;/);
 const ped=C.csvPedidos([{marca:'fish',order_id:'65',dia:'2026-09-02T00:00:00Z',cupom_usado:'BRUTAL TAMBA',todos_cupons:'BRUTAL TAMBA',tipo:null,influ:'(desconhecido)',status_financeiro:'EXPIRED',pago:false,receita_base:'80.5',frete:'10',reembolsado:'0',comissao:null,atualizado_em:'2026-09-26T07:17:00Z'},
  {marca:'aristo',order_id:'7',cupom_usado:'A;"B"',pago:true,receita_base:1}]);
 const [cab,l1,l2]=ped.replace('﻿','').split('\r\n');
 assert.equal(cab,'marca;pedido_id;link_admin;dia_brasilia;cupom;todos_cupons;tipo_cupom;dono;status_shopify;conta_no_painel;subtotal_apos_desconto;frete;reembolsado;comissao_apurada;coletado_em');
 assert.match(l1,/^fish;65;https:\/\/admin\.shopify\.com\/store\/c0kfm1-qt\/orders\/65;2026-09-02;BRUTAL TAMBA;BRUTAL TAMBA;;\(desconhecido\);EXPIRED;não;80,5;10;0;;/);
 assert.match(l2,/;"A;""B""";/);
 assert.doesNotMatch(ped,/email|telefone|endere/i);
});

test('render: indisponível explícito, período com hoje avisa parcial e exportação pede pedidos da marca e período',async()=>{
 const {document}=parseHTML('<html><body><div id="h"></div></body></html>');const host=document.querySelector('#h');
 let pedido=null;const ctx=(p,per={ini:'2026-09-01',fim:'2026-09-25'})=>({getData:()=>p,getMarca:()=>'fish',getPeriod:()=>per,fetchPedidos:async q=>{pedido=q;return [];}});
 C.render(document,host,ctx({saude:[]}));
 assert.match(host.textContent,/Conferência indisponível/);assert.doesNotMatch(host.textContent,/R\$ 0,00/);
 C.render(document,host,ctx(payload(),{ini:'2026-09-01',fim:'2999-01-01'}));
 assert.match(host.textContent,/O período inclui hoje/);
 C.render(document,host,ctx(payload()));
 assert.doesNotMatch(host.textContent,/O período inclui hoje/);
 assert.match(host.textContent,/Só pago|só pedido pago/i);
 assert.equal(host.querySelectorAll('.conf-tabela tbody tr').length,2);
 assert.match(host.querySelector('.conf-saude').textContent,/falhou/);
 const g=globalThis;g.URL.createObjectURL=()=> 'blob:x';g.URL.revokeObjectURL=()=>{};g.Blob=g.Blob||class{};
 await host.querySelector('#conf-csv-pedidos').onclick();
 assert.deepEqual(pedido,{ini:'2026-09-01',fim:'2026-09-25',marca:'fish'});
 assert.match(host.querySelector('#conf-msg').textContent,/0 pedido/);
 const sel=host.querySelector('#conf-escopo');for(const o of sel.querySelectorAll('option'))o.toggleAttribute('selected',o.value==='todos');sel.onchange();
 assert.equal(host.dataset.escopo,'todos');
});
