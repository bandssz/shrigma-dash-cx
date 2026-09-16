/* Consolidate configured journeys without changing dispatch identities or cadence. */
'use strict';
const clone=v=>JSON.parse(JSON.stringify(v));
function mergeJourneys(flows){
 const result=clone(flows),merges=[];
 for(const brand of ['fish','aristo'])for(const kind of ['nps','order']){
  const keys=kind==='nps'?['nps-d0','nps-d3']:['pedido-recebido','pedido-confirmado','pedido-preparando','pedido-em_rota','pedido-entregue','pedido-cancelado'];
  const sources=keys.map(k=>result.find(f=>f.key===brand+':'+k));
  if(sources.some(f=>!f))throw Error('Missing source journey: '+brand+':'+kind);
  if(sources.some(f=>f.binding?.merged_into))throw Error('Already merged: '+brand+':'+kind);
  if(sources.some(f=>JSON.stringify(f.draft)!==JSON.stringify(f.published)))throw Error('Unpublished changes: '+brand+':'+kind);
  if(sources.some(f=>!f.runtime_ready))throw Error('Runtime unavailable: '+brand+':'+kind);
  const target=sources[0],name=kind==='nps'?'NPS · Pesquisa e lembrete':'Pedido · Acompanhamento';
  const steps=sources.flatMap(f=>f.published.steps.map(s=>({...clone(s),enabled:f.enabled&&s.enabled})));
  if(new Set(steps.map(s=>s.key)).size!==steps.length)throw Error('Duplicate stage');
  const slots=sources.flatMap(f=>f.binding.steps.map(s=>{
   const slot={...clone(s),entry_key:kind==='order'?f.key:'nps',entry_label:f.trigger};
   if(kind==='nps')slot.help_text=s.piece==='nps-d0'?'Pesquisa do pedido elegível. A pausa da jornada abrange pesquisa e lembrete. O convite VIP permanece desligado.':'Lembrete do mesmo pedido, com pesquisa inicial confirmada e ainda sem resposta. Prazo desde o registro inicial; seleção diária às 19h de Brasília. A resposta é conferida novamente na reserva.';
   return slot;
  }));
  const originalKeys=sources.map(f=>f.key);
  target.name=name;target.trigger=kind==='nps'?sources[0].trigger:'Eventos do pedido';
  target.enabled=sources.some(f=>f.enabled);target.version=Math.max(...sources.map(f=>f.version))+1;target.published_version=target.version;
  target.draft={name,steps};target.published=clone(target.draft);
  target.binding={brand,steps:slots,journey_kind:kind,source_keys:originalKeys};
  for(const f of sources.slice(1)){f.binding={...f.binding,merged_into:target.key};f.enabled=false;f.runtime_ready=false;f.version++;}
  merges.push({key:target.key,kind,source_keys:originalKeys,stage_count:steps.length});
 }
 return {flows:result,merges};
}
if(typeof module!=='undefined')module.exports={mergeJourneys};
