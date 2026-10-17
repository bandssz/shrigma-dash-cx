'use strict';
const now=Date.parse('2026-10-07T12:00:00Z');
function flow(marca='fish',key='cart'){return {key,marca,nome:'Jornada '+marca,gatilho:{evento:'checkout_abandonado',chave_evento:'checkout_id',reentrada:'apos_fim',saida:['pedido_pago'],descricao:'Carrinho abandonado'},versao:{id:'revision-v3',numero:3,ativa:true,rascunho_pendente:false,publicada_em:'2026-10-01T10:00:00Z'},modo:'real',etapas:[{key:'send',ordem:2,tipo:'mensagem',canal:'email',template_ref:'template-1',nome:'Mensagem inicial',saida_para:'check'},{key:'check',ordem:1,tipo:'condicao',condicoes:[{se:'pedido pago',entao:'end'},{se:'sem compra',entao:'missing'}]},{key:'end',tipo:'fim'}]};}
const api=fluxos=>({crm_fluxo_def:{schema_version:1,generated_at:'2026-10-07T11:00:00Z',revision:'r6-source',fluxos},crm_fluxo:[],crm_wa_envios:[]});

module.exports={flow,api,now};
