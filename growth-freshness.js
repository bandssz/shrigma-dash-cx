/* Collection health is separate from the time of the last matching sale. */
const GrowthFreshness=(()=>{
 const brands={fish:'Fishermans',aristo:'O Aristocrata',olivas:'Olivas do Campo'};
 const labels={crm_diario:'E-mail diário',crm_campanha:'Campanhas',crm_fluxo:'Automações',crm_conversao:'Conversões',crm_intradia:'Conversões por hora',crm_utm_orfa:'UTMs sem canal',crm_arvore_snapshot:'Segmentos',crm_credencial:'Credenciais'};
 const latest=rows=>rows.reduce((best,r)=>{const t=Date.parse(r?.checked_at||r?.coletado_em||'');return Number.isFinite(t)&&(!best||t>best.time)?{time:t,checked_at:new Date(t).toISOString()}:best;},null)?.checked_at||null;
 function sources(api,brand='todas'){
  const out=[],chosen=b=>brand==='todas'||brand===b;
  for(const [name,rows] of Object.entries(api||{})){
   if(name.startsWith('_')||name==='crm_collection_receipt'||!Array.isArray(rows)||!rows.length)continue;
   if(['crm_conversao','crm_intradia'].includes(name))continue;
   // A sparse event inventory is not a collector heartbeat.
   if(name==='crm_utm_orfa')continue;
   const grouped=new Map();for(const r of rows){const b=r?.marca||r?.brand||'';if(b&&!chosen(b))continue;if(!grouped.has(b))grouped.set(b,[]);grouped.get(b).push(r);}
   for(const [b,rr] of grouped){const stamp=latest(rr);if(stamp)out.push({name:(labels[name]||name)+(b?' · '+(brands[b]||b):''),checked_at:stamp});}
  }
  const v2=api?.crm_attribution?.schema_version===2;
  for(const b of Object.keys(brands)){
   if(!chosen(b))continue;
   if(v2&&['fish','aristo','olivas'].includes(b)){
    out.push({name:'Atribuição · '+brands[b],checked_at:latest((api.crm_attribution.coverage||[]).filter(r=>r?.brand===b)),required:true});
   }else{
    const receipts=(api.crm_collection_receipt||[]).filter(r=>r?.source==='legacy_conversion'&&r.brand===b);
    const raw=(api._attribution_legacy?.hourly||api.crm_intradia||[]).filter(r=>r?.marca===b);
    const daily=(api._attribution_legacy?.conv||api.crm_conversao||[]).filter(r=>r?.marca===b);
    if(receipts.length)out.push({name:'Conversões · '+brands[b],checked_at:latest(receipts),required:true});
    else if(raw.length||daily.length)out.push({name:'Conversões · '+brands[b],checked_at:null,required:true});
   }
  }
  return out;
 }
 return {sources};
})();
if(typeof module!=='undefined')module.exports=GrowthFreshness;
