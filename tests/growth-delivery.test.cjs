const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('../growth-data.js'),GD=require('../growth-delivery.js');
const day='2026-09-07';
const base=()=>({crm_wa_cobertura:{inicio:'2026-06-10',fim:day},crm_wa_envios:[
  {dia:day,marca:'fish',canal:'whatsapp',flow:'carrinho',piece:'primeiro',registros:120,aceitos:20,entregues:18,lidos:8,falhas:1,pendentes_entrega:1,sem_disparo_confirmado:100},
  {dia:day,marca:'fish',canal:'whatsapp',flow:'teste-motor',piece:'teste',registros:7,aceitos:7,entregues:7,lidos:7,falhas:0,pendentes_entrega:0,sem_disparo_confirmado:0}],
  crm_fluxo:[{dia:day,marca:'fish',canal:'whatsapp',flow:'carrinho',piece:'primeiro',enviados:120,pedidos_ultimo:2,receita_ultimo:300},
    {dia:day,marca:'fish',canal:'email',flow:'carrinho',piece:'primeiro',enviados:50,pedidos_ultimo:1,receita_ultimo:100}],
  crm_campanha:[],crm_conversao:[{dia:day,marca:'fish',canal:'whatsapp',utm_medium:'fluxo',utm_campaign:'carrinho',utm_content:'primeiro',pedidos_ultimo:2,receita_ultimo:300}]});
test('aceites e entregas não contam sombra nem o fluxo identificado de testes',()=>{
 const s=GD.summary(G,base(),'fish',day,day,'whatsapp');
 assert.equal(s.enviados,20);assert.equal(s.wa.entregues,18);assert.equal(s.wa.testes_aceitos,7);
 assert.equal(s.wa.sem_disparo_confirmado,100);assert.equal(s.wa.entrega_pct,90);
 assert.equal(s.wa.aceitos,s.wa.entregues+s.wa.falhas+s.wa.pendentes_entrega);
 assert.equal(s.receita,300);assert.equal(s.pedidos,2);
});
test('régua substitui contagem bruta WhatsApp por aceite e mantém e-mail separado',()=>{
 const rows=GD.flows(G,base(),'fish',day,day);
 assert.equal(rows.length,2);assert.equal(rows.find(r=>r.canal==='whatsapp').enviados,20);
 assert.equal(rows.find(r=>r.canal==='email').enviados,50);
 assert.equal(rows.find(r=>r.canal==='email').entregues,null);
});
test('API ausente e janela incompleta não aparecem como zero WhatsApp',()=>{
 assert.equal(GD.whatsapp({},'fish',day,day).aceitos,null);
 assert.equal(GD.whatsapp(base(),'fish','2026-06-01',day).aceitos,null);
 assert.equal(GD.whatsapp(base(),'aristo',day,day).aceitos,0);
 const p=base();delete p.crm_wa_envios;delete p.crm_wa_cobertura;
 assert.equal(GD.summary(G,p,'fish',day,day,'email').enviados,50);
 assert.equal(GD.summary(G,p,'fish',day,day,'todos').enviados,null);
});
test('série de disparos reconcilia com KPI e não reutiliza e-mail como entrega WA',()=>{
 assert.equal(GD.series(G,base(),'fish',day,day,'enviados','whatsapp')[0].v,20);
 assert.equal(GD.series(G,base(),'fish',day,day,'enviados','todos')[0].v,70);
 assert.equal(GD.series(G,base(),'fish',day,day,'entregues','email')[0].v,null);
});
test('peça em dois fluxos não recebe receita duplicada sem atribuição por fluxo',()=>{
 const p=base();p.crm_fluxo.push({...p.crm_fluxo[0],flow:'outro'});
 const rows=GD.flows(G,p,'fish',day,day,'whatsapp');
 assert.equal(rows.length,2);assert(rows.every(r=>r.atribuicao_ambigua&&r.receita===null&&r.pedidos===null));
 assert.equal(GD.summary(G,p,'fish',day,day,'whatsapp').receita,300);
});
test('fonte de conversão ausente permanece desconhecida nas linhas de automação',()=>{
 const p=base();delete p.crm_conversao;
 assert(GD.flows(G,p,'fish',day,day).every(r=>r.receita===null&&r.pedidos===null));
});
