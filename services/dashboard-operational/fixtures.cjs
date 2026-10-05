'use strict';
// All rows below are authored synthetic data, never a production export.
const MARKER='TESTE — dados sintéticos — escrita bloqueada';
function fixture(panel,query={},brand){
 const now=new Date().toISOString(),day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const base={preview:true,synthetic:true,label:MARKER,_escopo:panel,_painel:panel,gerado_em:now,_cache_gerado_em:now,crm_credencial:[],capabilities:{endpoints:{},write:false},pode_escrever:false};
 const arrays=keys=>Object.fromEntries(keys.split(' ').filter(Boolean).map(k=>[k,[]]));
 if(panel==='cx')return {...base,...arrays('janelas agentes_1d agentes_janelas cx_agente cx_csat cx_desfecho cx_esforco cx_handoff cx_reabertura cx_resposta_agente nps nps_frustracoes social social_atencao social_autoria social_oportunidade cx_concessao cx_concessao_tipo cx_despacho cx_fechamento cx_fechamento_motivo cx_fila cx_marco cx_pedidos cx_ra cx_tempo cx_troca cx_troca_motivo cx_wismo social_tempo'),snapshot_1d:['aristocrata','fishermans','olivas'].map(marca=>({marca,dia:day,janela:'1d',novos:12,fechados:10,trabalhados:10,respostas:18,fila_aberta:2,primeira_resposta_seg:180,primeira_resposta_comercial_seg:180,resolucao_comercial_seg:600,amostra_comercial:10,csat:80,csat_votos:5,csat_cobertura:50,kai_deflexao:40,ia_perguntas:5,coletas_ok:1,coletas_total:1,coletado_em:now,label:MARKER}))};
 if(panel==='growth')return {...base,...arrays('crm_diario crm_intradia crm_fluxo crm_conversao crm_carrinho crm_familia_campanha crm_campanha_receita crm_campanha_grupo crm_credencial crm_fontes crm_ab crm_teste crm_testes crm_teste_ab wa_saude wa_fluxo_saude wa_template wa_fluxo crm_pix'),crm_campanha:[{marca:'aristo',campanha_id:900001,nome:'TESTE · campanha sintética',canal:'email',status:'sent',enviado_em:now,enviados:100,entregues:95,abertos:30,cliques:5,coletado_em:now}],crm_operacao:{label:MARKER},crm_attribution:{schema_version:2,generated_at:now,daily:[],coverage:[],reconciliation:[],pieces:[],dispatches:[]}};
 if(panel==='organico')return {...base,...arrays('cx_post cx_story cx_organico_receita cx_conta_dia cx_comentario cx_post_midia cx_post_comentario cx_organico_attribution'),cx_post:[{marca:'aristo',rede:'instagram',conta:'teste',post_id:'synthetic-post',dia:day,publicado_em:now,tipo:'IMAGE',legenda:'TESTE · publicação sintética sem rede social real',alcance:100,curtidas:5,comentarios:1,salvos:2,compartilhamentos:1,coletado_em:now}]};
 if(panel==='influs'){
  // This closed authored fixture is already the entire source. Preserve the
  // consumer's financial fields and exact POST window without treating the
  // production aggregate projection as a per-brand Influs read contract.
  const ini=query.ini||day,fim=query.fim||day,modelo='comissao';
  const result={...base,...arrays('receita_link receita_sku escopo historias marcas pedidos'),ok:true,janela:{ini,fim},
   influs:[{marca:'aristo',influ:'creator-teste',nome:'TESTE · Creator sintético',handle:'teste.sintetico',ativo:true,nicho:'Teste',modelo,comissao_pct:0.1,porte:'micro',desde:ini}],
   cupons:[{marca:'aristo',codigo:'TESTE-SINTETICO',tipo:'influ',influ:'creator-teste',ativo:true,usos_lifetime:3,influ_comissao_pct:0.1,desconto_pct:0.1,desde:ini}],
   roi:[{marca:'aristo',influ:'creator-teste',modelo,porte:'micro',receita:300,pedidos:3,custo_lancado:20,comissao:30,patrocinio:10,investimento:50,investimento_total:60,roi:6,roi_total:5,frete_zerado:false}],
   custos:[{marca:'aristo',influ:'creator-teste',competencia:fim.slice(0,7),fixo:0,produto:15,frete:5,patrocinio:10}],
   receita_cupom:[{marca:'aristo',codigo:'TESTE-SINTETICO',influ:'creator-teste',pedidos:3,receita:300}],
   termos:[{marca:'aristo',influ:'creator-teste',vigente_desde:ini,modelo,comissao_pct:0.1}],
   marco:{custo_confiavel_desde:ini},pilot:{candidates:[],history:[],pode_escrever:false}};
  if(brand!==undefined){
   if(!['fish','aristo'].includes(brand))throw new Error('SYNTHETIC_BRAND_DENIED');
   for(const [key,rows]of Object.entries(result))if(Array.isArray(rows))result[key]=rows.filter(row=>row.marca===brand);
   result.brand=brand;result.brands=[brand];result.brandAccess='single';
  }
  return result;
 }
 if(panel==='tts')return {...base,...arrays('kpis amostras fila criadores target open envio regra escopos cobranca_fila cobranca_regra cobranca_envio canal produtos videos lives conteudos autorizacao'),janela:{ini:query.ini||day,fim:query.fim||day},kpis:[{marca:'aristo',pedidos:2,receita:100,gmv:100,comissao:10,criadores:1}],criadores:[{marca:'aristo',username:'teste.sintetico',nickname:'TESTE · Afiliado sintético',creator_id:'synthetic-creator',pedidos:2,gmv:100,comissao:10}],regra:[{marca:'aristo',modo:'dry_run',automatico:false}],_manual:{schema:'synthetic-read-only',can_write:false}};
 if(panel==='tts-cobranca')return {...base,...arrays('regras modelos envios simulacoes supressoes produtos'),pode_escrever:false,modo:'pausado'};
 if(panel==='organico-links')return {...base,links:[]};
 if(panel==='escopo')return {...base,...arrays('creators entregas orfaos eventos itens contratos'),mes:query.mes||day.slice(0,7),pode_escrever:false};
 if(['candidaturas','aprovacao'].includes(panel))return {...base,...arrays('candidaturas applications candidatos envios historico'),pode_escrever:false};
 return {...base};
}
module.exports={fixture,MARKER};
