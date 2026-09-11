/* Fluxos (Fase C · leitura): regras sem DOM. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const GF=require('../growth-flows.js');
const DEF=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-fluxo-def.synthetic.json'),'utf8'));
const CTRL=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-control.json'),'utf8'));
const api=()=>({
 crm_fluxo:[{dia:'2026-09-07',marca:'fish',canal:'whatsapp',flow:'carrinho',piece:'carrinho-30min',enviados:142},{dia:'2026-09-07',marca:'fish',canal:'email',flow:'carrinho',piece:'carrinho-24h',enviados:50},
  {dia:'2026-08-01',marca:'fish',canal:'email',flow:'carrinho',piece:'carrinho-24h',enviados:999},{dia:'2026-09-07',marca:'fish',canal:'whatsapp',flow:'teste-motor',piece:'teste',enviados:7},null,{marca:'fish',flow:'x'}],
 crm_wa_envios:[{dia:'2026-09-07',marca:'fish',canal:'whatsapp',flow:'carrinho',piece:'carrinho-30min',registros:142,aceitos:42,entregues:40},{dia:'2026-09-06',marca:'fish',canal:'whatsapp',flow:'carrinho',piece:'carrinho-30min',registros:10,aceitos:null,entregues:5},
  {dia:'2026-09-07',marca:'aristo',canal:'whatsapp',flow:'transacional',piece:'pedido-pago',registros:102,aceitos:0,entregues:0}],
 crm_operacao:(()=>{const c=CTRL();c.templates[1].mapped_in=[{workflow_key:'aristo_tx',piece:'pedido-pago',mode_key:'modo_pedido_pago'}];return c;})(),
 wa_fluxo_saude:[{chave:'gatilho:aristo:pedido-pago',brand:'aristo',nome:'Gatilho → WhatsApp · aristo · pedido-pago',estado:'ok'},{chave:'gatilho:fish:carrinho-30min',brand:'fish',nome:'G fish',estado:'alerta',motivo:'x'}],
});

test('definição declarada: valida fluxo/gatilho/versão/etapas; inválidos são contados com o motivo, nunca exibidos como válidos',()=>{
 const d=GF.definidos(DEF);
 assert.equal(d.presente,true);assert.equal(d.fluxos.length,2);assert.equal(d.invalidos,2);
 assert.deepEqual(d.erros.map(x=>x.key),['quebrado',null]);assert.match(d.erros[0].erros.join(' '),/marca inválida|chave_evento ausente|reentrada inválida|versao.ativa|etapa 1: canal inválido/);
 const c=d.fluxos[0];assert.equal(c.key,'carrinho');assert.equal(c.gatilho.chave_evento,'checkout_id');assert.equal(c.gatilho.reentrada,'apos_fim');assert.deepEqual(c.gatilho.saida,['pedido_pago','checkout_recuperado']);
 assert.deepEqual(c.etapas.map(e=>e.tipo),['espera','mensagem','espera','condicao','mensagem','fim']);assert.equal(c.etapas[1].canal,'whatsapp');assert.equal(c.etapas[4].canal,'email');
 assert.deepEqual(c.etapas[3].condicoes,[{se:'whatsapp_lido',entao:'fim'},{se:'nao_lido',entao:'email-24h'}]);
 assert.equal(GF.espera(1800),'30 min');assert.equal(GF.espera(86400),'1 dia(s)');assert.equal(GF.espera(5400),'90 min');assert.equal(GF.espera(null),'—');
 assert.equal(GF.definidos({}).presente,false);assert.equal(GF.definidos({crm_fluxo_def:{fluxos:'nao'}}).presente,false);
});
test('observado: agrupa por (marca, flow) sem inventar gatilho/ordem; volume só do período com desconhecido = null; teste-motor e linhas inválidas fora',()=>{
 const o=GF.observados(api(),{ini:'2026-09-01',fim:'2026-09-07',marca:'todas'});
 assert.equal(o.invalidas,2);assert.deepEqual(o.fluxos.map(f=>f.key),['aristo|transacional','fish|carrinho']);
 const c=o.fluxos[1];assert.equal(c.gatilho,null);assert.equal(c.versao,null);assert.equal(c.origem,'observado');
 assert.deepEqual(c.etapas.map(e=>`${e.peca}/${e.canal}`),['carrinho-24h/email','carrinho-30min/whatsapp']);
 assert.equal(c.etapas[0].volume.enviados,50); // agosto fora
 assert.equal(c.etapas[1].volume.aceitos,null); // uma linha com aceitos:null → desconhecido, não 42
 assert.equal(c.etapas[1].volume.entregues,45);
 assert.equal(c.modo.valor,'nao_declarado'); // sem mapped_in para carrinho
 assert.equal(c.saude.length,1);assert.equal(c.saude[0].estado,'alerta');
 assert.match(GF.volumeTexto(c.etapas[1]),/^— aceitos · 45 entregues$/);assert.match(GF.volumeTexto(c.etapas[0]),/50 aceitos pela API \(entrega individual não medida\)/);
 const a=o.fluxos[0];assert.equal(a.etapas[0].workflows.length,1);assert.equal(a.etapas[0].workflows[0].modo,'sombra');assert.equal(a.etapas[0].workflows[0].atual,null); // sem modelo da tela: não afirma atualidade
 assert.equal(a.etapas[0].templates[0].name,'aristo_confirmacao_exemplo');assert.equal(a.modo.valor,'sombra');
 assert.equal(GF.observados(api(),{marca:'fish'}).fluxos.length,1);
});
test('resumo de modo: real só com todos os workflows em real, ativos e com consulta atual; desatualizado nunca vira real; mistura vira misto',()=>{
 const w=(modo,atual,ativo=true,key='k')=>({key,modo,atual,ativo});
 assert.equal(GF.modoResumo([{workflows:[w('real',true)]}]).tone,'verified');
 assert.equal(GF.modoResumo([{workflows:[w('real',true,false)]}]).rotulo,'Modo real · workflow inativo');
 assert.equal(GF.modoResumo([{workflows:[w('real',false,true,'fish_tx')]}]).rotulo,'Modo não confirmado (consulta desatualizada em fish_tx)');
 assert.equal(GF.modoResumo([{workflows:[w('real',true)]},{workflows:[w('sombra',true)]}]).valor,'misto');
 const parcial=GF.modoResumo([{workflows:[w('real',true)]},{workflows:[]}]);assert.equal(parcial.rotulo,'Modo real (1 de 2 etapas com workflow declarado)');assert.equal(parcial.tone,'neutral');
 assert.equal(GF.modoResumo([{workflows:[w('nao_confirmado',true)]}]).valor,'nao_confirmado');
 assert.equal(GF.modoResumo([{workflows:[]}]).valor,'nao_declarado');
});
test('lista: definição declarada tem precedência sobre o observado do mesmo (marca, flow); CSV segue a projeção da tela',()=>{
 const a={...api(),...DEF};
 const l=GF.lista(a,{ini:'2026-09-01',fim:'2026-09-07',marca:'todas'});
 assert.deepEqual(l.definidos.map(f=>f.key),['carrinho','pix-nao-pago']);
 assert.deepEqual(l.observados.map(f=>f.key),['aristo|transacional']); // fish|carrinho coberto pela definição
 const csv=GF.linhasCsv(l);
 assert.equal(csv.length,6+2+1);
 assert.deepEqual(Object.keys(csv[0]),GF.colunas.map(c=>c.chave));
 assert.equal(csv[1].origem,'definição declarada');assert.equal(csv[1].canal,'WhatsApp');assert.equal(csv[1].template,'exemplo_carrinho_30');assert.equal(csv[0].espera,'30 min');
 assert.match(csv[0].gatilho,/checkout_abandonado · reentrada apos_fim · sai em pedido_pago, checkout_recuperado/);assert.equal(csv[0].versao,'v3 · ativa');
 const obs=csv[8];assert.equal(obs.origem,'observado no motor');assert.equal(obs.gatilho,null);assert.equal(obs.ordem,null);assert.match(obs.workflows,/Pedido pago e rastreio Aristocrata · modo sombra/);assert.match(obs.volume,/0 aceitos · 0 entregues/);
});
