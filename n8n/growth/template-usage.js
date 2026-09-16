/* Build metadata from published bindings; never interpret template names as routing. */
'use strict';
function templateUsage(seed, flows) {
  if(!Array.isArray(flows)||!flows.length)throw Error('published_bindings_unavailable');
  const routes={
    'fish:pedido-confirmado':['fish_tx','modo_pedido_pago'], 'aristo:pedido-confirmado':['aristo_tx','modo_pedido_pago'],
    'fish:pedido-recebido':['fish_tx','modo_pedido_pago'], 'aristo:pedido-recebido':['aristo_tx','modo_pedido_pago'],
    'fish:rastreio':['fish_tx','modo_rastreio'], 'aristo:rastreio':['aristo_tx','modo_rastreio'],
    'fish:carrinho':['fish_cart','modo'], 'aristo:carrinho':['aristo_cart','modo'],
    'fish:pix':['fish_pix','modo'], 'aristo:pix':['aristo_pix_appmax','modo']
  };
  const out=new Map(seed.map(d=>[d.key,{...d,usage:d.usage==='current'?'available':d.usage,mapped_in:[]} ]));
  for(const f of flows){
    for(const s of f.steps||[]){
      if(!s.id)continue;
      const route=routes[f.key];if(!route)throw Error('unmapped_published_flow');
      if(!/^\d+$/.test(String(s.id))||!['fish','aristo'].includes(f.brand))throw Error('invalid_published_template');
      const key=f.brand+':'+s.id,existing=out.get(key);
      const d=existing||{key,id:String(s.id),brand:f.brand,channel:'whatsapp',name:s.name,language:s.language||'pt_BR',expected_category:s.category,mapped_in:[]};
      const enabled=f.enabled===true&&f.runtime_ready===true&&s.enabled===true;
      const link={workflow_key:route[0],mode_key:route[1],piece:s.piece};
      if(enabled&&!d.mapped_in.some(x=>x.workflow_key===link.workflow_key&&x.piece===link.piece))d.mapped_in.push(link);
      d.piece=s.piece;d.usage=d.mapped_in.length?'current':'configured_paused';
      d.usage_reason=enabled?'Selecionado na versão publicada da jornada.':'Selecionado em uma jornada ou etapa pausada.';
      out.set(key,d);
    }
  }
  return [...out.values()];
}
if(typeof module!=='undefined')module.exports=templateUsage;
